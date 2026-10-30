package expo.modules.beebeebcrypto

import java.security.MessageDigest
import uniffi.beebeeb_uniffi.OwnerKeyConvention

/**
 * Conventions only — never keys. Kept separate from [SharedKeyRegistry] so a lock
 * (`clearSharedKeys`) empties both, while the fact that an owned file needs the
 * owner resolver cannot outlive the vault session.
 */
class OwnerConventionCache {
  private data class NameKey(val epoch: Long, val fileId: String, val nameHash: String)
  private data class ContentKey(val epoch: Long, val fileId: String, val objectVersionId: String)

  private val names = HashMap<NameKey, OwnerKeyConvention>()
  private val contents = HashMap<ContentKey, OwnerKeyConvention>()

  @Synchronized
  fun name(epoch: Long, fileId: String, nameEncrypted: String): OwnerKeyConvention? =
    names[NameKey(epoch, fileId, hash(nameEncrypted))]

  @Synchronized
  fun storeName(convention: OwnerKeyConvention, epoch: Long, fileId: String, nameEncrypted: String) {
    names[NameKey(epoch, fileId, hash(nameEncrypted))] = convention
  }

  @Synchronized
  fun content(epoch: Long, fileId: String, objectVersionId: String): OwnerKeyConvention? =
    contents[ContentKey(epoch, fileId, objectVersionId)]

  @Synchronized
  fun storeContent(convention: OwnerKeyConvention, epoch: Long, fileId: String, objectVersionId: String) {
    contents[ContentKey(epoch, fileId, objectVersionId)] = convention
  }

  @Synchronized
  fun clear() {
    names.clear()
    contents.clear()
  }

  @Synchronized
  fun count(): Int = names.size + contents.size

  /** Stable, non-secret digest: the cache key never carries the sealed name. */
  private fun hash(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
}
