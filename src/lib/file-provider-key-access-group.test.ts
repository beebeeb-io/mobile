// @ts-nocheck — bun runs this; compiles the shipped keychain Swift against a group-aware keychain double (macOS).
/**
 * Task 1722 round 4 — Guus, 2026-10-15, decision Q3: "Yes, own keychain group (Recommended)".
 *
 * The no-prompt Files key (a Secure Enclave key, privateKeyUsage + WhenPasscodeSetThisDeviceOnly,
 * that unwraps the vault key) and its wrapped blob live in a keychain access group of their own,
 * entitled only to the app and the File Provider extension. The Share extension and the widget do
 * not get that group, so they cannot find or use the key. Round-3 builds wrote the key (tag
 * `io.beebeeb.sekey.files.v1`) into the shared group, which the Share extension also has: the app
 * deletes those items on upgrade and provisions a new key (`...files.v2`) in the Files group. No
 * plaintext fallback, and the extension never uses the vault or the share/backup key.
 *
 * Two parts:
 *  - entitlements: app.json, the config plugins (what a clean `expo prebuild` writes) and the
 *    committed ios/ files must agree, per target;
 *  - a native harness (macOS): the REAL KeychainManager writer/delete and BeebeebKeychainCore
 *    loader against a keychain double that enforces access groups per process (an explicit group
 *    the process lacks is errSecMissingEntitlement; a query without a group searches every group
 *    the process has; an add without a group lands in the first one).
 *
 * What the double cannot show: the real Secure Enclave, real entitlement checks by securityd.
 * The simulator rung (keychain-2-debug.db, column agrp) covers the second.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const REQUIRE_NATIVE_SWIFT_HARNESSES = process.env.BB_REQUIRE_NATIVE_SWIFT_HARNESSES === '1';

function nativeSwiftHarnessTest(name: string, fn: () => void, timeout?: number): void {
  if (process.platform === 'darwin') {
    test(name, fn, timeout);
    return;
  }
  if (REQUIRE_NATIVE_SWIFT_HARNESSES) {
    test(name, () => {
      throw new Error('native Swift harnesses require macOS; run this in CI swift-gate');
    }, timeout);
    return;
  }
  test.skip(`${name} [macOS Swift harness; required in CI swift-gate]`, fn, timeout);
}

const SHARED = '$(AppIdentifierPrefix)io.beebeeb.shared';
const FILES = '$(AppIdentifierPrefix)io.beebeeb.files';

/** The keychain-access-groups array of an entitlements plist, or null when the key is absent. */
function keychainGroups(plist: string): string[] | null {
  const match = plist.match(/<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match) return null;
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

function plugin(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(join(ROOT, path));
}

describe('task 1722 round 4 (Q3): the Files keychain group is entitled to the app and the File Provider only', () => {
  const app = JSON.parse(read('app.json'));

  test('app.json: the app has the Files group after the shared one (the shared group stays the default for adds)', () => {
    expect(app.expo.ios.entitlements['keychain-access-groups']).toEqual([SHARED, FILES]);
  });

  test('the committed app entitlements are app.json plus the File Provider plugin groups, in that order', () => {
    const fileProvider = plugin('plugins/file-provider/withFileProvider.js');
    expect(fileProvider.APP_KEYCHAIN_ACCESS_GROUPS).toEqual([SHARED, FILES]);
    const expected = [...new Set([...app.expo.ios.entitlements['keychain-access-groups'], ...fileProvider.APP_KEYCHAIN_ACCESS_GROUPS])];
    expect(keychainGroups(read('ios/Beebeeb/Beebeeb.entitlements'))).toEqual(expected);
  });

  test('File Provider extension: the plugin writes shared + Files, and the committed file matches it', () => {
    const fileProvider = plugin('plugins/file-provider/withFileProvider.js');
    expect(typeof fileProvider.extensionEntitlementsPlist).toBe('function');
    const generated = fileProvider.extensionEntitlementsPlist();
    expect(keychainGroups(generated)).toEqual([SHARED, FILES]);
    // Byte for byte: a clean `expo prebuild` writes exactly the committed file.
    expect(read('ios/BeebeebFileProvider/BeebeebFileProvider.entitlements')).toBe(generated);
    expect(keychainGroups(read('targets/file-provider/generated.entitlements'))).toEqual([SHARED, FILES]);
    expect(read('targets/file-provider/expo-target.config.js')).toContain(`'keychain-access-groups': ['${SHARED}', '${FILES}']`);
  });

  test('Share extension: the plugin writes the shared group only, and the committed files match it', () => {
    const share = plugin('plugins/share-extension/withShareExtension.js');
    expect(typeof share.extensionEntitlementsPlist).toBe('function');
    expect(keychainGroups(share.extensionEntitlementsPlist())).toEqual([SHARED]);
    expect(read('ios/BeebeebShare/BeebeebShare.entitlements')).toBe(share.extensionEntitlementsPlist());
    expect(keychainGroups(read('targets/share-extension/generated.entitlements'))).toEqual([SHARED]);
    expect(read('targets/share-extension/expo-target.config.js')).not.toContain('io.beebeeb.files');
  });

  test('Widget: no keychain group at all (plugin and committed file)', () => {
    const widget = plugin('plugins/withWidget.js');
    expect(typeof widget.extensionEntitlementsPlist).toBe('function');
    expect(keychainGroups(widget.extensionEntitlementsPlist())).toBeNull();
    expect(read('ios/BeebeebWidget/BeebeebWidget.entitlements')).toBe(widget.extensionEntitlementsPlist());
  });

  test('BeebeebKeychainCore names the same group with the app.json team, and versions the Files key', () => {
    const core = read('modules/beebeeb-crypto/ios/Shared/BeebeebKeychainCore.swift');
    expect(app.expo.ios.appleTeamId).toBe('R8352WDJJR');
    const declarations = [
      'static let filesAccessGroup = "R8352WDJJR.io.beebeeb.files"',
      'static let accessGroup: String? = "R8352WDJJR.io.beebeeb.shared"',
      'static let seKeyTagFiles = "io.beebeeb.sekey.files.v2".data(using: .utf8)!',
      'static let wrappedKeyServiceFiles = "io.beebeeb.masterkey.files.v2"',
      'static let legacySeKeyTagFilesV1 = "io.beebeeb.sekey.files.v1".data(using: .utf8)!',
      'static let legacyWrappedKeyServiceFilesV1 = "io.beebeeb.masterkey.files.v1"',
    ];
    expect(declarations.filter((line) => !core.includes(line))).toEqual([]);
  });
});

// ---- native harness ----

function functionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start, end).replaceAll('private static func', 'static func');
}
/** '' when the signature is not in the source, so one harness compiles before and after a change. */
function optionalBody(source: string, signature: string) {
  return source.includes(signature) ? functionBody(source, signature) : '';
}
function optionalLine(source: string, prefix: string) {
  const found = source.split('\n').find((l) => l.trim().startsWith(prefix));
  return found ? found.trim().replace(/^private /, '') : '';
}

nativeSwiftHarnessTest('the Files key lives in the Files group only; the Share extension cannot reach it; round-3 keys in the shared group are deleted on upgrade', () => {
  const manager = read('modules/beebeeb-crypto/ios/KeychainManager.swift');
  const core = read('modules/beebeeb-crypto/ios/Shared/BeebeebKeychainCore.swift');
  const writer = [
    'enum FileProviderKeyOutcome',
    'enum FileProviderKeyCheck',
    'static func syncFileProviderWrappedKey(',
    'private static func provisionFileProviderKeyLocked(',
    'private static func checkFileProviderKey(',
    'private static func fileProviderKeyCount()',
    'private static func constantTimeEqual(',
    'static func deleteFileProviderKey()',
    'private static func deleteFileProviderKeyLocked()',
    'private static func deleteLegacyFileProviderKeyLocked()',
    'private static func storeFileProviderWrappedKey(',
    'private static func getOrCreateFileProviderSEKey()',
    'private static func generateSEKey(',
    'private static func deleteSEKey(tag: Data)',
    'private static func deleteSEKey(tag: Data, accessGroup: String?)',
    'private static func deleteWrappedItems(service: String)',
    'private static func deleteWrappedItems(service: String, accessGroup: String?)',
  ].map((s) => optionalBody(manager, s));
  const lock = optionalLine(manager, 'private static let fileProviderKeyLock');
  const loaders = [
    'static func findSEKey(tag: Data, authContext: AnyObject? = nil)',
    'static func findSEKeyReportingStatus(tag: Data, authContext: AnyObject? = nil)',
    'static func findSEKeyReportingStatus(tag: Data, inAccessGroup group: String)',
    'static func fetchWrappedBlobReportingStatus(service: String, label: String) ->',
    'static func fetchWrappedBlobReportingStatus(service: String, label: String, inAccessGroup group: String)',
    'static func loadFileProviderMasterKey(',
  ].map((s) => optionalBody(core, s));
  const loadError = functionBody(core, 'enum LoadError: Error {');

  const harness = String.raw`
import Foundation
typealias CFString = String
typealias CFDictionary = [String: Any]
typealias CFData = Data
typealias CFError = NSError
typealias CFTypeRef = AnyObject
typealias OSStatus = Int32
let kCFAllocatorDefault = 0
let kSecAttrAccessibleAfterFirstUnlock = "afterFirstUnlock-migratable"
let kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "afterFirstUnlock"
let kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly = "passcodeSetUnlockedDeviceOnly"
let kSecClass = "class", kSecClassGenericPassword = "password", kSecClassKey = "key", kSecAttrService = "service"
let kSecAttrAccount = "account", kSecAttrAccessible = "accessible", kSecValueData = "data"
let kSecAttrAccessGroup = "group", kSecAttrKeyType = "type", kSecAttrKeyTypeECSECPrimeRandom = "ec"
let kSecAttrKeySizeInBits = "bits", kSecAttrTokenID = "token", kSecAttrTokenIDSecureEnclave = "secureEnclave"
let kSecPrivateKeyAttrs = "private", kSecAttrIsPermanent = "permanent", kSecAttrApplicationTag = "tag", kSecAttrAccessControl = "acl"
let kSecReturnData = "returnData", kSecReturnAttributes = "returnAttributes", kSecReturnRef = "returnRef"
let kSecMatchLimit = "matchLimit", kSecMatchLimitAll = "all", kSecMatchLimitOne = "one"
let kSecUseAuthenticationContext = "authContext"
let errSecSuccess: OSStatus = 0
let errSecItemNotFound: OSStatus = -25300
let errSecDuplicateItem: OSStatus = -25299
let errSecInteractionNotAllowed: OSStatus = -25308
let errSecMissingEntitlement: OSStatus = -34018

struct SecAccessControlCreateFlags: OptionSet {
  let rawValue: Int
  static let privateKeyUsage = Self(rawValue: 1), devicePasscode = Self(rawValue: 2), biometryAny = Self(rawValue: 4)
}
struct ACL { let protection: String; let flags: SecAccessControlCreateFlags }
final class SecKey {
  let tag: Data, acl: ACL, id: UInt8, group: String
  init(_ tag: Data, _ acl: ACL, id: UInt8, group: String) { self.tag = tag; self.acl = acl; self.id = id; self.group = group }
}

let SHARED = "R8352WDJJR.io.beebeeb.shared", FILES = "R8352WDJJR.io.beebeeb.files"
/// keychain-access-groups per process, in entitlement order (the first is where an add without a group lands).
let appGroups = [SHARED, FILES], fileProviderGroups = [SHARED, FILES], shareGroups = [SHARED]

/// The keychain, shared by every process on the device; the calling process is Keychain.process.
enum Keychain {
  struct Item { let service: String; let account: String; let group: String; var data: Data; var accessible: String }
  static let lock = NSLock()
  static var keys: [SecKey] = [], items: [Item] = []
  static var nextId: UInt8 = 1, keysCreated = 0, process = appGroups
  static func with<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
  static func reset() { with { keys = []; items = []; nextId = 1; keysCreated = 0; process = appGroups } }
  /// An explicit group must be one of the process's (else nil: errSecMissingEntitlement); no group = all of them.
  static func groups(_ query: CFDictionary) -> [String]? {
    if let group = query[kSecAttrAccessGroup] as? String { return process.contains(group) ? [group] : nil }
    return process
  }
}
func matchesKey(_ key: SecKey, _ query: CFDictionary, _ groups: [String]) -> Bool {
  guard groups.contains(key.group) else { return false }
  if let tag = query[kSecAttrApplicationTag] as? Data, tag != key.tag { return false }
  return true
}
func matchesItem(_ item: Keychain.Item, _ query: CFDictionary, _ groups: [String]) -> Bool {
  guard groups.contains(item.group) else { return false }
  if let service = query[kSecAttrService] as? String, service != item.service { return false }
  if let account = query[kSecAttrAccount] as? String, account != item.account { return false }
  return true
}
func SecAccessControlCreateWithFlags(_ allocator: Int, _ protection: String, _ flags: SecAccessControlCreateFlags, _ error: Any?) -> ACL? {
  ACL(protection: protection, flags: flags)
}
func SecKeyCreateRandomKey(_ attrs: CFDictionary, _ error: inout Unmanaged<CFError>?) -> SecKey? {
  let p = attrs[kSecPrivateKeyAttrs] as! CFDictionary
  return Keychain.with { () -> SecKey? in
    let group = (attrs[kSecAttrAccessGroup] as? String) ?? (p[kSecAttrAccessGroup] as? String) ?? Keychain.process[0]
    guard Keychain.process.contains(group) else { return nil }
    let key = SecKey(p[kSecAttrApplicationTag] as! Data, p[kSecAttrAccessControl] as! ACL, id: Keychain.nextId, group: group)
    Keychain.nextId &+= 1
    Keychain.keysCreated += 1
    Keychain.keys.append(key)
    return key
  }
}
func SecKeyCopyPublicKey(_ key: SecKey) -> SecKey? { key }
/// ECIES double: the blob names the key that wrapped it, so only that key opens it.
func SecKeyCreateEncryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? {
  Data([99, key.id]) + bytes.map { $0 ^ 0xA5 }
}
func SecKeyCreateDecryptedData(_ key: SecKey, _ algorithm: String, _ bytes: CFData, _ error: inout Unmanaged<CFError>?) -> CFData? {
  guard bytes.count > 2, bytes.first == 99, bytes.dropFirst().first == key.id else {
    error = Unmanaged.passRetained(NSError(domain: NSOSStatusErrorDomain, code: -26275))
    return nil
  }
  return Data(bytes.dropFirst(2).map { $0 ^ 0xA5 })
}
@discardableResult
func SecItemAdd(_ attrs: CFDictionary, _ result: Any?) -> OSStatus {
  Keychain.with {
    let group = (attrs[kSecAttrAccessGroup] as? String) ?? Keychain.process[0]
    guard Keychain.process.contains(group) else { return errSecMissingEntitlement }
    let service = attrs[kSecAttrService] as! String, account = attrs[kSecAttrAccount] as? String ?? ""
    if Keychain.items.contains(where: { $0.service == service && $0.account == account && $0.group == group }) { return errSecDuplicateItem }
    Keychain.items.append(.init(service: service, account: account, group: group, data: attrs[kSecValueData] as? Data ?? Data(),
                                accessible: attrs[kSecAttrAccessible] as? String ?? "default"))
    return errSecSuccess
  }
}
@discardableResult
func SecItemUpdate(_ query: CFDictionary, _ values: CFDictionary) -> OSStatus {
  Keychain.with {
    guard let groups = Keychain.groups(query) else { return errSecMissingEntitlement }
    var found = false
    for index in Keychain.items.indices where matchesItem(Keychain.items[index], query, groups) {
      found = true
      if let data = values[kSecValueData] as? Data { Keychain.items[index].data = data }
      if let accessible = values[kSecAttrAccessible] as? String { Keychain.items[index].accessible = accessible }
    }
    return found ? errSecSuccess : errSecItemNotFound
  }
}
@discardableResult
func SecItemDelete(_ query: CFDictionary) -> OSStatus {
  Keychain.with {
    guard let groups = Keychain.groups(query) else { return errSecMissingEntitlement }
    if query[kSecClass] as? String == kSecClassKey {
      let before = Keychain.keys.count
      Keychain.keys.removeAll { matchesKey($0, query, groups) }
      return Keychain.keys.count < before ? errSecSuccess : errSecItemNotFound
    }
    let before = Keychain.items.count
    Keychain.items.removeAll { matchesItem($0, query, groups) }
    return Keychain.items.count < before ? errSecSuccess : errSecItemNotFound
  }
}
func SecItemCopyMatching(_ query: CFDictionary, _ result: inout CFTypeRef?) -> OSStatus {
  let (status, value) = Keychain.with { () -> (OSStatus, CFTypeRef?) in
    guard let groups = Keychain.groups(query) else { return (errSecMissingEntitlement, nil) }
    let all = query[kSecMatchLimit] as? String == kSecMatchLimitAll
    if query[kSecClass] as? String == kSecClassKey {
      let matches = Keychain.keys.filter { matchesKey($0, query, groups) }
      guard let first = matches.first else { return (errSecItemNotFound, nil) }
      if all { return (errSecSuccess, matches.map { [kSecAttrApplicationTag: $0.tag, kSecAttrAccessGroup: $0.group] } as NSArray) }
      return (errSecSuccess, first)
    }
    let matches = Keychain.items.filter { matchesItem($0, query, groups) }
    guard let first = matches.first else { return (errSecItemNotFound, nil) }
    if all { return (errSecSuccess, matches.map { [kSecValueData: $0.data, kSecAttrAccount: $0.account] } as NSArray) }
    return (errSecSuccess, first.data as NSData)
  }
  result = value
  return status
}

enum KeychainError: Error {
  case seKeyGenerationFailed, seKeyNotFound, encryptionFailed, decryptionFailed, invalidMasterKeySize
  case writeError(OSStatus), readError(OSStatus)
}
enum RuntimeTrace {
  private static let lock = NSLock()
  private static var recorded: [String] = []
  static var events: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
  static func reset() { lock.lock(); recorded = []; lock.unlock() }
  static func event(_ name: String, _ payload: [String: Any] = [:]) { lock.lock(); recorded.append(name); lock.unlock() }
}
enum PlaintextStorageProtection {
  static func isPurgePending() -> Bool { false }
}

enum BeebeebKeychainCore {
  ${loadError}
  static let accessGroup: String? = SHARED
  static let filesAccessGroup = FILES
  static let seKeyTag = Data("io.beebeeb.sekey".utf8), seKeyTagExt = Data("io.beebeeb.sekey.ext".utf8)
  static let seKeyTagFiles = Data("io.beebeeb.sekey.files.v2".utf8)
  static let legacySeKeyTagFilesV1 = Data("io.beebeeb.sekey.files.v1".utf8)
  static let wrappedKeyService = "io.beebeeb.masterkey", wrappedKeyServiceExt = "io.beebeeb.masterkey.ext"
  static let wrappedKeyServiceFiles = "io.beebeeb.masterkey.files.v2"
  static let legacyWrappedKeyServiceFilesV1 = "io.beebeeb.masterkey.files.v1"
  static let eciesAlgorithm = "ecies"
  static func fileProviderMountConsented(defaults: UserDefaults? = nil) -> Bool { true }
  ${loaders.join('\n')}
}
enum Manager {
  ${lock}
  ${writer.join('\n')}
}

var count = 0, failed = 0
/// Keeps going after a failure, so a red run lists every check that failed.
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  if condition() { count += 1 } else { failed += 1; print("FAIL: \(label)"); fflush(stdout) }
}
let vault = Data(repeating: 42, count: 32)
let label = "io.beebeeb.master-key"
let v2Tag = BeebeebKeychainCore.seKeyTagFiles, v1Tag = BeebeebKeychainCore.legacySeKeyTagFilesV1
let v2Service = BeebeebKeychainCore.wrappedKeyServiceFiles, v1Service = BeebeebKeychainCore.legacyWrappedKeyServiceFilesV1

/// Runs body as the process with these keychain-access-groups.
func asProcess<T>(_ groups: [String], _ body: () -> T) -> T {
  let saved = Keychain.with { Keychain.process }
  Keychain.with { Keychain.process = groups }
  defer { Keychain.with { Keychain.process = saved } }
  return body()
}
func keys(_ tag: Data, in group: String? = nil) -> [SecKey] { Keychain.with { Keychain.keys.filter { $0.tag == tag && (group == nil || $0.group == group) } } }
func items(_ service: String, in group: String? = nil) -> [Keychain.Item] { Keychain.with { Keychain.items.filter { $0.service == service && (group == nil || $0.group == group) } } }
func groupsOf(_ tag: Data) -> [String] { keys(tag).map(\.group) }
/// What a query without a group returns to the calling process (every group it has).
func visibleKeys(_ tag: Data) -> Int {
  var result: CFTypeRef?
  let query: CFDictionary = [kSecClass: kSecClassKey, kSecAttrApplicationTag: tag, kSecReturnAttributes: true, kSecMatchLimit: kSecMatchLimitAll]
  return SecItemCopyMatching(query, &result) == errSecSuccess ? ((result as? NSArray)?.count ?? 0) : 0
}
func visibleItems(_ service: String) -> Int {
  var result: CFTypeRef?
  let query: CFDictionary = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecReturnAttributes: true, kSecMatchLimit: kSecMatchLimitAll]
  return SecItemCopyMatching(query, &result) == errSecSuccess ? ((result as? NSArray)?.count ?? 0) : 0
}
func filesLoad(as groups: [String]) -> Data? { asProcess(groups) { try? BeebeebKeychainCore.loadFileProviderMasterKey(label: label) } }
func filesLoadError(as groups: [String]) -> String {
  asProcess(groups) {
    do { _ = try BeebeebKeychainCore.loadFileProviderMasterKey(label: label); return "loaded" } catch { return "\(error)" }
  }
}
/// Not named sync(): a bare sync() call resolves to Darwin's libc sync(2) and does nothing here.
func syncFilesKey(allowed: Bool = true) -> Manager.FileProviderKeyOutcome {
  Manager.syncFileProviderWrappedKey(masterKeyBytes: vault, label: label, allowed: { allowed })
}
let filesACL = ACL(protection: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags: [.privateKeyUsage])
/// What a round-3 build left (simulator, 2026-10-15: "files-tag keys=1 (group/token: R8352WDJJR.io.beebeeb.shared/...)"):
/// the v1 key and its blob in the shared group.
func injectRoundThreeKey() {
  Keychain.with {
    Keychain.keys.append(SecKey(v1Tag, filesACL, id: 200, group: SHARED))
    Keychain.items.append(.init(service: v1Service, account: label, group: SHARED, data: Data([99, 200]) + vault.map { $0 ^ 0xA5 },
                                accessible: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly))
  }
}

// 1. A fresh Files key: the key and its blob land in the Files group, nothing in the shared one.
Keychain.reset(); RuntimeTrace.reset()
check(syncFilesKey() == .ready, "fresh: the Files key is provisioned")
check(keys(v2Tag).count == 1 && keys(v2Tag, in: FILES).count == 1, "fresh: one Files key, in the Files group, got groups \(groupsOf(v2Tag))")
check(items(v2Service).count == 1 && items(v2Service, in: FILES).count == 1, "fresh: one wrapped blob, in the Files group, got groups \(items(v2Service).map(\.group))")
check(keys(v2Tag, in: SHARED).isEmpty && items(v2Service, in: SHARED).isEmpty && keys(v1Tag).isEmpty && items(v1Service).isEmpty,
      "fresh: no Files key or blob in the shared group")
check(keys(v2Tag).first?.acl.flags == [.privateKeyUsage] && keys(v2Tag).first?.acl.protection == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      "fresh: key policy unchanged (no prompt; unlocked, passcode-set device only)")
check(items(v2Service).first?.accessible == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, "fresh: blob protection unchanged")

// 2. The File Provider (shared + Files groups) loads it; the Share extension (shared only) cannot.
check(filesLoad(as: fileProviderGroups) == vault, "File Provider: loads the vault key through the Files key")
check(filesLoad(as: shareGroups) == nil, "Share extension: cannot load the Files key, got \(filesLoadError(as: shareGroups))")
check(asProcess(shareGroups) { visibleKeys(v2Tag) + visibleItems(v2Service) } == 0, "Share extension: the Files key and blob are not in any of its groups")
let createdOnce = Keychain.with { Keychain.keysCreated }
check(syncFilesKey() == .ready && Keychain.with { Keychain.keysCreated } == createdOnce, "a working Files key is checked, not rewritten")

// 3. Upgrade from a round-3 build, Files on: the v1 key + blob go from every group, a new key lands in the Files group.
Keychain.reset(); RuntimeTrace.reset()
injectRoundThreeKey()
check(asProcess(shareGroups) { visibleKeys(v1Tag) } == 1, "setup: the round-3 Files key is visible to the Share extension (what Q3 removes)")
check(filesLoad(as: fileProviderGroups) == nil, "before the app migrates: the File Provider never uses the round-3 key, got \(filesLoadError(as: fileProviderGroups))")
check(syncFilesKey() == .ready, "upgrade: the unlock provisions the Files key")
check(keys(v1Tag).isEmpty && items(v1Service).isEmpty, "upgrade: the round-3 key and blob are deleted, left \(groupsOf(v1Tag)) / \(items(v1Service).map(\.group))")
check(keys(v2Tag).count == 1 && keys(v2Tag, in: FILES).count == 1, "upgrade: one new Files key, in the Files group, got \(groupsOf(v2Tag))")
check(RuntimeTrace.events.contains("keychain.manager.files_key.legacy_removed"), "upgrade: the removal is traced, got \(RuntimeTrace.events)")
check(filesLoad(as: fileProviderGroups) == vault, "upgrade: the File Provider loads through the new key")
check(asProcess(shareGroups) { visibleKeys(v1Tag) + visibleKeys(v2Tag) + visibleItems(v1Service) + visibleItems(v2Service) } == 0,
      "upgrade: the Share extension sees no Files key or blob")

// 3b. A round-3 straggler next to a working new key (an earlier delete that did not land): the next
// unlock removes it although the new key needs no repair.
Keychain.reset(); RuntimeTrace.reset()
_ = syncFilesKey()
injectRoundThreeKey()
RuntimeTrace.reset()
check(syncFilesKey() == .ready, "straggler: the working Files key stays ready")
check(keys(v1Tag).isEmpty && items(v1Service).isEmpty, "straggler: the round-3 key and blob are deleted, left \(groupsOf(v1Tag))")
check(RuntimeTrace.events.contains("keychain.manager.files_key.legacy_removed"), "straggler: the removal is traced, got \(RuntimeTrace.events)")

// 4. Upgrade with Files off: the round-3 key goes, and no new key is made.
Keychain.reset(); RuntimeTrace.reset()
injectRoundThreeKey()
check(syncFilesKey(allowed: false) == .notAllowed, "upgrade with Files off: not allowed")
check(keys(v1Tag).isEmpty && items(v1Service).isEmpty && keys(v2Tag).isEmpty && items(v2Service).isEmpty,
      "upgrade with Files off: no Files key or blob in any group, left keys \(Keychain.with { Keychain.keys.map(\.group) })")

// 5. A v2 key in the shared group (a development build): never used by the extension, replaced by the app.
Keychain.reset(); RuntimeTrace.reset()
Keychain.with {
  Keychain.keys.append(SecKey(v2Tag, filesACL, id: 210, group: SHARED))
  Keychain.items.append(.init(service: v2Service, account: label, group: SHARED, data: Data([99, 210]) + vault.map { $0 ^ 0xA5 },
                              accessible: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly))
}
check(filesLoad(as: fileProviderGroups) == nil, "a Files key in the shared group is never used by the File Provider, got \(filesLoadError(as: fileProviderGroups))")
check(syncFilesKey() == .ready, "the app replaces a Files key in the wrong group")
check(keys(v2Tag, in: SHARED).isEmpty && items(v2Service, in: SHARED).isEmpty, "the wrong-group key and blob are removed")
check(keys(v2Tag).count == 1 && keys(v2Tag, in: FILES).count == 1 && filesLoad(as: fileProviderGroups) == vault,
      "one working Files key, in the Files group")

// 5b. Each lookup on its own names the Files group: a key in the shared group with its blob in the
// Files group, and a key in the Files group with its blob in the shared group, are never used.
Keychain.reset(); RuntimeTrace.reset()
Keychain.with {
  Keychain.keys.append(SecKey(v2Tag, filesACL, id: 220, group: SHARED))
  Keychain.items.append(.init(service: v2Service, account: label, group: FILES, data: Data([99, 220]) + vault.map { $0 ^ 0xA5 },
                              accessible: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly))
}
check(filesLoad(as: fileProviderGroups) == nil, "key in the shared group, blob in the Files group: never used, got \(filesLoadError(as: fileProviderGroups))")
Keychain.reset(); RuntimeTrace.reset()
Keychain.with {
  Keychain.keys.append(SecKey(v2Tag, filesACL, id: 230, group: FILES))
  Keychain.items.append(.init(service: v2Service, account: label, group: SHARED, data: Data([99, 230]) + vault.map { $0 ^ 0xA5 },
                              accessible: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly))
}
check(filesLoad(as: fileProviderGroups) == nil, "key in the Files group, blob in the shared group: never used, got \(filesLoadError(as: fileProviderGroups))")
check(syncFilesKey() == .ready && items(v2Service, in: SHARED).isEmpty && filesLoad(as: fileProviderGroups) == vault,
      "the app replaces a blob in the wrong group")

// 6. Files off / sign-out (deleteFileProviderKey): nothing Files-related left anywhere, round-3 leftovers included.
Keychain.reset(); RuntimeTrace.reset()
_ = syncFilesKey()
injectRoundThreeKey()
Manager.deleteFileProviderKey()
check(Keychain.with { Keychain.keys.isEmpty && Keychain.items.isEmpty },
      "delete: no Files key or blob in any group, left keys \(Keychain.with { Keychain.keys.map(\.group) }), blobs \(Keychain.with { Keychain.items.map(\.service) })")

print("Files key access group: \(count) cases passed, \(failed) failed")
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-files-key-group-'));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'runner'), output = join(dir, 'output.log');
  writeFileSync(swift, harness);
  try {
    execFileSync('xcrun', ['swiftc', swift, '-o', binary], { timeout: 180_000, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`access-group harness did not compile:\n${String(error?.stderr ?? error)}`);
  }
  try {
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-key-group', binary, output], { timeout: 60_000 });
  } catch {
    // The FAIL line is asserted below.
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  console.log(text);
  expect(text).not.toContain('FAIL:');
  expect(text).toContain('Files key access group: 31 cases passed, 0 failed');
}, 300_000);
