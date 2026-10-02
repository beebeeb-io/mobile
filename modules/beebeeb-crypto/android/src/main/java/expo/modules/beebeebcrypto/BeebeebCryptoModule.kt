package expo.modules.beebeebcrypto

import android.content.Context
import android.util.Base64
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
