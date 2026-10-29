import XCTest
import CryptoKit

/// Task 1382 (audit item K2) — mobile half. Drives `beebeeb-core`'s cross-platform known-answer
/// vectors (`test-vectors/vectors.json`, v11, 31 families) through the SAME production UniFFI Swift
/// bindings the app links (`modules/beebeeb-crypto/ios/beebeeb_uniffi.swift`, compiled directly into
/// this target's Sources build phase — see the `CoreVectorsKATTests` target in `Beebeeb.xcodeproj`,
/// mirroring the host-less `ProvenanceHeadersTests` target added in task 1439). This file lives at
/// `targets/native-tests/` — OUTSIDE `ios/` — because `expo prebuild --clean` wipes the whole `ios/`
/// tree before regenerating it; `plugins/native-tests/withNativeTestTargets.js` (task 1562) wires the
/// target into the project on every prebuild, referencing this file directly. No app host, no
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
/// `Vectors/core-vectors.v11.json` is a vendored COPY of `repos/core/test-vectors/vectors.json` — it
/// has to be a copy (not a symlink out of the repo) so this xctest bundle can embed it as a Resource.
/// To refresh after core bumps the vector file:
/// 1. `cp ../core/test-vectors/vectors.json targets/native-tests/Vectors/core-vectors.v11.json`
///    (run from the mobile repo root in the standard `<workspace>/repos/{core,mobile}` layout — NOT
///    from an isolated `git worktree`, which has no sibling `repos/core` checkout).
/// 2. `shasum -a 256 targets/native-tests/Vectors/core-vectors.v11.json` and paste the new hex into
///    `expectedSha256Hex` below.
/// 3. If core bumped `version`, update `expectedVersion` and `expectedFamilyRowCounts` here to match
///    `vector_file_version_check` in `cross_platform_vectors.rs`; `src/lib/1943-core-vectors-v11.guard.test.ts`
///    pins the same bytes, version and row counts for the JS-side gate.
/// 4. Re-run this target; `testVendoredVectorsShaPin` enforces the new pin, and every family test
///    re-validates against the refreshed data automatically (no other code change needed).
final class CoreVectorsKATTests: XCTestCase {

    // MARK: - Pin

    /// `shasum -a 256 repos/core/test-vectors/vectors.json` (v11, core c08defc7).
    private static let expectedSha256Hex =
        "11f7522056d0c12eff92d2f37a5fa6975ce460cf36899e3a6a92f3455a4d754a"
    private static let expectedVersion = 11
    /// Every family core ships at this revision, with the number of rows it carries — 31 families,
    /// 31 rows. Asserting the row count (not just presence) catches a truncated or half-refreshed
    /// vendored file, which presence alone would wave through. `envelope_serialization` stays an
    /// explicit skip (`testEnvelopeSerialization`), exactly as before.
    private static let expectedFamilyRowCounts: [(family: String, rows: Int)] = [
        ("master_key_from_password", 1),
        ("file_key_derivation", 1),
        ("chunk_encrypt_decrypt", 1),
        ("x25519_identity_keypair", 1),
        ("x25519_share_key_exchange", 1),
        ("recovery_check", 1),
        ("envelope_serialization", 1),
        ("recovery_phrase_roundtrip", 1),
        ("metadata_encrypt_decrypt", 1),
        ("file_request_seal_open", 1),
        ("share_key_wrap", 1),
        ("thumbnail_encrypt", 1),
        ("chunk_v2_stream", 1),
        ("chunk_v2_single_frame", 1),
        ("metadata_v2_name", 1),
        ("metadata_v2_name_filekey", 1),
        ("metadata_v1_name_filekey", 1),
        ("folder_key_id", 1),
        ("shared_folder_index_key", 1),
        ("combine_folder_link_key", 1),
        ("key_wrap_v1", 1),
        ("folder_link_passphrase", 1),
        ("folder_link_passphrase_nfd", 1),
        ("folder_custody_v1", 1),
        ("link_owner_key_v1", 1),
        ("link_owner_token_v1", 1),
        ("folder_child_file_v1", 1),
        ("folder_child_folder_v1", 1),
        ("owner_wrapped_file_key", 1),
        ("owner_wrapped_folder_key", 1),
        ("folder_wrapped_file_key", 1),
    ]

    // MARK: - Vector loading

    private static func bundledVectorsURL() throws -> URL {
        guard let url = Bundle(for: CoreVectorsKATTests.self)
            .url(forResource: "core-vectors.v11", withExtension: "json") else {
            throw NSError(
                domain: "CoreVectorsKATTests", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "core-vectors.v11.json missing from test bundle resources"]
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
                           userInfo: [NSLocalizedDescriptionKey: "core-vectors.v11.json did not decode to an object"])
        }
        return root
    }

    private static func loadVectors() throws -> [[String: Any]] {
        guard let vectors = try loadRoot()["vectors"] as? [[String: Any]] else {
            throw NSError(domain: "CoreVectorsKATTests", code: 3,
                           userInfo: [NSLocalizedDescriptionKey: "core-vectors.v11.json 'vectors' is not an array"])
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

    /// Test-only 60-byte wrap opener (nonce(12) || ciphertext(48)) for link-wrap vectors. Production code
    /// has no generic opener: every wrap is opened by a purpose-bound core function.
    private static func openWrap(_ wrapper: FileKeyHandle, _ wrapped: Data) throws -> FileKeyHandle {
        XCTAssertEqual(wrapped.count, 60)
        return try wrapper.unwrapKey(nonce: Data(wrapped.prefix(12)), ciphertext: Data(wrapped.dropFirst(12)))
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

    /// `<repo>/targets/native-tests/CoreVectorsKATTests.swift` -> four levels up (this file,
    /// `native-tests/`, `targets/`, repo root) lands on `repos/`, then `core/test-vectors/vectors.json`
    /// — the standard `<workspace>/repos/{core,mobile}` sibling layout. An isolated worktree may have
    /// an unrelated `../core` checkout; only the documented `repos/` layout participates in this
    /// optional comparison. The SHA pin is enforced in every layout.
    private static func siblingCoreVectorsURL() -> URL? {
        let parent = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // BeebeebNativeTests/
            .deletingLastPathComponent() // ios/
            .deletingLastPathComponent() // repo root
            .deletingLastPathComponent() // parent of repo root (sibling of repos/core)
        guard parent.lastPathComponent == "repos" else { return nil }
        return parent.appendingPathComponent("core/test-vectors/vectors.json")
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
            "vendored Vectors/core-vectors.v11.json drifted from the pinned sha256 — see this file's " +
            "header for the refresh procedure before changing expectedSha256Hex"
        )
    }

    func testVendoredVectorsMatchSiblingCoreRepoWhenPresent() throws {
        guard let siblingURL = Self.siblingCoreVectorsURL(),
              FileManager.default.fileExists(atPath: siblingURL.path) else {
            throw XCTSkip(
                "no sibling repos/core/test-vectors/vectors.json next to this checkout " +
                "— expected only in the standard <workspace>/repos/{core,mobile} layout, " +
                "not in an isolated git worktree; the sha256 pin test above is the enforced guard here"
            )
        }
        let siblingData = try Data(contentsOf: siblingURL)
        let bundledData = try Self.loadVectorsData()
        XCTAssertEqual(
            siblingData, bundledData,
            "vendored Vectors/core-vectors.v11.json diverged from repos/core/test-vectors/vectors.json " +
            "— re-vendor the copy and re-pin the sha256 (see this file's header)"
        )
    }

    func testVectorFileVersionAndEveryFamilyRowCount() throws {
        let root = try Self.loadRoot()
        XCTAssertEqual(root["version"] as? Int, Self.expectedVersion, "vectors.json version mismatch")
        let vectors = try Self.loadVectors()
        var counts: [String: Int] = [:]
        for vector in vectors {
            guard let name = vector["name"] as? String else {
                XCTFail("vectors.json carries a row with no name")
                continue
            }
            counts[name, default: 0] += 1
        }
        for (family, rows) in Self.expectedFamilyRowCounts {
            XCTAssertEqual(counts[family], rows, "vectors.json family '\(family)' row count mismatch")
            print("[CoreVectorsKAT] \(family): \(counts[family] ?? 0) row(s)")
        }
        XCTAssertEqual(
            Set(counts.keys), Set(Self.expectedFamilyRowCounts.map(\.family)),
            "vectors.json carries a family this KAT does not assert by name"
        )
        XCTAssertEqual(vectors.count, Self.expectedFamilyRowCounts.reduce(0) { $0 + $1.rows },
                       "vectors.json total row count mismatch")
        print("[CoreVectorsKAT] \(Self.expectedFamilyRowCounts.count) families, \(vectors.count) rows, version \(Self.expectedVersion)")
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
    // v10: exercise actual handle ABI, not a reimplementation of the derivation.
    func testKeyWrapV1() throws {
        let v = try Self.vector(Self.loadVectors(), named: "key_wrap_v1")
        let wrapper = try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "wrapper_key_hex"))
        let wire = try Self.hex(v, "wrapped_hex")
        let opened = try wrapper.unwrapKey(nonce: Data(wire.prefix(12)), ciphertext: Data(wire.dropFirst(12)))
        let expected = try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "inner_key_hex"))
        XCTAssertEqual(try opened.keyId(), try expected.keyId())
        print("[CoreVectorsKAT] key_wrap_v1: 1 row")
    }

    func testFolderLinkPassphrase() throws {
        let v = try Self.vector(Self.loadVectors(), named: "folder_link_passphrase")
        let actual = try FileKeyHandle.fromFolderLinkPassphrase(
            kC: Self.hex(v, "k_c_hex"), passphrase: Self.str(v, "passphrase"), token: Self.str(v, "token"))
        let expected = try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "link_key_hex"))
        XCTAssertEqual(try actual.keyId(), try expected.keyId())
        print("[CoreVectorsKAT] folder_link_passphrase: 1 row")
    }

    func testL6PurposeWrapVectors() throws {
        for name in ["folder_custody_v1", "link_owner_key_v1", "link_owner_token_v1"] {
            let v = try Self.vector(Self.loadVectors(), named: name)
            let master = try MasterKeyHandle.fromKeychainBytes(bytes: Self.hex(v, "master_key_hex"))
            let wire = try Self.hex(v, "wrapped_hex")
            let id = try Self.str(v, "record_id")
            let nonce = Data(wire.prefix(12)), ct = Data(wire.dropFirst(12))
            let plain = try Self.hex(v, "plaintext_hex")
            if name == "folder_custody_v1" {
                let opened = try master.unwrapFolderCustody(folderId: id, nonce: nonce, ciphertext: ct)
                XCTAssertEqual(try opened.keyId(), try FileKeyHandle.fromKeyBytes(key: plain).keyId())
                XCTAssertThrowsError(try master.unwrapFolderCustody(folderId: id + "wrong", nonce: nonce, ciphertext: ct))
            } else if name == "link_owner_key_v1" {
                XCTAssertEqual(try master.unwrapLinkOwnerKey(shareId: id, nonce: nonce, ciphertext: ct), plain)
                XCTAssertThrowsError(try master.unwrapLinkOwnerToken(shareId: id, nonce: nonce, ciphertext: ct))
            } else {
                XCTAssertEqual(try master.unwrapLinkOwnerToken(shareId: id, nonce: nonce, ciphertext: ct), plain)
            }
            print("[CoreVectorsKAT] \(name): 1 row")
        }
    }

    func testFolderLinkPassphraseNfd() throws {
        let v = try Self.vector(Self.loadVectors(), named: "folder_link_passphrase_nfd")
        let actual = try FileKeyHandle.fromFolderLinkPassphrase(
            kC: Self.hex(v, "k_c_hex"), passphrase: Self.str(v, "passphrase"), token: Self.str(v, "token"))
        XCTAssertEqual(try actual.keyId(), try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "link_key_hex")).keyId())
        XCTAssertThrowsError(try FileKeyHandle.fromFolderLinkPassphrase(kC: Self.hex(v, "k_c_hex"), passphrase: "", token: Self.str(v, "token")))
        print("[CoreVectorsKAT] folder_link_passphrase_nfd: 1 row")
    }

    func testFolderChildVectorsBindEveryContextField() throws {
        for name in ["folder_child_file_v1", "folder_child_folder_v1"] {
            let v = try Self.vector(Self.loadVectors(), named: name)
            let key = try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "folder_key_hex"))
            let wire = try Self.hex(v, "wrapped_hex"), root = try Self.str(v, "shared_folder_id"), item = try Self.str(v, "item_id")
            let kind = UInt8(v["kind"] as! Int)
            let opened = try key.unwrapFolderChild(sharedFolderId: root, itemId: item, kind: kind, nonce: Data(wire.prefix(12)), ciphertext: Data(wire.dropFirst(12)))
            XCTAssertEqual(try opened.keyId(), try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "child_key_hex")).keyId())
            for (r, i, k) in [("00000000-0000-4000-8000-000000000099", item, kind), (root, "00000000-0000-4000-8000-000000000099", kind), (root, item, 3-kind)] {
                XCTAssertThrowsError(try key.unwrapFolderChild(sharedFolderId: r, itemId: i, kind: k, nonce: Data(wire.prefix(12)), ciphertext: Data(wire.dropFirst(12))))
            }
            print("[CoreVectorsKAT] \(name): 1 row")
        }
    }

    func testOwnerWrapRejectsOwnV1Content() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let id = "11111111-1111-4111-8111-111111111111"
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let derived = try master.deriveFileKey(fileId: Data(id.utf8))
        let frame = try SharedKeyOps.wire(derived.encryptChunk(plaintext: Data(repeating: 0x55, count: 32)))
        XCTAssertEqual(frame.count, 60)
        XCTAssertFalse(SharedKeyOps.openOwnerFileKey(master: master, fileId: id, wrapped: frame, registry: registry))
        XCTAssertNil(registry.file(id))
    }

    func testOwnerWrapRejectsLegacyNameEnvelope() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let id = "11111111-1111-4111-8111-111111111111"
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let name = try master.encryptName(fileId: id, filename: "test", mimeType: nil)
        let blob = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(name.utf8)) as? [String: Any])
        let nonce = Data(try XCTUnwrap(blob["nonce"] as? [UInt8]))
        let ciphertext = Data(try XCTUnwrap(blob["ciphertext"] as? [UInt8]))
        let frame = nonce + ciphertext
        XCTAssertEqual(frame.count, 60)
        XCTAssertFalse(SharedKeyOps.openOwnerFileKey(master: master, fileId: id, wrapped: frame, registry: registry))
        XCTAssertNil(registry.file(id))
    }

    func testL8OwnerWrapVectorAndAdoption() throws {
        let v = try Self.vector(Self.loadVectors(), named: "owner_wrapped_file_key")
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Self.hex(v, "master_key_hex"))
        let id = try Self.str(v, "file_id")
        let frame = try Self.hex(v, "expected_frame_hex")
        let registry = SharedKeyRegistry<FileKeyHandle>()
        XCTAssertTrue(SharedKeyOps.openOwnerFileKey(master: master, fileId: id, wrapped: frame, registry: registry))
        let expected = try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "child_key_hex"))
        XCTAssertEqual(try XCTUnwrap(registry.file(id)).keyId(), try expected.keyId())
        let adopted = try SharedKeyOps.adoptWrap(master: master, fileId: id, registry: registry)
        XCTAssertEqual(adopted.count, 60)
        registry.clear()
        XCTAssertTrue(SharedKeyOps.openOwnerFileKey(master: master, fileId: id, wrapped: adopted, registry: registry))
        XCTAssertEqual(try XCTUnwrap(registry.file(id)).keyId(), try expected.keyId())
        XCTAssertFalse(SharedKeyOps.openOwnerFileKey(master: master, fileId: "22222222-2222-4222-8222-222222222222", wrapped: adopted, registry: registry))
        var corrupt = adopted
        corrupt[corrupt.count - 1] ^= 1
        XCTAssertFalse(SharedKeyOps.openOwnerFileKey(master: master, fileId: id, wrapped: corrupt, registry: registry))
        XCTAssertEqual(try XCTUnwrap(registry.file(id)).keyId(), try expected.keyId())
    }

    func testSharedKeyOpsRoundTrip() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let folder = try SharedKeyOps.generateFolderKey(master: master, folderId: "2237c000-0000-4000-8000-000000000001", registry: registry)
        let opened = try SharedKeyOps.openOwnerFolderKey(master: master, folderId: "2237c000-0000-4000-8000-000000000001", wrapped: folder.ownerWrapped, registry: registry)
        let rows = try SharedKeyOps.wrapChildKeys(master: master, folderId: opened, fileIds: ["2237c000-0000-4000-8000-000000000002"], registry: registry)
        let loaded = try SharedKeyOps.loadFileKeys(folderId: opened,
            entries: rows + [SharedKeyEntryNative(fileId: "bad", wrapped: Data(), kind: 1)], registry: registry)
        XCTAssertEqual(loaded.loaded, ["2237c000-0000-4000-8000-000000000002"])
        XCTAssertEqual(loaded.failed, ["bad"])
        let derived = try master.deriveFileKey(fileId: Data("2237c000-0000-4000-8000-000000000002".utf8))
        let encrypted = try derived.encryptChunk(plaintext: Data("round trip".utf8))
        let key = try SharedKeyOps.fileKey(master: master, fileId: "2237c000-0000-4000-8000-000000000002", registry: registry)
        XCTAssertEqual(try key.decryptChunk(nonce: encrypted.nonce, ciphertext: encrypted.ciphertext), Data("round trip".utf8))
        let adopted = try SharedKeyOps.adoptWrap(master: master, fileId: "2237c000-0000-4000-8000-000000000002", registry: registry)
        XCTAssertTrue(SharedKeyOps.openOwnerFileKey(master: master, fileId: "2237c000-0000-4000-8000-000000000002", wrapped: adopted, registry: registry))
    }

    func testMintLinkMatchesTheVector() throws {
        let v = try Self.vector(Self.loadVectors(), named: "folder_link_passphrase")
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let folder = try SharedKeyOps.generateFolderKey(master: master, folderId: "root", registry: registry)
        let token = try Self.str(v, "token"), passphrase = try Self.str(v, "passphrase")
        let minted = try SharedKeyOps.mintLink(master: master, folderId: folder.handleId, token: token, passphrase: passphrase, shareId: "share", registry: registry)
        let kc = Data(base64Encoded: minted.kc.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")!
        let link = try FileKeyHandle.fromFolderLinkPassphrase(kC: kc, passphrase: passphrase, token: token)
        let opened = try Self.openWrap(link, minted.wrappedFolderKey)
        XCTAssertEqual(try opened.keyId(), try registry.folder(folder.handleId)!.handle.keyId())
        XCTAssertEqual(try SharedKeyOps.recoverKc(master: master, folderId: folder.handleId, wrapped: minted.ownerWrappedKey, shareId: "share", registry: registry), minted.kc)
        XCTAssertNil(try SharedKeyOps.recoverKc(master: master, folderId: folder.handleId, wrapped: minted.ownerWrappedKey, shareId: "wrong", registry: registry))
        XCTAssertEqual(try master.unwrapLinkOwnerToken(shareId: "share", nonce: Data(minted.ownerWrappedToken.prefix(12)), ciphertext: Data(minted.ownerWrappedToken.dropFirst(12))), Data(token.utf8))
        XCTAssertThrowsError(try SharedKeyOps.mintLink(master: master, folderId: folder.handleId, token: token, passphrase: "", shareId: "share", registry: registry))
    }

    func testRecoverKcRefusesTheFolderKeyWrap() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let folder = try SharedKeyOps.generateFolderKey(master: master, folderId: "root", registry: registry)
        let key = registry.folder(folder.handleId)!.handle
        let wrong = try SharedKeyOps.wire(master.wrapLinkOwnerKey(shareId: "share", inner: key))
        XCTAssertNil(try SharedKeyOps.recoverKc(master: master, folderId: folder.handleId, wrapped: wrong, shareId: "share", registry: registry))
        let legacy = try SharedKeyOps.wire(master.wrapKey(inner: key))
        XCTAssertNil(try SharedKeyOps.recoverKc(master: master, folderId: folder.handleId, wrapped: legacy, shareId: "share", registry: registry))
    }

    func testDecryptNamesPrefersTheTableKey() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let key = try FileKeyHandle.generate()
        let name = try key.encryptNameFor(filename: "guest.txt", mimeType: "text/plain", recordedPin: 0)
        let items = [BatchNameItem(fileId: "2237c000-0000-4000-8000-000000000002", nameEncrypted: name)]
        XCTAssertNotNil(try SharedKeyOps.decryptNames(master: master, items: items, registry: registry)[0].error)
        let folder = try SharedKeyOps.generateFolderKey(master: master, folderId: "2237c000-0000-4000-8000-000000000001", registry: registry)
        let wrapped = try SharedKeyOps.wire(registry.folder(folder.handleId)!.handle.wrapFolderChild(sharedFolderId: "2237c000-0000-4000-8000-000000000001", itemId: "2237c000-0000-4000-8000-000000000002", kind: 1, inner: key))
        _ = try SharedKeyOps.loadFileKeys(folderId: folder.handleId, entries: [SharedKeyEntryNative(fileId: "2237c000-0000-4000-8000-000000000002", wrapped: wrapped, kind: 1)], registry: registry)
        let opened = try SharedKeyOps.decryptNames(master: master, items: items, registry: registry)
        XCTAssertEqual(opened[0].name, "guest.txt")
        XCTAssertEqual(opened[0].mimeType, "text/plain")
        XCTAssertNil(opened[0].error)
        let ownerName = try master.encryptName(fileId: "2237c000-0000-4000-8000-000000000002", filename: "owner", mimeType: nil)
        let rejected = try SharedKeyOps.decryptNames(master: master,
            items: [BatchNameItem(fileId: "2237c000-0000-4000-8000-000000000002", nameEncrypted: ownerName)], registry: registry)
        XCTAssertNotNil(rejected[0].error, "a table decrypt failure must not fall back to the master")
    }

    func testChildPublicationPreservesLoadedRandomKeysForBothKinds() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let root = "2237c000-0000-4000-8000-000000000001"
        let folder = try SharedKeyOps.generateFolderKey(master: master, folderId: root, registry: registry)
        for kind: UInt8 in [1, 2] {
            let id = "2237c000-0000-4000-8000-000000000002"
            let real = try FileKeyHandle.generate()
            registry.storeFile(id, real)
            let rows = try SharedKeyOps.wrapChildKeys(master: master, folderId: folder.handleId, fileIds: [id], kind: kind, registry: registry)
            let wire = rows[0].wrapped
            let opened = try registry.folder(folder.handleId)!.handle.unwrapFolderChild(sharedFolderId: root, itemId: id, kind: kind, nonce: Data(wire.prefix(12)), ciphertext: Data(wire.dropFirst(12)))
            XCTAssertEqual(try opened.keyId(), try real.keyId())
            XCTAssertNotEqual(try opened.keyId(), try master.deriveFileKey(fileId: Data(id.utf8)).keyId())
            let frame = try real.encryptChunk(plaintext: Data("moved guest".utf8))
            XCTAssertEqual(try opened.decryptChunk(nonce: frame.nonce, ciphertext: frame.ciphertext), Data("moved guest".utf8))
        }
    }

    func testPreviewUsesAuthenticatedV2PinForTableAndOwnerKeys() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        for tableHeld in [false, true] {
            let registry = SharedKeyRegistry<FileKeyHandle>()
            let id = "2237c000-0000-4000-8000-000000000002"
            let key = try tableHeld ? FileKeyHandle.generate() : master.deriveFileKey(fileId: Data(id.utf8))
            if tableHeld { registry.storeFile(id, key) }
            let name = try key.encryptNameFor(filename: "pinned.txt", mimeType: nil, recordedPin: 2)
            let pin = try SharedKeyOps.previewChunkFormat(master: master, fileId: id, nameEncrypted: name, registry: registry)
            XCTAssertEqual(pin, 2)
            let legacy = try SharedKeyOps.wire(key.encryptChunk(plaintext: Data("replayed v1".utf8)))
            let decryptor = try SharedKeyOps.chunkDecryptor(master: master, fileId: id, expectedChunkFormat: pin, registry: registry)
            XCTAssertThrowsError(try decryptor.pushFrame(frame: legacy), "v2 pin must refuse legacy replay")
            XCTAssertThrowsError(try SharedKeyOps.previewChunkFormat(master: master, fileId: id, nameEncrypted: "plaintext", registry: registry))
        }
    }

    func testTruncatedV2PreviewRejectsMissingLastFrame() throws {
        let v = try Self.vector(Self.loadVectors(), named: "chunk_v2_stream")
        let key = try FileKeyHandle.fromKeyBytes(key: Self.hex(v, "file_key_hex"))
        let decryptor = try ChunkDecryptorHandle.forPushWithFileKeyHandle(
            fileKey: key, fileId: try Self.str(v, "file_id"), expectedChunkFormat: 2)
        let frames = v["frames"] as! [[String: Any]]
        XCTAssertEqual(frames.count, 3)
        for frame in frames.prefix(2) {
            XCTAssertEqual(try decryptor.pushFrame(frame: Self.hex(frame, "frame_hex")).data.count, 32)
        }
        XCTAssertThrowsError(try decryptor.finish(), "missing authenticated last frame must reject promotion")
    }

    func testChunkDecryptorUsesTheFileKeyHandle() throws {
        let master = try MasterKeyHandle.fromKeychainBytes(bytes: Data(repeating: 0x40, count: 32))
        let registry = SharedKeyRegistry<FileKeyHandle>()
        let key = try FileKeyHandle.generate()
        registry.storeFile("guest", key)
        let frame = try SharedKeyOps.wire(key.encryptChunk(plaintext: Data("guest frame".utf8)))
        let decryptor = try SharedKeyOps.chunkDecryptor(master: master, fileId: "guest", expectedChunkFormat: 0, registry: registry)
        XCTAssertEqual(try decryptor.pushFrame(frame: frame).data, Data("guest frame".utf8))
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
