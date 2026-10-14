// @ts-nocheck — native Swift contract is exercised on macOS.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const source = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'), 'utf8');
test('trusted registration resumes Files authentication throttling before enumerator signals', () => {
  const start = source.indexOf('private func registerMountedFileProviderDomainLocked(');
  const end = source.indexOf('private func removeMountedFileProviderDomain(', start);
  const registration = source.slice(start, end);
  expect(registration).toContain('await resumeFileProviderAuthenticationIfReady(domain: domain, defaults: defaults)');
  expect(registration.indexOf('await resumeFileProviderAuthenticationIfReady')).toBeLessThan(registration.indexOf('let rootError = await signalFileProviderEnumerator'));
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('actual native authentication recovery only resumes verified unlocked accounts', () => {
  const start = source.indexOf('private func resumeFileProviderAuthenticationIfReady(');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  const helper = source.slice(start, end);
  const harness = `
import Foundation
import FileProvider
let fileProviderTrustedMountKey = "trusted"
let fileProviderEnabledKey = "enabled"
func sharedBoolDefaultTrue(_ defaults: UserDefaults?, key: String) -> Bool {
  defaults?.object(forKey: key) == nil ? true : defaults!.bool(forKey: key)
}
enum PlaintextStorageProtection {
  static var pending = false
  static func isPurgePending() -> Bool { pending }
}
enum BeebeebKeychainCore {
  static let sessionTokenKey = "token", masterKeyOwnerKey = "owner", sessionUserIdKey = "user"
  static var strings: [String: String] = [:]
  static func loadString(key: String) -> String? { strings[key] }
}
final class FakeHandle {
  var exports = 0
  func exportForKeychain() throws -> Data { exports += 1; return Data(repeating: 9, count: 32) }
}
enum BeebeebCryptoBridge {
  static let kMasterKeyLabel = "io.beebeeb.master-key"
  struct Snapshot { var handle: FakeHandle?; var ownerId: String? }
  static var snapshot = Snapshot(handle: FakeHandle(), ownerId: "A")
  static func cachedMasterKeySnapshot() -> Snapshot { snapshot }
}
// Task 1722 (G1): the Files key is provisioned from the verified unlocked handle when missing.
enum KeychainManager {
  static var present = false
  static var provisioned: [(bytes: Int, label: String, mounted: Bool)] = []
  static func hasFileProviderKey(label: String) -> Bool { present }
  @discardableResult
  static func syncFileProviderWrappedKey(masterKeyBytes: Data, label: String, mounted: Bool) -> Bool {
    provisioned.append((masterKeyBytes.count, label, mounted)); present = mounted; return mounted
  }
}
enum RuntimeTrace {
  static var events: [String] = []
  static func event(_ value: String) { events.append(value) }
}
final class NSFileProviderManager {
  static var available = true, fail = false
  static var calls: [Int] = []
  init?(for domain: NSFileProviderDomain) { if !Self.available { return nil } }
  func signalErrorResolved(_ error: Error) async throws {
    Self.calls.append((error as NSError).code)
    if Self.fail { throw NSFileProviderError(.serverUnreachable) }
  }
}
${helper}
@main struct Runner {
  static func main() async {
    let suite = "beebeeb.auth-recovery.test." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("test"), displayName: "Test")
    var count = 0
    func reset() {
      defaults.set(true, forKey: "trusted"); defaults.set(true, forKey: "enabled")
      PlaintextStorageProtection.pending = false
      BeebeebKeychainCore.strings = ["token": "token", "owner": "A", "user": "A"]
      BeebeebCryptoBridge.snapshot = .init(handle: FakeHandle(), ownerId: "A")
      KeychainManager.present = false; KeychainManager.provisioned = []
      NSFileProviderManager.available = true; NSFileProviderManager.fail = false
      NSFileProviderManager.calls = []; RuntimeTrace.events = []
    }
    // Ready: provision the Files key if it is missing, then lift BOTH throttles Files may hold:
    // -1000 (key/session unavailable) and -2005 (what builds before task 1722 reported for a
    // key failure, which Files never retries on its own).
    let resolved = [NSFileProviderError.notAuthenticated.rawValue, NSFileProviderError.cannotSynchronize.rawValue]
    func run(_ label: String, _ change: () -> Void, ready: Bool = false, provisions: Bool = false) async {
      reset(); change()
      await resumeFileProviderAuthenticationIfReady(domain: domain, defaults: defaults)
      precondition(NSFileProviderManager.calls == (ready ? resolved : []), "\\(label): signalled \\(NSFileProviderManager.calls)")
      precondition(KeychainManager.provisioned.count == (provisions ? 1 : 0), "\\(label): provisioned \\(KeychainManager.provisioned.count)x")
      if provisions {
        let call = KeychainManager.provisioned[0]
        precondition(call.bytes == 32 && call.label == "io.beebeeb.master-key" && call.mounted, "\\(label): provisioned \\(call)")
      }
      count += 1
    }
    await run("authenticated unlock, Files key missing", {}, ready: true, provisions: true)
    await run("authenticated unlock, Files key present", { KeychainManager.present = true }, ready: true)
    await run("locked vault", { BeebeebCryptoBridge.snapshot.handle = nil })
    await run("unconfirmed handle", { BeebeebCryptoBridge.snapshot.ownerId = nil })
    await run("foreign handle", { BeebeebCryptoBridge.snapshot.ownerId = "B" })
    await run("missing token", { BeebeebKeychainCore.strings.removeValue(forKey: "token") })
    await run("empty token", { BeebeebKeychainCore.strings["token"] = "" })
    await run("missing owner", { BeebeebKeychainCore.strings.removeValue(forKey: "owner") })
    await run("missing user", { BeebeebKeychainCore.strings.removeValue(forKey: "user") })
    await run("account mismatch", { BeebeebKeychainCore.strings["user"] = "B" })
    await run("purge pending", { PlaintextStorageProtection.pending = true })
    await run("mount not trusted", { defaults.set(false, forKey: "trusted") })
    await run("mount disabled", { defaults.set(false, forKey: "enabled") })
    await run("manager unavailable", { NSFileProviderManager.available = false })
    await run("retry callback failure", { NSFileProviderManager.fail = true }, ready: true, provisions: true)
    precondition(RuntimeTrace.events == ["fileprovider.authentication_retry.failed", "fileprovider.authentication_retry.failed"], "\\(RuntimeTrace.events)")
    FileHandle.standardOutput.write(Data("PASS native authentication recovery cases=\\(count)\\n".utf8))
  }
}
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-auth-recovery-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'harness');
  writeFileSync(swift, harness);
  execFileSync('swiftc', ['-parse-as-library', swift, '-o', binary], { timeout: 60_000 });
  const output = join(dir, 'result.log');
  execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'harness', binary, output], { timeout: 30_000 });
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  if (!text.includes('PASS')) console.log(text);
  expect(text).toContain('PASS native authentication recovery cases=15');
}, 65_000);
