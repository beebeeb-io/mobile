package expo.modules.beebeebcrypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device tests for [AndroidKeyStoreVault] (M1, task 1683 follow-up).
 * AndroidKeyStore only exists on a device/emulator — these cannot run on the JVM.
 */
@RunWith(AndroidJUnit4::class)
class AndroidKeyStoreVaultTest {

  private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun freshVault() = AndroidKeyStoreVault(context)

  @Test
  fun sealUnsealRoundTrip() {
    val vault = freshVault()
    val plaintext = "beebeeb-vault-roundtrip-plaintext".toByteArray()
    val blob = vault.sealWithRoot(plaintext)
    assertEquals(SealedBlob.IV_LENGTH, blob.iv.size)
    assertArrayEquals(plaintext, vault.unsealWithRoot(blob))
  }

  @Test
  fun rootKeyIsStableAcrossVaultInstances() {
    val first = freshVault()
    val blob = first.sealWithRoot("stable-key-check".toByteArray())
    val second = freshVault()
    assertArrayEquals("stable-key-check".toByteArray(), second.unsealWithRoot(blob))
  }

  @Test
  fun tamperedCiphertextFailsToUnseal() {
    val vault = freshVault()
    val blob = vault.sealWithRoot("tamper-me".toByteArray())
    val tampered = ByteArray(blob.ciphertext.size) { i ->
      (blob.ciphertext[i].toInt() xor 0x01).toByte()
    }
    assertThrows(Exception::class.java) {
      vault.unsealWithRoot(SealedBlob(blob.iv, tampered))
    }
  }

  @Test
  fun blobPersistsAcrossInstances() {
    val first = freshVault()
    val plaintext = "persisted-across-instances".toByteArray()
    first.writeRootBlob(first.sealWithRoot(plaintext))

    val second = freshVault()
    val read = second.readRootBlob()
    assertNotNull(read)
    assertArrayEquals(plaintext, second.unsealWithRoot(read!!))
  }

  @Test
  fun destroyedRootKeyAndBlobAreGone() {
    val vault = freshVault()
    vault.writeRootBlob(vault.sealWithRoot("to-be-destroyed".toByteArray()))
    assertTrue(vault.hasRootBlob())
    vault.destroyRootKey()
    assertFalse(vault.hasRootBlob())
    assertNull(freshVault().readRootBlob())
  }

  @Test
  fun biometricKeyGenerationAndTeardown() {
    val vault = freshVault()
    // Generation requires biometric hardware; skip on devices without it.
    val hasHardware = context.packageManager.hasSystemFeature(
      android.content.pm.PackageManager.FEATURE_FINGERPRINT,
    ) || context.packageManager.hasSystemFeature(
      android.content.pm.PackageManager.FEATURE_FACE,
    )
    org.junit.Assume.assumeTrue("no biometric hardware declared", hasHardware)

    val key = vault.getOrCreateBiometricKey()
    assertNotNull(key)
    assertTrue(vault.hasBiometricKey())
    vault.destroyBiometricKey()
    assertFalse(vault.hasBiometricKey())
  }

  @Test
  fun prepareBiometricCipherWithoutKeyRaisesInvalidated() {
    val vault = freshVault()
    vault.destroyBiometricKey()
    assertThrows(VaultKeyInvalidatedException::class.java) {
      vault.prepareBiometricCipher(javax.crypto.Cipher.ENCRYPT_MODE)
    }
  }
}
