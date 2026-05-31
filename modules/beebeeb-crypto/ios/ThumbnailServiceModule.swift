import ExpoModulesCore
import Foundation
import CoreGraphics

public final class ThumbnailServiceModule: Module, ThumbnailEventEmitter {
  private static var localIdentifierMap: [String: String] = [:]
  private static let localIdentifierMapLock = NSLock()

  static func lookupLocalIdentifier(_ fileId: String) -> String? {
    localIdentifierMapLock.lock()
    defer { localIdentifierMapLock.unlock() }
    return localIdentifierMap[fileId]
  }

  private static var apiBaseURL: URL?
  private static var sessionToken: String?
  private static let credentialsLock = NSLock()

  static func credentials() -> (URL, String)? {
    credentialsLock.lock()
    defer { credentialsLock.unlock() }
    guard let url = apiBaseURL, let token = sessionToken else { return nil }
    return (url, token)
  }

  private static var fileKeys: [String: Data] = [:]
  private static let fileKeysLock = NSLock()

  static func fileKey(_ fileId: String) -> Data? {
    fileKeysLock.lock()
    defer { fileKeysLock.unlock() }
    return fileKeys[fileId]
  }

  internal func emit(_ name: String, body: [String: Any]) {
    sendEvent(name, body)
  }

  public func definition() -> ModuleDefinition {
    Name("ThumbnailService")
    Events("onThumbnailReady", "onAssociationCleared", "onWorkerStage", "onPoolStats", "onFileCompleted", "onWorkerFailure", "onPoolStateChanged")

    OnCreate {
      Task {
        await ThumbnailService.shared.wire(
          emitter: self,
          localIdentifierLookup: { fileId in
            ThumbnailServiceModule.lookupLocalIdentifier(fileId)
          },
          apiCredentialsProvider: {
            ThumbnailServiceModule.credentials()
          },
          remoteThumbnailDecryptProvider: { fileId, nonce, ciphertext in
            if let fileKey = ThumbnailServiceModule.fileKey(fileId) {
              return try BeebeebCryptoBridge.decryptChunk(key: fileKey, nonce: nonce, ciphertext: ciphertext)
            }
            return try BeebeebCryptoBridge.decryptChunkWithCachedMasterKey(
              fileId: fileId,
              nonce: nonce,
              ciphertext: ciphertext
            )
          }
        )
      }
      ThumbnailWorkerPool.shared.startObservers()
      ThumbnailWorkerPool.shared.onWorkerStage = { [weak self] slot, fileId, stage, elapsedMs in
          self?.sendEvent("onWorkerStage", ["slot": slot, "fileId": fileId, "stage": stage, "elapsedMs": elapsedMs])
      }
      ThumbnailWorkerPool.shared.onPoolStats = { [weak self] snap in
          guard let self else { return }
          let data: [String: Any] = [
              "workers": snap.workers.map { ["slot": $0.slot, "fileId": $0.fileId as Any, "stage": $0.stage, "elapsedMs": $0.elapsedMs] },
              "completed": snap.completed,
              "failed": snap.failed,
              "retrying": snap.retrying,
              "queueDepth": snap.queueDepth,
              "filesPerSec": snap.filesPerSec,
              "kbPerSec": snap.kbPerSec,
              "etaSec": snap.etaSec,
              "isPaused": snap.isPaused,
              "isThermalThrottled": snap.isThermalThrottled
          ]
          self.sendEvent("onPoolStats", data)
      }
      ThumbnailWorkerPool.shared.onFileCompleted = { [weak self] fileId, success, category, totalMs, stages in
          self?.sendEvent("onFileCompleted", [
              "fileId": fileId, "success": success,
              "category": category as Any, "totalMs": totalMs,
              "stageBreakdown": stages
          ])
      }
      ThumbnailWorkerPool.shared.onWorkerFailure = { [weak self] fileId, code, msg, attempt in
          self?.sendEvent("onWorkerFailure", [
              "fileId": fileId, "errorCode": code,
              "errorMessage": msg, "attempt": attempt
          ])
      }
      ThumbnailWorkerPool.shared.onPoolStateChanged = { [weak self] state in
          self?.sendEvent("onPoolStateChanged", ["state": state])
      }
    }

    AsyncFunction("getThumbnail") { (fileId: String, width: Double, height: Double) async throws -> [String: Any] in
      let result = try await ThumbnailService.shared.getThumbnail(
        for: fileId,
        targetSize: CGSize(width: width, height: height)
      )
      return [
        "uri": result.fileURL.absoluteString,
        "source": result.source.rawValue,
      ]
    }

    AsyncFunction("removeAssociation") { (fileId: String) async -> Void in
      await ThumbnailService.shared.forgetFile(fileId)
    }

    AsyncFunction("regenerateThumbnail") { (fileId: String, qualityPreset: String) async throws -> [String: Any] in
      let r = try await ThumbnailService.shared.regenerateThumbnail(fileId: fileId, qualityPreset: qualityPreset)
      return [
          "fileId": r.fileId,
          "success": r.success,
          "category": r.category?.rawValue as Any,
          "stageTimings": r.stageTimings,
          "bytesUploaded": r.bytesUploaded
      ]
    }

    AsyncFunction("enqueueApplyQuality") { (fileIds: [String], qualityPreset: String) -> Int in
        ThumbnailWorkerPool.shared.enqueue(fileIds: fileIds, qualityPreset: qualityPreset)
        return fileIds.count
    }

    AsyncFunction("pauseWorkers") { () -> Void in
        ThumbnailWorkerPool.shared.pause()
    }

    AsyncFunction("resumeWorkers") { () -> Void in
        ThumbnailWorkerPool.shared.resume()
    }

    AsyncFunction("retryFile") { (fileId: String) -> Void in
        ThumbnailQueueDB.shared.retry(fileId: fileId)
        ThumbnailWorkerPool.shared.pump()
    }

    AsyncFunction("cancelAllWorkers") { () -> Void in
        ThumbnailWorkerPool.shared.cancelAll()
    }

    AsyncFunction("getQueueStats") { () -> [String: Any] in
        let stats = ThumbnailQueueDB.shared.stats()
        let snap  = ThumbnailWorkerPool.shared.snapshot()
        return [
            "pending": stats.pending,
            "running": stats.running,
            "succeeded": stats.succeeded,
            "failedRetry": stats.failedRetry,
            "failedPerm": stats.failedPerm,
            "filesPerSec": snap.filesPerSec,
            "etaSec": snap.etaSec,
            "isPaused": snap.isPaused,
            "isThermalThrottled": snap.isThermalThrottled
        ]
    }

    AsyncFunction("listFailedPermanentFiles") { () -> [String] in
        return ThumbnailQueueDB.shared.failedPermFileIds()
    }

    AsyncFunction("clearQueueOnSignOut") { () -> Void in
        ThumbnailWorkerPool.shared.cancelAll()
        ThumbnailQueueDB.shared.clearAll()
    }

    AsyncFunction("setLocalIdentifierMap") { (map: [String: String]) -> Void in
      ThumbnailServiceModule.localIdentifierMapLock.lock()
      ThumbnailServiceModule.localIdentifierMap = map
      ThumbnailServiceModule.localIdentifierMapLock.unlock()
    }

    AsyncFunction("setLocalIdentifier") { (fileId: String, localIdentifier: String) -> Void in
      ThumbnailServiceModule.localIdentifierMapLock.lock()
      ThumbnailServiceModule.localIdentifierMap[fileId] = localIdentifier
      ThumbnailServiceModule.localIdentifierMapLock.unlock()
    }

    AsyncFunction("removeLocalIdentifier") { (fileId: String) async -> Void in
      ThumbnailServiceModule.localIdentifierMapLock.lock()
      ThumbnailServiceModule.localIdentifierMap.removeValue(forKey: fileId)
      ThumbnailServiceModule.localIdentifierMapLock.unlock()
      await ThumbnailService.shared.forgetFile(fileId)
    }

    AsyncFunction("setApiCredentials") { (baseURL: String, token: String) -> Void in
      ThumbnailServiceModule.credentialsLock.lock()
      ThumbnailServiceModule.apiBaseURL = URL(string: baseURL)
      ThumbnailServiceModule.sessionToken = token
      ThumbnailServiceModule.credentialsLock.unlock()
    }

    AsyncFunction("setFileKey") { (fileId: String, keyBytes: Data) -> Void in
      ThumbnailServiceModule.fileKeysLock.lock()
      ThumbnailServiceModule.fileKeys[fileId] = keyBytes
      ThumbnailServiceModule.fileKeysLock.unlock()
    }

    AsyncFunction("clearFileKeys") { () -> Void in
      ThumbnailServiceModule.fileKeysLock.lock()
      ThumbnailServiceModule.fileKeys.removeAll()
      ThumbnailServiceModule.fileKeysLock.unlock()
    }

#if DEBUG
    AsyncFunction("runSelfTests") { () async throws -> [String: Any] in
      var results: [String: Bool] = [:]

      let svc = ThumbnailService.shared
      let probeFile = "selftest-\(UUID().uuidString)"
      await svc.forgetFile(probeFile)
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(probeFile).png")
      try? "x".data(using: .utf8)?.write(to: url)
      await svc.setState(.photoKitResolved(url), for: probeFile)
      let didAccept = await svc.writeCache(
        CacheKey(fileId: probeFile, source: .remote),
        url: url
      )
      results["photoKitResolved_drops_remote_write"] = (didAccept == false)

      await svc.forgetFile(probeFile)

      results["service_compiled"] = true
      return results.mapValues { $0 as Any }
    }

    AsyncFunction("__queueDbSmokeTest") { () -> [String: Any] in
        let db = ThumbnailQueueDB.shared
        db.clearAll()
        db.enqueue(fileIds: ["a", "b", "c"], qualityPreset: "w768q082")
        let ready = db.popReady(limit: 2)
        db.markSucceeded(fileId: "a")
        db.recordFailure(fileId: "b", category: .network_5xx, message: "test")
        let stats = db.stats()
        return [
            "popped": ready.count,
            "pending": stats.pending,
            "running": stats.running,
            "succeeded": stats.succeeded,
            "failed_retry": stats.failedRetry
        ]
    }
#endif
  }
}

extension ThumbnailService {
  func wire(
    emitter: ThumbnailEventEmitter,
    localIdentifierLookup: @escaping (FileId) -> String?,
    apiCredentialsProvider: @escaping () async -> (URL, String)?,
    remoteThumbnailDecryptProvider: @escaping (FileId, Data, Data) async throws -> Data?
  ) {
    self.eventEmitter = emitter
    self.localIdentifierLookup = localIdentifierLookup
    self.apiCredentialsProvider = apiCredentialsProvider
    self.remoteThumbnailDecryptProvider = remoteThumbnailDecryptProvider
  }
}
