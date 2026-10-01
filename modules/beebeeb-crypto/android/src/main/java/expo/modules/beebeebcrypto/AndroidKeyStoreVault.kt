package expo.modules.beebeebcrypto

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android counterpart of the iOS `KeychainManager` (spec §5.2, M1).
 *
 * `K_root` — a non-auth-bound AES-256-GCM key in AndroidKeyStore (StrongBox
 * where the device declares it, TEE otherwise). It seals the master key into an
 * app-private blob; credential-encrypted storage gives "after first unlock"
 * semantics (nothing here runs before first unlock), and the key stays usable
 * in background sync while the device is locked.
 *
 * `K_biometric` — a per-use `AUTH_BIOMETRIC_STRONG` key, invalidated on
 * biometric-enrollment change — **disposable by design**: losing it costs
 * convenience only, never data (the passphrase always remains the root of
 * trust). Any invalidation path here destroys the key + its blob and raises
 * [VaultKeyInvalidatedException].
 *
 * Key material never leaves this class except as sealed blobs on disk.
 */
class VaultKeyInvalidatedException(message: String, cause: Throwable? = null) :
  Exception(message, cause)

/** `iv || ciphertext`, persisted app-private (one blob per purpose). */
class SealedBlob(val iv: ByteArray, val ciphertext: ByteArray) {
  fun toBytes(): ByteArray = iv + ciphertext

  companion object {
    const val IV_LENGTH = 12

    fun fromBytes(bytes: ByteArray): SealedBlob {
      require(bytes.size > IV_LENGTH) { "sealed blob too short" }
      return SealedBlob(bytes.copyOfRange(0, IV_LENGTH), bytes.copyOfRange(IV_LENGTH, bytes.size))
    }
  }
}

class AndroidKeyStoreVault(private val context: Context) {

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS_ROOT = "io.beebeeb.vault.root"
    const val ALIAS_BIOMETRIC = "io.beebeeb.vault.biometric"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val GCM_TAG_BITS = 128
    const val VAULT_DIR = "vault"
    const val ROOT_BLOB = "root.blob"
    const val BIOMETRIC_BLOB = "biometric.blob"
  }

  // ---------------------------------------------------------------- K_root

  /** Returns the existing root key or generates one (StrongBox first, TEE fallback). */
  fun getOrCreateRootKey(): SecretKey {
    (keyStore().getKey(ALIAS_ROOT, null) as? SecretKey)?.let { return it }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
    ) {
      try {
        val strongBoxSpec = KeyGenParameterSpec.Builder(
          ALIAS_ROOT,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setIsStrongBoxBacked(true)
          .build()
        return generateKey(strongBoxSpec)
      } catch (_: StrongBoxUnavailableException) {
        // per AOSP guidance: fall back to the TEE-backed generation below
      }
    }
    return generateKey(rootSpec())
  }

  private fun rootSpec(): KeyGenParameterSpec =
    KeyGenParameterSpec.Builder(
      ALIAS_ROOT,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setKeySize(256)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      // Deliberately NOT user-authentication-bound: background backup must be
      // able to unwrap the master key while the device is locked.
      .build()

  private fun generateKey(spec: KeyGenParameterSpec): SecretKey =
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
      .apply { init(spec) }
      .generateKey()

  /** Seals plaintext under K_root (fresh random IV from the Keystore). */
  fun sealWithRoot(plaintext: ByteArray): SealedBlob = seal(getOrCreateRootKey(), plaintext)

  /** Unseals a blob produced by [sealWithRoot]. Throws on tampering/wrong key. */
  fun unsealWithRoot(blob: SealedBlob): ByteArray = unseal(getOrCreateRootKey(), blob)

  fun destroyRootKey() {
    keyStore().deleteEntry(ALIAS_ROOT)
    deleteRootBlob()
  }

  // ----------------------------------------------------------- K_biometric

  /** Returns the existing biometric key or generates a per-use one. */
  fun getOrCreateBiometricKey(): SecretKey {
    (keyStore().getKey(ALIAS_BIOMETRIC, null) as? SecretKey)?.let { return it }

    val spec = KeyGenParameterSpec.Builder(
      ALIAS_BIOMETRIC,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setKeySize(256)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setUserAuthenticationRequired(true)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
          @Suppress("DEPRECATION")
          setUserAuthenticationValidityDurationSeconds(-1) // per-use, biometric-only
        }
      }
      .setInvalidatedByBiometricEnrollment(true)
      .build()
    return generateKey(spec)
  }

  /**
   * Initializes a cipher for the biometric key. Per-use keys are unusable
   * without a BiometricPrompt CryptoObject carrying this same cipher instance.
   * Any invalidation destroys the key + its blob and raises
   * [VaultKeyInvalidatedException] so callers can fall back to the passphrase.
   */
  fun prepareBiometricCipher(mode: Int): Cipher {
    val key = (keyStore().getKey(ALIAS_BIOMETRIC, null) as? SecretKey)
      ?: throw VaultKeyInvalidatedException("no biometric key provisioned")

    val cipher = Cipher.getInstance(TRANSFORMATION)
    try {
      cipher.init(mode, key)
    } catch (e: KeyPermanentlyInvalidatedException) {
      destroyBiometricKey()
      throw VaultKeyInvalidatedException("biometric key permanently invalidated", e)
    } catch (e: UnrecoverableKeyException) {
      destroyBiometricKey()
      throw VaultKeyInvalidatedException("biometric key unrecoverable", e)
    } catch (e: InvalidKeyException) {
      destroyBiometricKey()
      throw VaultKeyInvalidatedException("biometric key invalid", e)
    }
    return cipher
  }

  fun hasBiometricKey(): Boolean = keyStore().containsAlias(ALIAS_BIOMETRIC)

  /** Destroys the biometric key and its blob. Convenience-only loss by design. */
  fun destroyBiometricKey() {
    keyStore().deleteEntry(ALIAS_BIOMETRIC)
    deleteBiometricBlob()
  }

  // ------------------------------------------------------------- raw ops

  /** Seals under an arbitrary (already authorized) biometric cipher. */
  fun seal(cipher: Cipher, plaintext: ByteArray): SealedBlob {
    val output = cipher.doFinal(plaintext)
    return SealedBlob(cipher.iv, output)
  }

  /** Unseals using a cipher initialized for decryption with the given IV. */
  fun unseal(cipher: Cipher, blob: SealedBlob): ByteArray = cipher.doFinal(blob.ciphertext)

  private fun seal(key: SecretKey, plaintext: ByteArray): SealedBlob {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    return SealedBlob(cipher.iv, cipher.doFinal(plaintext))
  }

  private fun unseal(key: SecretKey, blob: SealedBlob): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob.iv))
    return cipher.doFinal(blob.ciphertext)
  }

  // --------------------------------------------------------- blob storage

  private fun vaultDir(): File = File(context.filesDir, VAULT_DIR).apply { mkdirs() }

  private fun writeBlob(name: String, blob: SealedBlob) {
    val dir = vaultDir()
    val tmp = File(dir, "$name.tmp")
    val dst = File(dir, name)
    tmp.writeBytes(blob.toBytes())
    if (!tmp.renameTo(dst)) {
      dst.delete()
      check(tmp.renameTo(dst)) { "vault blob rename failed" }
    }
  }

  private fun readBlob(name: String): SealedBlob? {
    val file = File(vaultDir(), name)
    if (!file.exists()) return null
    return SealedBlob.fromBytes(file.readBytes())
  }

  private fun deleteBlob(name: String) {
    File(vaultDir(), name).delete()
  }

  fun hasRootBlob(): Boolean = File(vaultDir(), ROOT_BLOB).exists()
  fun writeRootBlob(blob: SealedBlob) = writeBlob(ROOT_BLOB, blob)
  fun readRootBlob(): SealedBlob? = readBlob(ROOT_BLOB)
  fun deleteRootBlob() = deleteBlob(ROOT_BLOB)

  fun hasBiometricBlob(): Boolean = File(vaultDir(), BIOMETRIC_BLOB).exists()
  fun writeBiometricBlob(blob: SealedBlob) = writeBlob(BIOMETRIC_BLOB, blob)
  fun readBiometricBlob(): SealedBlob? = readBlob(BIOMETRIC_BLOB)
  fun deleteBiometricBlob() = deleteBlob(BIOMETRIC_BLOB)

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
}
