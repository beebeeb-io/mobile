package expo.modules.beebeebcrypto

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM-side twin of [ModuleSurfaceProbeTest] (task 1683b) — same assertions
 * without a device. Module registration (`definition()`) touches no Android
 * framework APIs, so the surface probe runs on the JVM for a fast loop.
 */
class ModuleSurfaceJvmProbeTest {

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
