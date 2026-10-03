package expo.modules.beebeebcrypto

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Chunked streaming video playback (task 1683j) — decrypt-as-the-player-reads.
 *
 * Design (task file + Guus's ruling: "download chunks and decrypt the chunks
 * directly — a streaming effect; the user shouldn't wait for the whole 600 MB"):
 *
 *  1. The server stores each AEAD chunk as an INDEPENDENT encrypted blob
 *     (`GET /api/v1/files/{id}/chunks/{i}` — beebeeb-api/src/routes/files.rs
 *     `chunk_router`), so the encrypted body can be fetched per-chunk.
 *  2. `VideoStreamSession` fetches chunks (bounded executor; bodies stream to
 *     a per-session encrypted temp file in 256 KB buffers — the 1683b
 *     bounded-buffer pattern) and decrypts them ONE AT A TIME into a SPARSE
 *     plaintext temp file at each chunk's deterministic plaintext offset
 *     ([VideoChunkMath]).
 *  3. Fill order is `[last, 0, 1, …]` — the TAIL is decrypted first because
 *     MP4/MOV players must parse the moov atom (usually at the END of the
 *     file) before the first frame can be produced; a tail-last order would
 *     gate playback on the whole download again.
 *  4. A loopback-only HTTP server ([VideoStreamServer]) serves the plaintext
 *     file with correct `Accept-Ranges`/206 semantics and a declared
 *     `Content-Length` (the plaintext size is known from the file record).
 *     A range whose chunks are not decrypted yet BLOCKS the response body;
 *     the wait itself triggers on-demand fetch+decrypt of exactly the chunks
 *     the player asked for (single-flight per chunk) — the task's "mid-file
 *     seek = map position → chunk window → decrypt-on-demand" mechanism.
 *     expo-video's player is OkHttpDataSource-based (10 s read timeout), and
 *     Media3's loader retry absorbs a missed window; a chunk fetch on the
 *     LAN lands well inside it.
 *  5. Progress rides the existing `PreviewDownloadProgress` snapshot store +
 *     cancel registry (JS polls `getPreviewLoadProgress`, cancels via
 *     `cancelDownloadAndDecryptFileNative` — no new JS cancel surface). The
 *     `decrypting` stage's percent IS the buffered percent; emissions carry
 *     `streaming: true` so the UI can label them "Streaming · N% buffered".
 *
 * Memory: fetched bodies stream to disk in 256 KB buffers; decrypts run one
 * window at a time (a window is ≤ plaintextChunkSize+28 ≈ 32 MiB at the
 * mobile ladder cap); the HTTP server writes 64 KB buffers. No unbounded
 * heap buffers — the 1683g/i invariant.
 */
internal object VideoStreamer {
  private const val TAG = "BeebeebVideoStream"

  /**
   * Run one streaming session to "playable" (chunk 0 + the last chunk
   * decrypted) and return the start result: the loopback stream URI, the
   * resolved plan, and where the final plaintext lands (the preview-cache
   * output path). The pump continues filling the file in the background;
   * progress + terminal states flow through [progress]. Throws on any
   * pre-playable failure (the caller rejects its promise); on failure the
   * session is torn down here.
   */
  fun start(
    requestId: String?,
    master: uniffi.beebeeb_uniffi.MasterKeyHandle,
    apiUrl: String,
    token: String,
    fileId: String,
    outputUri: String,
    declaredSizeBytes: Long?,
    declaredChunkCount: Int?,
    cacheDir: File,
    clientVersion: String,
    progress: PreviewDownloadProgress,
    /** Module-level terminal cleanup (the progress-registry entries). */
    onTerminal: () -> Unit,
  ): VideoStreamStart {
    val outputPath = android.net.Uri.parse(outputUri).path ?: outputUri.removePrefix("file://")
    val outputFile = File(outputPath)
    val outputParent = outputFile.parentFile
      ?: throw CodedException("ERR_OUTPUT_PATH", "output path has no parent directory", null)
    if (!outputParent.exists()) outputParent.mkdirs()

    val tempDir = File(cacheDir, "beebeeb-stream-$fileId-${UUID.randomUUID()}")
    tempDir.mkdirs()
    val session = VideoStreamSession(
      streamId = UUID.randomUUID().toString().replace("-", ""),
      requestId = requestId ?: "",
      fileId = fileId,
      apiUrl = apiUrl,
      bearerToken = token,
      clientVersion = clientVersion,
      outputFile = outputFile,
      plainTmpFile = File("$outputPath.tmp"),
      encFile = File(tempDir, "encrypted.bin"),
      tempDir = tempDir,
      progress = progress,
      onTerminal = onTerminal,
      masterKey = master,
    )
    progress.onCancelExtra = { session.cancelFromProgress() }
    try {
      // The JS caller checked the cache hit before routing here, so any
      // existing output copy is stale — clear both output positions.
      try { outputFile.delete() } catch (_: Exception) {}
      try { session.plainTmpFile.delete() } catch (_: Exception) {}

      // 1. Chunk 0 defines the framing (window0 - 28 = plaintextChunkSize;
      //    X-Chunk-Count on the response = chunkCount) — the same headers the
      //    whole-file path reads off the full-body response.
      val window0 = session.fetchChunkToDisk(0, encOffset = 0L, expectedLength = -1L)
      if (window0 < 0) throw CodedException("ERR_CANCELLED", "Preview stream cancelled", null)
      val chunkCount = session.lastChunkCountHeader ?: declaredChunkCount ?: 1
      val plaintextChunkSize: Long
      val originalSize: Long
      if (chunkCount <= 1) {
        plaintextChunkSize = 0L
        originalSize = window0 - VideoChunkMath.CHUNK_OVERHEAD_BYTES
        if (declaredSizeBytes != null && declaredSizeBytes != originalSize) {
          Log.w(TAG, "stream.plan size mismatch (single chunk): declared=$declaredSizeBytes actual=$originalSize fileId=$fileId")
        }
      } else {
        plaintextChunkSize = window0 - VideoChunkMath.CHUNK_OVERHEAD_BYTES
        originalSize = declaredSizeBytes
          ?: throw CodedException("ERR_CHUNK_METADATA", "Streaming requires the file's plaintext size", null)
      }
      VideoChunkMath.validate(chunkCount, plaintextChunkSize, originalSize)
      session.resolvePlan(chunkCount, plaintextChunkSize, originalSize)

      // 2. Sparse plaintext file pre-sized to the plaintext length; chunk
      //    writes land at their offsets, holes are never served.
      RandomAccessFile(session.plainTmpFile, "rw").use { raf -> raf.setLength(originalSize) }

      // 3. Chunk 0 is already on disk (the head fetch) — mark + decrypt it.
      session.admitHeadChunk(window0)
      session.decryptChunkFromDisk(0)

      // 4. Pump: fill order [last, 0..count-2] — the moov carrier first.
      // Download-tick emissions stop here; the buffered percent takes over.
      session.muteDownloadEmissions()
      session.startPump()

      // 5. Await playability: the last chunk decrypted → the player's first
      //    open (ftyp + moov parse) succeeds without waiting for the fill.
      //    No artificial timeout: the fetch's own network timeouts + retries
      //    bound it; a fatal failure completes the future as false and the
      //    loop surfaces the session's fatal error.
      val lastFuture = session.ensureChunk(chunkCount - 1)
      while (!lastFuture.isDone) {
        if (session.stopRequested()) {
          throw session.fatalException
            ?: CodedException("ERR_CANCELLED", "Preview stream cancelled", null)
        }
        try { Thread.sleep(100) } catch (_: InterruptedException) { break }
      }
      if (!lastFuture.get()) {
        throw session.fatalException
          ?: CodedException("ERR_STREAM", "Stream failed before it became playable", null)
      }

      val streamUri = VideoStreamServer.register(session)
      Log.i(TAG, "stream.playable requestId=${session.requestId} fileId=$fileId chunks=$chunkCount " +
        "chunkSize=$plaintextChunkSize size=$originalSize uri=$streamUri")
      progress.emitProgress(
        stage = PreviewDownloadProgress.STAGE_DECRYPTING,
        chunksCompleted = session.decryptedCount.get().toInt(),
        chunksTotal = chunkCount,
        extra = mapOf("streaming" to true),
      )
      return VideoStreamStart(
        streamUri = streamUri,
        outputUri = android.net.Uri.fromFile(outputFile).toString(),
        outputPath = outputFile.absolutePath,
        plaintextSize = originalSize,
        chunkCount = chunkCount,
        streamId = session.streamId,
      )
    } catch (t: Throwable) {
      progress.onError(t.message ?: t.javaClass.simpleName)
      session.teardown()
      throw t
    }
  }
}

/** The `streamVideoNative` promise result (JS contract). */
internal class VideoStreamStart(
  val streamUri: String,
  val outputUri: String,
  val outputPath: String,
  val plaintextSize: Long,
  val chunkCount: Int,
  val streamId: String,
)

/**
 * One streaming session: per-chunk fetch+decrypt into a sparse plaintext
 * file, plus the state the HTTP server serves against (framing plan,
 * decrypted-chunk coverage, single-flight chunk futures).
 */
internal class VideoStreamSession(
  val streamId: String,
  val requestId: String,
  val fileId: String,
  private val apiUrl: String,
  private val bearerToken: String,
  private val clientVersion: String,
  val outputFile: File,
  val plainTmpFile: File,
  private val encFile: File,
  private val tempDir: File,
  private val progress: PreviewDownloadProgress,
  private val onTerminal: () -> Unit,
  private val masterKey: uniffi.beebeeb_uniffi.MasterKeyHandle,
) {
  private val complete = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private val tornDown = AtomicBoolean(false)
  @Volatile var fatalException: Throwable? = null
    private set

  // Framing plan (resolved before any chunk math runs; the pump/server start
  // after resolvePlan, and the server reaches the session through the
  // registry map, so plain fields are safe to read).
  private var chunkCount: Int = 0
  private var plaintextChunkSize: Long = 0
  private var originalSize: Long = 0

  /** Decrypted/fetched coverage. Guarded by [chunkStateLock]. */
  private val chunkStateLock = Any()
  private val decryptedChunks = java.util.BitSet()
  private val downloadedChunks = java.util.BitSet()
  val decryptedCount = AtomicLong(0)
  private val downloadedBytes = AtomicLong(0)

  /** Single-flight chunk futures: the pump + on-demand requests share them. */
  private val inFlight = ConcurrentHashMap<Int, CompletableFuture<Boolean>>()

  private val decryptPermits = Semaphore(DECRYPT_PERMITS)

  private val fetchExecutor: ExecutorService = Executors.newFixedThreadPool(FETCH_CONCURRENCY) { r ->
    Thread(r, "beebeeb-stream-fetch-${fileId.take(8)}").apply { isDaemon = true }
  }
  private val decryptExecutor: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "beebeeb-stream-decrypt-${fileId.take(8)}").apply { isDaemon = true }
  }

  /** HTTP per-chunk fetches; cancel() tears the in-flight ones down.
   *  READ TIMEOUT (run 4, the buffered-48% stall): a chunk is ≤ 4 MiB — a
   *  read that idles 30 s mid-body is a STALLED connection, not a slow one.
   *  The old 600 s (1683b's whole-file body timeout) turned a hung read into
   *  a 10-minute silent pump freeze; 30 s + the 3× retry converts it into a
   *  fast recover (or a loud fatal). */
  private val client = OkHttpClient.Builder()
    .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
    .readTimeout(CHUNK_READ_TIMEOUT_S, TimeUnit.SECONDS)
    .build()
  private val openCalls = ConcurrentHashMap<String, okhttp3.Call>()

  /** Open HTTP-serve connections, closed on teardown. */
  val openConnections = ConcurrentHashMap<Socket, Boolean>()

  @Volatile private var fileKey: uniffi.beebeeb_uniffi.FileKeyHandle? = null
  @Volatile var lastChunkCountHeader: Int? = null
    private set

  /**
   * Download-stage emissions are muted once the pump starts: from then on the
   * user-facing signal IS the buffered percent (the `decrypting`+streaming
   * events); download ticks would only flap the UI text back to
   * "Downloading…". The head fetch (pre-playable) still emits.
   */
  @Volatile private var downloadEmissionsMuted = false

  /** Called by `VideoStreamer.start` right before the pump starts. */
  fun muteDownloadEmissions() {
    downloadEmissionsMuted = true
  }

  /** Cancelled by the user (progress.cancel) OR by a fatal internal failure. */
  fun stopRequested(): Boolean = cancelled.get() || progress.isCancelled()

  fun chunkPlan(): VideoChunkPlan? {
    if (chunkCount == 0) return null
    return VideoChunkPlan(chunkCount, plaintextChunkSize, originalSize)
  }

  fun resolvePlan(chunkCount: Int, plaintextChunkSize: Long, originalSize: Long) {
    synchronized(chunkStateLock) {
      decryptedChunks.clear()
      downloadedChunks.clear()
    }
    this.chunkCount = chunkCount
    this.plaintextChunkSize = plaintextChunkSize
    this.originalSize = originalSize
  }

  fun encryptedTotalBytes(): Long {
    var total = 0L
    for (index in 0 until chunkCount) {
      total += VideoChunkMath.windowSize(index, chunkCount, plaintextChunkSize, originalSize)
    }
    return total
  }

  private fun planTriple(): Triple<Int, Long, Long> = Triple(chunkCount, plaintextChunkSize, originalSize)

  /** Wire chunk 0's on-disk head fetch into the state (byte 0 of the enc file). */
  fun admitHeadChunk(window0: Long) {
    synchronized(chunkStateLock) {
      downloadedChunks.set(0)
      downloadedBytes.addAndGet(window0)
    }
    progress.emitDownload(downloadedBytes.get(), encryptedTotalBytes())
  }

  /**
   * The single-flight primitive: fetch+decrypt chunk [index] (a no-op when it
   * is already decrypted). Used by BOTH the pump (ordered fill) and the HTTP
   * server (on-demand for a mid-file seek), so a seek never double-fetches a
   * chunk the pump is already fetching.
   */
  fun ensureChunk(index: Int): CompletableFuture<Boolean> {
    synchronized(chunkStateLock) {
      if (decryptedChunks.get(index)) {
        return CompletableFuture.completedFuture(true)
      }
    }
    val future = CompletableFuture<Boolean>()
    val raced = inFlight.putIfAbsent(index, future)
    if (raced != null) return raced
    Log.i(TAG, "stream.ensure.new chunk=$index inFlight=${inFlight.size} decrypted=${decryptedCount.get()}/$chunkCount")
    // The OWNER (this call) starts the work only after winning the map slot,
    // so a racing caller can never duplicate the fetch.
    fetchExecutor.execute {
      try {
        if (stopRequested() || complete.get()) {
          future.complete(false)
          return@execute
        }
        val expected = VideoChunkMath.windowSize(index, chunkCount, plaintextChunkSize, originalSize)
        fetchChunkToDisk(index, VideoChunkMath.encOffset(index, chunkCount, plaintextChunkSize), expected)
        if (stopRequested() || complete.get()) {
          future.complete(false)
          return@execute
        }
        decryptExecutor.execute {
          try {
            if (stopRequested() || complete.get()) {
              future.complete(false)
              return@execute
            }
            future.complete(decryptChunkFromDisk(index))
          } catch (t: Throwable) {
            completeFailure(index, t, future)
          }
        }
      } catch (t: Throwable) {
        completeFailure(index, t, future)
      }
    }
    return future
  }

  /** Server-side blocking wait for one chunk (triggering the on-demand fetch). */
  fun awaitChunk(index: Int): Boolean = try {
    ensureChunk(index).get(CHUNK_WAIT_TIMEOUT_S, TimeUnit.SECONDS)
  } catch (_: Exception) {
    false
  }

  private fun completeFailure(index: Int, t: Throwable, future: CompletableFuture<Boolean>) {
    if (stopRequested() || complete.get()) {
      future.complete(false)
      return
    }
    future.complete(false)
    fail("chunk $index failed: ${t.message ?: t.javaClass.simpleName}")
  }

  /**
   * Fetch chunk [index]'s encrypted bytes to the enc temp file at [encOffset]
   * (with retries). `expectedLength < 0` means unknown (chunk 0 defines the
   * framing); otherwise a mismatch is a non-retryable framing error. Returns
   * the bytes actually written, or -1 when the session stopped first.
   * Module-visible: `VideoStreamer.start` bootstraps the framing with the
   * chunk-0 head fetch.
   */
  fun fetchChunkToDisk(index: Int, encOffset: Long, expectedLength: Long): Long {
    val url = "${apiUrl.trimEnd('/')}/api/v1/files/$fileId/chunks/$index"
    var lastError: Exception? = null
    repeat(FETCH_ATTEMPTS) { attemptZeroBased ->
      val attempt = attemptZeroBased + 1
      if (stopRequested() || complete.get()) return -1L
      val request = Request.Builder()
        .url(url)
        .header("Authorization", "Bearer $bearerToken")
        .header("X-Beebeeb-Client", "mobile-android")
        .header("X-Beebeeb-Client-Version", clientVersion)
        .build()
      val call = client.newCall(request)
      openCalls["$index:$attempt"] = call
      val fetchStartedAt = android.os.SystemClock.elapsedRealtime()
      Log.i(TAG, "stream.fetch.begin chunk=$index attempt=$attempt expected=$expectedLength")
      try {
        call.execute().use { resp ->
          if (!resp.isSuccessful) {
            throw CodedException("ERR_DOWNLOAD_HTTP", "Chunk $index fetch failed with HTTP ${resp.code}", null)
          }
          resp.header("X-Chunk-Count")?.toIntOrNull()?.let { lastChunkCountHeader = it }
          val contentLength = resp.header("Content-Length")?.toLongOrNull() ?: -1L
          if (expectedLength >= 0 && contentLength >= 0 && contentLength != expectedLength) {
            throw CodedException(
              "ERR_CHUNK_SIZE",
              "Chunk $index is $contentLength bytes on the wire, expected $expectedLength",
              null,
            )
          }
          val body = resp.body ?: throw CodedException("ERR_DOWNLOAD_BODY", "Chunk $index response has no body", null)
          val buf = ByteArray(DOWNLOAD_BUFFER_SIZE)
          var written = 0L
          RandomAccessFile(encFile, "rw").use { raf ->
            raf.seek(encOffset)
            val source = body.byteStream()
            while (true) {
              if (stopRequested()) return -1L
              val n = source.read(buf)
              if (n < 0) break
              if (n > 0) {
                raf.write(buf, 0, n)
                written += n
              }
            }
          }
          if (expectedLength >= 0 && written != expectedLength) {
            throw CodedException("ERR_TRUNCATED", "Chunk $index delivered $written of $expectedLength bytes", null)
          }
          synchronized(chunkStateLock) {
            downloadedChunks.set(index)
            downloadedBytes.addAndGet(written)
          }
          Log.i(TAG, "stream.fetch.done chunk=$index bytes=$written in=${android.os.SystemClock.elapsedRealtime() - fetchStartedAt}ms frontier_kb=${downloadedBytes.get() / 1024}")
          if (!downloadEmissionsMuted) {
            progress.emitDownload(downloadedBytes.get(), encryptedTotalBytes())
          }
          return written
        }
      } catch (e: Exception) {
        if (stopRequested() || complete.get()) return -1L
        Log.w(TAG, "stream.fetch.retry chunk=$index attempt=$attempt error=${e.message ?: e.javaClass.simpleName}")
        if (e is CodedException && e.code in NON_RETRYABLE_FETCH_CODES) throw e
        lastError = e
        try { Thread.sleep(500L * attempt) } catch (_: InterruptedException) { return -1L }
      } finally {
        openCalls.remove("$index:$attempt")
      }
    }
    throw lastError ?: CodedException("ERR_DOWNLOAD_HTTP", "Chunk $index fetch failed", null)
  }

  /**
   * Decrypt chunk [index] from the enc temp file into the plaintext temp file
   * at its deterministic offset. One window at a time (the decrypt permit).
   */
  fun decryptChunkFromDisk(index: Int): Boolean {
    if (stopRequested() || complete.get()) return false
    val (count, chunkSize, size) = planTriple()
    if (!synchronized(chunkStateLock) { downloadedChunks.get(index) }) {
      throw CodedException("ERR_STREAM_STATE", "Chunk $index not downloaded", null)
    }
    decryptPermits.acquire()
    try {
      if (stopRequested() || complete.get()) return false
      if (fileKey == null) {
        fileKey = masterKey.deriveFileKey(fileId.toByteArray(Charsets.UTF_8))
      }
      val windowSize = VideoChunkMath.windowSize(index, count, chunkSize, size)
      val window = ByteArray(windowSize.toInt())
      RandomAccessFile(encFile, "r").use { raf ->
        raf.seek(VideoChunkMath.encOffset(index, count, chunkSize))
        raf.readFully(window)
      }
      val nonce = window.copyOfRange(0, VideoChunkMath.NONCE_BYTES)
      val ciphertext = window.copyOfRange(VideoChunkMath.NONCE_BYTES, window.size)
      val plaintext = fileKey!!.decryptChunk(nonce, ciphertext)
      RandomAccessFile(plainTmpFile, "rw").use { raf ->
        raf.seek(VideoChunkMath.plainOffset(index, count, chunkSize))
        raf.write(plaintext)
      }
      synchronized(chunkStateLock) { decryptedChunks.set(index) }
      val done = decryptedCount.incrementAndGet()
      Log.i(TAG, "stream.decrypt.done chunk=$index buffered=$done/$count")
      progress.emitProgress(
        stage = PreviewDownloadProgress.STAGE_DECRYPTING,
        chunksCompleted = done.toInt(),
        chunksTotal = count,
        extra = mapOf("streaming" to true),
      )
      if (done.toInt() >= count) finalizeSuccess()
      return true
    } finally {
      decryptPermits.release()
    }
  }

  /**
   * The pump: submit the fill order (the bounded fetch executor throttles the
   * wire), then join it in order; the final decrypt finalizes the session.
   */
  fun startPump() {
    val count = chunkCount
    val fillOrder = buildList {
      add(count - 1)
      for (index in 0 until count - 1) add(index)
    }
    Thread({
      try {
        fillOrder.forEach { ensureChunk(it) } // submit; bounded by the fetch executor
        for (index in fillOrder) {
          if (!ensureChunk(index).get() || stopRequested()) return@Thread
        }
        // finalizeSuccess already ran inside the last decryptChunkFromDisk.
      } catch (e: Exception) {
        if (!stopRequested() && !complete.get()) {
          fail("pump failed: ${e.message ?: e.javaClass.simpleName}")
        }
      }
    }, "beebeeb-stream-pump-${fileId.take(8)}").apply {
      isDaemon = true
      start()
    }
  }

  /** All chunks decrypted: flush, rename into the output path, emit complete. */
  private fun finalizeSuccess() {
    if (!complete.compareAndSet(false, true)) return
    val renamed = try {
      plainTmpFile.renameTo(outputFile)
    } catch (_: Exception) {
      false
    }
    if (!renamed) {
      fail("Could not finalize the decrypted stream output")
      return
    }
    Log.i(TAG, "stream.complete requestId=$requestId fileId=$fileId size=${outputFile.length()}")
    progress.onComplete()
    teardown()
  }

  /** Fatal failure: emit error, abort waiters, clean up. */
  fun fail(reason: String) {
    if (complete.get()) return
    if (!cancelled.compareAndSet(false, true)) return
    fatalException = CodedException("ERR_STREAM", reason, null)
    Log.e(TAG, "stream.error requestId=$requestId fileId=$fileId reason=$reason")
    progress.onError(reason)
    teardown()
  }

  /** Wired as `PreviewDownloadProgress`'s cancel hook by the module. */
  fun cancelFromProgress() {
    if (complete.get() || cancelled.get()) return
    cancelled.set(true)
    Log.i(TAG, "stream.cancelled requestId=$requestId fileId=$fileId")
    teardown()
  }

  fun isCancelled(): Boolean = cancelled.get()

  fun isComplete(): Boolean = complete.get()

  /** Idempotent terminal teardown: close sockets/calls, free the key, sweep temps. */
  fun teardown() {
    if (!tornDown.compareAndSet(false, true)) return
    for (socket in openConnections.keys.toList()) {
      try { socket.close() } catch (_: Exception) {}
    }
    openConnections.clear()
    for (key in openCalls.keys.toList()) {
      openCalls.remove(key)?.cancel()
    }
    try { fetchExecutor.shutdownNow() } catch (_: Exception) {}
    try { decryptExecutor.shutdownNow() } catch (_: Exception) {}
    try { fileKey?.close() } catch (_: Exception) {}
    fileKey = null
    try { tempDir.deleteRecursively() } catch (_: Exception) {}
    // A partial (holey) plaintext must never be served later — delete the
    // .tmp; a COMPLETE stream renamed it into place already.
    if (!complete.get()) {
      try { plainTmpFile.delete() } catch (_: Exception) {}
    }
    try { onTerminal() } catch (_: Exception) {}
    VideoStreamServer.unregister(streamId)
  }

  /** The plaintext file requests are served from (tmp while streaming, output after). */
  fun currentPlaintextFile(): File = if (complete.get() && outputFile.exists()) outputFile else plainTmpFile

  companion object {
    private const val TAG = "BeebeebVideoStream"
    private const val CONNECT_TIMEOUT_S = 30L
    private const val CHUNK_READ_TIMEOUT_S = 30L
    private const val CHUNK_WAIT_TIMEOUT_S = 120L
    private const val DECRYPT_PERMITS = 1
    private const val FETCH_CONCURRENCY = 4
    private const val FETCH_ATTEMPTS = 3
    private const val DOWNLOAD_BUFFER_SIZE = 256 * 1024
    /** A framing disagreement (record vs wire) is not a network flap — fail fast. */
    private val NON_RETRYABLE_FETCH_CODES = setOf("ERR_CHUNK_SIZE", "ERR_TRUNCATED")
  }
}

/** The framing plan the HTTP server's range math reads. */
internal class VideoChunkPlan(
  val chunkCount: Int,
  val plaintextChunkSize: Long,
  val originalSize: Long,
) {
  fun chunkIndexForPosition(position: Long): Int =
    VideoChunkMath.chunkIndexForPosition(position, chunkCount, plaintextChunkSize)
}

/**
 * Loopback-only HTTP server exposing the decrypted stream to the player
 * (ExoPlayer via expo-video's OkHttpDataSource — an http URI is required for
 * range/blocking semantics; a file URI over a growing sparse file fails at
 * the extractor).
 *
 * One request per connection (`Connection: close`) — Media3 re-opens per read
 * window anyway. Range math: 200 for whole-file requests, 206 for ranges,
 * 416 for out-of-bounds; a range beyond the decrypted coverage triggers
 * on-demand chunk fetch+decrypt and blocks the body until it lands.
 */
internal object VideoStreamServer {
  private const val TAG = "BeebeebVideoStream"
  /** Body-write buffer per serve connection (bounded — 1683g/i invariant). */
  private const val SERVER_WRITE_BUFFER = 64 * 1024
  private val serverLock = Any()
  private var serverSocket: ServerSocket? = null
  private val sessions = ConcurrentHashMap<String, VideoStreamSession>()

  /** Register a session; returns its loopback stream URI. */
  fun register(session: VideoStreamSession): String {
    val port = ensureStarted()
    sessions[session.streamId] = session
    evictOldSessions()
    val name = "v.${session.outputFile.extension.ifEmpty { "mp4" }}"
    return "http://127.0.0.1:$port/s/${session.streamId}/$name"
  }

  fun unregister(streamId: String) {
    sessions.remove(streamId)
  }

  private fun evictOldSessions() {
    if (sessions.size <= 8) return
    // Evict COMPLETE sessions first; live streams are never evicted (a
    // mid-play eviction would break the player's next read window).
    val excess = sessions.size - 8
    val evictable = sessions.entries
      .filter { it.value.isComplete() }
      .map { it.key }
      .take(excess)
    evictable.forEach { sessions.remove(it) }
  }

  @Synchronized
  private fun ensureStarted(): Int {
    serverSocket?.let { return it.localPort }
    // ANY-IPv6 bind (::) + loopback reachability: a loopback-only bind
    // ([::1]) is NOT reachable from an OkHttp request to 127.0.0.1 on this
    // Android (the first stream attempt failed ConnectException: Failed to
    // connect to /127.0.0.1:32789 with the server on [::1]) — the app's
    // network stack resolves "127.0.0.1" to the IPv4 loopback only. Binding
    // to :: accepts both the IPv6 loopback and the IPv4-mapped form;
    // inbound connections are restricted to loopback at ACCEPT time below.
    val socket = ServerSocket()
    socket.reuseAddress = true
    try {
      socket.bind(java.net.InetSocketAddress("::", 0))
    } catch (_: Exception) {
      socket.bind(java.net.InetSocketAddress(InetAddress.getLoopbackAddress(), 0))
    }
    serverSocket = socket
    Thread({
      while (!socket.isClosed) {
        try {
          val client = socket.accept()
          // Loopback-only enforcement (the bind is any-interface): a
          // non-loopback peer is refused immediately.
          val addr = client.inetAddress
          if (!addr.isLoopbackAddress) {
            try { client.close() } catch (_: Exception) {}
            continue
          }
          Thread({ serve(client) }, "beebeeb-stream-serve").apply {
            isDaemon = true
            start()
          }
        } catch (_: Exception) {
          if (socket.isClosed) return@Thread
        }
      }
    }, "beebeeb-stream-accept").apply {
      isDaemon = true
      start()
    }
    Log.i(TAG, "stream.server.listening port=${socket.localPort}")
    return socket.localPort
  }

  private fun serve(socket: Socket) {
    try {
      socket.soTimeout = 15_000 // request-header read bound
      val reader = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
      val requestLine = reader.readLine() ?: return
      val rangeHeader = readHeaders(reader)
      val parts = requestLine.split(" ")
      if (parts.size < 2) {
        respondError(socket, 400, "Bad request")
        return
      }
      val method = parts[0].uppercase(Locale.US)
      val path = parts[1]
      val streamId = path.removePrefix("/s/").substringBefore('/')
      val session = sessions[streamId]
      if (session == null) {
        respondError(socket, 404, "Unknown stream")
        return
      }
      session.openConnections[socket] = true
      try {
        when (method) {
          "GET" -> serveGet(socket, session, rangeHeader)
          "HEAD" -> serveHead(socket, session, rangeHeader)
          else -> respondError(socket, 405, "Method not allowed")
        }
      } finally {
        session.openConnections.remove(socket)
      }
    } catch (_: Exception) {
      // Client went away / malformed request — the socket dies with us.
    } finally {
      try { socket.close() } catch (_: Exception) {}
    }
  }

  /** Reads header lines up to the blank line; returns the Range header value. */
  private fun readHeaders(reader: java.io.BufferedReader): String? {
    var range: String? = null
    while (true) {
      val line = reader.readLine() ?: break
      if (line.isEmpty()) break
      val colon = line.indexOf(':')
      if (colon <= 0) continue
      val name = line.substring(0, colon).trim().lowercase(Locale.US)
      if (name == "range") range = line.substring(colon + 1).trim()
    }
    return range
  }

  private fun resolveRange(rangeHeader: String?, total: Long): Pair<Long, Long> {
    if (rangeHeader.isNullOrEmpty()) return Pair(0, total - 1)
    val spec = rangeHeader.removePrefix("bytes=").trim()
    val dash = spec.indexOf('-')
    if (dash < 0) throw IllegalArgumentException("Malformed Range header")
    val startRaw = spec.substring(0, dash).trim()
    val endRaw = spec.substring(dash + 1).trim()
    return when {
      startRaw.isEmpty() && endRaw.isNotEmpty() -> {
        // Suffix range: the last N bytes.
        val n = endRaw.toLongOrNull() ?: throw IllegalArgumentException("Malformed Range header")
        Pair(maxOf(0, total - n), total - 1)
      }
      else -> {
        val start = startRaw.toLongOrNull() ?: throw IllegalArgumentException("Malformed Range header")
        val end = if (endRaw.isEmpty()) total - 1 else minOf(endRaw.toLongOrNull() ?: (total - 1), total - 1)
        Pair(start, end)
      }
    }
  }

  private fun serveHead(socket: Socket, session: VideoStreamSession, rangeHeader: String?) {
    val plan = session.chunkPlan() ?: run {
      respondError(socket, 503, "Stream not ready")
      return
    }
    val (start, end) = try {
      resolveRange(rangeHeader, plan.originalSize)
    } catch (_: IllegalArgumentException) {
      respondError(socket, 416, "Range not satisfiable")
      return
    }
    if (start > end || start >= plan.originalSize) {
      respondError(socket, 416, "Range not satisfiable")
      return
    }
    socket.getOutputStream().apply {
      write(buildHeaders(session, 206, start, end, plan.originalSize).toByteArray(Charsets.ISO_8859_1))
      flush()
    }
  }

  private fun serveGet(socket: Socket, session: VideoStreamSession, rangeHeader: String?) {
    val plan = session.chunkPlan() ?: run {
      respondError(socket, 503, "Stream not ready")
      return
    }
    val (start, end) = try {
      resolveRange(rangeHeader, plan.originalSize)
    } catch (_: IllegalArgumentException) {
      respondError(socket, 416, "Range not satisfiable")
      return
    }
    if (start > end || start >= plan.originalSize) {
      respondError(socket, 416, "Range not satisfiable")
      return
    }
    val status = if (rangeHeader.isNullOrEmpty()) 200 else 206
    Log.i(TAG, "stream.serve.open start=$start end=$end total=${plan.originalSize} status=$status buffered=${session.decryptedCount.get()}/${plan.chunkCount}")
    val out = BufferedOutputStream(socket.getOutputStream())
    out.write(buildHeaders(session, status, start, end, plan.originalSize).toByteArray(Charsets.ISO_8859_1))
    out.flush()

    // The body: stream the plaintext file, blocking (on-demand) beyond the
    // decrypted coverage. A mid-body wait failure aborts the connection — the
    // player's loader retry re-opens a fresh request.
    socket.soTimeout = 0 // the body may block on the frontier
    val buf = ByteArray(SERVER_WRITE_BUFFER)
    RandomAccessFile(session.currentPlaintextFile(), "r").use { raf ->
      var pos = start
      while (pos <= end) {
        if (session.stopRequested()) break
        val chunkIndex = plan.chunkIndexForPosition(pos)
        val bufferedBefore = session.decryptedCount.get().toInt()
        val chunkWaitStartedAt = android.os.SystemClock.elapsedRealtime()
        if (!session.awaitChunk(chunkIndex)) {
          Log.w(TAG, "stream.serve.aborted pos=$pos chunk=$chunkIndex bufferedNow=$bufferedBefore waitedMs=${android.os.SystemClock.elapsedRealtime() - chunkWaitStartedAt}")
          break
        }
        // Log only REAL frontier waits (the on-demand path) — per-64KB-window
        // logging floods the logcat ring (~40 lines/s).
        val waitedMs = android.os.SystemClock.elapsedRealtime() - chunkWaitStartedAt
        if (waitedMs > 0L) {
          Log.i(TAG, "stream.serve.chunk-wait pos=$pos chunk=$chunkIndex waitedMs=$waitedMs bufferedBefore=$bufferedBefore bufferedNow=${session.decryptedCount.get()}")
        }
        val chunkPlainEnd = VideoChunkMath.plainOffset(chunkIndex, plan.chunkCount, plan.plaintextChunkSize) +
          VideoChunkMath.plaintextSize(chunkIndex, plan.chunkCount, plan.plaintextChunkSize, plan.originalSize) - 1
        val readLen = minOf(buf.size.toLong(), end - pos + 1, chunkPlainEnd - pos + 1).toInt()
        if (readLen <= 0) break
        raf.seek(pos)
        raf.readFully(buf, 0, readLen)
        out.write(buf, 0, readLen)
        out.flush()
        pos += readLen
      }
    }
  }

  private fun buildHeaders(
    session: VideoStreamSession,
    status: Int,
    start: Long,
    end: Long,
    total: Long,
  ): String {
    val mime = when (session.outputFile.extension.lowercase(Locale.US)) {
      "mov" -> "video/quicktime"
      "webm" -> "video/webm"
      "mkv" -> "video/x-matroska"
      "3gp" -> "video/3gpp"
      else -> "video/mp4"
    }
    val sb = StringBuilder()
    sb.append("HTTP/1.1 ").append(status).append(if (status == 206) " Partial Content" else " OK").append("\r\n")
    if (status == 206) {
      sb.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(total).append("\r\n")
      sb.append("Content-Length: ").append(end - start + 1).append("\r\n")
    } else {
      sb.append("Content-Length: ").append(total).append("\r\n")
    }
    sb.append("Content-Type: ").append(mime).append("\r\n")
    sb.append("Accept-Ranges: bytes\r\n")
    sb.append("Cache-Control: no-store\r\n")
    sb.append("Connection: close\r\n")
    sb.append("\r\n")
    return sb.toString()
  }

  private fun respondError(socket: Socket, code: Int, message: String) {
    try {
      socket.getOutputStream().apply {
        write(
          ("HTTP/1.1 $code $message\r\nContent-Length: ${message.length}\r\n" +
            "Content-Type: text/plain\r\nConnection: close\r\n\r\n$message")
            .toByteArray(Charsets.ISO_8859_1),
        )
        flush()
      }
    } catch (_: Exception) {}
  }
}
