import AVFoundation
import Foundation
import Photos
import SQLite3
import UIKit
import UserNotifications
#if os(iOS)
import BackgroundTasks
import Network
#endif

// MARK: - Types

enum BackupError: LocalizedError {
  case assetNotFound
  case assetLoadFailed
  case databaseUnavailable
  case noMasterKey
  case notConfigured
  case invalidServerURL
  case invalidResponse
  case httpStatus(Int, String)
  case jsonEncoding
  case encryptionFailed(String)

  var errorDescription: String? {
    switch self {
    case .assetNotFound: return "Photo asset not found in library"
    case .assetLoadFailed: return "Failed to load photo data from library"
    case .databaseUnavailable: return "Backup database unavailable"
    case .noMasterKey: return "Master key not available — sign in required"
    case .notConfigured: return "Backup engine not configured (missing token or API URL)"
    case .invalidServerURL: return "Invalid server URL for backup"
    case .invalidResponse: return "Invalid server response"
    case .httpStatus(let code, let body):
      return body.isEmpty ? "HTTP \(code)" : "HTTP \(code): \(body)"
    case .jsonEncoding: return "JSON encoding failed"
    case .encryptionFailed(let msg): return "Encryption failed: \(msg)"
    }
  }
}

/// Row from the backup_assets SQLite table.
struct BackupAssetRow {
  let localAssetId: String
  let assetType: String
  let contentHash: String
  let fileSize: Int64
  let createdAt: String
  let retryCount: Int
  let errorMessage: String?
  let filename: String? // Not stored in DB — resolved from PHAsset at upload time
}

// MARK: - NativeBackupEngine

/// Native Swift backup engine replacing the JS-based PhotoSyncEngine.
///
/// Architecture:
/// - PHPhotoLibraryChangeObserver for real-time asset detection
/// - 3-concurrent TaskGroup upload pipeline
/// - Rust encrypt via MasterKeyHandle -> FileKeyHandle -> encryptChunk (chunks written to temp files)
/// - Rust `uploadEncryptedFile()` from beebeeb-upload crate handles init/chunk-upload/complete
/// - Shared SQLite database (backup_assets) with JS UI layer via WAL mode
/// - Expo EventEmitter bridge for progress -> React
///
/// Encryption uses the MasterKeyHandle -> FileKeyHandle -> encryptChunk path,
/// writing encrypted chunks to temp files. The Rust `uploadEncryptedFile()`
/// function from the beebeeb-upload crate then handles the full upload
/// protocol (init session, upload chunks, complete) in a single blocking call.
final class NativeBackupEngine: NSObject {
  static let shared = NativeBackupEngine()

  private func perfLog(_ event: String, _ fields: [String: CustomStringConvertible] = [:]) {
    let suffix = fields
      .map { "\($0.key)=\($0.value)" }
      .sorted()
      .joined(separator: " ")
    if suffix.isEmpty {
      NSLog("[BeebeebPerf] backup.native.\(event)")
    } else {
      NSLog("[BeebeebPerf] backup.native.\(event) \(suffix)")
    }
  }

  // MARK: - Private state

  private let queue = DispatchQueue(label: "io.beebeeb.backup.engine", qos: .utility)
  private let dbQueue = DispatchQueue(label: "io.beebeeb.backup.engine.db", qos: .utility)
  private var backgroundSession: URLSession!
  private var metadataSession: URLSession!
  private var db: OpaquePointer?
  private var masterKeyHandle: MasterKeyHandle?
  private var isRunning = false
  private var isPaused = false
  private var uploadTaskMap: [Int: String] = [:] // URLSessionTask.taskIdentifier -> localAssetId
  private var drainTask: Task<Void, Never>?
  private var currentFetchResult: PHFetchResult<PHAsset>?
  #if os(iOS)
  private var networkMonitor: NWPathMonitor?
  private var isNetworkAvailable = true
  #endif

  // Chunk size matching existing uploader (4 MB)
  private let chunkSize = 4 * 1024 * 1024

  // Backoff state
  private var consecutiveFailures = 0
  private var backoffUntil: Date?

  static let bgTaskIdentifier = "io.beebeeb.app.native-backup"
  static let bgSessionIdentifier = "io.beebeeb.backup"

  // MARK: - Configuration (set by JS before calling start)

  var parentFolderId: String?

  var token: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.backupToken") }
    set { UserDefaults.standard.set(newValue, forKey: "io.beebeeb.backupToken") }
  }

  var apiBaseUrl: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.serverURL") }
    set { UserDefaults.standard.set(newValue, forKey: "io.beebeeb.serverURL") }
  }

  // MARK: - Progress (thread-safe via atomic reads from main queue)

  private(set) var totalAssets = 0
  private(set) var completedAssets = 0
  private(set) var failedAssets = 0
  private(set) var inProgressAssets = 0
  private(set) var bytesUploaded: Int64 = 0
  private(set) var bytesTotal: Int64 = 0

  // MARK: - Callbacks

  /// Progress callback invoked on each asset completion. Called on arbitrary queue.
  var onProgress: ((_ total: Int, _ completed: Int, _ failed: Int) -> Void)?

  /// Per-file status callback.
  var onFileStatus: ((_ assetId: String, _ status: String, _ filename: String?, _ error: String?) -> Void)?

  /// Completion callback when a batch finishes.
  var onBatchComplete: ((_ uploaded: Int, _ failed: Int, _ duration: TimeInterval) -> Void)?

  // MARK: - Init

  private override init() {
    super.init()
    setupBackgroundSession()
    setupMetadataSession()
    dbQueue.sync { openDatabase() }
  }

  // MARK: - URLSession Setup

  private func setupBackgroundSession() {
    let config = URLSessionConfiguration.background(withIdentifier: Self.bgSessionIdentifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = true // Respect user's wifiOnly setting separately
    config.timeoutIntervalForResource = 60 * 60 // 1 hour for large files
    config.httpMaximumConnectionsPerHost = 3
    backgroundSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  private func setupMetadataSession() {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 60
    metadataSession = URLSession(configuration: config)
  }

  // MARK: - Lifecycle

  /// Start the backup engine. Loads the master key from keychain, registers
  /// the photo library observer, and begins draining the upload queue.
  func start() {
    guard !isRunning else { return }

    do {
      guard let mk = try BeebeebCryptoBridge.loadMasterKey() else {
        NSLog("[NativeBackupEngine] No master key in keychain — cannot start")
        return
      }
      masterKeyHandle = mk
    } catch {
      NSLog("[NativeBackupEngine] Failed to load master key: \(error.localizedDescription)")
      return
    }

    guard token != nil, apiBaseUrl != nil else {
      NSLog("[NativeBackupEngine] Missing token or apiBaseUrl — cannot start")
      return
    }

    isRunning = true
    perfLog("start", [
      "total": totalAssets,
      "completed": completedAssets
    ])
    isPaused = false
    consecutiveFailures = 0
    backoffUntil = nil

    refreshProgress()
    registerPhotoObserver()
    startNetworkMonitor()
    startDrainLoop()

    NSLog("[NativeBackupEngine] Started — \(totalAssets) total, \(completedAssets) completed")
  }

  /// Stop the backup engine. Cancels the drain loop, unregisters observers,
  /// and clears the cached master key. In-flight NSURLSession background
  /// uploads continue independently.
  func stop() {
    guard isRunning else { return }
    isRunning = false
    isPaused = false

    drainTask?.cancel()
    drainTask = nil

    PHPhotoLibrary.shared().unregisterChangeObserver(self)
    stopNetworkMonitor()

    // Clear sensitive state
    masterKeyHandle = nil
    uploadTaskMap.removeAll()

    // Recover any rows stuck in 'uploading' state
    dbQueue.async { [weak self] in
      self?.recoverStuckUploads()
    }

    perfLog("stop", [
      "total": totalAssets,
      "completed": completedAssets,
      "inProgress": inProgressAssets
    ])
    NSLog("[NativeBackupEngine] Stopped")
  }

  /// Pause the drain loop without clearing state. Background uploads continue.
  func pause() {
    isPaused = true
    perfLog("pause")
    NSLog("[NativeBackupEngine] Paused")
  }

  /// Resume after pause.
  func resume() {
    guard isRunning else { return }
    isPaused = false
    perfLog("resume")
    NSLog("[NativeBackupEngine] Resumed")
  }

  /// Return current progress as a dictionary suitable for JS bridge.
  func currentProgress() -> [String: Any] {
    refreshProgress()
    return [
      "total": totalAssets,
      "completed": completedAssets,
      "inProgress": inProgressAssets,
      "failed": failedAssets,
      "bytesUploaded": bytesUploaded,
      "bytesTotal": bytesTotal,
      "isRunning": isRunning,
      "isPaused": isPaused,
    ]
  }

  // MARK: - Background task registration

  #if os(iOS)
  func registerBackgroundTask() {
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: Self.bgTaskIdentifier,
      using: nil
    ) { [weak self] task in
      guard let processingTask = task as? BGProcessingTask else { return }
      self?.handleBackgroundTask(processingTask)
    }
  }

  func scheduleNextBackup() {
    let request = BGProcessingTaskRequest(identifier: Self.bgTaskIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    try? BGTaskScheduler.shared.submit(request)
  }

  private func handleBackgroundTask(_ task: BGProcessingTask) {
    scheduleNextBackup()

    task.expirationHandler = { [weak self] in
      self?.pause()
    }

    Task {
      // Ensure master key is available for background processing
      if masterKeyHandle == nil {
        do {
          masterKeyHandle = try BeebeebCryptoBridge.loadMasterKey()
        } catch {
          task.setTaskCompleted(success: false)
          return
        }
      }

      guard masterKeyHandle != nil else {
        task.setTaskCompleted(success: false)
        return
      }

      let batchStart = isRunning
      if !isRunning {
        isRunning = true
        isPaused = false
      }

      do {
        let uploaded = try await processBatch(limit: 50)
        task.setTaskCompleted(success: uploaded >= 0)
      } catch {
        task.setTaskCompleted(success: false)
      }

      if !batchStart {
        isRunning = false
      }
    }
  }
  #endif

  func handleBackgroundSessionEvents(identifier: String, completionHandler: @escaping () -> Void) {
    // iOS delivers pending delegate messages after relaunching the app.
    // Store the completion handler so we call it after all events are delivered.
    backgroundSessionCompletionHandler = completionHandler
  }

  private var backgroundSessionCompletionHandler: (() -> Void)?

  // MARK: - Photo Library Observer

  private func registerPhotoObserver() {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard status == .authorized || status == .limited else {
      NSLog("[NativeBackupEngine] Photo library not authorized (status: \(status.rawValue))")
      return
    }

    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    // Fetch both images and videos
    options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
                                    PHAssetMediaType.image.rawValue,
                                    PHAssetMediaType.video.rawValue)
    let result = PHAsset.fetchAssets(with: options)
    currentFetchResult = result

    // Insert any new assets not yet in the database
    var assets: [PHAsset] = []
    result.enumerateObjects { asset, _, _ in assets.append(asset) }
    dbQueue.async { [weak self] in
      self?.insertNewAssets(assets)
    }

    PHPhotoLibrary.shared().register(self)
  }

  // MARK: - Network Monitor

  private func startNetworkMonitor() {
    #if os(iOS)
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      let wasAvailable = self?.isNetworkAvailable ?? false
      self?.isNetworkAvailable = path.status == .satisfied

      // Resume drain loop when network comes back
      if !wasAvailable && path.status == .satisfied {
        NSLog("[NativeBackupEngine] Network restored — resuming")
        self?.isPaused = false
      }
    }
    monitor.start(queue: queue)
    networkMonitor = monitor
    #endif
  }

  private func stopNetworkMonitor() {
    #if os(iOS)
    networkMonitor?.cancel()
    networkMonitor = nil
    #endif
  }

  // MARK: - Drain Loop

  private func startDrainLoop() {
    drainTask?.cancel()
    drainTask = Task { [weak self] in
      while let self, self.isRunning, !Task.isCancelled {
        if self.isPaused {
          try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s
          continue
        }

        // Respect backoff
        if let backoff = self.backoffUntil, Date() < backoff {
          let remaining = backoff.timeIntervalSinceNow
          try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
          continue
        }

        do {
          let uploaded = try await self.processBatch(limit: 30)
          if uploaded == 0 {
            // No pending work — sleep before checking again
            try? await Task.sleep(nanoseconds: 10_000_000_000) // 10s
          } else {
            // Brief pause between batches to avoid overwhelming the device
            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5s
          }
        } catch {
          NSLog("[NativeBackupEngine] Batch error: \(error.localizedDescription)")
          try? await Task.sleep(nanoseconds: 5_000_000_000) // 5s on error
        }
      }
    }
  }

  // MARK: - Core Upload Pipeline

  /// Process a batch of pending uploads. Returns the number of successfully uploaded assets.
  func processBatch(limit: Int = 30) async throws -> Int {
    guard isRunning, let masterKey = masterKeyHandle else { return 0 }
    guard let authToken = token, let baseURL = apiBaseUrl else {
      throw BackupError.notConfigured
    }

    // Recover stuck uploads on each batch start
    dbQueue.sync { recoverStuckUploads() }

    // Get pending assets from database
    let pending = dbQueue.sync { getPendingUploads(limit: limit) }
    perfLog("batch.start", [
      "limit": limit,
      "pending": pending.count,
      "running": isRunning
    ])
    if pending.isEmpty { return 0 }

    let batchStart = Date()
    var uploaded = 0

    // Process with concurrency limit of 3
    await withTaskGroup(of: Bool.self) { group in
      var activeCount = 0
      var index = 0

      while index < pending.count || !group.isEmpty {
        // Add tasks up to concurrency limit
        while activeCount < 3 && index < pending.count {
          let asset = pending[index]
          index += 1
          activeCount += 1

          group.addTask { [weak self] in
            guard let self else { return false }
            return await self.uploadSingleAsset(
              asset,
              masterKey: masterKey,
              authToken: authToken,
              baseURL: baseURL
            )
          }
        }

        // Wait for one to complete
        if let result = await group.next() {
          activeCount -= 1
          if result {
            uploaded += 1
            self.consecutiveFailures = 0
          } else {
            self.consecutiveFailures += 1
            // 5 consecutive failures: 60s backoff
            if self.consecutiveFailures >= 5 {
              self.backoffUntil = Date().addingTimeInterval(60)
              NSLog("[NativeBackupEngine] 5 consecutive failures — backing off 60s")
            }
          }
        }
      }
    }

    let duration = Date().timeIntervalSince(batchStart)
    perfLog("batch.finish", [
      "uploaded": uploaded,
      "pending": pending.count,
      "durationMs": Int(duration * 1000)
    ])
    refreshProgress()

    onProgress?(totalAssets, completedAssets, failedAssets)
    onBatchComplete?(uploaded, pending.count - uploaded, duration)

    NSLog("[NativeBackupEngine] Batch complete: \(uploaded)/\(pending.count) uploaded in \(String(format: "%.1f", duration))s")

    #if os(iOS)
    // Update persistent notification
    if isRunning {
      updateNotification(uploaded: completedAssets, total: totalAssets, isComplete: pending.isEmpty && uploaded > 0)
    }
    #endif

    return uploaded
  }

  // MARK: - Single Asset Upload

  private func uploadSingleAsset(
    _ asset: BackupAssetRow,
    masterKey: MasterKeyHandle,
    authToken: String,
    baseURL: String
  ) async -> Bool {
    dbQueue.sync { markUploading(assetId: asset.localAssetId) }
    onFileStatus?(asset.localAssetId, "uploading", nil, nil)
    perfLog("asset.start", [
      "assetType": asset.assetType,
      "retry": asset.retryCount
    ])

    do {
      // 1. Get photo data from PHAsset
      let (data, uti) = try await fetchAssetData(localId: asset.localAssetId)

      // 2. Generate file ID and derive file key
      let fileId = UUID().uuidString.lowercased()
      let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))

      // 3. Encrypt chunks to temp files on disk for the Rust upload protocol
      let chunkResults = try encryptData(data: data, fileKey: fileKey)
      let tempDir = NSTemporaryDirectory()
      var chunkPaths: [String] = []
      for (index, chunk) in chunkResults.enumerated() {
        var chunkData = Data()
        chunkData.append(chunk.nonce)
        chunkData.append(chunk.ciphertext)
        let path = (tempDir as NSString).appendingPathComponent("upload-\(fileId)-\(index).enc")
        try chunkData.write(to: URL(fileURLWithPath: path))
        chunkPaths.append(path)
      }
      defer {
        for path in chunkPaths {
          try? FileManager.default.removeItem(atPath: path)
        }
      }

      // 4. Encrypt filename
      let ext = fileExtension(for: uti)
      let filename = "IMG_\(fileId).\(ext)"
      let mimeType = mimeTypeFromUTI(uti)
      let nameEncrypted = try masterKey.encryptName(fileId: fileId, filename: filename, mimeType: mimeType)

      // 5. Upload via Rust — handles init, chunk upload, and complete in one call
      let createdAt = ISO8601DateFormatter().string(from: Date())
      let result = try uploadEncryptedFile(
        apiUrl: baseURL,
        token: authToken,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        parentId: self.parentFolderId,
        mimeType: mimeType,
        isMedia: isMedia(mimeType: mimeType),
        chunkPaths: chunkPaths,
        originalSize: UInt64(data.count),
        createdAt: createdAt,
        callback: nil
      )

      // 6. Mark complete in database
      let serverFileId = result.fileId
      dbQueue.sync {
        markUploadComplete(assetId: asset.localAssetId, remoteFileId: serverFileId)
      }
      completedAssets += 1
      bytesUploaded += Int64(data.count)
      perfLog("asset.finish", [
        "bytes": data.count,
        "chunks": result.chunksUploaded
      ])

      onFileStatus?(asset.localAssetId, "uploaded", filename, nil)
      NSLog("[NativeBackupEngine] Uploaded asset (\(data.count) bytes, \(result.chunksUploaded) chunks via Rust)")

      // 7. Generate and upload thumbnail (best-effort, never blocks the upload)
      generateAndUploadThumbnail(
        phAssetId: asset.localAssetId,
        serverFileId: serverFileId,
        uti: uti,
        masterKey: masterKey,
        authToken: authToken,
        baseURL: baseURL
      )

      return true

      // --- Legacy Swift HTTP upload code (commented out for quick revert) ---
      //
      // // 5. Compute total ciphertext size
      // var totalCiphertextBytes = 0
      // for chunk in chunkResults {
      //   totalCiphertextBytes += chunk.nonce.count + chunk.ciphertext.count
      // }
      //
      // // 6. Init upload session via metadata session (not background session)
      // let serverFileId = try await initUploadSession(
      //   fileId: fileId,
      //   nameEncrypted: nameEncrypted,
      //   mimeType: mimeType,
      //   isMedia: isMedia(mimeType: mimeType),
      //   sizeBytes: data.count,
      //   chunkCount: chunkResults.count,
      //   authToken: authToken,
      //   baseURL: baseURL
      // )
      //
      // // 7. Upload each chunk
      // for (index, chunk) in chunkResults.enumerated() {
      //   var chunkData = Data()
      //   chunkData.append(chunk.nonce)
      //   chunkData.append(chunk.ciphertext)
      //
      //   try await uploadChunk(
      //     serverFileId: serverFileId,
      //     chunkIndex: index,
      //     chunkData: chunkData,
      //     authToken: authToken,
      //     baseURL: baseURL
      //   )
      // }
      //
      // // 8. Complete upload
      // try await completeUpload(
      //   serverFileId: serverFileId,
      //   authToken: authToken,
      //   baseURL: baseURL
      // )
      //
      // // 9. Mark complete in database
      // dbQueue.sync {
      //   markUploadComplete(assetId: asset.localAssetId, remoteFileId: serverFileId)
      // }
      // completedAssets += 1
      // bytesUploaded += Int64(data.count)
      //
      // onFileStatus?(asset.localAssetId, "uploaded", filename, nil)
      // NSLog("[NativeBackupEngine] Uploaded asset (\(data.count) bytes)")
      //
      // return true
      // --- End legacy Swift HTTP upload code ---

    } catch {
      perfLog("asset.fail", [
        "assetType": asset.assetType,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        markFailed(assetId: asset.localAssetId, error: error.localizedDescription)
      }
      failedAssets += 1

      onFileStatus?(asset.localAssetId, "failed", nil, error.localizedDescription)
      NSLog("[NativeBackupEngine] Asset upload failed: \(error.localizedDescription)")

      return false
    }
  }

  // MARK: - Encryption

  /// Encrypt data into chunks using the existing FileKeyHandle.encryptChunk API.
  /// Returns an array of EncryptedData (nonce + ciphertext per chunk).
  private func encryptData(data: Data, fileKey: FileKeyHandle) throws -> [EncryptedData] {
    var results: [EncryptedData] = []
    let totalChunks = max(1, Int(ceil(Double(data.count) / Double(chunkSize))))

    for i in 0..<totalChunks {
      let start = i * chunkSize
      let end = min(start + chunkSize, data.count)
      let chunkPlaintext = start < end ? data.subdata(in: start..<end) : Data()
      let encrypted = try fileKey.encryptChunk(plaintext: chunkPlaintext)
      results.append(encrypted)
    }

    return results
  }

  // MARK: - PHAsset Data Fetch

  private func fetchAssetData(localId: String) async throws -> (Data, String) {
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
    guard let phAsset = fetchResult.firstObject else {
      throw BackupError.assetNotFound
    }

    if phAsset.mediaType == .video {
      return try await fetchVideoData(phAsset: phAsset)
    }

    return try await withCheckedThrowingContinuation { continuation in
      let options = PHImageRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      options.deliveryMode = .highQualityFormat

      PHImageManager.default().requestImageDataAndOrientation(for: phAsset, options: options) { data, uti, _, info in
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let data = data {
          continuation.resume(returning: (data, uti ?? "public.jpeg"))
        } else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
        }
      }
    }
  }

  private func fetchVideoData(phAsset: PHAsset) async throws -> (Data, String) {
    return try await withCheckedThrowingContinuation { continuation in
      let options = PHVideoRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true

      PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { avAsset, _, info in
        guard let urlAsset = avAsset as? AVURLAsset else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
          return
        }

        do {
          let data = try Data(contentsOf: urlAsset.url)
          let uti = urlAsset.url.pathExtension == "mov" ? "com.apple.quicktime-movie" : "public.mpeg-4"
          continuation.resume(returning: (data, uti))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  // MARK: - API Calls (metadata session — standard URLSession, not background)

  private func initUploadSession(
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    isMedia: Bool,
    sizeBytes: Int,
    chunkCount: Int,
    authToken: String,
    baseURL: String
  ) async throws -> String {
    guard let url = URL(string: "\(baseURL)/api/v1/files/upload/init") else {
      throw BackupError.invalidServerURL
    }

    let body: [String: Any] = [
      "file_id": fileId,
      "name_encrypted": nameEncrypted,
      "parent_id": parentFolderId as Any? ?? NSNull(),
      "mime_type": NSNull(),
      "is_media": isMedia,
      "size_bytes": sizeBytes,
      "chunk_count": chunkCount,
    ]
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
      throw BackupError.jsonEncoding
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = bodyData

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    // Handle rate limiting
    if statusCode == 429 {
      if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
         let seconds = Double(retryAfter) {
        backoffUntil = Date().addingTimeInterval(seconds)
      } else {
        backoffUntil = Date().addingTimeInterval(60)
      }
      throw BackupError.httpStatus(429, "Rate limited")
    }

    guard (200..<300).contains(statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw BackupError.httpStatus(statusCode, body)
    }

    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let serverFileId = json["file_id"] as? String,
          !serverFileId.isEmpty else {
      throw BackupError.invalidResponse
    }

    return serverFileId
  }

  private func uploadChunk(
    serverFileId: String,
    chunkIndex: Int,
    chunkData: Data,
    authToken: String,
    baseURL: String
  ) async throws {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/chunks/\(chunkIndex)") else {
      throw BackupError.invalidServerURL
    }

    // Write chunk to temp file for background-safe upload
    let tempDir = NSTemporaryDirectory()
    let tempFile = URL(fileURLWithPath: tempDir).appendingPathComponent("chunk-\(serverFileId)-\(chunkIndex).enc")
    try chunkData.write(to: tempFile)
    defer { try? FileManager.default.removeItem(at: tempFile) }

    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

    // Use uploadTask(with:fromFile:) for background-safe transfer.
    // For now we await the result synchronously within the TaskGroup.
    // The background session handles retries and survives app suspension.
    let (_, response) = try await backgroundSession.upload(for: request, fromFile: tempFile)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    if statusCode == 429 {
      if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
         let seconds = Double(retryAfter) {
        backoffUntil = Date().addingTimeInterval(seconds)
      }
      throw BackupError.httpStatus(429, "Rate limited")
    }

    guard (200..<300).contains(statusCode) else {
      throw BackupError.httpStatus(statusCode, "Chunk upload failed")
    }
  }

  private func completeUpload(
    serverFileId: String,
    authToken: String,
    baseURL: String
  ) async throws {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/upload/complete") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    guard (200..<300).contains(statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw BackupError.httpStatus(statusCode, body)
    }
  }

  // MARK: - SQLite Database

  /// Open the SAME database as the JS PhotoSyncEngine (beebeeb-backup.db).
  /// expo-sqlite stores databases in <documentDir>/SQLite/<name>.
  private func openDatabase() {
    let documentDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    let sqliteDir = documentDir.appendingPathComponent("SQLite", isDirectory: true)
    try? FileManager.default.createDirectory(at: sqliteDir, withIntermediateDirectories: true)
    let path = sqliteDir.appendingPathComponent("beebeeb-backup.db").path

    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
      NSLog("[NativeBackupEngine] Failed to open database at \(path)")
      db = nil
      return
    }

    // Enable WAL mode for concurrent access with JS layer
    sqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil)

    // Ensure tables exist (safe to call even if JS already created them)
    ensureTables()
  }

  private func ensureTables() {
    guard let db = db else { return }

    let sql = """
    CREATE TABLE IF NOT EXISTS backup_assets (
      local_asset_id TEXT PRIMARY KEY,
      remote_file_id TEXT,
      remote_path TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      uploaded_at TEXT,
      asset_type TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at INTEGER,
      last_attempt_at INTEGER,
      retry_count INTEGER DEFAULT 0,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backup_assets_status_type
      ON backup_assets(status, asset_type);
    CREATE INDEX IF NOT EXISTS idx_backup_assets_created_at
      ON backup_assets(created_at);
    """
    sqlite3_exec(db, sql, nil, nil, nil)
  }

  /// Insert new assets from the photo library that are not already tracked.
  private func insertNewAssets(_ assets: [PHAsset]) {
    guard let db = db else { return }
    let now = ISO8601DateFormatter().string(from: Date())
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    let sql = """
    INSERT OR IGNORE INTO backup_assets
      (local_asset_id, content_hash, file_size, created_at, asset_type, status, queued_at)
    VALUES (?, '', 0, ?, ?, 'pending_upload', ?)
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }

    sqlite3_exec(db, "BEGIN", nil, nil, nil)
    for asset in assets {
      let assetType: String = asset.mediaType == .video ? "video" : "photo"

      sqlite3_bind_text(stmt, 1, (asset.localIdentifier as NSString).utf8String, -1, transient)
      sqlite3_bind_text(stmt, 2, (now as NSString).utf8String, -1, transient)
      sqlite3_bind_text(stmt, 3, (assetType as NSString).utf8String, -1, transient)
      sqlite3_bind_int64(stmt, 4, nowMs)
      sqlite3_step(stmt)
      sqlite3_reset(stmt)
    }
    sqlite3_exec(db, "COMMIT", nil, nil, nil)
  }

  /// Get pending uploads ordered by creation date (newest first), respecting retry limits.
  func getPendingUploads(limit: Int) -> [BackupAssetRow] {
    guard let db = db else { return [] }
    var results: [BackupAssetRow] = []

    let sql = """
    SELECT local_asset_id, asset_type, content_hash, file_size, created_at,
           COALESCE(retry_count, 0), error_message
    FROM backup_assets
    WHERE status IN ('pending_upload', 'pending_reupload')
      AND COALESCE(retry_count, 0) < 10
    ORDER BY created_at DESC
    LIMIT ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int(stmt, 1, Int32(limit))

    while sqlite3_step(stmt) == SQLITE_ROW {
      let localAssetId = String(cString: sqlite3_column_text(stmt, 0))
      let assetType = String(cString: sqlite3_column_text(stmt, 1))
      let contentHash = String(cString: sqlite3_column_text(stmt, 2))
      let fileSize = sqlite3_column_int64(stmt, 3)
      let createdAt = String(cString: sqlite3_column_text(stmt, 4))
      let retryCount = Int(sqlite3_column_int(stmt, 5))
      let errorMsg: String? = sqlite3_column_type(stmt, 6) != SQLITE_NULL
        ? String(cString: sqlite3_column_text(stmt, 6))
        : nil

      results.append(BackupAssetRow(
        localAssetId: localAssetId,
        assetType: assetType,
        contentHash: contentHash,
        fileSize: fileSize,
        createdAt: createdAt,
        retryCount: retryCount,
        errorMessage: errorMsg,
        filename: nil
      ))
    }

    return results
  }

  /// Mark an asset as currently uploading.
  private func markUploading(assetId: String) {
    guard let db = db else { return }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    let sql = "UPDATE backup_assets SET status = 'uploading', last_attempt_at = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, nowMs)
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  /// Mark an asset as successfully uploaded.
  private func markUploadComplete(assetId: String, remoteFileId: String) {
    guard let db = db else { return }
    let now = ISO8601DateFormatter().string(from: Date())
    let sql = """
    UPDATE backup_assets
    SET status = 'uploaded', remote_file_id = ?, uploaded_at = ?, error_message = NULL
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (remoteFileId as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 2, (now as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  /// Mark an asset as failed, incrementing retry count.
  private func markFailed(assetId: String, error: String) {
    guard let db = db else { return }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    // Increment retry_count. Assets with retry_count >= 10 become dead letters.
    let sql = """
    UPDATE backup_assets
    SET status = 'pending_upload',
        retry_count = COALESCE(retry_count, 0) + 1,
        error_message = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (error as NSString).utf8String, -1, nil)
    sqlite3_bind_int64(stmt, 2, nowMs)
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  /// Recover assets stuck in 'uploading' state for more than 5 minutes.
  /// This handles crashes or app terminations mid-upload.
  func recoverStuckUploads() {
    guard let db = db else { return }
    let fiveMinAgoMs = Int64((Date().timeIntervalSince1970 - 300) * 1000)
    let sql = """
    UPDATE backup_assets
    SET status = 'pending_upload'
    WHERE status = 'uploading'
      AND (last_attempt_at IS NULL OR last_attempt_at < ?)
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, fiveMinAgoMs)
    sqlite3_step(stmt)

    let changes = sqlite3_changes(db)
    if changes > 0 {
      NSLog("[NativeBackupEngine] Recovered \(changes) stuck uploads")
    }
  }

  /// Refresh progress counters from the database.
  private func refreshProgress() {
    dbQueue.sync {
      guard let db = db else { return }
      totalAssets = countWhere(db: db, condition: "1=1")
      completedAssets = countWhere(db: db, condition: "status = 'uploaded'")
      failedAssets = countWhere(db: db, condition: "COALESCE(retry_count, 0) >= 10")
      inProgressAssets = countWhere(db: db, condition: "status = 'uploading'")
    }
  }

  private func countWhere(db: OpaquePointer, condition: String) -> Int {
    var stmt: OpaquePointer?
    let sql = "SELECT COUNT(*) FROM backup_assets WHERE \(condition)"
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { sqlite3_finalize(stmt) }
    return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
  }

  // MARK: - Notification

  #if os(iOS)
  private func updateNotification(uploaded: Int, total: Int, isComplete: Bool) {
    let content = UNMutableNotificationContent()
    content.title = "Beebeeb Backup"
    if isComplete {
      content.body = "\(total) photos secured"
    } else {
      content.body = "Backing up \(uploaded) of \(total) photos"
    }
    content.sound = nil

    let request = UNNotificationRequest(
      identifier: "io.beebeeb.backup-progress",
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request) { _ in }

    if isComplete {
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
      }
    }
  }
  #endif

  // MARK: - Thumbnail Generation

  /// Maximum dimension for generated thumbnails (matches JS THUMB_WIDTH).
  private let thumbMaxSize = 256

  /// Generate and upload a thumbnail for an uploaded asset.
  /// Best-effort: failures are logged but never block the upload pipeline.
  private func generateAndUploadThumbnail(
    phAssetId: String,
    serverFileId: String,
    uti: String,
    masterKey: MasterKeyHandle,
    authToken: String,
    baseURL: String
  ) {
    Task.detached(priority: .utility) { [weak self] in
      guard let self else { return }
      do {
        let jpegData: Data
        if self.isVideoUTI(uti) {
          jpegData = try await self.generateVideoThumbnail(phAssetId: phAssetId)
        } else {
          jpegData = try await self.generateImageThumbnail(phAssetId: phAssetId)
        }

        // Encrypt thumbnail as single AES-256-GCM chunk
        let fileKey = try masterKey.deriveFileKey(fileId: Data(serverFileId.utf8))
        let enc = try fileKey.encryptChunk(plaintext: jpegData)

        // Wire format: nonce(12) || ciphertext — matches the web client
        var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
        wire.append(enc.nonce)
        wire.append(enc.ciphertext)

        // Upload via PUT
        guard let thumbUrl = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/thumbnail") else { return }
        var request = URLRequest(url: thumbUrl)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = wire

        let (_, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(statusCode) {
          NSLog("[NativeBackupEngine] Thumbnail uploaded for \(serverFileId)")
        } else {
          NSLog("[NativeBackupEngine] Thumbnail upload HTTP \(statusCode) for \(serverFileId)")
        }
      } catch {
        NSLog("[NativeBackupEngine] Thumbnail generation failed for \(phAssetId): \(error.localizedDescription)")
      }
    }
  }

  /// Generate a JPEG thumbnail from a video asset using AVAssetImageGenerator.
  private func generateVideoThumbnail(phAssetId: String) async throws -> Data {
    let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [phAssetId], options: nil).firstObject
    guard let phAsset else { throw BackupError.assetNotFound }

    let avAsset: AVAsset = try await withCheckedThrowingContinuation { continuation in
      let options = PHVideoRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { asset, _, info in
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let asset {
          continuation.resume(returning: asset)
        } else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
        }
      }
    }

    let generator = AVAssetImageGenerator(asset: avAsset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: thumbMaxSize, height: thumbMaxSize)

    let time = CMTime(seconds: 1.0, preferredTimescale: 600)
    let cgImage: CGImage
    do {
      cgImage = try generator.copyCGImage(at: time, actualTime: nil)
    } catch {
      // Fall back to time 0 if 1s is beyond the video duration
      cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
    }

    let image = UIImage(cgImage: cgImage)
    guard let jpeg = image.jpegData(compressionQuality: 0.7) else {
      throw BackupError.assetLoadFailed
    }
    return jpeg
  }

  /// Generate a JPEG thumbnail from an image asset (JPEG, HEIC, PNG, DNG, etc).
  /// Uses PHImageManager to get a small preview — this works for all image types
  /// including RAW/DNG because Photos.framework handles the decoding.
  private func generateImageThumbnail(phAssetId: String) async throws -> Data {
    let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [phAssetId], options: nil).firstObject
    guard let phAsset else { throw BackupError.assetNotFound }

    let image: UIImage = try await withCheckedThrowingContinuation { continuation in
      let options = PHImageRequestOptions()
      options.deliveryMode = .highQualityFormat
      options.isNetworkAccessAllowed = true
      options.isSynchronous = false
      options.resizeMode = .fast

      let targetSize = CGSize(width: thumbMaxSize, height: thumbMaxSize)
      PHImageManager.default().requestImage(
        for: phAsset,
        targetSize: targetSize,
        contentMode: .aspectFit,
        options: options
      ) { result, info in
        let isDegraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
        if isDegraded { return } // Wait for the high-quality callback
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let result {
          continuation.resume(returning: result)
        } else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
        }
      }
    }

    guard let jpeg = image.jpegData(compressionQuality: 0.7) else {
      throw BackupError.assetLoadFailed
    }
    return jpeg
  }

  /// Whether the given UTI represents a video type.
  private func isVideoUTI(_ uti: String) -> Bool {
    return uti == "com.apple.quicktime-movie" || uti == "public.mpeg-4" ||
           uti.hasPrefix("public.movie") || uti.hasPrefix("public.video")
  }

  // MARK: - MIME / Extension Helpers

  private func mimeTypeFromUTI(_ uti: String) -> String? {
    let map: [String: String] = [
      "public.jpeg": "image/jpeg",
      "public.png": "image/png",
      "public.heic": "image/heic",
      "public.heif": "image/heif",
      "public.tiff": "image/tiff",
      "com.adobe.raw-image": "image/x-adobe-dng",
      "com.apple.quicktime-movie": "video/quicktime",
      "public.mpeg-4": "video/mp4",
    ]
    return map[uti]
  }

  private func fileExtension(for uti: String) -> String {
    let map: [String: String] = [
      "public.jpeg": "jpg",
      "public.png": "png",
      "public.heic": "heic",
      "public.heif": "heif",
      "public.tiff": "tiff",
      "com.adobe.raw-image": "dng",
      "com.apple.quicktime-movie": "mov",
      "public.mpeg-4": "mp4",
    ]
    return map[uti] ?? "bin"
  }
}

// MARK: - PHPhotoLibraryChangeObserver

extension NativeBackupEngine: PHPhotoLibraryChangeObserver {
  func photoLibraryDidChange(_ changeInstance: PHChange) {
    guard let old = currentFetchResult else { return }
    guard let details = changeInstance.changeDetails(for: old) else { return }

    currentFetchResult = details.fetchResultAfterChanges
    let inserted = details.insertedObjects
    if !inserted.isEmpty {
      dbQueue.async { [weak self] in
        self?.insertNewAssets(inserted)
      }
      NSLog("[NativeBackupEngine] Detected \(inserted.count) new assets in photo library")
    }
  }
}

// MARK: - URLSessionDelegate

extension NativeBackupEngine: URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // Handle background upload completion for tasks tracked in uploadTaskMap
    guard let localAssetId = uploadTaskMap[task.taskIdentifier] else { return }
    uploadTaskMap.removeValue(forKey: task.taskIdentifier)

    dbQueue.async { [weak self] in
      guard let self, self.db != nil else { return }
      if let error = error {
        self.markFailed(assetId: localAssetId, error: error.localizedDescription)
      } else {
        let statusCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(statusCode) {
          // Background chunk upload succeeded — handled by the await in uploadChunk
        } else {
          self.markFailed(assetId: localAssetId, error: "HTTP \(statusCode)")
        }
      }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async { [weak self] in
      self?.backgroundSessionCompletionHandler?()
      self?.backgroundSessionCompletionHandler = nil
    }
  }
}
