package expo.modules.beebeebcrypto

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.max
import kotlin.math.min
import okhttp3.Call
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.Request as HttpRequest
import okio.BufferedSink
import okhttp3.Response
import org.json.JSONObject
import uniffi.beebeeb_uniffi.ChunkEncryptorHandle
import uniffi.beebeeb_uniffi.ChunkPlanResult
import uniffi.beebeeb_uniffi.MasterKeyHandle
import uniffi.beebeeb_uniffi.planChunks

/**
 * Kotlin port of iOS `NativeManualUploader.swift` (task 1683c). Encrypts a
 * file straight from disk with the shared beebeeb-core
 * `ChunkEncryptorHandle.fromFile` and PUTs each `nonce || ciphertext || tag`
 * frame to the storage-v2 upload session — the same streaming primitive the
 * backup engine uses. The JS side keeps the protocol bookkeeping (session
 * init, resume state, complete, encrypted-name patch); this class only does
 * the work that must not go through the JS heap: reading, encrypting and
 * sending bytes. Plaintext never crosses the bridge, and progress is
 * byte-level (counting `RequestBody`) instead of one tick per chunk.
 *
 * Wire contract mirrors iOS exactly (`NativeManualUploader.swift`):
 *  - profile "mobile" — must match what JS sends to `/api/v1/uploads/init`
 *    (`api.ts initUploadV2` sends `profile: 'mobile'` + the plan this same
 *    core function produces).
 *  - request spacing 120 ms — the JS `rateLimitedFetch` files bucket.
 *  - retry: 429 / 5xx / network errors, 4 attempts max, exponential backoff
 *    capped at 8 s, `Retry-After` honored and capped at 60 s.
 *  - resume: chunks with `index < startChunkIndex` are walked by the
 *    encryptor (so `finish()` runs its integrity guard) but not re-PUT.
 *  - errors carry a `{"bb_upload_error":true,status,code,message}` JSON
 *    envelope in their message so `parseNativeUploadError`
 *    (`src/lib/native-upload-bridge.ts`) can rebuild an `ApiError`.
 */
/** Transport write granularity — byte-level progress ticks per slice. */
private const val TRANSPORT_SLICE_BYTES = 256 * 1024

internal object NativeManualUploader {

  private const val TAG = "BeebeebUpload"

  /**
   * Chunk-plan profile handed to beebeeb-core; must match what JS sends to
   * `/api/v1/uploads/init` (the plan is deterministic in size + profile, so
   * the encryptor rebuilt here for a resumed upload lands on the same
   * frames).
   */
  const val CHUNK_PROFILE = "mobile"

  private const val MAX_ATTEMPTS_PER_CHUNK = 4
  /** Minimum spacing between requests — the JS `rateLimitedFetch` files bucket. */
  private const val REQUEST_SPACING_MS = 120L
  /** AES-256-GCM frame overhead per chunk: 12-byte nonce + 16-byte tag. */
  private const val FRAME_OVERHEAD_BYTES = 28L

  class Request(
    val masterKey: MasterKeyHandle,
    val fileId: String,
    val inputPath: String,
    val apiUrl: String,
    val token: String,
    val uploadSessionId: String,
    val chunkSizeBytes: ULong,
    val chunkCount: ULong,
    val startChunkIndex: UInt,
    val clientVersion: String,
  )

  private val client: OkHttpClient = OkHttpClient.Builder()
    // iOS URLSessionConfiguration: timeoutIntervalForRequest = 60,
    // timeoutIntervalForResource = 6 h, httpMaximumConnectionsPerHost = 2.
    .connectTimeout(60, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .callTimeout(6, TimeUnit.HOURS)
    .dispatcher(Dispatcher().also { it.maxRequestsPerHost = 2 })
    .build()

  private val spacingLock = Any()
  private var lastRequestAtMs = Long.MIN_VALUE

  fun plan(fileSizeBytes: ULong): ChunkPlanResult = planChunks(fileSizeBytes, CHUNK_PROFILE)

  fun upload(req: Request, progress: NativeUploadProgress): Map<String, Any?> {
    val encryptor = ChunkEncryptorHandle.fromFile(
      masterKey = req.masterKey,
      fileId = req.fileId,
      inputPath = req.inputPath,
      profile = CHUNK_PROFILE,
    )
    encryptor.use { enc ->
      val plan = enc.chunkPlan()
      if (plan.chunkSizeBytes != req.chunkSizeBytes || plan.chunkCount != req.chunkCount) {
        throw NativeUploadException.envelope(
          0,
          "chunk_plan_mismatch",
          "Upload session was planned for ${req.chunkCount}×${req.chunkSizeBytes} B " +
            "but the file plans as ${plan.chunkCount}×${plan.chunkSizeBytes} B",
        )
      }
      val bytesTotal = enc.expectedTotalCiphertext().toLong()
      progress.setTotals(chunksTotal = plan.chunkCount.toInt(), bytesTotal = bytesTotal)

      val apiBase = req.apiUrl.trimEnd('/')
      var bytesUploaded = 0L
      var chunksUploaded = req.startChunkIndex.toLong().toInt()
      var cryptoPlainBytes = 0L
      var cryptoElapsedNs = 0L
      var cryptoRate: Double? = null

      while (true) {
        if (progress.isCancelled) throw NativeUploadException.cancelled()
        val startedAt = System.nanoTime()
        val chunk = enc.nextChunk() ?: break
        if (chunk.index.toLong() < req.startChunkIndex.toLong()) {
          // Resume: these frames are already on the server. The encryptor has
          // to walk them anyway so `finish()` can run its integrity guard.
          bytesUploaded += chunk.data.size.toLong()
          continue
        }
        cryptoElapsedNs += System.nanoTime() - startedAt
        cryptoPlainBytes += max(0L, chunk.data.size.toLong() - FRAME_OVERHEAD_BYTES)
        val cryptoElapsedSec = cryptoElapsedNs / 1_000_000_000.0
        if (cryptoElapsedSec > 0.05) cryptoRate = cryptoPlainBytes / cryptoElapsedSec

        progress.beginChunk(
          bytesBefore = bytesUploaded,
          chunksUploaded = chunksUploaded,
          cryptoBytesPerSec = cryptoRate,
        )
        Log.d(TAG, "upload.native.chunk fileId=${req.fileId} index=${chunk.index} bytesUploaded=$bytesUploaded")
        putChunk(
          frame = chunk.data,
          index = chunk.index.toLong().toInt(),
          uploadSessionId = req.uploadSessionId,
          token = req.token,
          apiBase = apiBase,
          clientVersion = req.clientVersion,
          progress = progress,
        )
        bytesUploaded += chunk.data.size.toLong()
        chunksUploaded += 1
        progress.update(
          stage = "uploading",
          chunksUploaded = chunksUploaded,
          bytesUploaded = bytesUploaded,
          cryptoBytesPerSec = cryptoRate,
        )
      }

      // Integrity guard (detects a source that shrank) BEFORE JS tells the
      // server the upload is complete.
      enc.finish()
      if (chunksUploaded != plan.chunkCount.toInt()) {
        throw NativeUploadException.envelope(
          0,
          "chunk_count_mismatch",
          "Encrypted $chunksUploaded of ${plan.chunkCount} planned chunks",
        )
      }
      progress.update(
        stage = "complete",
        chunksUploaded = chunksUploaded,
        bytesUploaded = bytesUploaded,
        cryptoBytesPerSec = cryptoRate,
      )
      return mapOf(
        "chunksUploaded" to chunksUploaded,
        "bytesUploaded" to bytesUploaded,
        "bytesTotal" to bytesTotal,
        "cryptoBytesPerSec" to (cryptoRate ?: 0.0),
      )
    }
  }

  // ─────────────────────────────────── transport ─────────────────────────────

  private fun putChunk(
    frame: ByteArray,
    index: Int,
    uploadSessionId: String,
    token: String,
    apiBase: String,
    clientVersion: String,
    progress: NativeUploadProgress,
  ) {
    val url = "$apiBase/api/v1/uploads/$uploadSessionId/chunks/$index"
    var attempt = 0
    while (true) {
      attempt += 1
      if (progress.isCancelled) throw NativeUploadException.cancelled()
      val spacingDelayMs = reserveRequestSlot()
      if (spacingDelayMs > 0) Thread.sleep(spacingDelayMs)
      // Fresh body per attempt — the counting sink's byte counter restarts.
      val request = HttpRequest.Builder()
        .url(url)
        .header("X-Beebeeb-Client", "mobile-android")
        .header("X-Beebeeb-Client-Version", clientVersion)
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", "Bearer $token")
        .put(CountingRequestBody(frame, progress))
        .build()
      val call = client.newCall(request)
      progress.attachCall(call)
      var backoffDelayMs = 0L
      try {
        call.execute().use { resp ->
          val status = resp.code
          if (status in 200..299) return
          val bodyText = resp.body?.string().orEmpty()
          val (code, message) = parseErrorBody(bodyText, status)
          val retryable = status == 429 || status >= 500
          if (retryable && attempt < MAX_ATTEMPTS_PER_CHUNK) {
            backoffDelayMs = backoffDelay(attempt, retryAfterSeconds(resp))
          } else {
            throw NativeUploadException.envelope(status, code, message)
          }
        }
      } catch (e: IOException) {
        if (progress.isCancelled || call.isCanceled()) throw NativeUploadException.cancelled()
        if (attempt < MAX_ATTEMPTS_PER_CHUNK) {
          backoffDelayMs = backoffDelay(attempt, null)
        } else {
          throw NativeUploadException.envelope(0, "network", e.message ?: "network error")
        }
      }
      if (progress.isCancelled) throw NativeUploadException.cancelled()
      if (backoffDelayMs > 0) Thread.sleep(backoffDelayMs)
    }
  }

  /**
   * Synchronous so the lock never sleeps while held. Returns how long the
   * caller must wait before its request may go out.
   */
  private fun reserveRequestSlot(): Long {
    synchronized(spacingLock) {
      val now = System.currentTimeMillis()
      val reference = if (lastRequestAtMs == Long.MIN_VALUE) Long.MIN_VALUE else lastRequestAtMs
      val wait = if (reference == Long.MIN_VALUE) 0L else REQUEST_SPACING_MS - (now - reference)
      val clamped = max(0L, wait)
      lastRequestAtMs = now + clamped
      return clamped
    }
  }

  private fun backoffDelay(attempt: Int, retryAfterSeconds: Long?): Long {
    val exponentialSec = min(8.0, Math.pow(2.0, (attempt - 1).toDouble()))
    val exponentialMs = (exponentialSec * 1000).toLong()
    val retryAfterMs = (retryAfterSeconds ?: 0L) * 1000
    return max(exponentialMs, retryAfterMs)
  }

  private fun retryAfterSeconds(resp: Response): Long? {
    val raw = resp.header("Retry-After") ?: return null
    val seconds = raw.toLongOrNull() ?: return null
    if (seconds < 0) return null
    return min(seconds, 60L)
  }

  /** Server errors are `{ "error": <machine code>, "message": <human text> }`. */
  private fun parseErrorBody(body: String, status: Int): Pair<String?, String> {
    val fallback = "Upload failed (HTTP $status)"
    if (body.isEmpty()) return Pair(null, fallback)
    val obj = try { JSONObject(body) } catch (_: Exception) { return Pair(null, fallback) }
    val code = if (obj.has("error") && !obj.isNull("error")) obj.getString("error") else null
    val message = when {
      obj.has("message") && !obj.isNull("message") -> obj.getString("message")
      code != null -> code
      else -> fallback
    }
    return Pair(code, message)
  }
}

/**
 * Failure surfaced to JS. The message is a JSON envelope so the TS side can
 * rebuild an `ApiError` (HTTP status + machine code + message) — the same
 * triple the JS chunk uploader throws — instead of pattern-matching free
 * text. `rejectUnexpected` passes `CodedException`s straight through, so the
 * JS error message is exactly the envelope text.
 */
class NativeUploadException private constructor(message: String) : CodedException(
  code = "ERR_NATIVE_UPLOAD",
  message = message,
  cause = null,
) {
  companion object {
    fun envelope(status: Int, code: String?, message: String): NativeUploadException {
      val body = JSONObject()
      body.put("bb_upload_error", true)
      body.put("status", status)
      if (!code.isNullOrEmpty()) body.put("code", code)
      body.put("message", message)
      return NativeUploadException(body.toString())
    }

    fun cancelled(): NativeUploadException = envelope(0, "cancelled", "Upload cancelled")
  }
}

/**
 * Live progress for one upload request — Kotlin port of iOS
 * `NativeUploadProgress` (`NativeManualUploader.swift:39`). The module keeps
 * one per `requestId`; JS polls `getUploadProgressNative(requestId)` and
 * reads the latest snapshot. Byte counts come from the counting request
 * body's transport writes instead of URLSession's `didSendBodyData`.
 */
internal class NativeUploadProgress(val requestId: String) {

  private val lock = ReentrantLock()
  private val snapshot = HashMap<String, Any?>()
  private var cancelled = false
  private var currentCall: Call? = null
  private var bytesBeforeCurrentCall = 0L

  init {
    snapshot["requestId"] = requestId
    snapshot["stage"] = "encrypting"
    snapshot["chunksUploaded"] = 0
    snapshot["chunksTotal"] = 0
    snapshot["bytesUploaded"] = 0L
    snapshot["bytesTotal"] = 0L
  }

  val isCancelled: Boolean
    get() = lock.withLock { cancelled }

  fun currentSnapshot(): Map<String, Any?> = lock.withLock { HashMap(snapshot) }

  fun setTotals(chunksTotal: Int, bytesTotal: Long) {
    lock.withLock {
      snapshot["chunksTotal"] = chunksTotal
      snapshot["bytesTotal"] = bytesTotal
    }
  }

  /** Called right before a frame is PUT: fixes the byte offset transport progress is added to. */
  fun beginChunk(bytesBefore: Long, chunksUploaded: Int, cryptoBytesPerSec: Double?) {
    lock.withLock {
      bytesBeforeCurrentCall = bytesBefore
      currentCall = null
      snapshot["stage"] = "uploading"
      snapshot["chunksUploaded"] = chunksUploaded
      snapshot["bytesUploaded"] = bytesBefore
      if (cryptoBytesPerSec != null) snapshot["cryptoBytesPerSec"] = cryptoBytesPerSec
    }
  }

  /** Called from the counting request body: bytes handed to the transport for the current call. */
  fun onTransportBytes(totalSentForCall: Long) {
    lock.withLock {
      snapshot["bytesUploaded"] = bytesBeforeCurrentCall + totalSentForCall
    }
  }

  fun update(stage: String, chunksUploaded: Int, bytesUploaded: Long, cryptoBytesPerSec: Double?) {
    lock.withLock {
      snapshot["stage"] = stage
      snapshot["chunksUploaded"] = chunksUploaded
      snapshot["bytesUploaded"] = bytesUploaded
      if (cryptoBytesPerSec != null) snapshot["cryptoBytesPerSec"] = cryptoBytesPerSec
    }
  }

  fun fail(message: String) {
    lock.withLock {
      snapshot["stage"] = "error"
      snapshot["error"] = message
    }
  }

  fun cancel() {
    val call = lock.withLock {
      cancelled = true
      currentCall
    }
    call?.cancel()
  }

  fun attachCall(call: Call) {
    lock.withLock {
      currentCall = call
      val shouldCancel = cancelled
      if (shouldCancel) call.cancel()
    }
  }
}

/**
 * `RequestBody` that streams the frame to OkHttp in fixed slices and feeds
 * byte-level progress as the bytes are handed toward the socket — the
 * transport-progress equivalent of iOS URLSession's `didSendBodyData`. The
 * byte offset the slice count is added to is the progress object's own
 * `bytesBeforeCurrentCall` (fixed by `beginChunk`), so each attempt starts
 * from the right offset.
 */
private class CountingRequestBody(
  private val frame: ByteArray,
  private val progress: NativeUploadProgress,
) : RequestBody() {

  override fun contentType() = "application/octet-stream".toMediaTypeOrNull()

  override fun contentLength(): Long = frame.size.toLong()

  override fun writeTo(sink: BufferedSink) {
    var written = 0L
    while (written < frame.size) {
      val n = min(TRANSPORT_SLICE_BYTES.toLong(), frame.size.toLong() - written).toInt()
      sink.write(frame, written.toInt(), n)
      written += n
      progress.onTransportBytes(written)
    }
  }
}