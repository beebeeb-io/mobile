package expo.modules.beebeebcrypto

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.SecureRandom
import javax.crypto.Cipher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.beebeeb_uniffi.BatchNameItem
import uniffi.beebeeb_uniffi.EncryptedData
import uniffi.beebeeb_uniffi.MasterKeyHandle
import uniffi.beebeeb_uniffi.computeRecoveryCheck
import uniffi.beebeeb_uniffi.decryptChunk
import uniffi.beebeeb_uniffi.decryptMetadata
import uniffi.beebeeb_uniffi.deriveFileKey
import uniffi.beebeeb_uniffi.deriveShareKey
import uniffi.beebeeb_uniffi.deriveX25519Private
import uniffi.beebeeb_uniffi.deriveX25519Public
import uniffi.beebeeb_uniffi.encryptChunk
import uniffi.beebeeb_uniffi.encryptMetadata
import uniffi.beebeeb_uniffi.generateRecoveryPhrase
import uniffi.beebeeb_uniffi.opaqueLoginFinish
import uniffi.beebeeb_uniffi.opaqueLoginStart
import uniffi.beebeeb_uniffi.opaqueRegistrationFinish
import uniffi.beebeeb_uniffi.opaqueRegistrationStart
import uniffi.beebeeb_uniffi.recoverFromPhrase
import uniffi.beebeeb_uniffi.x25519SharedSecret
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.TimeUnit

// Stub helper — throws until a function is deliberately implemented. The
// return type is Any? so the AsyncFunction lambdas do not infer R = Nothing
// (invalid as a reified type parameter).
private fun notLinked(): Any? = throw NotLinkedException()

/**
 * M1 module surface (task 1683 follow-up). The generated `uniffi.beebeeb_uniffi`
 * bindings do the cryptography; this class maps the fixed JS contract onto
 * them (conversions here only) and provides the Android vault:
 * AndroidKeyStoreVault (K_root/K_biometric) + BeebeebCryptoHandleRegistry
 * (JS-facing ids over Rust MasterKeyHandle objects).
 *
 * Deliberately still stubbed (iOS-only surfaces, M4/M5): File Provider domain
 * family, pending shares. Everything else is real.
 */
class BeebeebCryptoModule : Module() {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val handles = BeebeebCryptoHandleRegistry()

  // ── preview download + decrypt state (task 1683b; iOS
  // `previewDownloadCancellations` / `previewProgressSnapshots`,
  // BeebeebCryptoModule.swift:1880–1883) ─────────────────────────────────────
  private val previewDownloadLock = Any()
  private val previewDownloadCancellations = HashMap<String, PreviewDownloadProgress>()
  private val previewProgressLock = Any()
  private val previewProgressSnapshots = HashMap<String, Map<String, Any?>>()

  // ── native manual upload progress state (task 1683c; iOS
  // `uploadProgressEntries` + lock, BeebeebCryptoModule.swift:1885–1886) ─────
  private val uploadProgressLock = Any()
  private val uploadProgressEntries = HashMap<String, NativeUploadProgress>()

  @Volatile
  private var vaultInstance: AndroidKeyStoreVault? = null

  private val reactContext: Context
    get() = appContext.reactContext
      ?: throw CodedException("NO_CONTEXT", "no react context available", null)

  private fun theVault(): AndroidKeyStoreVault {
    vaultInstance?.let { return it }
    val created = AndroidKeyStoreVault(reactContext)
    vaultInstance = created
    return created
  }

  // ------------------------------------------------------- policy storage

  private fun policyPrefs() =
    reactContext.getSharedPreferences("beebeeb.vault.policy", Context.MODE_PRIVATE)

  private fun requireBiometricEnabled(): Boolean =
    policyPrefs().getBoolean("requireBiometric", false)

  private fun setRequireBiometricEnabled(value: Boolean) {
    policyPrefs().edit().putBoolean("requireBiometric", value).apply()
  }

  private fun keyLabelStored(): String? = policyPrefs().getString("keyLabel", null)

  private fun setKeyLabelStored(label: String) {
    policyPrefs().edit().putString("keyLabel", label).apply()
  }

  // ------------------------------------------------------ vault plumbing

  /** Reads + unseals the label's blob; null when nothing is stored (no prompt). */
  private suspend fun unsealKeyBlob(label: String): ByteArray? {
    val vault = theVault()
    val blob = withContext(Dispatchers.IO) { vault.readKeyBlob(label) } ?: return null

    if (requireBiometricEnabled()) {
      val cipher = withContext(Dispatchers.IO) { vault.prepareBiometricCipher(Cipher.DECRYPT_MODE) }
      val authorized = promptForCipher(cipher, "Unlock Beebeeb")
      return withContext(Dispatchers.IO) {
        try {
          vault.unseal(authorized, blob)
        } catch (e: Exception) {
          throw VaultAuthException(VaultAuthCodes.AUTH_FAILED, "vault unseal failed: ${e.message}")
        }
      }
    }

    return withContext(Dispatchers.IO) {
      try {
        vault.unsealWithRoot(blob)
      } catch (e: Exception) {
        throw VaultAuthException(VaultAuthCodes.AUTH_FAILED, "vault unseal failed: ${e.message}")
      }
    }
  }

  /** Seals + persists the label's blob under the given policy. */
  private suspend fun sealKeyBytes(label: String, keyBytes: ByteArray, biometric: Boolean) {
    val vault = theVault()
    val blob = if (biometric) {
      // Per-use keys require an ENROLLED strong biometric; surface the same
      // retryable code JS already understands instead of ERR_UNEXPECTED.
      val canAuthenticate = androidx.biometric.BiometricManager.from(reactContext)
        .canAuthenticate(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG)
      if (canAuthenticate != androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS) {
        throw VaultAuthException(
          VaultAuthCodes.AUTH_NOT_AVAILABLE,
          "no enrolled strong biometric (canAuthenticate=$canAuthenticate)",
        )
      }
      val cipher = withContext(Dispatchers.IO) {
        vault.getOrCreateBiometricKey()
        try {
          vault.prepareBiometricCipher(Cipher.ENCRYPT_MODE)
        } catch (e: VaultKeyInvalidatedException) {
          // enrollment changed under a live policy — provision a fresh key once
          vault.destroyBiometricKey()
          vault.getOrCreateBiometricKey()
          vault.prepareBiometricCipher(Cipher.ENCRYPT_MODE)
        }
      }
      val authorized = promptForCipher(cipher, "Secure your vault")
      withContext(Dispatchers.IO) { vault.seal(authorized, keyBytes) }
    } else {
      withContext(Dispatchers.IO) { vault.sealWithRoot(keyBytes) }
    }
    withContext(Dispatchers.IO) { vault.writeKeyBlob(label, blob) }
    setKeyLabelStored(label)
  }

  private suspend fun promptForCipher(cipher: Cipher, title: String): Cipher {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: throw VaultAuthException(
        VaultAuthCodes.AUTH_NOT_AVAILABLE,
        "no foreground activity for biometric prompt",
      )
    val outcome = withContext(Dispatchers.Main.immediate) {
      BiometricUnlock.authenticate(activity, cipher, title)
    }
    return when (outcome) {
      is BiometricOutcome.Success -> outcome.cipher
      is BiometricOutcome.Error -> throw VaultAuthException(outcome.code, outcome.detail)
    }
  }

  // ------------------------------------------------------------ helpers

  private fun encryptDataToMap(data: EncryptedData): Map<String, Any?> = mapOf(
    "cipherSuite" to data.cipherSuite,
    "nonce" to data.nonce,
    "ciphertext" to data.ciphertext,
  )

  /** Expo's Promise.reject takes a CodedException; pass ours through, wrap the rest. */
  private fun rejectUnexpected(promise: Promise, throwable: Throwable) {
    when (throwable) {
      is CodedException -> promise.reject(throwable)
      else -> promise.reject(
        CodedException(
          "ERR_UNEXPECTED",
          throwable.message ?: throwable.javaClass.simpleName,
          throwable,
        ),
      )
    }
  }

  private fun fileIdBytes(fileId: String): ByteArray = fileId.toByteArray(Charsets.UTF_8)

  private fun b64Encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

  private fun b64Decode(value: String, field: String): ByteArray = try {
    Base64.decode(value, Base64.NO_WRAP)
  } catch (e: IllegalArgumentException) {
    throw CodedException("INVALID_BASE64", "$field is not valid base64", e)
  }

  /** 0 = legacy Identity KSF, 1 = Argon2id; anything else defaults to 1 (api.ts rule). */
  private fun coerceKsfVersion(value: Int): UInt = when (value) {
    0 -> 0u
    1 -> 1u
    else -> 1u
  }

  // ───────────────────── preview download + decrypt (task 1683b) ─────────────
  //
  // Kotlin port of iOS `downloadAndDecryptFileNative`
  // (BeebeebCryptoModule.swift:3992+). Streams the HTTP download incrementally
  // to a temp encrypted file (never a full-memory buffer — the JS fallback's
  // `arrayBuffer()` + expo/fetch ResponseSink peak was the 1683 OOM class),
  // then decrypts chunk-wise from disk: a RandomAccessFile window of
  // `nonce(12) || ct(pt+16)` (≤ chunkSize+28) per chunk → the existing UniFFI
  // chunk decrypt → plaintext appended to the output stream. Peak memory is a
  // few MB regardless of file size. JS receives only the output URI.
  //
  // Wire contract mirrors the JS loop (`src/lib/native-decrypt.ts:545–556`):
  // `X-Chunk-Count` / `X-Chunk-Size` / `X-Original-Size` decide the framing,
  // exactly like iOS (BeebeebCryptoModule.swift:4054–4070).

  private fun storePreviewProgress(requestId: String, body: Map<String, Any?>) {
    if (requestId.isEmpty()) return
    synchronized(previewProgressLock) { previewProgressSnapshots[requestId] = body }
  }

  private fun readPreviewProgress(requestId: String?): Map<String, Any?>? {
    if (requestId.isNullOrEmpty()) return null
    return synchronized(previewProgressLock) { previewProgressSnapshots[requestId] }
  }

  private fun clearPreviewProgress(requestId: String) {
    if (requestId.isEmpty()) return
    synchronized(previewProgressLock) { previewProgressSnapshots.remove(requestId) }
  }

  private fun storePreviewDownloadCancellation(
    progress: PreviewDownloadProgress,
    requestId: String?,
  ) {
    if (requestId.isNullOrEmpty()) return
    synchronized(previewDownloadLock) { previewDownloadCancellations[requestId] = progress }
  }

  private fun removePreviewDownloadCancellation(requestId: String?) {
    if (requestId.isNullOrEmpty()) return
    synchronized(previewDownloadLock) { previewDownloadCancellations.remove(requestId) }
  }

  private fun cancelPreviewDownload(requestId: String): Boolean {
    val cancellation = synchronized(previewDownloadLock) {
      previewDownloadCancellations[requestId]
    }
    cancellation?.cancel()
    return cancellation != null
  }

  // ───────────────────── native upload progress helpers (task 1683c) ────────
  // Mirrors iOS storeUploadProgress/readUploadProgress/removeUploadProgress/
  // cancelUpload (BeebeebCryptoModule.swift:1948–1974).

  private fun storeUploadProgress(progress: NativeUploadProgress) {
    synchronized(uploadProgressLock) { uploadProgressEntries[progress.requestId] = progress }
  }

  private fun readUploadProgress(requestId: String?): Map<String, Any?>? {
    if (requestId.isNullOrEmpty()) return null
    return synchronized(uploadProgressLock) { uploadProgressEntries[requestId] }?.currentSnapshot()
  }

  private fun removeUploadProgress(requestId: String) {
    synchronized(uploadProgressLock) { uploadProgressEntries.remove(requestId) }
  }

  private fun cancelUpload(requestId: String): Boolean {
    val entry = synchronized(uploadProgressLock) { uploadProgressEntries[requestId] }
    entry?.cancel()
    return entry != null
  }

  /**
   * Task 1683h — native key resolution. A null/absent `handleId` means the
   * module resolves the master key ITSELF: take the adopted handle when one
   * is loaded, otherwise await the registry's key-loaded latch (completed by
   * the keychain auto-unlock's `loadKeyFromKeychainAsHandle` store). A
   * genuinely locked vault surfaces the specific ERR_VAULT_LOCKED error —
   * no JS timer, no hang, never the memory-bomb fallback.
   */
  private suspend fun resolveMasterKey(handleId: Int?): uniffi.beebeeb_uniffi.MasterKeyHandle =
    if (handleId != null) handles.get(handleId) else handles.awaitKey()

  /**
   * JS `uploadChunksNative` params → the engine's request. Numbers arrive as
   * `Double` (JSI), so coerce like iOS's `number(_:)` helper
   * (BeebeebCryptoModule.swift:4134). Any missing required key throws the
   * same message iOS throws.
   */
  private fun parseUploadRequest(params: Map<String, Any?>): NativeManualUploader.Request {
    val missing = CodedException(
      "ERR_UPLOAD_PARAMS",
      "Missing required parameters for uploadChunksNative",
      null,
    )
    fun number(key: String): Double? = (params[key] as? Number)?.toDouble()
    fun requiredString(key: String): String = params[key] as? String ?: throw missing
    val handleId = number("handleId")?.toInt() ?: throw missing
    val chunkSizeBytes = number("chunkSizeBytes") ?: throw missing
    val chunkCount = number("chunkCount") ?: throw missing
    val startChunkIndex = (number("startChunkIndex") ?: 0.0).coerceAtLeast(0.0)
    return NativeManualUploader.Request(
      masterKey = handles.get(handleId),
      fileId = requiredString("fileId"),
      inputPath = filePathFromUri(requiredString("inputUri")),
      apiUrl = requiredString("apiUrl"),
      token = requiredString("token"),
      uploadSessionId = requiredString("uploadSessionId"),
      chunkSizeBytes = chunkSizeBytes.toLong().toULong(),
      chunkCount = chunkCount.toLong().toULong(),
      startChunkIndex = startChunkIndex.toLong().toUInt(),
      clientVersion = clientVersion(),
    )
  }

  /** `file://…` URI → filesystem path (iOS `fileURL(fromURI:)` equivalent). */
  private fun filePathFromUri(uri: String): String =
    try {
      android.net.Uri.parse(uri).path ?: uri.removePrefix("file://")
    } catch (_: Exception) {
      uri.removePrefix("file://")
    }

  /**
   * The `X-Beebeeb-Client-Version` value — matches `mobileClientHeaders()`
   * (`src/lib/api.ts:501–503`): the app's versionName (expoConfig version).
   */
  @Suppress("DEPRECATION")
  private fun clientVersion(): String = try {
    reactContext.packageManager
      .getPackageInfo(reactContext.packageName, 0)
      .versionName ?: "1.0.0"
  } catch (_: Exception) {
    "1.0.0"
  }

  /**
   * Stream `GET {apiUrl}/api/v1/files/{fileId}/download` to a temp encrypted
   * file, then chunk-decrypt it to `outputPath`. Runs on Dispatchers.IO.
   * Blocking; all cancellation/progress flows through `progress`.
   */
  private fun downloadAndDecryptPreview(
    master: uniffi.beebeeb_uniffi.MasterKeyHandle,
    apiUrl: String,
    token: String,
    fileId: String,
    outputUri: String,
    requestId: String?,
  ): Map<String, Any?> {
    val outputPath = filePathFromUri(outputUri)
    val outputFile = File(outputPath)
    val outputParent = outputFile.parentFile
      ?: throw CodedException("ERR_OUTPUT_PATH", "output path has no parent directory", null)
    if (!outputParent.exists()) outputParent.mkdirs()

    val progress = PreviewDownloadProgress(requestId, fileId) { body ->
      storePreviewProgress(requestId ?: "", body)
    }
    storePreviewDownloadCancellation(progress, requestId)
    try {
      val tempDir = File(reactContext.cacheDir, "beebeeb-preview-$fileId-${UUID.randomUUID()}")
      try {
        tempDir.mkdirs()
        val encFile = streamEncryptedDownload(progress, apiUrl, token, fileId, tempDir)
        return decryptPreviewChunks(progress, master, fileId, encFile, outputFile)
      } catch (t: Throwable) {
        // Task 1593 parity — never leave a partial plaintext behind (JS deletes
        // outputPath on native errors too; the .tmp sibling is swept here).
        try { File("$outputPath.tmp").delete() } catch (_: Exception) {}
        try { outputFile.delete() } catch (_: Exception) {}
        progress.onError(t.message ?: t.javaClass.simpleName)
        throw t
      } finally {
        try { tempDir.deleteRecursively() } catch (_: Exception) {}
      }
    } finally {
      removePreviewDownloadCancellation(requestId)
      clearPreviewProgress(requestId ?: "")
    }
  }

  /**
   * Stream the download body to `tempDir/encrypted.bin` incrementally. Never
   * holds more than one buffer of body bytes in memory. Returns the temp file
   * plus the framing resolved from its headers.
   */
  private fun streamEncryptedDownload(
    progress: PreviewDownloadProgress,
    apiUrl: String,
    token: String,
    fileId: String,
    tempDir: File,
  ): DownloadedEncryptedFile {
    progress.emitProgress(stage = PreviewDownloadProgress.STAGE_DOWNLOADING, bytesDownloaded = 0, bytesTotal = 0)

    // Pin the header values BEFORE streaming (OkHttp headers are only valid
    // until the body is consumed).
    val url = "${apiUrl.trimEnd('/')}/api/v1/files/$fileId/download"
    val request = Request.Builder()
      .url(url)
      .header("Authorization", "Bearer $token")
      .header("X-Beebeeb-Client", "mobile-android")
      .header("X-Beebeeb-Client-Version", clientVersion())
      .build()
    val client = OkHttpClient.Builder()
      .connectTimeout(30, TimeUnit.SECONDS)
      // Core's own download client allows a 600 s total timeout; a slow body
      // must not be cut off at OkHttp's 10 s default read timeout.
      .readTimeout(600, TimeUnit.SECONDS)
      .build()

    val call = client.newCall(request)
    progress.attachCall(call)
    val response = call.execute()
    response.use { resp ->
      if (!resp.isSuccessful) {
        throw CodedException(
          "ERR_DOWNLOAD_HTTP",
          "Download failed with HTTP ${resp.code}",
          null,
        )
      }
      val contentLength = resp.header("Content-Length")?.toLongOrNull() ?: 0L
      val headerChunkCount = resp.header("X-Chunk-Count")?.toLongOrNull()
      val headerOriginalSize = resp.header("X-Original-Size")?.toLongOrNull()
      val headerChunkSize = resp.header("X-Chunk-Size")?.toLongOrNull()?.takeIf { it > 0 }

      val body = resp.body ?: throw CodedException("ERR_DOWNLOAD_BODY", "Download response has no body", null)
      val encFile = File(tempDir, "encrypted.bin")
      var written = 0L
      FileOutputStream(encFile).use { out ->
        val buf = ByteArray(DOWNLOAD_BUFFER_SIZE)
        val source = body.byteStream()
        while (true) {
          if (progress.isCancelled()) {
            throw CodedException("ERR_CANCELLED", "Preview download cancelled", null)
          }
          val n = source.read(buf)
          if (n < 0) break
          if (n > 0) {
            out.write(buf, 0, n)
            written += n
            progress.emitDownload(written, contentLength)
          }
        }
        out.flush()
      }

      val encryptedSize = encFile.length()
      // Chunk framing resolved EXACTLY like the JS loop
      // (native-decrypt.ts:545–556) and iOS (BeebeebCryptoModule.swift:4054–4070):
      // header values when present; legacy fallbacks otherwise.
      val chunkCount = (headerChunkCount ?: 1L).toInt()
      if (chunkCount <= 0) {
        throw CodedException("ERR_CHUNK_COUNT", "Invalid chunk count", null)
      }
      val originalSize = headerOriginalSize ?: maxOf(0L, encryptedSize - CHUNK_OVERHEAD_BYTES)
      if (originalSize <= 0L) {
        throw CodedException("ERR_CHUNK_METADATA", "Invalid download size metadata", null)
      }
      val plaintextChunkSize = if (chunkCount <= 1) {
        originalSize
      } else {
        headerChunkSize ?: DEFAULT_CHUNK_SIZE_BYTES
      }
      if (plaintextChunkSize <= 0L) {
        throw CodedException("ERR_CHUNK_METADATA", "Invalid chunk size metadata", null)
      }

      progress.emitProgress(
        stage = PreviewDownloadProgress.STAGE_DOWNLOADING,
        bytesDownloaded = written,
        bytesTotal = if (contentLength > 0) contentLength else written,
      )
      return DownloadedEncryptedFile(
        file = encFile,
        encryptedSize = encryptedSize,
        chunkCount = chunkCount,
        originalSize = originalSize,
        plaintextChunkSize = plaintextChunkSize,
      )
    }
  }

  /**
   * Chunk-wise decrypt from disk: a RandomAccessFile window of
   * `nonce(12) || ct(plaintextSize+16)` per chunk (≤ chunkSize+28 bytes) →
   * UniFFI chunk decrypt via the derived FileKeyHandle (key material stays in
   * Rust) → plaintext appended to the output stream. Writes to a `.tmp`
   * sibling and renames on success so a partial file can never be served from
   * the preview cache (Rust `decrypt_chunks_to_file` semantics).
   */
  private fun decryptPreviewChunks(    progress: PreviewDownloadProgress,
    master: uniffi.beebeeb_uniffi.MasterKeyHandle,
    fileId: String,
    downloaded: DownloadedEncryptedFile,
    outputFile: File,
  ): Map<String, Any?> {
    val encFile = downloaded.file
    val meta = downloaded
    val tmpFile = File("${outputFile.absolutePath}.tmp")
    try {
      tmpFile.delete()
    } catch (_: Exception) {}
    progress.emitProgress(
      stage = PreviewDownloadProgress.STAGE_DECRYPTING,
      chunksCompleted = 0,
      chunksTotal = meta.chunkCount,
    )

    val fileKey = master.deriveFileKey(fileIdBytes(fileId))
    try {
      RandomAccessFile(encFile, "r").use { raf ->
        FileOutputStream(tmpFile).use { out ->
          var chunkStart = 0L
          for (index in 0 until meta.chunkCount) {
            if (progress.isCancelled()) {
              throw CodedException("ERR_CANCELLED", "Preview decrypt cancelled", null)
            }
            val isLast = index == meta.chunkCount - 1
            val plaintextSize = if (meta.chunkCount == 1) {
              meta.originalSize
            } else if (isLast) {
              meta.originalSize - meta.plaintextChunkSize * (meta.chunkCount - 1)
            } else {
              meta.plaintextChunkSize
            }
            if (plaintextSize <= 0L) {
              throw CodedException("ERR_CHUNK_SIZE", "Invalid chunk size", null)
            }
            val windowSize = CHUNK_OVERHEAD_BYTES + plaintextSize
            if (chunkStart + windowSize > meta.encryptedSize) {
              throw CodedException(
                "ERR_TRUNCATED",
                "Encrypted payload ended before chunk $index",
                null,
              )
            }
            val window = ByteArray(windowSize.toInt())
            raf.seek(chunkStart)
            raf.readFully(window)
            val nonce = window.copyOfRange(0, NONCE_BYTES)
            val ciphertext = window.copyOfRange(NONCE_BYTES, window.size)
            val plaintext = fileKey.decryptChunk(nonce, ciphertext)
            out.write(plaintext)
            chunkStart += windowSize
            progress.onChunkDecrypted(index + 1, meta.chunkCount)
          }
          if (chunkStart != meta.encryptedSize) {
            throw CodedException("ERR_TRAILING", "Encrypted payload has trailing bytes", null)
          }
          out.flush()
        }
      }
      if (!tmpFile.renameTo(outputFile)) {
        throw CodedException("ERR_RENAME", "Could not finalize decrypted output", null)
      }
    } finally {
      fileKey.close()
    }

    progress.onComplete()
    return mapOf(
      "outputPath" to outputFile.absolutePath,
      "outputUri" to android.net.Uri.fromFile(outputFile).toString(),
      "plaintextSize" to outputFile.length(),
      "chunksDecrypted" to meta.chunkCount,
    )
  }

  /** The downloaded encrypted body + the framing resolved from its headers. */
  private class DownloadedEncryptedFile(
    val file: File,
    val encryptedSize: Long,
    val chunkCount: Int,
    val originalSize: Long,
    val plaintextChunkSize: Long,
  )

  // ───────────────────── native offline decrypt (task 1683d) ────────────────
  //
  // The offline open path (`decryptLocalFileLeased`, src/lib/native-decrypt.ts
  // :787–871) read the whole local ciphertext as base64 into the JS heap and
  // wrote the plaintext back as base64 — the 1683 OOM class at offline sizes
  // (>100 MB). This port streams the LOCAL encrypted file from disk with the
  // 1683b chunk-window loop (RandomAccessFile window → UniFFI decryptChunk →
  // plaintext stream → .tmp rename); peak memory is one window regardless of
  // file size, and plaintext never enters the JS heap.
  //
  // Framing parity: JS resolves `originalSize` / `chunkCount` / `chunkSize`
  // with the SAME math it uses for the fallback loop (manifest meta captured
  // from the download headers, then the size-based inference) and passes the
  // resolved values in — native only validates the window math (the same
  // ERR_TRUNCATED/ERR_TRAILING guards as the preview loop). Progress + cancel
  // reuse the 1683b preview surface (getPreviewLoadProgress /
  // cancelDownloadAndDecryptFileNative) so no new JS plumbing is needed.

  private fun decryptLocalFileChunks(
    progress: PreviewDownloadProgress,
    fileKey: ByteArray,
    inputPath: String,
    outputFile: File,
    chunkSizeBytes: Long,
    chunkCount: Int,
    originalSize: Long,
  ): Map<String, Any?> {
    val encFile = File(inputPath)
    if (!encFile.exists()) {
      throw CodedException("ERR_OFFLINE_MISSING", "Offline copy is missing", null)
    }
    if (chunkCount <= 0 || chunkSizeBytes <= 0L || originalSize <= 0L) {
      throw CodedException("ERR_CHUNK_METADATA", "Invalid offline decrypt metadata", null)
    }
    val encSize = encFile.length()
    val tmpFile = File("${outputFile.absolutePath}.tmp")
    try {
      tmpFile.delete()
    } catch (_: Exception) {}
    progress.emitProgress(
      stage = PreviewDownloadProgress.STAGE_DECRYPTING,
      chunksCompleted = 0,
      chunksTotal = chunkCount,
    )

    try {
      RandomAccessFile(encFile, "r").use { raf ->
        FileOutputStream(tmpFile).use { out ->
          var chunkStart = 0L
          for (index in 0 until chunkCount) {
            if (progress.isCancelled()) {
              throw CodedException("ERR_CANCELLED", "Offline decrypt cancelled", null)
            }
            val isLast = index == chunkCount - 1
            val plaintextSize = if (chunkCount == 1) {
              originalSize
            } else if (isLast) {
              originalSize - chunkSizeBytes * (chunkCount - 1)
            } else {
              chunkSizeBytes
            }
            if (plaintextSize <= 0L) {
              throw CodedException("ERR_CHUNK_SIZE", "Invalid chunk size", null)
            }
            val windowSize = CHUNK_OVERHEAD_BYTES + plaintextSize
            if (chunkStart + windowSize > encSize) {
              throw CodedException(
                "ERR_TRUNCATED",
                "Encrypted payload ended before chunk $index",
                null,
              )
            }
            val window = ByteArray(windowSize.toInt())
            raf.seek(chunkStart)
            raf.readFully(window)
            val nonce = window.copyOfRange(0, NONCE_BYTES)
            val ciphertext = window.copyOfRange(NONCE_BYTES, window.size)
            val plaintext = decryptChunk(fileKey, nonce, ciphertext)
            out.write(plaintext)
            chunkStart += windowSize
            progress.onChunkDecrypted(index + 1, chunkCount)
          }
          if (chunkStart != encSize) {
            throw CodedException("ERR_TRAILING", "Encrypted payload has trailing bytes", null)
          }
          out.flush()
        }
      }
      if (!tmpFile.renameTo(outputFile)) {
        throw CodedException("ERR_RENAME", "Could not finalize decrypted output", null)
      }
    } catch (t: Throwable) {
      try { tmpFile.delete() } catch (_: Exception) {}
      throw t
    }

    progress.onComplete()
    return mapOf(
      "outputPath" to outputFile.absolutePath,
      "outputUri" to android.net.Uri.fromFile(outputFile).toString(),
      "plaintextSize" to outputFile.length(),
      "chunksDecrypted" to chunkCount,
    )
  }

  companion object {
    /** logcat tag for the native upload engine's trace lines (task 1683c). */
    private const val UPLOAD_LOG_TAG = "BeebeebUpload"
    /** nonce(12) + GCM tag(16) per chunk on the wire. */
    private const val NONCE_BYTES = 12
    private const val CHUNK_OVERHEAD_BYTES = 28L
    /** Legacy fallback chunk size when the server sends no X-Chunk-Size. */
    private const val DEFAULT_CHUNK_SIZE_BYTES = 4L * 1024 * 1024
    private const val DOWNLOAD_BUFFER_SIZE = 256 * 1024
  }


  override fun definition() = ModuleDefinition {
    Name("BeebeebCrypto")

    // ─────────────────────────────── misc / pure-Kotlin ──────────────────────

    AsyncFunction("generateRandomBytes") { length: Int ->
      if (length <= 0 || length > 4096) {
        throw CodedException("INVALID_LENGTH", "Invalid random byte length", null)
      }
      ByteArray(length).also { SecureRandom().nextBytes(it) }
    }

    // ─────────────────────────────── recovery / x25519 / share ───────────────

    AsyncFunction("generateRecoveryPhrase") { ->
      val result = generateRecoveryPhrase()
      mapOf("phrase" to result.phrase, "masterKey" to result.masterKey)
    }

    AsyncFunction("recoverFromPhrase") { phrase: String ->
      mapOf("masterKey" to recoverFromPhrase(phrase))
    }

    AsyncFunction("computeRecoveryCheck") { masterKey: ByteArray ->
      computeRecoveryCheck(masterKey)
    }

    AsyncFunction("deriveX25519Private") { masterKey: ByteArray ->
      deriveX25519Private(masterKey)
    }

    AsyncFunction("deriveX25519Public") { privateKey: ByteArray ->
      deriveX25519Public(privateKey)
    }

    AsyncFunction("x25519SharedSecret") { myPrivate: ByteArray, theirPublic: ByteArray ->
      x25519SharedSecret(myPrivate, theirPublic)
    }

    AsyncFunction("deriveShareKey") { sharedSecret: ByteArray, fileId: ByteArray ->
      deriveShareKey(sharedSecret, fileId)
    }

    // ─────────────────────────────── chunk / metadata AEAD ───────────────────

    AsyncFunction("encryptChunk") { key: ByteArray, plaintext: ByteArray ->
      encryptDataToMap(encryptChunk(key, plaintext))
    }

    AsyncFunction("decryptChunk") { key: ByteArray, nonce: ByteArray, ciphertext: ByteArray ->
      decryptChunk(key, nonce, ciphertext)
    }

    AsyncFunction("encryptMetadata") { key: ByteArray, metadata: String ->
      encryptDataToMap(encryptMetadata(key, metadata))
    }

    AsyncFunction("decryptMetadata") { key: ByteArray, nonce: ByteArray, ciphertext: ByteArray ->
      decryptMetadata(key, nonce, ciphertext)
    }

    AsyncFunction("deriveFileKey") { masterKey: ByteArray, fileId: String ->
      deriveFileKey(masterKey, fileIdBytes(fileId))
    }

    // ─────────────────────────────── master-key handles ──────────────────────

    AsyncFunction("createMasterKeyHandle") { masterKey: ByteArray, promise: Promise ->
      scope.launch {
        try {
          val handle = MasterKeyHandle.fromKeychainBytes(masterKey)
          promise.resolve(handles.store(handle))
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        } finally {
          masterKey.fill(0.toByte())
        }
      }
    }

    AsyncFunction("confirmMasterKeyHandle") { handleId: Int, ownerId: String? ->
      handles.adopt(handleId, ownerId)
    }

    AsyncFunction("releaseHandle") { handleId: Int ->
      handles.release(handleId)
    }

    AsyncFunction("handleComputeRecoveryCheck") { handleId: Int ->
      handles.get(handleId).computeRecoveryCheck()
    }

    AsyncFunction("handleDeriveX25519Private") { handleId: Int ->
      handles.get(handleId).deriveX25519Private()
    }

    AsyncFunction("handleDeriveFileKey") { handleId: Int, fileId: String ->
      val masterKeyBytes = handles.get(handleId).exportForKeychain()
      try {
        deriveFileKey(masterKeyBytes, fileIdBytes(fileId))
      } finally {
        masterKeyBytes.fill(0.toByte())
      }
    }

    AsyncFunction("handleEncryptChunk") { handleId: Int, fileId: String, plaintext: ByteArray ->
      val fileKey = handles.get(handleId).deriveFileKey(fileIdBytes(fileId))
      encryptDataToMap(fileKey.encryptChunk(plaintext))
    }

    AsyncFunction("handleDecryptChunk") { handleId: Int, fileId: String, nonce: ByteArray, ciphertext: ByteArray ->
      handles.get(handleId).deriveFileKey(fileIdBytes(fileId)).decryptChunk(nonce, ciphertext)
    }

    AsyncFunction("handleEncryptMetadata") { handleId: Int, fileId: String, metadata: String ->
      val fileKey = handles.get(handleId).deriveFileKey(fileIdBytes(fileId))
      encryptDataToMap(fileKey.encryptMetadata(metadata))
    }

    AsyncFunction("handleDecryptMetadata") { handleId: Int, fileId: String, nonce: ByteArray, ciphertext: ByteArray ->
      handles.get(handleId).deriveFileKey(fileIdBytes(fileId)).decryptMetadata(nonce, ciphertext)
    }

    AsyncFunction("decryptNames") { handleId: Int, items: List<Map<String, Any?>> ->
      val batch = items.map { item ->
        BatchNameItem(
          fileId = item["fileId"] as? String ?: "",
          nameEncrypted = item["nameEncrypted"] as? String ?: "",
        )
      }
      handles.get(handleId).decryptNames(batch).map { result ->
        mapOf(
          "name" to result.name,
          "mimeType" to result.mimeType,
          "error" to result.error,
        )
      }
    }

    AsyncFunction("wrapForOwnerWithHandle") { handleId: Int, bytes: ByteArray ->
      val masterKeyBytes = handles.get(handleId).exportForKeychain()
      try {
        val result = encryptChunk(masterKeyBytes, bytes)
        mapOf("wrapped" to result.ciphertext, "nonce" to result.nonce)
      } finally {
        masterKeyBytes.fill(0.toByte())
      }
    }

    AsyncFunction("unwrapForOwnerWithHandle") { handleId: Int, wrapped: ByteArray, nonce: ByteArray ->
      val masterKeyBytes = handles.get(handleId).exportForKeychain()
      try {
        decryptChunk(masterKeyBytes, nonce, wrapped)
      } finally {
        masterKeyBytes.fill(0.toByte())
      }
    }

    // ─────────────────────────────── keychain / vault ────────────────────────

    AsyncFunction("storeKeyInKeychain") { key: ByteArray, label: String, promise: Promise ->
      scope.launch {
        try {
          if (key.size != 32) {
            throw CodedException(
              "INVALID_MASTER_KEY_SIZE",
              "master key must be 32 bytes (got ${key.size})",
              null,
            )
          }
          sealKeyBytes(label, key, requireBiometricEnabled())
          promise.resolve(null)
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    AsyncFunction("loadKeyFromKeychain") { label: String, promise: Promise ->
      scope.launch {
        try {
          promise.resolve(unsealKeyBlob(label))
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    AsyncFunction("loadKeyFromKeychainAsHandle") { label: String, promise: Promise ->
      scope.launch {
        try {
          val bytes = unsealKeyBlob(label)
          if (bytes == null) {
            promise.resolve(null)
            return@launch
          }
          try {
            val handle = MasterKeyHandle.fromKeychainBytes(bytes)
            promise.resolve(handles.store(handle))
          } finally {
            bytes.fill(0.toByte())
          }
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    AsyncFunction("deleteKeyFromKeychain") { ->
      val vault = theVault()
      vault.destroyRootKey()
      vault.destroyBiometricKey()
      vault.deleteAllKeyBlobs()
      handles.clear()
      policyPrefs().edit().remove("keyLabel").apply()
      true
    }

    AsyncFunction("setRequireBiometric") { require: Boolean, promise: Promise ->
      scope.launch {
        try {
          if (require == requireBiometricEnabled()) {
            promise.resolve(true)
            return@launch
          }
          val label = keyLabelStored()
          if (label == null) {
            setRequireBiometricEnabled(require)
            promise.resolve(true)
            return@launch
          }
          // unseal under the OLD policy (may prompt), then re-seal under the new one
          val existing = unsealKeyBlob(label)
          if (existing == null) {
            setRequireBiometricEnabled(require)
            promise.resolve(true)
            return@launch
          }
          try {
            sealKeyBytes(label, existing, require)
            setRequireBiometricEnabled(require)
            promise.resolve(true)
          } finally {
            existing.fill(0.toByte())
          }
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    // ─────────────────────────────── OPAQUE ──────────────────────────────────

    AsyncFunction("opaqueRegistrationStart") { _: String, password: String ->
      val result = opaqueRegistrationStart(password.toByteArray(Charsets.UTF_8))
      mapOf("state" to b64Encode(result.state), "message" to b64Encode(result.message))
    }

    AsyncFunction("opaqueRegistrationFinish") { state: String, serverMessage: String, password: String ->
      val record = opaqueRegistrationFinish(
        b64Decode(state, "state"),
        password.toByteArray(Charsets.UTF_8),
        b64Decode(serverMessage, "serverMessage"),
      )
      mapOf("record" to b64Encode(record))
    }

    AsyncFunction("opaqueLoginStart") { _: String, password: String ->
      val result = opaqueLoginStart(password.toByteArray(Charsets.UTF_8))
      mapOf("state" to b64Encode(result.state), "message" to b64Encode(result.message))
    }

    AsyncFunction("opaqueLoginFinish") { state: String, serverMessage: String, password: String, ksfVersion: Int ->
      val result = opaqueLoginFinish(
        b64Decode(state, "state"),
        password.toByteArray(Charsets.UTF_8),
        b64Decode(serverMessage, "serverMessage"),
        coerceKsfVersion(ksfVersion),
      )
      mapOf(
        "message" to b64Encode(result.message),
        "sessionKey" to b64Encode(result.sessionKey),
        "exportKey" to b64Encode(result.exportKey),
      )
    }

    // ─────────────────── preview download + decrypt (task 1683b) ─────────────
    //
    // Contract-identical to iOS (BeebeebCryptoModule.swift:3992–4116). JS owns
    // the request lifecycle (`downloadAndDecryptFileNative` in
    // modules/beebeeb-crypto/src/BeebeebCrypto.ts:1119) and polls
    // `getPreviewLoadProgress(requestId)` every 200 ms; native streams the
    // download and decrypts chunk-wise from disk so plaintext/encrypted bytes
    // never enter the JS heap (the 1683 OOM class).

    // handleId is nullable (task 1683h): null → the module resolves the key
    // itself from its loaded-key registry (awaiting the key-loaded latch —
    // the relaunch-tap race is solved NATIVELY, not with a JS timer).
    AsyncFunction("downloadAndDecryptFileNative") { handleId: Int?, apiUrl: String, token: String, fileId: String, outputUri: String, requestId: String?, promise: Promise ->
      scope.launch {
        try {
          val result = withContext(Dispatchers.IO) {
            val master = resolveMasterKey(handleId)
            downloadAndDecryptPreview(master, apiUrl, token, fileId, outputUri, requestId)
          }
          promise.resolve(result)
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    AsyncFunction("cancelDownloadAndDecryptFileNative") { requestId: String ->
      cancelPreviewDownload(requestId)
    }

    // ─────────────── chunked streaming video playback (task 1683j) ───────────
    //
    // Guus (2026-10-03): "Can't we download chunks and decrypt the chunks
    // directly? A streaming effect where the user doesn't download the whole
    // 600 MB, decrypt 600 MB, then play." The whole-file path above must
    // finish the ENTIRE download + decrypt before the player can start; the
    // server's per-chunk endpoint (`GET /api/v1/files/{id}/chunks/{i}`,
    // beebeeb-api routes/files.rs chunk_router) lets native fetch + decrypt
    // chunk-by-chunk while ExoPlayer reads the decrypted output progressively.
    //
    // VideoStreamer.start: fetch chunk 0 (+ the response's X-Chunk-Count) to
    // resolve the framing, decrypt ahead (tail-first — the MP4 moov lives at
    // the END) into a sparse plaintext temp file, and serve that file to
    // expo-video over a loopback-only HTTP server with proper 206/Range
    // semantics; a range beyond the decrypted frontier BLOCKS while the
    // needed chunks fetch + decrypt on demand (single-flight per chunk).
    // Promise resolves once the head is playable (chunk 0 + the LAST chunk
    // decrypted) with the loopback streamUri + the output path; the pump
    // keeps filling in the background and the final plaintext lands at
    // outputUri (the preview-cache copy) on completion.
    //
    // Progress + cancel ride the SAME surfaces as the whole-file path:
    // `getPreviewLoadProgress(requestId)` snapshots (`decrypting` events carry
    // `streaming: true` — the UI maps them to "Streaming · N% buffered") and
    // `cancelDownloadAndDecryptFileNative(requestId)` (the session hooks
    // PreviewDownloadProgress.onCancelExtra). Params map like
    // decryptLocalFileNative — proven conversion surface for optional
    // numbers (handleId nullable per 1683h).
    AsyncFunction("streamVideoNative") { params: Map<String, Any?>, promise: Promise ->
      scope.launch {
        val requestId = params["requestId"] as? String
        try {
          val result = withContext(Dispatchers.IO) {
            val master = resolveMasterKey((params["handleId"] as? Number)?.toInt())
            val progress = PreviewDownloadProgress(requestId, params["fileId"] as? String ?: "") { body ->
              storePreviewProgress(requestId ?: "", body)
            }
            if (!requestId.isNullOrEmpty()) {
              storePreviewDownloadCancellation(progress, requestId)
            }
            try {
              val started = VideoStreamer.start(
                requestId = requestId,
                master = master,
                apiUrl = params["apiUrl"] as? String
                  ?: throw CodedException("ERR_PARAMS", "streamVideoNative requires apiUrl", null),
                token = params["token"] as? String
                  ?: throw CodedException("ERR_PARAMS", "streamVideoNative requires token", null),
                fileId = params["fileId"] as? String
                  ?: throw CodedException("ERR_PARAMS", "streamVideoNative requires fileId", null),
                outputUri = params["outputUri"] as? String
                  ?: throw CodedException("ERR_PARAMS", "streamVideoNative requires outputUri", null),
                declaredSizeBytes = (params["sizeBytes"] as? Number)?.toLong(),
                declaredChunkCount = (params["chunkCount"] as? Number)?.toInt(),
                cacheDir = reactContext.cacheDir,
                clientVersion = clientVersion(),
                progress = progress,
                onTerminal = {
                  if (!requestId.isNullOrEmpty()) {
                    removePreviewDownloadCancellation(requestId)
                    clearPreviewProgress(requestId)
                  }
                },
              )
              mapOf(
                "streamUri" to started.streamUri,
                "outputUri" to started.outputUri,
                "outputPath" to started.outputPath,
                "plaintextSize" to started.plaintextSize,
                "chunkCount" to started.chunkCount,
                "streamId" to started.streamId,
              )
            } catch (t: Throwable) {
              throw t
            }
          }
          promise.resolve(result)
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }
    Function("getPreviewLoadProgress") { requestId: String? ->
      readPreviewProgress(requestId) ?: emptyMap()
    }

    // ───────────────────── native offline decrypt (task 1683d) ───────────────
    //
    // Kotlin port of the 1683b chunk-window loop for LOCAL offline ciphertext:
    // streams the encrypted blob from disk (never a whole-file base64 buffer in
    // the JS heap), decrypts chunk-wise, writes a .tmp and renames. JS keeps
    // the framing resolution + fallback; progress/cancel ride the existing
    // preview-download surface.
    AsyncFunction("decryptLocalFileNative") { params: Map<String, Any?>, promise: Promise ->
      scope.launch {
        val requestId = params["requestId"] as? String ?: ""
        try {
          val fileKey = params["fileKey"] as? ByteArray
            ?: throw CodedException("ERR_PARAMS", "decryptLocalFileNative requires fileKey", null)
          val inputPath = filePathFromUri(
            params["inputUri"] as? String
              ?: throw CodedException("ERR_PARAMS", "decryptLocalFileNative requires inputUri", null),
          )
          val outputUri = params["outputUri"] as? String
            ?: throw CodedException("ERR_PARAMS", "decryptLocalFileNative requires outputUri", null)
          val outputFile = File(filePathFromUri(outputUri))
          val outputParent = outputFile.parentFile
            ?: throw CodedException("ERR_OUTPUT_PATH", "output path has no parent directory", null)
          if (!outputParent.exists()) outputParent.mkdirs()
          fun number(key: String): Long? = (params[key] as? Number)?.toLong()
          val chunkSizeBytes = number("chunkSizeBytes")
            ?: throw CodedException("ERR_PARAMS", "decryptLocalFileNative requires chunkSizeBytes", null)
          val chunkCount = number("chunkCount")
            ?: throw CodedException("ERR_PARAMS", "decryptLocalFileNative requires chunkCount", null)
          val originalSize = number("originalSize")
            ?: throw CodedException("ERR_PARAMS", "decryptLocalFileNative requires originalSize", null)

          val progress = PreviewDownloadProgress(requestId, params["fileId"] as? String ?: "") { body ->
            storePreviewProgress(requestId, body)
          }
          if (requestId.isNotEmpty()) {
            storePreviewDownloadCancellation(
              progress,
              requestId,
            )
          }
          try {
            val result = withContext(Dispatchers.IO) {
              decryptLocalFileChunks(
                progress,
                fileKey,
                inputPath,
                outputFile,
                chunkSizeBytes,
                chunkCount.toInt(),
                originalSize,
              )
            }
            promise.resolve(result)
          } catch (t: Throwable) {
            progress.onError(t.message ?: t.javaClass.simpleName)
            throw t
          } finally {
            if (requestId.isNotEmpty()) {
              removePreviewDownloadCancellation(requestId)
              clearPreviewProgress(requestId)
            }
          }
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    // ─────────────────────── native manual upload (task 1683c) ───────────────
    //
    // Kotlin port of iOS BeebeebCryptoModule.swift:4118–4200. JS owns the
    // upload-session protocol (init / resume state / complete / encrypted-name
    // patch); native owns everything that must not touch the JS heap: reading
    // the file, encrypting it with the core streaming encryptor and PUTting
    // the frames with byte-level progress. See NativeManualUploader.

    Function("planUploadChunksNative") { fileSizeBytes: Double ->
      val plan = NativeManualUploader.plan(fileSizeBytes.coerceAtLeast(0.0).toLong().toULong())
      mapOf(
        "chunkSizeBytes" to plan.chunkSizeBytes.toLong().toDouble(),
        "chunkCount" to plan.chunkCount.toLong().toDouble(),
      )
    }

    AsyncFunction("uploadChunksNative") { params: Map<String, Any?>, promise: Promise ->
      scope.launch {
        val requestId = params["requestId"] as? String
        try {
          if (requestId.isNullOrEmpty()) {
            throw CodedException(
              "ERR_UPLOAD_PARAMS",
              "Missing required parameters for uploadChunksNative",
              null,
            )
          }
          val request = parseUploadRequest(params)
          Log.i(
            UPLOAD_LOG_TAG,
            "upload.native.start fileId=${request.fileId} chunkCount=${request.chunkCount} " +
              "chunkSizeBytes=${request.chunkSizeBytes} startChunkIndex=${request.startChunkIndex}",
          )
          val progress = NativeUploadProgress(requestId)
          storeUploadProgress(progress)
          val result = try {
            withContext(Dispatchers.IO) { NativeManualUploader.upload(request, progress) }
          } catch (t: Throwable) {
            progress.fail(t.message ?: t.javaClass.simpleName)
            Log.e(UPLOAD_LOG_TAG, "upload.native.error fileId=${request.fileId} error=${t.message ?: t.javaClass.simpleName}")
            throw t
          } finally {
            removeUploadProgress(requestId)
          }
          Log.i(
            UPLOAD_LOG_TAG,
            "upload.native.complete fileId=${request.fileId} chunksUploaded=${result["chunksUploaded"]} " +
              "bytesUploaded=${result["bytesUploaded"]} bytesTotal=${result["bytesTotal"]}",
          )
          promise.resolve(result)
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    Function("getUploadProgressNative") { requestId: String? ->
      readUploadProgress(requestId)
    }

    AsyncFunction("cancelUploadNative") { requestId: String ->
      cancelUpload(requestId)
    }

    // ── 0438 Expo wrapper for the Rust-side fast-path decrypt (Android port,
    // task 1683c; iOS reference BeebeebCryptoModule.swift:3780) ───────────────
    //
    // Rust slices the contiguous encrypted body, decrypts each chunk and
    // appends plaintext to outputPath in one call — no per-chunk JSI
    // round-trips. Flips isDecryptToFileReady() (src/lib/decrypt-to-file.ts).
    AsyncFunction("decryptContiguousToFile") {
      fileKey: ByteArray,
      body: ByteArray,
      chunkSize: Double,
      outputPath: String,
      promise: Promise,
      ->
      scope.launch {
        try {
          if (chunkSize <= 0.0) {
            throw CodedException("ERR_CHUNK_SIZE", "Invalid chunk size", null)
          }
          // JS hands us an expo-file-system URI ("file:///data/.../preview/x.png").
          // Rust does File::create() on whatever string it gets, and a file://
          // URI is not a POSIX path — convert at the native boundary like every
          // other file-taking function in this module (iOS does the same via
          // fileURL(fromURI:); see the Swift comment on this function).
          val resolvedPath = filePathFromUri(outputPath)
          val written = withContext(Dispatchers.IO) {
            uniffi.beebeeb_uniffi.decryptContiguousToFile(
              fileKey = fileKey,
              body = body,
              chunkSize = chunkSize.toLong().toULong(),
              outputPath = resolvedPath,
            )
          }
          promise.resolve(written.toLong())
        } catch (t: Throwable) {
          rejectUnexpected(promise, t)
        }
      }
    }

    // ─────────────────────── pure-Kotlin surfaces (keep stub shapes) ─────────

    AsyncFunction("renderPdfFirstPage") { _: String, _: String, _: Double -> null }

    AsyncFunction("mirrorSessionToAppGroup") { _: String?, _: String? -> true }

    AsyncFunction("mirrorSimulatorFileProviderMasterKey") { _: String? -> false }

    // File Provider is iOS-only; these status maps drive SettingsScreen's
    // `supported: false` branch. Android shares arrive via Intent filters (M4).
    AsyncFunction("registerFileProviderDomain") { ->
      mapOf(
        "supported" to false,
        "identifier" to "io.beebeeb.files",
        "displayName" to "Beebeeb",
        "registered" to false,
        "added" to false,
        "removedBeforeAdd" to false,
        "domainCount" to 0,
        "rootEnumerationSignaled" to false,
        "workingSetEnumerationSignaled" to false,
      )
    }

    AsyncFunction("listFileProviderDomains") { -> emptyList<Map<String, Any?>>() }

    AsyncFunction("unregisterFileProviderDomain") { ->
      mapOf(
        "supported" to false,
        "identifier" to "io.beebeeb.files",
        "displayName" to "Beebeeb",
        "registered" to false,
        "added" to false,
        "removedBeforeAdd" to false,
        "domainCount" to 0,
        "rootEnumerationSignaled" to false,
        "workingSetEnumerationSignaled" to false,
      )
    }

    AsyncFunction("setFileProviderEnabled") { _: Boolean ->
      mapOf(
        "supported" to false,
        "identifier" to "io.beebeeb.files",
        "displayName" to "Beebeeb",
        "registered" to false,
        "added" to false,
        "removedBeforeAdd" to false,
        "domainCount" to 0,
        "rootEnumerationSignaled" to false,
        "workingSetEnumerationSignaled" to false,
      )
    }

    AsyncFunction("getFileProviderPrivacyState") { ->
      mapOf(
        "supported" to false,
        "showInFiles" to false,
        "requireDeviceAuth" to true,
        "unlockedUntilMs" to 0,
        "unlockWindowSeconds" to 300,
        "locked" to true,
      )
    }

    AsyncFunction("setFileProviderAuthRequired") { _: Boolean ->
      mapOf(
        "supported" to false,
        "showInFiles" to false,
        "requireDeviceAuth" to true,
        "unlockedUntilMs" to 0,
        "unlockWindowSeconds" to 300,
        "locked" to true,
      )
    }

    AsyncFunction("unlockFileProviderAccess") { ->
      mapOf(
        "supported" to false,
        "showInFiles" to false,
        "requireDeviceAuth" to true,
        "unlockedUntilMs" to 0,
        "unlockWindowSeconds" to 300,
        "locked" to true,
      )
    }

    AsyncFunction("lockFileProviderAccess") { ->
      mapOf(
        "supported" to false,
        "showInFiles" to false,
        "requireDeviceAuth" to true,
        "unlockedUntilMs" to 0,
        "unlockWindowSeconds" to 300,
        "locked" to true,
      )
    }

    AsyncFunction("resetFileProviderDomain") { ->
      mapOf(
        "supported" to false,
        "identifier" to "io.beebeeb.files",
        "displayName" to "Beebeeb",
        "registered" to false,
        "added" to false,
        "removedBeforeAdd" to false,
        "domainCount" to 0,
        "rootEnumerationSignaled" to false,
        "workingSetEnumerationSignaled" to false,
      )
    }

    // Share intake on Android is a manifest Intent flow (M4); the iOS dropbox
    // calls below are unreachable from Android JS (platform-guarded caller).
    AsyncFunction("listPendingShares") { -> emptyList<Map<String, Any?>>() }
    AsyncFunction("consumePendingShare") { _: String -> notLinked() }
    AsyncFunction("clearAllPendingShares") { -> 0 }

    OnDestroy {
      handles.clear()
      scope.cancel()
    }
  }
}

class NotLinkedException : CodedException(
  code = "NOT_LINKED",
  message = "BeebeebCore .so not linked — run repos/core/build-android.sh first",
  cause = null,
)
