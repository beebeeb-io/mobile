package expo.modules.beebeebcrypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Task 1683b probe — the Android module surface must expose the streaming
 * preview download + decrypt bridge, contract-identical to iOS
 * (`BeebeebCryptoModule.swift:3992+`).
 *
 * RED before the port: the Kotlin module's AsyncFunction list had no
 * `downloadAndDecryptFileNative`, so the JS wrapper
 * (`modules/beebeeb-crypto/src/BeebeebCrypto.ts:1127`) threw
 * "downloadAndDecryptFileNative is not available in this native build" and
 * every network preview/save fell through `not_available_fallback`
 * (`src/lib/native-decrypt.ts:468`) to the JS fallback.
 *
 * The probe builds the module's `definition()` (registration only — no
 * lambdas are invoked, no app context needed) and asserts the three
 * contract entries exist under their exact JS-facing names.
 */
@RunWith(AndroidJUnit4::class)
class ModuleSurfaceProbeTest {

  @Test
  fun exposesDownloadAndDecryptFileNative() {
    val def = BeebeebCryptoModule().definition()
    assertTrue(
      "Android BeebeebCrypto must expose downloadAndDecryptFileNative (task 1683b)",
      def.asyncFunctions.containsKey("downloadAndDecryptFileNative"),
    )
  }

  @Test
  fun exposesCancelAndProgressSurface() {
    val def = BeebeebCryptoModule().definition()
    assertTrue(
      "Android BeebeebCrypto must expose cancelDownloadAndDecryptFileNative (task 1683b)",
      def.asyncFunctions.containsKey("cancelDownloadAndDecryptFileNative"),
    )
    assertTrue(
      "Android BeebeebCrypto must expose getPreviewLoadProgress (task 1683b)",
      def.syncFunctions.containsKey("getPreviewLoadProgress"),
    )
  }

  // ── task 1683c — native upload engine + fast decrypt-to-file ───────────────
  //
  // iOS contract: planUploadChunksNative (sync, BeebeebCryptoModule.swift:4125),
  // uploadChunksNative (AsyncFunction, :4133), getUploadProgressNative (sync,
  // :4194), cancelUploadNative (:4198) and decryptContiguousToFile (:3780).
  // RED before the port: none of these existed on the Kotlin module, so
  // api.ts:1808 (`Platform.OS !== 'ios' || !isNativeUploadAvailable()`) bailed
  // every Android upload to the JS chunk loop and isDecryptToFileReady()
  // (`src/lib/decrypt-to-file.ts:97`) stayed false.

  @Test
  fun exposesNativeUploadEngineSurface() {
    val def = BeebeebCryptoModule().definition()
    assertTrue(
      "Android BeebeebCrypto must expose planUploadChunksNative (task 1683c)",
      def.syncFunctions.containsKey("planUploadChunksNative"),
    )
    assertTrue(
      "Android BeebeebCrypto must expose uploadChunksNative (task 1683c)",
      def.asyncFunctions.containsKey("uploadChunksNative"),
    )
    assertTrue(
      "Android BeebeebCrypto must expose getUploadProgressNative (task 1683c)",
      def.syncFunctions.containsKey("getUploadProgressNative"),
    )
    assertTrue(
      "Android BeebeebCrypto must expose cancelUploadNative (task 1683c)",
      def.asyncFunctions.containsKey("cancelUploadNative"),
    )
  }

  @Test
  fun exposesDecryptContiguousToFile() {
    val def = BeebeebCryptoModule().definition()
    assertTrue(
      "Android BeebeebCrypto must expose decryptContiguousToFile (task 1683c)",
      def.asyncFunctions.containsKey("decryptContiguousToFile"),
    )
  }

  // ── task 1683d — native offline decrypt-from-local-file ────────────────────
  //
  // The offline open path (`decryptLocalFileLeased`, src/lib/native-decrypt.ts)
  // reads the whole local ciphertext as base64 into the JS heap and writes the
  // plaintext back as base64 — the 1683 OOM class at >100 MB. The Kotlin port
  // streams the file from disk with the 1683b chunk-window loop
  // (RandomAccessFile window → UniFFI decryptChunk → .tmp rename). RED before
  // the port: no such AsyncFunction on the module.

  @Test
  fun exposesDecryptLocalFileNative() {
    val def = BeebeebCryptoModule().definition()
    assertTrue(
      "Android BeebeebCrypto must expose decryptLocalFileNative (task 1683d)",
      def.asyncFunctions.containsKey("decryptLocalFileNative"),
    )
  }
}
