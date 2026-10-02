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

  // ── task 1683c — native upload engine + fast decrypt-to-file ───────────────
  // Same assertions as the androidTest twin; RED before the port.

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
}
