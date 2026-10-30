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
        ownedFileIds: [fileId],
        registry: registry)
    check(results.count == 1, "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: result count")
    check(results[0].name == v["expected_name"] as! String,
          "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: owner retry wins")
    check(results[0].error == nil, "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: no error")
    check(results[0].convention == "upper_repair",
          "anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver: exact convention")
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
        registry: registry)
    check(results.count == 1, "aForeignWrongTableKeyStaysFinal: result count")
    check(results[0].name == nil, "aForeignWrongTableKeyStaysFinal: no name")
    check(results[0].error != nil, "aForeignWrongTableKeyStaysFinal: error is final")
    check(results[0].convention == nil, "aForeignWrongTableKeyStaysFinal: no convention")
    check(SharedKeyOps.nameResolutionPlan(tablePresent: true, tableFailed: true, isForeign: true)
            == .errorFinal,
          "aForeignWrongTableKeyStaysFinal: plan")
    // Declaring the id foreign is the same verdict as not declaring it owned.
    let declaredForeign = try SharedKeyOps.decryptNames(
        master: master,
        items: [BatchNameItem(fileId: fileId, nameEncrypted: v["name_encrypted"] as! String)],
        ownedFileIds: [],
        registry: registry)
    check(declaredForeign[0].name == nil, "aForeignWrongTableKeyStaysFinal: default set is final")
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

// MARK: - 6. Names carry their convention; a canonical row costs no owner attempt

do {
    let v = try vector("metadata_v2_name")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    SharedKeyOps.resetOwnerResolveAttempts()
    let results = try SharedKeyOps.decryptNames(
        master: master,
        items: [BatchNameItem(fileId: fileId, nameEncrypted: v["name_encrypted"] as! String)],
        ownedFileIds: [fileId])
    check(results.count == 1, "aCanonicalNameCostsNoExtraAttemptInTheBatch: result count")
    check(results[0].name == v["expected_name"] as! String,
          "aCanonicalNameCostsNoExtraAttemptInTheBatch: name")
    check(results[0].convention == "string_or_binary",
          "aCanonicalNameCostsNoExtraAttemptInTheBatch: batch hit is string_or_binary")
    check(SharedKeyOps.ownerResolveAttempts == 0,
          "aCanonicalNameCostsNoExtraAttemptInTheBatch: no owner resolver attempt")
} catch {
    print("FAIL: aCanonicalNameCostsNoExtraAttemptInTheBatch threw \(error)")
    exit(1)
}

// MARK: - 7. An owned item the core batch fails retries through the owner resolver

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    SharedKeyOps.resetOwnerResolveAttempts()
    let results = try SharedKeyOps.decryptNames(
        master: master,
        items: [BatchNameItem(fileId: fileId, nameEncrypted: v["name_encrypted"] as! String)],
        ownedFileIds: [fileId])
    check(results[0].name == v["expected_name"] as! String,
          "anOwnedFailedBatchItemRetriesThroughTheOwnerResolver: name")
    check(results[0].convention == "upper_repair",
          "anOwnedFailedBatchItemRetriesThroughTheOwnerResolver: exact convention")
    check(SharedKeyOps.ownerResolveAttempts == 1,
          "anOwnedFailedBatchItemRetriesThroughTheOwnerResolver: one attempt")
    // Not declared owned: the batch failure is final and never reaches the resolver.
    SharedKeyOps.resetOwnerResolveAttempts()
    let foreign = try SharedKeyOps.decryptNames(
        master: master,
        items: [BatchNameItem(fileId: fileId, nameEncrypted: v["name_encrypted"] as! String)])
    check(foreign[0].name == nil, "anOwnedFailedBatchItemRetriesThroughTheOwnerResolver: undeclared stays failed")
    check(SharedKeyOps.ownerResolveAttempts == 0,
          "anOwnedFailedBatchItemRetriesThroughTheOwnerResolver: undeclared costs no attempt")
} catch {
    print("FAIL: anOwnedFailedBatchItemRetriesThroughTheOwnerResolver threw \(error)")
    exit(1)
}

// MARK: - 8. classifyOwnerContent caps its chunk-0 read at C

final class FakeChunkZeroTransport: ChunkZeroTransport {
    var body: Data
    var declaredLength: Int?
    var throwsError = false
    var calls = 0
    var lastURL = ""
    var lastMaxBytes = -1
    var vendedBytes = 0

    init(body: Data = Data(), declaredLength: Int? = nil) {
        self.body = body
        self.declaredLength = declaredLength
    }

    func fetch(apiUrl: String, fileId: String, token: String, maxBytes: Int) throws -> ChunkZeroResponse {
        calls += 1
        lastURL = "\(apiUrl)/api/v1/files/\(fileId)/chunks/0"
        lastMaxBytes = maxBytes
        if throwsError { throw NSError(domain: "classify", code: 1) }
        if let declaredLength, declaredLength > maxBytes {
            return ChunkZeroResponse(status: 200, contentLength: declaredLength, body: Data(), tooLarge: true)
        }
        if body.count > maxBytes {
            return ChunkZeroResponse(status: 200, contentLength: nil, body: Data(), tooLarge: true)
        }
        vendedBytes = body.count
        return ChunkZeroResponse(status: 200, contentLength: declaredLength, body: body, tooLarge: false)
    }
}

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    SharedKeyOps.ownerConventions.clear()
    let registry = SharedKeyRegistry<FileKeyHandle>()
    check(OwnerContentClassifier.maxChunkZeroBytes == 4 * 1024 * 1024 + 28,
          "classifyReadsAtMostCBytesFromChunks0: C is the pinned 4 MiB chunk plus AEAD overhead")

    // A declared length over C: the body is never read.
    let declared = FakeChunkZeroTransport(declaredLength: OwnerContentClassifier.maxChunkZeroBytes + 1)
    let declaredCode = OwnerContentClassifier(transport: declared).classify(
        master: master, fileId: fileId, objectVersionId: "v-big", createdAt: "2026-06-01T00:00:00Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry)
    check(declaredCode == "string_or_binary", "classifyReadsAtMostCBytesFromChunks0: over-cap length is string_or_binary")
    check(declared.lastURL == "https://api.example.test/api/v1/files/\(fileId)/chunks/0",
          "classifyReadsAtMostCBytesFromChunks0: URL is /chunks/0")
    check(declared.lastMaxBytes == OwnerContentClassifier.maxChunkZeroBytes,
          "classifyReadsAtMostCBytesFromChunks0: cap is handed to the transport")
    check(declared.vendedBytes == 0, "classifyReadsAtMostCBytesFromChunks0: no body read past C")

    // An unbounded (chunked) body over C: also never vended past the cap.
    let chunked = FakeChunkZeroTransport(body: Data(count: OwnerContentClassifier.maxChunkZeroBytes + 64))
    let chunkedCode = OwnerContentClassifier(transport: chunked).classify(
        master: master, fileId: fileId, objectVersionId: "v-chunked", createdAt: "2026-06-01T00:00:00Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry)
    check(chunkedCode == "string_or_binary", "classifyReadsAtMostCBytesFromChunks0: chunked over-cap is string_or_binary")
    check(chunked.vendedBytes == 0, "classifyReadsAtMostCBytesFromChunks0: bounded read stops at C")
} catch {
    print("FAIL: classifyReadsAtMostCBytesFromChunks0 threw \(error)")
    exit(1)
}

// MARK: - 9. A pre-cutover file or a known UpperRepair name costs zero requests

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    SharedKeyOps.ownerConventions.clear()
    let registry = SharedKeyRegistry<FileKeyHandle>()
    let transport = FakeChunkZeroTransport(declaredLength: 1)
    let classifier = OwnerContentClassifier(transport: transport)

    let preCutover = classifier.classify(
        master: master, fileId: fileId, objectVersionId: "v-pre", createdAt: "2026-04-30T23:59:59Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry)
    check(preCutover == "string_or_binary", "classifyIsZeroRequestsForAPreMayFileOrAnUpperRepairName: pre-cutover verdict")
    check(transport.calls == 0, "classifyIsZeroRequestsForAPreMayFileOrAnUpperRepairName: pre-cutover requests")

    SharedKeyOps.ownerConventions.storeName(.upperRepair, epoch: registry.generation, fileId: fileId,
                                             nameEncrypted: "sealed-name")
    let upper = classifier.classify(
        master: master, fileId: fileId, objectVersionId: "v-upper", createdAt: "2026-06-01T00:00:00Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry)
    check(upper == "upper_repair", "classifyIsZeroRequestsForAPreMayFileOrAnUpperRepairName: upper-repair verdict")
    check(transport.calls == 0, "classifyIsZeroRequestsForAPreMayFileOrAnUpperRepairName: upper-repair requests")
} catch {
    print("FAIL: classifyIsZeroRequestsForAPreMayFileOrAnUpperRepairName threw \(error)")
    exit(1)
}

// MARK: - 10. A failed classify is unknown and not cached

do {
    let v = try vector("upper_repair_v1")
    let master = try MasterKeyHandle.fromKeychainBytes(bytes: hex(v["master_key_hex"] as! String))
    let fileId = v["file_id"] as! String
    SharedKeyOps.ownerConventions.clear()
    let registry = SharedKeyRegistry<FileKeyHandle>()
    let failing = FakeChunkZeroTransport()
    failing.throwsError = true
    let failedCode = OwnerContentClassifier(transport: failing).classify(
        master: master, fileId: fileId, objectVersionId: "v-fail", createdAt: "2026-06-01T00:00:00Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry)
    check(failedCode == "unknown", "aFailedClassifyIsUnknownAndNotCached: verdict")
    check(SharedKeyOps.ownerConventions.content(epoch: registry.generation, fileId: fileId,
                                                objectVersionId: "v-fail") == nil,
          "aFailedClassifyIsUnknownAndNotCached: failure not cached")

    let good = FakeChunkZeroTransport(body: hex(v["content_frame_hex"] as! String))
    let classifier = OwnerContentClassifier(transport: good)
    let code = classifier.classify(
        master: master, fileId: fileId, objectVersionId: "v-ok", createdAt: "2026-06-01T00:00:00Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry)
    check(code == "upper_repair", "aFailedClassifyIsUnknownAndNotCached: content convention")
    check(SharedKeyOps.ownerConventions.content(epoch: registry.generation, fileId: fileId,
                                                objectVersionId: "v-ok") != nil,
          "aFailedClassifyIsUnknownAndNotCached: success cached by objectVersionId")
    let calls = good.calls
    check(classifier.classify(
        master: master, fileId: fileId, objectVersionId: "v-ok", createdAt: "2026-06-01T00:00:00Z",
        apiUrl: "https://api.example.test", token: "t", registry: registry) == "upper_repair",
          "aFailedClassifyIsUnknownAndNotCached: cache hit verdict")
    check(good.calls == calls, "aFailedClassifyIsUnknownAndNotCached: cache hit costs no request")
} catch {
    print("FAIL: aFailedClassifyIsUnknownAndNotCached threw \(error)")
    exit(1)
}

print("owner-read-key-test: \(assertions) assertions, 0 failed")
