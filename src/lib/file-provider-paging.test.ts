// @ts-nocheck -- compile the shipped Swift API against URLProtocol, no app/device.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('File Provider follows all folder cursors and refuses partial or repeated pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-files-paging-'));
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
      let rows = try await api.listFiles(parentId: "folder")
      guard rows.count == 1000, Set(rows.map(\.id)).count == 1000 else { fatalError("expected all 1000 children, got \(rows.count)") }
      guard StubProtocol.requests.count == 5 else { fatalError("expected 5 cursor pages") }
      for request in StubProtocol.requests {
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        guard query.contains(URLQueryItem(name: "parent_id", value: "folder")) else { fatalError("lost parent") }
      }
      StubProtocol.mode = "fail"
      do { _ = try await api.listFiles(parentId: nil); fatalError("partial listing accepted") } catch {}
      StubProtocol.mode = "repeat"
      do { _ = try await api.listFiles(parentId: nil); fatalError("repeated cursor accepted") } catch {}
      print("paging: 5 assertions passed, 0 failed")
    } catch { fatalError("unexpected error: \(error)") }
  }
}
`);
  execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), join(import.meta.dir, '../../targets/file-provider/ApiClient.swift'), join(dir, 'Driver.swift'), '-o', join(dir, 'paging')], { timeout: 60000 });
  const output = execFileSync(join(dir, 'paging'), [], { encoding: 'utf8', timeout: 15000 });
  expect(output).toContain('paging: 5 assertions passed, 0 failed');
}, 90000);
