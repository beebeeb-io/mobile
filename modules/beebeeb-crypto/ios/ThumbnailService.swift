import Foundation
import CoreGraphics
import os.log

public actor ThumbnailService {
  public static let shared = ThumbnailService()

  private var state: [FileId: FsmState] = [:]

  private var cache: [CacheKey: URL] = [:]

  private var inFlight: [FileId: Task<ResolvedThumbnail, Error>] = [:]

  internal var eventEmitter: ThumbnailEventEmitter?

  internal var localIdentifierLookup: ((FileId) -> String?)?

  internal var fileKeyProvider: ((FileId) async -> Data?)?
  internal var apiCredentialsProvider: (() async -> (URL, String)?)?

  private let documentDirectory: URL = {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
  }()

  private let logger = Logger(subsystem: "io.beebeeb.thumbnail", category: "service")

  internal func cacheHit(_ key: CacheKey) -> URL? {
    if let url = cache[key], FileManager.default.fileExists(atPath: url.path) {
      return url
    }
    cache.removeValue(forKey: key)
    return nil
  }

  @discardableResult
  internal func writeCache(_ key: CacheKey, url: URL) -> Bool {
    let current = state[key.fileId] ?? .unresolved
    switch (current, key.source) {
    case (.photoKitResolved, .remote):
      logger.debug("dropped remote cache write for \(key.fileId) — already photoKitResolved")
      return false
    case (.staleLocalId, .photoKit):
      logger.debug("dropped photoKit cache write for \(key.fileId) — staleLocalId")
      return false
    default:
      cache[key] = url
      return true
    }
  }

  internal func setState(_ next: FsmState, for fileId: FileId) {
    state[fileId] = next
  }

  internal func currentState(for fileId: FileId) -> FsmState {
    state[fileId] ?? .unresolved
  }

  internal func diskCacheURL(for fileId: FileId, variant: String = "medium") -> URL? {
    let dir = documentDirectory.appendingPathComponent("beebeeb-thumbnails-v3", isDirectory: true)
    let candidate = dir.appendingPathComponent("\(fileId).\(variant).webp")
    if FileManager.default.fileExists(atPath: candidate.path) {
      return candidate
    }
    let legacy = dir.appendingPathComponent("\(fileId).webp")
    return FileManager.default.fileExists(atPath: legacy.path) ? legacy : nil
  }
}

internal protocol ThumbnailEventEmitter: AnyObject, Sendable {
  func emit(_ name: String, body: [String: Any])
}

extension ThumbnailService {
  public func getThumbnail(
    for fileId: FileId,
    targetSize: CGSize
  ) async throws -> ResolvedThumbnail {
    if let pending = inFlight[fileId] {
      return try await pending.value
    }

    let task: Task<ResolvedThumbnail, Error> = Task { [weak self] in
      guard let self else { throw ThumbnailServiceError.cancelled }
      return try await self.resolve(fileId: fileId, targetSize: targetSize)
    }
    inFlight[fileId] = task
    defer { inFlight[fileId] = nil }

    do {
      return try await task.value
    } catch {
      throw error
    }
  }

  fileprivate func resolve(
    fileId: FileId,
    targetSize: CGSize
  ) async throws -> ResolvedThumbnail {
    let localId = localIdentifierLookup?(fileId) ?? nil

    if let localId {
      let photoKitKey = CacheKey(fileId: fileId, source: .photoKit)
      if let hit = cacheHit(photoKitKey) {
        setState(.photoKitResolved(hit), for: fileId)
        return ResolvedThumbnail(fileURL: hit, source: .photoKit)
      }

      setState(.photoKitPending, for: fileId)
      let result = await PhotoKitResolver.shared.requestImage(
        fileId: fileId,
        localIdentifier: localId,
        targetSize: targetSize
      )

      switch result {
      case .success(let url):
        writeCache(photoKitKey, url: url)
        setState(.photoKitResolved(url), for: fileId)
        return ResolvedThumbnail(fileURL: url, source: .photoKit)

      case .notFound:
        try await handleStaleLocalId(fileId: fileId)

      case .error(let message):
        logger.warning("PhotoKit transient failure for \(fileId): \(message)")
      }
    }

    return try await resolveRemote(fileId: fileId, targetSize: targetSize)
  }
}

extension ThumbnailService {
  fileprivate func handleStaleLocalId(fileId: FileId) async throws {
    setState(.staleLocalId, for: fileId)
    cache.removeValue(forKey: CacheKey(fileId: fileId, source: .photoKit))
    logger.notice("STALE_LOCALID for \(fileId) — emitting onAssociationCleared")
    eventEmitter?.emit("onAssociationCleared", body: [
      "fileId": fileId,
    ])
  }
}

extension ThumbnailService {
  fileprivate func resolveRemote(
    fileId: FileId,
    targetSize _: CGSize
  ) async throws -> ResolvedThumbnail {
    let remoteKey = CacheKey(fileId: fileId, source: .remote)

    if let memHit = cacheHit(remoteKey) {
      setState(.remoteResolved(memHit), for: fileId)
      return ResolvedThumbnail(fileURL: memHit, source: .remote)
    }
    if let diskHit = diskCacheURL(for: fileId) {
      writeCache(remoteKey, url: diskHit)
      setState(.remoteResolved(diskHit), for: fileId)
      return ResolvedThumbnail(fileURL: diskHit, source: .cache)
    }

    setState(.remotePending, for: fileId)

    guard let credentialsProvider = apiCredentialsProvider,
          let credentials = await credentialsProvider() else {
      setState(.remoteFailed(category: .unknown), for: fileId)
      throw ThumbnailServiceError.remoteUnavailable
    }
    let (baseURL, sessionToken) = credentials

    let thumbnailURL = baseURL.appendingPathComponent("api/v1/files/\(fileId)/thumbnail")
    var request = URLRequest(url: thumbnailURL)
    request.httpMethod = "GET"
    request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")

    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      setState(.remoteFailed(category: .network5xx), for: fileId)
      throw ThumbnailServiceError.remoteUnavailable
    }

    guard let http = response as? HTTPURLResponse else {
      setState(.remoteFailed(category: .network5xx), for: fileId)
      throw ThumbnailServiceError.remoteUnavailable
    }
    if http.statusCode == 404 {
      setState(.remoteFailed(category: .unknown), for: fileId)
      throw ThumbnailServiceError.remoteUnavailable
    }
    if http.statusCode == 429 {
      setState(.remoteFailed(category: .network429), for: fileId)
      throw ThumbnailServiceError.remoteUnavailable
    }
    if !(200..<300).contains(http.statusCode) {
      setState(.remoteFailed(category: .network5xx), for: fileId)
      throw ThumbnailServiceError.remoteUnavailable
    }
    guard data.count >= 13 else {
      setState(.remoteFailed(category: .decryptFailed), for: fileId)
      throw ThumbnailServiceError.decryptFailed
    }
    if data.count >= 3, data[0] == 0xFF, data[1] == 0xD8, data[2] == 0xFF {
      setState(.remoteFailed(category: .decryptFailed), for: fileId)
      throw ThumbnailServiceError.decryptFailed
    }
    let nonce = data.prefix(12)
    let ciphertext = data.dropFirst(12)

    guard let keyProvider = fileKeyProvider,
          let fileKey = await keyProvider(fileId) else {
      setState(.remoteFailed(category: .decryptFailed), for: fileId)
      throw ThumbnailServiceError.decryptFailed
    }
    let plaintext: Data
    do {
      plaintext = try BeebeebCryptoBridge.decryptChunk(
        key: fileKey,
        nonce: Data(nonce),
        ciphertext: Data(ciphertext)
      )
    } catch {
      setState(.remoteFailed(category: .decryptFailed), for: fileId)
      throw ThumbnailServiceError.decryptFailed
    }

    let outDir = documentDirectory.appendingPathComponent("beebeeb-thumbnails-v3", isDirectory: true)
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let outURL = outDir.appendingPathComponent("\(fileId).medium.webp")
    do {
      try plaintext.write(to: outURL, options: .atomic)
    } catch {
      setState(.remoteFailed(category: .unknown), for: fileId)
      throw ThumbnailServiceError.ioFailure(error.localizedDescription)
    }

    writeCache(remoteKey, url: outURL)
    setState(.remoteResolved(outURL), for: fileId)
    eventEmitter?.emit("onThumbnailReady", body: [
      "fileId": fileId,
      "source": "remote",
      "uri": outURL.absoluteString,
    ])
    return ResolvedThumbnail(fileURL: outURL, source: .remote)
  }
}

extension ThumbnailService {
  public struct RegenResult: Sendable {
    public let fileId: FileId
    public let success: Bool
    public let category: ThumbnailErrorCategory?
    public let stageTimings: [String: Int]
    public let bytesUploaded: Int
  }

  /// Parse a quality preset string like "w768q082" into (width, quality).
  public static func parseQualityPreset(_ s: String) -> (width: Int, quality: Float) {
    let regex = try? NSRegularExpression(pattern: "^w(\\d{3,4})q(\\d{2,3})$")
    let range = NSRange(s.startIndex..., in: s)
    guard let m = regex?.firstMatch(in: s, options: [], range: range), m.numberOfRanges == 3,
          let wR = Range(m.range(at: 1), in: s), let qR = Range(m.range(at: 2), in: s),
          let w = Int(s[wR]), let q = Int(s[qR]) else {
      return (768, 0.82)
    }
    return (w, Float(q) / 100.0)
  }

  /// Full regeneration pipeline: PhotoKit fetch -> resize+WebP encode -> encrypt -> PUT upload.
  /// Called by ThumbnailWorkerPool for each queued file.
  public func regenerateThumbnail(fileId: String, qualityPreset: String) async throws -> RegenResult {
    var stages: [String: Int] = [:]

    // Stage 1: PhotoKit — resolve local identifier and fetch full image
    let stagePhotoKitStart = Date()
    guard let localId = localIdentifierLookup?(fileId) else {
      throw NSError(domain: "BeebeebPhotoKit", code: 404,
                    userInfo: [NSLocalizedDescriptionKey: "no local identifier mapping for fileId"])
    }
    let preset = Self.parseQualityPreset(qualityPreset)
    let img = try await PhotoKitResolver.shared.requestFullImage(localIdentifier: localId)
    stages["photoKit"] = Int(Date().timeIntervalSince(stagePhotoKitStart) * 1000)

    // Stage 2: Resize + WebP encode
    let stageResizeStart = Date()
    let resized = try BeebeebThumbnailEncoder.encode(
      image: img,
      targetWidth: preset.width,
      quality: CGFloat(preset.quality)
    )
    stages["resize"] = Int(Date().timeIntervalSince(stageResizeStart) * 1000)

    // Stage 3: Encrypt
    let stageEncryptStart = Date()
    let encrypted = try await ThumbnailEncryptUpload.encryptThumbnail(
      fileId: fileId,
      plaintext: resized
    )
    stages["encrypt"] = Int(Date().timeIntervalSince(stageEncryptStart) * 1000)
    if encrypted.count > 64 * 1024 {
      throw NSError(domain: "BeebeebThumbnailGen", code: 413,
                    userInfo: [NSLocalizedDescriptionKey: "encrypted thumb exceeds 64KB cap"])
    }

    // Stage 4: Upload
    let stageUploadStart = Date()
    try await ThumbnailEncryptUpload.put(fileId: fileId, ciphertext: encrypted)
    stages["upload"] = Int(Date().timeIntervalSince(stageUploadStart) * 1000)

    // Invalidate cache so next getThumbnail fetches the new version
    invalidateCacheEntries(fileId: fileId)

    return RegenResult(
      fileId: fileId, success: true, category: nil,
      stageTimings: stages, bytesUploaded: encrypted.count
    )
  }

  /// Legacy overload kept for the existing Expo module bridge signature.
  public func regenerateThumbnail(
    for fileId: FileId,
    quality: ThumbnailQuality
  ) async throws -> RegenResult {
    let preset: String
    switch quality {
    case .continuous(let width, let jpegQuality):
      let q = Int(round(jpegQuality * 100))
      preset = "w\(width)q\(String(format: "%03d", q))"
    }
    return try await regenerateThumbnail(fileId: fileId, qualityPreset: preset)
  }

  func invalidateCacheEntries(fileId: String) {
    cache.removeValue(forKey: CacheKey(fileId: fileId, source: .remote))
  }
}

extension ThumbnailService {
  public func cancelPhotoKitRequest(for fileId: FileId) async {
    await PhotoKitResolver.shared.cancelInFlight(for: fileId)
  }

  public func forgetFile(_ fileId: FileId) {
    state.removeValue(forKey: fileId)
    cache.removeValue(forKey: CacheKey(fileId: fileId, source: .photoKit))
    cache.removeValue(forKey: CacheKey(fileId: fileId, source: .remote))
    inFlight[fileId]?.cancel()
    inFlight.removeValue(forKey: fileId)
  }
}
