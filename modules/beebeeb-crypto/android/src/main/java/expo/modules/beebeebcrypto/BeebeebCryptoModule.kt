package expo.modules.beebeebcrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException

// Placeholder module. All functions throw NotLinkedException until the Android
// .so files are built (repos/core/build-android.sh) and bundled into the APK.
class BeebeebCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("generateRecoveryPhrase") { -> throw NotLinkedException() }

    AsyncFunction("recoverFromPhrase") { _: String -> throw NotLinkedException() }

    AsyncFunction("encryptChunk") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("decryptChunk") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("encryptMetadata") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("decryptMetadata") { _: ByteArray, _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("opaqueRegistrationStart") { _: String, _: String -> throw NotLinkedException() }

    AsyncFunction("opaqueRegistrationFinish") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("opaqueLoginStart") { _: String -> throw NotLinkedException() }

    AsyncFunction("opaqueLoginFinish") { _: ByteArray, _: ByteArray -> throw NotLinkedException() }

    AsyncFunction("deriveFileKey") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("storeKeyInKeychain") { _: ByteArray, _: String -> throw NotLinkedException() }

    AsyncFunction("loadKeyFromKeychain") { _: String -> throw NotLinkedException() }

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
