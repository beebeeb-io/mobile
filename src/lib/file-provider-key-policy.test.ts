// @ts-nocheck — extracted production Swift runs with a deterministic Security test double.
import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = join(import.meta.dir, '../..');
const manager = readFileSync(join(root, 'modules/beebeeb-crypto/ios/KeychainManager.swift'), 'utf8');
const core = readFileSync(join(root, 'modules/beebeeb-crypto/ios/Shared/BeebeebKeychainCore.swift'), 'utf8');
const bridge = readFileSync(join(root, 'targets/file-provider/CryptoBridge.swift'), 'utf8');
function functionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start, end).replaceAll('private static func', 'static func');
}

const moduleSwift = readFileSync(join(root, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'), 'utf8');

test('Files key follows the Files mount through the trusted key lifecycle, never failing a store or unlock', () => {
  expect(bridge).toContain('mode: .fileProviderOnly');
  expect(bridge).not.toContain('mode: .extensionOnly');
  // Task 1722 (G6/G7): every vault write path syncs the Files key best-effort, gated on the mount.
  for (const signature of ['static func store(masterKeyBytes:', 'static func load(label:', 'static func setAccessControl(']) {
    const body = functionBody(manager, signature);
    expect(body).toContain('syncFileProviderWrappedKey(');
    expect(body).toContain('BeebeebKeychainCore.fileProviderMountConsented()');
    expect(body).not.toMatch(/try\s+storeFileProviderWrappedKey\(/);
  }
  const sync = functionBody(manager, 'static func syncFileProviderWrappedKey(');
  expect(sync).toContain('deleteFileProviderKey()');
  expect(sync).not.toContain('throw');
  const remove = functionBody(manager, 'static func deleteFileProviderKey()');
  expect(remove).toContain('deleteSEKey(tag: BeebeebKeychainCore.seKeyTagFiles)');
  expect(remove).toContain('deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyServiceFiles)');
  expect(remove).not.toContain('seKeyTagExt');
  expect(remove).not.toMatch(/seKeyTag\)/);
  expect(functionBody(manager, 'private static func deleteSEKey()')).toContain('BeebeebKeychainCore.seKeyTagFiles');
  expect(functionBody(manager, 'private static func deleteWrappedItems()')).toContain('BeebeebKeychainCore.wrappedKeyServiceFiles');
  // Shared backup/share policy must remain untouched.
  expect(functionBody(manager, 'private static func getOrCreateExtensionSEKey()')).toContain('flags: [.privateKeyUsage, .devicePasscode]');
});

test('turning Files off and every sign-out purge delete the Files key; consent keys are declared once', () => {
  expect(functionBody(moduleSwift, 'private func clearFileProviderSharedState(defaults: UserDefaults?) -> Int {')).toContain('KeychainManager.deleteFileProviderKey()');
  expect(functionBody(moduleSwift, 'private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {')).toContain('KeychainManager.deleteFileProviderKey()');
  expect(moduleSwift).toContain('private let fileProviderEnabledKey = BeebeebKeychainCore.fileProviderEnabledKey');
  expect(moduleSwift).toContain('private let fileProviderTrustedMountKey = BeebeebKeychainCore.fileProviderTrustedMountKey');
  expect(moduleSwift).not.toContain('"io.beebeeb.fileProvider.enabled"');
  expect(moduleSwift).not.toContain('"io.beebeeb.fileProvider.trustedMountEnabled"');
});

const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('actual Files provisioning and loader enforce unlocked device policy without key fallback', () => {
  const writer = [
    'private static func storeFileProviderWrappedKey(',
    'private static func getOrCreateFileProviderSEKey()',
    'private static func generateSEKey(',
  ].map(s => functionBody(manager, s)).join('\n');
  const loader = functionBody(core, 'static func loadMasterKey(\n');
  const throwing = functionBody(core, 'static func loadMasterKeyThrowing(');
  // Task 1722 (G3): the Files loader names the failing step; LoadError is the shipped enum.
  const filesLoader = functionBody(core, 'static func loadFileProviderMasterKey(');
  const loadError = functionBody(core, 'enum LoadError: Error {');
  const harness = `
import Foundation
typealias CFString = String
typealias CFDictionary = [String: Any]
typealias CFData = Data
typealias CFError = NSError
let kCFAllocatorDefault = 0
let kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "afterFirstUnlock"
let kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly = "passcodeSetUnlockedDeviceOnly"
let kSecClass = "class", kSecClassGenericPassword = "password", kSecAttrService = "service"
let kSecAttrAccount = "account", kSecAttrAccessible = "accessible", kSecValueData = "data"
let kSecAttrAccessGroup = "group", kSecAttrKeyType = "type", kSecAttrKeyTypeECSECPrimeRandom = "ec"
let kSecAttrKeySizeInBits = "bits", kSecAttrTokenID = "token", kSecAttrTokenIDSecureEnclave = "secureEnclave"
let kSecPrivateKeyAttrs = "private", kSecAttrIsPermanent = "permanent", kSecAttrApplicationTag = "tag", kSecAttrAccessControl = "acl"
let errSecSuccess: Int32 = 0
let errSecItemNotFound: Int32 = -25300
struct SecAccessControlCreateFlags: OptionSet {
  let rawValue: Int
  static let privateKeyUsage = Self(rawValue: 1), devicePasscode = Self(rawValue: 2), biometryAny = Self(rawValue: 4)
}
struct ACL { let protection: String; let flags: SecAccessControlCreateFlags }
final class SecKey { let tag: Data; let acl: ACL; init(_ tag: Data, _ acl: ACL) { self.tag = tag; self.acl = acl } }
enum State {
  static var keys: [Data: SecKey] = [:], blobs: [String: Data] = [:]
  static var lookups: [Data] = [], generated: [CFDictionary] = [], written: [CFDictionary] = []
  static var unlocked = true, passcode = true, generationFails = false, writeStatus: Int32 = 0, decryptFails = false
}
func SecAccessControlCreateWithFlags(_ allocator: Int, _ protection: String, _ flags: SecAccessControlCreateFlags, _ error: Any?) -> ACL? { ACL(protection: protection, flags: flags) }
func SecKeyCreateRandomKey(_ attrs: CFDictionary, _ error: inout Unmanaged<CFError>?) -> SecKey? {
  State.generated.append(attrs)
  let p = attrs[kSecPrivateKeyAttrs] as! CFDictionary
  let acl = p[kSecAttrAccessControl] as! ACL
  guard !State.generationFails, State.passcode || acl.protection != kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly else { return nil }
  let key = SecKey(p[kSecAttrApplicationTag] as! Data, acl); State.keys[key.tag] = key; return key
}
func SecKeyCopyPublicKey(_ key: SecKey) -> SecKey? { key }
func SecKeyCreateEncryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? { Data([99]) + bytes.map { $0 ^ 0xA5 } }
func SecKeyCreateDecryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? {
  guard State.unlocked, State.passcode, !State.decryptFails, !key.acl.flags.contains(.devicePasscode), bytes.first == 99 else {
    error = Unmanaged.passRetained(NSError(domain: "NSOSStatusErrorDomain", code: State.unlocked ? -26276 : -25308))
    return nil
  }
  return Data(bytes.dropFirst().map { $0 ^ 0xA5 })
}
func SecItemAdd(_ attrs: CFDictionary, _ result: Any?) -> Int32 {
  State.written.append(attrs)
  if State.writeStatus == 0 { State.blobs[attrs[kSecAttrService] as! String] = attrs[kSecValueData] as? Data }
  return State.writeStatus
}
func SecItemUpdate(_ query: CFDictionary, _ values: CFDictionary) -> Int32 {
  let service = query[kSecAttrService] as! String
  if State.writeStatus != 0 { return State.writeStatus }
  guard State.blobs[service] != nil else { return errSecItemNotFound }
  State.written.append(query.merging(values) { _, new in new })
  State.blobs[service] = values[kSecValueData] as? Data
  return 0
}
enum KeychainError: Error { case seKeyNotFound, encryptionFailed, seKeyGenerationFailed, writeError(Int32) }
enum BeebeebKeychainCore {
  enum LoadMode { case primaryOnly, extensionOnly, extensionThenPrimary, fileProviderOnly }
  ${loadError}
  static let accessGroup: String? = "shared"
  static let seKeyTag = Data([1]), seKeyTagExt = Data([2]), seKeyTagFiles = Data([3])
  static let wrappedKeyService = "primary", wrappedKeyServiceExt = "extension", wrappedKeyServiceFiles = "files"
  static let eciesAlgorithm = "ecies"
  static func findSEKey(tag: Data, authContext: AnyObject? = nil) -> SecKey? { State.lookups.append(tag); return State.keys[tag] }
  static func fetchWrappedBlob(service: String, label: String) -> Data? { State.blobs[service] }
  static func findSEKeyReportingStatus(tag: Data, authContext: AnyObject? = nil) -> (key: SecKey?, status: Int32) {
    let key = findSEKey(tag: tag, authContext: authContext)
    return (key, key == nil ? errSecItemNotFound : errSecSuccess)
  }
  static func fetchWrappedBlobReportingStatus(service: String, label: String) -> (blob: Data?, status: Int32) {
    let blob = fetchWrappedBlob(service: service, label: label)
    return (blob, blob == nil ? errSecItemNotFound : errSecSuccess)
  }
  ${loader}
  static func loadMasterKey(label: String, mode: LoadMode) -> Data? {
    var error: Unmanaged<CFError>?
    let result = loadMasterKey(label: label, mode: mode, authContext: nil, decryptError: &error)
    if result == nil { _ = error?.takeRetainedValue() }
    return result
  }
  ${throwing}
  ${filesLoader}
}
func reason(_ body: () throws -> Data) -> String {
  do { _ = try body(); return "loaded" } catch { return "\\(error)" }
}
enum Manager {
  ${writer}
  static func deleteWrappedItem(account: String, service: String) { State.blobs.removeValue(forKey: service) }
}
let bytes = Data(repeating: 42, count: 32)
var count = 0
func check(_ condition: Bool, _ label: String) { precondition(condition, label); count += 1 }
try Manager.storeFileProviderWrappedKey(masterKeyBytes: bytes, label: "vault")
let attrs = State.generated.last!
let p = attrs[kSecPrivateKeyAttrs] as! CFDictionary
let acl = p[kSecAttrAccessControl] as! ACL
check(acl.flags == [.privateKeyUsage], "no passcode-operation authentication")
check(acl.protection == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, "unlocked device with passcode only")
check(attrs[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave, "hardware key")
check((attrs[kSecAttrAccessGroup] as? String ?? p[kSecAttrAccessGroup] as? String) == "shared", "shared access group")
check(State.written.last![kSecAttrAccessible] as? String == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, "wrapped blob same protection")
check(State.blobs["files"] != bytes, "only ciphertext persisted")
check(try BeebeebKeychainCore.loadMasterKeyThrowing(label: "vault", mode: .fileProviderOnly) == bytes, "unlocked Files load")
check(State.lookups.allSatisfy { $0 == BeebeebKeychainCore.seKeyTagFiles }, "no primary or legacy key lookup")
let before = State.generated.count
try Manager.storeFileProviderWrappedKey(masterKeyBytes: bytes, label: "vault")
check(State.generated.count == before, "idempotent Files key reuse")
State.unlocked = false
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "locked device denied")
check(reason { try BeebeebKeychainCore.loadMasterKeyThrowing(label: "vault", mode: .fileProviderOnly) } == #"fileProviderKeyUnavailable(step: "unwrap", domain: "NSOSStatusErrorDomain", code: -25308)"#, "locked device reason names the unwrap status")
State.unlocked = true; State.passcode = false
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "passcode removed denied")
State.passcode = true; State.decryptFails = true
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "unwrap failure denied")
State.decryptFails = false; State.blobs.removeValue(forKey: "files")
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "missing Files blob denied")
check(reason { try BeebeebKeychainCore.loadMasterKeyThrowing(label: "vault", mode: .fileProviderOnly) } == #"fileProviderKeyUnavailable(step: "wrapped_blob_lookup", domain: "OSStatus", code: -25300)"#, "missing blob reason names the lookup")
State.keys.removeValue(forKey: BeebeebKeychainCore.seKeyTagFiles)
State.keys[BeebeebKeychainCore.seKeyTag] = SecKey(Data([1]), ACL(protection: "legacy", flags: [.privateKeyUsage]))
State.keys[BeebeebKeychainCore.seKeyTagExt] = SecKey(Data([2]), ACL(protection: "legacy", flags: [.privateKeyUsage]))
State.blobs["primary"] = Data([99]) + bytes.map { $0 ^ 0xA5 }; State.blobs["extension"] = State.blobs["primary"]
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "legacy primary/extension never fallback")
check(reason { try BeebeebKeychainCore.loadMasterKeyThrowing(label: "vault", mode: .fileProviderOnly) } == #"fileProviderKeyUnavailable(step: "se_key_lookup", domain: "OSStatus", code: -25300)"#, "missing Files key reason names the key lookup")
State.passcode = false
do { try Manager.storeFileProviderWrappedKey(masterKeyBytes: bytes, label: "vault"); fatalError("no passcode accepted") } catch {}
check(State.blobs["files"] == nil, "no blob created without passcode")
State.passcode = true; State.generationFails = true
do { try Manager.storeFileProviderWrappedKey(masterKeyBytes: bytes, label: "vault"); fatalError("generation failure accepted") } catch {}
check(State.blobs["files"] == nil, "generation failure fails closed")
State.generationFails = false; State.writeStatus = -1
do { try Manager.storeFileProviderWrappedKey(masterKeyBytes: bytes, label: "vault"); fatalError("write failure accepted") } catch {}
check(State.blobs["files"] == nil, "write failure propagated")
State.writeStatus = 0
try Manager.storeFileProviderWrappedKey(masterKeyBytes: bytes, label: "vault")
let priorBlob = State.blobs["files"]
State.writeStatus = -1
do { try Manager.storeFileProviderWrappedKey(masterKeyBytes: Data(repeating: 43, count: 32), label: "vault"); fatalError("update failure accepted") } catch {}
check(State.blobs["files"] == priorBlob, "failed rewrap preserves existing ciphertext")
print("Files key policy: \\(count) cases passed")
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-files-key-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'runner'), output = join(dir, 'output.log');
  writeFileSync(swift, harness);
  execFileSync('swiftc', [swift, '-o', binary], { timeout: 60_000 });
  execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-key-test', binary, output], { timeout: 30_000 });
  expect(readFileSync(output, 'utf8')).toContain('Files key policy: 21 cases passed');
}, 90_000);

/** Like functionBody, but '' when the signature is not in the source (so one harness compiles before and after a change). */
function optionalBody(source: string, signature: string) {
  return source.includes(signature) ? functionBody(source, signature) : '';
}

// Task 1722 (G1/G6/G7): the Files key is a no-user-presence copy of the vault key. It may only
// exist while the user has Files mounted, and provisioning it must never fail a vault store or
// unlock (a failure there broke unlock, or pushed store() onto the software-key fallback).
nativeTest('Files key exists only while Files is mounted, and never fails a vault store or unlock', () => {
  const extracted = [
    'static func store(masterKeyBytes:',
    'static func load(label:',
    'private static func storeExtensionWrappedKey(',
    'private static func storeFileProviderWrappedKey(',
    'private static func getOrCreateSEKey()',
    'private static func getOrCreateExtensionSEKey()',
    'private static func getOrCreateFileProviderSEKey()',
    'private static func generateSEKey(',
  ].map((s) => functionBody(manager, s));
  const lifecycle = [
    'static func syncFileProviderWrappedKey(',
    'static func deleteFileProviderKey()',
    'private static func deleteSEKey(tag: Data)',
    'private static func deleteWrappedItems(service: String)',
  ].map((s) => optionalBody(manager, s));
  const loader = functionBody(core, 'static func loadMasterKey(\n');
  const filesLoader = functionBody(core, 'static func loadFileProviderMasterKey(');
  const loadError = functionBody(core, 'enum LoadError: Error {');
  const harness = `
import Foundation
typealias CFString = String
typealias CFDictionary = [String: Any]
typealias CFData = Data
typealias CFError = NSError
let kCFAllocatorDefault = 0
let kSecAttrAccessibleAfterFirstUnlock = "afterFirstUnlock-migratable"
let kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "afterFirstUnlock"
let kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly = "passcodeSetUnlockedDeviceOnly"
let kSecClass = "class", kSecClassGenericPassword = "password", kSecClassKey = "key", kSecAttrService = "service"
let kSecAttrAccount = "account", kSecAttrAccessible = "accessible", kSecValueData = "data"
let kSecAttrAccessGroup = "group", kSecAttrKeyType = "type", kSecAttrKeyTypeECSECPrimeRandom = "ec"
let kSecAttrKeySizeInBits = "bits", kSecAttrTokenID = "token", kSecAttrTokenIDSecureEnclave = "secureEnclave"
let kSecPrivateKeyAttrs = "private", kSecAttrIsPermanent = "permanent", kSecAttrApplicationTag = "tag", kSecAttrAccessControl = "acl"
let errSecSuccess: Int32 = 0
let errSecItemNotFound: Int32 = -25300
struct SecAccessControlCreateFlags: OptionSet {
  let rawValue: Int
  static let privateKeyUsage = Self(rawValue: 1), devicePasscode = Self(rawValue: 2), biometryAny = Self(rawValue: 4)
}
struct ACL { let protection: String; let flags: SecAccessControlCreateFlags }
final class SecKey { let tag: Data; let acl: ACL; init(_ tag: Data, _ acl: ACL) { self.tag = tag; self.acl = acl } }
final class LAContext {}
enum State {
  static var keys: [Data: SecKey] = [:], blobs: [String: Data] = [:]
  static var mounted = false, authenticated = false, failingTags: Set<Data> = []
}
enum RuntimeTrace {
  static var events: [String] = []
  static func event(_ name: String, _ payload: [String: Any] = [:]) { events.append(name) }
}
func SecAccessControlCreateWithFlags(_ allocator: Int, _ protection: String, _ flags: SecAccessControlCreateFlags, _ error: Any?) -> ACL? { ACL(protection: protection, flags: flags) }
func SecKeyCreateRandomKey(_ attrs: CFDictionary, _ error: inout Unmanaged<CFError>?) -> SecKey? {
  let p = attrs[kSecPrivateKeyAttrs] as! CFDictionary
  let tag = p[kSecAttrApplicationTag] as! Data
  guard !State.failingTags.contains(tag) else { return nil }
  let key = SecKey(tag, p[kSecAttrAccessControl] as! ACL); State.keys[tag] = key; return key
}
func SecKeyCopyPublicKey(_ key: SecKey) -> SecKey? { key }
func SecKeyCreateEncryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? { Data([99]) + bytes.map { $0 ^ 0xA5 } }
func SecKeyCreateDecryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? {
  // A passcode-gated key decrypts only after the app's one explicit evaluation.
  guard !key.acl.flags.contains(.devicePasscode) || State.authenticated, bytes.first == 99 else { return nil }
  return Data(bytes.dropFirst().map { $0 ^ 0xA5 })
}
func SecItemAdd(_ attrs: CFDictionary, _ result: Any?) -> Int32 { State.blobs[attrs[kSecAttrService] as! String] = attrs[kSecValueData] as? Data; return 0 }
func SecItemUpdate(_ query: CFDictionary, _ values: CFDictionary) -> Int32 {
  let service = query[kSecAttrService] as! String
  guard State.blobs[service] != nil else { return errSecItemNotFound }
  State.blobs[service] = values[kSecValueData] as? Data
  return 0
}
func SecItemDelete(_ query: CFDictionary) -> Int32 {
  if query[kSecClass] as? String == kSecClassKey, let tag = query[kSecAttrApplicationTag] as? Data { State.keys[tag] = nil }
  if query[kSecClass] as? String == kSecClassGenericPassword, let service = query[kSecAttrService] as? String { State.blobs[service] = nil }
  return 0
}
enum KeychainError: Error {
  case seKeyGenerationFailed, seKeyNotFound, encryptionFailed, decryptionFailed, invalidMasterKeySize
  case writeError(Int32), readError(Int32)
  case vaultAuth(BeebeebKeychainCore.AuthFailureReason)
}
enum BeebeebKeychainCore {
  enum AuthFailureReason: String { case notWarm, notAvailable, userCanceled, authFailed, biometryLockout }
  static func classifyDecryptError(_ error: Unmanaged<CFError>?) -> AuthFailureReason { _ = error?.takeRetainedValue(); return .notWarm }
  enum LoadMode { case primaryOnly, extensionOnly, extensionThenPrimary, fileProviderOnly }
  ${loadError}
  static let accessGroup: String? = "shared"
  static let seKeyTag = Data([1]), seKeyTagExt = Data([2]), seKeyTagFiles = Data([3])
  static let wrappedKeyService = "primary", wrappedKeyServiceExt = "extension", wrappedKeyServiceFiles = "files"
  static let eciesAlgorithm = "ecies"
  static func fileProviderMountConsented(defaults: UserDefaults? = nil) -> Bool { State.mounted }
  static func findSEKey(tag: Data, authContext: AnyObject? = nil) -> SecKey? { State.keys[tag] }
  static func fetchWrappedBlob(service: String, label: String) -> Data? { State.blobs[service] }
  static func findSEKeyReportingStatus(tag: Data, authContext: AnyObject? = nil) -> (key: SecKey?, status: Int32) {
    let key = findSEKey(tag: tag); return (key, key == nil ? errSecItemNotFound : errSecSuccess)
  }
  static func fetchWrappedBlobReportingStatus(service: String, label: String) -> (blob: Data?, status: Int32) {
    let blob = fetchWrappedBlob(service: service, label: label); return (blob, blob == nil ? errSecItemNotFound : errSecSuccess)
  }
  ${loader}
  ${filesLoader}
}
enum Manager {
  static var requiresBiometric = false
  static func authenticateForPrimaryLoad(label: String) throws -> LAContext { State.authenticated = true; return LAContext() }
  static func deleteWrappedItem(account: String, service: String = BeebeebKeychainCore.wrappedKeyService) { State.blobs[service] = nil }
  ${extracted.join('\n')}
  ${lifecycle.join('\n')}
}

var count = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  if !condition() { print("FAIL: \\(label)"); exit(1) }
  count += 1
}
let vault = Data(repeating: 42, count: 32)
let label = "io.beebeeb.master-key"
func reset(mounted: Bool) {
  State.keys = [:]; State.blobs = [:]; State.mounted = mounted; State.authenticated = false; State.failingTags = []
  RuntimeTrace.events = []
}
var hasFilesKey: Bool { State.keys[BeebeebKeychainCore.seKeyTagFiles] != nil || State.blobs[BeebeebKeychainCore.wrappedKeyServiceFiles] != nil }
func filesLoad() -> Data? { try? BeebeebKeychainCore.loadFileProviderMasterKey(label: label) }

// Files off: storing the vault key never creates the Files key, and removes one left behind.
reset(mounted: false)
do { try Manager.store(masterKeyBytes: vault, label: label) } catch { check(false, "store with Files off threw \\(error)") }
check(State.blobs[BeebeebKeychainCore.wrappedKeyService] != nil, "Files off: vault key stored")
check(State.blobs[BeebeebKeychainCore.wrappedKeyServiceExt] != nil, "Files off: share/backup key stored")
check(!hasFilesKey, "Files off: no Files key created")
reset(mounted: true)
try! Manager.store(masterKeyBytes: vault, label: label)
check(filesLoad() == vault, "Files on: store provisions a working Files key")
let filesKey = State.keys[BeebeebKeychainCore.seKeyTagFiles]!
check(filesKey.acl.flags == [.privateKeyUsage] && filesKey.acl.protection == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, "Files key policy unchanged: unlocked, passcode-set device, no prompt")
State.mounted = false
try! Manager.store(masterKeyBytes: vault, label: label)
check(!hasFilesKey, "Files off: a Files key left from an earlier build is removed on store")
check(State.keys[BeebeebKeychainCore.seKeyTag] != nil && State.keys[BeebeebKeychainCore.seKeyTagExt] != nil, "removing the Files key leaves the vault and share/backup keys")

// A Files key failure never fails the vault store.
reset(mounted: true)
State.failingTags = [BeebeebKeychainCore.seKeyTagFiles]
var storeError: Error?
do { try Manager.store(masterKeyBytes: vault, label: label) } catch { storeError = error }
check(storeError == nil, "Files key failure: store still succeeds, got \\(String(describing: storeError))")
check(State.blobs[BeebeebKeychainCore.wrappedKeyService] != nil && State.blobs[BeebeebKeychainCore.wrappedKeyServiceExt] != nil, "Files key failure: vault + share keys stored")
check(!hasFilesKey, "Files key failure: no half-written Files key")

// Unlock: same contract.
reset(mounted: false)
try! Manager.store(masterKeyBytes: vault, label: label)
State.mounted = true
State.keys[BeebeebKeychainCore.seKeyTagFiles] = nil; State.blobs[BeebeebKeychainCore.wrappedKeyServiceFiles] = nil
State.authenticated = false
check((try? Manager.load(label: label)) == vault, "Files on: unlock returns the vault key")
check(filesLoad() == vault, "Files on: unlock provisions the Files key")
State.mounted = false
State.authenticated = false
check((try? Manager.load(label: label)) == vault, "Files off: unlock returns the vault key")
check(!hasFilesKey, "Files off: unlock removes the Files key")
State.mounted = true
State.failingTags = [BeebeebKeychainCore.seKeyTagFiles]
State.authenticated = false
var loadResult: Data?
var loadError: Error?
do { loadResult = try Manager.load(label: label) } catch { loadError = error }
check(loadError == nil && loadResult == vault, "Files key failure: unlock still returns the vault key, got \\(String(describing: loadError))")
check(!hasFilesKey, "Files key failure on unlock: no Files key")
print("Files key lifecycle: \\(count) cases passed")
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-files-key-lifecycle-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'runner'), output = join(dir, 'output.log');
  writeFileSync(swift, harness);
  try {
    execFileSync('swiftc', [swift, '-o', binary], { timeout: 120_000, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`lifecycle harness did not compile:\n${String(error?.stderr ?? error)}`);
  }
  try {
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-key-lifecycle', binary, output], { timeout: 30_000 });
  } catch {
    // The FAIL line is asserted below.
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  console.log(text);
  expect(text).not.toContain('FAIL:');
  expect(text).toContain('Files key lifecycle: 16 cases passed');
}, 150_000);

nativeTest('fileProviderMountConsented is the Settings rule: trusted mount on, enabled on or absent', () => {
  const consent = functionBody(core, 'static func fileProviderMountConsented(');
  const harness = `
import Foundation
enum BeebeebKeychainCore {
  static let appGroupSuiteName = "unused"
  static let fileProviderEnabledKey = "enabled"
  static let fileProviderTrustedMountKey = "trusted"
  ${consent}
}
let suite = "beebeeb.files-consent.test." + UUID().uuidString
let defaults = UserDefaults(suiteName: suite)!
defer { defaults.removePersistentDomain(forName: suite) }
var count = 0
func check(_ condition: Bool, _ label: String) { if !condition { print("FAIL: \\(label)"); exit(1) }; count += 1 }
check(!BeebeebKeychainCore.fileProviderMountConsented(defaults: nil), "no defaults: not mounted")
check(!BeebeebKeychainCore.fileProviderMountConsented(defaults: defaults), "nothing set: not mounted")
defaults.set(true, forKey: "trusted")
check(BeebeebKeychainCore.fileProviderMountConsented(defaults: defaults), "trusted on, enabled absent: mounted")
defaults.set(false, forKey: "enabled")
check(!BeebeebKeychainCore.fileProviderMountConsented(defaults: defaults), "enabled off: not mounted")
defaults.set(true, forKey: "enabled")
check(BeebeebKeychainCore.fileProviderMountConsented(defaults: defaults), "both on: mounted")
defaults.set(false, forKey: "trusted")
check(!BeebeebKeychainCore.fileProviderMountConsented(defaults: defaults), "trusted off: not mounted")
print("Files consent: \\(count) cases passed")
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-files-consent-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'runner'), output = join(dir, 'output.log');
  writeFileSync(swift, harness);
  execFileSync('swiftc', [swift, '-o', binary], { timeout: 120_000, stdio: 'pipe' });
  try {
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-consent', binary, output], { timeout: 30_000 });
  } catch {
    // asserted below
  }
  const text = readFileSync(output, 'utf8');
  expect(text).not.toContain('FAIL:');
  expect(text).toContain('Files consent: 6 cases passed');
}, 150_000);
