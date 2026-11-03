// @ts-nocheck -- compile the shipped Swift API against URLProtocol, no app/device.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('File Provider follows all folder cursors and refuses partial or repeated pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-files-paging-'));
  try {
  writeFileSync(join(dir, 'Driver.swift'), String.raw`
import Foundation

enum BeebeebConstants {
  static let userDefaultsApiBaseUrlKey = "url", userDefaultsSessionTokenKey = "token"
  static let defaultApiBaseUrl = "https://local.test"
}
enum BeebeebKeychainCore { static func loadString(key: String) -> String? { key == "token" ? "fixture" : nil } }
enum ProvenanceHeaders { static func apply(to request: inout URLRequest) {} }
enum AccountMismatchDetection { static func isAccountMismatch(_ data: Data) -> Bool { false } }
final class StubProtocol: URLProtocol {
  static var requests: [URLRequest] = []
  static var mode = "normal"
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.append(request)
    let special: (Int, [String: Any])? = {
      switch Self.mode {
      case "init-busy": return (409, ["error": "upload is already in progress for this file"])
      case "chunk-gone", "complete-gone", "folder-parent-gone": return (404, ["error": "not found"])
      case "patch-parent-trash": return (409, ["error": "parent_trashed"])
      case "patch-moved": return (409, ["error": "item_moved"])
      case "unprocessable": return (422, ["error": "invalid business state"])
      default: return nil
      }
    }()
    if let special {
      let data = try! JSONSerialization.data(withJSONObject: special.1)
      client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: special.0, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
      client!.urlProtocol(self, didLoad: data)
      client!.urlProtocolDidFinishLoading(self)
      return
    }
    let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
    let cursor = query.first(where: { $0.name == "cursor" })?.value
    let start = Int(cursor ?? "0") ?? 0
    let end = min(start + 200, 1000)
    let entries = (start..<end).map { i in
      ["id": "f\(i)", "parent_id": "folder", "size_bytes": 1, "is_folder": false, "chunk_count": 1] as [String: Any]
    }
    let next: Any = Self.mode == "repeat" ? "200" : (end < 1000 ? String(end) as Any : NSNull())
    let status = Self.mode == "fail" && start == 200 ? 503 : 200
    let data = try! JSONSerialization.data(withJSONObject: ["files": entries, "next_cursor": next])
    client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client!.urlProtocol(self, didLoad: data)
    client!.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main struct Driver {
  static func main() async {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    let api = ApiClient(session: URLSession(configuration: config))
    do {
      let rows = try await api.listFiles(parentId: "folder", expectedUser: "user-1")
      guard rows.count == 1000, Set(rows.map(\.id)).count == 1000 else { fatalError("expected all 1000 children, got \(rows.count)") }
      guard StubProtocol.requests.count == 5 else { fatalError("expected 5 cursor pages") }
      for request in StubProtocol.requests {
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        guard query.contains(URLQueryItem(name: "parent_id", value: "folder")) else { fatalError("lost parent") }
        guard request.value(forHTTPHeaderField: "X-Beebeeb-Expected-User") == "user-1" else { fatalError("lost expected user") }
      }
      StubProtocol.requests = []
      let capped = try await api.listFiles(parentId: nil, trashed: true, maxEntries: 350)
      guard capped.count == 350, Set(capped.map(\.id)).count == 350 else { fatalError("expected exactly 350 capped rows, got \(capped.count)") }
      guard StubProtocol.requests.count == 2 else { fatalError("capped listing fetched \(StubProtocol.requests.count) pages") }
      for request in StubProtocol.requests {
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        guard query.contains(URLQueryItem(name: "trashed", value: "true")) else { fatalError("lost trashed flag") }
      }
      StubProtocol.mode = "fail"
      do { _ = try await api.listFiles(parentId: nil); fatalError("partial listing accepted") } catch {}
      StubProtocol.mode = "repeat"
      do { _ = try await api.listFiles(parentId: nil); fatalError("repeated cursor accepted") } catch {}
      StubProtocol.mode = "init-busy"
      do {
        _ = try await api.initUploadV2(fileId: UUID().uuidString, nameEncrypted: "name", fileSizeBytes: 1, mimeType: nil,
          parentId: nil, isMedia: false, chunkSizeBytes: 1, chunkCount: 1, isReplacement: false, expectedUser: "user-1")
        fatalError("busy upload lease accepted")
      } catch ApiError.retryableConflict {}
      catch { fatalError("busy upload lease misclassified: \(error)") }
      StubProtocol.mode = "chunk-gone"
      do { try await api.uploadChunkV2(uploadSessionId: "s", index: 0, encryptedChunk: Data([1]), expectedUser: nil, timeout: 1); fatalError("gone chunk session accepted") }
      catch ApiError.uploadSessionUnavailable {} catch { fatalError("gone chunk misclassified: \(error)") }
      StubProtocol.mode = "complete-gone"
      do { _ = try await api.completeUploadV2(uploadSessionId: "s", expectedUser: nil); fatalError("gone complete session accepted") }
      catch ApiError.uploadSessionUnavailable {} catch { fatalError("gone completion misclassified: \(error)") }
      // Abandon is keyed by file id, carries the same account guard as init,
      // and treats 404 as already cleaned up by expiry.
      try await api.abandonUploadForRestart(fileId: "old-file", expectedUser: "user-1")
      guard StubProtocol.requests.last?.url?.path == "/api/v1/files/old-file/upload/abandon" else {
        fatalError("restart used the wrong abandon endpoint")
      }
      guard StubProtocol.requests.last?.value(forHTTPHeaderField: "X-Beebeeb-Expected-User") == "user-1" else {
        fatalError("abandon lost expected user")
      }
      StubProtocol.mode = "folder-parent-gone"
      do {
        _ = try await api.initUploadV2(fileId: UUID().uuidString, nameEncrypted: "name", fileSizeBytes: 1, mimeType: nil,
          parentId: "parent", isMedia: false, chunkSizeBytes: 1, chunkCount: 1, isReplacement: true, expectedUser: nil)
        fatalError("replacement upload 404 accepted")
      } catch ApiError.uploadSessionUnavailable {}
      catch { fatalError("replacement upload 404 misclassified: \(error)") }
      do {
        _ = try await api.initUploadV2(fileId: UUID().uuidString, nameEncrypted: "name", fileSizeBytes: 1, mimeType: nil,
          parentId: "parent", isMedia: false, chunkSizeBytes: 1, chunkCount: 1, isReplacement: false, expectedUser: nil)
        fatalError("new upload missing parent accepted")
      } catch ApiError.parentUnavailable(let id) where id == "parent" {}
      catch { fatalError("new upload parent misclassified: \(error)") }
      do { _ = try await api.createFolder(folderId: UUID().uuidString, nameEncrypted: "name", parentId: "parent", expectedUser: nil); fatalError("missing folder parent accepted") }
      catch ApiError.parentUnavailable(let id) where id == "parent" {} catch { fatalError("missing folder parent misclassified: \(error)") }
      StubProtocol.mode = "patch-parent-trash"
      do { _ = try await api.patchFile(fileId: "file", parentId: "parent", expectedUser: nil); fatalError("trashed move parent accepted") }
      catch ApiError.parentUnavailable(let id) where id == "parent" {} catch { fatalError("trashed move parent misclassified: \(error)") }
      StubProtocol.mode = "patch-moved"
      do { _ = try await api.patchFile(fileId: "file", parentId: "parent", expectedUser: nil); fatalError("racing move accepted") }
      catch ApiError.retryableConflict {} catch { fatalError("racing move misclassified: \(error)") }
      StubProtocol.mode = "unprocessable"
      do { _ = try await api.createFolder(folderId: UUID().uuidString, nameEncrypted: "name", parentId: nil, expectedUser: nil); fatalError("422 accepted") }
      catch ApiError.statusCode(422) {} catch { fatalError("422 misclassified: \(error)") }
      print("paging: 10 assertions passed, 0 failed")
    } catch { fatalError("unexpected error: \(error)") }
  }
}
`);
  execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), join(import.meta.dir, '../../targets/file-provider/ApiClient.swift'), join(dir, 'Driver.swift'), '-o', join(dir, 'paging')], { timeout: 60000 });
  const output = execFileSync(join(dir, 'paging'), [], { encoding: 'utf8', timeout: 15000 });
  expect(output).toContain('paging: 10 assertions passed, 0 failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90000);
