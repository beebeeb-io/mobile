package expo.modules.beebeebcrypto

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.crypto.Cipher
import kotlin.coroutines.resume

/**
 * Vault-auth codes JS branches on — `crypto-context.tsx` `surfacedReasonForAuthCode`
 * ([CC]:361–374). Must match the iOS `VaultAuthException` codes exactly:
 * NOT_AVAILABLE is the retryable family; CANCELED/FAILED/LOCKOUT are surfaced.
 */
object VaultAuthCodes {
  const val SE_NOT_WARM = "ERR_VAULT_SE_NOT_WARM"
  const val AUTH_NOT_AVAILABLE = "ERR_VAULT_AUTH_NOT_AVAILABLE" // retryable
  const val AUTH_CANCELED = "ERR_VAULT_AUTH_CANCELED"
  const val AUTH_FAILED = "ERR_VAULT_AUTH_FAILED"
  const val BIOMETRY_LOCKOUT = "ERR_VAULT_BIOMETRY_LOCKOUT"
}

class VaultAuthException(code: String, detail: String) :
  CodedException(code, detail, null)

sealed class BiometricOutcome {
  class Success(val cipher: Cipher) : BiometricOutcome()
  data class Error(val code: String, val detail: String) : BiometricOutcome()
}

/**
 * Android counterpart of the iOS vault-auth gate: a per-use Keystore key
 * (Task 1's [AndroidKeyStoreVault.prepareBiometricCipher]) authorized through
 * BiometricPrompt with a CryptoObject. Requires a foreground FragmentActivity —
 * background paths must never call this (spec §5.2).
 */
object BiometricUnlock {

  /** Stable mapping from androidx.biometric error codes to the JS codes. */
  fun mapErrorCode(errorCode: Int): String = when (errorCode) {
    BiometricPrompt.ERROR_CANCELED,
    BiometricPrompt.ERROR_USER_CANCELED,
    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
    -> VaultAuthCodes.AUTH_CANCELED

    BiometricPrompt.ERROR_LOCKOUT,
    BiometricPrompt.ERROR_LOCKOUT_PERMANENT,
    -> VaultAuthCodes.BIOMETRY_LOCKOUT

    BiometricPrompt.ERROR_HW_UNAVAILABLE,
    BiometricPrompt.ERROR_NO_BIOMETRICS,
    BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
    -> VaultAuthCodes.AUTH_NOT_AVAILABLE

    else -> VaultAuthCodes.AUTH_FAILED
  }

  /**
   * Runs one BiometricPrompt for [cipher]. Resolves with the same cipher
   * instance on success (per-use keys require it), or an [BiometricOutcome.Error]
   * carrying the vault-auth code.
   */
  suspend fun authenticate(
    activity: androidx.fragment.app.FragmentActivity,
    cipher: Cipher,
    title: String,
  ): BiometricOutcome {
    val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
      BiometricManager.Authenticators.DEVICE_CREDENTIAL

    val canAuthenticate = BiometricManager.from(activity).canAuthenticate(authenticators)
    if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
      return BiometricOutcome.Error(
        VaultAuthCodes.AUTH_NOT_AVAILABLE,
        "canAuthenticate=$canAuthenticate",
      )
    }

    return suspendCancellableCoroutine { cont ->
      val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val authorized = result.cryptoObject?.cipher
            if (authorized != null) {
              cont.resume(BiometricOutcome.Success(authorized))
            } else {
              cont.resume(BiometricOutcome.Error(VaultAuthCodes.AUTH_FAILED, "no cipher in result"))
            }
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            cont.resume(BiometricOutcome.Error(mapErrorCode(errorCode), errString.toString()))
          }

          // onAuthenticationFailed is a per-attempt failure; the prompt keeps
          // running by itself and only terminal errors arrive via onAuthenticationError.
        },
      )

      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        // No negative button: DEVICE_CREDENTIAL supplies it.
        .setAllowedAuthenticators(authenticators)
        .build()

      prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
      cont.invokeOnCancellation { prompt.cancelAuthentication() }
    }
  }
}
