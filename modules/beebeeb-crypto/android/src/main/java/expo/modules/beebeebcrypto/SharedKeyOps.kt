package expo.modules.beebeebcrypto

import uniffi.beebeeb_uniffi.*
import java.security.SecureRandom
import java.util.Base64

data class SharedKeyEntryNative(val fileId: String, val wrapped: ByteArray, val kind: Int)
data class FolderLinkMintNative(val kc: String, val wrappedFolderKey: ByteArray,
  val ownerWrappedKey: ByteArray, val ownerWrappedToken: ByteArray)

/**
 * Whether a name batch may fall through to the owner resolver. Pure so the
 * boundary is testable without native keys: a table hit is final; a table
 * failure on a FOREIGN shared file is final; a table failure on this account's
 * own file may be retried by the owner resolver.
 */
enum class NameResolutionPlan { TABLE_FINAL, OWNER_RESOLVE, ERROR_FINAL }

object SharedKeyOps {
  val registry = SharedKeyRegistry<FileKeyHandle> { it.close() }
  val ownerConventions = OwnerConventionCache()
  fun folder(id: Int, registry: SharedKeyRegistry<FileKeyHandle> = this.registry) =
    registry.folder(id) ?: error("Vault is locked")
  fun wire(encrypted: EncryptedData) = encrypted.nonce + encrypted.ciphertext
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
  // MARK: - SF-0002 owner resolvers

  /**
   * Resolve this account's per-file key from the stored name pair, reporting the
   * id convention. The returned key can only read; the convention is cached (never
   * the key) so a read-only decision survives the read that discovered it.
   */
  fun resolveOwnerName(master: MasterKeyHandle, fileId: String, nameEncrypted: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Pair<OwnerReadKey, OwnerKeyConvention> {
    val resolved = master.ownerFileKeyForName(fileId, nameEncrypted)
    ownerConventions.storeName(resolved.convention, registry.generation, fileId, nameEncrypted)
    return Pair(OwnerReadKey(resolved.key), resolved.convention)
  }

  /** Resolve one content version independently of the name. */
  fun resolveOwnerContent(master: MasterKeyHandle, fileId: String, firstFrame: ByteArray,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): Pair<OwnerReadKey, OwnerKeyConvention> {
    val resolved = master.ownerFileKeyForContent(fileId, firstFrame)
    ownerConventions.storeContent(
      resolved.convention, registry.generation, fileId,
      java.util.Base64.getEncoder().encodeToString(firstFrame))
    return Pair(OwnerReadKey(resolved.key), resolved.convention)
  }

  /** The only pin source for an owned file: authenticated metadata under the owner's key. */
  fun readContentPin(master: MasterKeyHandle, fileId: String, nameEncrypted: String,
    registry: SharedKeyRegistry<FileKeyHandle> = this.registry): ContentPin {
    val (readKey, convention) = resolveOwnerName(master, fileId, nameEncrypted, registry)
    return try {
      val metadata = readKey.decryptFileMetadata(nameEncrypted)
      ContentPin(metadata.chunkFormat, convention)
    } catch (error: Exception) { throw ContentPinUnverifiable(error) }
  }

  /** The shared-folder boundary as a pure decision. */
  fun nameResolutionPlan(tablePresent: Boolean, tableFailed: Boolean, isForeign: Boolean): NameResolutionPlan =
    when {
      tablePresent && !tableFailed -> NameResolutionPlan.TABLE_FINAL
      isForeign -> NameResolutionPlan.ERROR_FINAL
      else -> NameResolutionPlan.OWNER_RESOLVE
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
    foreignFileIds: Set<String> = emptySet(),
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
        } catch (error: Exception) {
          // A present but wrong table key is final for a FOREIGN shared file. For this
          // account's own file it may be the uppercase-repair convention, which only the
          // owner resolver can authenticate — retry there.
          val retried = if (nameResolutionPlan(true, true, item.fileId in foreignFileIds) ==
            NameResolutionPlan.OWNER_RESOLVE) {
            try {
              val (readKey, _) = resolveOwnerName(master, item.fileId, item.nameEncrypted, registry)
              val value = readKey.decryptNameMetadata(item.nameEncrypted)
              BatchNameResult(value.name, value.mimeType, null)
            } catch (_: Exception) { null }
          } else null
          retried ?: BatchNameResult(null, null, error.message ?: "decryption failed")
        }
        fromTable.add(index to result)
      } else { remaining.add(item); indices.add(index) }
    }
    val results = if (remaining.isEmpty()) emptyList() else master.decryptNames(remaining)
    return mergeNameResults(items.size, fromTable, indices.zip(results))
  }
  private fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
