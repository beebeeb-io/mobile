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

    AsyncFunction<Any?>("generateRecoveryPhrase") { -> throw NotLinkedException() }

    AsyncFunction<Any?>("recoverFromPhrase") { _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("computeRecoveryCheck") { _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("deriveX25519Private") { _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("deriveX25519Public") { _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("x25519SharedSecret") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("deriveShareKey") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("encryptChunk") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("decryptChunk") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction<Any?>("encryptMetadata") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("decryptMetadata") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("renderPdfFirstPage") { _: String, _: String, _: Double -> null }

    AsyncFunction<Any?>("opaqueRegistrationStart") { _: String, _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("opaqueRegistrationFinish") { _: String, _: String, _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("opaqueLoginStart") { _: String, _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("opaqueLoginFinish") { _: String, _: String, _: String, _: Int -> throw NotLinkedException() }

    AsyncFunction<Any?>("deriveFileKey") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("storeKeyInKeychain") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("loadKeyFromKeychain") { _: String -> throw NotLinkedException() }

    AsyncFunction<Any?>("deleteKeyFromKeychain") { -> throw NotLinkedException() }

    AsyncFunction<Any?>("setRequireBiometric") { _: Boolean -> throw NotLinkedException() }

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
    AsyncFunction<Any?>("consumePendingShare") { _: String -> throw NotLinkedException() }
    AsyncFunction("clearAllPendingShares") { -> 0 }
  }
}

class NotLinkedException : CodedException(
  code = "NOT_LINKED",
  message = "BeebeebCore .so not linked — run repos/core/build-android.sh first",
  cause = null,
)
