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
  // Task 1722 review M1: the resume re-checks consent with the same pure rule the domain add uses.
  const undoStart = source.indexOf('private func shouldUndoFileProviderAdd(');
  expect(undoStart).toBeGreaterThanOrEqual(0);
  const undoOpen = source.indexOf('{', source.indexOf(') -> Bool', undoStart));
  let undoDepth = 1, undoEnd = undoOpen + 1;
  for (; undoDepth && undoEnd < source.length; undoEnd++) {
    if (source[undoEnd] === '{') undoDepth++;
    if (source[undoEnd] === '}') undoDepth--;
  }
  const undoRule = source.slice(undoStart, undoEnd);
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
var purgeGeneration = 0
func currentFileProviderPurgeGeneration() -> Int { purgeGeneration }
${undoRule}
final class FakeHandle {
  var exports = 0
  // Task 1722 review M1: runs between the resume's checks and its Files key write.
  static var onExport: (() -> Void)?
  // Task 1722 review M2-D: for every exported key buffer, whether all its bytes were zero when it was freed.
  static var zeroedAtRelease: [Bool] = []
  func exportForKeychain() throws -> Data {
    exports += 1
    Self.onExport?()
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: 32, alignment: 1)
    buffer.initializeMemory(as: UInt8.self, repeating: 9, count: 32)
    return Data(bytesNoCopy: buffer, count: 32, deallocator: .custom { pointer, count in
      let bytes = pointer.assumingMemoryBound(to: UInt8.self)
      FakeHandle.zeroedAtRelease.append((0..<count).allSatisfy { bytes[$0] == 0 })
      pointer.deallocate()
    })
  }
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
  static var deletes = 0
  static func deleteFileProviderKey() { deletes += 1; present = false }
}
enum RuntimeTrace {
  static var events: [String] = []
  static func event(_ value: String, _ fields: [String: Any] = [:]) { events.append(value) }
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
      KeychainManager.present = false; KeychainManager.provisioned = []; KeychainManager.deletes = 0
      NSFileProviderManager.available = true; NSFileProviderManager.fail = false
      NSFileProviderManager.calls = []; RuntimeTrace.events = []
      purgeGeneration = 0; FakeHandle.onExport = nil; FakeHandle.zeroedAtRelease = []
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

    // Task 1722 review M2-D: the exported vault key is zeroed before its buffer is released.
    await run("provisioning zeroes the exported key", {}, ready: true, provisions: true)
    precondition(FakeHandle.zeroedAtRelease == [true], "exported key bytes not zeroed before release: \\(FakeHandle.zeroedAtRelease)")

    // Task 1722 review M1: a sign-out purge or a Settings toggle-off can land between the checks
    // above and the Files key write (this runs on a Swift Task with no ordering against the purge
    // queue). The key written after consent was revoked must be deleted again, and nothing resolved.
    func race(_ label: String, _ revoke: @escaping () -> Void) async {
      reset()
      FakeHandle.onExport = revoke
      await resumeFileProviderAuthenticationIfReady(domain: domain, defaults: defaults)
      precondition(KeychainManager.provisioned.count == 1, "\\(label): expected the racing write, got \\(KeychainManager.provisioned.count)")
      precondition(!KeychainManager.present, "\\(label): a no-prompt Files key outlived the consent that allowed it")
      precondition(NSFileProviderManager.calls.isEmpty, "\\(label): signalled \\(NSFileProviderManager.calls) after consent was revoked")
      precondition(RuntimeTrace.events.contains("fileprovider.files_key.provision_undone"), "\\(label): undo not traced: \\(RuntimeTrace.events)")
      precondition(FakeHandle.zeroedAtRelease == [true], "\\(label): exported key bytes not zeroed")
      count += 1
    }
    // resetFileProviderShowInFilesConsent: flags off, key deleted, purge generation bumped.
    await race("sign-out purge between check and write", {
      defaults.set(false, forKey: "enabled"); defaults.set(false, forKey: "trusted")
      KeychainManager.deleteFileProviderKey(); purgeGeneration += 1
    })
    // clearFileProviderSharedState (Settings toggle-off): flags off, key deleted, no generation bump.
    await race("Settings toggle-off between check and write", {
      defaults.set(false, forKey: "enabled"); defaults.set(false, forKey: "trusted")
      KeychainManager.deleteFileProviderKey()
    })
    // A purge that ran and a mount that turned Files back on, both inside the window: the purge
    // generation moved, so this write is undone; the new mount provisions its own key.
    await race("purge and re-mount between check and write", {
      KeychainManager.deleteFileProviderKey(); purgeGeneration += 1
    })
    // A purge still in progress (marker set) also undoes the write.
    await race("purge pending between check and write", { PlaintextStorageProtection.pending = true })
    FileHandle.standardOutput.write(Data("PASS native authentication recovery cases=\\(count)\\n".utf8))
  }
}
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-auth-recovery-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'harness');
  writeFileSync(swift, harness);
  execFileSync('swiftc', ['-parse-as-library', swift, '-o', binary], { timeout: 60_000 });
  const output = join(dir, 'result.log');
  try {
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'harness', binary, output], { timeout: 30_000 });
  } catch {
    // A failed precondition exits non-zero; its message is in the output, asserted below.
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  if (!text.includes('PASS')) console.log(text);
  expect(text).toContain('PASS native authentication recovery cases=20');
}, 65_000);
