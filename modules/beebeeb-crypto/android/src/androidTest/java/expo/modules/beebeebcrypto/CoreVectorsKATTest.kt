package expo.modules.beebeebcrypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
import uniffi.beebeeb_uniffi.MasterKeyHandle
import uniffi.beebeeb_uniffi.FileKeyHandle
import uniffi.beebeeb_uniffi.ChunkDecryptorHandle
import uniffi.beebeeb_uniffi.OwnerKeyConvention

/**
 * Android half of the core known-answer-vector gate (task 1683, mirroring the
 * iOS `CoreVectorsKATTests.swift` from task 1382). Drives `beebeeb-core`'s
 * cross-platform vectors (`test-vectors/vectors.json`, v13, 37 families through
 * the SAME production UniFFI Kotlin bindings the app links — the generated
 * `uniffi.beebeeb_uniffi` sources and the deployed `libbeebeeb_uniffi.so`).
 *
 * Run: `./android/gradlew -p android :beebeeb-crypto:connectedDebugAndroidTest`
 * with the device attached. On failure of the binding to initialize, this suite
 * surfaces the UniFFI API-checksum exception directly (that is the M0 gate for
 * the pinning decision in the design spec — UniFFI 0.31.1).
 *
 * ## Refreshing the vendored vector file
 * `src/androidTest/assets/core-vectors.json` is a vendored COPY of core's
 * `test-vectors/vectors.json`; the filename is stable and [EXPECTED_VERSION] plus
 * [EXPECTED_SHA256] guard its content. From the mobile repo root:
 * 1. `git -C ../core show $(cat modules/beebeeb-crypto/CORE_REV):test-vectors/vectors.json`
 *    > `modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.json`, then copy that
 *    same file to `targets/native-tests/Vectors/core-vectors.json`.
 * 2. `shasum -a 256` the new copy and update [EXPECTED_SHA256] (see the task file).
 * 3. If core bumped the version, update [EXPECTED_VERSION] and [EXPECTED_FAMILY_ROW_COUNTS].
 *    `src/lib/1943-core-vectors-v13.guard.test.ts` pins the same bytes, version and row counts
 *    and compares this table with the TS one.
 *
 * ## Families decrypted here, and the ones only counted
 * All 37 families are required by name with their row count in [vectorsFileIntegrity]. 22 are
 * decrypted or derived through the binding: `file_key_derivation`, `chunk_encrypt_decrypt`,
 * `x25519_identity_keypair`, `x25519_share_key_exchange`, `recovery_check`,
 * `metadata_encrypt_decrypt`, `file_request_seal_open`, `chunk_v2_stream`,
 * `chunk_v2_single_frame`, `metadata_v2_name`, `metadata_v2_name_filekey`,
 * `metadata_v1_name_filekey`, `folder_key_id`, `key_wrap_v1`, `folder_link_passphrase`,
 * `folder_link_passphrase_nfd`, `folder_custody_v1`, `link_owner_key_v1`,
 * `link_owner_token_v1`, `folder_child_file_v1`, `folder_child_folder_v1` and
 * `owner_wrapped_file_key`. The other 9 are only counted:
 * - `master_key_from_password`, `recovery_phrase_roundtrip`: Argon2id (256 MiB / 4 iter) —
 *   deliberately excluded from the emulator smoke because of device runtime; add with
 *   generous timeouts when the suite is promoted to a full mirror of the iOS gate.
 * - `envelope_serialization`: not exposed by UniFFI (same skip as iOS).
 * - `share_key_wrap`, `thumbnail_encrypt`: their decrypt primitives need the exact call mapping
 *   confirmed (AES-GCM key/nonce/ciphertext shapes differ from `decryptChunk` inputs); add with
 *   the full mirror.
 * - `shared_folder_index_key`, `combine_folder_link_key`,
 *   `owner_wrapped_folder_key`, `folder_wrapped_file_key`: no mobile reader uses them yet.
 */
@RunWith(AndroidJUnit4::class)
class CoreVectorsKATTest {

    companion object {
        /** `sha256sum` of the vendored asset (v13, matching merged core f8ee8e4). */
        private const val EXPECTED_SHA256 =
            "71fb633774fcb13d7cca0613603282ea47ab77e265abd09b3a2ec189689c1464"
        private const val EXPECTED_VERSION = 13

        /**
         * Every family core ships at this revision with the number of rows it carries — 37 families,
         * 37 rows. The row count is asserted, not just presence: a truncated or half-refreshed asset
         * would otherwise pass. `envelope_serialization` is present here but is an explicit skip on
         * both platforms (no UniFFI export), same as before.
         */
        private val EXPECTED_FAMILY_ROW_COUNTS = linkedMapOf(
            "master_key_from_password" to 1,
            "file_key_derivation" to 1,
            "chunk_encrypt_decrypt" to 1,
            "x25519_identity_keypair" to 1,
            "x25519_share_key_exchange" to 1,
            "recovery_check" to 1,
            "envelope_serialization" to 1,
            "recovery_phrase_roundtrip" to 1,
            "metadata_encrypt_decrypt" to 1,
            "file_request_seal_open" to 1,
            "share_key_wrap" to 1,
            "thumbnail_encrypt" to 1,
            "chunk_v2_stream" to 1,
            "chunk_v2_single_frame" to 1,
            "metadata_v2_name" to 1,
            "metadata_v2_name_filekey" to 1,
            "metadata_v1_name_filekey" to 1,
            "folder_key_id" to 1,
            "shared_folder_index_key" to 1,
            "combine_folder_link_key" to 1,
            "key_wrap_v1" to 1,
            "folder_link_passphrase" to 1,
            "folder_link_passphrase_nfd" to 1,
            "invite_owner_copy_v1" to 1,
            "folder_custody_v1" to 1,
            "link_owner_key_v1" to 1,
            "link_owner_token_v1" to 1,
            "folder_child_file_v1" to 1,
            "folder_child_folder_v1" to 1,
            "owner_wrapped_file_key" to 1,
            "owner_wrapped_folder_key" to 1,
            "folder_wrapped_file_key" to 1,
            "upper_repair_v1" to 1,
            "upper_repair_split_v1" to 1,
            "client_meta_device_hostname" to 1,
            "client_meta_session_paths" to 1,
            "client_meta_padding_buckets" to 1,
        )

        /**
         * The chunk-v2 families, in one place: the positive test and the [v2DecryptRefusesAnotherVersionId]
         * negative both iterate this, so adding a family cannot leave the negative one family behind.
         */
        private val CHUNK_V2_FAMILIES = listOf("chunk_v2_single_frame", "chunk_v2_stream")

        /** The name families, each decrypted by a different reader (see `assertNameFamilyDecrypts`). */
        private val NAME_FAMILIES =
            listOf("metadata_v2_name", "metadata_v2_name_filekey", "metadata_v1_name_filekey")

        /**
         * One parse of a chunk-v2 family, shared by the positive decrypt test and the version-id
         * negative so the two cannot drift apart in how they read the fixture.
         */
        private fun chunkV2Fixture(name: String): ChunkV2Fixture {
            val v = vector(loadRoot(), name)
            return ChunkV2Fixture(
                vector = v,
                fileId = v.getString("file_id"),
                versionId = v.getString("version_id_hex").hexToBytes(),
                fileKey = FileKeyHandle.fromKeyBytes(v.getString("file_key_hex").hexToBytes()),
                frames = v.getJSONArray("frames"),
            )
        }

        private fun loadRoot(): JSONObject {
            val assets = InstrumentationRegistry.getInstrumentation().context.assets
            val bytes = assets.open("core-vectors.json").readBytes()
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            val hex = digest.joinToString("") { "%02x".format(it) }
            assertEquals(
                "vendored core-vectors.json drifted from the pinned sha256 — see this file's header",
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
            throw AssertionError("vector '$name' not found in core-vectors.json")
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
        val counts = mutableMapOf<String, Int>()
        val vectors = root.getJSONArray("vectors")
        for (i in 0 until vectors.length()) {
            val name = vectors.getJSONObject(i).getString("name")
            counts[name] = (counts[name] ?: 0) + 1
        }
        for ((family, rows) in EXPECTED_FAMILY_ROW_COUNTS) {
            assertEquals(
                "vectors.json family '$family' row count mismatch",
                rows,
                counts[family] ?: 0,
            )
        }
        assertEquals(
            "vectors.json carries a family this KAT does not assert by name",
            EXPECTED_FAMILY_ROW_COUNTS.keys,
            counts.keys,
        )
        assertEquals(
            "vectors.json total row count mismatch",
            EXPECTED_FAMILY_ROW_COUNTS.values.sum(),
            vectors.length(),
        )
    }

    // MARK: - 21/22. The 1908 chunk and name families, decrypted through the binding

    /**
     * `chunk_v2_stream` and `chunk_v2_single_frame`: the sequential reader under the V2 pin
     * reproduces the published plaintext and finishes on the last frame, and every frame also
     * opens on its own through the random-access reader at its published index. A wrong key,
     * nonce, index or format fails here.
     */
    @Test
    fun chunkV2FamiliesDecryptThroughTheBinding() {
        // Each family is isolated: collect a failure per family and assert once at the end, so
        // an exception in the first family (round 4: the binding threw "Decryption") still lets
        // the second family run and every failure names its family and exception type.
        val failures = mutableListOf<String>()
        for (name in CHUNK_V2_FAMILIES) {
            try {
                assertChunkV2FamilyDecrypts(name)
            } catch (t: Throwable) {
                failures += "$name: ${t.javaClass.simpleName}: ${t.message.orEmpty()}"
            }
        }
        assertTrue(
            "chunk v2 families failed (each family isolated; all were attempted):\n" +
                failures.joinToString("\n"),
            failures.isEmpty(),
        )
    }

    private fun assertChunkV2FamilyDecrypts(name: String) {
        val fixture = chunkV2Fixture(name)
        val master = MasterKeyHandle.fromKeychainBytes(fixture.vector.getString("master_key_hex").hexToBytes())
        val frames = fixture.frames
        assertEquals("$name: frame count", fixture.chunkCount, frames.length())

        val decryptor = ChunkDecryptorHandle.forPush(master, fixture.fileId, 2u)
        val streamed = java.io.ByteArrayOutputStream()
        for (position in 0 until frames.length()) {
            val frame = frames.getJSONObject(position)
            val frameData = frame.getString("frame_hex").hexToBytes()
            val index = frame.getInt("index")
            val isLast = frame.getBoolean("is_last")
            assertEquals("$name: frames must be ordered by index", position, index)
            val opened = decryptor.pushFrame(frameData)
            assertEquals("$name: pushed frame index", index.toUInt(), opened.index)
            streamed.write(opened.data)
            val randomAccess = fixture.fileKey.decryptChunkFrame(
                fixture.fileId, fixture.versionId, index.toUInt(), isLast, 2u, frameData)
            assertHexEquals("$name: frame $index random access", frame.getString("plaintext_hex"), randomAccess)
        }
        // `finish()` takes the handle's state, so `versionId()` MUST be read FIRST (as Swift
        // does): after `finish()` every call throws "handle has been cleared".
        val actualVersionId = decryptor.versionId()
        assertNotNull("$name: version id is null after the frames", actualVersionId)
        assertHexEquals("$name: version id after the frames", fixture.vector.getString("version_id_hex"), actualVersionId!!)
        val summary = decryptor.finish()
        assertEquals("$name: detected format", 2, summary.format.toInt())
        assertEquals("$name: finished chunk count", frames.length().toUInt(), summary.chunkCount)
        assertHexEquals("$name: streamed plaintext", fixture.plaintextHex, streamed.toByteArray())
        println("[CoreVectorsKAT] $name: 1 row (streamed + per-frame open)")
    }

    /**
     * The AAD version binding as a negative: for every V2 family, frame 0 opens under the
     * vector's own version id and MUST be refused when one bit of that id flips. Isolated the
     * same way as the positive test, so each family's result is reported separately.
     */
    @Test
    fun v2DecryptRefusesAnotherVersionId() {
        val failures = mutableListOf<String>()
        for (name in CHUNK_V2_FAMILIES) {
            try {
                assertV2RefusesAnotherVersionId(name)
            } catch (t: Throwable) {
                failures += "$name: ${t.javaClass.simpleName}: ${t.message.orEmpty()}"
            }
        }
        assertTrue(
            "chunk v2 versionId negatives failed (each family isolated; all were attempted):\n" +
                failures.joinToString("\n"),
            failures.isEmpty(),
        )
    }

    private fun assertV2RefusesAnotherVersionId(name: String) {
        val fixture = chunkV2Fixture(name)
        assertTrue("$name: version_id_hex must not be empty", fixture.versionId.isNotEmpty())
        val frame = fixture.frames.getJSONObject(0)
        val frameData = frame.getString("frame_hex").hexToBytes()
        val index = frame.getInt("index")
        val isLast = frame.getBoolean("is_last")

        val otherVersionId = fixture.versionId.copyOf()
        otherVersionId[0] = (otherVersionId[0].toInt() xor 0x01).toByte()
        assertFalse("$name: the negative version id must differ in one bit", otherVersionId.contentEquals(fixture.versionId))

        // Positive control: the vector's own version id opens frame 0.
        val opened = fixture.fileKey.decryptChunkFrame(fixture.fileId, fixture.versionId, index.toUInt(), isLast, 2u, frameData)
        assertHexEquals("$name: frame 0 opens under the vector version id", frame.getString("plaintext_hex"), opened)

        // Negative: the same frame under a one-bit-different version id must throw.
        assertThrows(Exception::class.java) {
            fixture.fileKey.decryptChunkFrame(fixture.fileId, otherVersionId, index.toUInt(), isLast, 2u, frameData)
        }
    }

    /**
     * The two negatives the iOS KAT has. A V2 stream that stops before its authenticated last
     * frame must refuse promotion at `finish()`, and a legacy V1 frame replayed under the V2
     * pin must be refused at `pushFrame()` — the pin is authenticated, not advisory.
     */
    @Test
    fun truncatedV2StreamRejectsMissingLastFrame() {
        val v = vector(loadRoot(), "chunk_v2_stream")
        val key = FileKeyHandle.fromKeyBytes(v.getString("file_key_hex").hexToBytes())
        val decryptor = ChunkDecryptorHandle.forPushWithFileKeyHandle(key, v.getString("file_id"), 2u)
        val frames = v.getJSONArray("frames")
        assertEquals("chunk_v2_stream: frame count", 3, frames.length())
        for (position in 0 until 2) {
            val frame = frames.getJSONObject(position)
            val opened = decryptor.pushFrame(frame.getString("frame_hex").hexToBytes())
            assertEquals("chunk_v2_stream: opened frame size", 32, opened.data.size)
        }
        assertThrows(Exception::class.java) { decryptor.finish() }
    }

    @Test
    fun v1FrameIsRefusedUnderTheV2Pin() {
        val v = vector(loadRoot(), "chunk_v2_single_frame")
        val key = FileKeyHandle.fromKeyBytes(v.getString("file_key_hex").hexToBytes())
        val fileId = v.getString("file_id")
        // The v1 wire comes from the production wire helper, not hand-assembled bytes.
        val wire = SharedKeyOps.wire(key.encryptChunk("replayed v1".toByteArray()))
        val v2 = ChunkDecryptorHandle.forPushWithFileKeyHandle(key, fileId, 2u)
        assertThrows(Exception::class.java) { v2.pushFrame(wire) }
        // Positive control: the SAME wire opens under the v1 pin 0 — so the refusal above is the
        // pin, not the frame being malformed.
        val v1 = ChunkDecryptorHandle.forPushWithFileKeyHandle(key, fileId, 0u)
        assertTrue(v1.pushFrame(wire).data.contentEquals("replayed v1".toByteArray()))
    }

    /**
     * `metadata_v2_name` through the master-key name reader, and the two per-file-key name
     * vectors through the file-key reader: name, MIME type and the returned pin must match the
     * vector. The pin is what every later content reader of that file must use.
     */
    @Test
    fun nameFamiliesDecryptThroughTheBinding() {
        // Each family is isolated (its own try/catch) and only prints its row line once every
        // assertion in it held, so a failed family can never be logged as a pass.
        val failures = mutableListOf<String>()
        for (name in NAME_FAMILIES) {
            try {
                assertNameFamilyDecrypts(name)
            } catch (t: Throwable) {
                failures += "$name: ${t.javaClass.simpleName}: ${t.message.orEmpty()}"
            }
        }
        assertTrue(
            "name families failed (each family isolated; all were attempted):\n" +
                failures.joinToString("\n"),
            failures.isEmpty(),
        )
    }

    private fun assertNameFamilyDecrypts(name: String) {
        val v = vector(loadRoot(), name)
        val expectedName = v.getString("expected_name")
        val expectedMime = v.getString("expected_mime_type")
        val expectedPin = v.getInt("expected_chunk_format").toUByte()
        if (name == "metadata_v2_name") {
            val master = MasterKeyHandle.fromKeychainBytes(v.getString("master_key_hex").hexToBytes())
            val meta = master.decryptFileMetadata(
                v.getString("file_id"), v.getString("name_encrypted"))
            assertEquals("$name: name", expectedName, meta.name)
            assertEquals("$name: mime", expectedMime, meta.mimeType)
            assertEquals("$name: pin", expectedPin, meta.chunkFormat)
            println("[CoreVectorsKAT] $name: 1 row (master-key name reader)")
        } else {
            val meta = FileKeyHandle.fromKeyBytes(v.getString("file_key_hex").hexToBytes())
                .decryptFileMetadata(v.getString("name_encrypted"))
            assertEquals("$name: name", expectedName, meta.name)
            assertEquals("$name: mime", expectedMime, meta.mimeType)
            assertEquals("$name: pin", expectedPin, meta.chunkFormat)
            println("[CoreVectorsKAT] $name: 1 row (file-key name reader)")
        }
    }

    // MARK: - SF-0002 owner resolvers

    /**
     * `upper_repair_v1` through the real binding: the owner resolver reports the uppercase repair
     * convention and its key opens both the sealed name and the single content version.
     */
    @Test
    fun upperRepairNameAndContentResolveThroughTheBinding() {
        val v = vector(loadRoot(), "upper_repair_v1")
        val master = MasterKeyHandle.fromKeychainBytes(v.getString("master_key_hex").hexToBytes())
        val fileId = v.getString("file_id")
        val nameEncrypted = v.getString("name_encrypted")

        val nameResolved = master.ownerFileKeyForName(fileId, nameEncrypted)
        assertEquals("upper_repair_v1: name convention", OwnerKeyConvention.UPPER_REPAIR, nameResolved.convention)
        val meta = nameResolved.key.decryptFileMetadata(nameEncrypted)
        assertEquals("upper_repair_v1: name", v.getString("expected_name"), meta.name)
        assertEquals("upper_repair_v1: mime", v.getString("expected_mime_type"), meta.mimeType)

        val frame = v.getString("content_frame_hex").hexToBytes()
        val contentResolved = master.ownerFileKeyForContent(fileId, frame)
        assertEquals(
            "upper_repair_v1: content convention",
            OwnerKeyConvention.UPPER_REPAIR,
            contentResolved.convention,
        )
        val plaintext = contentResolved.key.decryptChunk(
            frame.copyOfRange(0, 12), frame.copyOfRange(12, frame.size))
        assertHexEquals("upper_repair_v1: plaintext", v.getString("content_plaintext_hex"), plaintext)
        println("[CoreVectorsKAT] upper_repair_v1: 1 row (owner resolver)")
    }

    /**
     * `upper_repair_split_v1`: the name and version 1 resolve under the uppercase repair
     * convention, version 2 under the canonical string convention, and the name's key does not
     * open version 2.
     */
    @Test
    fun splitUpperRepairResolvesEachVersionIndependently() {
        val v = vector(loadRoot(), "upper_repair_split_v1")
        val master = MasterKeyHandle.fromKeychainBytes(v.getString("master_key_hex").hexToBytes())
        val fileId = v.getString("file_id")
        val nameEncrypted = v.getString("name_encrypted")

        val nameResolved = master.ownerFileKeyForName(fileId, nameEncrypted)
        assertEquals(
            "upper_repair_split_v1: name convention",
            OwnerKeyConvention.UPPER_REPAIR,
            nameResolved.convention,
        )
        assertEquals(
            "upper_repair_split_v1: name",
            v.getString("expected_name"),
            nameResolved.key.decryptFileMetadata(nameEncrypted).name,
        )

        val v1Frame = v.getString("content_v1_frame_hex").hexToBytes()
        val v1Resolved = master.ownerFileKeyForContent(fileId, v1Frame)
        assertEquals(
            "upper_repair_split_v1: v1 convention",
            OwnerKeyConvention.UPPER_REPAIR,
            v1Resolved.convention,
        )
        assertHexEquals(
            "upper_repair_split_v1: v1 plaintext",
            v.getString("content_v1_plaintext_hex"),
            v1Resolved.key.decryptChunk(v1Frame.copyOfRange(0, 12), v1Frame.copyOfRange(12, v1Frame.size)),
        )

        val v2Frame = v.getString("content_v2_frame_hex").hexToBytes()
        val v2Resolved = master.ownerFileKeyForContent(fileId, v2Frame)
        assertEquals(
            "upper_repair_split_v1: v2 convention",
            OwnerKeyConvention.STRING,
            v2Resolved.convention,
        )
        assertHexEquals(
            "upper_repair_split_v1: v2 plaintext",
            v.getString("content_v2_plaintext_hex"),
            v2Resolved.key.decryptChunk(v2Frame.copyOfRange(0, 12), v2Frame.copyOfRange(12, v2Frame.size)),
        )

        assertThrows(
            "upper_repair_split_v1: version 2 must not open under the name's uppercase key",
            Exception::class.java,
        ) {
            nameResolved.key.decryptChunk(v2Frame.copyOfRange(0, 12), v2Frame.copyOfRange(12, v2Frame.size))
        }
        println("[CoreVectorsKAT] upper_repair_split_v1: 1 row (owner resolver)")
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
    @Test
    fun keyWrapV1() {
        val v = vector(loadRoot(), "key_wrap_v1")
        val wrapper = FileKeyHandle.fromKeyBytes(v.getString("wrapper_key_hex").hexToBytes())
        val wire = v.getString("wrapped_hex").hexToBytes()
        val opened = wrapper.unwrapKey(wire.copyOfRange(0, 12), wire.copyOfRange(12, wire.size))
        val expected = FileKeyHandle.fromKeyBytes(v.getString("inner_key_hex").hexToBytes())
        assertTrue(opened.keyId().contentEquals(expected.keyId()))
        println("[CoreVectorsKAT] key_wrap_v1: 1 row")
    }

    @Test
    fun folderKeyId() {
        val v = vector(loadRoot(), "folder_key_id")
        val key = FileKeyHandle.fromKeyBytes(v.getString("folder_key_hex").hexToBytes())
        assertHexEquals("folder_key_id: key id mismatch", v.getString("expected_key_id_hex"), key.keyId())
        println("[CoreVectorsKAT] folder_key_id: 1 row")
    }

    @Test
    fun folderLinkPassphrase() {
        val v = vector(loadRoot(), "folder_link_passphrase")
        val actual = FileKeyHandle.fromFolderLinkPassphrase(
            v.getString("k_c_hex").hexToBytes(), v.getString("passphrase"), v.getString("token"))
        val expected = FileKeyHandle.fromKeyBytes(v.getString("link_key_hex").hexToBytes())
        assertTrue(actual.keyId().contentEquals(expected.keyId()))
        println("[CoreVectorsKAT] folder_link_passphrase: 1 row")
    }

    @Test
    fun l6PurposeWrapVectors() {
        for (name in listOf("folder_custody_v1", "link_owner_key_v1", "link_owner_token_v1")) {
            val v = vector(loadRoot(), name)
            val master = MasterKeyHandle.fromKeychainBytes(v.getString("master_key_hex").hexToBytes())
            val wire = v.getString("wrapped_hex").hexToBytes()
            val id = v.getString("record_id")
            val nonce = wire.copyOfRange(0, 12)
            val ct = wire.copyOfRange(12, wire.size)
            val plain = v.getString("plaintext_hex").hexToBytes()
            when (name) {
                "folder_custody_v1" -> {
                    val opened = master.unwrapFolderCustody(id, nonce, ct)
                    assertTrue(opened.keyId().contentEquals(FileKeyHandle.fromKeyBytes(plain).keyId()))
                    assertThrows(Exception::class.java) { master.unwrapFolderCustody(id + "wrong", nonce, ct) }
                }
                "link_owner_key_v1" -> {
                    assertTrue(master.unwrapLinkOwnerKey(id, nonce, ct).contentEquals(plain))
                    assertThrows(Exception::class.java) { master.unwrapLinkOwnerToken(id, nonce, ct) }
                }
                else -> assertTrue(master.unwrapLinkOwnerToken(id, nonce, ct).contentEquals(plain))
            }
            println("[CoreVectorsKAT] $name: 1 row")
        }
    }

    @Test
    fun folderLinkPassphraseNfd() {
        val v = vector(loadRoot(), "folder_link_passphrase_nfd")
        val kc = v.getString("k_c_hex").hexToBytes()
        val actual = FileKeyHandle.fromFolderLinkPassphrase(kc, v.getString("passphrase"), v.getString("token"))
        assertTrue(actual.keyId().contentEquals(FileKeyHandle.fromKeyBytes(v.getString("link_key_hex").hexToBytes()).keyId()))
        assertThrows(Exception::class.java) { FileKeyHandle.fromFolderLinkPassphrase(kc, "", v.getString("token")) }
        println("[CoreVectorsKAT] folder_link_passphrase_nfd: 1 row")
    }


    @Test
    fun folderChildVectorsBindEveryContextField() {
        for (name in listOf("folder_child_file_v1", "folder_child_folder_v1")) {
            val v = vector(loadRoot(), name)
            val key = FileKeyHandle.fromKeyBytes(v.getString("folder_key_hex").hexToBytes())
            val wire = v.getString("wrapped_hex").hexToBytes()
            val root = v.getString("shared_folder_id"); val item = v.getString("item_id"); val kind = v.getInt("kind").toUByte()
            val opened = key.unwrapFolderChild(root, item, kind, wire.copyOfRange(0,12), wire.copyOfRange(12,wire.size))
            assertTrue(opened.keyId().contentEquals(FileKeyHandle.fromKeyBytes(v.getString("child_key_hex").hexToBytes()).keyId()))
            for ((r,i,k) in listOf(Triple("00000000-0000-4000-8000-000000000099",item,kind), Triple(root,"00000000-0000-4000-8000-000000000099",kind), Triple(root,item,(3-kind.toInt()).toUByte()))) {
                assertThrows(Exception::class.java) { key.unwrapFolderChild(r,i,k,wire.copyOfRange(0,12),wire.copyOfRange(12,wire.size)) }
            }
            println("[CoreVectorsKAT] $name: 1 row")
        }
    }

    @Test
    fun ownerWrapRejectsOwnV1Content() {
        MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 }).use { master ->
            val id = "11111111-1111-4111-8111-111111111111"
            val registry = SharedKeyRegistry<FileKeyHandle> { it.close() }
            try {
                val frame = master.deriveFileKey(id.toByteArray()).use { derived ->
                    SharedKeyOps.wire(derived.encryptChunk(ByteArray(32) { 0x55 }))
                }
                assertEquals(60, frame.size)
                assertFalse(SharedKeyOps.openOwnerFileKey(master, id, frame, registry))
                assertNull(registry.file(id))
            } finally { registry.clear() }
        }
    }

    @Test
    fun ownerWrapRejectsLegacyNameEnvelope() {
        MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 }).use { master ->
            val id = "11111111-1111-4111-8111-111111111111"
            val registry = SharedKeyRegistry<FileKeyHandle> { it.close() }
            try {
                val blob = JSONObject(master.encryptName(id, "test", null))
                fun bytes(name: String): ByteArray {
                    val array = blob.getJSONArray(name)
                    return ByteArray(array.length()) { array.getInt(it).toByte() }
                }
                val frame = bytes("nonce") + bytes("ciphertext")
                assertEquals(60, frame.size)
                assertFalse(SharedKeyOps.openOwnerFileKey(master, id, frame, registry))
                assertNull(registry.file(id))
            } finally { registry.clear() }
        }
    }

    @Test
    fun l8OwnerWrapVectorAndAdoption() {
        val v = vector(loadRoot(), "owner_wrapped_file_key")
        MasterKeyHandle.fromKeychainBytes(v.getString("master_key_hex").hexToBytes()).use { master ->
            val id = v.getString("file_id")
            val registry = SharedKeyRegistry<FileKeyHandle> { it.close() }
            FileKeyHandle.fromKeyBytes(v.getString("child_key_hex").hexToBytes()).use { expected ->
                try {
                    assertTrue(SharedKeyOps.openOwnerFileKey(master, id, v.getString("expected_frame_hex").hexToBytes(), registry))
                    assertTrue(expected.keyId().contentEquals(registry.file(id)!!.keyId()))
                    val adopted = SharedKeyOps.adoptWrap(master, id, registry)
                    assertEquals(60, adopted.size)
                    registry.clear()
                    assertTrue(SharedKeyOps.openOwnerFileKey(master, id, adopted, registry))
                    assertTrue(expected.keyId().contentEquals(registry.file(id)!!.keyId()))
                    assertFalse(SharedKeyOps.openOwnerFileKey(master, "22222222-2222-4222-8222-222222222222", adopted, registry))
                    val corrupt = adopted.copyOf()
                    corrupt[corrupt.lastIndex] = (corrupt.last().toInt() xor 1).toByte()
                    assertFalse(SharedKeyOps.openOwnerFileKey(master, id, corrupt, registry))
                    assertTrue(expected.keyId().contentEquals(registry.file(id)!!.keyId()))
                } finally { registry.clear() }
            }
        }
    }

    @Test
    fun sharedKeyOpsRoundTrip() {
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val folder = SharedKeyOps.generateFolderKey(master, "2237c000-0000-4000-8000-000000000001", registry)
        val opened = SharedKeyOps.openOwnerFolderKey(master, "2237c000-0000-4000-8000-000000000001", folder.second, registry)
        val rows = SharedKeyOps.wrapChildKeys(master, opened, listOf("2237c000-0000-4000-8000-000000000002"), registry)
        val loaded = SharedKeyOps.loadFileKeys(opened, rows + SharedKeyEntryNative("bad", byteArrayOf(), 1), registry)
        assertEquals(listOf("2237c000-0000-4000-8000-000000000002"), loaded.first)
        assertEquals(listOf("bad"), loaded.second)
        val encrypted = master.deriveFileKey("2237c000-0000-4000-8000-000000000002".toByteArray()).encryptChunk("round trip".toByteArray())
        assertTrue(SharedKeyOps.fileKey(master, "2237c000-0000-4000-8000-000000000002", registry).decryptChunk(encrypted.nonce, encrypted.ciphertext).contentEquals("round trip".toByteArray()))
        val adopted = SharedKeyOps.adoptWrap(master, "2237c000-0000-4000-8000-000000000002", registry)
        assertTrue(SharedKeyOps.openOwnerFileKey(master, "2237c000-0000-4000-8000-000000000002", adopted, registry))
    }

    @Test
    fun mintLinkMatchesTheVector() {
        val v = vector(loadRoot(), "folder_link_passphrase")
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val folder = SharedKeyOps.generateFolderKey(master, "root", registry)
        val token = v.getString("token")
        val passphrase = v.getString("passphrase")
        val minted = SharedKeyOps.mintLink(master, folder.first, token, passphrase, "share", registry)
        val kc = java.util.Base64.getUrlDecoder().decode(minted.kc)
        val link = FileKeyHandle.fromFolderLinkPassphrase(kc, passphrase, token)
        assertTrue(openWrap(link, minted.wrappedFolderKey).keyId().contentEquals(registry.folder(folder.first)!!.handle.keyId()))
        assertEquals(minted.kc, SharedKeyOps.recoverKc(master, folder.first, minted.ownerWrappedKey, "share", registry))
        assertNull(SharedKeyOps.recoverKc(master, folder.first, minted.ownerWrappedKey, "wrong", registry))
        assertThrows(Exception::class.java) { SharedKeyOps.mintLink(master, folder.first, token, "", "share", registry) }
    }

    @Test
    fun recoverKcRefusesTheFolderKeyWrap() {
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val folder = SharedKeyOps.generateFolderKey(master, "root", registry)
        val key = registry.folder(folder.first)!!.handle
        val wrong = SharedKeyOps.wire(master.wrapLinkOwnerKey("share", key))
        assertNull(SharedKeyOps.recoverKc(master, folder.first, wrong, "share", registry))
        assertNull(SharedKeyOps.recoverKc(master, folder.first, SharedKeyOps.wire(master.wrapKey(key)), "share", registry))
    }

    @Test
    fun decryptNamesPrefersTheTableKey() {
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val key = FileKeyHandle.generate()
        val name = key.encryptNameFor("guest.txt", "text/plain", 0u)
        val items = listOf(uniffi.beebeeb_uniffi.BatchNameItem("2237c000-0000-4000-8000-000000000002", name))
        assertNotNull(SharedKeyOps.decryptNames(master, items, registry)[0].error)
        val folder = SharedKeyOps.generateFolderKey(master, "2237c000-0000-4000-8000-000000000001", registry)
        val wrapped = SharedKeyOps.wire(registry.folder(folder.first)!!.handle.wrapFolderChild("2237c000-0000-4000-8000-000000000001", "2237c000-0000-4000-8000-000000000002", 1u, key))
        SharedKeyOps.loadFileKeys(folder.first, listOf(SharedKeyEntryNative("2237c000-0000-4000-8000-000000000002", wrapped, 1)), registry)
        val opened = SharedKeyOps.decryptNames(master, items, registry)
        assertEquals("guest.txt", opened[0].name)
        assertEquals("text/plain", opened[0].mimeType)
        assertNull(opened[0].error)
        val ownerName = master.encryptName("2237c000-0000-4000-8000-000000000002", "owner", null)
        assertNotNull(SharedKeyOps.decryptNames(master, listOf(uniffi.beebeeb_uniffi.BatchNameItem("2237c000-0000-4000-8000-000000000002", ownerName)), registry)[0].error)
    }

    @Test
    fun childPublicationPreservesLoadedRandomKeysForBothKinds() {
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val root = "2237c000-0000-4000-8000-000000000001"
        val folder = SharedKeyOps.generateFolderKey(master, root, registry)
        for (kind in listOf(1, 2)) {
            val id = "2237c000-0000-4000-8000-000000000002"
            val real = FileKeyHandle.generate()
            registry.storeFile(id, real)
            val wire = SharedKeyOps.wrapChildKeys(master, folder.first, listOf(id), registry, kind)[0].wrapped
            val opened = registry.folder(folder.first)!!.handle.unwrapFolderChild(root, id, kind.toUByte(), wire.copyOfRange(0, 12), wire.copyOfRange(12, wire.size))
            assertTrue(opened.keyId().contentEquals(real.keyId()))
            assertFalse(opened.keyId().contentEquals(master.deriveFileKey(id.toByteArray()).keyId()))
            val frame = real.encryptChunk("moved guest".toByteArray())
            assertTrue(opened.decryptChunk(frame.nonce, frame.ciphertext).contentEquals("moved guest".toByteArray()))
        }
    }

    @Test
    fun registryReleaseReplaceAndClearDestroyNativeHandles() {
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val folder = FileKeyHandle.generate()
        val folderId = registry.storeFolder(folder, "root")
        registry.releaseFolder(folderId)
        assertThrows(IllegalStateException::class.java) { folder.keyId() }
        val old = FileKeyHandle.generate(); val replacement = FileKeyHandle.generate()
        registry.storeFile("file", old); registry.storeFile("file", replacement)
        assertThrows(IllegalStateException::class.java) { old.keyId() }
        assertEquals(32, replacement.keyId().size)
        registry.clear()
        assertThrows(IllegalStateException::class.java) { replacement.keyId() }
    }

    @Test
    fun borrowedPreviewKeySurvivesTwoReads() {
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val key = FileKeyHandle.generate()
        registry.storeFile("guest", key)
        val frame = key.encryptChunk("guest frame".toByteArray())
        repeat(2) {
            SharedKeyOps.borrowFileKey(master, "guest", registry).use { access ->
                assertFalse(access.owned)
                assertSame(key, access.handle)
                assertTrue(access.handle.decryptChunk(frame.nonce, frame.ciphertext).contentEquals("guest frame".toByteArray()))
            }
            assertTrue(registry.file("guest")!!.keyId().contentEquals(key.keyId()))
        }
    }

    @Test
    fun chunkDecryptorUsesTheFileKeyHandle() {
        val master = MasterKeyHandle.fromKeychainBytes(ByteArray(32) { 0x40 })
        val registry = SharedKeyRegistry<FileKeyHandle>()
        val key = FileKeyHandle.generate()
        registry.storeFile("guest", key)
        val frame = key.encryptChunk("guest frame".toByteArray())
        assertTrue(SharedKeyOps.fileKey(master, "guest", registry).decryptChunk(frame.nonce, frame.ciphertext).contentEquals("guest frame".toByteArray()))
    }

  /** Test-only 60-byte wrap opener (nonce(12) || ciphertext(48)) for link-wrap vectors. Production code
   *  has no generic opener: every wrap is opened by a purpose-bound core function. */
  private fun openWrap(wrapper: FileKeyHandle, wrapped: ByteArray): FileKeyHandle {
    assertEquals(60, wrapped.size)
    return wrapper.unwrapKey(wrapped.copyOfRange(0, 12), wrapped.copyOfRange(12, wrapped.size))
  }
}

/** One parse of a chunk-v2 family, shared by the positive decrypt test and the version-id negative. */
private class ChunkV2Fixture(
    val vector: JSONObject,
    val fileId: String,
    val versionId: ByteArray,
    val fileKey: FileKeyHandle,
    val frames: JSONArray,
) {
    val chunkCount: Int get() = vector.getInt("chunk_count")
    val plaintextHex: String get() = vector.getString("plaintext_hex")
}
