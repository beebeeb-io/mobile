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

test('Files key follows the Files mount through one locked writer, never failing a store or unlock', () => {
  expect(bridge).toContain('mode: .fileProviderOnly');
  expect(bridge).not.toContain('mode: .extensionOnly');
  // Task 1722 (G6/G7): every vault write path syncs the Files key best-effort, gated on the mount.
  // Review round 2 (item 4): the rule is passed in, so the sync reads it under the Files key lock
  // before AND after its write, not as a value the caller read once before.
  for (const signature of ['static func store(masterKeyBytes:', 'static func load(label:', 'static func setAccessControl(']) {
    const body = functionBody(manager, signature);
    expect(body).toContain('syncFileProviderWrappedKey(');
    expect(body).toContain('allowed: fileProviderKeyAllowed)');
    expect(body).not.toMatch(/try\s+storeFileProviderWrappedKey\(/);
  }
  const allowed = functionBody(manager, 'static func fileProviderKeyAllowed()');
  expect(allowed).toContain('BeebeebKeychainCore.fileProviderMountConsented()');
  expect(allowed).toContain('PlaintextStorageProtection.isPurgePending()');
  const sync = functionBody(manager, 'static func syncFileProviderWrappedKey(');
  expect(sync).toContain('fileProviderKeyLock.lock()');
  expect(sync).toContain('deleteFileProviderKeyLocked()');
  expect(sync).not.toContain('throw');
  // Review round 2 (item 5): one lock for every Files key write and delete; "provisioned" is an
  // unwrap, so the existence-only check is gone.
  expect(functionBody(manager, 'static func deleteFileProviderKey()')).toContain('fileProviderKeyLock.lock()');
  const remove = functionBody(manager, 'private static func deleteFileProviderKeyLocked()');
  expect(remove).toContain('deleteSEKey(tag: BeebeebKeychainCore.seKeyTagFiles)');
  expect(remove).toContain('deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyServiceFiles)');
  expect(remove).not.toContain('seKeyTagExt');
  expect(remove).not.toMatch(/seKeyTag\)/);
  expect(functionBody(manager, 'private static func deleteSEKey()')).toContain('deleteFileProviderKey()');
  expect(functionBody(manager, 'private static func deleteWrappedItems()')).toContain('deleteFileProviderKey()');
  expect(manager).not.toContain('static func hasFileProviderKey(');
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

/** A one-line declaration such as the Files key lock, without `private`; '' when absent. */
function optionalLine(source: string, prefix: string) {
  const found = source.split('\n').find((l) => l.trim().startsWith(prefix));
  return found ? found.trim().replace(/^private /, '') : '';
}

// Task 1722 (G1/G6/G7): the Files key is a no-user-presence copy of the vault key. It may only
// exist while the user has Files mounted, and provisioning it must never fail a vault store or
// unlock (a failure there broke unlock, or pushed store() onto the software-key fallback).
// Review round 2 (items 1, 4, 5): the Face ID toggle follows the same rule; a writer notices a
// consent revoked while it was writing the Files key; every Files key write and delete runs under
// one lock; and "provisioned" means one Files key whose blob the extension's own lookup unwraps to
// the vault key, not "both keychain items exist".
//
// The Security double keeps several keys under one tag (the keychain does: a tag is not unique),
// wraps per key (a blob opens only with the key that wrapped it), returns the FIRST key for a
// lookup, deletes every match, can be "locked", and is thread safe: two writers run at once below.
nativeTest('Files key exists only while Files is mounted, has one writer at a time, and never fails a vault store or unlock', () => {
  const extracted = [
    'static func store(masterKeyBytes:',
    'static func load(label:',
    'static func setAccessControl(',
    'static func delete()',
    'private static func storeExtensionWrappedKey(',
    'private static func storeFileProviderWrappedKey(',
    'private static func getOrCreateSEKey()',
    'private static func getOrCreateExtensionSEKey()',
    'private static func getOrCreateFileProviderSEKey()',
    'private static func generateSEKey(',
    'private static func deleteWrappedItem(',
    'private static func deleteSEKey()',
    'private static func deleteSEKey(tag: Data)',
    'private static func deleteWrappedItems()',
    'private static func deleteWrappedItems(service: String)',
  ].map((s) => functionBody(manager, s));
  // Round 3 added most of these and removed hasFileProviderKey; an absent one compiles to nothing.
  const lifecycle = [
    'enum FileProviderKeyOutcome',
    'enum FileProviderKeyCheck',
    'static func fileProviderKeyAllowed()',
    'static func syncFileProviderWrappedKey(',
    'private static func provisionFileProviderKeyLocked(',
    'private static func checkFileProviderKey(',
    'private static func fileProviderKeyCount()',
    'private static func constantTimeEqual(',
    'static func deleteFileProviderKey()',
    'private static func deleteFileProviderKeyLocked()',
    'static func hasFileProviderKey(label: String)',
  ].map((s) => optionalBody(manager, s));
  const lock = optionalLine(manager, 'private static let fileProviderKeyLock');
  const loader = functionBody(core, 'static func loadMasterKey(\n');
  const filesLoader = functionBody(core, 'static func loadFileProviderMasterKey(');
  const loadError = functionBody(core, 'enum LoadError: Error {');
  const harness = `
import Foundation
typealias CFString = String
typealias CFDictionary = [String: Any]
typealias CFData = Data
typealias CFError = NSError
typealias CFTypeRef = Any
let kCFAllocatorDefault = 0
let kSecAttrAccessibleAfterFirstUnlock = "afterFirstUnlock-migratable"
let kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "afterFirstUnlock"
let kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly = "passcodeSetUnlockedDeviceOnly"
let kSecClass = "class", kSecClassGenericPassword = "password", kSecClassKey = "key", kSecAttrService = "service"
let kSecAttrAccount = "account", kSecAttrAccessible = "accessible", kSecValueData = "data"
let kSecAttrAccessGroup = "group", kSecAttrKeyType = "type", kSecAttrKeyTypeECSECPrimeRandom = "ec"
let kSecAttrKeySizeInBits = "bits", kSecAttrTokenID = "token", kSecAttrTokenIDSecureEnclave = "secureEnclave"
let kSecPrivateKeyAttrs = "private", kSecAttrIsPermanent = "permanent", kSecAttrApplicationTag = "tag", kSecAttrAccessControl = "acl"
let kSecReturnData = "returnData", kSecReturnAttributes = "returnAttributes"
let kSecMatchLimit = "matchLimit", kSecMatchLimitAll = "all", kSecMatchLimitOne = "one"
let errSecSuccess: Int32 = 0
let errSecItemNotFound: Int32 = -25300
let errSecInteractionNotAllowed: Int32 = -25308
struct SecAccessControlCreateFlags: OptionSet {
  let rawValue: Int
  static let privateKeyUsage = Self(rawValue: 1), devicePasscode = Self(rawValue: 2), biometryAny = Self(rawValue: 4)
}
struct ACL { let protection: String; let flags: SecAccessControlCreateFlags }
final class SecKey {
  let tag: Data, acl: ACL, id: UInt8
  init(_ tag: Data, _ acl: ACL, id: UInt8) { self.tag = tag; self.acl = acl; self.id = id }
}
final class LAContext {}

/// The keychain double. Every access takes \`lock\`, because two writers run at once below.
/// Hooks run outside it, on the calling thread.
enum State {
  static let lock = NSLock()
  static var keys: [SecKey] = []
  static var blobs: [String: Data] = [:], accounts: [String: String] = [:]
  static var nextKeyId: UInt8 = 1
  static var mounted = false, purgePending = false, authenticated = false, locked = false
  static var failingTags: Set<Data> = []
  static var filesKeysCreated = 0, filesBlobWrites = 0
  static var beforeFilesKeyCreate: (() -> Void)?, afterFilesBlobWrite: (() -> Void)?
  static func with<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
  static func reset(mount: Bool) {
    with {
      keys = []; blobs = [:]; accounts = [:]; nextKeyId = 1
      mounted = mount; purgePending = false; authenticated = false; locked = false; failingTags = []
      filesKeysCreated = 0; filesBlobWrites = 0; beforeFilesKeyCreate = nil; afterFilesBlobWrite = nil
    }
  }
  /// One-shot hooks: the first caller takes them.
  static func takeBeforeFilesKeyCreate() -> (() -> Void)? { with { () -> (() -> Void)? in defer { beforeFilesKeyCreate = nil }; return beforeFilesKeyCreate } }
  static func takeAfterFilesBlobWrite() -> (() -> Void)? { with { () -> (() -> Void)? in defer { afterFilesBlobWrite = nil }; return afterFilesBlobWrite } }
}
func SecAccessControlCreateWithFlags(_ allocator: Int, _ protection: String, _ flags: SecAccessControlCreateFlags, _ error: Any?) -> ACL? { ACL(protection: protection, flags: flags) }
func SecKeyCreateRandomKey(_ attrs: CFDictionary, _ error: inout Unmanaged<CFError>?) -> SecKey? {
  let p = attrs[kSecPrivateKeyAttrs] as! CFDictionary
  let tag = p[kSecAttrApplicationTag] as! Data
  if tag == BeebeebKeychainCore.seKeyTagFiles { State.takeBeforeFilesKeyCreate()?() }
  return State.with { () -> SecKey? in
    guard !State.failingTags.contains(tag) else { return nil }
    let key = SecKey(tag, p[kSecAttrAccessControl] as! ACL, id: State.nextKeyId)
    State.nextKeyId &+= 1
    State.keys.append(key)
    if tag == BeebeebKeychainCore.seKeyTagFiles { State.filesKeysCreated += 1 }
    return key
  }
}
func SecKeyCopyPublicKey(_ key: SecKey) -> SecKey? { key }
/// ECIES double: the blob names the key that wrapped it, so only that key opens it.
func SecKeyCreateEncryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? {
  Data([99, key.id]) + bytes.map { $0 ^ 0xA5 }
}
func SecKeyCreateDecryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? {
  let refusal = State.with { () -> Int? in
    // A passcode- or Face ID-gated key decrypts only after the app's one explicit evaluation.
    if !key.acl.flags.isDisjoint(with: [.devicePasscode, .biometryAny]), !State.authenticated { return -25293 }
    if State.locked, key.tag == BeebeebKeychainCore.seKeyTagFiles { return Int(errSecInteractionNotAllowed) }
    return nil
  }
  if let refusal { error = Unmanaged.passRetained(NSError(domain: NSOSStatusErrorDomain, code: refusal)); return nil }
  guard bytes.count > 2, bytes.first == 99, bytes.dropFirst().first == key.id else {
    error = Unmanaged.passRetained(NSError(domain: NSOSStatusErrorDomain, code: -26275))
    return nil
  }
  return Data(bytes.dropFirst(2).map { $0 ^ 0xA5 })
}
@discardableResult
func SecItemAdd(_ attrs: CFDictionary, _ result: Any?) -> Int32 {
  let service = attrs[kSecAttrService] as! String
  State.with {
    State.blobs[service] = attrs[kSecValueData] as? Data
    State.accounts[service] = attrs[kSecAttrAccount] as? String
    if service == BeebeebKeychainCore.wrappedKeyServiceFiles { State.filesBlobWrites += 1 }
  }
  if service == BeebeebKeychainCore.wrappedKeyServiceFiles { State.takeAfterFilesBlobWrite()?() }
  return errSecSuccess
}
@discardableResult
func SecItemUpdate(_ query: CFDictionary, _ values: CFDictionary) -> Int32 {
  let service = query[kSecAttrService] as! String
  let found = State.with { () -> Bool in
    guard State.blobs[service] != nil else { return false }
    State.blobs[service] = values[kSecValueData] as? Data
    if service == BeebeebKeychainCore.wrappedKeyServiceFiles { State.filesBlobWrites += 1 }
    return true
  }
  guard found else { return errSecItemNotFound }
  if service == BeebeebKeychainCore.wrappedKeyServiceFiles { State.takeAfterFilesBlobWrite()?() }
  return errSecSuccess
}
@discardableResult
func SecItemDelete(_ query: CFDictionary) -> Int32 {
  State.with {
    // As in the keychain, every match goes: two keys under one tag included.
    if query[kSecClass] as? String == kSecClassKey, let tag = query[kSecAttrApplicationTag] as? Data { State.keys.removeAll { $0.tag == tag } }
    if query[kSecClass] as? String == kSecClassGenericPassword, let service = query[kSecAttrService] as? String {
      State.blobs[service] = nil; State.accounts[service] = nil
    }
  }
  return errSecSuccess
}
func SecItemCopyMatching(_ query: CFDictionary, _ result: inout CFTypeRef?) -> Int32 {
  let (status, value) = State.with { () -> (Int32, CFTypeRef?) in
    if query[kSecClass] as? String == kSecClassKey, let tag = query[kSecAttrApplicationTag] as? Data {
      if State.locked, tag == BeebeebKeychainCore.seKeyTagFiles { return (errSecInteractionNotAllowed, nil) }
      let matches = State.keys.filter { $0.tag == tag }
      if matches.isEmpty { return (errSecItemNotFound, nil) }
      return (errSecSuccess, matches.map { _ in [kSecAttrApplicationTag: tag] as [String: Any] })
    }
    if query[kSecClass] as? String == kSecClassGenericPassword, let service = query[kSecAttrService] as? String,
       let blob = State.blobs[service] {
      return (errSecSuccess, [[kSecValueData: blob, kSecAttrAccount: State.accounts[service] ?? ""]] as [[String: Any]])
    }
    return (errSecItemNotFound, nil)
  }
  result = value
  return status
}
enum KeychainError: Error {
  case seKeyGenerationFailed, seKeyNotFound, encryptionFailed, decryptionFailed, invalidMasterKeySize
  case writeError(Int32), readError(Int32)
  case vaultAuth(BeebeebKeychainCore.AuthFailureReason)
}
enum RuntimeTrace {
  private static let lock = NSLock()
  private static var recorded: [String] = []
  static var events: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
  static func reset() { lock.lock(); recorded = []; lock.unlock() }
  static func event(_ name: String, _ payload: [String: Any] = [:]) { lock.lock(); recorded.append(name); lock.unlock() }
}
enum PlaintextStorageProtection {
  static func isPurgePending() -> Bool { State.with { State.purgePending } }
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
  static func fileProviderMountConsented(defaults: UserDefaults? = nil) -> Bool { State.with { State.mounted } }
  /// The first key under the tag, as a kSecMatchLimitOne lookup returns it.
  static func findSEKey(tag: Data, authContext: AnyObject? = nil) -> SecKey? { State.with { State.keys.first { $0.tag == tag } } }
  static func fetchWrappedBlob(service: String, label: String) -> Data? { State.with { State.blobs[service] } }
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
  static func authenticateForPrimaryLoad(label: String) throws -> LAContext { State.with { State.authenticated = true }; return LAContext() }
  ${lock}
  ${extracted.join('\n')}
  ${lifecycle.join('\n')}
}

var count = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  if !condition() { print("FAIL: \\(label)"); fflush(stdout); exit(1) }
  count += 1
}
let vault = Data(repeating: 42, count: 32)
let otherVault = Data(repeating: 43, count: 32)
let label = "io.beebeeb.master-key"
let filesTag = BeebeebKeychainCore.seKeyTagFiles
let filesService = BeebeebKeychainCore.wrappedKeyServiceFiles
func reset(mounted: Bool) { State.reset(mount: mounted); RuntimeTrace.reset(); Manager.requiresBiometric = false }
func setMounted(_ value: Bool) { State.with { State.mounted = value } }
func filesKeys() -> [SecKey] { State.with { State.keys.filter { $0.tag == filesTag } } }
func hasFilesKey() -> Bool { !filesKeys().isEmpty || State.with { State.blobs[filesService] } != nil }
func filesKeysCreated() -> Int { State.with { State.filesKeysCreated } }
func filesBlobWrites() -> Int { State.with { State.filesBlobWrites } }
func filesLoad() -> Data? { try? BeebeebKeychainCore.loadFileProviderMasterKey(label: label) }
/// What the extension needs: exactly one Files key, and its own lookup + unwrap gives this vault key.
func filesKeyWorks(_ expected: Data = vault) -> Bool { filesKeys().count == 1 && filesLoad() == expected }
func vaultLoad() -> Data? {
  var error: Unmanaged<CFError>?
  let key = BeebeebKeychainCore.loadMasterKey(label: label, mode: .primaryOnly, authContext: nil, decryptError: &error)
  _ = error?.takeRetainedValue()
  return key
}
/// Signed in: vault + share/backup keys stored with Files off, then Files set as given.
func signIn(filesMounted: Bool) {
  reset(mounted: false)
  try! Manager.store(masterKeyBytes: vault, label: label)
  setMounted(filesMounted)
}
/// What phones were left with by two writers that raced before round 3: two keys under the
/// Files tag, the blob wrapped by the second; the extension's lookup returns the first.
func injectRaceLeftovers() {
  State.with {
    let acl = ACL(protection: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags: [.privateKeyUsage])
    let first = SecKey(filesTag, acl, id: 200), second = SecKey(filesTag, acl, id: 201)
    State.keys.removeAll { $0.tag == filesTag }
    State.keys += [first, second]
    State.blobs[filesService] = Data([99, second.id]) + vault.map { $0 ^ 0xA5 }
    State.accounts[filesService] = label
  }
}

// Files off: storing the vault key never creates the Files key, and removes one left behind.
reset(mounted: false)
do { try Manager.store(masterKeyBytes: vault, label: label) } catch { check(false, "store with Files off threw \\(error)") }
check(State.with { State.blobs[BeebeebKeychainCore.wrappedKeyService] } != nil, "Files off: vault key stored")
check(State.with { State.blobs[BeebeebKeychainCore.wrappedKeyServiceExt] } != nil, "Files off: share/backup key stored")
check(!hasFilesKey() && filesKeysCreated() == 0, "Files off: no Files key created")
reset(mounted: true)
try! Manager.store(masterKeyBytes: vault, label: label)
check(filesKeyWorks(), "Files on: store provisions one working Files key")
let filesKey = filesKeys()[0]
check(filesKey.acl.flags == [.privateKeyUsage] && filesKey.acl.protection == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, "Files key policy unchanged: unlocked, passcode-set device, no prompt")
setMounted(false)
try! Manager.store(masterKeyBytes: vault, label: label)
check(!hasFilesKey(), "Files off: a Files key left from an earlier build is removed on store")
check(State.with { State.keys.contains { $0.tag == BeebeebKeychainCore.seKeyTag } && State.keys.contains { $0.tag == BeebeebKeychainCore.seKeyTagExt } }, "removing the Files key leaves the vault and share/backup keys")

// A Files key failure never fails the vault store.
reset(mounted: true)
State.with { State.failingTags = [filesTag] }
var storeError: Error?
do { try Manager.store(masterKeyBytes: vault, label: label) } catch { storeError = error }
check(storeError == nil, "Files key failure: store still succeeds, got \\(String(describing: storeError))")
check(State.with { State.blobs[BeebeebKeychainCore.wrappedKeyService] != nil && State.blobs[BeebeebKeychainCore.wrappedKeyServiceExt] != nil }, "Files key failure: vault + share keys stored")
check(!hasFilesKey(), "Files key failure: no half-written Files key")

// Unlock: same contract.
signIn(filesMounted: true)
check((try? Manager.load(label: label)) == vault, "Files on: unlock returns the vault key")
check(filesKeyWorks(), "Files on: unlock provisions the Files key")
setMounted(false)
State.with { State.authenticated = false }
check((try? Manager.load(label: label)) == vault, "Files off: unlock returns the vault key")
check(!hasFilesKey(), "Files off: unlock removes the Files key")
setMounted(true)
State.with { State.failingTags = [filesTag]; State.authenticated = false }
var loadResult: Data?
var loadError: Error?
do { loadResult = try Manager.load(label: label) } catch { loadError = error }
check(loadError == nil && loadResult == vault, "Files key failure: unlock still returns the vault key, got \\(String(describing: loadError))")
check(!hasFilesKey(), "Files key failure on unlock: no Files key")

// Review round 2, item 1 (mutation A): turning Face ID on re-wraps the vault key under a new key
// (setAccessControl). With Files off that must not create the Files key, not even for a moment.
signIn(filesMounted: false)
State.with { State.authenticated = true }  // the one prompt the old passcode policy asks for
do { try Manager.setAccessControl(requireBiometric: true) } catch { check(false, "Face ID toggle threw \\(error)") }
check(State.with { State.keys.first { $0.tag == BeebeebKeychainCore.seKeyTag }?.acl.flags } == [.privateKeyUsage, .biometryAny], "Face ID toggle: the vault key is now wrapped by a Face ID key")
check(vaultLoad() == vault, "Face ID toggle: the vault key still opens")
check(!hasFilesKey() && filesKeysCreated() == 0 && filesBlobWrites() == 0, "Files off: a Face ID toggle creates no Files key")
signIn(filesMounted: true)
State.with { State.authenticated = true }
_ = try? Manager.load(label: label)
let createdBeforeToggle = filesKeysCreated()
State.with { State.authenticated = true }
try! Manager.setAccessControl(requireBiometric: true)
check(filesKeyWorks() && filesKeysCreated() == createdBeforeToggle, "Files on: a Face ID toggle keeps the one working Files key")
setMounted(false)
State.with { State.authenticated = true }
try! Manager.setAccessControl(requireBiometric: false)
check(!hasFilesKey(), "Files off: a Face ID toggle removes a Files key left behind")

// Review round 2, item 4: Files is turned off while a store, an unlock or a Face ID toggle is
// writing the Files key. The toggle-off clears the consent first and deletes the key after; here
// its consent change lands right after the write, before its delete. The writer must notice and
// undo its own write before it returns. A sign-out purge can also start during a backup task's
// unlock (that load runs off the module queue): its pending marker counts the same way.
signIn(filesMounted: true)
State.with { State.afterFilesBlobWrite = { setMounted(false) } }
try! Manager.store(masterKeyBytes: vault, label: label)
check(filesBlobWrites() == 1, "store: the Files key was written before Files was turned off (the race happened)")
check(!hasFilesKey(), "store: Files turned off during the Files key write: no Files key when store returns")
signIn(filesMounted: false)
setMounted(true)
State.with { State.authenticated = true; State.afterFilesBlobWrite = { setMounted(false) } }
try! Manager.setAccessControl(requireBiometric: true)
check(filesBlobWrites() == 1, "Face ID toggle: the Files key was written before Files was turned off (the race happened)")
check(!hasFilesKey(), "Face ID toggle: Files turned off during the Files key write: no Files key when it returns")
for (name, revoke) in [("Files turned off", { setMounted(false) }), ("a sign-out purge started", { State.with { State.purgePending = true } })] as [(String, () -> Void)] {
  signIn(filesMounted: true)
  State.with { State.afterFilesBlobWrite = revoke }
  check((try? Manager.load(label: label)) == vault, "unlock, \\(name) during the Files key write: the vault key still loads")
  check(!hasFilesKey(), "unlock: \\(name) during the Files key write: no Files key when unlock returns")
}

// Review round 2, item 5: two writers at once (the foreground resume on a Swift Task, a store or
// an unlock on the module queue, a backup's unlock on its own thread) could both miss the Files
// key and each generate one; the blob then ended up wrapped by a key the extension's lookup does
// not return: a permanent -1000. Here a store starts while an unlock is generating the key, and
// gets 1.5 s to finish before the unlock goes on.
signIn(filesMounted: true)
let secondWriter = DispatchGroup()
State.with {
  State.beforeFilesKeyCreate = {
    secondWriter.enter()
    DispatchQueue.global().async {
      try? Manager.store(masterKeyBytes: vault, label: label)
      secondWriter.leave()
    }
    _ = secondWriter.wait(timeout: .now() + 1.5)
  }
}
check((try? Manager.load(label: label)) == vault, "two writers: the unlock returns the vault key")
secondWriter.wait()
let createdByTwoWriters = filesKeysCreated()
check(createdByTwoWriters == 1, "two writers at once create one Files key, created \\(createdByTwoWriters)")
check(filesKeyWorks(), "two writers at once: one Files key whose blob the extension's lookup unwraps, \\(filesKeys().count) key(s)")

// The same lock covers deletes: a toggle-off's delete that arrives during a Files key write waits
// for that write, and removes what it wrote.
signIn(filesMounted: true)
let deleter = DispatchGroup()
var deleteFinishedDuringWrite = true
State.with {
  State.afterFilesBlobWrite = {
    setMounted(false)
    deleter.enter()
    DispatchQueue.global().async { Manager.deleteFileProviderKey(); deleter.leave() }
    deleteFinishedDuringWrite = deleter.wait(timeout: .now() + 0.3) == .success
  }
}
try! Manager.store(masterKeyBytes: vault, label: label)
deleter.wait()
check(!deleteFinishedDuringWrite, "a Files key delete waits for the Files key write in progress (one lock)")
check(!hasFilesKey(), "toggle-off during a store: no Files key afterwards")

// The state that race left on phones: both keychain items exist, so the old "provisioned" check
// said yes, but the blob opens only with the key the lookup does not return. The next unlock
// finds it by unwrapping and starts again from one key.
signIn(filesMounted: true)
injectRaceLeftovers()
check(filesLoad() == nil, "race leftovers: the extension cannot unwrap (the -1000 loop)")
check((try? Manager.load(label: label)) == vault, "race leftovers: unlock returns the vault key")
check(filesKeyWorks(), "race leftovers: the unlock leaves one Files key that unwraps, \\(filesKeys().count) key(s)")

// KeychainManager.delete (sign-out, owner-mismatch purge) removes the Files key with the rest.
reset(mounted: true)
try! Manager.store(masterKeyBytes: vault, label: label)
Manager.delete()
check(State.with { State.keys.isEmpty && State.blobs.isEmpty }, "delete removes every key and blob, the Files key included")

// ---- round 3 API ----
// The call the foreground resume makes, with its own consent rule.
func resumeSync(_ allowed: () -> Bool = { true }) -> Manager.FileProviderKeyOutcome {
  Manager.syncFileProviderWrappedKey(masterKeyBytes: vault, label: label, allowed: allowed)
}
reset(mounted: true)
injectRaceLeftovers()
check(resumeSync() == .ready, "resume: race leftovers repaired")
check(filesKeyWorks(), "resume: one Files key that unwraps after the repair, \\(filesKeys().count) key(s)")
reset(mounted: true)
try! Manager.store(masterKeyBytes: otherVault, label: label)
check(filesLoad() == otherVault, "setup: the Files key holds another vault key")
check(resumeSync() == .ready && filesKeyWorks(), "resume: a Files key that unwraps to another vault key is replaced")
let writesBefore = filesBlobWrites(), createdBefore = filesKeysCreated()
check(resumeSync() == .ready && filesBlobWrites() == writesBefore && filesKeysCreated() == createdBefore, "resume: a working Files key is checked, not rewritten")
let keptKey = filesKeys().map(ObjectIdentifier.init)
State.with { State.locked = true }
check(resumeSync() == .failed, "device locked: the Files key cannot be checked, so it is not reported ready")
check(filesKeys().map(ObjectIdentifier.init) == keptKey && filesKeysCreated() == createdBefore, "device locked: the Files key is left as it is (no delete, no second key)")
State.with { State.locked = false }
check(filesKeyWorks(), "device unlocked again: the same Files key works")
check(resumeSync({ false }) == .notAllowed && !hasFilesKey(), "not allowed before the write: no Files key")
reset(mounted: true)
var allowedReads = 0
check(resumeSync({ allowedReads += 1; return allowedReads == 1 }) == .revoked && allowedReads == 2, "allowed before the write, not after: .revoked")
check(!hasFilesKey() && RuntimeTrace.events.contains("keychain.manager.files_key.provision_undone"), "revoked during the write: undone and traced")
reset(mounted: true)
State.with { State.failingTags = [filesTag] }
check(resumeSync() == .failed && !hasFilesKey(), "Files key cannot be created: .failed, nothing half written")

// Review M2-C, with round 3's meaning of "provisioned": one Files key whose blob unwraps to this
// vault key. "Both keychain items exist" is not enough.
reset(mounted: true)
try! Manager.store(masterKeyBytes: vault, label: label)
check(Manager.checkFileProviderKey(masterKeyBytes: vault, label: label) == .matches, "one Files key + its blob: matches")
check(Manager.checkFileProviderKey(masterKeyBytes: otherVault, label: label) == .mismatch, "a blob for another vault key: mismatch")
let savedBlob = State.with { State.blobs[filesService] }
State.with { State.blobs[filesService] = nil }
check(Manager.checkFileProviderKey(masterKeyBytes: vault, label: label) == .mismatch, "Files key without its wrapped blob: mismatch")
State.with { State.blobs[filesService] = savedBlob; State.keys.removeAll { $0.tag == filesTag } }
check(Manager.checkFileProviderKey(masterKeyBytes: vault, label: label) == .mismatch, "wrapped blob without its Files key: mismatch")
State.with { State.blobs[filesService] = nil }
check(Manager.checkFileProviderKey(masterKeyBytes: vault, label: label) == .mismatch, "neither half: mismatch")
injectRaceLeftovers()
State.with { State.keys.removeLast() }
State.with { State.blobs[filesService] = Data([99, 200]) + vault.map { $0 ^ 0xA5 } }
check(Manager.checkFileProviderKey(masterKeyBytes: vault, label: label) == .matches, "setup: the first race key alone matches")
injectRaceLeftovers()
State.with { State.blobs[filesService] = Data([99, 200]) + vault.map { $0 ^ 0xA5 } }
check(Manager.checkFileProviderKey(masterKeyBytes: vault, label: label) == .mismatch, "two keys under the Files tag: mismatch even when the blob opens")
// ---- end round 3 API ----
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
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-key-lifecycle', binary, output], { timeout: 60_000 });
  } catch {
    // The FAIL line is asserted below.
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  console.log(text);
  expect(text).not.toContain('FAIL:');
  expect(text).toContain('Files key lifecycle: 57 cases passed');
}, 150_000);

// Review round 2, item 2 (mutation B): Settings toggle-off (`clearFileProviderSharedState`) and
// every sign-out purge (`resetFileProviderShowInFilesConsent`) must turn the consent off BEFORE
// they delete the Files key. A vault store or unlock that runs right after the delete reads the
// consent under the Files key lock: if Files still looks mounted then, it writes a new Files key
// and nothing removes it. Deleting first passed the whole suite.
nativeTest('Settings toggle-off and every sign-out purge revoke the Files consent before they delete the Files key', () => {
  const body = (signature: string) => {
    const start = moduleSwift.indexOf(signature);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = moduleSwift.indexOf('{', start + signature.length - 1);
    let depth = 1, end = open + 1;
    for (; depth && end < moduleSwift.length; end++) {
      if (moduleSwift[end] === '{') depth++;
      if (moduleSwift[end] === '}') depth--;
    }
    return moduleSwift.slice(start, end).replace(/^private /, '');
  };
  const clear = body('private func clearFileProviderSharedState(defaults: UserDefaults?) -> Int {');
  const reset = body('private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {');
  const consent = functionBody(core, 'static func fileProviderMountConsented(');
  const harness = `
import Foundation
let fileProviderEnabledKey = "enabled", fileProviderTrustedMountKey = "trusted"
let fileProviderAuthRequiredKey = "authRequired", fileProviderUnlockedUntilKey = "unlockedUntil"
let sharedSessionTokenKey = "token", sharedAPIBaseURLKey = "api", simulatorFileProviderMasterKeyKey = "simulatorKey"
enum BeebeebKeychainCore {
  static let appGroupSuiteName = "unused"
  static let fileProviderEnabledKey = "enabled"
  static let fileProviderTrustedMountKey = "trusted"
  static var deletedStrings: [String] = []
  static func deleteString(key: String) { deletedStrings.append(key) }
  ${consent}
}
var generation = 0, purgeGeneration = 0
@discardableResult func bumpFileProviderGeneration() -> Int { generation += 1; return generation }
@discardableResult func bumpFileProviderPurgeGeneration() -> Int { purgeGeneration += 1; return purgeGeneration }
func clearFileProviderCacheState(defaults: UserDefaults?) -> (removed: Int, cacheResetOk: Bool) { (0, true) }
let suite = "beebeeb.files-revoke-order.test." + UUID().uuidString
let defaults = UserDefaults(suiteName: suite)!
enum KeychainManager {
  /// What a vault store or unlock would read (the Settings consent rule) at the moment the Files
  /// key is deleted.
  static var mountedAtDelete: [Bool] = []
  static func deleteFileProviderKey() {
    mountedAtDelete.append(BeebeebKeychainCore.fileProviderMountConsented(defaults: defaults))
  }
}
${clear}
${reset}
var count = 0
func check(_ condition: Bool, _ label: String) { if !condition { print("FAIL: \\(label)"); exit(1) }; count += 1 }
func mount() { defaults.set(true, forKey: "trusted"); defaults.set(true, forKey: "enabled") }
mount()
_ = clearFileProviderSharedState(defaults: defaults)
check(KeychainManager.mountedAtDelete == [false], "Settings toggle-off: Files is already off when the Files key is deleted, got \\(KeychainManager.mountedAtDelete)")
KeychainManager.mountedAtDelete = []
mount()
resetFileProviderShowInFilesConsent(defaults: defaults)
check(KeychainManager.mountedAtDelete == [false], "sign-out purge: Files is already off when the Files key is deleted, got \\(KeychainManager.mountedAtDelete)")
check(purgeGeneration == 1, "sign-out purge: the purge generation moves")
defaults.removePersistentDomain(forName: suite)
print("Files revoke order: \\(count) cases passed")
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-files-revoke-order-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'runner'), output = join(dir, 'output.log');
  writeFileSync(swift, harness);
  try {
    execFileSync('swiftc', [swift, '-o', binary], { timeout: 120_000, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`revoke-order harness did not compile:\n${String(error?.stderr ?? error)}`);
  }
  try {
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-revoke-order', binary, output], { timeout: 30_000 });
  } catch {
    // asserted below
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  console.log(text);
  expect(text).not.toContain('FAIL:');
  expect(text).toContain('Files revoke order: 3 cases passed');
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
