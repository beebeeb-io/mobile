package expo.modules.beebeebcrypto

import uniffi.beebeeb_uniffi.*
import java.security.SecureRandom
import java.util.Base64

data class SharedKeyEntryNative(val fileId: String, val wrapped: ByteArray, val kind: Int)
data class FolderLinkMintNative(val kc: String, val wrappedFolderKey: ByteArray,
  val ownerWrappedKey: ByteArray, val ownerWrappedToken: ByteArray)

object SharedKeyOps {
  val registry = SharedKeyRegistry<FileKeyHandle> { it.close() }
  fun folder(id: Int, registry: SharedKeyRegistry<FileKeyHandle> = this.registry) =
    registry.folder(id) ?: error("Vault is locked")
  fun wire(encrypted: EncryptedData) = encrypted.nonce + encrypted.ciphertext
  fun unwrap(wrapper: FileKeyHandle, wrapped: ByteArray): FileKeyHandle {
    require(wrapped.size == 60) { "Invalid shared key wrap" }
    return wrapper.unwrapKey(wrapped.copyOfRange(0, 12), wrapped.copyOfRange(12, wrapped.size))
  }
  fun openOwnerFolderKey(master: MasterKeyHandle, folderId: String, wrapped: ByteArray,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Int {
    val epoch = registry.generation
    require(wrapped.size == 60) { "Invalid shared key wrap" }
    val key = master.unwrapFolderCustody(folderId, wrapped.copyOfRange(0, 12), wrapped.copyOfRange(12, wrapped.size))
    return registry.storeFolderIfCurrent(key, folderId, epoch) ?: error("Vault is locked")
  }
  fun generateFolderKey(master: MasterKeyHandle, folderId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Pair<Int, ByteArray> {
    val epoch = registry.generation
    val key = FileKeyHandle.generate()
    val wrapped = wire(master.wrapFolderCustody(folderId, key))
    return Pair(registry.storeFolderIfCurrent(key, folderId, epoch) ?: error("Vault is locked"), wrapped)
  }
  fun loadFileKeys(folderId: Int, entries: List<SharedKeyEntryNative>,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Pair<List<String>, List<String>> {
    val epoch = registry.generation
    val folder = folder(folderId, registry)
    val loaded = mutableListOf<String>(); val failed = mutableListOf<String>()
    for (entry in entries) {
      try {
        require(entry.wrapped.size == 60 && entry.kind in 1..2) { "Invalid shared key wrap" }
        val opened = folder.handle.unwrapFolderChild(folder.folderId, entry.fileId, entry.kind.toUByte(), entry.wrapped.copyOfRange(0,12), entry.wrapped.copyOfRange(12,entry.wrapped.size))
        if (registry.storeFile(entry.fileId, opened, epoch)) loaded.add(entry.fileId) else failed.add(entry.fileId)
      } catch (_: Exception) { failed.add(entry.fileId) }
    }
    return Pair(loaded, failed)
  }
  fun openOwnerFileKey(master: MasterKeyHandle, fileId: String, wrapped: ByteArray,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Boolean {
    val epoch = registry.generation
    return try {
      require(wrapped.size == 60) { "Invalid shared key wrap" }
      val key = master.unwrapOwnerFileKey(fileId, wrapped.copyOfRange(0, 12), wrapped.copyOfRange(12, wrapped.size))
      registry.storeFile(fileId, key, epoch)
    }
    catch (_: Exception) { false }
  }
  fun wrapChildKeys(master: MasterKeyHandle, folderId: Int, fileIds: List<String>,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry, kind: Int = 1): List<SharedKeyEntryNative> {
    val folder = folder(folderId, registry)
    require(kind in 1..2) { "Invalid shared key kind" }
    return fileIds.map { id ->
      borrowFileKey(master, id, registry).use { access ->
        SharedKeyEntryNative(id, wire(folder.handle.wrapFolderChild(folder.folderId, id, kind.toUByte(), access.handle)), kind)
      }
    }
  }
  fun adoptWrap(master: MasterKeyHandle, fileId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): ByteArray {
    val key = registry.file(fileId) ?: error("Vault is locked")
    return wire(master.wrapOwnerFileKey(fileId, key))
  }
  fun fileKey(master: MasterKeyHandle, fileId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): FileKeyHandle =
    pickKey(registry.file(fileId)) { master.deriveFileKey(fileId.toByteArray(Charsets.UTF_8)) }
  fun borrowFileKey(master: MasterKeyHandle, fileId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): SharedKeyAccess<FileKeyHandle> {
    val table = registry.file(fileId)
    return if (table != null) SharedKeyAccess(table, false) { it.close() }
      else SharedKeyAccess(master.deriveFileKey(fileId.toByteArray(Charsets.UTF_8)), true) { it.close() }
  }
  fun mintLink(master: MasterKeyHandle, folderId: Int, token: String, passphrase: String?, shareId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): FolderLinkMintNative {
    val key = folder(folderId, registry).handle
    val kc = ByteArray(32)
    try {
      SecureRandom().nextBytes(kc)
      // No catch/fallback: a failed Argon2id stretch is an error to the caller.
      val link = if (passphrase == null) FileKeyHandle.fromFolderLink(kc, null)
        else FileKeyHandle.fromFolderLinkPassphrase(kc, passphrase, token)
      return FolderLinkMintNative(base64url(kc), wire(link.wrapKey(key)),
        wire(master.wrapLinkOwnerKey(shareId, FileKeyHandle.fromKeyBytes(kc))),
        wire(master.wrapLinkOwnerToken(shareId, token.toByteArray(Charsets.UTF_8))))
    } finally { kc.fill(0) }
  }
  fun recoverKc(master: MasterKeyHandle, folderId: Int, wrapped: ByteArray, shareId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): String? {
    val key = folder(folderId, registry).handle
    require(wrapped.size == 60) { "Invalid shared key wrap" }
    val candidate = try { master.unwrapLinkOwnerKey(shareId, wrapped.copyOfRange(0, 12), wrapped.copyOfRange(12, wrapped.size)) }
      catch (_: Exception) { return null } // No legacy retry.
    try {
        require(candidate.size == 32) { "Invalid shared key wrap" }
        if (FileKeyHandle.fromKeyBytes(candidate).keyId().contentEquals(key.keyId())) return null
        return base64url(candidate)
    } finally { candidate.fill(0) }
  }
  fun decryptNames(master: MasterKeyHandle, items: List<BatchNameItem>,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): List<BatchNameResult> {
    val fromTable = mutableListOf<Pair<Int, BatchNameResult>>()
    val remaining = mutableListOf<BatchNameItem>()
    val indices = mutableListOf<Int>()
    for ((index, item) in items.withIndex()) {
      val key = registry.file(item.fileId)
      if (key != null) {
        val result = try {
          val value = key.decryptNameMetadata(item.nameEncrypted)
          BatchNameResult(value.name, value.mimeType, null)
        } catch (error: Exception) { BatchNameResult(null, null, error.message ?: "decryption failed") }
        fromTable.add(index to result)
      } else { remaining.add(item); indices.add(index) }
    }
    val results = if (remaining.isEmpty()) emptyList() else master.decryptNames(remaining)
    return mergeNameResults(items.size, fromTable, indices.zip(results))
  }
  private fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
