package expo.modules.beebeebcrypto

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Task 1683j — the chunk index → byte-offset map the streaming engine and the
 * local HTTP server are built on. The two real vault videos (163 MB each,
 * uploaded with the mobile profile → 8 MiB chunks) and Guus's 600 MB test
 * file (32 MiB chunks) are the concrete sizes these cases mirror.
 */
class VideoChunkMathTest {

  @Test
  fun `single chunk carries the whole plaintext`() {
    val originalSize = 5_000_000L
    assertEquals(originalSize, VideoChunkMath.plaintextSize(0, 1, 0, originalSize))
    assertEquals(28 + originalSize, VideoChunkMath.windowSize(0, 1, 0, originalSize))
    assertEquals(0L, VideoChunkMath.encOffset(0, 1, 0))
    assertEquals(0L, VideoChunkMath.plainOffset(0, 1, 0))
    assertEquals(0, VideoChunkMath.chunkIndexForPosition(0, 1, 0))
    assertEquals(0, VideoChunkMath.chunkIndexForPosition(originalSize - 1, 1, 0))
  }

  @Test
  fun `sixteen thirty MB video — 8 MiB chunks like the real vault videos`() {
    // 163 MB video, mobile profile: base ladder target = 163/32 ≈ 5.1 MB →
    // next pow2 = 8 MiB; ~20 chunks + a remainder last chunk.
    val originalSize = 170_917_376L // 163 MiB
    val chunkSize = 8L * 1024 * 1024
    val chunkCount = ((originalSize + chunkSize - 1) / chunkSize).toInt() // 21
    // Non-final chunks are full; the last carries the remainder.
    assertEquals(chunkSize, VideoChunkMath.plaintextSize(0, chunkCount, chunkSize, originalSize))
    assertEquals(
      originalSize - chunkSize * (chunkCount - 1),
      VideoChunkMath.plaintextSize(chunkCount - 1, chunkCount, chunkSize, originalSize),
    )
    // The offset map is linear: chunk i starts at i*(28+chunkSize) on the wire.
    assertEquals(0L, VideoChunkMath.encOffset(0, chunkCount, chunkSize))
    assertEquals(28 + chunkSize, VideoChunkMath.encOffset(1, chunkCount, chunkSize))
    assertEquals(
      (chunkCount - 1) * (28 + chunkSize),
      VideoChunkMath.encOffset(chunkCount - 1, chunkCount, chunkSize),
    )
    // Plaintext offsets are i*chunkSize for the same reason.
    assertEquals(0L, VideoChunkMath.plainOffset(0, chunkCount, chunkSize))
    assertEquals(chunkSize, VideoChunkMath.plainOffset(1, chunkCount, chunkSize))
    assertEquals(
      (chunkCount - 1) * chunkSize,
      VideoChunkMath.plainOffset(chunkCount - 1, chunkCount, chunkSize),
    )
    // Position → chunk: every byte of the file maps into a window.
    assertEquals(0, VideoChunkMath.chunkIndexForPosition(0, chunkCount, chunkSize))
    assertEquals(1, VideoChunkMath.chunkIndexForPosition(chunkSize, chunkCount, chunkSize))
    assertEquals(
      chunkCount - 1,
      VideoChunkMath.chunkIndexForPosition(originalSize - 1, chunkCount, chunkSize),
    )
  }

  @Test
  fun `600 MB video — 32 MiB chunks (mobile cap), 19 chunks`() {
    val originalSize = 629_145_600L // 600 MiB
    val chunkSize = 32L * 1024 * 1024
    val chunkCount = ((originalSize + chunkSize - 1) / chunkSize).toInt() // 19 (18 full + 24 MiB remainder)
    assertEquals(19, chunkCount)
    // The full encrypted length is originalSize + 28*chunkCount — the map's
    // telescoping sum, asserted as the invariant the engine validates against.
    var encTotal = 0L
    for (index in 0 until chunkCount) {
      encTotal += VideoChunkMath.windowSize(index, chunkCount, chunkSize, originalSize)
    }
    assertEquals(originalSize + 28L * chunkCount, encTotal)
    // Chunk 0's window carries the plaintext chunk size (the engine derives
    // plaintextChunkSize from it: window0 - 28).
    assertEquals(chunkSize, VideoChunkMath.windowSize(0, chunkCount, chunkSize, originalSize) - 28L)
  }

  @Test
  fun `window sizes tile the encrypted body exactly`() {
    val originalSize = 10_000_000L
    val chunkSize = 4L * 1024 * 1024
    val chunkCount = 3 // 4 MiB + 4 MiB + remainder (1_835_008)
    val last = VideoChunkMath.plaintextSize(2, chunkCount, chunkSize, originalSize)
    assertEquals(originalSize - 2 * chunkSize, last)
    var encCursor = 0L
    var plainCursor = 0L
    for (index in 0 until chunkCount) {
      val expectedPlain = if (index == chunkCount - 1) last else chunkSize
      assertEquals(encCursor, VideoChunkMath.encOffset(index, chunkCount, chunkSize))
      assertEquals(plainCursor, VideoChunkMath.plainOffset(index, chunkCount, chunkSize))
      assertEquals(28 + expectedPlain, VideoChunkMath.windowSize(index, chunkCount, chunkSize, originalSize))
      encCursor += VideoChunkMath.windowSize(index, chunkCount, chunkSize, originalSize)
      plainCursor += expectedPlain
    }
    assertEquals(originalSize + 28L * chunkCount, encCursor)
    assertEquals(originalSize, plainCursor)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `validate rejects a zero chunk count`() {
    VideoChunkMath.validate(0, 8L * 1024 * 1024, 100L)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `validate rejects a non-positive original size`() {
    VideoChunkMath.validate(2, 8L * 1024 * 1024, 0L)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `validate rejects an empty last chunk`() {
    // 2 chunks of 8 MiB each but an original size that leaves nothing for the last.
    VideoChunkMath.validate(2, 8L * 1024 * 1024, 8L * 1024 * 1024)
  }

  @Test
  fun `validate accepts a one-byte last chunk`() {
    VideoChunkMath.validate(2, 8L * 1024 * 1024, 8L * 1024 * 1024 + 1)
  }

  @Test
  fun `chunk 0 is fetched first for the head — its window defines the chunk size`() {
    // The engine fetches chunk 0 to resolve the plan: Content-Length(0) - 28
    // must equal the plaintext chunk size the rest of the map assumes.
    val originalSize = 629_145_600L
    val chunkSize = 32L * 1024 * 1024
    val chunkCount = 20
    assertEquals(
      chunkSize,
      VideoChunkMath.windowSize(0, chunkCount, chunkSize, originalSize) - VideoChunkMath.CHUNK_OVERHEAD_BYTES,
    )
  }
}
