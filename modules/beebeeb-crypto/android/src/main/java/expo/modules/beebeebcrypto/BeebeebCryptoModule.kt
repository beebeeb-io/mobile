package expo.modules.beebeebcrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import java.security.SecureRandom

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

    AsyncFunction("generateRecoveryPhrase") { -> throw NotLinkedException() }

    AsyncFunction("recoverFromPhrase") { _: String -> throw NotLinkedException() }

    AsyncFunction("computeRecoveryCheck") { _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("deriveX25519Private") { _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("deriveX25519Public") { _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("x25519SharedSecret") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("deriveShareKey") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("encryptChunk") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("decryptChunk") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("encryptMetadata") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("decryptMetadata") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("renderPdfFirstPage") { _: String, _: String, _: Double -> null }

    AsyncFunction("opaqueRegistrationStart") { _: String, _: String -> throw NotLinkedException() }

    AsyncFunction("opaqueRegistrationFinish") { _: String, _: String, _: String -> throw NotLinkedException() }

    AsyncFunction("opaqueLoginStart") { _: String, _: String -> throw NotLinkedException() }

    AsyncFunction("opaqueLoginFinish") { _: String, _: String, _: String -> throw NotLinkedException() }

    AsyncFunction("deriveFileKey") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("storeKeyInKeychain") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("loadKeyFromKeychain") { _: String -> throw NotLinkedException() }

    AsyncFunction("deleteKeyFromKeychain") { -> throw NotLinkedException() }

    AsyncFunction("setRequireBiometric") { _: Boolean -> throw NotLinkedException() }

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
    AsyncFunction("consumePendingShare") { _: String -> throw NotLinkedException() }
    AsyncFunction("clearAllPendingShares") { -> 0 }
  }
}

class NotLinkedException : CodedException(
  code = "NOT_LINKED",
  message = "BeebeebCore .so not linked — run repos/core/build-android.sh first",
  cause = null,
)
