import AVFoundation
import ExpoModulesCore
import Foundation
import ImageIO
import FileProvider
import NaturalLanguage
import PDFKit
import Photos
import Security
import SQLite3
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import Vision

private let fileProviderDomainIdentifier = NSFileProviderDomainIdentifier("io.beebeeb.files")
private let fileProviderDisplayName = "Beebeeb"
private let fileProviderDomainSchemaKey = "io.beebeeb.fileProviderDomainSchema"
private let fileProviderDomainSchemaVersion = "replicated-v6-cache-bootstrap"
private let appGroupIdentifier = "group.io.beebeeb.shared"
private let simulatorFileProviderMasterKeyKey = "io.beebeeb.simulatorFileProviderMasterKey"
// Task 1671: alias the canonical `BeebeebKeychainCore` constants rather than
// re-typing the literals — the Share Extension reader was drifted onto
// different, never-written keys for months because its own copy of this
// string was typed independently. See BeebeebKeychainCore.swift's
// `sessionTokenKey` / `apiBaseUrlKey` doc comment.
private let sharedSessionTokenKey = BeebeebKeychainCore.sessionTokenKey
private let sharedAPIBaseURLKey = BeebeebKeychainCore.apiBaseUrlKey
private let fileProviderEnabledKey = "io.beebeeb.fileProvider.enabled"
private let fileProviderTrustedMountKey = "io.beebeeb.fileProvider.trustedMountEnabled"
private let fileProviderAuthRequiredKey = "io.beebeeb.fileProvider.requireDeviceAuth"
private let fileProviderUnlockedUntilKey = "io.beebeeb.fileProvider.unlockedUntilMs"
private let fileProviderEnumeratorStatePrefix = "io.beebeeb.fileProvider.enumerator."
// Task 1593 round 8 (R2) — the "purge epoch" used to live here as an App
// Group UserDefaults counter (`fileProviderPurgeEpochKey`,
// `bumpFileProviderPurgeEpoch`). Removed: `UserDefaults(suiteName:)` is
// backed by `cfprefsd` with no guaranteed-immediate cross-process
// visibility, so a `CacheManager.replaceChildren` write racing this exact
// moment could still read the OLD value even after the bump had "landed"
// from this process's point of view. The epoch now lives in the File
// Provider cache database's own `PRAGMA user_version` — see
// `bumpFileProviderCacheVersion()` below and
// `CacheManager.currentPurgeEpoch()` in the extension target for the full
// rationale. Nothing else referenced this key (grepped clean across both
// Swift targets and JS before removal).

// PHKit picks its own callback queue (often main when the app is foregrounded).
// Hop here as the first line of every PhotoKit completion so the work in the
// closure body never blocks main, consistent with PhotoBackupManager.
private let beebeebCryptoPHKitCallbackQueue = DispatchQueue(
  label: "io.beebeeb.crypto.phkit-callback",
  qos: .utility
)

private let beebeebDngThumbnailQueue = DispatchQueue(
  label: "io.beebeeb.crypto.dng-thumbnail",
  qos: .utility
)

/// Translate a `KeychainError.vaultAuth(reason)` thrown by the primary
/// master-key load into an Expo `Exception` carrying a STABLE machine `code`
/// (`reason.jsCode`) that the JS layer reads to decide retry-vs-surface
/// (task 0882). Any other error passes through unchanged.
private func mapVaultAuthError(_ error: Error) -> Error {
  if let keychainError = error as? KeychainError, case let .vaultAuth(reason) = keychainError {
    return Exception(name: "VaultAuthException", description: reason.message, code: reason.jsCode)
  }
  return error
}

private func decodeBase64(_ value: String, field: String) throws -> Data {
  guard let data = Data(base64Encoded: value) else {
    throw NSError(
      domain: "BeebeebCrypto",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Invalid base64 for \(field)"]
    )
  }
  return data
}

private func fileURL(fromURI uri: String) -> URL {
  if let url = URL(string: uri), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: uri)
}

/// Map a UIImage display orientation to the CGImagePropertyOrientation that
/// Vision's image handler expects, so OCR reads text the right way up even when
/// the source JPEG carries an EXIF orientation tag.
private func cgImagePropertyOrientation(
  from uiOrientation: UIImage.Orientation
) -> CGImagePropertyOrientation {
  switch uiOrientation {
  case .up: return .up
  case .down: return .down
  case .left: return .left
  case .right: return .right
  case .upMirrored: return .upMirrored
  case .downMirrored: return .downMirrored
  case .leftMirrored: return .leftMirrored
  case .rightMirrored: return .rightMirrored
  @unknown default: return .up
  }
}

private func isVideoMediaHint(_ value: String?) -> Bool {
  guard let value = value?.lowercased() else { return false }
  return value.hasPrefix("video/") ||
         value == "com.apple.quicktime-movie" ||
         value == "public.mpeg-4" ||
         value.hasPrefix("public.movie") ||
         value.hasPrefix("public.video")
}

private func generatePhotoLibraryImageThumbnail(
  localIdentifier: String,
  maxSize: Int,
  config: ThumbnailGenerator.Config = .medium
) async throws -> Data {
  let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
  guard let phAsset else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 10,
      userInfo: [NSLocalizedDescriptionKey: "Photo asset not found in library"]
    )
  }

  let image: UIImage = try await withCheckedThrowingContinuation { continuation in
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.isNetworkAccessAllowed = true
    options.isSynchronous = false
    options.resizeMode = .fast

    PHImageManager.default().requestImage(
      for: phAsset,
      targetSize: CGSize(width: maxSize, height: maxSize),
      contentMode: .aspectFit,
      options: options
    ) { result, info in
      beebeebCryptoPHKitCallbackQueue.async {
        let isDegraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
        if isDegraded { return }
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let result {
          continuation.resume(returning: result)
        } else {
          continuation.resume(throwing: NSError(
            domain: "BeebeebThumbnail",
            code: 11,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load photo thumbnail from library"]
          ))
        }
      }
    }
  }

  guard let webpData = ThumbnailGenerator.generate(from: image, config: config) else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 12,
      userInfo: [NSLocalizedDescriptionKey: "Failed to encode photo thumbnail as WebP"]
    )
  }
  return webpData
}

private func generatePhotoLibraryVideoThumbnail(
  localIdentifier: String,
  maxSize: Int,
  config: ThumbnailGenerator.Config = .medium
) async throws -> Data {
  let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
  guard let phAsset else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 13,
      userInfo: [NSLocalizedDescriptionKey: "Video asset not found in library"]
    )
  }

  let avAsset: AVAsset = try await withCheckedThrowingContinuation { continuation in
    let options = PHVideoRequestOptions()
    options.version = .original
    options.isNetworkAccessAllowed = true
    PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { asset, _, info in
      beebeebCryptoPHKitCallbackQueue.async {
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let asset {
          continuation.resume(returning: asset)
        } else {
          continuation.resume(throwing: NSError(
            domain: "BeebeebThumbnail",
            code: 14,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load video asset from library"]
          ))
        }
      }
    }
  }

  let generator = AVAssetImageGenerator(asset: avAsset)
  generator.appliesPreferredTrackTransform = true
  generator.maximumSize = CGSize(width: maxSize, height: maxSize)

  let time = CMTime(seconds: 1.0, preferredTimescale: 600)
  let cgImage: CGImage
  do {
    cgImage = try generator.copyCGImage(at: time, actualTime: nil)
  } catch {
    cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
  }

  guard let webpData = ThumbnailGenerator.generate(from: UIImage(cgImage: cgImage), config: config) else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 15,
      userInfo: [NSLocalizedDescriptionKey: "Failed to encode video thumbnail as WebP"]
    )
  }
  return webpData
}

private final class PreviewDownloadProgress: DownloadProgressCallback, FileProgressCallback, @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private weak var task: URLSessionTask?
  private let requestId: String?
  private let fileId: String
  private let emit: ([String: Any]) -> Void

  // Progress-emission throttle state (guarded by `lock`). The high-frequency stages
  // ("downloading" from URLSession didWriteData, per-chunk "decrypting") fire tens of
  // thousands of times for a multi-GB export; unthrottled that floods the RN bridge +
  // main queue and gets the app memory-watchdog-killed (TestFlight #190). We gate those
  // to at most ~1 event / 150ms OR a whole-percent advance, while ALWAYS emitting the
  // first event of a stage, any stage transition, the final tick, and terminal stages.
  private var lastEmitStage: String = ""
  private var lastEmitPercent: Int = -1
  private var lastEmitAt: Date = .distantPast

  /// Decide (under `lock`) whether this progress event should reach the JS bridge.
  /// - `downloading` / `decrypting` are throttled; everything else (complete/error)
  ///   is always emitted. A stage change always emits and resets the throttle window.
  private func shouldEmit(stage: String, percent: Int, isFinal: Bool) -> Bool {
    lock.lock()
    defer { lock.unlock() }

    // First event of a stage / any stage transition (e.g. downloading→decrypting,
    // →complete, →error): always emit, and reset the window so the next stage starts fresh.
    if stage != lastEmitStage {
      lastEmitStage = stage
      lastEmitPercent = percent
      lastEmitAt = Date()
      return true
    }

    // Non-throttled stages (complete/error and anything unexpected): never suppress.
    guard stage == "downloading" || stage == "decrypting" else { return true }

    // Always emit the final tick of a throttled stage so the banner reaches 100%
    // before it transitions (download-complete → decrypting, decrypt-complete → complete).
    if isFinal {
      lastEmitPercent = percent
      lastEmitAt = Date()
      return true
    }

    let now = Date()
    let elapsedOK = now.timeIntervalSince(lastEmitAt) >= 0.15  // ~150ms
    let percentOK = percent >= lastEmitPercent + 1
    guard elapsedOK || percentOK else { return false }
    lastEmitPercent = percent
    lastEmitAt = now
    return true
  }

  init(requestId: String?, fileId: String, emit: @escaping ([String: Any]) -> Void) {
    self.requestId = requestId
    self.fileId = fileId
    self.emit = emit
  }

  func setTask(_ task: URLSessionTask) {
    lock.lock()
    self.task = task
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let task = task
    lock.unlock()
    task?.cancel()
  }

  func isCancelled() -> Bool {
    lock.lock()
    let value = cancelled
    lock.unlock()
    return value
  }

  func onChunkDecrypted(chunkIndex: UInt32, totalChunks: UInt32) {
    if chunkIndex == 1 || chunkIndex == totalChunks || chunkIndex % 10 == 0 {
      RuntimeTrace.event("preview.native_download.chunk_decrypted", [
        "fileId": fileId,
        "chunkIndex": Int(chunkIndex),
        "totalChunks": Int(totalChunks)
      ])
    }
    emitProgress(stage: "decrypting", chunksCompleted: Int(chunkIndex), chunksTotal: Int(totalChunks))
  }

  func onProgress(chunksCompleted: UInt32, chunksTotal: UInt32) {
    if chunksCompleted == 1 || chunksCompleted == chunksTotal || chunksCompleted % 10 == 0 {
      RuntimeTrace.event("preview.native_download.progress", [
        "fileId": fileId,
        "chunksCompleted": Int(chunksCompleted),
        "chunksTotal": Int(chunksTotal)
      ])
    }
    emitProgress(stage: "decrypting", chunksCompleted: Int(chunksCompleted), chunksTotal: Int(chunksTotal))
  }

  func onComplete(outputPath: String) {
    RuntimeTrace.event("preview.native_download.callback_complete", ["fileId": fileId])
    emitProgress(stage: "complete")
  }

  func onError(error: String) {
    RuntimeTrace.event("preview.native_download.callback_error", [
      "fileId": fileId,
      "error": error
    ])
    emitProgress(stage: "error", extra: ["error": error])
  }

  func emitDownload(bytesWritten: Int64, bytesExpected: Int64) {
    emitProgress(
      stage: "downloading",
      bytesDownloaded: max(0, bytesWritten),
      bytesTotal: bytesExpected > 0 ? bytesExpected : 0
    )
  }

  func emitProgress(
    stage: String,
    bytesDownloaded: Int64? = nil,
    bytesTotal: Int64? = nil,
    chunksCompleted: Int? = nil,
    chunksTotal: Int? = nil,
    extra: [String: Any] = [:]
  ) {
    // Compute the integer percent + final-tick flag for the high-frequency stages so the
    // throttle gate can drop redundant events before they hit the main-queue/RN-bridge emit.
    var percent = 0
    var isFinal = false
    if stage == "downloading" {
      if let bytesTotal, bytesTotal > 0, let bytesDownloaded {
        percent = Int((bytesDownloaded * 100) / bytesTotal)
        isFinal = bytesDownloaded >= bytesTotal
      }
    } else if stage == "decrypting" {
      if let chunksTotal, chunksTotal > 0, let chunksCompleted {
        percent = Int((chunksCompleted * 100) / chunksTotal)
        isFinal = chunksCompleted >= chunksTotal
      }
    }

    guard shouldEmit(stage: stage, percent: percent, isFinal: isFinal) else { return }

    var body: [String: Any] = [
      "requestId": requestId ?? "",
      "fileId": fileId,
      "stage": stage,
    ]
    if let bytesDownloaded { body["bytesDownloaded"] = bytesDownloaded }
    if let bytesTotal { body["bytesTotal"] = bytesTotal }
    if let chunksCompleted { body["chunksCompleted"] = chunksCompleted }
    if let chunksTotal { body["chunksTotal"] = chunksTotal }
    for (key, value) in extra { body[key] = value }
    emit(body)
  }
}

private final class PreviewEncryptedDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private var continuation: CheckedContinuation<(URL, HTTPURLResponse), Error>?
  private var response: HTTPURLResponse?
  private var session: URLSession?
  private let progress: PreviewDownloadProgress

  init(progress: PreviewDownloadProgress) {
    self.progress = progress
  }

  func download(request: URLRequest) async throws -> (URL, HTTPURLResponse) {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
      self.session = session
      let task = session.downloadTask(with: request)
      progress.setTask(task)
      task.resume()
    }
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    progress.emitDownload(bytesWritten: totalBytesWritten, bytesExpected: totalBytesExpectedToWrite)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    response = downloadTask.response as? HTTPURLResponse
    guard let response else {
      continuation?.resume(throwing: NSError(
        domain: "BeebeebPreviewDownload",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Missing download response"]
      ))
      continuation = nil
      return
    }

    let target = FileManager.default.temporaryDirectory
      .appendingPathComponent("beebeeb-preview-\(UUID().uuidString).enc")
    do {
      try FileManager.default.moveItem(at: location, to: target)
      continuation?.resume(returning: (target, response))
    } catch {
      continuation?.resume(throwing: error)
    }
    continuation = nil
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    defer {
      session.invalidateAndCancel()
      self.session = nil
    }
    if let error, continuation != nil {
      continuation?.resume(throwing: error)
      continuation = nil
    }
  }

}

@available(iOS 16.0, *)
private func beebeebFileProviderDomain() -> NSFileProviderDomain {
  NSFileProviderDomain(identifier: fileProviderDomainIdentifier, displayName: fileProviderDisplayName)
}

/// Task 1593 round 7 (F2) — bumped every time this app successfully ADDS
/// the File Provider domain (`registerMountedFileProviderDomain`, i.e. a
/// sign-in re-registering it). Guards a narrow but real race in
/// `removeFileProviderDomainIfRegistered`'s bounded wait: `NSFileProvider
/// Manager.remove`'s completion handler is not cancelled by our 5s
/// `DispatchSemaphore.wait(timeout:)` giving up — the underlying system
/// call keeps running and can call back seconds later. If, in that window,
/// the user signed back in and `registerMountedFileProviderDomain` added
/// the domain again, a since-arriving completion for the OLD `.remove`
/// call would otherwise look like confirmation that removal "worked",
/// while at the OS level the domain the user just re-enabled is the one
/// that actually vanished. `NSLock`-guarded plain `Int`, not an atomic
/// type, to avoid pulling in `os.lock` purely for a counter neither
/// perf-sensitive nor called from a hot path.
private let fileProviderGenerationLock = NSLock()
private var _fileProviderGeneration: Int = 0

@discardableResult
private func bumpFileProviderGeneration() -> Int {
  fileProviderGenerationLock.lock()
  defer { fileProviderGenerationLock.unlock() }
  _fileProviderGeneration &+= 1
  return _fileProviderGeneration
}

private func currentFileProviderGeneration() -> Int {
  fileProviderGenerationLock.lock()
  defer { fileProviderGenerationLock.unlock() }
  return _fileProviderGeneration
}

/// Task 1593 round 10 (reviewer F-a) — SEPARATE from `_fileProviderGeneration`
/// above. That counter is bumped by BOTH a successful domain add
/// (`registerMountedFileProviderDomainLocked`) AND a purge's consent reset
/// (`resetFileProviderShowInFilesConsent`), which is fine for
/// `removeFileProviderDomainIfRegistered`'s F2/R1 stale-remove branch (it
/// independently rechecks consent before ever acting on a bump), but was
/// WRONG for `shouldUndoFileProviderAdd`'s generation-delta check below: two
/// overlapping, both-legitimate calls to `registerMountedFileProviderDomainLocked`
/// each bump the SHARED counter once for their own add, so the second one to
/// finish observes a jump of +2 (its own bump plus the other call's), reads
/// that as "a purge happened while I was adding", and undoes its OWN valid
/// registration — confirmed as a real bug, not a theoretical one (see the
/// task file's round 10 Notes for the concrete before/after trace). This
/// counter is bumped ONLY by an actual purge's consent reset — never by a
/// registration — so a delta here can only ever mean a purge ran, regardless
/// of how many concurrent registrations are also in flight.
private let fileProviderPurgeGenerationLock = NSLock()
private var _fileProviderPurgeGeneration: Int = 0

@discardableResult
private func bumpFileProviderPurgeGeneration() -> Int {
  fileProviderPurgeGenerationLock.lock()
  defer { fileProviderPurgeGenerationLock.unlock() }
  _fileProviderPurgeGeneration &+= 1
  return _fileProviderPurgeGeneration
}

private func currentFileProviderPurgeGeneration() -> Int {
  fileProviderPurgeGenerationLock.lock()
  defer { fileProviderPurgeGenerationLock.unlock() }
  return _fileProviderPurgeGeneration
}

/// Task 1593 round 9 (Codex thread PRRT_kwDOSLX6T86mgrDZ) — pure decision
/// function for `registerMountedFileProviderDomainLocked`'s validate-and-undo
/// step (see that function's doc comment above its call site for the full
/// race), reused by round 10 for the stale-removal restore-add's own
/// validate-and-undo (`removeFileProviderDomainIfRegistered`'s completion,
/// Codex thread PRRT_kwDOSLX6T86mhUiV). Extracted as a free function, with
/// no NSFileProviderManager/UserDefaults access of its own, specifically so
/// a test can drive every branch directly without touching the File
/// Provider APIs — this repo has no macOS-runnable Swift unit harness
/// (rounds 4-8's Notes), so a pure, side-effect-free function is the most
/// directly testable shape available; the structural source-scan tests in
/// `file-provider-purge-hygiene.test.ts` assert this function's body, not
/// just its call sites, so a future edit that weakens either condition
/// fails the test even if no call site is touched.
///
/// `purgeGenerationBeforeAdd`/`purgeGenerationAfterAdd` bracket the
/// just-completed `.add` call, read from the PURGE-only generation counter
/// above (round 10) — NOT the shared add/purge counter round 9 originally
/// used, which false-positived on two concurrent, both-legitimate adds (see
/// that counter's doc comment). Because only an actual purge's consent
/// reset ever bumps this counter, ANY delta between the two reads means a
/// purge ran during the caller's `.add` — no "+1 allowance" arithmetic is
/// needed, unlike the old shared counter, since concurrent registrations no
/// longer move this counter at all. The direct consent-flag recheck is
/// still checked FIRST and independently, because a forced sign-out's OTHER
/// path (`clearFileProviderSharedState`, the ordinary in-app
/// `removeFileProviderAccess()` route) sets both flags false directly
/// without going through `resetFileProviderShowInFilesConsent` and so never
/// bumps this counter at all — the generation check alone would miss that
/// race; the two checks are complementary, not redundant.
private func shouldUndoFileProviderAdd(
  purgeGenerationBeforeAdd: Int,
  purgeGenerationAfterAdd: Int,
  consentTrustedMount: Bool,
  consentEnabled: Bool
) -> Bool {
  guard consentTrustedMount, consentEnabled else {
    return true
  }
  return purgeGenerationAfterAdd != purgeGenerationBeforeAdd
}

/// Task 1593 round 10 (reviewer F-a) — async, FIFO mutual-exclusion gate for
/// `registerMountedFileProviderDomainLocked`. A plain Swift `actor` does NOT
/// give exclusive access across `await` points by itself (actors are
/// reentrant by default: a second call to an actor's method can start
/// running while the first is suspended at an `await` inside it), so simply
/// marking the registration function `actor`-isolated would not have closed
/// the overlapping-registrations race above — two overlapping calls could
/// still both read `getFileProviderDomains()`, both decide `!existed`, and
/// both call `addFileProviderDomain` before either resumes. This is instead
/// the standard actor-backed async lock / "serial queue with an async
/// continuation" shape: the actor's own state mutations (`isBusy`/`waiters`)
/// never themselves `await`, so each one runs atomically with respect to
/// the others (that is the one guarantee a Swift actor DOES give — no two
/// of its methods' non-suspended sections interleave); a caller that finds
/// the gate busy suspends on a `CheckedContinuation` that `release()`
/// resumes in FIFO order once the current holder finishes. Deliberately not
/// a `DispatchSemaphore` here: this gate is acquired/released from `async`
/// Swift Task contexts (the cooperative thread pool), and blocking one of
/// those threads on a semaphore risks starving the pool exactly the way
/// round 6's `new-1` doc comment describes for the UNRELATED Expo serial
/// queue — the fix there was a bound + moving work off-thread, not a
/// semaphore on a cooperative-pool thread, and the same reasoning applies
/// here.
private actor FileProviderRegistrationGate {
  private var isBusy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func acquire() async {
    if !isBusy {
      isBusy = true
      return
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      waiters.append(continuation)
    }
  }

  func release() {
    guard !waiters.isEmpty else {
      isBusy = false
      return
    }
    let next = waiters.removeFirst()
    next.resume()
  }
}

private let fileProviderRegistrationGate = FileProviderRegistrationGate()

/// Task 1593 round 10 (reviewer F-a) — moves `removeFileProviderDomainIfRegistered`'s
/// blocking `DispatchSemaphore.wait` calls (up to 5s + 5s = 10s worst case,
/// round 6 `new-1`) off whatever thread calls this wrapper. The ONLY caller
/// that matters here is `registerMountedFileProviderDomainLocked`'s
/// validate-and-undo branch, an `async` Swift Task running on the
/// cooperative thread pool — calling the semaphore-based function directly
/// from there could block one of that pool's small, fixed number of threads
/// for up to 10 real seconds, which Swift's cooperative-pool design
/// explicitly assumes never happens (it can starve unrelated `async` work
/// system-wide for the duration). `purgePlaintextStorage`'s own call to the
/// synchronous function is NOT changed — it already runs on Expo's ordinary
/// serial `AsyncFunctionDefinition` queue, a normal GCD queue, not the
/// cooperative pool, so it has nothing to move off of.
@available(iOS 16.0, *)
private func removeFileProviderDomainIfRegisteredOffCooperativePool() async -> Bool {
  await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
    DispatchQueue.global(qos: .userInitiated).async {
      continuation.resume(returning: removeFileProviderDomainIfRegistered())
    }
  }
}

@available(iOS 16.0, *)
private func getFileProviderDomains() async throws -> [NSFileProviderDomain] {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[NSFileProviderDomain], Error>) in
    NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: domains)
      }
    }
  }
}

@available(iOS 16.0, *)
private func addFileProviderDomain(_ domain: NSFileProviderDomain) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    NSFileProviderManager.add(domain) { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

@available(iOS 16.0, *)
private func removeFileProviderDomain(_ domain: NSFileProviderDomain) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    NSFileProviderManager.remove(domain) { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

/// Task 1593 round 5 (P1-3) — forced sign-outs (session expiry, account
/// deleted elsewhere, a startup 401, the startup failure fallback, a cold
/// launch with no session) reach `purgePlaintextStorage()` (every sign-out
/// path does, via `signed-out-purge.ts` → `purgeAllPlaintextCaches` →
/// native `purgePlaintextStorage`) but NEVER `removeFileProviderAccess()`,
/// which only the ordinary in-app `signOut()` calls. `PlaintextStorageProtection
/// .purgeAll()` already empties `file-provider-cache.sqlite` in place
/// (round 4, P1-1), but the File Provider DOMAIN stays registered with iOS:
/// Files.app and the system's own File Provider bookkeeping keep whatever
/// they cached from that still-registered domain's enumerator, and a
/// registered domain can be re-enumerated at any time, repopulating rows
/// this purge just erased.
///
/// This removes the domain from every purge, not just the ordinary one, and
/// is idempotent: it checks the domain is actually registered first, so
/// running it after an ordinary sign-out (which already removed it), or
/// when the File Provider was never mounted this install, is a no-op. Uses
/// `.removeAll` — the same call `removeFileProviderAccess` describes,
/// `NSFileProviderManager.remove(domain, mode:completionHandler:)` — rather
/// than `.preserveDirtyUserData`/`.preserveDownloadedUserData`, because this
/// IS the privacy purge: nothing should be preserved. The next sign-in
/// re-registers the domain exactly as it does today —
/// `registerMountedFileProviderDomain` sees `existed == false` and re-adds
/// it, unchanged by this function.
///
/// A removal failure is traced (no user data — just the fact that it
/// failed) and swallowed: this must never block the caller's purge, the same
/// contract `PlaintextStorageProtection.purgeAll()` itself gives every other
/// registered path.
///
/// Task 1593 round 5 (P2-4) — deliberately SYNCHRONOUS (blocks the calling
/// thread on a semaphore while the completion-handler-based FileProvider
/// APIs resolve, same bridging pattern as `KeychainManager`'s LAContext
/// evaluation), NOT `async`, and its only caller (`purgePlaintextStorage`)
/// is equally deliberately not `async` either. Every `AsyncFunction("name") {
/// closure }` registered WITHOUT `async` in its closure type becomes an
/// `AsyncFunctionDefinition` (expo-modules-core
/// `Api/Factories/AsyncFunctionFactories.swift`), and EVERY
/// `AsyncFunctionDefinition` call in the whole app is dispatched onto the
/// same single, private, serial `defaultQueue`
/// (`Core/Functions/AsyncFunctionDefinition.swift:20`,
/// `.async`-dispatched at `:138`) unless it opts out via `.runOnQueue(...)`,
/// which nothing in this file does. `syncFileProviderCache` (this file) is
/// declared the same way, so it and `purgePlaintextStorage` are two calls on
/// that ONE queue: the queue itself guarantees they can never run
/// concurrently, which is what lets `populateFileProviderCache`'s lease
/// check (`file-provider-mount.ts`, round 4 P1-1) treat "the walk has
/// stopped" as "no write can still land after this point" — a real
/// guarantee, not a race with whichever of the two the scheduler happens to
/// run first. Marking either closure `async` instead moves it onto
/// `ConcurrentFunctionDefinition`'s Swift-Task-based path
/// (`Api/Factories/ConcurrentFunctionFactories.swift`) — a DIFFERENT
/// execution context with no ordering relationship to the serial queue at
/// all — which would silently break this invariant while every existing
/// test kept passing (there is no automated check for which
/// `AsyncFunction` overload a given closure resolves to). Do not add
/// `async` to this function, `purgePlaintextStorage`, or
/// `syncFileProviderCache` without re-deriving this guarantee some other
/// way first.
/// Task 1593 round 6 (new-1) — both semaphore waits below used to block with
/// no timeout. Expo dispatches every non-`async` `AsyncFunction` — this one
/// included, per the P2-4 doc comment above — onto ONE shared, private,
/// serial queue. If the system never calls either completion handler back,
/// the unbounded wait blocks that ENTIRE queue forever: every other
/// non-async native call, crypto included, stalls behind it,
/// `purgePlaintextStorage` never resolves, and JS's `refreshAuth` (which
/// awaits `settled()`) hangs sign-in — and because this runs on every
/// signed-out arrival, it recurs on every signed-out cold launch, not once.
/// A 5 s bound (this API call typically resolves in low milliseconds)
/// trades a slow, rare completion for never hanging the queue; a timeout is
/// traced (`storage.purge.failed`, no names or paths — just which stage
/// timed out) and counted as a real purge failure by the caller
/// (`purgePlaintextStorage`) instead of silently hanging.
///
/// Task 1593 round 6 (new-2) — `getDomainsWithCompletionHandler`'s error
/// used to be discarded (`{ result, _ in ... }`). A call that genuinely
/// failed still handed back an empty `result` array, which the
/// "already absent" guard below then read as "domain already absent —
/// clean, not a failure": a real lookup failure silently reported success
/// without having checked anything. The captured error is now traced and
/// treated as a failure before that guard runs.
@available(iOS 16.0, *)
@discardableResult
private func removeFileProviderDomainIfRegistered() -> Bool {
  let domain = beebeebFileProviderDomain()

  let domainsSemaphore = DispatchSemaphore(value: 0)
  var domains: [NSFileProviderDomain] = []
  var domainsError: Error?
  NSFileProviderManager.getDomainsWithCompletionHandler { result, error in
    domains = result
    domainsError = error
    domainsSemaphore.signal()
  }
  guard domainsSemaphore.wait(timeout: .now() + 5) == .success else {
    RuntimeTrace.event("storage.purge.failed", ["stage": "file_provider_domains_timeout"])
    return false
  }

  if let domainsError {
    RuntimeTrace.event("storage.purge.failed", [
      "stage": "file_provider_domains_error",
      "error": domainsError.localizedDescription,
    ])
    return false
  }

  guard domains.contains(where: { $0.identifier == domain.identifier }) else {
    return true // already absent - counts as clean, not a failure
  }

  // Task 1593 round 7 (F2) — captured BEFORE the `.remove` call so the
  // completion handler below can tell whether a NEW sign-in re-registered
  // the domain while this removal was in flight. See
  // `bumpFileProviderGeneration`'s doc comment for the full race.
  let generationBeforeRemove = currentFileProviderGeneration()
  var removeSucceeded = true
  let removeSemaphore = DispatchSemaphore(value: 0)
  NSFileProviderManager.remove(domain, mode: .removeAll) { _, error in
    if let error {
      removeSucceeded = false
      RuntimeTrace.event("storage.purge.file_provider_domain_failed", [
        "error": error.localizedDescription,
      ])
    } else if currentFileProviderGeneration() != generationBeforeRemove {
      // Task 1593 round 7 (F2) — this completion may be firing well after
      // our bounded wait below already gave up (a timeout still returns
      // `false` from this function; the underlying system call is not
      // cancelled by that timeout and can complete on its own schedule).
      // A generation change between the two reads means a NEW sign-in
      // added the domain again in between: the removal that just executed
      // undid that fresh registration, so re-add it — best-effort and
      // fire-and-forget, matching every other completion handler in this
      // function — it must never block, and a failure here is no worse
      // than the domain staying unregistered until the next explicit
      // `registerMountedFileProviderDomain` call (e.g. app foreground).
      //
      // Task 1593 round 8 (R1, security re-review of round 7) — re-adding
      // used to be unconditional on the generation change alone. Real
      // sequence that broke: purge 1's `.remove` times out (its underlying
      // system call keeps running); the user signs BACK in, bumping the
      // generation to G1; the user signs OUT again (purge 2), which resets
      // BOTH "show in Files" consent flags to false (see
      // `resetFileProviderShowInFilesConsent`, which now also bumps the
      // generation itself — belt and suspenders with the check below) and
      // issues its OWN `.remove`. If purge 1's original, still-in-flight
      // completion fires after purge 2 has already reset consent,
      // `currentFileProviderGeneration() != generationBeforeRemove` is true
      // (captured all the way back at G0) and this branch used to re-add
      // the domain unconditionally — mounting Files with consent already
      // off. The NEXT sign-in (possibly a different user on a shared
      // device) then mirrors its session on unlock regardless of consent
      // (`App.tsx`'s unlock-time mirror does not itself recheck it), and
      // the extension starts decrypting that user's names into Files with
      // no consent ever granted. Rechecking BOTH consent flags here — the
      // same check `registerMountedFileProviderDomain` applies immediately
      // before its own add (round 7, new-P1) — means a re-add only ever
      // proceeds when the user currently, actively consents to the mount;
      // never on the strength of a generation bump alone.
      RuntimeTrace.event("storage.purge.file_provider_domain_stale_remove", [:])
      let consentDefaults = sharedDefaults()
      if (consentDefaults?.bool(forKey: fileProviderTrustedMountKey) ?? false),
         sharedBoolDefaultTrue(consentDefaults, key: fileProviderEnabledKey) {
        // Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhUiV, P2) —
        // this restore `.add` used to report success (or a plain add
        // failure) with no re-check of its own: a SUBSEQUENT sign-out can
        // reset consent after the guard just above ran but before this
        // `.add` call's completion lands, and because the stale removal
        // above already made the domain absent, that later purge observes
        // nothing to remove and finishes believing it purged cleanly —
        // then this callback re-registers the domain for a now-signed-out
        // user. Captured BEFORE the `.add`, using the SAME purge-only
        // generation counter and the SAME `shouldUndoFileProviderAdd`
        // decision `registerMountedFileProviderDomainLocked` uses for its
        // own add — a purge landing in this exact window bumps that
        // counter (or resets consent directly), and either one is caught
        // here just as it would be there.
        let purgeGenerationBeforeRestoreAdd = currentFileProviderPurgeGeneration()
        NSFileProviderManager.add(domain) { addError in
          if let addError {
            RuntimeTrace.event("storage.purge.file_provider_domain_restore_failed", [
              "error": addError.localizedDescription,
            ])
            return
          }
          let recheckDefaults = sharedDefaults()
          let purgeGenerationAfterRestoreAdd = currentFileProviderPurgeGeneration()
          if shouldUndoFileProviderAdd(
            purgeGenerationBeforeAdd: purgeGenerationBeforeRestoreAdd,
            purgeGenerationAfterAdd: purgeGenerationAfterRestoreAdd,
            consentTrustedMount: recheckDefaults?.bool(forKey: fileProviderTrustedMountKey) ?? false,
            consentEnabled: sharedBoolDefaultTrue(recheckDefaults, key: fileProviderEnabledKey)
          ) {
            // Best-effort, fire-and-forget — matching every other
            // completion handler in this function; a failure here is no
            // worse than the domain staying mounted until the next
            // explicit purge or registration call re-derives the correct
            // state.
            RuntimeTrace.event("storage.purge.file_provider_domain_stale_restore_undone", [:])
            NSFileProviderManager.remove(domain, mode: .removeAll) { _, undoError in
              if let undoError {
                RuntimeTrace.event("storage.purge.file_provider_domain_stale_restore_undo_failed", [
                  "error": undoError.localizedDescription,
                ])
              }
            }
          }
        }
      } else {
        RuntimeTrace.event("storage.purge.file_provider_domain_stale_remove_consent_off", [:])
      }
    }
    removeSemaphore.signal()
  }
  guard removeSemaphore.wait(timeout: .now() + 5) == .success else {
    RuntimeTrace.event("storage.purge.failed", ["stage": "file_provider_domain_remove_timeout"])
    return false
  }
  return removeSucceeded
}

@available(iOS 16.0, *)
private func signalFileProviderEnumerator(
  domain: NSFileProviderDomain,
  itemIdentifier: NSFileProviderItemIdentifier
) async -> String? {
  guard let manager = NSFileProviderManager(for: domain) else {
    return "File Provider manager unavailable"
  }

  return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
    manager.signalEnumerator(for: itemIdentifier) { error in
      continuation.resume(returning: error?.localizedDescription)
    }
  }
}

@available(iOS 16.0, *)
private func signalBeebeebFileProviderEnumerators() async {
  let domain = beebeebFileProviderDomain()
  let domains = (try? await getFileProviderDomains()) ?? []
  guard domains.contains(where: { $0.identifier == domain.identifier }) else {
    return
  }

  _ = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
  _ = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
}

@available(iOS 16.0, *)
private func fileProviderDomainStatus(
  domain: NSFileProviderDomain,
  registered: Bool,
  added: Bool,
  removedBeforeAdd: Bool = false,
  domainCount: Int,
  cacheDatabaseReady: Bool = fileProviderCacheDatabaseExists(),
  documentStorageURL: String? = nil,
  userVisibleRootURL: String? = nil,
  userVisibleRootError: String? = nil,
  rootEnumerationError: String? = nil,
  workingSetEnumerationError: String? = nil
) -> [String: Any] {
  [
    "supported": true,
    "identifier": domain.identifier.rawValue,
    "displayName": domain.displayName,
    "registered": registered,
    "added": added,
    "removedBeforeAdd": removedBeforeAdd,
    "domainCount": domainCount,
    "cacheDatabaseReady": cacheDatabaseReady,
    "documentStorageURL": documentStorageURL ?? NSNull(),
    "userVisibleRootURL": userVisibleRootURL ?? NSNull(),
    "userVisibleRootError": userVisibleRootError ?? NSNull(),
    "rootEnumerationSignaled": rootEnumerationError == nil,
    "workingSetEnumerationSignaled": workingSetEnumerationError == nil,
    "rootEnumerationError": rootEnumerationError ?? NSNull(),
    "workingSetEnumerationError": workingSetEnumerationError ?? NSNull(),
  ]
}

@available(iOS 16.0, *)
private func fileProviderRootVisibility(domain: NSFileProviderDomain) async -> (String?, String?) {
  guard let manager = NSFileProviderManager(for: domain) else {
    return (nil, "File Provider manager unavailable")
  }

  return await withCheckedContinuation { (continuation: CheckedContinuation<(String?, String?), Never>) in
    manager.getUserVisibleURL(for: .rootContainer) { url, error in
      continuation.resume(returning: (url?.absoluteString, error?.localizedDescription))
    }
  }
}

private func sharedDefaults() -> UserDefaults? {
  UserDefaults(suiteName: appGroupIdentifier)
}

private func sharedBoolDefaultTrue(_ defaults: UserDefaults?, key: String) -> Bool {
  guard let defaults else { return true }
  if defaults.object(forKey: key) == nil {
    return true
  }
  return defaults.bool(forKey: key)
}

private func clearFileProviderSharedState(defaults: UserDefaults?) -> Int {
  defaults?.set(false, forKey: fileProviderEnabledKey)
  defaults?.set(false, forKey: fileProviderTrustedMountKey)
  defaults?.set(true, forKey: fileProviderAuthRequiredKey)
  defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
  // Session token + apiBaseUrl live in the shared Keychain (task 0447),
  // not in App Group UserDefaults. `deleteString` also clears any legacy
  // UserDefaults entries at the same keys so a stale token from a
  // pre-0447 install can't survive a sign-out.
  BeebeebKeychainCore.deleteString(key: sharedSessionTokenKey)
  BeebeebKeychainCore.deleteString(key: sharedAPIBaseURLKey)
  defaults?.removeObject(forKey: simulatorFileProviderMasterKeyKey)
  // Task 1593 f3 (item 2) — this path REMOVES the domain outright (see
  // `removeMountedFileProviderDomain`, its only caller); there is no
  // subsequent add to gate, so `cacheResetOk` is not needed here.
  let (removed, _) = clearFileProviderCacheState(defaults: defaults)
  return removed
}

/// Task 1593 round 6 (new-4, privacy consent) — just the two flags that
/// together grant the File Provider "show in Files" mount
/// (`mountFileProviderAccess` sets both `true` together, and
/// `fileProviderPrivacyState`'s `showInFiles` is their AND), factored out of
/// `clearFileProviderSharedState` so `purgePlaintextStorage` — reached by
/// every sign-out, forced or ordinary — can reset consent on every path
/// without also touching that function's session-token / simulator-key
/// clearing, which is out of scope here (overlaps P0 1594). Called from
/// `purgePlaintextStorage` in addition to (not instead of) the ordinary
/// in-app `removeFileProviderAccess()` → `clearFileProviderSharedState`
/// path, so calling both on an ordinary sign-out just resets the same two
/// flags to `false` twice — harmless.
private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {
  defaults?.set(false, forKey: fileProviderEnabledKey)
  defaults?.set(false, forKey: fileProviderTrustedMountKey)
  // Task 1593 round 8 (R1) — stamp the generation here too, not only on a
  // successful ADD (`registerMountedFileProviderDomainLocked`). A consent
  // reset is exactly the kind of state change a pending stale-`.remove`
  // completion (see that function's R1 fix above) must be able to detect
  // as "something changed since I captured generationBeforeRemove" — belt
  // and suspenders alongside that completion's own direct consent-flag
  // recheck: even a future change to this file that weakens the flag
  // recheck still has a generation mismatch blocking the stale re-add.
  bumpFileProviderGeneration()
  // Task 1593 round 10 (reviewer F-a) — the DEDICATED purge-only counter.
  // This is the only call site that ever bumps it: see its declaration for
  // why `registerMountedFileProviderDomainLocked`'s validate-and-undo and
  // the stale-removal restore-add's validate-and-undo (below) both need a
  // signal that fires ONLY for an actual purge, never for a concurrent,
  // equally-legitimate registration.
  bumpFileProviderPurgeGeneration()
}

/// Task 1593 round 8 (R2, security re-review of round 7's C1) — replaces
/// `bumpFileProviderPurgeEpoch`'s App Group UserDefaults counter (see the
/// removal note at this file's top). Bumps the File Provider cache
/// database's own `PRAGMA user_version` instead, under `BEGIN IMMEDIATE` —
/// a real OS-level write lock on the file (this db is never WAL-mode, see
/// `resetFileProviderCacheDatabase`'s doc comment, so that's the lock the
/// default rollback journal always uses), the SAME lock
/// `CacheManager.replaceChildren` takes with its own `BEGIN IMMEDIATE`
/// before it ever reads `user_version` to decide whether to write. Two
/// processes contending on one file's actual lock is a real synchronisation
/// primitive; two independent UserDefaults suites were not.
///
/// Called FIRST, before domain removal, for the same reason the old
/// UserDefaults bump was: it closes the window for a
/// `CacheManager.replaceChildren` write already in flight when this purge
/// starts. `resetFileProviderCacheDatabase` (this purge's LAST step, via
/// `PlaintextStorageProtection.purgeAll()`) bumps `user_version` again
/// inside its OWN reset transaction — belt and suspenders, so anything that
/// slips past this early bump is still caught by the final one.
///
/// No-op (returns `true`) when the cache database does not exist yet —
/// nothing has been cached for this device, so there is nothing to
/// invalidate; the extension's next `CacheManager.init` creates it fresh
/// at `user_version = 0`.
///
/// Task 1593 f2 (lead design decision: MARKER FIRST; item 3, reviewer
/// follow-up) — `clearsPendingMarker` defaults to `false`: this function has
/// TWO callers with two different relationships to the fail-closed pending
/// marker (`PlaintextStorageProtection.markPurgePending()`'s doc comment).
/// `purgePlaintextStorage`'s own EARLY bump (default, `false`) is NOT "the
/// purge's final epoch bump" — the marker stays set through it on purpose,
/// so an extension write still cannot land anywhere between this early bump
/// and the purge's own end. Task 1593 f4 (item 1b) moved that purge-owned
/// clear out of `PlaintextStorageProtection.resetSQLiteInPlace` (the
/// `DELETE FROM` transaction) and into `PlaintextStorageProtection.purgeAll`
/// itself, which is now the ONLY place a purge is allowed to clear its own
/// marker — and only after its OWN legacy sweep and pinned/temp resweep have
/// also already run, not merely after the reset transaction commits; see
/// `purgeAll`'s doc comment for the full rationale.
/// `registerMountedFileProviderDomainLocked` passes `true`: a
/// registration's successful bump is how a marker left behind by some
/// EARLIER, already-finished purge that never got the chance to clear it
/// itself gets cleared — "how Files comes back after a failed purge".
///
/// When `clearsPendingMarker` is `true`, the clear (`clearPurgePending
/// (nonce:)`'s own compare-then-delete) runs against `pendingNonceAtSnapshot`
/// — a value THIS FUNCTION never reads itself. Task 1593 f7 (Codex P1,
/// PRRT_kwDOSLX6T86mme-b) — f2's original design had this function call
/// `PlaintextStorageProtection.currentPurgePendingNonce()` itself, right
/// here, immediately BEFORE its own `BEGIN IMMEDIATE`. That was still too
/// late: `registerMountedFileProviderDomainLocked` can call this function
/// well after ITS OWN snapshot of `isPurgePending()` (`ensureFileProvider
/// CacheDatabase()` and any schema work run in between) — long enough for a
/// DIFFERENT, concurrently-started `purgePlaintextStorage` to create its own
/// marker in that gap. A fresh read taken here would capture THAT purge's
/// nonce, not "nothing was pending", and then clear it right out from under
/// the still-running purge. The caller must instead capture the nonce at
/// its OWN true snapshot point — the same instant it decides whether a
/// purge was pending at all — and pass that exact value in here. A `nil`
/// (nothing pending at the caller's snapshot) means this function clears
/// nothing, full stop, even if a marker exists by the time it runs; only a
/// nonce that was ALREADY on disk at the caller's snapshot can ever be
/// cleared, and only if it is STILL the value on disk when
/// `clearPurgePending`'s rename-claim compare runs (a DIFFERENT, newer
/// purge re-marking in between still correctly refuses the clear).
@discardableResult
private func bumpFileProviderCacheVersion(
  clearsPendingMarker: Bool = false,
  pendingNonceAtSnapshot: Data? = nil
) -> Bool {
  guard let url = fileProviderCacheDatabaseUrl(),
        FileManager.default.fileExists(atPath: url.path) else {
    return true
  }

  var db: OpaquePointer?
  guard sqlite3_open_v2(
    url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil
  ) == SQLITE_OK, let db else {
    sqlite3_close(db)
    return false
  }
  defer { sqlite3_close(db) }
  // The extension's own `CacheManager` connection may hold a brief lock
  // (its own `BEGIN IMMEDIATE` in `replaceChildren`/`upsert`/`delete`);
  // worth a short wait rather than failing this purge step outright.
  sqlite3_busy_timeout(db, 2000)

  guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else {
    return false
  }
  var current: Int32 = 0
  var stmt: OpaquePointer?
  if sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &stmt, nil) == SQLITE_OK,
     sqlite3_step(stmt) == SQLITE_ROW {
    current = sqlite3_column_int(stmt, 0)
  }
  sqlite3_finalize(stmt)
  guard sqlite3_exec(db, "PRAGMA user_version = \(current &+ 1)", nil, nil, nil) == SQLITE_OK else {
    sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
    return false
  }
  guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
    return false
  }
  if clearsPendingMarker, let pendingNonceAtSnapshot {
    PlaintextStorageProtection.clearPurgePending(nonce: pendingNonceAtSnapshot)
  }
  return true
}

/// Task 1593 f2 (item 4, reviewer follow-up) — a failed registration bump
/// used to be silently discarded (`_ = bumpFileProviderCacheVersion()`),
/// which could leave a real, stale pending marker stuck forever with no
/// registration ever getting a second chance to clear it. One retry after a
/// short delay recovers the SAME class of transient lock contention
/// `bumpFileProviderCacheVersion`'s own 2s busy_timeout usually already
/// absorbs. Mirrors `removeFileProviderDomainIfRegisteredOffCooperativePool`
/// (round 10, reviewer F-a): `registerMountedFileProviderDomainLocked` is an
/// async Swift Task on the cooperative thread pool, so the delay AND the
/// retried, blocking-SQLite bump both run off one of its threads via GCD —
/// not inline, where a slow retry could tie up the pool.
///
/// Task 1593 f5 (reviewer follow-up 1) — `clearsPendingMarker` is now a
/// caller-supplied parameter (the caller's own `cacheResetOk`), not a bare
/// `true` — see the call site's doc comment for why passing a bare `true`
/// was wrong. The retry must use the SAME value the first attempt did:
/// `cacheResetOk` reflects whether a reset actually landed for this
/// REGISTRATION call, which the retry delay does not change.
///
/// Task 1593 f7 (Codex P1, PRRT_kwDOSLX6T86mme-b) — `pendingNonceAtSnapshot`
/// is threaded through the same way, for the same reason: it is the
/// caller's OWN snapshot-time nonce (see `bumpFileProviderCacheVersion`'s
/// doc comment), and the retry must clear against that SAME captured value,
/// never a fresh read taken at retry time either.
@available(iOS 16.0, *)
private func retryFileProviderCacheReadyAndBumpOffCooperativePool(
  clearsPendingMarker: Bool,
  pendingNonceAtSnapshot: Data?
) async -> (ready: Bool, bumped: Bool) {
  await withCheckedContinuation { (continuation: CheckedContinuation<(Bool, Bool), Never>) in
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.25) {
      let ready = ensureFileProviderCacheDatabase()
      let bumped = ready && bumpFileProviderCacheVersion(
        clearsPendingMarker: clearsPendingMarker,
        pendingNonceAtSnapshot: pendingNonceAtSnapshot
      )
      continuation.resume(returning: (ready, bumped))
    }
  }
}

private let fileProviderCacheSchemaStatements = [
  """
  CREATE TABLE IF NOT EXISTS file_cache (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name_encrypted TEXT,
    name_decrypted TEXT,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    is_folder INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    thumbnail_data BLOB,
    thumbnail_nonce BLOB,
    created_at TEXT,
    updated_at TEXT,
    sync_anchor INTEGER NOT NULL DEFAULT 0,
    is_materialized INTEGER NOT NULL DEFAULT 0
  );
  """,
  "CREATE INDEX IF NOT EXISTS idx_file_cache_parent ON file_cache(parent_id);",
  "CREATE INDEX IF NOT EXISTS idx_file_cache_anchor ON file_cache(sync_anchor);",
  """
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  """,
  """
  CREATE TABLE IF NOT EXISTS upload_queue (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    local_path TEXT,
    file_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  """,
]

/// Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoV) — dedicated,
/// protected directory for the SQLite cache; see `PlaintextStorageProtection
/// .migrateFileProviderCacheDatabaseIfNeeded`'s doc comment for why a
/// directory (not just the file) is what actually closes the sidecar-
/// protection gap, via inheritance. Mirrors `AppGroupContainer
/// .cacheDatabaseDirectory` (Constants.swift, the extension target) — this
/// file cannot reference that type directly (it is declared in a different
/// compiled target), so the same literal directory name is duplicated here,
/// same as this file already duplicates the `"file-provider-cache.sqlite"`
/// filename literal independently of `BeebeebConstants.cacheDatabaseFilename`.
private func fileProviderCacheDatabaseDirectory() -> URL? {
  guard let container = FileManager.default
    .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else { return nil }
  let dir = container.appendingPathComponent("file-provider-db", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  PlaintextStorageProtection.protect(dir)
  return dir
}

/// Task 1593 round 11 — every caller of this used to build
/// `container.appendingPathComponent("file-provider-cache.sqlite")` at the
/// App Group root directly (this function, plus two more inline call sites
/// in `syncFileProviderCache` / `removeFileProviderEntries` — now routed
/// through here too, closing the drift the direct inline computation let
/// creep in). Migrates a pre-round-11 install's legacy top-level database
/// into `fileProviderCacheDatabaseDirectory()` the first time this resolves.
private func fileProviderCacheDatabaseUrl() -> URL? {
  guard let container = FileManager.default
    .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else { return nil }
  guard let dir = fileProviderCacheDatabaseDirectory() else { return nil }
  let legacy = container.appendingPathComponent("file-provider-cache.sqlite")
  let migrated = dir.appendingPathComponent("file-provider-cache.sqlite")
  return PlaintextStorageProtection.migrateFileProviderCacheDatabaseIfNeeded(from: legacy, to: migrated)
}

private func ensureFileProviderCacheDatabase() -> Bool {
  guard let url = fileProviderCacheDatabaseUrl() else {
    return false
  }

  var db: OpaquePointer?
  guard sqlite3_open_v2(
    url.path,
    &db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
    nil
  ) == SQLITE_OK, let db else {
    sqlite3_close(db)
    return false
  }
  defer {
    sqlite3_close(db)
  }
  // Task 1593 round 7 (C2) — `SQLITE_OPEN_CREATE` above means the file may
  // have just been created by this very call (a fresh install, or after
  // `clearFileProviderCacheState` unlinked it). Protecting it here, before
  // any schema statement runs, closes the window where `hardenAll()`'s
  // launch-time sweep would have skipped it (the registry entry's
  // `FileManager.default.fileExists` check in `PlaintextStorageProtection
  // .hardenAll()` only picks up a file that already existed at launch) and
  // it would otherwise sit backup-eligible, at the default protection
  // class, until the next cold launch re-runs `hardenAll()`.
  PlaintextStorageProtection.protect(url)
  // Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhUiZ) — see
  // `protectSQLiteSidecars`'s doc comment: the main file's `protect()`
  // above says nothing about its `-journal`/`-wal`/`-shm` siblings.
  PlaintextStorageProtection.protectSQLiteSidecars(url)

  for statement in fileProviderCacheSchemaStatements {
    sqlite3_exec(db, statement, nil, nil, nil)
  }
  return true
}

private func fileProviderCacheDatabaseExists() -> Bool {
  guard let url = fileProviderCacheDatabaseUrl() else {
    return false
  }
  return FileManager.default.fileExists(atPath: url.path)
}

private func resetFileProviderCacheDatabase(at url: URL) -> Bool {
  let fileManager = FileManager.default
  guard fileManager.fileExists(atPath: url.path) else {
    return false
  }

  var db: OpaquePointer?
  guard sqlite3_open_v2(
    url.path,
    &db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
    nil
  ) == SQLITE_OK, let db else {
    sqlite3_close(db)
    try? fileManager.removeItem(at: url)
    return true
  }
  defer {
    sqlite3_close(db)
  }

  // Keep the SQLite file inode stable. The File Provider extension may already
  // have this database open; unlinking it can leave the app writing to one DB
  // while the extension opens another at the same path.
  sqlite3_busy_timeout(db, 2000)
  // Task 1593 round 5 (P1-1, same finding as PlaintextStorageProtection.swift's
  // `resetSQLiteInPlace`) — a plain DELETE leaves the decrypted row bytes
  // readable on the freelist page; `secure_delete = ON` (set before the
  // transaction) zeroes them as they're deleted. This database is never put
  // into WAL mode anywhere in this codebase, so it always uses the default
  // rollback journal — the `PRAGMA wal_checkpoint(TRUNCATE)` this comment
  // used to end with was a silent no-op here. VACUUM after COMMIT is what
  // actually rewrites the file and drops the freed pages instead of just
  // marking them free for reuse. Evidence: _qa-evidence/1593/r5-sqlite-bytes.txt.
  //
  // Task 1593 round 8 (R2) — this reset is "the purge's reset transaction"
  // that bumps `PRAGMA user_version` (the epoch `CacheManager.replaceChildren`
  // / `upsert` / `delete` check — see `bumpFileProviderCacheVersion`'s doc
  // comment for the full rationale). Bumping it INSIDE this same BEGIN/COMMIT
  // means the version change is atomic with the rows actually being gone —
  // a reader can never observe "new version, old rows still present" or
  // vice versa. VACUUM below preserves `user_version` (it rewrites pages,
  // not the header pragma fields — verified directly, see
  // _qa-evidence/1593/r8-epoch-proof.txt), so the reset sequence still ends
  // on the bumped value even after VACUUM runs.
  var nextVersion: Int32 = 1
  var versionStmt: OpaquePointer?
  if sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &versionStmt, nil) == SQLITE_OK,
     sqlite3_step(versionStmt) == SQLITE_ROW {
    nextVersion = sqlite3_column_int(versionStmt, 0) &+ 1
  }
  sqlite3_finalize(versionStmt)

  var ok = sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil) == SQLITE_OK
  ok = ok && sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK
  ok = ok && sqlite3_exec(db, "DELETE FROM file_cache", nil, nil, nil) == SQLITE_OK
  ok = ok && sqlite3_exec(db, "DELETE FROM sync_state", nil, nil, nil) == SQLITE_OK
  ok = ok && sqlite3_exec(db, "DELETE FROM upload_queue", nil, nil, nil) == SQLITE_OK
  ok = ok && sqlite3_exec(db, "PRAGMA user_version = \(nextVersion)", nil, nil, nil) == SQLITE_OK
  if ok {
    ok = sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
  } else {
    sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
  }
  // Task 1593 round 6 (new-3) — same transient-lock reasoning as
  // PlaintextStorageProtection.swift's identical helper: the File Provider
  // extension's own live connection to this exact file can hold it just
  // long enough to turn one VACUUM into a single SQLITE_BUSY, which is
  // worth one short retry rather than counting as a hard purge failure.
  ok = ok && vacuumRetryingOnceOnBusy(db)
  return ok
}

/// See the `new-3` doc comment on the `VACUUM` call site above.
private func vacuumRetryingOnceOnBusy(_ db: OpaquePointer?) -> Bool {
  if sqlite3_exec(db, "VACUUM", nil, nil, nil) == SQLITE_OK {
    return true
  }
  guard sqlite3_errcode(db) == SQLITE_BUSY else {
    return false
  }
  usleep(50_000) // 50ms
  return sqlite3_exec(db, "VACUUM", nil, nil, nil) == SQLITE_OK
}

/// Task 1722 — a Files mount can race the File Provider extension itself:
/// Files launches the extension, the extension opens the shared cache DB,
/// then the main app's force-reset mount tries to prove that same DB was
/// wiped before re-adding the domain. A single transient SQLite lock made
/// `resetFileProviderCacheDatabase` return `false`, so
/// `mayAddFileProviderDomain` correctly refused the add forever while the
/// stale purge marker stayed on disk. Keep that fail-closed gate, but give
/// the reset one bounded second chance before reporting that the cache reset
/// could not be proven.
private func retryFileProviderCacheReset(
  sleepMicros: useconds_t = 250_000,
  reset: () -> Bool
) -> Bool {
  if reset() {
    return true
  }
  RuntimeTrace.event("storage.purge.file_provider_cache_reset_retry", [:])
  if sleepMicros > 0 {
    usleep(sleepMicros)
  }
  let ok = reset()
  if !ok {
    RuntimeTrace.event("storage.purge.file_provider_cache_reset_failed", [:])
  }
  return ok
}

/// Task 1593 f3 (independent security review of eff81b7, item 2) — used to
/// return a bare `Int` (files-removed count) that every caller either
/// discarded (`removeMountedFileProviderDomain`'s
/// `clearFileProviderSharedState`) or discarded with `_ =`
/// (`registerMountedFileProviderDomainLocked`, the forceReset/legacy-
/// migration branch). The COUNT says nothing about whether the one entry
/// that matters most — the cache DATABASE itself — was actually reset:
/// `resetFileProviderCacheDatabase`'s own `false` return (a genuine open/
/// transaction failure on an EXISTING database) was indistinguishable from
/// "there was nothing to reset" (also no increment). `cacheResetOk` below
/// makes that distinction explicit so `registerMountedFileProviderDomainLocked`
/// can refuse to mount on top of an unproven reset (`mayAddFileProviderDomain`'s
/// doc comment).
private func clearFileProviderCacheState(defaults: UserDefaults?) -> (removed: Int, cacheResetOk: Bool) {
  defaults?.dictionaryRepresentation().keys
    .filter { $0.hasPrefix(fileProviderEnumeratorStatePrefix) }
    .forEach { defaults?.removeObject(forKey: $0) }

  var removed = 0
  let fileManager = FileManager.default
  if let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
    for name in ["BeebeebFileProvider", "FileProviderCache"] {
      let url = container.appendingPathComponent(name)
      if fileManager.fileExists(atPath: url.path) {
        try? fileManager.removeItem(at: url)
        removed += 1
      }
    }
  }
  // Task 1593 round 11 — routed through the shared resolver instead of a
  // third inline `container.appendingPathComponent("file-provider-cache
  // .sqlite")` at the App Group root, so a legacy pre-round-11 database
  // gets migrated (and its NEW location reset) here too.
  guard let dbUrl = fileProviderCacheDatabaseUrl() else {
    // Task 1593 f3 (item 2) — cannot even resolve the App Group container
    // to find the database. Nothing this call can prove was reset — fail
    // CLOSED for a forced-reset caller rather than silently reporting ok.
    return (removed, false)
  }
  guard fileManager.fileExists(atPath: dbUrl.path) else {
    // Nothing to reset — the previous account never cached anything here;
    // `ensureFileProviderCacheDatabase()` creates it fresh and empty.
    return (removed, true)
  }
  let cacheResetOk = retryFileProviderCacheReset {
    resetFileProviderCacheDatabase(at: dbUrl)
  }
  if cacheResetOk { removed += 1 }
  return (removed, cacheResetOk)
}

private func fileProviderPrivacyState(defaults: UserDefaults? = sharedDefaults()) -> [String: Any] {
  let trustedMountEnabled = defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false
  let showInFiles = trustedMountEnabled && sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
  let requireDeviceAuth = defaults?.bool(forKey: fileProviderAuthRequiredKey) ?? true
  let unlockedUntilMs = defaults?.double(forKey: fileProviderUnlockedUntilKey) ?? 0
  let cacheDatabaseReady = fileProviderCacheDatabaseExists()
  let locked = !showInFiles

  return [
    "supported": true,
    "showInFiles": showInFiles,
    "trustedMountEnabled": trustedMountEnabled,
    "mounted": showInFiles && cacheDatabaseReady,
    "cacheDatabaseReady": cacheDatabaseReady,
    "requireDeviceAuth": requireDeviceAuth,
    "unlockedUntilMs": unlockedUntilMs,
    "unlockWindowSeconds": 0,
    "locked": locked,
  ]
}

@available(iOS 16.0, *)
private func fileProviderPrivacyState(defaults: UserDefaults?, domains: [NSFileProviderDomain]) -> [String: Any] {
  var state = fileProviderPrivacyState(defaults: defaults)
  let registered = domains.contains { $0.identifier == fileProviderDomainIdentifier }
  let showInFiles = state["showInFiles"] as? Bool ?? false
  state["registered"] = registered
  state["domainCount"] = domains.count
  let cacheDatabaseReady = state["cacheDatabaseReady"] as? Bool ?? false
  state["mounted"] = showInFiles && registered && cacheDatabaseReady
  state["locked"] = !showInFiles || !registered || !cacheDatabaseReady
  return state
}

@available(iOS 16.0, *)
private func currentFileProviderDomainStatus() async -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domains = (try? await getFileProviderDomains()) ?? []
  let registered = domains.contains { $0.identifier == domain.identifier }
  return fileProviderDomainStatus(
    domain: domain,
    registered: registered,
    added: false,
    domainCount: domains.count
  )
}

/// Task 1593 round 10 (reviewer F-a) — thin public entry point. All the
/// actual registration logic lives in `registerMountedFileProviderDomainLocked`
/// below; this wrapper's only job is to serialize concurrent callers through
/// `fileProviderRegistrationGate` (see its doc comment for why overlapping,
/// both-legitimate registrations needed this — the shared generation
/// counter's false-positive undo, fixed independently above, was a SYMPTOM;
/// this gate removes the interleaving itself). Every real call site
/// (`registerFileProviderDomain`, `resetFileProviderDomain`,
/// `mountFileProviderAccess`) already calls this exact name, so no caller
/// needed to change.
@available(iOS 16.0, *)
private func registerMountedFileProviderDomain(
  defaults: UserDefaults?,
  forceReset: Bool = false
) async throws -> [String: Any] {
  await fileProviderRegistrationGate.acquire()
  do {
    let result = try await registerMountedFileProviderDomainLocked(defaults: defaults, forceReset: forceReset)
    await fileProviderRegistrationGate.release()
    return result
  } catch {
    await fileProviderRegistrationGate.release()
    throw error
  }
}

/// Task 1593 f3 (independent security review of eff81b7, item 2) — pure
/// decision, extracted so it can be exhaustively (and mutation-)tested
/// without driving the File Provider framework. Whether
/// `registerMountedFileProviderDomainLocked` may proceed to
/// `addFileProviderDomain`.
///
/// `forceReset` is the caller explicitly asking for a clean mount (account
/// switch / an in-app "reset Files"). If the cache reset THIS call
/// triggered (or its own epoch bump) did not PROVABLY succeed, the
/// previous account's decrypted names can still be sitting in the cache
/// database — mounting on top of that would show them to whoever is
/// signed in now. Refuse.
///
/// Independently: `purgePending` (captured by the caller as
/// `purgePendingBeforeBump`, `PlaintextStorageProtection.isPurgePending()`
/// read BEFORE this call's own bump could clear it — task 1593 f4 item 2,
/// see the call site's doc comment for why reading it any later is unsafe)
/// means a fail-closed marker — this call's own, or some OTHER purge's — was
/// still up when this call started. Registration is the one path allowed to
/// clear a marker an EARLIER, already-finished purge left stuck
/// (`bumpFileProviderCacheVersion`'s doc comment: "how Files comes back
/// after a failed purge") — but only once ITS OWN reset + bump (whichever
/// of the two this call actually attempted) have BOTH landed; adding while
/// still pending, without proof of that, risks the add itself racing a
/// purge that has not finished.
///
/// `cacheResetOk` is `true` when no reset was attempted this call AND no
/// purge was pending at the start of the call — nothing to have failed. A
/// purge pending with no reset attempted (task 1593 f4 item 2) sets it
/// `false` instead of leaving it at that default: the cache database may
/// still hold exactly the rows the in-flight purge exists to remove, and
/// this call has no reset of its own to point to as proof otherwise.
private func mayAddFileProviderDomain(
  forceReset: Bool,
  purgePending: Bool,
  cacheResetOk: Bool,
  cacheVersionBumped: Bool
) -> Bool {
  if forceReset, !(cacheResetOk && cacheVersionBumped) {
    return false
  }
  if purgePending, !(cacheResetOk && cacheVersionBumped) {
    return false
  }
  return true
}

@available(iOS 16.0, *)
private func registerMountedFileProviderDomainLocked(
  defaults: UserDefaults?,
  forceReset: Bool = false
) async throws -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domainsBefore = try await getFileProviderDomains()
  let existed = domainsBefore.contains { $0.identifier == domain.identifier }
  let needsLegacyMigration = existed && defaults?.string(forKey: fileProviderDomainSchemaKey) != fileProviderDomainSchemaVersion

  // Task 1593 f4 (item 2, Codex thread PRRT_kwDOSLX6T86mknXP) — captured
  // BEFORE the cache-database-ready check and its epoch bump below can
  // touch it, and BEFORE that bump's own conditional clear (see the f5 doc
  // comment further down) can run. The OLD code read
  // `PlaintextStorageProtection.isPurgePending()` fresh at
  // the `mayAddFileProviderDomain` call site below, AFTER that bump — so
  // whenever this call's own bump cleared a marker (its nonce still matched
  // what THIS call captured, because under f4's item 1b a purge now only
  // clears its own marker at the very END of `purgeAll`, not right after
  // its reset's own commit — a much wider window than before), the guard
  // read `purgePending: false` even though the purge that marker belonged
  // to had NOT actually finished sweeping the cache yet. Capturing here
  // instead means the guard sees the true pre-bump state.
  // Task 1593 f7 (Codex P1, PRRT_kwDOSLX6T86mme-b) — `purgePendingNonceAtSnapshot`
  // below is captured at this SAME snapshot point, before
  // `ensureFileProviderCacheDatabase` or the bump further down can run.
  // f2's original design read this nonce freshly INSIDE
  // `bumpFileProviderCacheVersion`, right before its own `BEGIN IMMEDIATE`
  // — well after this snapshot, so a marker created by a DIFFERENT,
  // concurrently-started purge in that gap would be captured and cleared
  // as if it were this call's own to clear. This registration may only
  // ever clear a marker that was ALREADY pending when it started (or find
  // nothing pending, `nil`) — never one that appears afterwards — so the
  // nonce is captured here, at the same instant as `purgePendingBeforeBump`
  // itself, and threaded through unchanged to every bump attempt below.
  // See `bumpFileProviderCacheVersion`'s doc comment for the full race.
  //
  // Task 1593 f8 (Codex P1, PRRT_kwDOSLX6T86mm-UP) — f7 still captured
  // `purgePendingBeforeBump` and `purgePendingNonceAtSnapshot` from TWO
  // SEPARATE reads: `PlaintextStorageProtection.isPurgePending()` (a plain
  // `fileExists` check) immediately followed by a SECOND, independent
  // `currentPurgePendingNonce()` call. "Immediately" is not "atomically":
  // a `markPurgePending()` landing in the (arbitrarily small, but nonzero)
  // gap between those two calls made the FIRST read observe "nothing
  // pending" — so `purgePendingBeforeBump == false`, and `cacheResetOk`
  // above never took the `else if purgePendingBeforeBump { cacheResetOk =
  // false }` branch — while the SECOND read, a moment later, picked up
  // that brand-new purge's own nonce regardless. That nonce then flowed,
  // unexamined, into `bumpFileProviderCacheVersion(clearsPendingMarker:
  // cacheResetOk /* == true */, pendingNonceAtSnapshot:)` below, which
  // cleared it the instant this call's own bump committed — wiping out a
  // DIFFERENT purge's marker while that purge was still mid-flight, the
  // exact failure f7 believed it had already closed one call frame up.
  //
  // Fixed by reading the marker exactly ONCE:
  // `PlaintextStorageProtection.purgePendingSnapshot()` returns a single
  // `PurgePendingSnapshot` (`.none` / `.nonce(Data)` / `.unreadable`) from
  // one atomic `open()`/`read()` pair, and `purgePendingBeforeBump` /
  // `purgePendingNonceAtSnapshot` below are both DERIVED from that one
  // value — never from two independently-timed calls again. A marker
  // that exists but could not be read in full (`.unreadable`) is treated
  // as pending (`isPending == true`, fails closed) with NO nonce this call
  // could ever legitimately clear (`clearableNonce == nil`) — see
  // `PurgePendingSnapshot`'s own doc comment (`PlaintextStorageProtection.swift`).
  let purgePendingSnapshot = PlaintextStorageProtection.purgePendingSnapshot()
  let purgePendingBeforeBump = purgePendingSnapshot.isPending
  let purgePendingNonceAtSnapshot = purgePendingSnapshot.clearableNonce

  var cacheResetOk = true
  if forceReset || needsLegacyMigration {
    if existed {
      try await removeFileProviderDomain(domain)
    }
    cacheResetOk = clearFileProviderCacheState(defaults: defaults).cacheResetOk
  } else if purgePendingBeforeBump {
    // Task 1593 f4 (item 2) — a purge was mid-flight when this call started
    // and nothing here was asked to reset anything. `cacheResetOk`'s
    // ordinary "true when no reset was attempted — nothing to have failed"
    // meaning does not hold in this specific case: there IS something that
    // could still be wrong — the rows currently in the cache database may
    // be exactly the ones that in-flight purge exists to remove, and this
    // call has no way to prove they already are not. Deliberately does NOT
    // run an unrequested reset here (that would delete/recreate the whole
    // cache database for a call that never asked for one, per the brief) —
    // marking the reset as unproven is enough: `mayAddFileProviderDomain`'s
    // existing `purgePending, !(cacheResetOk && cacheVersionBumped)` guard
    // below already refuses the add whenever `cacheResetOk` is `false`.
    cacheResetOk = false
  }

  // Task 1593 f3 (item 2) — ensure + bump the cache DB's own epoch BEFORE
  // ever deciding whether to add the domain. Previously this ran AFTER the
  // add block below, so a failed reset/bump was only ever logged — the
  // domain had already been mounted by the time anyone noticed. Runs
  // unconditionally on every call — the bump itself (and the epoch
  // invalidation it provides) is needed regardless of whether the add ends
  // up refused.
  //
  // Task 1593 f5 (reviewer follow-up 1) — `clearsPendingMarker` is now
  // `cacheResetOk`, not a bare `true`. A bare `true` cleared the marker
  // whenever THIS call's bump committed, with no regard for whether this
  // call actually proved the cache safe: a call that hit `else if
  // purgePendingBeforeBump { cacheResetOk = false }` above (a purge is
  // mid-flight; nothing here reset it) still cleared that SAME purge's own
  // marker via its bump — even though `mayAddFileProviderDomain` below then
  // correctly refused the add on that very same `cacheResetOk`. The marker
  // exists to protect exactly the domain-add decision that was being
  // refused, so clearing it out from under a refused add defeated the
  // point. `cacheResetOk` is true only when no reset was needed (no purge
  // pending) or a reset this call attempted actually landed
  // (`forceReset`/`needsLegacyMigration`'s own `clearFileProviderCacheState`
  // call) — matching `mayAddFileProviderDomain`'s own doc comment above:
  // "Registration is the one path allowed to clear a marker an EARLIER,
  // already-finished purge left stuck — but only once ITS OWN reset ...
  // [has] landed." Threaded into the retry below too, so a transient-lock
  // retry can't regress back to the unconditional clear.
  var cacheReady = ensureFileProviderCacheDatabase()
  var cacheVersionBumped = cacheReady && bumpFileProviderCacheVersion(
    clearsPendingMarker: cacheResetOk,
    pendingNonceAtSnapshot: purgePendingNonceAtSnapshot
  )
  if !cacheReady || !cacheVersionBumped {
    (cacheReady, cacheVersionBumped) = await retryFileProviderCacheReadyAndBumpOffCooperativePool(
      clearsPendingMarker: cacheResetOk,
      pendingNonceAtSnapshot: purgePendingNonceAtSnapshot
    )
  }
  if !cacheReady || !cacheVersionBumped {
    RuntimeTrace.event("storage.purge.failed", [
      "stage": cacheReady ? "registration_cache_version_bump" : "registration_cache_not_ready",
    ])
  }

  // Task 1593 f9 (reviewer F1) — an `.unreadable` marker snapshot carries no
  // nonce `bumpFileProviderCacheVersion`'s ordinary clear (just above) could
  // ever compare against, so it would otherwise sit stuck until some later,
  // unrelated purge's own bump happened to clear whatever then occupied the
  // live path. Safe to remove unconditionally here, and ONLY here: this
  // specific call just proved (`forceReset`, `cacheResetOk`,
  // `cacheVersionBumped` — all three) that its own reset wiped the cache
  // database and its own bump re-versioned it, so no purge this marker
  // could have belonged to still has unflushed work outstanding against it.
  // See `PlaintextStorageProtection.clearUnreadablePurgePendingMarker()`'s
  // doc comment (PlaintextStorageProtection.swift) for the full rationale,
  // including why `markPurgePending()`'s f9 atomic-rename fix (same file as
  // that doc comment, NOT this one) is a precondition for this being safe.
  if forceReset, cacheResetOk, cacheVersionBumped, case .unreadable = purgePendingSnapshot {
    PlaintextStorageProtection.clearUnreadablePurgePendingMarker()
  }

  if !existed || forceReset || needsLegacyMigration {
    // Task 1593 f3 (item 2) — refuse the add outright when it is not safe:
    // see `mayAddFileProviderDomain`'s doc comment. Reports the FRESH
    // status (never a fabricated success) so JS sees `registered: false`
    // and Settings shows Files could not be turned on.
    guard mayAddFileProviderDomain(
      forceReset: forceReset,
      purgePending: purgePendingBeforeBump,
      cacheResetOk: cacheResetOk,
      cacheVersionBumped: cacheVersionBumped
    ) else {
      RuntimeTrace.event("storage.purge.file_provider_domain_add_refused", [:])
      return await currentFileProviderDomainStatus()
    }
    // Task 1593 round 7 (new P1, Codex auto re-review of 117e11e) — this
    // whole function is `async` (Swift Task concurrency,
    // `ConcurrentFunctionDefinition`), NOT on Expo's shared serial
    // `AsyncFunctionDefinition` queue that `purgePlaintextStorage` /
    // `removeFileProviderDomainIfRegistered` deliberately stay on (see the
    // extensive doc comment on that function) — the two paths have NO
    // ordering relationship. A forced sign-out's purge can therefore run
    // its `resetFileProviderShowInFilesConsent` + domain removal entirely
    // in between this function reading `getFileProviderDomains()` above
    // and this `addFileProviderDomain` call below, leaving Files mounted
    // and consent flags back on for an app that just signed out. Rechecking
    // the CURRENT consent flags immediately before the add — not just
    // trusting the caller's own check moments earlier — catches that
    // window: every real caller (`registerFileProviderDomain`,
    // `resetFileProviderDomain`, `mountFileProviderAccess`) already sets or
    // confirms both flags true right before calling this function, so this
    // recheck is a no-op in the non-racing case and only refuses the add
    // when a purge's consent reset landed inside the race window.
    guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false),
          sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
    else {
      return await currentFileProviderDomainStatus()
    }
    // Task 1593 round 9 (Codex thread PRRT_kwDOSLX6T86mgrDZ, P1) —
    // "Serialize the consent check with domain addition". Fresh evidence on
    // top of round 7b's new-P1 fix (the guard immediately above): the
    // recheck happening right before `addFileProviderDomain` does not make
    // the check-then-add atomic. A forced sign-out can still start AFTER
    // this guard passes but BEFORE (or while) `addFileProviderDomain`
    // actually runs, reset consent, observe the domain absent (our add
    // hasn't landed yet), and finish — then this suspended add resumes and
    // mounts the domain for a now-signed-out user.
    //
    // LEAD DECISION (task 1593 Notes, round 9): do not build a blocking
    // wait here. `registerMountedFileProviderDomainLocked` is a Swift Task
    // (`ConcurrentFunctionDefinition`); the purge's consent-reset-then-
    // remove sequence deliberately stays on Expo's separate shared serial
    // `AsyncFunctionDefinition` queue (see `removeFileProviderDomainIfRegistered`'s
    // P2-4 doc comment) so that neither native call can ever hang behind a
    // completion handler that never fires (round 6, new-1) — coordinating
    // the two with a shared lock would reintroduce exactly that hang risk.
    // Instead: validate-and-undo. Capture the PURGE-only generation counter
    // immediately before the add (bracketing exactly the window the race
    // needs), let the add complete, then re-check BOTH the live consent
    // flags AND that counter. If consent is off, or a purge's
    // `resetFileProviderShowInFilesConsent` ran inside that window, undo
    // immediately — via `removeFileProviderDomainIfRegisteredOffCooperativePool`
    // (round 10, reviewer F-a: this call runs on the cooperative thread
    // pool, so the underlying semaphore-based removal must not block one of
    // its threads directly — see that wrapper's doc comment) — and report
    // the FRESH domain status, never the success this add technically
    // achieved.
    //
    // Task 1593 round 10 (reviewer F-a) — this used to read/write the SAME
    // generation counter `registerMountedFileProviderDomainLocked`'s own
    // successful adds bump (`bumpFileProviderGeneration`/
    // `currentFileProviderGeneration`), which meant two overlapping,
    // both-legitimate calls to THIS function each bumped it once for their
    // own add — the second call to finish saw a jump bigger than its own
    // +1, read that as "a purge raced me", and undid its own valid
    // registration. Reading the dedicated PURGE-only counter instead (see
    // its declaration) means concurrent registrations never move this
    // check's inputs at all — only an actual purge does, in either
    // observable form (the flags, or the counter). The `registerMounted
    // FileProviderDomain` wrapper above also now serializes calls to this
    // function entirely, which independently prevents two registrations
    // from interleaving in the first place; this fix stands on its own even
    // without that gate, since a purge running concurrently with a single,
    // un-overlapped registration is a real, still-possible race the gate
    // does nothing about.
    let purgeGenerationBeforeAdd = currentFileProviderPurgeGeneration()
    try await addFileProviderDomain(domain)
    // Task 1593 round 7 (F2) — unchanged: still bumped on every successful
    // add for `removeFileProviderDomainIfRegistered`'s OWN stale-remove
    // detection (a completely different question — "did a NEW sign-in
    // re-add the domain while I was removing it?" — answered correctly by
    // the shared counter moving at all, with no false-positive risk there
    // because that branch independently rechecks consent before acting).
    bumpFileProviderGeneration()
    let purgeGenerationAfterAdd = currentFileProviderPurgeGeneration()
    if shouldUndoFileProviderAdd(
      purgeGenerationBeforeAdd: purgeGenerationBeforeAdd,
      purgeGenerationAfterAdd: purgeGenerationAfterAdd,
      consentTrustedMount: defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false,
      consentEnabled: sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
    ) {
      RuntimeTrace.event("storage.purge.file_provider_domain_add_undone", [:])
      _ = await removeFileProviderDomainIfRegisteredOffCooperativePool()
      return await currentFileProviderDomainStatus()
    }
  }
  // Task 1593 f3 (item 2) — `cacheReady`/`cacheVersionBumped` were already
  // computed ABOVE, before the add-decision guard (see that block's doc
  // comment for why this moved up from here).
  defaults?.set(fileProviderDomainSchemaVersion, forKey: fileProviderDomainSchemaKey)
  defaults?.synchronize()

  let rootError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
  let workingSetError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
  let manager = NSFileProviderManager(for: domain)
  let documentStorageURL = manager?.documentStorageURL.absoluteString
  let (userVisibleRootURL, userVisibleRootError) = await fileProviderRootVisibility(domain: domain)
  let domainsAfter = try await getFileProviderDomains()
  let registered = domainsAfter.contains { $0.identifier == domain.identifier }

  return fileProviderDomainStatus(
    domain: domain,
    registered: registered,
    added: !existed || forceReset || needsLegacyMigration,
    removedBeforeAdd: (forceReset && existed) || needsLegacyMigration,
    domainCount: domainsAfter.count,
    cacheDatabaseReady: cacheReady,
    documentStorageURL: documentStorageURL,
    userVisibleRootURL: userVisibleRootURL,
    userVisibleRootError: userVisibleRootError,
    rootEnumerationError: rootError,
    workingSetEnumerationError: workingSetError
  )
}

@available(iOS 16.0, *)
private func removeMountedFileProviderDomain(defaults: UserDefaults?) async throws -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domainsBefore = try await getFileProviderDomains()
  let existed = domainsBefore.contains { $0.identifier == domain.identifier }
  if existed {
    try await removeFileProviderDomain(domain)
  }
  _ = clearFileProviderSharedState(defaults: defaults)
  defaults?.synchronize()
  let domainsAfter = try await getFileProviderDomains()

  return fileProviderDomainStatus(
    domain: domain,
    registered: false,
    added: false,
    removedBeforeAdd: existed,
    domainCount: domainsAfter.count
  )
}

// All crypto runs through `BeebeebCryptoBridge`, which wraps the UniFFI
// bindings shipped in `BeebeebCore.xcframework` (linked via the
// `withUniffiBridge` config plugin).
public class BeebeebCryptoModule: Module {
  // ── Opaque master key handle registry ──────────────────────────────────
  //
  // JS holds only a numeric handle ID. All crypto operations pass the handle
  // to native, which resolves it to the real MasterKeyHandle. Raw key bytes
  // never cross the bridge after initial keychain load.
  private var masterKeyHandles: [Int: MasterKeyHandle] = [:]
  private var nextHandleId: Int = 1
  private let previewDownloadLock = NSLock()
  private var previewDownloadCancellations: [String: PreviewDownloadProgress] = [:]
  private let previewProgressLock = NSLock()
  private var previewProgressSnapshots: [String: [String: Any]] = [:]
  /// Live native manual uploads keyed by requestId (task 1310) — polled by JS.
  private let uploadProgressLock = NSLock()
  private var uploadProgressEntries: [String: NativeUploadProgress] = [:]

  /// Store a MasterKeyHandle and return its opaque numeric ID.
  private func storeHandle(_ handle: MasterKeyHandle) -> Int {
    let id = nextHandleId
    nextHandleId += 1
    masterKeyHandles[id] = handle
    return id
  }

  /// Retrieve a MasterKeyHandle by its opaque ID.
  private func getHandle(_ id: Int) throws -> MasterKeyHandle {
    guard let handle = masterKeyHandles[id] else {
      throw NSError(
        domain: "BeebeebCrypto",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid master key handle ID: \(id)"]
      )
    }
    return handle
  }

  private func storePreviewDownloadCancellation(
    _ cancellation: PreviewDownloadProgress,
    requestId: String?
  ) {
    guard let requestId, !requestId.isEmpty else { return }
    previewDownloadLock.lock()
    previewDownloadCancellations[requestId] = cancellation
    previewDownloadLock.unlock()
  }

  private func removePreviewDownloadCancellation(requestId: String?) {
    guard let requestId, !requestId.isEmpty else { return }
    previewDownloadLock.lock()
    previewDownloadCancellations.removeValue(forKey: requestId)
    previewDownloadLock.unlock()
  }

  private func cancelPreviewDownload(requestId: String) -> Bool {
    previewDownloadLock.lock()
    let cancellation = previewDownloadCancellations[requestId]
    previewDownloadLock.unlock()
    cancellation?.cancel()
    return cancellation != nil
  }

  private func storePreviewProgress(_ requestId: String, _ body: [String: Any]) {
    guard !requestId.isEmpty else { return }
    previewProgressLock.lock()
    previewProgressSnapshots[requestId] = body
    previewProgressLock.unlock()
  }

  private func readPreviewProgress(_ requestId: String) -> [String: Any]? {
    guard !requestId.isEmpty else { return nil }
    previewProgressLock.lock()
    let snapshot = previewProgressSnapshots[requestId]
    previewProgressLock.unlock()
    return snapshot
  }

  private func storeUploadProgress(_ progress: NativeUploadProgress) {
    uploadProgressLock.lock()
    uploadProgressEntries[progress.requestId] = progress
    uploadProgressLock.unlock()
  }

  private func readUploadProgress(_ requestId: String) -> [String: Any]? {
    uploadProgressLock.lock()
    let entry = uploadProgressEntries[requestId]
    uploadProgressLock.unlock()
    return entry?.currentSnapshot()
  }

  private func removeUploadProgress(_ requestId: String) {
    uploadProgressLock.lock()
    uploadProgressEntries.removeValue(forKey: requestId)
    uploadProgressLock.unlock()
  }

  private func cancelUpload(_ requestId: String) -> Bool {
    uploadProgressLock.lock()
    let entry = uploadProgressEntries[requestId]
    uploadProgressLock.unlock()
    entry?.cancel()
    return entry != nil
  }

  private func clearPreviewProgress(_ requestId: String) {
    guard !requestId.isEmpty else { return }
    previewProgressLock.lock()
    previewProgressSnapshots.removeValue(forKey: requestId)
    previewProgressLock.unlock()
  }

  private func splitEncryptedPreviewFile(
    encryptedUrl: URL,
    outputDir: URL,
    chunkCount: Int,
    originalSize: Int,
    plaintextChunkSize: Int
  ) throws -> [String] {
    guard chunkCount > 0 else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Invalid chunk count"]
      )
    }
    guard originalSize > 0, plaintextChunkSize > 0 else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Invalid download size metadata"]
      )
    }

    let chunkOverhead = 28
    let handle = try FileHandle(forReadingFrom: encryptedUrl)
    defer {
      try? handle.close()
    }

    var paths: [String] = []
    for index in 0..<chunkCount {
      let isLast = index == chunkCount - 1
      let plaintextSize = chunkCount == 1
        ? originalSize
        : (isLast ? originalSize - plaintextChunkSize * (chunkCount - 1) : plaintextChunkSize)
      guard plaintextSize > 0 else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 4,
          userInfo: [NSLocalizedDescriptionKey: "Invalid chunk size"]
        )
      }
      let encryptedChunkSize = plaintextSize + chunkOverhead
      let data = handle.readData(ofLength: encryptedChunkSize)
      guard data.count == encryptedChunkSize else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 5,
          userInfo: [NSLocalizedDescriptionKey: "Encrypted payload ended before chunk \(index)"]
        )
      }
      let path = outputDir.appendingPathComponent("\(index).enc").path
      try data.write(to: URL(fileURLWithPath: path))
      paths.append(path)
    }

    let remaining = handle.readDataToEndOfFile()
    if !remaining.isEmpty {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 6,
        userInfo: [NSLocalizedDescriptionKey: "Encrypted payload has trailing bytes"]
      )
    }
    return paths
  }

  public func definition() -> ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("logDiagnostic") { (marker: String, payload: String?) in
      if let payload, !payload.isEmpty {
        NSLog("[BeebeebDiagnostics] \(marker) \(payload)")
      } else {
        NSLog("[BeebeebDiagnostics] \(marker)")
      }
    }

    AsyncFunction("hardenPlaintextStorage") { () -> [String: Bool] in
      PlaintextStorageProtection.hardenAll()
    }

    AsyncFunction("auditPlaintextStorage") { () -> [[String: Any]] in
      PlaintextStorageProtection.writeAuditReport()
      return PlaintextStorageProtection.audit()
    }

    // Task 1399 follow-up (Codex P1): permanently delete every registered
    // plaintext path. See PlaintextStorageProtection.purgeAll() doc comment.
    //
    // Task 1593 round 7 (C1) — the three steps below run in this SPECIFIC
    // order, not the order they were added in. The File Provider extension
    // is a separate process: neither `lib/plaintext-gate.ts` nor Expo's
    // shared serial AsyncFunction queue reaches it, so a
    // `SyncEngine.refreshContainer` already in flight when a forced
    // sign-out starts can still call `CacheManager.replaceChildren` after
    // this function starts running. The DB reset (`purgeAll()`) must
    // therefore run LAST — whatever the extension manages to write while
    // the earlier two steps run gets swept by this final step, matching
    // the existing remove-then-clear ordering `removeMountedFileProviderDomain`
    // already uses for the ordinary in-app sign-out path:
    //   1. reset consent — cheap, synchronous, no observable side effect on
    //      the extension until iOS actually re-delivers `.file-provider` a
    //      command, so its position relative to the other two doesn't matter
    //      for this race, but it must run before a NEW sign-in can flip it
    //      back on, so it goes first.
    //   2. bump the purge epoch, THEN remove the domain (bounded 5s) — the
    //      epoch bump must land before the domain removal call so ANY
    //      request the extension has in flight sees a changed epoch by the
    //      time it goes to write (see `bumpFileProviderCacheVersion`; round
    //      8/R2 moved this from an App Group UserDefaults counter into the
    //      cache DB's own `PRAGMA user_version`).
    //   3. sweep/reset the DB in place (`purgeAll()`) — LAST, so a write
    //      that slips through both of the above (e.g. one already inside
    //      `CacheManager`'s serial queue, past the epoch check, when step 2
    //      ran) is still wiped by this final in-place reset.
    AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in
      var failed = 0
      // Task 1593 f2 (lead design decision: MARKER FIRST) — mark pending
      // BEFORE this purge does ANYTHING else: before the consent reset,
      // before any epoch bump, before any database is opened. See
      // `PlaintextStorageProtection.markPurgePending()`'s doc comment for
      // the full rationale (supersedes f1's mark-only-after-a-failed-bump
      // design, which left every one of the steps below unmarked). The
      // returned nonce is this purge's own proof-of-identity for the ONE
      // place it is allowed to clear the marker again — its own final,
      // durably-committed epoch bump, at the very end of `purgeAll` below.
      // A total failure here (both the marker file AND its chmod fallback)
      // is a real, counted purge failure: nothing this purge does from this
      // point on can prove an extension write is refused.
      let pendingNonce = PlaintextStorageProtection.markPurgePending()
      if pendingNonce == nil {
        RuntimeTrace.event("storage.purge.failed", ["stage": "pending_marker"])
        failed += 1
      }
      // Task 1593 round 6 (new-4, privacy consent) — a forced sign-out
      // (session expiry, account deleted elsewhere, a startup 401) reaches
      // this function but never the ordinary in-app `removeFileProviderAccess`
      // → `clearFileProviderSharedState` path (~line 663) that resets the
      // "show in Files" mount consent. Left alone, a DIFFERENT account
      // signing in next on this device inherited the previous user's
      // consent and got the Files mount automatically, with no prompt.
      // Deliberately narrow: only the two consent flags, not the rest of
      // `clearFileProviderSharedState` (App Group session-mirror /
      // simulator-key clearing) — those overlap P0 1594's forced-sign-out
      // gap and stay out of scope for this round. The SAME user re-signing
      // in after a forced sign-out now also has to re-enable Files.
      resetFileProviderShowInFilesConsent(defaults: sharedDefaults())
      // Task 1593 round 5 (P1-3) — reached by EVERY sign-out, forced or
      // ordinary, unlike `removeFileProviderAccess` (only the ordinary
      // in-app signOut() calls that). Deliberately NOT `async` — see
      // removeFileProviderDomainIfRegistered's doc comment (P2-4): this
      // function must stay an `AsyncFunctionDefinition` on Expo's shared
      // serial queue, the same one `syncFileProviderCache` runs on.
      if #available(iOS 16.0, *) {
        // Task 1593 round 7 (C1) — bump BEFORE the (possibly slow, up to
        // 5s) domain removal call, not after, so a write already in flight
        // observes the new epoch as early as this purge can make it. Round
        // 8 (R2) moved the epoch itself into the cache DB's own
        // `PRAGMA user_version` — see `bumpFileProviderCacheVersion`'s doc
        // comment.
        //
        // Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mjO56, P1) — this
        // call's boolean result used to be thrown away with a bare
        // underscore assignment. An open/lock/commit failure here meant an
        // extension fetch that had already captured the OLD epoch kept
        // passing its `purgeEpochUnchanged` checks (round 11) for the rest
        // of this purge — the actual leak is closed unconditionally, below
        // this function's own call further down, by a new resweep of the
        // content directories that does not depend on this bump having
        // succeeded — but discarding a real failure here was still a
        // second, independent bug worth its own fix: one retry (the
        // function's own 2s busy_timeout already absorbs brief lock
        // contention; a second failure means a real, non-transient problem
        // — corrupt DB, open failure), then an honest, counted purge
        // failure instead of a second silent discard.
        if !bumpFileProviderCacheVersion() {
          if !bumpFileProviderCacheVersion() {
            RuntimeTrace.event("storage.purge.failed", ["stage": "file_provider_cache_version_bump"])
            failed += 1
            // Task 1593 f2 — no additional pending-mark call needed here:
            // marker-first already marked at the very top of this
            // function, BEFORE this bump was ever attempted, so this
            // failure simply leaves that mark exactly as it is. The final
            // in-place reset below (`purgeAll`) still gets a chance to bump
            // and clear it; until either that or a later purge/registration
            // succeeds, every extension write stays refused.
          }
        }
        // Task 1593 round 6 (new-1/new-2) — a timed-out or errored domain
        // lookup/removal is now a real, counted purge failure instead of a
        // silently swallowed one.
        if !removeFileProviderDomainIfRegistered() {
          failed += 1
        }
      }
      // Task 1593 round 7 (C1) — moved LAST (was first). See the block
      // comment above this AsyncFunction for why.
      let result = PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce)
      failed += result.failed
      return ["removed": result.removed, "failed": failed]
    }

    AsyncFunction("generateRandomBytes") { (length: Int) throws -> Data in
      guard length > 0, length <= 4096 else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Invalid random byte length"]
        )
      }

      var bytes = [UInt8](repeating: 0, count: length)
      let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
      guard status == errSecSuccess else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: Int(status),
          userInfo: [NSLocalizedDescriptionKey: "Secure random generator failed"]
        )
      }
      return Data(bytes)
    }

    AsyncFunction("generateRecoveryPhrase") { () throws -> [String: Any] in
      let result = try generateRecoveryPhrase()
      return [
        "phrase": result.phrase,
        "masterKey": result.masterKey,
      ]
    }

    AsyncFunction("recoverFromPhrase") { (phrase: String) throws -> [String: Any] in
      let masterKey = try recoverFromPhrase(phrase: phrase)
      return ["masterKey": masterKey]
    }

    AsyncFunction("computeRecoveryCheck") { (masterKey: Data) throws -> Data in
      try computeRecoveryCheck(masterKey: masterKey)
    }

    AsyncFunction("deriveX25519Private") { (masterKey: Data) throws -> Data in
      try deriveX25519Private(masterKey: masterKey)
    }

    AsyncFunction("deriveX25519Public") { (privateKey: Data) throws -> Data in
      try deriveX25519Public(privateKey: privateKey)
    }

    AsyncFunction("x25519SharedSecret") { (myPrivate: Data, theirPublic: Data) throws -> Data in
      try x25519SharedSecret(myPrivate: myPrivate, theirPublic: theirPublic)
    }

    AsyncFunction("deriveShareKey") { (sharedSecret: Data, fileId: Data) throws -> Data in
      try deriveShareKey(sharedSecret: sharedSecret, fileId: fileId)
    }

    // MARK: - File Requests (0643)
    //
    // Per-request sealed-keypair crypto (ECIES) for file requests. Mirrors the
    // web reference (repos/web/src/lib/crypto.ts) byte-for-byte at the core
    // level: same UniFFI functions, same EMPTY HKDF context, same X25519/HKDF/
    // AES — so links round-trip cross-client.
    //
    // Invariants:
    //  - The MASTER key never crosses to JS (task 0556). wrap/unwrap export the
    //    raw key transiently from the in-memory MasterKeyHandle and zero it.
    //  - R_priv is generated with SecRandomCopyBytes and, on create, never
    //    leaves native — only {publicKey, wrapped, nonce} are returned.
    //  - The HKDF context is EMPTY (`Data()`) for BOTH wrap (requestId) and open
    //    (fileId) — the ratified cross-client contract (decision 0651). The
    //    server-assigned ids are NOT used; uniqueness comes from the random
    //    keypair, ephemeral keypair, content key, and GCM nonce.
    //
    // New tracks (camera-roll 0672, ShareUploader 0673) MUST add their own
    // marked regions and not interleave here.

    AsyncFunction("createRequestKeypairWithHandle") { [self] (handleId: Int) throws -> [String: Any] in
      // 1. Fresh per-request X25519 private key (32 CSPRNG bytes).
      var rPrivBytes = [UInt8](repeating: 0, count: 32)
      let status = SecRandomCopyBytes(kSecRandomDefault, 32, &rPrivBytes)
      guard status == errSecSuccess else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: Int(status),
          userInfo: [NSLocalizedDescriptionKey: "Secure random generator failed"]
        )
      }
      var rPriv = Data(rPrivBytes)
      rPrivBytes.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
      }
      defer { rPriv.resetBytes(in: 0..<rPriv.count) }

      // 2. Derive R_pub (goes in the link fragment, never persisted server-side).
      let rPub = try deriveX25519Public(privateKey: rPriv)

      // 3. Wrap R_priv under the master key (raw bytes stay native, zeroed after).
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      let wrapped = try wrapRequestPrivate(masterKey: masterKeyBytes, requestId: Data(), rPriv: rPriv)
      return [
        "publicKey": rPub,
        "wrapped": wrapped.wrapped,
        "nonce": wrapped.nonce,
      ]
    }

    AsyncFunction("unwrapRequestPrivateWithHandle") { [self] (handleId: Int, wrapped: Data, nonce: Data) throws -> Data in
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      // Returns R_priv to JS; the caller (RequestKeyResolver) caches it and
      // zeroizes on vault lock.
      return try unwrapRequestPrivate(masterKey: masterKeyBytes, requestId: Data(), wrapped: wrapped, nonce: nonce)
    }

    // ─── Owner-recoverable share wrap (0805) ───────────────────────────────
    //  Wrap/unwrap bytes DIRECTLY under the master key with AES-256-GCM — the
    //  core chunk AEAD (BeebeebCryptoBridge.encryptChunk/decryptChunk), keyed by
    //  the master key as-is (NO HKDF), so the blob is byte-for-byte compatible
    //  with web's wrapKeyForShare(masterKey, …). The master key is exported
    //  transiently from the in-memory handle and zeroed; only ciphertext + nonce
    //  reach JS. Used for owner_wrapped_key (K_c) and owner_wrapped_token.
    AsyncFunction("wrapForOwnerWithHandle") { [self] (handleId: Int, plaintext: Data) throws -> [String: Any] in
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      let result = try BeebeebCryptoBridge.encryptChunk(key: masterKeyBytes, plaintext: plaintext)
      return [
        "wrapped": result.ciphertext,
        "nonce": result.nonce,
      ]
    }

    AsyncFunction("unwrapForOwnerWithHandle") { [self] (handleId: Int, wrapped: Data, nonce: Data) throws -> Data in
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      return try BeebeebCryptoBridge.decryptChunk(key: masterKeyBytes, nonce: nonce, ciphertext: wrapped)
    }

    AsyncFunction("openRequestUpload") { (rPriv: Data, ePub: Data, wrappedKey: Data) throws -> Data in
      // Recover the content key C for a request-uploaded file (owner decrypt).
      // No master key needed — R_priv is supplied by the caller.
      try openRequestUpload(rPriv: rPriv, ePub: ePub, fileId: Data(), wrappedKey: wrappedKey)
    }

    AsyncFunction("encryptChunk") { (key: Data, plaintext: Data) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptChunk(key: key, plaintext: plaintext)
      return [
        "cipherSuite": result.cipherSuite,
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptChunk") { (key: Data, nonce: Data, ciphertext: Data) throws -> Data in
      try BeebeebCryptoBridge.decryptChunk(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("encryptMetadata") { (key: Data, metadata: String) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptMetadata(key: key, metadata: metadata)
      return [
        "cipherSuite": result.cipherSuite,
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptMetadata") { (key: Data, nonce: Data, ciphertext: Data) throws -> String in
      try BeebeebCryptoBridge.decryptMetadata(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("renderPdfFirstPage") { (inputUri: String, outputUri: String, maxDimension: Double) throws -> String? in
      let inputURL = fileURL(fromURI: inputUri)
      let outputURL = fileURL(fromURI: outputUri)

      guard let document = PDFDocument(url: inputURL), let page = document.page(at: 0) else {
        return nil
      }

      let pageBounds = page.bounds(for: .mediaBox)
      guard pageBounds.width > 0, pageBounds.height > 0 else {
        return nil
      }

      let safeMaxDimension = max(320, min(maxDimension, 2400))
      let scale = min(safeMaxDimension / pageBounds.width, safeMaxDimension / pageBounds.height)
      let outputSize = CGSize(width: pageBounds.width * scale, height: pageBounds.height * scale)

      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
      let image = renderer.image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: outputSize))
        context.cgContext.saveGState()
        context.cgContext.translateBy(x: 0, y: outputSize.height)
        context.cgContext.scaleBy(x: scale, y: -scale)
        context.cgContext.translateBy(x: -pageBounds.origin.x, y: -pageBounds.origin.y)
        page.draw(with: .mediaBox, to: context.cgContext)
        context.cgContext.restoreGState()
      }

      guard let data = image.pngData() else {
        return nil
      }

      try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: outputURL, options: .atomic)
      return outputURL.absoluteString
    }

    // MARK: - On-device document OCR (0802)
    //
    // Apple Vision text recognition (`VNRecognizeTextRequest`) runs entirely
    // on-device — it makes ZERO network calls and never sends pixels or text to
    // Apple or any cloud. This is the privacy-preserving OCR engine for scanned
    // documents (fits the no-US/no-cloud rule); the recognized text is handed
    // back to JS where it is encrypted into the file's note field and (later)
    // the encrypted search index. NaturalLanguage's on-device language detector
    // tags the dominant language to help the local summary.
    AsyncFunction("recognizeDocumentText") { (uri: String, options: [String: Any]?) throws -> [String: Any] in
      let url = fileURL(fromURI: uri)
      guard
        let imageData = try? Data(contentsOf: url),
        let uiImage = UIImage(data: imageData),
        let cgImage = uiImage.cgImage
      else {
        throw NSError(
          domain: "BeebeebOCR",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Could not load image for text recognition"]
        )
      }

      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      if #available(iOS 16.0, *) {
        request.automaticallyDetectsLanguage = true
      }
      // Optional caller-supplied language hints (BCP-47, e.g. ["en-US","nl-NL"]).
      if let langs = options?["languages"] as? [String], !langs.isEmpty {
        request.recognitionLanguages = langs
      }

      let orientation = cgImagePropertyOrientation(from: uiImage.imageOrientation)
      let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
      try handler.perform([request])

      let observations = request.results ?? []
      var lines: [[String: Any]] = []
      var collected: [String] = []
      var confidenceSum: Float = 0
      var confidenceCount = 0
      for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let value = candidate.string
        collected.append(value)
        lines.append(["text": value, "confidence": Double(candidate.confidence)])
        confidenceSum += candidate.confidence
        confidenceCount += 1
      }

      let text = collected.joined(separator: "\n")
      let averageConfidence = confidenceCount > 0
        ? Double(confidenceSum / Float(confidenceCount))
        : 0

      var dominantLanguage: String?
      if !text.isEmpty {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        dominantLanguage = recognizer.dominantLanguage?.rawValue
      }

      return [
        "text": text,
        "lines": lines,
        "confidence": averageConfidence,
        "language": dominantLanguage as Any,
        "onDevice": true,
      ]
    }

    AsyncFunction("opaqueRegistrationStart") { (_ username: String, password: String) throws -> [String: Any] in
      let result = try opaqueRegistrationStart(password: Data(password.utf8))
      return [
        "state": result.state.base64EncodedString(),
        "message": result.message.base64EncodedString(),
      ]
    }

    AsyncFunction("opaqueRegistrationFinish") { (state: String, serverMessage: String, password: String) throws -> [String: Any] in
      let stateData = try decodeBase64(state, field: "state")
      let serverMessageData = try decodeBase64(serverMessage, field: "serverMessage")
      let record = try opaqueRegistrationFinish(clientState: stateData, password: Data(password.utf8), serverResponse: serverMessageData)
      return ["record": record.base64EncodedString()]
    }

    AsyncFunction("opaqueLoginStart") { (username: String, password: String) throws -> [String: Any] in
      let result = try opaqueLoginStart(password: Data(password.utf8))
      return [
        "state": result.state.base64EncodedString(),
        "message": result.message.base64EncodedString(),
      ]
    }

    AsyncFunction("opaqueLoginFinish") { (state: String, serverMessage: String, password: String, ksfVersion: Int) throws -> [String: Any] in
      let stateData = try decodeBase64(state, field: "state")
      let serverMessageData = try decodeBase64(serverMessage, field: "serverMessage")
      // `ksfVersion` (0 = legacy Identity KSF, 1 = Argon2id) selects the KSF the
      // account's OPAQUE password file was registered under, so a v0 (legacy)
      // account stretches with the matching KSF and its fresh login succeeds.
      // Forwarded from /opaque/login-start through the JS bridge as Int, lowered
      // to the UniFFI UInt32 the regenerated binding expects.
      let result = try opaqueLoginFinish(clientState: stateData, password: Data(password.utf8), serverResponse: serverMessageData, ksfVersion: UInt32(ksfVersion))
      return [
        "message": result.message.base64EncodedString(),
        "sessionKey": result.sessionKey.base64EncodedString(),
        "exportKey": result.exportKey.base64EncodedString(),
      ]
    }

    AsyncFunction("deriveFileKey") { (masterKey: Data, fileId: String) throws -> Data in
      try BeebeebCryptoBridge.deriveFileKey(masterKey: masterKey, fileId: fileId)
    }

    // ── Handle-based crypto operations ─────────────────────────────────
    //
    // These accept an opaque handle ID from JS instead of raw key bytes.
    // The handle is resolved to the real MasterKeyHandle on the native
    // side; raw key material never crosses the bridge.

    AsyncFunction("handleEncryptChunk") { [self] (handleId: Int, fileId: String, plaintext: Data) throws -> [String: Any] in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fk.encryptChunk(plaintext: plaintext)
      return [
        "cipherSuite": enc.cipherSuite,
        "nonce": enc.nonce,
        "ciphertext": enc.ciphertext,
      ]
    }

    AsyncFunction("handleDecryptChunk") { [self] (handleId: Int, fileId: String, nonce: Data, ciphertext: Data) throws -> Data in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      return try fk.decryptChunk(nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("handleEncryptMetadata") { [self] (handleId: Int, fileId: String, metadata: String) throws -> [String: Any] in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fk.encryptMetadata(metadata: metadata)
      return [
        "cipherSuite": enc.cipherSuite,
        "nonce": enc.nonce,
        "ciphertext": enc.ciphertext,
      ]
    }

    AsyncFunction("handleDecryptMetadata") { [self] (handleId: Int, fileId: String, nonce: Data, ciphertext: Data) throws -> String in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      return try fk.decryptMetadata(nonce: nonce, ciphertext: ciphertext)
    }

    // Task 0807: batch-decrypt many file names in ONE bridge crossing (folder-load
    // perf). Delegates to core's `MasterKeyHandle.decryptNames` (0806) — the master
    // key stays native (0556); a bad item yields a per-item error, never failing the
    // batch. Order + length match `items`.
    AsyncFunction("decryptNames") { [self] (handleId: Int, items: [[String: String]]) throws -> [[String: Any]] in
      let master = try self.getHandle(handleId)
      let batchItems = items.map { item in
        BatchNameItem(fileId: item["fileId"] ?? "", nameEncrypted: item["nameEncrypted"] ?? "")
      }
      let results = try master.decryptNames(items: batchItems)
      return results.map { result -> [String: Any] in
        [
          "name": result.name as Any,
          "mimeType": result.mimeType as Any,
          "error": result.error as Any,
        ]
      }
    }

    AsyncFunction("handleDeriveX25519Private") { [self] (handleId: Int) throws -> Data in
      let master = try self.getHandle(handleId)
      return try master.deriveX25519Private()
    }

    AsyncFunction("handleDeriveFileKey") { [self] (handleId: Int, fileId: String) throws -> Data in
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      return try BeebeebCryptoBridge.deriveFileKey(masterKey: masterKeyBytes, fileId: fileId)
    }

    AsyncFunction("handleComputeRecoveryCheck") { [self] (handleId: Int) throws -> Data in
      let master = try self.getHandle(handleId)
      return try master.computeRecoveryCheck()
    }

    AsyncFunction("releaseHandle") { [self] (handleId: Int) in
      self.masterKeyHandles.removeValue(forKey: handleId)
      if self.masterKeyHandles.isEmpty {
        BeebeebCryptoBridge.clearCachedMasterKey()
      }
    }

    AsyncFunction("storeKeyInKeychain") { (masterKeyBytes: Data, label: String) throws in
      RuntimeTrace.event("keychain.bridge.store.request", ["label": label])
      do {
        try KeychainManager.store(masterKeyBytes: masterKeyBytes, label: label)
        RuntimeTrace.event("keychain.bridge.store.success", ["label": label])
      } catch {
        RuntimeTrace.event("keychain.bridge.store.failed", ["label": label, "error": error.localizedDescription])
        throw error
      }
    }

    AsyncFunction("loadKeyFromKeychain") { (label: String) throws -> Data? in
      RuntimeTrace.event("keychain.bridge.load_bytes.request", [
        "label": label,
        "promptMayAppear": true
      ])
      do {
        let key = try KeychainManager.load(label: label)
        RuntimeTrace.event("keychain.bridge.load_bytes.result", [
          "label": label,
          "found": key != nil
        ])
        return key
      } catch {
        RuntimeTrace.event("keychain.bridge.load_bytes.failed", [
          "label": label,
          "error": error.localizedDescription
        ])
        throw mapVaultAuthError(error)
      }
    }

    // ── Opaque handle-based keychain load ──────────────────────────────
    //
    // Returns an opaque numeric handle ID instead of raw key bytes.
    // The real MasterKeyHandle stays in native memory; JS never sees
    // the key material.

    AsyncFunction("loadKeyFromKeychainAsHandle") { [self] (label: String) throws -> Int? in
      RuntimeTrace.event("keychain.bridge.load_handle.request", [
        "label": label,
        "promptMayAppear": true
      ])
      let keyData: Data?
      do {
        keyData = try KeychainManager.load(label: label)
      } catch {
        RuntimeTrace.event("keychain.bridge.load_handle.failed", [
          "label": label,
          "error": error.localizedDescription
        ])
        // Surface the typed vault-auth reason (stable code) to JS so
        // crypto-context can retry warm-up vs. surface cancel/fail/lockout.
        throw mapVaultAuthError(error)
      }
      guard let keyData else {
        RuntimeTrace.event("keychain.bridge.load_handle.miss", ["label": label])
        return nil
      }
      let handle = try MasterKeyHandle.fromKeychainBytes(bytes: keyData)
      // Zero the raw bytes now that the handle owns the key
      var mutableData = keyData
      mutableData.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
      }
      // Task 1594 round 4 (F4): do NOT populate `BeebeebCryptoBridge`'s
      // app-wide cache here. `NativeBackupEngine` (a background task can run
      // any time), `NativeEncryptedBackupUploader`, and `ThumbnailServiceModule`
      // all read that cache directly — setting it before JS's ownership
      // verdict (`crypto-context.tsx`'s `verifyKeyBelongsToAccount` / the
      // `unbound`/`purged` precheck branches) runs meant a key that verdict
      // was about to REJECT (or purge) was already usable by those readers
      // for however long the verdict took. The JS side now calls
      // `confirmMasterKeyHandle(handleId)` at every point it actually adopts
      // a handle — see that function below.
      let handleId = self.storeHandle(handle)
      RuntimeTrace.event("keychain.bridge.load_handle.success", [
        "label": label,
        "handleId": handleId
      ])
      return handleId
    }

    AsyncFunction("createMasterKeyHandle") { [self] (masterKeyBytes: Data) throws -> Int in
      let handle = try MasterKeyHandle.fromKeychainBytes(bytes: masterKeyBytes)
      var mutableData = masterKeyBytes
      mutableData.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
      }
      // Task 1594 round 4 (F4): see the matching comment in
      // `loadKeyFromKeychainAsHandle` above — the cache is populated only via
      // `confirmMasterKeyHandle`, once JS has actually adopted this handle.
      let handleId = self.storeHandle(handle)
      RuntimeTrace.event("keychain.bridge.create_handle.success", ["handleId": handleId])
      return handleId
    }

    // Task 1594 round 4 (F4): populate `BeebeebCryptoBridge`'s app-wide
    // native-cache — the ONE thing `NativeBackupEngine` (background task),
    // `NativeEncryptedBackupUploader`, and `ThumbnailServiceModule` read
    // directly, bypassing the JS handle entirely — ONLY once JS has proven
    // (or accepted, in the `unverifiable`/offline-`bound` cases the existing
    // ownership flow already treats as usable) that this handle belongs to
    // the signed-in account. Called from every adoption point in
    // `crypto-context.tsx`'s `unlock()`: the phrase-unlock branch (after its
    // ownership verdict, or immediately for a session-less signup with
    // nothing to verify against yet) and the keychain-unlock branch (the
    // `match` verdict, and the `bound`-precheck `unverifiable`/`unreachable`
    // branches that keep an already-trusted binding). A handle NEVER
    // confirmed (refused, purged, or the provider disposed first) simply sits
    // inert in `masterKeyHandles` until `releaseHandle` removes it — the
    // native readers never see it.
    //
    // Task 1599 followup 3: `ownerId` is the account id JS has ALREADY
    // verified this handle belongs to at this exact call site (the same
    // `ownerUserId` `crypto-context.tsx`'s `unlock()` passes to
    // `mirrorSignedInUserId`/`setExpectedUserId` right after this call —
    // see that file's own comment on the choke point). It is stored
    // alongside the handle so a reader with no ownership context of its own
    // (`NativeBackupEngine`'s background-task cache adoption) can refuse to
    // adopt a handle whose recorded owner doesn't match its `currentAccountId`,
    // rather than trusting "a handle is cached" as proof of the right
    // account. `nil` (a session-less signup with nothing to verify against
    // yet) caches the handle WITHOUT an attested owner — exactly like the
    // pre-1599 behavior, since there is no owner to attest.
    AsyncFunction("confirmMasterKeyHandle") { [self] (handleId: Int, ownerId: String?) throws -> Bool in
      let handle = try self.getHandle(handleId)
      // Normalize "" the same way every other owner/accountId reader in this
      // codebase does (e.g. `applyExpectedUserHeader`) — an empty string is
      // never a real account id.
      let normalizedOwnerId = (ownerId?.isEmpty == false) ? ownerId : nil
      BeebeebCryptoBridge.setCachedMasterKey(handle, ownerId: normalizedOwnerId)
      // Task 1599 followups round 2 review (P2): THIS call site — reached
      // only from `crypto-context.tsx`'s `unlock()`, i.e. an actual
      // phrase/keychain authentication event — is the genuine
      // "sign in again to resume" moment `NativeBackupEngine.bindAccount`'s
      // doc comment used to (incorrectly) treat itself as. A sticky
      // `accountMismatchStopReason` from a previous confirmed mismatch no
      // longer applies once a real new authentication has happened, so it is
      // cleared HERE, not in `bindAccount` (which also runs on every
      // ordinary "Back up now"/enable call with no new auth behind it —
      // clearing it there let a stale reason be silently dismissed without
      // the user actually signing in again).
      NativeBackupEngine.shared.clearAccountMismatchStopReasonOnNewAuthentication()
      // Task 1599 followups round 3 (P2): sibling clear for the LOCAL
      // owner-unconfirmed refusal reason — same genuine-new-authentication
      // choke point.
      NativeBackupEngine.shared.clearOwnerUnconfirmedStopReasonOnNewAuthentication()
      RuntimeTrace.event("keychain.bridge.confirm_handle", ["handleId": handleId, "hasOwner": normalizedOwnerId != nil])
      return true
    }

    AsyncFunction("deleteKeyFromKeychain") { () throws -> Bool in
      KeychainManager.delete()
      // Task 1531 [P0] defense in depth: the app-wide in-process master-key
      // cache (`BeebeebCryptoBridge`) was previously cleared ONLY as a side
      // effect of `releaseHandle` emptying `masterKeyHandles` — a path that
      // depends on JS calling `releaseHandle` for every outstanding handle
      // before/around sign-out. Clearing it explicitly here, at the same
      // moment the persisted keychain key is destroyed, means the in-process
      // cache can never outlive the keychain key it was read from, regardless
      // of handle-refcount bookkeeping on the JS side.
      BeebeebCryptoBridge.clearCachedMasterKey()
      // Task 1594 round 4 (F4): `BeebeebCryptoBridge.clearCachedMasterKey()`
      // above does NOT touch `NativeBackupEngine`'s OWN separate copy
      // (`masterKeyHandle`, warmed independently via `BeebeebCryptoBridge
      // .loadMasterKey()` in `start()`, or adopted from the bridge cache by a
      // background task — see `dropCachedMasterKeyHandle()`'s doc comment,
      // task 1531). Every path that purges the persisted key (this call —
      // `purgeStoredVaultKey`'s `key-ownership.ts`, reached on an
      // owner-mismatch precheck or a server-proven `mismatch`) must drop that
      // copy too, or a background backup task that already warmed
      // `masterKeyHandle` for the PREVIOUS account keeps using it after the
      // keychain key it came from no longer exists.
      NativeBackupEngine.shared.dropCachedMasterKeyHandle()
      return true
    }

    AsyncFunction("setRequireBiometric") { (require: Bool) throws -> Bool in
      RuntimeTrace.event("keychain.bridge.set_require_biometric.request", [
        "require": require,
        "promptMayAppear": true
      ])
      try KeychainManager.setAccessControl(requireBiometric: require)
      RuntimeTrace.event("keychain.bridge.set_require_biometric.success", ["require": require])
      return true
    }

    AsyncFunction("replaceKeychainAccessControl") { (require: Bool, masterKeyBytes: Data, label: String) throws -> Bool in
      RuntimeTrace.event("keychain.bridge.replace_access_control.request", [
        "require": require,
        "label": label,
        "source": "raw_bytes"
      ])
      try KeychainManager.replaceAccessControl(requireBiometric: require, masterKeyBytes: masterKeyBytes, label: label)
      RuntimeTrace.event("keychain.bridge.replace_access_control.success", [
        "require": require,
        "label": label,
        "source": "raw_bytes"
      ])
      return true
    }

    // Re-wrap the SE-protected master key under a new access-control policy
    // without re-reading the existing wrapped blob from the Keychain. Reading
    // the existing blob triggers Face ID under the current policy, which is
    // exactly the surprise prompt the user reported when toggling biometrics
    // (task 0556). The cached `MasterKeyHandle` already holds the key in
    // native memory; export it transiently, hand it to `KeychainManager`, and
    // zero the buffer before returning. Raw bytes never cross the JS bridge.
    AsyncFunction("replaceKeychainAccessControlFromHandle") { [self] (handleId: Int, require: Bool, label: String) throws -> Bool in
      RuntimeTrace.event("keychain.bridge.replace_access_control.request", [
        "require": require,
        "label": label,
        "handleId": handleId,
        "source": "handle"
      ])
      let master = try self.getHandle(handleId)
      var bytes = try master.exportForKeychain()
      defer {
        bytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      try KeychainManager.replaceAccessControl(requireBiometric: require, masterKeyBytes: bytes, label: label)
      RuntimeTrace.event("keychain.bridge.replace_access_control.success", [
        "require": require,
        "label": label,
        "handleId": handleId,
        "source": "handle"
      ])
      return true
    }

    AsyncFunction("mirrorSessionToAppGroup") { (token: String?, baseUrl: String?) -> Bool in
      // Session token + apiBaseUrl go to the SHARED Keychain
      // (`BeebeebKeychainCore` with the App Group access group +
      // `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) so the File
      // Provider extension + Share Extension can read them after first
      // unlock, and so they're EXCLUDED from unencrypted iCloud / iTunes
      // device backups. This replaces the previous App-Group UserDefaults
      // path that leaked the bearer in plaintext (task 0447). The
      // per-app KeychainManager copy for the backup engine
      // (`io.beebeeb.backupToken` / `io.beebeeb.serverURL`) stays — it's
      // a separate keychain item used only by `NativeBackupEngine`
      // running in the main app address space (task 0430).
      if let token, !token.isEmpty {
        // Task 1531 [P1] (round 5 delta security review): there is NO
        // token-REFRESH path in this codebase — `setToken` is only ever
        // called from `setSessionCredentials` at signup/login/OPAQUE/2FA
        // (api.ts:201, 451, 476, 2375, 2414, 2479) — so any change to the
        // stored `io.beebeeb.backupToken` here is a fresh sign-in, not a
        // silent renewal of the SAME session. Unbind the OLD account + drop
        // the engine's cached master-key handle BEFORE persisting the new
        // token, so nothing already-running can keep using the OLD
        // account/key pairing under the NEW token for even one tick.
        // `enablePhotoBackup`/`enableContactsBackup`/`enableCalendarBackup`
        // (all now routed through `bindAccount`) re-establish the correct
        // binding for whichever account this new token belongs to, right
        // after this call, from JS. A no-op re-store of the SAME token
        // (this function can be called redundantly, e.g. on app resume)
        // does nothing extra here.
        let previousToken = KeychainManager.loadString(key: "io.beebeeb.backupToken")
        if previousToken != token {
          NativeBackupEngine.shared.currentAccountId = nil
          NativeBackupEngine.shared.dropCachedMasterKeyHandle()
          // Task 1599 followups round 3 (P1 — sign-in lockout loop): a token
          // change here is ALWAYS a genuine new sign-in (this codebase has
          // no token-REFRESH path — see the comment above), so a sticky
          // `accountMismatchStopReason`/`ownerUnconfirmedStopReason` left
          // over from the PREVIOUS session no longer applies. Clearing it
          // HERE, before the new session's `BackupProvider` even mounts,
          // closes the race where its progress poll fires before
          // `confirmMasterKeyHandle` (unlock) would otherwise have cleared
          // it — misreading a stale reason as a fresh one and ending the
          // brand-new session before the user finishes signing in.
          NativeBackupEngine.shared.clearAccountMismatchStopReasonOnNewAuthentication()
          NativeBackupEngine.shared.clearOwnerUnconfirmedStopReasonOnNewAuthentication()
          RuntimeTrace.event("backup.native.mirror_session.token_changed_unbind")
          // Task 1594 round 2 (F3): a token change is a NEW (or newly-ended)
          // session — invalidate the shared "who is signed in" mirror in the
          // SAME call that changes the token, before persisting it, so there
          // is no window where the token is already usable by an extension
          // while `sessionUserIdKey` still names the OUTGOING account. JS
          // (`mirrorSignedInUserId`, key-ownership.ts, called from
          // `CryptoProvider`'s mount effect) re-establishes the correct
          // value shortly after; until it does, `sessionUserIdKey` is absent
          // and every extension ownership check below refuses (missing),
          // never "still matches the previous owner record".
          BeebeebKeychainCore.deleteString(key: BeebeebKeychainCore.sessionUserIdKey)
        }
        do {
          try BeebeebKeychainCore.storeString(token, key: sharedSessionTokenKey)
        } catch {
          RuntimeTrace.event("fileprovider.auth_mirror.failed", ["key": "sessionToken"])
          return false
        }
        try? KeychainManager.storeString(token, key: "io.beebeeb.backupToken")
      } else {
        BeebeebKeychainCore.deleteString(key: sharedSessionTokenKey)
        KeychainManager.deleteString(key: "io.beebeeb.backupToken")
        BeebeebKeychainCore.deleteString(key: BeebeebKeychainCore.sessionUserIdKey)
        NativeBackupEngine.shared.backupClientSessionId = nil
        // Task 1531 [P2-4]: this is the sign-out call (App.tsx `signOut()` /
        // `clearToken()` call `mirrorSessionToAppGroup(null, null)`). Clear
        // `currentAccountId` in the SAME call that wipes the shared backup
        // token, rather than relying only on `disablePhotoBackup()` /
        // `clearAccountAndPurgeStaged()` running first — belt-and-braces so
        // this token clear and the account binding it guards can never drift
        // out of sync regardless of call ordering elsewhere in the sign-out
        // path. (The reverse — binding a NEW account here on the SET branch
        // — is intentionally NOT done: this function has no `userId`, and
        // most of its callers (api.ts's token-refresh path in particular)
        // have no user context to pass one; `enablePhotoBackup`/
        // `triggerImmediateBackup` remain the only places a NEW binding is
        // established.)
        NativeBackupEngine.shared.currentAccountId = nil
        // Task 1599 followups round 3 (P1 — sign-in lockout loop): a signed-
        // out device has no session to hold a stale mismatch reason FOR —
        // clear both here too, belt-and-braces with the token-changed
        // branch's own clear above, so the very next sign-in (whatever
        // token it presents) never inherits a reason from the session that
        // JUST ended. This is also the exact path `endSessionForAccountMismatch`
        // (api.ts `clearToken()`) takes when IT is what forced this
        // sign-out — clearing here means the reason that caused the
        // teardown does not outlive the teardown itself.
        NativeBackupEngine.shared.clearAccountMismatchStopReasonOnNewAuthentication()
        NativeBackupEngine.shared.clearOwnerUnconfirmedStopReasonOnNewAuthentication()
      }
      if let baseUrl, !baseUrl.isEmpty {
        do {
          try BeebeebKeychainCore.storeString(baseUrl, key: sharedAPIBaseURLKey)
        } catch {
          RuntimeTrace.event("fileprovider.auth_mirror.failed", ["key": "apiBaseUrl"])
          return false
        }
        try? KeychainManager.storeString(baseUrl, key: "io.beebeeb.serverURL")
      } else {
        BeebeebKeychainCore.deleteString(key: sharedAPIBaseURLKey)
        KeychainManager.deleteString(key: "io.beebeeb.serverURL")
      }
      return true
    }

    AsyncFunction("mirrorBackupClientSession") { (sessionId: String?) -> Bool in
      NativeBackupEngine.shared.backupClientSessionId = sessionId
      return true
    }

    // Task 1594 round 2 (F3/F6): the vault key's proven owner, mirrored into
    // the SHARED keychain (same access group + accessibility as the key
    // itself) so the File Provider and Share Extension can read it without a
    // bridge back to the main app. Called from `key-ownership.ts`
    // `writeKeyOwner` / `clearKeyOwner` — never directly from JS elsewhere.
    // A `nil`/empty `userId` clears it (the key was purged or never proven).
    AsyncFunction("mirrorKeyOwner") { (userId: String?) -> Bool in
      if let userId, !userId.isEmpty {
        try? BeebeebKeychainCore.storeString(userId, key: BeebeebKeychainCore.masterKeyOwnerKey)
      } else {
        BeebeebKeychainCore.deleteString(key: BeebeebKeychainCore.masterKeyOwnerKey)
      }
      return true
    }

    // Task 1594 round 2 (F3/F6): who is CURRENTLY signed in, mirrored into
    // the same shared keychain. Extensions compare this against
    // `mirrorKeyOwner`'s value and refuse the key on any mismatch or either
    // being absent. Called from `CryptoProvider`'s mount effect
    // (crypto-context.tsx, via `key-ownership.ts` `mirrorSignedInUserId`) —
    // `mirrorSessionToAppGroup` above already clears this value the instant
    // the session token changes, so this call only ever WRITES the
    // definitive value for the now-current session (or clears it at
    // sign-out).
    AsyncFunction("mirrorSessionUserId") { (userId: String?) -> Bool in
      if let userId, !userId.isEmpty {
        try? BeebeebKeychainCore.storeString(userId, key: BeebeebKeychainCore.sessionUserIdKey)
      } else {
        BeebeebKeychainCore.deleteString(key: BeebeebKeychainCore.sessionUserIdKey)
      }
      return true
    }

    AsyncFunction("mirrorSimulatorFileProviderMasterKey") { (masterKeyBase64: String?) -> Bool in
      guard let defaults = sharedDefaults() else {
        return false
      }
      _ = masterKeyBase64
      defaults.removeObject(forKey: simulatorFileProviderMasterKeyKey)
      defaults.synchronize()
      return false
    }

    AsyncFunction("registerFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let defaults = sharedDefaults()
      guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false),
            sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
      else {
        return await currentFileProviderDomainStatus()
      }

      return try await registerMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("listFileProviderDomains") { () async throws -> [[String: Any]] in
      guard #available(iOS 16.0, *) else {
        return []
      }

      let domains = try await getFileProviderDomains()
      return domains.map { domain in
        [
          "identifier": domain.identifier.rawValue,
          "displayName": domain.displayName,
          "isBeebeeb": domain.identifier == fileProviderDomainIdentifier,
        ]
      }
    }

    // Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoQ, P1) — used to
    // hand-roll its own unconditional remove-then-add (no consent check, no
    // registration gate, no post-add generation validate-and-undo) instead
    // of reusing `registerMountedFileProviderDomainLocked`'s `forceReset:
    // true` path, which already does exactly this same remove-if-existed +
    // `clearFileProviderCacheState` + add + `ensureFileProviderCacheDatabase`
    // + schema-stamp + signal-enumerators + status-return sequence — but
    // WITH the guard: if a forced sign-out's purge lands while this reset's
    // own add is suspended between removal and (re-)addition, the guarded
    // path's consent recheck + purge-generation validate-and-undo (round
    // 9/10) catches it and undoes the add instead of re-registering the
    // domain after consent was reset. `mountFileProviderAccess` (this same
    // file) already calls `registerMountedFileProviderDomain(defaults:
    // forceReset: true)` for its own force-reset case; this is the same
    // call, and every real caller of `resetFileProviderDomain`
    // (`SettingsScreen.tsx`'s repair path) only invokes it when the privacy
    // state it just read had `showInFiles == true` — i.e. consent is
    // already expected to be on — so the guard's consent recheck is a no-op
    // in the ordinary case and only refuses when a purge actually raced it.
    AsyncFunction("resetFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      return try await registerMountedFileProviderDomain(defaults: sharedDefaults(), forceReset: true)
    }

    AsyncFunction("unregisterFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let defaults = sharedDefaults()
      return try await removeMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("setFileProviderEnabled") { (enabled: Bool) async throws -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(enabled, forKey: fileProviderEnabledKey)
      if !enabled {
        _ = clearFileProviderSharedState(defaults: defaults)
      }
      defaults?.synchronize()

      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      if enabled {
        guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false) else {
          return try await removeMountedFileProviderDomain(defaults: defaults)
        }
        return try await registerMountedFileProviderDomain(defaults: defaults)
      }

      return try await removeMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("mountFileProviderAccess") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        let defaults = sharedDefaults()
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let defaults = sharedDefaults()
      defaults?.set(true, forKey: fileProviderEnabledKey)
      defaults?.set(true, forKey: fileProviderTrustedMountKey)
      defaults?.set(true, forKey: fileProviderAuthRequiredKey)
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()

      return try await registerMountedFileProviderDomain(defaults: defaults, forceReset: true)
    }

    AsyncFunction("removeFileProviderAccess") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        let defaults = sharedDefaults()
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      return try await removeMountedFileProviderDomain(defaults: sharedDefaults())
    }

    AsyncFunction("getFileProviderPrivacyState") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      guard #available(iOS 16.0, *) else {
        var state = fileProviderPrivacyState(defaults: defaults)
        state["supported"] = false
        state["showInFiles"] = false
        state["mounted"] = false
        state["locked"] = true
        state["registered"] = false
        state["domainCount"] = 0
        return state
      }

      let domains = (try? await getFileProviderDomains()) ?? []
      var state = fileProviderPrivacyState(defaults: defaults, domains: domains)

      // "registered" + cache-ready is not the same as actually presented in
      // Files.app. iOS only surfaces the location once getUserVisibleURL
      // resolves without error; a non-nil error means the mount exists on paper
      // but the user can't see it. Gate the reported `mounted` on real
      // presentation and pass the error string through so the JS layer (and the
      // user) can see WHY the location is missing.
      let registered = state["registered"] as? Bool ?? false
      if registered {
        let domain = beebeebFileProviderDomain()
        let (userVisibleRootURL, userVisibleRootError) = await fileProviderRootVisibility(domain: domain)
        state["userVisibleRootURL"] = userVisibleRootURL ?? NSNull()
        state["userVisibleRootError"] = userVisibleRootError ?? NSNull()
        if userVisibleRootError != nil {
          state["mounted"] = false
          state["locked"] = true
        }
      } else {
        state["userVisibleRootURL"] = NSNull()
        state["userVisibleRootError"] = NSNull()
      }
      return state
    }

    AsyncFunction("setFileProviderAuthRequired") { (required: Bool) async -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(required, forKey: fileProviderAuthRequiredKey)
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("unlockFileProviderAccess") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("lockFileProviderAccess") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      _ = clearFileProviderSharedState(defaults: defaults)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    // ── File Provider cache pre-population ──────────────────────────────
    //
    // The File Provider extension cannot decrypt filenames when BeebeebCore
    // xcframework is not linked to the extension target. As a workaround the
    // main app decrypts names on the JS side and writes them to the shared
    // SQLite cache here.

    // `prune` opts the writer into deleting rows that are no longer present in
    // the incoming child set. The caller passes `prune == true` ONLY when
    // `entries` contains the COMPLETE child set for every parent it touches
    // (a full folder listing). A partial push (e.g. a single decrypted-name
    // refresh) MUST pass `prune == false`, otherwise siblings the caller did
    // not include would be wrongly deleted. When `prune` is omitted the
    // default is `false`, preserving the legacy upsert-only behaviour.
    AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]], prune: Bool?, pruneParents: [Any]?) -> Int in
      let shouldPrune = prune ?? false
      // Task 1593 round 11 — routed through the shared resolver (was an
      // inline `containerUrl.appendingPathComponent("file-provider-cache
      // .sqlite")` at the App Group root) so this call site gets the
      // directory-based sidecar protection AND the legacy-path migration
      // for free, instead of drifting from `ensureFileProviderCacheDatabase`
      // /`fileProviderCacheDatabaseUrl()`'s own path resolution.
      guard let dbUrl = fileProviderCacheDatabaseUrl() else {
        return 0
      }
      let dbPath = dbUrl.path
      var db: OpaquePointer?
      guard sqlite3_open_v2(
        dbPath,
        &db,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        nil
      ) == SQLITE_OK, let db else {
        sqlite3_close(db)
        return 0
      }
      defer { sqlite3_close(db) }
      // Task 1593 round 7 (C2) — same reasoning as `ensureFileProviderCache
      // Database`: `SQLITE_OPEN_CREATE` above can be creating this file for
      // the first time (this JS call runs independently of that native
      // bootstrap path), and an unprotected new file is backup-eligible and
      // at the wrong protection class until the next cold launch.
      PlaintextStorageProtection.protect(URL(fileURLWithPath: dbPath))
      // Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhUiZ) — see
      // `protectSQLiteSidecars`'s doc comment: the main file's `protect()`
      // above says nothing about its `-journal`/`-wal`/`-shm` siblings.
      PlaintextStorageProtection.protectSQLiteSidecars(URL(fileURLWithPath: dbPath))
      // Task 1593 round 6 (new-3) — this connection issues DELETEs (the
      // prune pass below); without secure_delete the freed b-tree pages
      // keep a pruned row's decrypted name bytes readable on disk until
      // something VACUUMs the file (same finding as the purge path's
      // `resetFileProviderCacheDatabase` / `resetSQLiteInPlace`, round 5
      // P1-1) — this ordinary write path never VACUUMs, so secure_delete is
      // the only defense it gets. Must be set before any DELETE runs.
      sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil)

      // Ensure the table exists (idempotent)
      let createSql = """
      CREATE TABLE IF NOT EXISTS file_cache (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_encrypted TEXT,
        name_decrypted TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        is_folder INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        has_thumbnail INTEGER NOT NULL DEFAULT 0,
        thumbnail_data BLOB,
        thumbnail_nonce BLOB,
        created_at TEXT,
        updated_at TEXT,
        sync_anchor INTEGER NOT NULL DEFAULT 0,
        is_materialized INTEGER NOT NULL DEFAULT 0
      );
      """
      sqlite3_exec(db, createSql, nil, nil, nil)

      let upsertSql = """
      INSERT INTO file_cache(
        id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
        is_folder, is_pinned, has_thumbnail, created_at, updated_at, sync_anchor, is_materialized
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        name_encrypted = excluded.name_encrypted,
        name_decrypted = COALESCE(excluded.name_decrypted, file_cache.name_decrypted),
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        is_folder = excluded.is_folder,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        sync_anchor = excluded.sync_anchor;
      """

      sqlite3_exec(db, "BEGIN", nil, nil, nil)
      var count = 0
      let now = Int64(Date().timeIntervalSince1970 * 1000)
      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
      var touchedParentIdentifiers = Set<String>()
      // Per-parent COMPLETE child-id sets, keyed by the SQLite parent_id value
      // (the real parent string, or nil → the root sentinel below). Only used
      // when `shouldPrune` is true. Mirrors CacheManager._deleteChildren's
      // (parent, keepingIds) contract: we keep exactly the ids the caller sent
      // for that parent and delete every other row under it.
      let rootParentSentinel = "\u{0}__bb_root__"
      var childIdsByParent: [String: Set<String>] = [:]

      // Seed prune targets that may contribute NO entries. The JS write-through
      // passes `pruneParents` for every affected parent — including folders that
      // became EMPTY (last live child trashed/deleted remotely) and remotely
      // trashed FOLDERs whose descendant rows must be cleared. Those parents
      // would never appear in the per-entry derivation below (no rows to upsert),
      // so without seeding their prune DELETE never runs and Files.app keeps the
      // vanished rows. Seeding an empty keep-set here means the prune pass deletes
      // EVERY surviving row under them and re-enumerates. A `nil`/NSNull element
      // is the root container (matching the per-entry null-parent handling). Only
      // honoured when pruning — a partial push never names pruneParents.
      if shouldPrune, let pruneParents {
        for raw in pruneParents {
          if let parentId = raw as? String {
            if childIdsByParent[parentId] == nil { childIdsByParent[parentId] = [] }
            touchedParentIdentifiers.insert(parentId)
          } else {
            // nil / NSNull → root container.
            if childIdsByParent[rootParentSentinel] == nil { childIdsByParent[rootParentSentinel] = [] }
            touchedParentIdentifiers.insert(NSFileProviderItemIdentifier.rootContainer.rawValue)
          }
        }
      }

      for entry in entries {
        guard let id = entry["id"] as? String else { continue }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, upsertSql, -1, &stmt, nil) == SQLITE_OK else { continue }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, transient)
        if let parentId = entry["parent_id"] as? String {
          sqlite3_bind_text(stmt, 2, (parentId as NSString).utf8String, -1, transient)
          touchedParentIdentifiers.insert(parentId)
          childIdsByParent[parentId, default: []].insert(id)
        } else { sqlite3_bind_null(stmt, 2) }
        if entry["parent_id"] == nil || entry["parent_id"] is NSNull {
          touchedParentIdentifiers.insert(NSFileProviderItemIdentifier.rootContainer.rawValue)
          childIdsByParent[rootParentSentinel, default: []].insert(id)
        }
        if let nameEnc = entry["name_encrypted"] as? String {
          sqlite3_bind_text(stmt, 3, (nameEnc as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 3) }
        if let nameDec = entry["name_decrypted"] as? String, !nameDec.isEmpty {
          sqlite3_bind_text(stmt, 4, (nameDec as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 4) }
        if let mime = entry["mime_type"] as? String {
          sqlite3_bind_text(stmt, 5, (mime as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 5) }
        sqlite3_bind_int64(stmt, 6, Int64(entry["size_bytes"] as? Int ?? 0))
        sqlite3_bind_int(stmt, 7, (entry["is_folder"] as? Bool ?? false) ? 1 : 0)
        if let createdAt = entry["created_at"] as? String {
          sqlite3_bind_text(stmt, 8, (createdAt as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 8) }
        if let updatedAt = entry["updated_at"] as? String {
          sqlite3_bind_text(stmt, 9, (updatedAt as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 9) }
        sqlite3_bind_int64(stmt, 10, now)

        if sqlite3_step(stmt) == SQLITE_DONE { count += 1 }
      }

      // Prune stale rows. For each parent the caller supplied a COMPLETE child
      // set for, delete file_cache rows under that parent whose id is NOT in
      // the incoming set — mirroring CacheManager._deleteChildren(parent:
      // keepingIds:). This is what makes a remote trash/delete disappear from
      // Files.app without the user re-opening the folder. Guarded by
      // `shouldPrune` so partial single-folder pushes never delete siblings.
      if shouldPrune {
        for (parentKey, keepIds) in childIdsByParent {
          let isRoot = parentKey == rootParentSentinel
          var deleteSql: String
          if isRoot {
            deleteSql = "DELETE FROM file_cache WHERE parent_id IS NULL"
          } else {
            deleteSql = "DELETE FROM file_cache WHERE parent_id = ?"
          }
          if !keepIds.isEmpty {
            let placeholders = Array(repeating: "?", count: keepIds.count).joined(separator: ",")
            deleteSql += " AND id NOT IN (\(placeholders))"
          }

          var delStmt: OpaquePointer?
          guard sqlite3_prepare_v2(db, deleteSql, -1, &delStmt, nil) == SQLITE_OK else { continue }
          defer { sqlite3_finalize(delStmt) }

          var index: Int32 = 1
          if !isRoot {
            sqlite3_bind_text(delStmt, index, (parentKey as NSString).utf8String, -1, transient)
            index += 1
          }
          // Sorted for deterministic binding order (matches CacheManager).
          for keepId in keepIds.sorted() {
            sqlite3_bind_text(delStmt, index, (keepId as NSString).utf8String, -1, transient)
            index += 1
          }
          sqlite3_step(delStmt)
        }
      }

      sqlite3_exec(db, "COMMIT", nil, nil, nil)

      // Signal the File Provider to re-enumerate so it picks up fresh names.
      // Fire whenever a row was upserted (count > 0) OR a prune pass ran over a
      // touched parent — a folder that was emptied by pruning has count == 0 but
      // still needs Files.app to re-enumerate and drop the vanished rows.
      let didPrune = shouldPrune && !touchedParentIdentifiers.isEmpty
      if #available(iOS 16.0, *), count > 0 || didPrune {
        let domain = beebeebFileProviderDomain()
        for rawIdentifier in touchedParentIdentifiers {
          let itemIdentifier: NSFileProviderItemIdentifier = rawIdentifier == NSFileProviderItemIdentifier.rootContainer.rawValue
            ? .rootContainer
            : NSFileProviderItemIdentifier(rawIdentifier)
          NSFileProviderManager(for: domain)?.signalEnumerator(for: itemIdentifier) { _ in }
        }
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
      }

      return count
    }

    // Remove specific entries from the shared File Provider cache (local
    // trash/delete write-through). Resolves each id's parent_id first so we can
    // re-enumerate the affected folders, then deletes the rows and signals the
    // File Provider — so a file trashed/deleted from inside the app disappears
    // from Files.app immediately instead of lingering until the next listing.
    AsyncFunction("removeFileProviderEntries") { (ids: [String]) -> Int in
      guard !ids.isEmpty else { return 0 }
      // Task 1593 round 11 — same resolver routing as `syncFileProviderCache`
      // above.
      guard let dbUrl = fileProviderCacheDatabaseUrl() else {
        return 0
      }
      let dbPath = dbUrl.path
      var db: OpaquePointer?
      guard sqlite3_open_v2(
        dbPath,
        &db,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX,
        nil
      ) == SQLITE_OK, let db else {
        sqlite3_close(db)
        return 0
      }
      defer { sqlite3_close(db) }
      // Task 1593 round 7 (F1) — this connection issues DELETEs (below)
      // without ever setting `secure_delete`; a freed b-tree page keeps the
      // deleted row's decrypted `name_decrypted` bytes readable on disk
      // until something VACUUMs the file (same finding already fixed for
      // `syncFileProviderCache` / `resetFileProviderCacheDatabase` in round
      // 5/6 P1-1 — this call site was missed). Must be set before any
      // DELETE runs.
      sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil)

      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
      // Track the parents whose listing changed so we can signal them. A NULL
      // parent_id (root) maps to the rootContainer sentinel, matching the
      // upsert path above.
      var touchedParentIdentifiers = Set<String>()

      sqlite3_exec(db, "BEGIN", nil, nil, nil)
      var removed = 0
      for id in ids {
        // Look up the parent before deleting so we know which folder to signal.
        var selStmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT parent_id FROM file_cache WHERE id = ?", -1, &selStmt, nil) == SQLITE_OK {
          sqlite3_bind_text(selStmt, 1, (id as NSString).utf8String, -1, transient)
          if sqlite3_step(selStmt) == SQLITE_ROW {
            if let cstr = sqlite3_column_text(selStmt, 0) {
              touchedParentIdentifiers.insert(String(cString: cstr))
            } else {
              touchedParentIdentifiers.insert(NSFileProviderItemIdentifier.rootContainer.rawValue)
            }
          }
        }
        sqlite3_finalize(selStmt)

        var delStmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "DELETE FROM file_cache WHERE id = ?", -1, &delStmt, nil) == SQLITE_OK {
          sqlite3_bind_text(delStmt, 1, (id as NSString).utf8String, -1, transient)
          if sqlite3_step(delStmt) == SQLITE_DONE { removed += 1 }
        }
        sqlite3_finalize(delStmt)
      }
      sqlite3_exec(db, "COMMIT", nil, nil, nil)

      if #available(iOS 16.0, *), removed > 0 {
        let domain = beebeebFileProviderDomain()
        for rawIdentifier in touchedParentIdentifiers {
          let itemIdentifier: NSFileProviderItemIdentifier = rawIdentifier == NSFileProviderItemIdentifier.rootContainer.rawValue
            ? .rootContainer
            : NSFileProviderItemIdentifier(rawIdentifier)
          NSFileProviderManager(for: domain)?.signalEnumerator(for: itemIdentifier) { _ in }
        }
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
      }

      return removed
    }

    // ── Backup management ──────────────────────────────────────────────

    AsyncFunction("configureBackupFolder") { (category: String, parentFolderId: String?) in
      RuntimeTrace.event("backup.configure_folder", [
        "category": category,
        "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
      ])
      switch category {
      case "camera_roll":
        PhotoBackupManager.shared.configure(parentFolderId: parentFolderId)
        NativeBackupEngine.shared.parentFolderId = parentFolderId
      case "contacts":
        ContactsBackupManager.shared.configure(parentFolderId: parentFolderId)
      case "calendar":
        CalendarBackupManager.shared.configure(parentFolderId: parentFolderId)
      default:
        break
      }
    }

    AsyncFunction("listPhotoBackupAlbums") { () -> [[String: Any]] in
      let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
      var albums: [[String: Any]] = []
      collections.enumerateObjects { collection, _, _ in
        let assetOptions = PHFetchOptions()
        if NativeBackupEngine.shared.includeVideos {
          assetOptions.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
                                               PHAssetMediaType.image.rawValue,
                                               PHAssetMediaType.video.rawValue)
        } else {
          assetOptions.predicate = NSPredicate(format: "mediaType == %d",
                                               PHAssetMediaType.image.rawValue)
        }
        let count = PHAsset.fetchAssets(in: collection, options: assetOptions).count
        guard count > 0 else { return }
        albums.append([
          "id": collection.localIdentifier,
          "title": collection.localizedTitle ?? "Untitled album",
          "assetCount": count,
        ])
      }
      return albums.sorted {
        (($0["title"] as? String) ?? "").localizedCaseInsensitiveCompare(($1["title"] as? String) ?? "") == .orderedAscending
      }
    }

    AsyncFunction("getPhotoBackupSelectedAlbumIds") { () -> [String] in
      NativeBackupEngine.shared.selectedPhotoAlbumIds
    }

    AsyncFunction("setPhotoBackupSelectedAlbumIds") { (albumIds: [String]) -> Bool in
      NativeBackupEngine.shared.selectedPhotoAlbumIds = albumIds
      return true
    }

    AsyncFunction("getPhotoBackupIncludeVideos") { () -> Bool in
      NativeBackupEngine.shared.includeVideos
    }

    AsyncFunction("setPhotoBackupIncludeVideos") { (includeVideos: Bool) -> Bool in
      NativeBackupEngine.shared.includeVideos = includeVideos
      return true
    }

    AsyncFunction("enablePhotoBackup") { (authToken: String, userId: String) in
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      // Task 1531 [P1-A] (round 5 delta review): route through the shared
      // `bindAccount` entry point (purge mismatched staged assets + set
      // `currentAccountId` + drop any stale cached key handle) instead of
      // writing `currentAccountId` directly — see that method's doc
      // comment in NativeBackupEngine.swift.
      engine.bindAccount(userId: userId)
      if engine.apiBaseUrl == nil {
        engine.apiBaseUrl = KeychainManager.loadString(key: "io.beebeeb.serverURL")
      }
      engine.start()
    }

    AsyncFunction("disablePhotoBackup") { () in
      let engine = NativeBackupEngine.shared
      engine.stop()
      engine.backupClientSessionId = nil
      // Task 1531 [P0] round 3 (lead review): sign-out / account-switch
      // teardown — see `clearAccountAndPurgeStaged` in NativeBackupEngine.swift.
      // Purges every staged-but-unuploaded asset and clears `currentAccountId`
      // so nothing this account staged can survive to be uploaded into
      // whichever account signs in next on this device.
      //
      // Task 1531 [P1-A follow-up] (round 5 delta review): this function is
      // ALSO called on its own — with Contacts/Calendar left running — when
      // the user toggles Camera Roll backup off alone (`togglePhotoBackup`'s
      // off-branch, backup-context.tsx). Now that Contacts/Calendar bind
      // through the SAME `engine.currentAccountId` (`bindAccount`, this
      // round's P1-A fix), unconditionally clearing it here would silently
      // break Contacts/Calendar backup the moment Camera Roll is toggled
      // off — the "camera roll off with contacts on" scenario in this
      // round's device-test checklist. Only clear the shared account when
      // NEITHER Contacts nor Calendar is still bound to it — i.e. this
      // really is a full teardown, not a single-surface toggle.
      //
      // Task 1531 [P1] round 6 (delta review 3, finding N1): this
      // isBound-conditional clear is now SINGLE-SURFACE-TOGGLE ONLY.
      // `stopBackupEngines()` (src/lib/backup-context.tsx) no longer calls
      // this function for the full sign-out / account-switch teardown — it
      // calls `teardownAllBackup()` below instead. The previous wording
      // here called the "runs before Contacts/Calendar clear their own
      // accountId" ordering a possible race that left a merely "inert"
      // stale value; it was neither. Expo dispatches `AsyncFunction` bodies
      // serially IN CALL ORDER (see `bindAccount`'s doc comment,
      // NativeBackupEngine.swift, N4), and `stopBackupEngines`'s
      // `Promise.all([disablePhotoBackup(), disableContactsBackup(),
      // disableCalendarBackup(), …])` calls `disablePhotoBackup()` FIRST —
      // so this body ran, and the isBound check below saw Contacts/Calendar
      // as "still bound", EVERY SINGLE TIME sign-out happened with either
      // enabled, not occasionally. `clearAccountAndPurgeStaged()` was
      // therefore skipped on every such sign-out — the outgoing account's
      // staged-but-unuploaded ciphertext was never wiped from disk at
      // sign-out, only (if ever) on a LATER, genuinely different account's
      // first bind on this device. `teardownAllBackup()` closes that by
      // disabling all three surfaces and purging unconditionally in one
      // native call, with no cross-call ordering to get wrong.
      if ContactsBackupManager.shared.isBound || CalendarBackupManager.shared.isBound {
        RuntimeTrace.event("backup.native.disable_photo.account_kept_for_other_surface")
      } else {
        engine.clearAccountAndPurgeStaged()
      }
    }

    // Task 1531 [P1] round 6 (delta review 3, finding N1): the full sign-out
    // / account-switch teardown entry point. Disables all three backup
    // surfaces and THEN unconditionally clears the shared account + purges
    // every staged-but-unuploaded asset — unlike `disablePhotoBackup` above
    // (kept for the single-surface Camera Roll toggle, where the purge must
    // stay conditional on Contacts/Calendar's `isBound` state), this never
    // gates the purge on any other surface's state, so it cannot be skipped
    // by the call-order behavior described in `disablePhotoBackup`'s
    // comment above. Called from `stopBackupEngines()`
    // (src/lib/backup-context.tsx) on EVERY BackupProvider unmount
    // (sign-out AND sign-in-as-different-user).
    AsyncFunction("teardownAllBackup") { () in
      let engine = NativeBackupEngine.shared
      ContactsBackupManager.shared.disable()
      CalendarBackupManager.shared.disable()
      engine.stop()
      engine.backupClientSessionId = nil
      engine.clearAccountAndPurgeStaged()
      RuntimeTrace.event("backup.native.teardown_all")
    }

    AsyncFunction("enableContactsBackup") { (authToken: String, userId: String) in
      ContactsBackupManager.shared.enable(authToken: authToken, userId: userId, runNow: true)
    }

    AsyncFunction("resumeContactsBackup") { (authToken: String, userId: String) in
      ContactsBackupManager.shared.enable(authToken: authToken, userId: userId, runNow: false)
    }

    AsyncFunction("disableContactsBackup") { () in
      ContactsBackupManager.shared.disable()
    }

    AsyncFunction("getContactsBackupStatus") { () -> [String: Any] in
      return ContactsBackupManager.shared.status()
    }

    // Task 0819: self-heal — clear the local scan/upload state + SHA dedup digest
    // so the next backup run re-uploads after the server copy was deleted.
    AsyncFunction("resetContactsBackup") { () in
      ContactsBackupManager.shared.reset()
    }

    AsyncFunction("enableCalendarBackup") { (authToken: String, userId: String) in
      CalendarBackupManager.shared.enable(authToken: authToken, userId: userId, runNow: true)
    }

    AsyncFunction("resumeCalendarBackup") { (authToken: String, userId: String) in
      CalendarBackupManager.shared.enable(authToken: authToken, userId: userId, runNow: false)
    }

    AsyncFunction("disableCalendarBackup") { () in
      CalendarBackupManager.shared.disable()
    }

    AsyncFunction("getCalendarBackupStatus") { () -> [String: Any] in
      return CalendarBackupManager.shared.status()
    }

    // Task 0819: self-heal — clear the local scan/upload state + every per-calendar
    // SHA dedup digest so the next backup run re-uploads after the server copy was
    // deleted.
    AsyncFunction("resetCalendarBackup") { () in
      CalendarBackupManager.shared.reset()
    }

    AsyncFunction("getBackupProgress") { () -> [String: Any] in
      return NativeBackupEngine.shared.currentProgress()
    }

    // ── 0437 single-owner bridge (Swift drives, TS reads) ─────────────
    //
    // Match the contract in `src/lib/backup-bridge.ts`. `getBackupStatus`
    // returns a `BackupStatusSnapshot`-shaped dictionary; `getAssetStatus`
    // returns the per-asset 4-state string or `nil`. The event channel
    // (`addBackupStatusListener` → `backup-status-changed`) and the
    // `migrateLegacyBackupState` ingest path land in the 0437 (b)
    // checkpoint — this is the read-side slice.

    AsyncFunction("getBackupStatus") { () -> [String: Any] in
      return NativeBackupEngine.shared.snapshotForBridge()
    }

    AsyncFunction("getAssetStatus") { (localId: String) -> String? in
      return NativeBackupEngine.shared.assetStatusForBridge(localId: localId)
    }

    // ── 0438 Expo wrapper for the Rust-side fast-path decrypt ─────────
    //
    // rust-engineer shipped `decryptContiguousToFile` in core (commit
    // `c5335ff`); ts-engineer wired the JS side (`src/lib/decrypt-to-file.ts`
    // and `src/lib/native-decrypt.ts`, gated by `isDecryptToFileReady()`
    // runtime probe). This 5-line wrapper exposes the UniFFI binding to JS
    // so the probe flips and the fast path takes over (Rust slices, decrypts
    // and writes in one call — no per-chunk JSI round-trips). The per-chunk
    // JS loop stays in place as the fallback path.
    AsyncFunction("decryptContiguousToFile") {
      (fileKey: Data, body: Data, chunkSize: UInt64, outputPath: String) throws -> UInt64 in
      // JS hands us an expo-file-system URI ("file:///var/.../preview/x.png").
      // Rust does File::create() on whatever string it gets, and a file:// URI
      // is not a POSIX path — it failed with
      //   CryptoError.Io("create file: No such file or directory (os error 2)")
      // on EVERY call, silently disabling this whole fast path. Convert at the
      // native boundary like every other file-taking function in this module
      // (fileURL(fromURI:) — see generateVideoThumbnail, encryptFile, …).
      let resolvedPath = fileURL(fromURI: outputPath).path
      // UniFFI emits this as a top-level function in `beebeeb_uniffi.swift`,
      // not under a namespace — call it directly.
      return try decryptContiguousToFile(
        fileKey: fileKey, body: body, chunkSize: chunkSize, outputPath: resolvedPath
      )
    }

    AsyncFunction("triggerImmediateBackup") { (authToken: String, userId: String) async throws -> [String: Any] in
      let engine = NativeBackupEngine.shared
      // Task 1531 [P2-4]: unlike `enablePhotoBackup`, this entry point used to
      // write `engine.token` WITHOUT touching `currentAccountId` — a manual
      // trigger could desync the two (a new token for account B written while
      // `currentAccountId` still read A) since `token`/`currentAccountId` are
      // independent keychain slots written from independent call sites. If an
      // account is already bound and it is NOT this call's account, refuse
      // outright rather than silently overwrite the token for a different
      // identity than the one the engine is authorized for.
      //
      // Task 1531 [P1-A] (round 5 delta review): the "bind if not yet bound"
      // branch now routes through `bindAccount` instead of writing
      // `currentAccountId` directly — same purge-first + stale-key-handle-
      // drop discipline every other enable entry point gets. The refuse-on-
      // mismatch behavior above is UNCHANGED: a manual trigger must never
      // silently rebind to a different account; `bindAccount` itself is
      // also a no-op when `userId` already matches, so this is safe to call
      // unconditionally once the mismatch case above has already thrown.
      if let boundAccountId = engine.currentAccountId, !boundAccountId.isEmpty, boundAccountId != userId {
        RuntimeTrace.event("backup.native.trigger_immediate.refused_account_mismatch", [
          "boundAccount": boundAccountId
        ])
        throw BackupError.accountUnknown
      }
      engine.bindAccount(userId: userId)
      engine.token = authToken
      if engine.apiBaseUrl == nil {
        engine.apiBaseUrl = KeychainManager.loadString(key: "io.beebeeb.serverURL")
      }
      return try await engine.triggerManualBackup(limit: 50)
    }

    // ── Share Extension: pending shares dropped by BeebeebShare ────────
    //
    // The iOS Share Extension writes files into the App Group container at
    // group.io.beebeeb.shared/IncomingShares/. The main app picks them up
    // here, copies each into its own sandbox so the JS side can fetch a
    // file:// URI, and removes the App Group copy on `consume`.

    AsyncFunction("listPendingShares") { () throws -> [[String: Any]] in
      try PendingSharesAccess.list()
    }

    AsyncFunction("consumePendingShare") { (id: String) throws -> [String: Any] in
      try PendingSharesAccess.consume(id: id)
    }

    AsyncFunction("acknowledgePendingShare") { (id: String) throws -> Bool in
      try PendingSharesAccess.acknowledge(id: id)
    }

    AsyncFunction("clearAllPendingShares") { () throws -> Int in
      try PendingSharesAccess.clearAll()
    }

    // ── Backup progress notification ─────────────────────────────────────

    AsyncFunction("configureBackupNotificationSettings") { (backupSummaries: Bool, noChangeCheckins: Bool, actionNeeded: Bool) in
      let defaults = UserDefaults.standard
      defaults.set(backupSummaries, forKey: "io.beebeeb.backupNotifications.backupSummaries")
      defaults.set(noChangeCheckins, forKey: "io.beebeeb.backupNotifications.noChangeCheckins")
      defaults.set(actionNeeded, forKey: "io.beebeeb.backupNotifications.actionNeeded")
    }

    AsyncFunction("updateBackupNotification") { (uploaded: Int, total: Int, throughputMBps: Double, isComplete: Bool, completionBody: String?) in
      let appIsActive = await MainActor.run {
        UIApplication.shared.applicationState == .active
      }
      if appIsActive {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
        return
      }

      let content = UNMutableNotificationContent()
      content.title = "Beebeeb Backup"
      guard isComplete else { return }
      content.body = completionBody ?? "\(total) photos secured"
      content.sound = nil

      let request = UNNotificationRequest(
        identifier: "io.beebeeb.backup-progress",
        content: content,
        trigger: nil
      )
      try? await UNUserNotificationCenter.current().add(request)

      if isComplete {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
          UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: ["io.beebeeb.backup-progress"]
          )
        }
      }
    }

    AsyncFunction("clearBackupNotification") { () in
      UNUserNotificationCenter.current().removeDeliveredNotifications(
        withIdentifiers: ["io.beebeeb.backup-progress"]
      )
    }

    // ── Native Backup Engine ──────────────────────────────────────────────

    // Task 1531 [P1] (round 5 delta security review): `startNativeBackup`
    // deleted — it wrote `engine.token` (and started the engine) with NO
    // `userId` parameter at all, so it could never route through
    // `bindAccount`/`currentAccountId` and had no way to be fixed to do so.
    // Confirmed dead: no JS caller anywhere in this repo (grepped src/,
    // modules/beebeeb-crypto/src/); `enablePhotoBackup(authToken:userId:)`
    // is the real, account-bound entry point every JS call site already
    // uses.

    AsyncFunction("stopNativeBackup") { () in
      NativeBackupEngine.shared.stop()
    }

    AsyncFunction("pauseNativeBackup") { () in
      NativeBackupEngine.shared.pause()
    }

    AsyncFunction("resumeNativeBackup") { () in
      NativeBackupEngine.shared.resume()
    }

    AsyncFunction("getNativeBackupProgress") { () -> [String: Any] in
      return NativeBackupEngine.shared.currentProgress()
    }

    AsyncFunction("getNativeBackupDiagnostics") { () -> [String: Any] in
      return NativeBackupEngine.shared.diagnosticSnapshot()
    }

    AsyncFunction("triggerNativeBackupBatch") { () async throws -> [String: Any] in
      let uploaded = try await NativeBackupEngine.shared.processBatch(limit: 12)
      return NativeBackupEngine.shared.currentProgress().merging(
        ["batchUploaded": uploaded],
        uniquingKeysWith: { _, new in new }
      )
    }

    // ── Rust upload bridge for manual (non-backup) uploads ────────────
    //
    // Calls the Rust `uploadEncryptedFile()` from the beebeeb-upload crate.
    // The caller (JS) provides pre-encrypted chunk file paths. The Rust
    // function handles init → chunk upload → complete in one blocking call.

    AsyncFunction("uploadEncryptedFileNative") { (params: [String: Any]) throws -> [String: Any] in
      guard let apiUrl = params["apiUrl"] as? String,
            let token = params["token"] as? String,
            let fileId = params["fileId"] as? String,
            let nameEncrypted = params["nameEncrypted"] as? String,
            let chunkPaths = params["chunkPaths"] as? [String],
            let originalSize = params["originalSize"] as? Int
      else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Missing required parameters for uploadEncryptedFileNative"]
        )
      }
      let parentId = params["parentId"] as? String
      let mimeType = params["mimeType"] as? String
      let isMediaFlag = params["isMedia"] as? Bool ?? false
      let createdAt = params["createdAt"] as? String

      let result = try uploadEncryptedFile(
        apiUrl: apiUrl,
        token: token,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        parentId: parentId,
        mimeType: mimeType,
        isMedia: isMediaFlag,
        chunkPaths: chunkPaths,
        originalSize: UInt64(originalSize),
        createdAt: createdAt,
        callback: nil
      )
      return [
        "fileId": result.fileId,
        "uploadSessionId": result.uploadSessionId,
        "chunksUploaded": result.chunksUploaded,
        "totalBytes": result.totalBytes,
      ]
    }

    // ── Rust download + decrypt bridge for previews ───────────────────
    //
    // Downloads the encrypted file and writes decrypted plaintext directly to
    // disk through Rust/Swift. JS receives only the output file URI and never
    // holds encrypted bytes, decrypted bytes, or base64 copies in its heap.

    AsyncFunction("downloadAndDecryptFileNative") { [self] (
      handleId: Int,
      apiUrl: String,
      token: String,
      fileId: String,
      outputUri: String,
      requestId: String?
    ) async throws -> [String: Any] in
      RuntimeTrace.event("preview.native_download.request", [
        "fileId": fileId,
        "hasRequestId": requestId != nil
      ])
      let master = try self.getHandle(handleId)
      let outputURL = fileURL(fromURI: outputUri)
      let outputPath = outputURL.path
      let progress = PreviewDownloadProgress(requestId: requestId, fileId: fileId) { [weak self] body in
        self?.storePreviewProgress(requestId ?? "", body)
      }
      self.storePreviewDownloadCancellation(progress, requestId: requestId)
      if Task.isCancelled {
        progress.cancel()
      }
      defer {
        self.removePreviewDownloadCancellation(requestId: requestId)
        self.clearPreviewProgress(requestId ?? "")
      }

      let tempDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("beebeeb-preview-\(fileId)-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
      defer {
        try? FileManager.default.removeItem(at: tempDir)
      }

      let downloadUrl = URL(string: "\(apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/v1/files/\(fileId)/download")!
      var request = URLRequest(url: downloadUrl)
      ProvenanceHeaders.apply(to: &request)
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

      progress.emitProgress(stage: "downloading", bytesDownloaded: 0, bytesTotal: 0)
      let delegate = PreviewEncryptedDownloadDelegate(progress: progress)
      let (encryptedUrl, response) = try await delegate.download(request: request)
      RuntimeTrace.event("preview.native_download.response", [
        "fileId": fileId,
        "status": response.statusCode,
        "contentLength": Int(response.value(forHTTPHeaderField: "Content-Length") ?? "") ?? 0,
        "chunkCountHeader": Int(response.value(forHTTPHeaderField: "X-Chunk-Count") ?? "") ?? 0,
        "originalSizeHeader": Int(response.value(forHTTPHeaderField: "X-Original-Size") ?? "") ?? 0,
        "chunkSizeHeader": Int(response.value(forHTTPHeaderField: "X-Chunk-Size") ?? "") ?? 0
      ])
      defer {
        try? FileManager.default.removeItem(at: encryptedUrl)
      }

      guard response.statusCode >= 200 && response.statusCode < 300 else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: response.statusCode,
          userInfo: [NSLocalizedDescriptionKey: "Download failed with HTTP \(response.statusCode)"]
        )
      }

      let encryptedSize = Int((try FileManager.default.attributesOfItem(atPath: encryptedUrl.path)[.size] as? NSNumber)?.intValue ?? 0)
      let chunkCount = Int(response.value(forHTTPHeaderField: "X-Chunk-Count") ?? "")
        ?? 1
      let originalSize = Int(response.value(forHTTPHeaderField: "X-Original-Size") ?? "")
        ?? max(0, encryptedSize - 28)
      let headerChunkSize = Int(response.value(forHTTPHeaderField: "X-Chunk-Size") ?? "")
      let plaintextChunkSize = chunkCount <= 1
        ? originalSize
        : (headerChunkSize ?? (4 * 1024 * 1024))
      RuntimeTrace.event("preview.native_download.chunk_metadata", [
        "fileId": fileId,
        "encryptedSize": encryptedSize,
        "originalSize": originalSize,
        "chunkCount": chunkCount,
        "plaintextChunkSize": plaintextChunkSize,
        "hasHeaderChunkSize": headerChunkSize != nil
      ])

      let chunkPaths = try self.splitEncryptedPreviewFile(
        encryptedUrl: encryptedUrl,
        outputDir: tempDir,
        chunkCount: chunkCount,
        originalSize: originalSize,
        plaintextChunkSize: plaintextChunkSize
      )
      RuntimeTrace.event("preview.native_download.split_complete", [
        "fileId": fileId,
        "chunks": chunkPaths.count
      ])

      progress.emitProgress(stage: "decrypting", chunksCompleted: 0, chunksTotal: chunkPaths.count)
      RuntimeTrace.event("preview.native_download.decrypt_start", [
        "fileId": fileId,
        "chunks": chunkPaths.count
      ])
      let result = try master.decryptFile(
        fileId: fileId,
        chunkPaths: chunkPaths,
        outputPath: outputPath,
        callback: progress
      )
      progress.emitProgress(stage: "complete")
      RuntimeTrace.event("preview.native_download.decrypt_complete", [
        "fileId": fileId,
        "totalBytes": result.totalBytes,
        "chunksProcessed": result.chunksProcessed
      ])

      return [
        "outputPath": result.outputPath,
        "outputUri": URL(fileURLWithPath: result.outputPath).absoluteString,
        "plaintextSize": result.totalBytes,
        "chunksDecrypted": result.chunksProcessed,
      ]
    }

    AsyncFunction("cancelDownloadAndDecryptFileNative") { [self] (requestId: String) -> Bool in
      self.cancelPreviewDownload(requestId: requestId)
    }

    Function("getPreviewLoadProgress") { [weak self] (requestId: String) -> [String: Any]? in
      self?.readPreviewProgress(requestId)
    }

    // ── Native manual upload (task 1310) ──────────────────────────────
    //
    // JS owns the upload-session protocol (init / resume state / complete /
    // encrypted-name patch); native owns everything that must not touch the JS
    // heap: reading the file, encrypting it with the core streaming encryptor
    // and PUTting the frames with byte-level progress. See NativeManualUploader.

    Function("planUploadChunksNative") { (fileSizeBytes: Double) throws -> [String: Any] in
      let plan = try NativeManualUploader.plan(fileSizeBytes: UInt64(max(0, fileSizeBytes)))
      return [
        "chunkSizeBytes": Double(plan.chunkSizeBytes),
        "chunkCount": Double(plan.chunkCount),
      ]
    }

    AsyncFunction("uploadChunksNative") { [self] (params: [String: Any]) async throws -> [String: Any] in
      func number(_ key: String) -> Double? {
        if let value = params[key] as? Double { return value }
        if let value = params[key] as? Int { return Double(value) }
        if let value = params[key] as? NSNumber { return value.doubleValue }
        return nil
      }
      guard let handleId = number("handleId").map({ Int($0) }),
            let apiUrl = params["apiUrl"] as? String,
            let token = params["token"] as? String,
            let fileId = params["fileId"] as? String,
            let inputUri = params["inputUri"] as? String,
            let uploadSessionId = params["uploadSessionId"] as? String,
            let chunkSizeBytes = number("chunkSizeBytes"),
            let chunkCount = number("chunkCount"),
            let requestId = params["requestId"] as? String
      else {
        throw NSError(
          domain: "BeebeebUpload",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Missing required parameters for uploadChunksNative"]
        )
      }
      let startChunkIndex = UInt32(max(0, number("startChunkIndex") ?? 0))
      let master = try self.getHandle(handleId)
      let progress = NativeUploadProgress(requestId: requestId)
      self.storeUploadProgress(progress)
      defer { self.removeUploadProgress(requestId) }

      RuntimeTrace.event("upload.native.start", [
        "fileId": fileId,
        "chunkCount": Int(chunkCount),
        "chunkSizeBytes": Int(chunkSizeBytes),
        "startChunkIndex": Int(startChunkIndex),
      ])
      let request = NativeManualUploader.Request(
        masterKey: master,
        fileId: fileId,
        inputPath: fileURL(fromURI: inputUri).path,
        apiUrl: apiUrl,
        token: token,
        uploadSessionId: uploadSessionId,
        chunkSizeBytes: UInt64(chunkSizeBytes),
        chunkCount: UInt64(chunkCount),
        startChunkIndex: startChunkIndex
      )
      do {
        let result = try await NativeManualUploader.shared.upload(request, progress: progress)
        RuntimeTrace.event("upload.native.complete", [
          "fileId": fileId,
          "chunksUploaded": result["chunksUploaded"] ?? 0,
          "bytesUploaded": result["bytesUploaded"] ?? 0,
        ])
        return result
      } catch {
        progress.fail(error.localizedDescription)
        RuntimeTrace.event("upload.native.error", ["fileId": fileId, "error": error.localizedDescription])
        throw error
      }
    }

    Function("getUploadProgressNative") { [weak self] (requestId: String) -> [String: Any]? in
      self?.readUploadProgress(requestId)
    }

    AsyncFunction("cancelUploadNative") { [self] (requestId: String) -> Bool in
      self.cancelUpload(requestId)
    }

    // ── Local thumbnail generation for video and RAW (DNG) files ────────
    //
    // generateVideoThumbnail: Uses AVAssetImageGenerator to extract a frame
    // from a local video file (MP4/MOV) and writes a WebP thumbnail to disk.
    //
    // generateDngThumbnail: Asks ImageIO for a size-bounded DNG preview and
    // resizes that preview to WebP. Keep this off Expo's default native queue:
    // RAW preview extraction can be slow enough to delay following uploads.

    AsyncFunction("generateVideoThumbnail") { (localUri: String, maxSize: Int) throws -> String in
      let url = fileURL(fromURI: localUri)
      let asset = AVAsset(url: url)
      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: maxSize, height: maxSize)

      let time = CMTime(seconds: 1.0, preferredTimescale: 600)
      let cgImage: CGImage
      do {
        cgImage = try generator.copyCGImage(at: time, actualTime: nil)
      } catch {
        // Fall back to time 0 if time 1s is beyond duration
        cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
      }
      let image = UIImage(cgImage: cgImage)

      guard let webpData = ThumbnailGenerator.generate(from: image, config: .medium) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Failed to encode video thumbnail as WebP"]
        )
      }

      let outputPath = NSTemporaryDirectory() + "video-thumb-\(UUID().uuidString).webp"
      try webpData.write(to: URL(fileURLWithPath: outputPath))
      return outputPath
    }

    AsyncFunction("generateDngThumbnail") { (localUri: String, maxSize: Int) throws -> String in
      let url = fileURL(fromURI: localUri)

      let sourceOptions: CFDictionary = [
        kCGImageSourceShouldCache: false,
        kCGImageSourceShouldCacheImmediately: false
      ] as CFDictionary

      guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Failed to open DNG image source"]
        )
      }

      let safeMaxSize = max(256, min(maxSize, 1600))
      let thumbnailOptions: CFDictionary = [
        kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCache: false,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: safeMaxSize
      ] as CFDictionary

      guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Failed to extract DNG preview"]
        )
      }

      let image = UIImage(cgImage: cgImage)
      let config: ThumbnailGenerator.Config
      if maxSize >= 1200 {
        // JS requests the large RAW thumbnail at 1600 px. Native's existing
        // large ladder currently encodes at up to 1280 px/192 KB, so ImageIO
        // may read a 1600 px preview while WebP output still follows that
        // established native large policy.
        config = .large
      } else if maxSize <= 384 {
        config = .small
      } else {
        config = .medium
      }

      guard let webpData = ThumbnailGenerator.generate(from: image, config: config) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 3,
          userInfo: [NSLocalizedDescriptionKey: "Failed to encode DNG thumbnail as WebP"]
        )
      }

      let outputPath = NSTemporaryDirectory() + "dng-thumb-\(UUID().uuidString).webp"
      try webpData.write(to: URL(fileURLWithPath: outputPath))
      return outputPath
    }.runOnQueue(beebeebDngThumbnailQueue)

    // ── Native thumbnail pipeline ────────────────────────────────────────
    //
    // Downloads the full encrypted file via URLSession, decrypts to disk via
    // Rust, resizes with UIImage (no JS heap), encrypts the thumbnail WebP
    // as a single AES-256-GCM chunk, and uploads via PUT. Zero JS memory.

    AsyncFunction("generateAndUploadThumbnailNative") { [self] (
      handleId: Int, apiUrl: String, token: String,
      fileId: String, maxSize: Int
    ) async throws -> Bool in
      let masterKey = try self.getHandle(handleId)

      let tempDir = NSTemporaryDirectory() + "thumb-\(fileId)-\(UUID().uuidString)/"
      try FileManager.default.createDirectory(
        atPath: tempDir, withIntermediateDirectories: true
      )
      defer { try? FileManager.default.removeItem(atPath: tempDir) }

      // 1. Fetch file metadata to learn chunk_count and size_bytes
      let metaUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)")!
      var metaReq = URLRequest(url: metaUrl)
      ProvenanceHeaders.apply(to: &metaReq)
      metaReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (metaData, metaResp) = try await URLSession.shared.data(for: metaReq)
      guard let httpMeta = metaResp as? HTTPURLResponse, httpMeta.statusCode == 200 else {
        return false
      }
      guard let meta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any],
            let chunkCount = meta["chunk_count"] as? Int,
            let sizeBytes = meta["size_bytes"] as? Int,
            chunkCount > 0, sizeBytes > 0
      else { return false }

      // 2. Download the full encrypted blob to a temp file
      let downloadUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/download")!
      var dlReq = URLRequest(url: downloadUrl)
      ProvenanceHeaders.apply(to: &dlReq)
      dlReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (dlData, dlResp) = try await URLSession.shared.data(for: dlReq)
      guard let httpDl = dlResp as? HTTPURLResponse, httpDl.statusCode == 200 else {
        return false
      }
      guard dlData.count > 0 else { return false }

      // 3. Split the concatenated blob into individual chunk files
      //    Each encrypted chunk = nonce(12) + ciphertext(plaintext_chunk + 16 tag)
      //    so overhead per chunk = 28 bytes.
      let nonceLen = 12
      let tagLen = 16
      let chunkOverhead = nonceLen + tagLen
      let encryptedSize = dlData.count
      // Default plaintext chunk size = 4 MB (matches beebeeb-types plan_chunks)
      let defaultPlaintextChunkSize = 4 * 1024 * 1024
      // Infer chunk size from total: plaintext per chunk = (sizeBytes / chunkCount) rounded up
      let plaintextChunkSize: Int
      if chunkCount == 1 {
        plaintextChunkSize = sizeBytes
      } else {
        // Use header hint if available, else compute from total size
        let headerChunkSize = (httpDl.value(forHTTPHeaderField: "X-Chunk-Size")).flatMap { Int($0) }
        plaintextChunkSize = headerChunkSize ?? defaultPlaintextChunkSize
      }

      var chunkPaths: [String] = []
      var offset = 0
      for i in 0..<chunkCount {
        let isLastChunk = (i == chunkCount - 1)
        let thisPlaintextSize = isLastChunk
          ? sizeBytes - (plaintextChunkSize * (chunkCount - 1))
          : plaintextChunkSize
        let thisEncryptedSize = thisPlaintextSize + chunkOverhead
        guard offset + thisEncryptedSize <= encryptedSize else { return false }

        let chunkData = dlData[offset..<(offset + thisEncryptedSize)]
        let chunkPath = tempDir + "\(i).enc"
        try Data(chunkData).write(to: URL(fileURLWithPath: chunkPath))
        chunkPaths.append(chunkPath)
        offset += thisEncryptedSize
      }

      // 4. Decrypt via Rust to a temp file
      let decryptedPath = tempDir + "decrypted"
      let _ = try masterKey.decryptFile(
        fileId: fileId, chunkPaths: chunkPaths,
        outputPath: decryptedPath, callback: nil
      )

      // 5. Resize via Rust + encode WebP
      guard let image = UIImage(contentsOfFile: decryptedPath) else { return false }
      guard let webpData = ThumbnailGenerator.generate(from: image, config: .medium)
      else { return false }

      // 6. Encrypt thumbnail as a single AES-256-GCM chunk via Rust
      let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fileKey.encryptChunk(plaintext: webpData)

      // Wire format: nonce(12) || ciphertext — matches the web client
      var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
      wire.append(enc.nonce)
      wire.append(enc.ciphertext)
      guard wire.count <= ThumbnailGenerator.Config.medium.maxBytes + 28 else {
        return false
      }

      // 7. Upload encrypted thumbnail via PUT
      let thumbUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/thumbnail")!
      var thumbReq = URLRequest(url: thumbUrl)
      ProvenanceHeaders.apply(to: &thumbReq)
      thumbReq.httpMethod = "PUT"
      thumbReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      thumbReq.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      thumbReq.httpBody = wire

      let (_, thumbResp) = try await URLSession.shared.data(for: thumbReq)
      guard let httpThumb = thumbResp as? HTTPURLResponse,
            httpThumb.statusCode >= 200, httpThumb.statusCode < 300
      else { return false }

      return true
    }

    AsyncFunction("generateAndUploadPhotoLibraryThumbnailNative") { [self] (
      handleId: Int, apiUrl: String, token: String,
      fileId: String, localIdentifier: String,
      mediaTypeHint: String?, maxSize: Int,
      variant: String?
    ) async throws -> Bool in
      let masterKey = try self.getHandle(handleId)
      let config = ThumbnailGenerator.config(for: variant)
      let variantLabel = variant ?? "medium"

      let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
      guard let phAsset else { return false }

      let thumbnailData: Data
      if phAsset.mediaType == .video || isVideoMediaHint(mediaTypeHint) {
        thumbnailData = try await generatePhotoLibraryVideoThumbnail(
          localIdentifier: localIdentifier,
          maxSize: maxSize,
          config: config
        )
      } else {
        thumbnailData = try await generatePhotoLibraryImageThumbnail(
          localIdentifier: localIdentifier,
          maxSize: maxSize,
          config: config
        )
      }

      let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fileKey.encryptChunk(plaintext: thumbnailData)

      var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
      wire.append(enc.nonce)
      wire.append(enc.ciphertext)
      // maxBytes already accounts for encryption overhead (28 bytes)
      guard wire.count <= config.maxBytes + 28 else {
        NSLog("[BeebeebCrypto] Photo-library \(variantLabel) thumbnail skipped: encrypted payload too large (\(wire.count) bytes)")
        return false
      }

      let suffix = variantLabel == "medium" ? "" : "/\(variantLabel)"
      guard let thumbUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/thumbnail\(suffix)") else {
        return false
      }
      var request = URLRequest(url: thumbUrl)
      ProvenanceHeaders.apply(to: &request)
      request.httpMethod = "PUT"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      request.httpBody = wire

      let (_, response) = try await URLSession.shared.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(statusCode) {
        NSLog("[BeebeebCrypto] Photo-library \(variantLabel) thumbnail uploaded")
        return true
      }
      NSLog("[BeebeebCrypto] Photo-library \(variantLabel) thumbnail upload HTTP \(statusCode)")
      return false
    }
  }
}
