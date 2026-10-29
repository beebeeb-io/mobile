package expo.modules.beebeebcrypto

/**
 * Pure framing math for the chunked video stream (task 1683j).
 *
 * The wire format is a sequence of AEAD frames — `nonce(12) || ciphertext(plaintext+16)`
 * — so chunk overhead is 28 bytes and chunks sit sequentially in the encrypted
 * body. The chunk index → byte-offset map is therefore deterministic given
 * (chunkCount, plaintextChunkSize, originalSize): the same math the 1683b
 * preview loop inlines, extracted so the streaming engine (`VideoStreamer`)
 * and the JVM test suite share one source of truth.
 *
 * No Android imports — this object must keep running in the plain JVM test
 * suite (`:beebeeb-crypto` unit tests).
 */
internal object VideoChunkMath {
  const val NONCE_BYTES = 12
  const val CHUNK_OVERHEAD_BYTES = NONCE_BYTES + 16L

  /**
   * Plaintext bytes carried by chunk [index] (0-based). Non-final chunks carry
   * exactly [plaintextChunkSize]; the last carries the remainder of
   * [originalSize] (for a single-chunk file: the whole [originalSize]).
   */
  fun plaintextSize(
    index: Int,
    chunkCount: Int,
    plaintextChunkSize: Long,
    originalSize: Long,
  ): Long {
    require(chunkCount >= 1) { "chunkCount must be >= 1 (got $chunkCount)" }
    require(index in 0 until chunkCount) { "chunk index $index out of range 0..${chunkCount - 1}" }
    return when {
      chunkCount == 1 -> originalSize
      index == chunkCount - 1 -> originalSize - plaintextChunkSize * (chunkCount - 1)
      else -> plaintextChunkSize
    }
  }

  /** Encrypted frame length on the wire for chunk [index]: `nonce || ct(pt+tag)`. */
  fun windowSize(
    index: Int,
    chunkCount: Int,
    plaintextChunkSize: Long,
    originalSize: Long,
  ): Long = CHUNK_OVERHEAD_BYTES + plaintextSize(index, chunkCount, plaintextChunkSize, originalSize)

  /**
   * Offset of chunk [index]'s frame within the contiguous encrypted body.
   * Only meaningful with the real [plaintextChunkSize] of the file (the value
   * the wire carries for non-final chunks); the single-chunk case has no
   * multi-chunk offsets (index is always 0).
   */
  fun encOffset(index: Int, chunkCount: Int, plaintextChunkSize: Long): Long {
    require(chunkCount >= 1) { "chunkCount must be >= 1 (got $chunkCount)" }
    require(index in 0 until chunkCount) { "chunk index $index out of range 0..${chunkCount - 1}" }
    return index * (CHUNK_OVERHEAD_BYTES + plaintextChunkSize)
  }

  /** Plaintext offset where chunk [index]'s decrypted bytes begin. */
  fun plainOffset(index: Int, chunkCount: Int, plaintextChunkSize: Long): Long {
    require(chunkCount >= 1) { "chunkCount must be >= 1 (got $chunkCount)" }
    require(index in 0 until chunkCount) { "chunk index $index out of range 0..${chunkCount - 1}" }
    return index * plaintextChunkSize
  }

  /**
   * The chunk whose plaintext window contains byte [position] of the plaintext
   * stream (0-based; the caller must keep `position < originalSize`).
   */
  fun chunkIndexForPosition(position: Long, chunkCount: Int, plaintextChunkSize: Long): Int {
    require(chunkCount >= 1) { "chunkCount must be >= 1 (got $chunkCount)" }
    if (chunkCount == 1) return 0
    require(plaintextChunkSize > 0) { "plaintextChunkSize must be positive for a multi-chunk file" }
    require(position >= 0) { "position must be >= 0 (got $position)" }
    return (position / plaintextChunkSize).toInt().coerceIn(0, chunkCount - 1)
  }

  /**
   * Validate the framing triple resolved from chunk 0's response headers +
   * the file record's size. Throws [IllegalArgumentException] (the callers
   * wrap it in the module's ERR_CHUNK_METADATA family) when the numbers
   * cannot describe a real chunked body.
   */
  fun validate(chunkCount: Int, plaintextChunkSize: Long, originalSize: Long) {
    if (chunkCount <= 0) {
      throw IllegalArgumentException("chunkCount must be positive (got $chunkCount)")
    }
    if (originalSize <= 0) {
      throw IllegalArgumentException("originalSize must be positive (got $originalSize)")
    }
    if (chunkCount > 1 && plaintextChunkSize <= 0) {
      throw IllegalArgumentException("plaintextChunkSize must be positive for a multi-chunk file (got $plaintextChunkSize)")
    }
    if (chunkCount > 1 && originalSize <= plaintextChunkSize * (chunkCount - 1)) {
      throw IllegalArgumentException(
        "last chunk would be empty: originalSize=$originalSize <= " +
          "plaintextChunkSize*(${chunkCount - 1})=${plaintextChunkSize * (chunkCount - 1)}",
      )
    }
  }
}
