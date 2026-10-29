package expo.modules.beebeebcrypto

import androidx.biometric.BiometricPrompt
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BiometricUnlockTest {

  @Test
  fun canceledFamilyMapsToAuthCanceled() {
    assertEquals(VaultAuthCodes.AUTH_CANCELED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_CANCELED))
    assertEquals(VaultAuthCodes.AUTH_CANCELED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_USER_CANCELED))
    assertEquals(VaultAuthCodes.AUTH_CANCELED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_NEGATIVE_BUTTON))
  }

  @Test
  fun lockoutFamilyMapsToBiometryLockout() {
    assertEquals(VaultAuthCodes.BIOMETRY_LOCKOUT, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_LOCKOUT))
    assertEquals(VaultAuthCodes.BIOMETRY_LOCKOUT, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_LOCKOUT_PERMANENT))
  }

  @Test
  fun unavailableFamilyMapsToRetryableNotAvailable() {
    assertEquals(VaultAuthCodes.AUTH_NOT_AVAILABLE, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_HW_UNAVAILABLE))
    assertEquals(VaultAuthCodes.AUTH_NOT_AVAILABLE, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_NO_BIOMETRICS))
    assertEquals(VaultAuthCodes.AUTH_NOT_AVAILABLE, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL))
  }

  @Test
  fun otherFailuresMapToAuthFailed() {
    assertEquals(VaultAuthCodes.AUTH_FAILED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_UNABLE_TO_PROCESS))
    assertEquals(VaultAuthCodes.AUTH_FAILED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_TIMEOUT))
    assertEquals(VaultAuthCodes.AUTH_FAILED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_VENDOR))
    assertEquals(VaultAuthCodes.AUTH_FAILED, BiometricUnlock.mapErrorCode(BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED))
  }

  @Test
  fun unknownCodeMapsToAuthFailed() {
    assertEquals(VaultAuthCodes.AUTH_FAILED, BiometricUnlock.mapErrorCode(-42))
  }
}
