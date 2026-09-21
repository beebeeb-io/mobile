import XCTest
import CryptoKit

/// Task 1382 (audit item K2) — mobile half. Drives `beebeeb-core`'s cross-platform known-answer
/// vectors (`test-vectors/vectors.json`, v4, 12 families) through the SAME production UniFFI Swift
/// bindings the app links (`modules/beebeeb-crypto/ios/beebeeb_uniffi.swift`, compiled directly into
/// this target's Sources build phase — see the `CoreVectorsKATTests` target in `Beebeeb.xcodeproj`,
/// mirroring the host-less `ProvenanceHeadersTests` target added in task 1439). No app host, no
/// Pods, no Expo — this is deliberately the smallest possible harness that still exercises the real
/// linked `.a` (not a mock). Semantic reference for what each family proves:
/// `repos/core/beebeeb-core/tests/cross_platform_vectors.rs`.
///
/// Run: `scripts/kat-ios.sh` (wraps the `xcodebuild test -scheme CoreVectorsKATTests` invocation
/// under the shared `ios-build` semaphore, on `bb-qa-2` only). This is a LOCAL gate — the mobile
/// repo's GitHub Actions workflow runs `typecheck` only; macOS runners are not enabled for Actions
/// minutes reasons, so this suite does NOT run in CI. See `CLAUDE.md` "Tests" section.
///
/// ## Refreshing the vendored vector file
/// `Vectors/core-vectors.v4.json` is a vendored COPY of `repos/core/test-vectors/vectors.json` — it
/// has to be a copy (not a symlink out of the repo) so this xctest bundle can embed it as a Resource.
/// To refresh after core bumps the vector file:
/// 1. `cp ../../core/test-vectors/vectors.json ios/BeebeebNativeTests/Vectors/core-vectors.v4.json`
///    (run from the mobile repo's `ios/` directory in the standard `<workspace>/repos/{core,mobile}`
///    layout — NOT from an isolated `git worktree`, which has no sibling `repos/core` checkout).
/// 2. `shasum -a 256 ios/BeebeebNativeTests/Vectors/core-vectors.v4.json` and paste the new hex into
///    `expectedSha256Hex` below.
/// 3. If core bumped `version`, update `expectedVersion` and `requiredVectorNames` here to match
///    `vector_file_version_check` in `cross_platform_vectors.rs`.
/// 4. Re-run this target; `testVendoredVectorsShaPin` enforces the new pin, and every family test
///    re-validates against the refreshed data automatically (no other code change needed).
final class CoreVectorsKATTests: XCTestCase {

    // MARK: - Pin

    /// `shasum -a 256 repos/core/test-vectors/vectors.json` (v4, 2026-09-22).
    private static let expectedSha256Hex =
        "a8f5320a0dbd06fa3a26ede7109f3c24295197061f13f81519c010b30157f6e5"
    private static let expectedVersion = 4
    private static let requiredVectorNames = [
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
    ]

    // MARK: - Vector loading

    private static func bundledVectorsURL() throws -> URL {
        guard let url = Bundle(for: CoreVectorsKATTests.self)
            .url(forResource: "core-vectors.v4", withExtension: "json") else {
            throw NSError(
                domain: "CoreVectorsKATTests", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "core-vectors.v4.json missing from test bundle resources"]
            )
        }
        return url
    }

    private static func loadVectorsData() throws -> Data {
        try Data(contentsOf: try bundledVectorsURL())
    }

    private static func loadRoot() throws -> [String: Any] {
        let data = try loadVectorsData()
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "CoreVectorsKATTests", code: 2,
                           userInfo: [NSLocalizedDescriptionKey: "core-vectors.v4.json did not decode to an object"])
        }
        return root
    }

    private static func loadVectors() throws -> [[String: Any]] {
        guard let vectors = try loadRoot()["vectors"] as? [[String: Any]] else {
            throw NSError(domain: "CoreVectorsKATTests", code: 3,
                           userInfo: [NSLocalizedDescriptionKey: "core-vectors.v4.json 'vectors' is not an array"])
        }
        return vectors
    }

    private static func vector(_ vectors: [[String: Any]], named name: String) throws -> [String: Any] {
        guard let v = vectors.first(where: { $0["name"] as? String == name }) else {
            throw NSError(domain: "CoreVectorsKATTests", code: 4,
                           userInfo: [NSLocalizedDescriptionKey: "vector '\(name)' not found in vectors.json"])
        }
        return v
    }

    private static func str(_ v: [String: Any], _ field: String) throws -> String {
        guard let s = v[field] as? String else {
            throw NSError(domain: "CoreVectorsKATTests", code: 5,
                           userInfo: [NSLocalizedDescriptionKey: "field '\(field)' missing or not a string"])
        }
        return s
    }

    private static func hex(_ v: [String: Any], _ field: String) throws -> Data {
        guard let data = Data(hexString: try str(v, field)) else {
            throw NSError(domain: "CoreVectorsKATTests", code: 6,
                           userInfo: [NSLocalizedDescriptionKey: "field '\(field)' is not valid hex"])
        }
        return data
    }

    /// `<repo>/ios/BeebeebNativeTests/CoreVectorsKATTests.swift` -> two levels up from `ios/` is
    /// `../../core/test-vectors/vectors.json`, matching the standard `<workspace>/repos/{core,mobile}`
    /// sibling layout (not present in an isolated `git worktree` checkout — that case is skipped,
    /// not failed, by `testVendoredVectorsMatchSiblingCoreRepoWhenPresent`).
    private static func siblingCoreVectorsURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // BeebeebNativeTests/
            .deletingLastPathComponent() // ios/
            .deletingLastPathComponent() // repo root
            .deletingLastPathComponent() // parent of repo root (sibling of repos/core)
            .appendingPathComponent("core/test-vectors/vectors.json")
    }

    private static func logPass(_ family: String) {
        print("[CoreVectorsKAT] \(family): PASS (byte-equal via production UniFFI bindings)")
    }

    /// Records a mismatch via `XCTFail` (through `recordFailure`, so the failure is attributed to
    /// the CALLING test method/line, not this helper) and flips `allPassed` so the caller's
    /// end-of-test `logPass` cannot fire. Deliberately NOT built on `XCTAssertEqual` — that macro
    /// reports a failure but does not hand back a pass/fail bool, which is exactly what let an
    /// earlier version of this file print "PASS" on a family that had just failed its own assert
    /// two lines above (caught by the tamper-proof run against `master_key_from_password`, task
    /// 1450 — the print must only fire when every comparison in the test actually held).
    private func expectEqual<T: Equatable>(
        _ actual: T, _ expected: T, _ message: String, allPassed: inout Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        guard actual != expected else { return }
        allPassed = false
        let failureMessage = "\(message) — got \(actual), expected \(expected)"
        record(XCTIssue(
            type: .assertionFailure, compactDescription: failureMessage,
            sourceCodeContext: XCTSourceCodeContext(location: XCTSourceCodeLocation(filePath: file, lineNumber: line))
        ))
    }

    /// Overload for `Data` specifically — `Data`'s default `description` is just "N bytes", which
    /// makes a byte-mismatch failure message useless for debugging. Print hex instead.
    private func expectEqual(
        _ actual: Data, _ expected: Data, _ message: String, allPassed: inout Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        guard actual != expected else { return }
        allPassed = false
        let failureMessage = "\(message) — got \(actual.hexString) (\(actual.count) bytes), expected \(expected.hexString) (\(expected.count) bytes)"
        record(XCTIssue(
            type: .assertionFailure, compactDescription: failureMessage,
            sourceCodeContext: XCTSourceCodeContext(location: XCTSourceCodeLocation(filePath: file, lineNumber: line))
        ))
    }

    // MARK: - Integrity of the vendored fixture itself

    func testVendoredVectorsShaPin() throws {
        let digest = SHA256.hash(data: try Self.loadVectorsData())
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hex, Self.expectedSha256Hex,
            "vendored Vectors/core-vectors.v4.json drifted from the pinned sha256 — see this file's " +
            "header for the refresh procedure before changing expectedSha256Hex"
        )
    }

    func testVendoredVectorsMatchSiblingCoreRepoWhenPresent() throws {
        let siblingURL = Self.siblingCoreVectorsURL()
        guard FileManager.default.fileExists(atPath: siblingURL.path) else {
            throw XCTSkip(
                "no sibling repos/core/test-vectors/vectors.json next to this checkout " +
                "(\(siblingURL.path)) — expected only in the standard <workspace>/repos/{core,mobile} " +
                "layout, not in an isolated git worktree; the sha256 pin test above is the enforced guard here"
            )
        }
        let siblingData = try Data(contentsOf: siblingURL)
        let bundledData = try Self.loadVectorsData()
        XCTAssertEqual(
            siblingData, bundledData,
            "vendored Vectors/core-vectors.v4.json diverged from repos/core/test-vectors/vectors.json " +
            "— re-vendor the copy and re-pin the sha256 (see this file's header)"
        )
    }

    func testVectorFileVersionAndRequiredNames() throws {
        let root = try Self.loadRoot()
        XCTAssertEqual(root["version"] as? Int, Self.expectedVersion, "vectors.json version mismatch")
        let vectors = try Self.loadVectors()
        let names = Set(vectors.compactMap { $0["name"] as? String })
        for name in Self.requiredVectorNames {
            XCTAssertTrue(names.contains(name), "vectors.json is missing required vector '\(name)'")
        }
    }

    // MARK: - 1. master_key_from_password (Argon2id)

    func testMasterKeyFromPassword() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "master_key_from_password")

        let password = try Self.str(v, "password")
        let salt = try Self.hex(v, "salt_hex")
        let expected = try Self.hex(v, "expected_master_key_hex")

        let result = try deriveMasterKey(password: password, salt: salt)
        var allPassed = true
        expectEqual(result.key, expected, "master_key_from_password: derived key does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("master_key_from_password") }
    }

    // MARK: - 2. file_key_derivation (HKDF-SHA256)

    func testFileKeyDerivation() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "file_key_derivation")

        let masterKey = try Self.hex(v, "master_key_hex")
        let fileId = try Self.hex(v, "file_id_hex")
        let expected = try Self.hex(v, "expected_file_key_hex")

        let fileKey = try deriveFileKey(masterKey: masterKey, fileId: fileId)
        var allPassed = true
        expectEqual(fileKey, expected, "file_key_derivation: derived file key does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("file_key_derivation") }
    }

    // MARK: - 3. chunk_encrypt_decrypt (AES-256-GCM)

    func testChunkDecrypt() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "chunk_encrypt_decrypt")

        let fileKey = try Self.hex(v, "file_key_hex")
        let nonce = try Self.hex(v, "nonce_hex")
        let ciphertext = try Self.hex(v, "ciphertext_hex")
        let expectedPlaintext = try Self.hex(v, "plaintext_hex")

        let decrypted = try decryptChunk(key: fileKey, nonce: nonce, ciphertext: ciphertext)
        var allPassed = true
        expectEqual(decrypted, expectedPlaintext, "chunk_encrypt_decrypt: decrypted plaintext does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("chunk_encrypt_decrypt (decrypt)") }
    }

    func testChunkEncryptDecryptRoundtrip() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "chunk_encrypt_decrypt")
        let fileKey = try Self.hex(v, "file_key_hex")
        let expectedPlaintext = try Self.hex(v, "plaintext_hex")

        let encrypted = try encryptChunk(key: fileKey, plaintext: expectedPlaintext)
        let decrypted = try decryptChunk(key: fileKey, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext)
        var allPassed = true
        expectEqual(decrypted, expectedPlaintext, "chunk roundtrip: encrypt->decrypt must reproduce the original plaintext", allPassed: &allPassed)
        if allPassed { Self.logPass("chunk_encrypt_decrypt (encrypt roundtrip)") }
    }

    // MARK: - 4. x25519_identity_keypair

    func testX25519IdentityKeypair() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "x25519_identity_keypair")

        let masterKey = try Self.hex(v, "master_key_hex")
        let expectedPrivate = try Self.hex(v, "expected_x25519_private_hex")
        let expectedPublic = try Self.hex(v, "expected_x25519_public_hex")

        let privateKey = try deriveX25519Private(masterKey: masterKey)
        let publicKey = try deriveX25519Public(privateKey: privateKey)

        var allPassed = true
        expectEqual(privateKey, expectedPrivate, "x25519_identity_keypair: private key does not match vector", allPassed: &allPassed)
        expectEqual(publicKey, expectedPublic, "x25519_identity_keypair: public key does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("x25519_identity_keypair") }
    }

    // MARK: - 5. x25519_share_key_exchange

    func testX25519ShareKeyExchange() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "x25519_share_key_exchange")

        let mkA = try Self.hex(v, "alice_master_key_hex")
        let mkB = try Self.hex(v, "bob_master_key_hex")
        let expectedSharedSecret = try Self.hex(v, "expected_shared_secret_hex")
        let expectedShareKey = try Self.hex(v, "expected_share_key_hex")
        let fileId = try Self.hex(v, "file_id_hex")

        let privA = try deriveX25519Private(masterKey: mkA)
        let pubA = try deriveX25519Public(privateKey: privA)
        let privB = try deriveX25519Private(masterKey: mkB)
        let pubB = try deriveX25519Public(privateKey: privB)

        var allPassed = true
        expectEqual(pubA, try Self.hex(v, "alice_x25519_public_hex"), "x25519_share_key_exchange: alice public key mismatch", allPassed: &allPassed)
        expectEqual(pubB, try Self.hex(v, "bob_x25519_public_hex"), "x25519_share_key_exchange: bob public key mismatch", allPassed: &allPassed)

        let sharedAB = try x25519SharedSecret(myPrivate: privA, theirPublic: pubB)
        let sharedBA = try x25519SharedSecret(myPrivate: privB, theirPublic: pubA)
        expectEqual(sharedAB, sharedBA, "x25519 DH must be commutative", allPassed: &allPassed)
        expectEqual(sharedAB, expectedSharedSecret, "x25519_share_key_exchange: shared secret does not match vector", allPassed: &allPassed)

        let shareKey = try deriveShareKey(sharedSecret: sharedAB, fileId: fileId)
        expectEqual(shareKey, expectedShareKey, "x25519_share_key_exchange: share key does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("x25519_share_key_exchange") }
    }

    // MARK: - 6. recovery_check

    func testRecoveryCheck() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "recovery_check")

        let masterKey = try Self.hex(v, "master_key_hex")
        let expected = try Self.hex(v, "expected_recovery_check_hex")

        let recoveryCheck = try computeRecoveryCheck(masterKey: masterKey)
        var allPassed = true
        expectEqual(recoveryCheck, expected, "recovery_check: computed value does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("recovery_check") }
    }

    // MARK: - 7. envelope_serialization — NOT exposed by UniFFI

    /// `OpaqueEnvelope::to_bytes()`/`from_bytes()` (repos/core/beebeeb-core/src/opaque.rs:8,23,31) is
    /// a pure Rust-side (de)serialization helper with no corresponding export in
    /// `beebeeb-uniffi/src/lib.rs` (grepped for "OpaqueEnvelope" — zero matches, confirmed 2026-09-22).
    /// Nothing in the mobile app constructs or parses the 96-byte envelope directly today — the mobile
    /// client only ever touches the derived fields (master key, x25519 keys, recovery check) via the
    /// individual functions covered by the other tests in this file. If mobile ever needs the raw
    /// envelope wire format (e.g. a future cross-client OPAQUE storage migration), this is where the
    /// gap must be closed on the core/UniFFI side first.
    func testEnvelopeSerialization() throws {
        print("[CoreVectorsKAT] envelope_serialization: SKIP — not exposed by UniFFI " +
              "(repos/core/beebeeb-core/src/opaque.rs:8 OpaqueEnvelope, :23 to_bytes, :31 from_bytes; " +
              "no export in repos/core/beebeeb-uniffi/src/lib.rs)")
        throw XCTSkip(
            "family envelope_serialization: not exposed by UniFFI — OpaqueEnvelope::to_bytes/from_bytes " +
            "(repos/core/beebeeb-core/src/opaque.rs:8,23,31) has no UniFFI export in " +
            "repos/core/beebeeb-uniffi/src/lib.rs"
        )
    }

    // MARK: - 8. recovery_phrase_roundtrip (BIP39 -> Argon2id -> master key)

    func testRecoveryPhraseRoundtrip() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "recovery_phrase_roundtrip")

        let mnemonic = try Self.str(v, "mnemonic")
        let expected = try Self.hex(v, "expected_master_key_hex")

        let recovered = try recoverFromPhrase(phrase: mnemonic)
        var allPassed = true
        expectEqual(recovered, expected, "recovery_phrase_roundtrip: recovered key does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("recovery_phrase_roundtrip") }
    }

    // MARK: - 9. metadata_encrypt_decrypt (filename AEAD)

    func testMetadataDecrypt() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "metadata_encrypt_decrypt")

        let fileKey = try Self.hex(v, "file_key_hex")
        let nonce = try Self.hex(v, "nonce_hex")
        let ciphertext = try Self.hex(v, "ciphertext_hex")
        let expectedMetadata = try Self.str(v, "metadata")

        let decrypted = try decryptMetadata(key: fileKey, nonce: nonce, ciphertext: ciphertext)
        var allPassed = true
        expectEqual(decrypted, expectedMetadata, "metadata_encrypt_decrypt: decrypted metadata does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("metadata_encrypt_decrypt (decrypt)") }
    }

    func testMetadataEncryptDecryptRoundtripUnicode() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "metadata_encrypt_decrypt")
        let fileKey = try Self.hex(v, "file_key_hex")

        let filenames = [
            "photos/vacation/IMG_2024.jpg",
            "documents/tax-return-2025.pdf",
            "",
            "a",
            String(repeating: "x", count: 4096),
            "Dokumente/Steuererklaerung 2025.pdf",
            "folder/file with spaces.txt",
        ]

        var allPassed = true
        for name in filenames {
            let encrypted = try encryptMetadata(key: fileKey, metadata: name)
            let recovered = try decryptMetadata(key: fileKey, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext)
            expectEqual(recovered, name, "metadata roundtrip failed for filename: \(name)", allPassed: &allPassed)
        }
        if allPassed { Self.logPass("metadata_encrypt_decrypt (encrypt roundtrip, unicode set)") }
    }

    // MARK: - 10. file_request_seal_open (sealed-box / ECIES per request)

    func testFileRequestSealOpen() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "file_request_seal_open")

        let masterKey = try Self.hex(v, "master_key_hex")
        let requestId = try Self.hex(v, "request_id_hex")
        let expectedWrapKey = try Self.hex(v, "expected_wrap_key_hex")
        let rPriv = try Self.hex(v, "r_priv_hex")
        let expectedRPub = try Self.hex(v, "r_pub_hex")
        let fileId = try Self.hex(v, "file_id_hex")
        let expectedContentKey = try Self.hex(v, "content_key_hex")
        let ePub = try Self.hex(v, "e_pub_hex")
        let wrappedKey = try Self.hex(v, "wrapped_key_hex")
        let wrappedPrivate = try Self.hex(v, "wrapped_private_hex")
        let wrapNonce = try Self.hex(v, "wrap_nonce_hex")

        var allPassed = true

        // 1. The private-wrap key is deterministic and must match the vector.
        let wrapKey = try deriveRequestWrapKey(masterKey: masterKey, requestId: requestId)
        expectEqual(wrapKey, expectedWrapKey, "file_request_seal_open: wrap key does not match vector", allPassed: &allPassed)

        // 2. The request public key must match the one derived from r_priv.
        let rPub = try deriveX25519Public(privateKey: rPriv)
        expectEqual(rPub, expectedRPub, "file_request_seal_open: r_pub does not match vector", allPassed: &allPassed)

        // 3. Unwrapping the stored wrapped private key must recover r_priv exactly.
        let recoveredPriv = try unwrapRequestPrivate(masterKey: masterKey, requestId: requestId, wrapped: wrappedPrivate, nonce: wrapNonce)
        expectEqual(recoveredPriv, rPriv, "file_request_seal_open: unwrapped private key does not match vector", allPassed: &allPassed)

        // 4. The critical interop path: a content key sealed on one platform must open to the
        //    original bytes on any other platform.
        let opened = try openRequestUpload(rPriv: rPriv, ePub: ePub, fileId: fileId, wrappedKey: wrappedKey)
        expectEqual(opened, expectedContentKey, "file_request_seal_open: opened content key does not match vector", allPassed: &allPassed)
        if allPassed { Self.logPass("file_request_seal_open") }
    }

    // MARK: - 11. share_key_wrap (audit item K3 — web wire format, same AEAD primitive)

    func testShareKeyWrapDecrypt() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "share_key_wrap")

        let wrapKey = try Self.hex(v, "wrap_key_hex")
        let nonce = try Self.hex(v, "nonce_hex")
        let ciphertext = try Self.hex(v, "ciphertext_hex")
        let expectedKeyToWrap = try Self.hex(v, "key_to_wrap_hex")

        var allPassed = true
        expectEqual(nonce.count + ciphertext.count, 60,
                    "share_key_wrap: nonce(12) || ciphertext(48) must total 60 bytes (the K3 wire format)", allPassed: &allPassed)

        let decrypted = try decryptChunk(key: wrapKey, nonce: nonce, ciphertext: ciphertext)
        expectEqual(
            decrypted, expectedKeyToWrap,
            "share_key_wrap: decrypted key does not match vector — this is the interop contract " +
            "web's unwrapKeyFromShare must also satisfy against this exact ciphertext",
            allPassed: &allPassed
        )
        if allPassed { Self.logPass("share_key_wrap (decrypt)") }
    }

    func testShareKeyWrapEncryptRoundtrip() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "share_key_wrap")
        let wrapKey = try Self.hex(v, "wrap_key_hex")
        let expectedKeyToWrap = try Self.hex(v, "key_to_wrap_hex")

        let encrypted = try encryptChunk(key: wrapKey, plaintext: expectedKeyToWrap)
        let decrypted = try decryptChunk(key: wrapKey, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext)
        var allPassed = true
        expectEqual(decrypted, expectedKeyToWrap, "share_key_wrap roundtrip: encrypt->decrypt must reproduce the original key", allPassed: &allPassed)
        if allPassed { Self.logPass("share_key_wrap (encrypt roundtrip)") }
    }

    // MARK: - 12. thumbnail_encrypt (audit item K3 — web wire format, same AEAD primitive)

    func testThumbnailEncryptDecrypt() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "thumbnail_encrypt")

        let fileKey = try Self.hex(v, "file_key_hex")
        let nonce = try Self.hex(v, "nonce_hex")
        let ciphertext = try Self.hex(v, "ciphertext_hex")
        let expectedPlaintext = try Self.hex(v, "plaintext_hex")

        let decrypted = try decryptChunk(key: fileKey, nonce: nonce, ciphertext: ciphertext)
        var allPassed = true
        expectEqual(
            decrypted, expectedPlaintext,
            "thumbnail_encrypt: decrypted plaintext does not match vector — this is the interop contract " +
            "web's thumbnail decrypt path must also satisfy against this exact ciphertext",
            allPassed: &allPassed
        )
        if allPassed { Self.logPass("thumbnail_encrypt (decrypt)") }
    }

    func testThumbnailEncryptRoundtrip() throws {
        let vectors = try Self.loadVectors()
        let v = try Self.vector(vectors, named: "thumbnail_encrypt")
        let fileKey = try Self.hex(v, "file_key_hex")
        let expectedPlaintext = try Self.hex(v, "plaintext_hex")

        let encrypted = try encryptChunk(key: fileKey, plaintext: expectedPlaintext)
        let decrypted = try decryptChunk(key: fileKey, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext)
        var allPassed = true
        expectEqual(decrypted, expectedPlaintext, "thumbnail_encrypt roundtrip: encrypt->decrypt must reproduce the original plaintext", allPassed: &allPassed)
        if allPassed { Self.logPass("thumbnail_encrypt (encrypt roundtrip)") }
    }
}

// MARK: - Hex <-> Data

private extension Data {
    init?(hexString: String) {
        let chars = Array(hexString)
        guard chars.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let byte = UInt8(String(chars[i...i+1]), radix: 16) else { return nil }
            bytes.append(byte)
            i += 2
        }
        self = Data(bytes)
    }

    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
