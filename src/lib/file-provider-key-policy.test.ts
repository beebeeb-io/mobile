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

test('Files key is provisioned and deleted through existing trusted key lifecycle', () => {
  expect(bridge).toContain('mode: .fileProviderOnly');
  expect(bridge).not.toContain('mode: .extensionOnly');
  for (const signature of ['static func store(masterKeyBytes:', 'static func load(label:', 'static func setAccessControl(']) {
    expect(functionBody(manager, signature)).toContain('storeFileProviderWrappedKey(');
  }
  expect(functionBody(manager, 'private static func deleteSEKey()')).toContain('BeebeebKeychainCore.seKeyTagFiles');
  expect(functionBody(manager, 'private static func deleteWrappedItems()')).toContain('BeebeebKeychainCore.wrappedKeyServiceFiles');
  // Shared backup/share policy must remain untouched.
  expect(functionBody(manager, 'private static func getOrCreateExtensionSEKey()')).toContain('flags: [.privateKeyUsage, .devicePasscode]');
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
  guard State.unlocked, State.passcode, !State.decryptFails, !key.acl.flags.contains(.devicePasscode), bytes.first == 99 else { return nil }
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
  enum LoadError: Error { case seKeyNotFound, notFound }
  static let accessGroup: String? = "shared"
  static let seKeyTag = Data([1]), seKeyTagExt = Data([2]), seKeyTagFiles = Data([3])
  static let wrappedKeyService = "primary", wrappedKeyServiceExt = "extension", wrappedKeyServiceFiles = "files"
  static let eciesAlgorithm = "ecies"
  static func findSEKey(tag: Data, authContext: AnyObject? = nil) -> SecKey? { State.lookups.append(tag); return State.keys[tag] }
  static func fetchWrappedBlob(service: String, label: String) -> Data? { State.blobs[service] }
  ${loader}
  static func loadMasterKey(label: String, mode: LoadMode) -> Data? {
    var error: Unmanaged<CFError>?
    let result = loadMasterKey(label: label, mode: mode, authContext: nil, decryptError: &error)
    if result == nil { _ = error?.takeRetainedValue() }
    return result
  }
  ${throwing}
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
State.unlocked = true; State.passcode = false
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "passcode removed denied")
State.passcode = true; State.decryptFails = true
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "unwrap failure denied")
State.decryptFails = false; State.blobs.removeValue(forKey: "files")
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "missing Files blob denied")
State.keys.removeValue(forKey: BeebeebKeychainCore.seKeyTagFiles)
State.keys[BeebeebKeychainCore.seKeyTag] = SecKey(Data([1]), ACL(protection: "legacy", flags: [.privateKeyUsage]))
State.keys[BeebeebKeychainCore.seKeyTagExt] = SecKey(Data([2]), ACL(protection: "legacy", flags: [.privateKeyUsage]))
State.blobs["primary"] = Data([99]) + bytes.map { $0 ^ 0xA5 }; State.blobs["extension"] = State.blobs["primary"]
check(BeebeebKeychainCore.loadMasterKey(label: "vault", mode: .fileProviderOnly) == nil, "legacy primary/extension never fallback")
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
  expect(readFileSync(output, 'utf8')).toContain('Files key policy: 18 cases passed');
}, 90_000);
