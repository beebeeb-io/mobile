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
}
