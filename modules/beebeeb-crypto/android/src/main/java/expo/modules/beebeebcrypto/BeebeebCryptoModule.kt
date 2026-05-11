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

    AsyncFunction("encryptChunk") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("decryptChunk") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("encryptMetadata") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("decryptMetadata") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

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
