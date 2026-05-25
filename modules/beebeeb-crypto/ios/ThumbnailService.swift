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
