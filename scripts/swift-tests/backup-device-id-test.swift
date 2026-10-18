import Darwin
import Foundation
import Security

// Task 1667 round 12 (review of mobile#182 at e9a93077, item 7) — standalone
// swiftc test for `BackupDeviceId`, compiled with the REAL shipped source
// (BackupDeviceId.swift, plus PendingUploadServerCheck/ManifestRebuildGate for
// the backoff) by scripts/swift-ci/run-swift-tests.sh.
//
// What it proves:
//   (a) a background task that runs before the first app open of this build
//       gets the canonical id from expo-secure-store's keychain item
//       (`bb_sync_device_id`), and it is persisted for later (locked) reads;
//   (b) native never mints an id: none anywhere is nil (the engine then
//       defers on `noDeviceId` with a 30 s backoff, not a 5 s spin);
//   (c) a canonical item that cannot be read now (device locked) is NOT
//       replaced by the legacy one (they may differ);
//   (d) the keychain query is expo-secure-store 57's layout (service
//       "app:no-auth" then "app", account/generic = the key's UTF-8 bytes) and
//       never asks for authentication UI (no Face ID from a background task).
//
// The real keychain read (`readSecureStore`) is not exercised here: a CLI
// binary has no app keychain access group. Its query is pinned by (d), and
// the decision around it by (a)-(c).

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

final class FakeKeychain {
  var items: [String: BackupDeviceId.Read] = [:]
  var reads: [String] = []
  func read(_ key: String) -> BackupDeviceId.Read {
    reads.append(key)
    return items[key] ?? .notFound
  }
}

final class FakeDefaults {
  var value: String?
  var writes: [String] = []
  func persist(_ v: String) { writes.append(v); value = v }
}

func resolve(_ d: FakeDefaults, _ k: FakeKeychain) -> BackupDeviceId.Resolution {
  BackupDeviceId.resolve(defaults: { d.value }, secureStore: { k.read($0) }, persist: { d.persist($0) })
}

// MARK: - (a) before the first app open: the canonical id from the keychain

do {
  let d = FakeDefaults()
  let k = FakeKeychain()
  k.items[BackupDeviceId.canonicalSecureStoreKey] = .value("dev-canonical")
  let r = resolve(d, k)
  expect(r.id == "dev-canonical" && r.source == .secureStoreCanonical, "a1: the canonical id is read (got \(r))")
  expect(d.writes == ["dev-canonical"], "a2: and persisted to UserDefaults (got \(d.writes))")
  // Later reads (the device locked) come from UserDefaults, no keychain read.
  k.reads = []
  k.items[BackupDeviceId.canonicalSecureStoreKey] = .unavailable(errSecInteractionNotAllowed)
  let again = resolve(d, k)
  expect(again.id == "dev-canonical" && again.source == .defaults && k.reads.isEmpty, "a3: the persisted id is used; no keychain read")
  // JS's id (setBackupDeviceId) wins: it is what UserDefaults holds.
  d.value = "dev-from-js"
  expect(resolve(d, k).id == "dev-from-js", "a4: the id JS handed over is used")
}

// MARK: - (b) never minted

do {
  let d = FakeDefaults()
  let k = FakeKeychain()
  let r = resolve(d, k)
  expect(r.id == nil && r.source == nil && r.unavailable == nil, "b1: no id anywhere: nil (got \(r))")
  expect(d.writes.isEmpty, "b1: nothing persisted, nothing minted")
  expect(k.reads == [BackupDeviceId.canonicalSecureStoreKey, BackupDeviceId.legacySecureStoreKey], "b2: canonical, then legacy (got \(k.reads))")
  d.value = ""
  k.items[BackupDeviceId.canonicalSecureStoreKey] = .value("")
  expect(resolve(d, k).id == nil, "b3: empty values count as none")
  // JS's resolveCanonicalId step 2: the legacy backup id is adopted.
  k.items[BackupDeviceId.legacySecureStoreKey] = .value("dev-legacy")
  let legacy = resolve(d, k)
  expect(legacy.id == "dev-legacy" && legacy.source == .secureStoreLegacy, "b4: the legacy id, as JS would adopt it (got \(legacy))")
  // The engine's deferral without an id backs off instead of spinning.
  expect(PendingUploadServerCheck.backoff(for: .noDeviceId, consecutiveFailures: 1) == ManifestRebuildGate.fetchFailureBackoff,
         "b5: noDeviceId backs off 30 s (batch guard)")
  expect(ManifestRebuildGate.backoff(for: .noDeviceId, consecutiveFailures: 1) == ManifestRebuildGate.fetchFailureBackoff,
         "b5: noDeviceId backs off 30 s (rebuild gate)")
}

// MARK: - (c) a locked canonical item is not replaced by the legacy one

do {
  let d = FakeDefaults()
  let k = FakeKeychain()
  k.items[BackupDeviceId.canonicalSecureStoreKey] = .unavailable(errSecInteractionNotAllowed)
  k.items[BackupDeviceId.legacySecureStoreKey] = .value("dev-legacy")
  let r = resolve(d, k)
  expect(r.id == nil && r.unavailable == errSecInteractionNotAllowed, "c1: locked: nil with the status (got \(r))")
  expect(k.reads == [BackupDeviceId.canonicalSecureStoreKey], "c2: the legacy item is not read (got \(k.reads))")
  expect(d.writes.isEmpty, "c3: nothing persisted")
}

// MARK: - (d) expo-secure-store's keychain layout, no authentication UI

do {
  expect(BackupDeviceId.canonicalSecureStoreKey == "bb_sync_device_id", "d1: the canonical key (device-identity.ts DEVICE_ID_KEY)")
  expect(BackupDeviceId.legacySecureStoreKey == "beebeeb_device_id", "d1: the legacy key (LEGACY_BACKUP_DEVICE_ID_KEY)")
  expect(BackupDeviceId.secureStoreServices == ["app:no-auth", "app"], "d2: the no-auth service, then the legacy one; never app:auth")
  let q = BackupDeviceId.secureStoreQuery(key: "bb_sync_device_id", service: "app:no-auth")
  expect(q[kSecClass as String] as? String == kSecClassGenericPassword as String, "d3: a generic password")
  expect(q[kSecAttrService as String] as? String == "app:no-auth", "d3: the service")
  expect(q[kSecAttrAccount as String] as? Data == Data("bb_sync_device_id".utf8), "d3: the account is the key's UTF-8 bytes")
  expect(q[kSecAttrGeneric as String] as? Data == Data("bb_sync_device_id".utf8), "d3: so is the generic attribute")
  expect(q[kSecAttrAccessGroup as String] == nil, "d3: no access group (expo passes none)")
  expect(q[kSecUseAuthenticationUI as String] as? String == kSecUseAuthenticationUISkip as String, "d4: never any authentication UI")
  expect(q[kSecUseOperationPrompt as String] == nil, "d4: no operation prompt")
}

if failures.isEmpty {
  print("BackupDeviceIdTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("BackupDeviceIdTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
