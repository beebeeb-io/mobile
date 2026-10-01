package expo.modules.beebeebcrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import java.security.SecureRandom

// Stub helper — throws until the Rust core is linked (M0). The return type is
// Any? deliberately: a bare `throw` makes the AsyncFunction lambdas infer
// R = Nothing, which Kotlin rejects as a reified type parameter.
private fun notLinked(): Any? = throw NotLinkedException()

// Placeholder module. All functions throw NotLinkedException until the Android
// .so files are built (repos/core/build-android.sh) and bundled into the APK.
class BeebeebCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("generateRandomBytes") { length: Int ->
      if (length <= 0 || length > 4096) {
        throw CodedException("INVALID_LENGTH", "Invalid random byte length", null)
      }
      ByteArray(length).also { SecureRandom().nextBytes(it) }
    }

    AsyncFunction("generateRecoveryPhrase") { -> notLinked() }

    AsyncFunction("recoverFromPhrase") { _: String -> notLinked() }

    AsyncFunction("computeRecoveryCheck") { _: ByteArray -> notLinked() }

    AsyncFunction("deriveX25519Private") { _: ByteArray -> notLinked() }

    AsyncFunction("deriveX25519Public") { _: ByteArray -> notLinked() }

    AsyncFunction("x25519SharedSecret") { _: ByteArray, _: ByteArray -> notLinked() }

    AsyncFunction("deriveShareKey") { _: ByteArray, _: ByteArray -> notLinked() }

    AsyncFunction("encryptChunk") { _: ByteArray, _: ByteArray -> notLinked() }

    AsyncFunction("decryptChunk") { _: ByteArray, _: ByteArray, _: ByteArray -> notLinked() }

    AsyncFunction("encryptMetadata") { _: ByteArray, _: String -> notLinked() }

    AsyncFunction("decryptMetadata") { _: ByteArray, _: ByteArray, _: ByteArray -> notLinked() }

    AsyncFunction("renderPdfFirstPage") { _: String, _: String, _: Double -> null }

    AsyncFunction("opaqueRegistrationStart") { _: String, _: String -> notLinked() }

    AsyncFunction("opaqueRegistrationFinish") { _: String, _: String, _: String -> notLinked() }

    AsyncFunction("opaqueLoginStart") { _: String, _: String -> notLinked() }

    AsyncFunction("opaqueLoginFinish") { _: String, _: String, _: String, _: Int -> notLinked() }

    AsyncFunction("deriveFileKey") { _: ByteArray, _: String -> notLinked() }

    AsyncFunction("storeKeyInKeychain") { _: ByteArray, _: String -> notLinked() }

    AsyncFunction("loadKeyFromKeychain") { _: String -> notLinked() }

    AsyncFunction("deleteKeyFromKeychain") { -> notLinked() }

    AsyncFunction("setRequireBiometric") { _: Boolean -> notLinked() }

    AsyncFunction("mirrorSessionToAppGroup") { _: String?, _: String? -> true }

    AsyncFunction("mirrorSimulatorFileProviderMasterKey") { _: String? -> false }

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

    // Share Extension is iOS-only. Android receives shared content through
    // Intent filters declared in the manifest, which is a separate flow.
    AsyncFunction("listPendingShares") { -> emptyList<Map<String, Any?>>() }
    AsyncFunction("consumePendingShare") { _: String -> notLinked() }
    AsyncFunction("clearAllPendingShares") { -> 0 }
  }
}

class NotLinkedException : CodedException(
  code = "NOT_LINKED",
  message = "BeebeebCore .so not linked — run repos/core/build-android.sh first",
  cause = null,
)
