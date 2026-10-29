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
    val label = "io.beebeeb.master-key"
    val first = freshVault()
    val plaintext = "persisted-across-instances".toByteArray()
    first.writeKeyBlob(label, first.sealWithRoot(plaintext))

    val second = freshVault()
    val read = second.readKeyBlob(label)
    assertNotNull(read)
    assertArrayEquals(plaintext, second.unsealWithRoot(read!!))
  }

  @Test
  fun deleteAllKeyBlobsRemovesOnlyKeyBlobs() {
    val vault = freshVault()
    vault.writeKeyBlob("label-a", vault.sealWithRoot("a".toByteArray()))
    vault.writeKeyBlob("label-b", vault.sealWithRoot("b".toByteArray()))
    assertTrue(vault.hasKeyBlob("label-a"))
    assertTrue(vault.hasKeyBlob("label-b"))
    vault.deleteAllKeyBlobs()
    assertFalse(vault.hasKeyBlob("label-a"))
    assertFalse(vault.hasKeyBlob("label-b"))
    assertNull(freshVault().readKeyBlob("label-a"))
  }

  @Test
  fun deleteKeyBlobRemovesSingleBlob() {
    val vault = freshVault()
    vault.writeKeyBlob("keep-me", vault.sealWithRoot("k".toByteArray()))
    vault.writeKeyBlob("drop-me", vault.sealWithRoot("d".toByteArray()))
    vault.deleteKeyBlob("drop-me")
    assertTrue(vault.hasKeyBlob("keep-me"))
    assertFalse(vault.hasKeyBlob("drop-me"))
    vault.deleteKeyBlob("keep-me")
  }

  @Test
  fun biometricKeyGenerationAndTeardown() {
    val vault = freshVault()
    // Per-use keys require an ENROLLED strong biometric (hardware feature alone
    // is not enough — keystore throws InvalidAlgorithmParameterException).
    val biometricsEnrolled = androidx.biometric.BiometricManager.from(context)
      .canAuthenticate(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
      androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS
    org.junit.Assume.assumeTrue("no enrolled strong biometric on this device", biometricsEnrolled)

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
