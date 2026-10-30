package expo.modules.beebeebcrypto

import uniffi.beebeeb_uniffi.ChunkDecryptorHandle
import uniffi.beebeeb_uniffi.FileKeyHandle
import uniffi.beebeeb_uniffi.NameMetadataDto
import uniffi.beebeeb_uniffi.OwnerKeyConvention

/**
 * The owner's resolved per-file key, wrapped so it can only READ.
 *
 * SF-0002: a key resolved from `(file_id, name_encrypted)` or a content version's
 * first frame may belong to the uppercase-repair convention, which is read-only.
 * This type deliberately exposes no encryption, wrapping, adoption or raw-key
 * operation, and the [FileKeyHandle] stays private. It lives for one read and is
 * never stored in [SharedKeyRegistry].
 */
class OwnerReadKey(private val key: FileKeyHandle) {
  fun decryptFileMetadata(nameEncrypted: String): NameMetadataDto =
    key.decryptFileMetadata(nameEncrypted)

  fun decryptNameMetadata(nameEncrypted: String): NameMetadataDto =
    key.decryptNameMetadata(nameEncrypted)

  fun makeDecryptor(fileId: String, chunkFormat: UByte): ChunkDecryptorHandle =
    ChunkDecryptorHandle.forPushWithFileKeyHandle(key, fileId, chunkFormat)
}

/** The authenticated pin plus the convention the name key came from. */
data class ContentPin(val chunkFormat: UByte, val nameConvention: OwnerKeyConvention)

class ContentPinUnverifiable(cause: Throwable) :
  Exception("Content pin could not be authenticated: ${cause.message}", cause)
