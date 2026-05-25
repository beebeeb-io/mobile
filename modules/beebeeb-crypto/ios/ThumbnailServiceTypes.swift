import Foundation
import CoreGraphics

public typealias FileId = String

public enum ThumbnailSource: String, Sendable, Equatable {
  case photoKit
  case remote
  case cache
}

public struct ResolvedThumbnail: Sendable, Equatable {
  public let fileURL: URL
  public let source: ThumbnailSource
}

public enum ThumbnailQuality: Sendable, Equatable {
  case continuous(width: Int, jpegQuality: Float)

  static let renderDefault: ThumbnailQuality = .continuous(width: 768, jpegQuality: 0.82)
}

public enum FsmState: Sendable, Equatable {
  case unresolved
  case photoKitPending
  case photoKitResolved(URL)
  case staleLocalId
  case remotePending
  case remoteResolved(URL)
  case remoteFailed(category: FailureCategory)
}

public enum FailureCategory: String, Sendable, Equatable {
  case network5xx
  case network429
  case photoKitMissing
  case decryptFailed
  case generateFailed
  case uploadTooLarge
  case timeout
  case notImplemented
  case unknown
}

public struct CacheKey: Hashable, Sendable {
  public let fileId: FileId
  public let source: ThumbnailSource
}

public enum ThumbnailServiceError: Error, Sendable, Equatable {
  case cancelled
  case notImplemented
  case photoKitMissing(localId: String)
  case remoteUnavailable
  case decryptFailed
  case ioFailure(String)
}
