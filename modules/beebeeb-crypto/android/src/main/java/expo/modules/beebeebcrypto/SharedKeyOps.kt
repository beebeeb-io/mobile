package expo.modules.beebeebcrypto

import uniffi.beebeeb_uniffi.*
import java.security.SecureRandom
import java.util.Base64

data class SharedKeyEntryNative(val fileId: String, val wrapped: ByteArray)
data class FolderLinkMintNative(val kc: String, val wrappedFolderKey: ByteArray,
  val ownerWrappedKey: ByteArray, val ownerWrappedToken: ByteArray)

object SharedKeyOps {
  val registry = SharedKeyRegistry<FileKeyHandle>()
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
    val key = unwrap(master.deriveFileKey(folderId.toByteArray(Charsets.UTF_8)), wrapped)
    return registry.storeFolderIfCurrent(key, folderId, epoch) ?: error("Vault is locked")
  }
  fun generateFolderKey(master: MasterKeyHandle, folderId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Pair<Int, ByteArray> {
    val epoch = registry.generation
    val key = FileKeyHandle.generate()
    val wrapped = wire(master.deriveFileKey(folderId.toByteArray(Charsets.UTF_8)).wrapKey(key))
    return Pair(registry.storeFolderIfCurrent(key, folderId, epoch) ?: error("Vault is locked"), wrapped)
  }
  fun loadFileKeys(folderId: Int, entries: List<SharedKeyEntryNative>,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Pair<List<String>, List<String>> {
    val epoch = registry.generation
    val key = folder(folderId, registry).handle
    val loaded = mutableListOf<String>(); val failed = mutableListOf<String>()
    for (entry in entries) {
      try {
        val opened = unwrap(key, entry.wrapped)
        if (registry.storeFile(entry.fileId, opened, epoch)) loaded.add(entry.fileId) else failed.add(entry.fileId)
      } catch (_: Exception) { failed.add(entry.fileId) }
    }
    return Pair(loaded, failed)
  }
  fun openOwnerFileKey(master: MasterKeyHandle, fileId: String, wrapped: ByteArray,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Boolean {
    val epoch = registry.generation
    return try { registry.storeFile(fileId, unwrap(master.deriveFileKey(fileId.toByteArray(Charsets.UTF_8)), wrapped), epoch) }
    catch (_: Exception) { false }
  }
  fun wrapChildKeys(master: MasterKeyHandle, folderId: Int, fileIds: List<String>,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): List<SharedKeyEntryNative> {
    val key = folder(folderId, registry).handle
    return fileIds.map { SharedKeyEntryNative(it, wire(key.wrapKey(master.deriveFileKey(it.toByteArray(Charsets.UTF_8))))) }
  }
  fun adoptWrap(master: MasterKeyHandle, fileId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): ByteArray {
    val key = registry.file(fileId) ?: error("Vault is locked")
    return wire(master.deriveFileKey(fileId.toByteArray(Charsets.UTF_8)).wrapKey(key))
  }
  fun fileKey(master: MasterKeyHandle, fileId: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): FileKeyHandle =
    pickKey(registry.file(fileId)) { master.deriveFileKey(fileId.toByteArray(Charsets.UTF_8)) }
  fun mintLink(master: MasterKeyHandle, folderId: Int, token: String, passphrase: String?,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): FolderLinkMintNative {
    val key = folder(folderId, registry).handle
    val kc = ByteArray(32)
    try {
      SecureRandom().nextBytes(kc)
      // No catch/fallback: a failed Argon2id stretch is an error to the caller.
      val link = if (passphrase == null) FileKeyHandle.fromFolderLink(kc, null)
        else FileKeyHandle.fromFolderLinkPassphrase(kc, passphrase, token)
      val masterBytes = master.exportForKeychain()
      try {
        return FolderLinkMintNative(base64url(kc), wire(link.wrapKey(key)),
          wire(encryptChunk(masterBytes, kc)), wire(encryptChunk(masterBytes, token.toByteArray(Charsets.UTF_8))))
      } finally { masterBytes.fill(0) }
    } finally { kc.fill(0) }
  }
  fun recoverKc(master: MasterKeyHandle, folderId: Int, wrapped: ByteArray,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): String? {
    val key = folder(folderId, registry).handle
    require(wrapped.size == 60) { "Invalid shared key wrap" }
    val masterBytes = master.exportForKeychain()
    try {
      val candidate = decryptChunk(masterBytes, wrapped.copyOfRange(0, 12), wrapped.copyOfRange(12, wrapped.size))
      try {
        require(candidate.size == 32) { "Invalid shared key wrap" }
        if (FileKeyHandle.fromKeyBytes(candidate).keyId().contentEquals(key.keyId())) return null
        return base64url(candidate)
      } finally { candidate.fill(0) }
    } finally { masterBytes.fill(0) }
  }
  private fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
