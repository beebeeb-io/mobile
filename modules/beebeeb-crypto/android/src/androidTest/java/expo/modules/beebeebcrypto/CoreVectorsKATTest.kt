package expo.modules.beebeebcrypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.beebeeb_uniffi.computeRecoveryCheck
import uniffi.beebeeb_uniffi.decryptChunk
import uniffi.beebeeb_uniffi.decryptMetadata
import uniffi.beebeeb_uniffi.deriveFileKey
import uniffi.beebeeb_uniffi.deriveRequestWrapKey
import uniffi.beebeeb_uniffi.deriveShareKey
import uniffi.beebeeb_uniffi.deriveX25519Private
import uniffi.beebeeb_uniffi.deriveX25519Public
import uniffi.beebeeb_uniffi.encryptChunk
import uniffi.beebeeb_uniffi.encryptMetadata
import uniffi.beebeeb_uniffi.openRequestUpload
import uniffi.beebeeb_uniffi.unwrapRequestPrivate
import uniffi.beebeeb_uniffi.x25519SharedSecret
import java.security.MessageDigest

/**
 * Android half of the core known-answer-vector gate (task 1683, mirroring the
 * iOS `CoreVectorsKATTests.swift` from task 1382). Drives `beebeeb-core`'s
 * cross-platform vectors (`test-vectors/vectors.json`, v4, 12 families through
 * the SAME production UniFFI Kotlin bindings the app links — the generated
 * `uniffi.beebeeb_uniffi` sources and the deployed `libbeebeeb_uniffi.so`).
 *
 * Run: `./android/gradlew -p android :beebeeb-crypto:connectedDebugAndroidTest`
 * with the device attached. On failure of the binding to initialize, this suite
 * surfaces the UniFFI API-checksum exception directly (that is the M0 gate for
 * the pinning decision in the design spec — UniFFI 0.31.1).
 *
 * ## Refreshing the vendored vector file
 * `src/androidTest/assets/core-vectors.v4.json` is a vendored COPY of
 * `repos/core/test-vectors/vectors.json`. To refresh after core bumps it:
 * 1. `cp ../../../core/test-vectors/vectors.json modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v4.json`
 * 2. `sha256sum` the new copy and update [EXPECTED_SHA256] (see the task file).
 * 3. If core bumped the version, update [EXPECTED_VERSION] and [REQUIRED_VECTOR_NAMES].
 *
 * ## Families not implemented (documented follow-ups, by design)
 * - `master_key_from_password`, `recovery_phrase_roundtrip`: Argon2id
 *   (256 MiB / 4 iter) — deliberately excluded from the M0 smoke because of
 *   device runtime; add with generous timeouts when the suite is promoted to
 *   a full mirror of the iOS gate.
 * - `envelope_serialization`: not exposed by UniFFI (same skip as iOS).
 * - `share_key_wrap`, `thumbnail_encrypt`: their decrypt primitives need the
 *   exact call mapping confirmed (AES-GCM key/nonce/ciphertext shapes differ
 *   from `decryptChunk` inputs); add with the full mirror.
 */
@RunWith(AndroidJUnit4::class)
class CoreVectorsKATTest {

    companion object {
        /** `sha256sum` of the vendored asset (v4, matching iOS pin 2026-09-22). */
        private const val EXPECTED_SHA256 =
            "a8f5320a0dbd06fa3a26ede7109f3c24295197061f13f81519c010b30157f6e5"
        private const val EXPECTED_VERSION = 4
        private val REQUIRED_VECTOR_NAMES = listOf(
            "master_key_from_password",
            "file_key_derivation",
            "chunk_encrypt_decrypt",
            "x25519_identity_keypair",
            "x25519_share_key_exchange",
            "recovery_check",
            "envelope_serialization",
            "recovery_phrase_roundtrip",
            "metadata_encrypt_decrypt",
            "file_request_seal_open",
            "share_key_wrap",
            "thumbnail_encrypt",
        )

        private fun loadRoot(): JSONObject {
            val assets = InstrumentationRegistry.getInstrumentation().context.assets
            val bytes = assets.open("core-vectors.v4.json").readBytes()
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            val hex = digest.joinToString("") { "%02x".format(it) }
            assertEquals(
                "vendored core-vectors.v4.json drifted from the pinned sha256 — see this file's header",
                EXPECTED_SHA256,
                hex,
            )
            return JSONObject(String(bytes, Charsets.UTF_8))
        }

        private fun vector(root: JSONObject, name: String): JSONObject {
            val vectors: JSONArray = root.getJSONArray("vectors")
            for (i in 0 until vectors.length()) {
                val v = vectors.getJSONObject(i)
                if (v.optString("name") == name) return v
            }
            throw AssertionError("vector '$name' not found in core-vectors.v4.json")
        }

        private fun String.hexToBytes(): ByteArray {
            require(length % 2 == 0) { "odd-length hex: $this" }
            return ByteArray(length / 2) { i ->
                ((this[i * 2].digitToInt(16) shl 4) or this[i * 2 + 1].digitToInt(16)).toByte()
            }
        }

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

        /** Byte-exact comparison with a hex failure message (JUnit's default is useless for bytes). */
        private fun assertHexEquals(message: String, expectedHex: String, actual: ByteArray) {
            val expected = expectedHex.hexToBytes()
            assertTrue(
                "$message — got ${actual.toHex()} (${actual.size} bytes), expected $expectedHex (${expected.size} bytes)",
                expected.contentEquals(actual),
            )
        }
    }

    // MARK: - Integrity of the vendored fixture

    @Test
    fun vectorsFileIntegrity() {
        val root = loadRoot() // includes the SHA-256 pin check
        assertEquals("vectors.json version mismatch", EXPECTED_VERSION, root.getInt("version"))
        val names = mutableSetOf<String>()
        val vectors = root.getJSONArray("vectors")
        for (i in 0 until vectors.length()) {
            names.add(vectors.getJSONObject(i).getString("name"))
        }
        for (name in REQUIRED_VECTOR_NAMES) {
            assertTrue("vectors.json is missing required vector '$name'", names.contains(name))
        }
    }

    // MARK: - 2. file_key_derivation (HKDF-SHA256)

    @Test
    fun fileKeyDerivation() {
        val v = vector(loadRoot(), "file_key_derivation")
        val derived = deriveFileKey(
            v.getString("master_key_hex").hexToBytes(),
            v.getString("file_id_hex").hexToBytes(),
        )
        assertHexEquals("file_key_derivation: derived file key mismatch", v.getString("expected_file_key_hex"), derived)
    }

    // MARK: - 3. chunk_encrypt_decrypt (AES-256-GCM)

    @Test
    fun chunkDecrypt() {
        val v = vector(loadRoot(), "chunk_encrypt_decrypt")
        val plaintext = decryptChunk(
            v.getString("file_key_hex").hexToBytes(),
            v.getString("nonce_hex").hexToBytes(),
            v.getString("ciphertext_hex").hexToBytes(),
        )
        assertHexEquals("chunk_encrypt_decrypt: decrypted plaintext mismatch", v.getString("plaintext_hex"), plaintext)
    }

    @Test
    fun chunkEncryptDecryptRoundtrip() {
        val v = vector(loadRoot(), "chunk_encrypt_decrypt")
        val key = v.getString("file_key_hex").hexToBytes()
        val plaintext = v.getString("plaintext_hex").hexToBytes()
        val encrypted = encryptChunk(key, plaintext)
        val decrypted = decryptChunk(key, encrypted.nonce, encrypted.ciphertext)
        assertHexEquals(
            "chunk roundtrip: encrypt->decrypt must reproduce the plaintext",
            v.getString("plaintext_hex"),
            decrypted,
        )
    }

    // MARK: - 4. x25519_identity_keypair

    @Test
    fun x25519IdentityKeypair() {
        val v = vector(loadRoot(), "x25519_identity_keypair")
        val privateKey = deriveX25519Private(v.getString("master_key_hex").hexToBytes())
        assertHexEquals("x25519_identity_keypair: private key mismatch", v.getString("expected_x25519_private_hex"), privateKey)
        val publicKey = deriveX25519Public(privateKey)
        assertHexEquals("x25519_identity_keypair: public key mismatch", v.getString("expected_x25519_public_hex"), publicKey)
    }

    // MARK: - 5. x25519_share_key_exchange

    @Test
    fun x25519ShareKeyExchange() {
        val v = vector(loadRoot(), "x25519_share_key_exchange")
        val privA = deriveX25519Private(v.getString("alice_master_key_hex").hexToBytes())
        val privB = deriveX25519Private(v.getString("bob_master_key_hex").hexToBytes())
        val pubA = deriveX25519Public(privA)
        val pubB = deriveX25519Public(privB)
        assertHexEquals("share exchange: alice public mismatch", v.getString("alice_x25519_public_hex"), pubA)
        assertHexEquals("share exchange: bob public mismatch", v.getString("bob_x25519_public_hex"), pubB)

        val sharedAB = x25519SharedSecret(privA, pubB)
        val sharedBA = x25519SharedSecret(privB, pubA)
        assertHexEquals("x25519 DH must be commutative", sharedAB.toHex(), sharedBA)
        assertHexEquals("share exchange: shared secret mismatch", v.getString("expected_shared_secret_hex"), sharedAB)

        val shareKey = deriveShareKey(sharedAB, v.getString("file_id_hex").hexToBytes())
        assertHexEquals("share exchange: share key mismatch", v.getString("expected_share_key_hex"), shareKey)
    }

    // MARK: - 6. recovery_check

    @Test
    fun recoveryCheck() {
        val v = vector(loadRoot(), "recovery_check")
        val check = computeRecoveryCheck(v.getString("master_key_hex").hexToBytes())
        assertHexEquals("recovery_check: computed value mismatch", v.getString("expected_recovery_check_hex"), check)
    }

    // MARK: - 9. metadata_encrypt_decrypt (filename AEAD)

    @Test
    fun metadataDecrypt() {
        val v = vector(loadRoot(), "metadata_encrypt_decrypt")
        val decrypted = decryptMetadata(
            v.getString("file_key_hex").hexToBytes(),
            v.getString("nonce_hex").hexToBytes(),
            v.getString("ciphertext_hex").hexToBytes(),
        )
        assertEquals("metadata_encrypt_decrypt: decrypted metadata mismatch", v.getString("metadata"), decrypted)
    }

    @Test
    fun metadataEncryptDecryptRoundtripUnicode() {
        val v = vector(loadRoot(), "metadata_encrypt_decrypt")
        val key = v.getString("file_key_hex").hexToBytes()
        val filenames = listOf(
            "photos/vacation/IMG_2024.jpg",
            "documents/tax-return-2025.pdf",
            "",
            "a",
            "x".repeat(4096),
            "Dokumente/Steuererklaerung 2025.pdf",
            "folder/file with spaces.txt",
        )
        for (name in filenames) {
            val encrypted = encryptMetadata(key, name)
            val recovered = decryptMetadata(key, encrypted.nonce, encrypted.ciphertext)
            assertEquals("metadata roundtrip failed for filename: $name", name, recovered)
        }
    }

    // MARK: - 10. file_request_seal_open (sealed-box / ECIES per request)

    @Test
    fun fileRequestSealOpen() {
        val v = vector(loadRoot(), "file_request_seal_open")
        val masterKey = v.getString("master_key_hex").hexToBytes()
        val requestId = v.getString("request_id_hex").hexToBytes()

        val wrapKey = deriveRequestWrapKey(masterKey, requestId)
        assertHexEquals("file_request: wrap key mismatch", v.getString("expected_wrap_key_hex"), wrapKey)

        val rPub = deriveX25519Public(v.getString("r_priv_hex").hexToBytes())
        assertHexEquals("file_request: r_pub mismatch", v.getString("r_pub_hex"), rPub)

        val recoveredPriv = unwrapRequestPrivate(
            masterKey,
            requestId,
            v.getString("wrapped_private_hex").hexToBytes(),
            v.getString("wrap_nonce_hex").hexToBytes(),
        )
        assertHexEquals("file_request: unwrapped private key mismatch", v.getString("r_priv_hex"), recoveredPriv)

        val opened = openRequestUpload(
            v.getString("r_priv_hex").hexToBytes(),
            v.getString("e_pub_hex").hexToBytes(),
            v.getString("file_id_hex").hexToBytes(),
            v.getString("wrapped_key_hex").hexToBytes(),
        )
        assertHexEquals("file_request: opened content key mismatch", v.getString("content_key_hex"), opened)
    }
}
