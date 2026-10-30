import Foundation

// SF-0002 M2a step 2: the read-only owner resolvers, driven through the real
// UniFFI host dylib. Run by scripts/swift-ci/run-swift-tests.sh, which links
// the core build named by BB_CORE_REPO.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else {
        print("FAIL: \(name)")
        exit(1)
    }
    assertions += 1
    print("PASS: \(name)")
}

func vectorsRoot() throws -> [String: Any] {
    let url = URL(fileURLWithPath: "targets/native-tests/Vectors/core-vectors.json")
    let data = try Data(contentsOf: url)
    return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
}

func vector(_ name: String) throws -> [String: Any] {
    let root = try vectorsRoot()
    let vectors = root["vectors"] as? [[String: Any]] ?? []
    guard let found = vectors.first(where: { $0["name"] as? String == name }) else {
        throw NSError(domain: "owner-read-key", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "vector \(name) missing"])
    }
    return found
}

func hex(_ value: String) -> Data {
    var data = Data(capacity: value.count / 2)
    var index = value.startIndex
    while index < value.endIndex {
        let next = value.index(index, offsetBy: 2)
        data.append(UInt8(value[index..<next], radix: 16)!)
        index = next
    }
    return data
}

func isUpperRepair(_ convention: OwnerKeyConvention) -> Bool {
    if case .upperRepair = convention { return true }
    return false
}

func isStringConvention(_ convention: OwnerKeyConvention) -> Bool {
    if case .string = convention { return true }
    return false
}

// MARK: - 1. The uppercase-sealed name resolves through the owner resolver

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    let nameEncrypted = v["name_encrypted"] as! String
    let resolved = try SharedKeyOps.resolveOwnerName(
        master: master, fileId: fileId, nameEncrypted: nameEncrypted)
    check(isUpperRepair(resolved.convention), "anUppercaseSealedNameResolvesUpperRepair: convention")
    let metadata = try resolved.readKey.decryptFileMetadata(nameEncrypted: nameEncrypted)
    check(metadata.name == v["expected_name"] as! String, "anUppercaseSealedNameResolvesUpperRepair: name")
    check(metadata.mimeType == v["expected_mime_type"] as? String, "anUppercaseSealedNameResolvesUpperRepair: mime")
    let frame = hex(v["content_frame_hex"] as! String)
    let content = try SharedKeyOps.resolveOwnerContent(master: master, fileId: fileId, firstFrame: frame)
    check(isUpperRepair(content.convention), "anUppercaseSealedNameResolvesUpperRepair: content convention")
    let plaintext = try content.readKey.makeDecryptor(fileId: fileId, chunkFormat: 0)
        .pushFrame(frame: frame).data
    check(plaintext == hex(v["content_plaintext_hex"] as! String),
          "anUppercaseSealedNameResolvesUpperRepair: content decrypts")
} catch {
    print("FAIL: anUppercaseSealedNameResolvesUpperRepair threw \(error)")
    exit(1)
}

// MARK: - 2. The resolver key is read-only by construction

do {
    let source = try String(contentsOfFile: "modules/beebeeb-crypto/ios/OwnerReadKey.swift",
                            encoding: .utf8)
    check(source.contains("private let key: FileKeyHandle"), "aResolverKeyCanNeitherEncryptNorWrap: private key")
    let exposed = ["decryptFileMetadata", "decryptNameMetadata", "makeDecryptor"]
    for name in exposed {
        check(source.contains("func \(name)("), "aResolverKeyCanNeitherEncryptNorWrap: exposes \(name)")
    }
    for forbidden in ["func encrypt", "func wrap", "func adopt", "storeFile", "borrowFileKey",
                      "func fileKey(", "FileKeyHandle {", "var key"] {
        check(!source.contains(forbidden), "aResolverKeyCanNeitherEncryptNorWrap: no \(forbidden)")
    }
    let ops = try String(contentsOfFile: "modules/beebeeb-crypto/ios/SharedKeyOps.swift", encoding: .utf8)
    if let start = ops.range(of: "static func resolveOwnerName"),
       let end = ops.range(of: "static func resolveOwnerContent") {
        let resolverBody = ops[start.lowerBound..<end.lowerBound]
        check(!resolverBody.contains("storeFile"),
              "aResolverKeyCanNeitherEncryptNorWrap: resolver key never stored")
    } else {
        check(false, "aResolverKeyCanNeitherEncryptNorWrap: resolver bodies found")
    }
} catch {
    print("FAIL: aResolverKeyCanNeitherEncryptNorWrap threw \(error)")
    exit(1)
}

// MARK: - 3. Owned shared file: a wrong table key falls through to the owner

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    let wrongKey = try FileKeyHandle.fromKeyBytes(key: Data(repeating: 0x7a, count: 32))
    let registry = SharedKeyRegistry<FileKeyHandle>()
    _ = registry.storeFile(fileId, wrongKey)
    let results = try SharedKeyOps.decryptNames(
        master: master,
        items: [BatchNameItem(fileId: fileId, nameEncrypted: v["name_encrypted"] as! String)],
        registry: registry)
    check(results.count == 1, "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: result count")
    check(results[0].name == v["expected_name"] as! String,
          "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: owner retry wins")
    check(results[0].error == nil, "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: no error")
    check(SharedKeyOps.nameResolutionPlan(tablePresent: true, tableFailed: true, isForeign: false)
            == .ownerResolve,
          "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: plan")
} catch {
    print("FAIL: anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver threw \(error)")
    exit(1)
}

// MARK: - 4. Foreign shared file: the wrong table key stays final

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    let wrongKey = try FileKeyHandle.fromKeyBytes(key: Data(repeating: 0x7b, count: 32))
    let registry = SharedKeyRegistry<FileKeyHandle>()
    _ = registry.storeFile(fileId, wrongKey)
    let results = try SharedKeyOps.decryptNames(
        master: master,
        items: [BatchNameItem(fileId: fileId, nameEncrypted: v["name_encrypted"] as! String)],
        foreignFileIds: [fileId],
        registry: registry)
    check(results.count == 1, "aForeignWrongTableKeyStaysFinal: result count")
    check(results[0].name == nil, "aForeignWrongTableKeyStaysFinal: no name")
    check(results[0].error != nil, "aForeignWrongTableKeyStaysFinal: error is final")
    check(SharedKeyOps.nameResolutionPlan(tablePresent: true, tableFailed: true, isForeign: true)
            == .errorFinal,
          "aForeignWrongTableKeyStaysFinal: plan")
} catch {
    print("FAIL: aForeignWrongTableKeyStaysFinal threw \(error)")
    exit(1)
}

// MARK: - 5. The convention cache holds no keys and clears on lock

do {
    let cache = OwnerConventionCache()
    check(cache.count == 0, "theConventionCacheHoldsNoKeysAndClearsOnLock: starts empty")
    let v = try vector("upper_repair_v1")
    cache.storeName(.upperRepair, epoch: 1, fileId: v["file_id"] as! String,
                    nameEncrypted: v["name_encrypted"] as! String)
    check(cache.count == 1, "theConventionCacheHoldsNoKeysAndClearsOnLock: remembers a convention")
    check(cache.name(epoch: 1, fileId: v["file_id"] as! String,
                     nameEncrypted: v["name_encrypted"] as! String).map(isUpperRepair) == true,
          "theConventionCacheHoldsNoKeysAndClearsOnLock: round trip")
    cache.clear()
    check(cache.count == 0, "theConventionCacheHoldsNoKeysAndClearsOnLock: clear empties")
    let source = try String(contentsOfFile: "modules/beebeeb-crypto/ios/OwnerReadKey.swift",
                            encoding: .utf8)
    let cacheSource = source.components(separatedBy: "final class OwnerConventionCache").last ?? ""
    check(!cacheSource.contains("FileKeyHandle"), "theConventionCacheHoldsNoKeysAndClearsOnLock: no key type")
    let ops = try String(contentsOfFile: "modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift",
                         encoding: .utf8)
    check(ops.contains("SharedKeyOps.ownerConventions.clear()"),
          "theConventionCacheHoldsNoKeysAndClearsOnLock: cleared with sharedKeysClear")
} catch {
    print("FAIL: theConventionCacheHoldsNoKeysAndClearsOnLock threw \(error)")
    exit(1)
}

print("owner-read-key-test: \(assertions) assertions, 0 failed")
