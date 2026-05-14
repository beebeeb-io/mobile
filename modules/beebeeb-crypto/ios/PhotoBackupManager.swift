import Foundation
import Photos
import SQLite3
#if os(iOS)
import BackgroundTasks
#endif

// PHImageRequestOptions.version = .original ensures full-res originals, not iCloud previews.

final class PhotoBackupManager: NSObject {
  static let shared = PhotoBackupManager()

  private static let bgTaskIdentifier = "io.beebeeb.app.photo-backup"
  static let bgSessionIdentifier = "io.beebeeb.app.bgUpload"

  private var db: OpaquePointer?
  private let dbQueue = DispatchQueue(label: "io.beebeeb.backupdb", qos: .background)
  private var currentFetchResult: PHFetchResult<PHAsset>?
  private(set) var backgroundSession: URLSession?
  var backgroundSessionCompletionHandlers: [String: () -> Void] = [:]

  private var serverBaseURL: String {
    UserDefaults.standard.string(forKey: "io.beebeeb.serverURL") ?? "http://localhost:3001"
  }

  // Auth token passed from JS when enabling backup, persisted for background relaunches.
  var storedAuthToken: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.backupToken") }
    set { UserDefaults.standard.set(newValue, forKey: "io.beebeeb.backupToken") }
  }

  var parentFolderId: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.photoBackupParentFolderId") }
    set {
      if let newValue, !newValue.isEmpty {
        UserDefaults.standard.set(newValue, forKey: "io.beebeeb.photoBackupParentFolderId")
      } else {
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.photoBackupParentFolderId")
      }
    }
  }

  private override init() {
    super.init()
    dbQueue.sync { self.openDatabase(); self.createTables() }
    setupBackgroundSession()
  }

  // MARK: - Background URLSession (must be created early so iOS can deliver events)

  func setupBackgroundSession() {
    guard backgroundSession == nil else { return }
    let config = URLSessionConfiguration.background(withIdentifier: Self.bgSessionIdentifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    backgroundSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  func handleBackgroundSessionEvents(identifier: String, completionHandler: @escaping () -> Void) {
    backgroundSessionCompletionHandlers[identifier] = completionHandler
  }

  // MARK: - Enable / Disable

  func enable(authToken: String) {
    storedAuthToken = authToken
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
      guard let self, status == .authorized || status == .limited else { return }
      let options = PHFetchOptions()
      options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
      let result = PHAsset.fetchAssets(with: .image, options: options)
      self.currentFetchResult = result
      var assets: [PHAsset] = []
      result.enumerateObjects { asset, _, _ in assets.append(asset) }
      self.dbQueue.async { self.insertPending(assets: assets) }
      PHPhotoLibrary.shared().register(self)
      self.scheduleNextBackup()
    }
  }

  func disable() {
    storedAuthToken = nil
    PHPhotoLibrary.shared().unregisterChangeObserver(self)
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.bgTaskIdentifier)
  }

  func configure(parentFolderId: String?) {
    self.parentFolderId = parentFolderId
  }

  // MARK: - BGProcessingTask

  func registerBackgroundTask() {
    #if os(iOS)
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: Self.bgTaskIdentifier,
      using: nil
    ) { [weak self] task in
      guard let processingTask = task as? BGProcessingTask else { return }
      self?.handleBackgroundTask(processingTask)
    }
    #endif
  }

  func scheduleNextBackup() {
    #if os(iOS)
    let request = BGProcessingTaskRequest(identifier: Self.bgTaskIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = true
    try? BGTaskScheduler.shared.submit(request)
    #endif
  }

  #if os(iOS)
  func handleBackgroundTask(_ task: BGProcessingTask) {
    scheduleNextBackup()
    task.expirationHandler = { [weak self] in self?.cancelCurrentBatch() }
    processBatch(limit: 50) { success in
      task.setTaskCompleted(success: success)
    }
  }
  #endif

  func triggerImmediateBatch(completion: @escaping (Bool) -> Void) {
    processBatch(limit: 50, completion: completion)
  }

  func cancelCurrentBatch() {
    dbQueue.async {
      guard let db = self.db else { return }
      sqlite3_exec(db,
        "UPDATE backup_queue SET status = 'pending' WHERE status IN ('uploading', 'encrypting')",
        nil, nil, nil)
    }
  }

  // MARK: - Progress

  func getProgress() -> (total: Int, completed: Int, inProgress: Int, lastBackupAt: String?) {
    var total = 0, completed = 0, inProgress = 0
    var lastAt: String?
    dbQueue.sync {
      guard let db = self.db else { return }
      total = self.countWhere(db: db, condition: "1=1")
      completed = self.countWhere(db: db, condition: "status = 'done'")
      inProgress = self.countWhere(db: db, condition: "status IN ('uploading', 'encrypting')")
      lastAt = self.getState(db: db, key: "last_backup_at")
    }
    return (total, completed, inProgress, lastAt)
  }

  // MARK: - Database helpers

  private func dbPath() -> String {
    let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
    let dir = lib.appendingPathComponent("Application Support/Beebeeb", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("backup.db").path
  }

  private func openDatabase() {
    if sqlite3_open(dbPath(), &db) != SQLITE_OK { db = nil }
  }

  private func createTables() {
    guard let db else { return }
    let sql = """
    CREATE TABLE IF NOT EXISTS backup_queue (
      local_identifier TEXT PRIMARY KEY,
      media_type TEXT,
      status TEXT DEFAULT 'pending',
      file_id TEXT,
      error TEXT,
      created_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS backup_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    """
    sqlite3_exec(db, sql, nil, nil, nil)
  }

  private func insertPending(assets: [PHAsset]) {
    guard let db else { return }
    let now = ISO8601DateFormatter().string(from: Date())
    let sql = "INSERT OR IGNORE INTO backup_queue (local_identifier, media_type, status, created_at) VALUES (?, 'photo', 'pending', ?)"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    for asset in assets {
      sqlite3_bind_text(stmt, 1, (asset.localIdentifier as NSString).utf8String, -1, nil)
      sqlite3_bind_text(stmt, 2, (now as NSString).utf8String, -1, nil)
      sqlite3_step(stmt)
      sqlite3_reset(stmt)
    }
  }

  private func fetchPending(limit: Int) -> [(identifier: String, mediaType: String)] {
    guard let db else { return [] }
    var results: [(String, String)] = []
    let sql = "SELECT local_identifier, media_type FROM backup_queue WHERE status = 'pending' LIMIT ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int(stmt, 1, Int32(limit))
    while sqlite3_step(stmt) == SQLITE_ROW {
      let id = String(cString: sqlite3_column_text(stmt, 0))
      let mt = String(cString: sqlite3_column_text(stmt, 1))
      results.append((id, mt))
    }
    return results
  }

  private func updateStatus(db: OpaquePointer, localIdentifier: String, status: String, fileId: String? = nil, error: String? = nil) {
    let completedAt: String? = status == "done" ? ISO8601DateFormatter().string(from: Date()) : nil
    let sql = "UPDATE backup_queue SET status=?, file_id=?, error=?, completed_at=? WHERE local_identifier=?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (status as NSString).utf8String, -1, nil)
    bindOptional(stmt, 2, fileId)
    bindOptional(stmt, 3, error)
    bindOptional(stmt, 4, completedAt)
    sqlite3_bind_text(stmt, 5, (localIdentifier as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func bindOptional(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String?) {
    if let v = value {
      sqlite3_bind_text(stmt, idx, (v as NSString).utf8String, -1, nil)
    } else {
      sqlite3_bind_null(stmt, idx)
    }
  }

  private func countWhere(db: OpaquePointer, condition: String) -> Int {
    var stmt: OpaquePointer?
    let sql = "SELECT COUNT(*) FROM backup_queue WHERE \(condition)"
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { sqlite3_finalize(stmt) }
    return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
  }

  func setState(key: String, value: String) {
    dbQueue.async {
      guard let db = self.db else { return }
      let sql = "INSERT OR REPLACE INTO backup_state (key, value) VALUES (?, ?)"
      var stmt: OpaquePointer?
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      defer { sqlite3_finalize(stmt) }
      sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
      sqlite3_bind_text(stmt, 2, (value as NSString).utf8String, -1, nil)
      sqlite3_step(stmt)
    }
  }

  private func getState(db: OpaquePointer, key: String) -> String? {
    var stmt: OpaquePointer?
    let sql = "SELECT value FROM backup_state WHERE key = ?"
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return String(cString: sqlite3_column_text(stmt, 0))
  }

  // MARK: - Batch processing

  private func processBatch(limit: Int, completion: @escaping (Bool) -> Void) {
    guard let token = storedAuthToken, !token.isEmpty else {
      completion(false)
      return
    }
    let pending = dbQueue.sync { fetchPending(limit: limit) }
    guard !pending.isEmpty else { completion(true); return }

    let identifiers = pending.map(\.identifier)
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
    let group = DispatchGroup()
    var allSucceeded = true

    fetchResult.enumerateObjects { [weak self] asset, _, _ in
      guard let self else { return }
      group.enter()
      dbQueue.async {
        guard let db = self.db else { group.leave(); return }
        self.updateStatus(db: db, localIdentifier: asset.localIdentifier, status: "encrypting")
      }
      self.processAsset(asset, token: token) { success in
        if !success { allSucceeded = false }
        group.leave()
      }
    }

    group.notify(queue: .global(qos: .background)) {
      completion(allSucceeded)
    }
  }

  private func processAsset(_ asset: PHAsset, token: String, completion: @escaping (Bool) -> Void) {
    let options = PHImageRequestOptions()
    options.version = .original
    options.isNetworkAccessAllowed = true
    options.deliveryMode = .highQualityFormat

    PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { [weak self] data, uti, _, _ in
      guard let self else { completion(false); return }
      guard let data else {
        dbQueue.async {
          guard let db = self.db else { return }
          self.updateStatus(db: db, localIdentifier: asset.localIdentifier, status: "failed", error: "No image data")
        }
        completion(false)
        return
      }

      let fallbackExt = self.fileExtension(for: uti ?? "public.jpeg")
      let fileName = "\(UUID().uuidString).\(fallbackExt)"
      let mimeType = guessMimeType(filename: fileName) ?? self.mimeType(for: uti ?? "public.jpeg")

      self.uploadFile(
        localIdentifier: asset.localIdentifier,
        data: data,
        fileName: fileName,
        mimeType: mimeType,
        token: token,
        completion: completion
      )
    }
  }

  private func uploadFile(localIdentifier: String, data: Data, fileName: String, mimeType: String, token: String, completion: @escaping (Bool) -> Void) {
    dbQueue.async {
      guard let db = self.db else { return }
      self.updateStatus(db: db, localIdentifier: localIdentifier, status: "uploading")
    }

    NativeEncryptedBackupUploader.shared.upload(
      plaintext: data,
      fileName: fileName,
      mimeType: mimeType,
      parentFolderId: parentFolderId,
      authToken: token,
      serverBaseURL: serverBaseURL
    ) { [weak self] result in
      guard let self else { completion(false); return }
      self.dbQueue.async {
        guard let db = self.db else { return }
        switch result {
        case .success(let fileId):
          self.updateStatus(db: db, localIdentifier: localIdentifier, status: "done", fileId: fileId)
          self.setState(key: "last_backup_at", value: ISO8601DateFormatter().string(from: Date()))
          completion(true)
        case .failure(let error):
          self.updateStatus(db: db, localIdentifier: localIdentifier, status: "failed", error: error.localizedDescription)
          completion(false)
        }
      }
    }
  }

  // MARK: - MIME / extension helpers

  private func mimeType(for uti: String) -> String {
    let map: [String: String] = [
      "public.jpeg": "image/jpeg",
      "public.png": "image/png",
      "public.heic": "image/heic",
      "public.heif": "image/heif",
      "public.tiff": "image/tiff",
      "com.apple.quicktime-movie": "video/quicktime",
      "public.mpeg-4": "video/mp4",
    ]
    return map[uti] ?? "application/octet-stream"
  }

  private func fileExtension(for uti: String) -> String {
    let map: [String: String] = [
      "public.jpeg": "jpg",
      "public.png": "png",
      "public.heic": "heic",
      "public.heif": "heif",
      "public.tiff": "tiff",
      "com.apple.quicktime-movie": "mov",
      "public.mpeg-4": "mp4",
    ]
    return map[uti] ?? "bin"
  }
}

// MARK: - PHPhotoLibraryChangeObserver

extension PhotoBackupManager: PHPhotoLibraryChangeObserver {
  func photoLibraryDidChange(_ changeInstance: PHChange) {
    guard let old = currentFetchResult else { return }
    if let details = changeInstance.changeDetails(for: old) {
      currentFetchResult = details.fetchResultAfterChanges
      let inserted = details.insertedObjects
      if !inserted.isEmpty {
        dbQueue.async { self.insertPending(assets: inserted) }
      }
    }
  }
}

// MARK: - URLSessionDelegate

extension PhotoBackupManager: URLSessionDelegate, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let identifier = task.taskDescription ?? ""
    dbQueue.async {
      guard let db = self.db else { return }
      if let error {
        self.updateStatus(db: db, localIdentifier: identifier, status: "failed", error: error.localizedDescription)
      } else {
        let statusCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if statusCode == 200 || statusCode == 201 {
          self.updateStatus(db: db, localIdentifier: identifier, status: "done")
          self.setState(key: "last_backup_at", value: ISO8601DateFormatter().string(from: Date()))
        } else {
          self.updateStatus(db: db, localIdentifier: identifier, status: "failed", error: "HTTP \(statusCode)")
        }
      }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async { [weak self] in
      guard let id = session.configuration.identifier else { return }
      self?.backgroundSessionCompletionHandlers[id]?()
      self?.backgroundSessionCompletionHandlers.removeValue(forKey: id)
    }
  }
}

// MARK: - Data helpers

private extension String {
  var utf8Data: Data { data(using: .utf8) ?? Data() }
}

private extension Data {
  static func += (lhs: inout Data, rhs: Data) { lhs.append(rhs) }
}
