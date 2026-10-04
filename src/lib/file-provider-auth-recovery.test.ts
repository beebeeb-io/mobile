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
enum BeebeebCryptoBridge {
  struct Snapshot { var handle: Int?; var ownerId: String? }
  static var snapshot = Snapshot(handle: 1, ownerId: "A")
  static func cachedMasterKeySnapshot() -> Snapshot { snapshot }
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
      BeebeebCryptoBridge.snapshot = .init(handle: 1, ownerId: "A")
      NSFileProviderManager.available = true; NSFileProviderManager.fail = false
      NSFileProviderManager.calls = []; RuntimeTrace.events = []
    }
    func run(_ label: String, _ change: () -> Void, expected: Int = 0) async {
      reset(); change()
      await resumeFileProviderAuthenticationIfReady(domain: domain, defaults: defaults)
      precondition(NSFileProviderManager.calls.count == expected, label)
      if expected > 0 { precondition(NSFileProviderManager.calls == [NSFileProviderError.notAuthenticated.rawValue], label) }
      count += 1
    }
    await run("authenticated unlock", {}, expected: 1)
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
    await run("retry callback failure", { NSFileProviderManager.fail = true }, expected: 1)
    precondition(RuntimeTrace.events == ["fileprovider.authentication_retry.failed"])
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
  expect(readFileSync(output, 'utf8')).toContain('PASS native authentication recovery cases=14');
}, 65_000);
