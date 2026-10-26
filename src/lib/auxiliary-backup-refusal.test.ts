// @ts-nocheck -- compile the real uploader with a URLProtocol and crypto/engine stubs.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const nativeTest = process.platform === 'darwin' ? test : test.skip;
const ios = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');

nativeTest('legacy backup uploader forwards a typed refusal and stops subsequent requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-aux-refusal-'));
  const engine = readFileSync(join(ios, 'NativeBackupEngine.swift'), 'utf8');
  const methods = engine.slice(engine.indexOf('  func recordAuxiliaryAccountRefusal('), engine.indexOf('  // MARK: - Lifecycle', engine.indexOf('  func recordAuxiliaryAccountRefusal(')));
  writeFileSync(join(dir, 'main.swift'), String.raw`
import Foundation
final class MasterKeyHandle { func encryptName(fileId: String, filename: String, mimeType: String) throws -> String { "encrypted" } }
enum BeebeebCryptoBridge { static func cachedMasterKeyIfAvailable() -> MasterKeyHandle? { MasterKeyHandle() } }
enum RuntimeTrace { static func event(_ name: String, _ fields: [String: Any] = [:]) {} }
enum ProvenanceHeaders { static func apply(to request: inout URLRequest) {} }
func isMedia(mimeType: String) -> Bool { false }
final class ChunkEncryptorHandle {
  struct Plan { let chunkSizeBytes = 10; let chunkCount = 1 }
  struct Chunk { let data = Data([1]); let index = 0 }
  static func forPush(masterKey: MasterKeyHandle, fileId: String, fileSize: UInt64, profile: String) throws -> ChunkEncryptorHandle { Self() }
  func chunkPlan() throws -> Plan { Plan() }
  func pushChunk(plaintext: Data) throws -> Chunk { Chunk() }
  func finish() throws -> Bool { true }
}
final class NativeBackupEngine {
  static let shared = NativeBackupEngine()
  var currentAccountId: String? = "account"
  var accountRefusalStopReason: String?
  var accountUploadRefused: Bool { accountRefusalStopReason != nil }
  var calls = 0
  func handleConfirmedAccountRefusal(code: String) { accountRefusalStopReason = code; calls += 1 }
  func handleConfirmedTrialCapExceeded(message: String) { accountRefusalStopReason = message; calls += 1 }
${methods}
}
final class StubProtocol: URLProtocol {
  static var requests = 0
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests += 1
    client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client!.urlProtocol(self, didLoad: Data(#"{"error":"account_lapsed"}"#.utf8))
    client!.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
let config = URLSessionConfiguration.ephemeral
config.protocolClasses = [StubProtocol.self]
let uploader = NativeEncryptedBackupUploader(session: URLSession(configuration: config))
for _ in 0..<2 {
  let done = DispatchSemaphore(value: 0)
  uploader.upload(plaintext: Data([1]), fileName: "contacts.vcf", mimeType: "text/vcard", parentFolderId: "folder", authToken: "fixture", serverBaseURL: "https://local.test", accountId: "account") { result in
    if case .success = result { fatalError("refusal succeeded") }
    done.signal()
  }
  guard done.wait(timeout: .now() + 3) == .success else { fatalError("upload never completed") }
}
guard NativeBackupEngine.shared.calls == 1, StubProtocol.requests == 1 else { fatalError("refusal not surfaced or retried") }
let engine = NativeBackupEngine.shared
engine.clearAuxiliaryAccountRefusal(accountId: "account")
guard !engine.accountUploadRefused else { fatalError("resume did not clear refusal") }
engine.recordAuxiliaryAccountRefusal(statusCode: 413, body: Data(#"{"error":"quota_exceeded","is_trial_cap":true,"limit_bytes":10000000000}"#.utf8), accountId: "account")
guard engine.accountRefusalStopReason == "This account is on the 10 GB trial storage cap. Free up space to keep uploading." else { fatalError("lost trial cap reason") }
engine.clearAuxiliaryAccountRefusal(accountId: "other")
guard engine.accountUploadRefused else { fatalError("other owner cleared refusal") }
engine.clearAuxiliaryAccountRefusal(accountId: "account")
engine.recordAuxiliaryAccountRefusal(statusCode: 413, body: Data(#"{"error":"quota_exceeded","is_trial_cap":false}"#.utf8), accountId: "account")
guard !engine.accountUploadRefused else { fatalError("ordinary quota treated as trial cap") }
engine.recordAuxiliaryAccountRefusal(statusCode: 409, body: Data(#"{"error":"account_lapsed"}"#.utf8), accountId: "other")
guard !engine.accountUploadRefused else { fatalError("stale owner paused new account") }
print("auxiliary refusal: 8 assertions passed, 0 failed")
`);
  execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), join(ios, 'NativeEncryptedBackupUploader.swift'), join(ios, 'AccountRefusalDetection.swift'), join(dir, 'main.swift'), '-o', join(dir, 'aux')], {timeout: 60000});
  expect(execFileSync(join(dir, 'aux'), [], {encoding:'utf8', timeout:10000})).toContain('auxiliary refusal: 8 assertions passed, 0 failed');
}, 90000);

test('contacts and calendar gate export and manual retry uses the shared refusal state', () => {
  for (const file of ['ContactsBackupManager.swift', 'CalendarBackupManager.swift']) {
    const source = readFileSync(join(ios, file), 'utf8');
    const body = source.slice(source.indexOf('  func backup()'), source.indexOf('  func status()'));
    expect(body).toContain('guard !NativeBackupEngine.shared.accountUploadRefused');
    expect(source).toContain('clearAuxiliaryAccountRefusal(accountId: userId)');
  }
});
