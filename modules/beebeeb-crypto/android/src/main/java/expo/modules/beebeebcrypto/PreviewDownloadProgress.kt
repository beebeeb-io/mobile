package expo.modules.beebeebcrypto

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import okhttp3.Call

/**
 * Kotlin port of iOS `PreviewDownloadProgress` (BeebeebCryptoModule.swift:218–380)
 * — task 1683b. One instance per in-flight `downloadAndDecryptFileNative`.
 *
 * Owns the throttled progress snapshots that JS polls via
 * `getPreviewLoadProgress(requestId)` (~every 200 ms) and the cancel flag +
 * OkHttp call handle used by `cancelDownloadAndDecryptFileNative(requestId)`.
 *
 * The high-frequency stages ("downloading" from the body pump, per-chunk
 * "decrypting") are throttled to ~1 event / 150 ms OR a whole-percent advance,
 * while ALWAYS emitting the first event of a stage, any stage transition, the
 * final tick of a throttled stage, and terminal stages ("complete"/"error") —
 * the exact gate iOS added when unthrottled emits flooded the RN bridge and
 * got the app memory-watchdog-killed (TestFlight #190; same bridge on both
 * platforms).
 */
internal class PreviewDownloadProgress(
  private val requestId: String?,
  private val fileId: String,
  private val emit: (Map<String, Any?>) -> Unit,
) {

  /**
   * Task 1683j — optional extra teardown when JS cancels. The streaming
   * session assigns itself here (`onCancelExtra = { session.cancelFromProgress() }`)
   * so `cancelDownloadAndDecryptFileNative` (the existing cancel surface) also
   * tears a video stream down; the plain download path leaves it null (its
   * OkHttp call attachment already covers it). Volatile: assigned by the IO
   * worker right after the session is built, read under `lock` by cancel().
   */
  @Volatile
  var onCancelExtra: (() -> Unit)? = null

  private val lock = ReentrantLock()
  private var cancelled = false
  private var call: Call? = null

  // Throttle state (guarded by `lock`).
  private var lastEmitStage: String = ""
  private var lastEmitPercent: Int = -1
  private var lastEmitAtMs: Long = Long.MIN_VALUE

  /** Decide (under `lock`) whether this progress event reaches the snapshot store. */
  private fun shouldEmit(stage: String, percent: Int, isFinal: Boolean): Boolean = lock.withLock {
    // First event of a stage / any stage transition: always emit, reset window.
    if (stage != lastEmitStage) {
      lastEmitStage = stage
      lastEmitPercent = percent
      lastEmitAtMs = nowMs()
      return@withLock true
    }

    // Non-throttled stages (complete/error and anything unexpected): never suppress.
    if (stage != STAGE_DOWNLOADING && stage != STAGE_DECRYPTING) return@withLock true

    // Always emit the final tick of a throttled stage so the banner reaches 100%
    // before it transitions (download-complete -> decrypting, decrypt-complete -> complete).
    if (isFinal) {
      lastEmitPercent = percent
      lastEmitAtMs = nowMs()
      return@withLock true
    }

    val elapsedOk = nowMs() - lastEmitAtMs >= EMIT_MIN_INTERVAL_MS
    val percentOk = percent >= lastEmitPercent + 1
    if (!elapsedOk && !percentOk) return@withLock false
    lastEmitPercent = percent
    lastEmitAtMs = nowMs()
    true
  }

  fun attachCall(call: Call) {
    lock.withLock { this.call = call }
  }

  fun cancel() {
    val toCancel = lock.withLock {
      cancelled = true
      call
    }
    toCancel?.cancel()
    onCancelExtra?.invoke()
  }

  fun isCancelled(): Boolean = lock.withLock { cancelled }

  fun onChunkDecrypted(chunkIndex: Int, totalChunks: Int) {
    emitProgress(
      stage = STAGE_DECRYPTING,
      chunksCompleted = chunkIndex,
      chunksTotal = totalChunks,
    )
  }

  fun onComplete() {
    emitProgress(stage = STAGE_COMPLETE)
  }

  fun onError(error: String) {
    emitProgress(stage = STAGE_ERROR, extra = mapOf("error" to error))
  }

  fun emitDownload(bytesWritten: Long, bytesExpected: Long) {
    emitProgress(
      stage = STAGE_DOWNLOADING,
      bytesDownloaded = maxOf(0L, bytesWritten),
      bytesTotal = if (bytesExpected > 0) bytesExpected else 0L,
    )
  }

  fun emitProgress(
    stage: String,
    bytesDownloaded: Long? = null,
    bytesTotal: Long? = null,
    chunksCompleted: Int? = null,
    chunksTotal: Int? = null,
    extra: Map<String, Any?> = emptyMap(),
  ) {
    // Integer percent + final-tick flag for the high-frequency stages so the
    // throttle gate can drop redundant events before they hit the snapshot store.
    var percent = 0
    var isFinal = false
    if (stage == STAGE_DOWNLOADING) {
      if (bytesTotal != null && bytesTotal > 0 && bytesDownloaded != null) {
        percent = (bytesDownloaded * 100 / bytesTotal).toInt()
        isFinal = bytesDownloaded >= bytesTotal
      }
    } else if (stage == STAGE_DECRYPTING) {
      if (chunksTotal != null && chunksTotal > 0 && chunksCompleted != null) {
        percent = chunksCompleted * 100 / chunksTotal
        isFinal = chunksCompleted >= chunksTotal
      }
    }

    if (!shouldEmit(stage = stage, percent = percent, isFinal = isFinal)) return

    val body = LinkedHashMap<String, Any?>()
    body["requestId"] = requestId ?: ""
    body["fileId"] = fileId
    body["stage"] = stage
    if (bytesDownloaded != null) body["bytesDownloaded"] = bytesDownloaded
    if (bytesTotal != null) body["bytesTotal"] = bytesTotal
    if (chunksCompleted != null) body["chunksCompleted"] = chunksCompleted
    if (chunksTotal != null) body["chunksTotal"] = chunksTotal
    body.putAll(extra)
    emit(body)
  }

  companion object {
    const val STAGE_DOWNLOADING = "downloading"
    const val STAGE_DECRYPTING = "decrypting"
    const val STAGE_COMPLETE = "complete"
    const val STAGE_ERROR = "error"
    const val EMIT_MIN_INTERVAL_MS = 150L

    private fun nowMs(): Long = System.currentTimeMillis()
  }
}
