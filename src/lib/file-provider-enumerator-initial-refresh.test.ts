// @ts-nocheck — bun runs this; guards native File Provider behavior.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ENUMERATOR = join(ROOT, 'targets', 'file-provider', 'FileProviderEnumerator.swift');
const SYNC_ENGINE = join(ROOT, 'targets', 'file-provider', 'SyncEngine.swift');
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

function bracedBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated body for ${signature}`);
}

const swiftHarness = String.raw`
import Foundation
import FileProvider
import UniformTypeIdentifiers

enum BeebeebConstants {
  static let rootContainerIdentifier = "io.beebeeb.root"
}

struct CachedItem {
  let id: String
  let parentId: String?
  let nameDecrypted: String?
}

final class CacheManager {
  static let shared = CacheManager()
  func children(parent: String?) -> [CachedItem] { [] }
  func syncState(key: String) -> String? { nil }
}

enum FileProviderRefreshOutcome {
  case success
  case notAuthenticated
  case serverUnreachable

  var fileProviderError: Error {
    switch self {
    case .success:
      return NSFileProviderError(.cannotSynchronize)
    case .notAuthenticated:
      return NSFileProviderError(.notAuthenticated)
    case .serverUnreachable:
      return NSFileProviderError(.serverUnreachable)
    }
  }
}

enum SyncEngine {
  static func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome { .success }
}

final class FileProviderItem: NSObject, NSFileProviderItem {
  let cached: CachedItem
  init(cached: CachedItem) { self.cached = cached }
  var itemIdentifier: NSFileProviderItemIdentifier { NSFileProviderItemIdentifier(cached.id) }
  var parentItemIdentifier: NSFileProviderItemIdentifier {
    cached.parentId.map(NSFileProviderItemIdentifier.init(_:)) ?? .rootContainer
  }
  var filename: String { cached.nameDecrypted ?? cached.id }
  var contentType: UTType { .data }
  var capabilities: NSFileProviderItemCapabilities { [.allowsReading] }
  var itemVersion: NSFileProviderItemVersion {
    NSFileProviderItemVersion(contentVersion: Data(), metadataVersion: Data())
  }
}

final class MockCache: FileProviderCacheReading {
  private let lock = NSLock()
  private var rowsByParent: [String: [CachedItem]]
  private var anchors: [String: String]

  init(rowsByParent: [String: [CachedItem]] = [:], anchors: [String: String] = [:]) {
    self.rowsByParent = rowsByParent
    self.anchors = anchors
  }

  func setRows(_ rows: [CachedItem], parent: String?) {
    lock.lock(); defer { lock.unlock() }
    rowsByParent[parent ?? "root"] = rows
  }

  func children(parent: String?) -> [CachedItem] {
    lock.lock(); defer { lock.unlock() }
    return rowsByParent[parent ?? "root"] ?? []
  }

  func syncState(key: String) -> String? {
    lock.lock(); defer { lock.unlock() }
    return anchors[key]
  }
}

final class MockRefresher: FileProviderContainerRefreshing {
  private let lock = NSLock()
  let cache: MockCache
  let outcome: FileProviderRefreshOutcome
  let rowsAfterSuccess: [CachedItem]
  let delayNanos: UInt64
  private(set) var callCount = 0

  init(
    cache: MockCache,
    outcome: FileProviderRefreshOutcome,
    rowsAfterSuccess: [CachedItem] = [],
    delayNanos: UInt64 = 0
  ) {
    self.cache = cache
    self.outcome = outcome
    self.rowsAfterSuccess = rowsAfterSuccess
    self.delayNanos = delayNanos
  }

  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    lock.lock(); callCount += 1; lock.unlock()
    if delayNanos > 0 { try? await Task.sleep(nanoseconds: delayNanos) }
    if case .success = outcome {
      cache.setRows(rowsAfterSuccess, parent: nil)
    }
    return outcome
  }
}

final class RecordingObserver: NSObject, NSFileProviderEnumerationObserver {
  private let lock = NSLock()
  private let semaphore = DispatchSemaphore(value: 0)
  private(set) var enumeratedCounts: [Int] = []
  private(set) var finishedPage: NSFileProviderPage?
  private(set) var error: Error?

  func didEnumerate(_ updatedItems: [NSFileProviderItem]) {
    lock.lock(); defer { lock.unlock() }
    enumeratedCounts.append(updatedItems.count)
  }

  func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
    lock.lock()
    finishedPage = nextPage
    lock.unlock()
    semaphore.signal()
  }

  func finishEnumeratingWithError(_ error: Error) {
    lock.lock()
    self.error = error
    lock.unlock()
    semaphore.signal()
  }

  @discardableResult
  func wait(seconds: Double) -> Bool {
    semaphore.wait(timeout: .now() + seconds) == .success
  }

  var snapshot: (counts: [Int], didFinish: Bool, error: NSError?) {
    lock.lock(); defer { lock.unlock() }
    return (enumeratedCounts, finishedPage != nil || error != nil, error as NSError?)
  }
}

final class RecordingChangeObserver: NSObject, NSFileProviderChangeObserver {
  var updatedCount = 0
  var deletedCount = 0
  var finishedAnchor: NSFileProviderSyncAnchor?
  var error: NSError?
  func didUpdate(_ updatedItems: [NSFileProviderItem]) { updatedCount += updatedItems.count }
  func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) { deletedCount += deletedItemIdentifiers.count }
  func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) { finishedAnchor = anchor }
  func finishEnumeratingWithError(_ error: Error) { self.error = error as NSError }
}

func readAnchor(_ enumerator: FileProviderEnumerator) -> NSFileProviderSyncAnchor {
  var result: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { result = $0 }
  assert(result != nil, "current anchor missing")
  return result!
}

func assert(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    Foundation.exit(1)
  }
}

func item(_ id: String) -> CachedItem {
  CachedItem(id: id, parentId: nil, nameDecrypted: id)
}

func assertProviderError(_ error: NSError?, code: NSFileProviderError.Code, _ context: String) {
  assert(error != nil, "\(context): expected error")
  assert(error!.domain == NSFileProviderErrorDomain, "\(context): wrong domain \(error!.domain)")
  assert(error!.code == code.rawValue, "\(context): wrong code \(error!.code)")
}

@main
struct Main {
  static func main() async {
    await populatedFirstMountRefreshesBeforeSuccess()
    await trueEmptyFolderSucceedsAfterRefresh()
    await knownEmptyFolderReturnsImmediatelyAndRefreshesInBackground()
    await failedInitialRefreshReportsAuthError()
    await failedInitialRefreshReportsServerError()
    await cancellationDoesNotCompleteInvalidatedObserver()
    cachedEmptyAnchorRequestsPopulatedRebuild()
    unchangedSnapshotDoesNotRestartEnumeration()
    deletionRequestsCompleteRebuild()
    subfolderSnapshotTracksMetadataChanges()
    cacheWriteAfterListingDoesNotAdvanceDeliveredAnchor()
    print("swift-enumerator-harness: 11 pass")
  }

  static func makeEnumerator(cache: MockCache, refresher: MockRefresher) -> FileProviderEnumerator {
    FileProviderEnumerator(containerIdentifier: .rootContainer, cache: cache, refresher: refresher)
  }

  static func cachedEmptyAnchorRequestsPopulatedRebuild() {
    let cache = MockCache(anchors: ["container.io.beebeeb.root.anchor": "stale-empty"])
    let refresher = MockRefresher(cache: cache, outcome: .success, rowsAfterSuccess: [item("fresh")])
    let enumerator = makeEnumerator(cache: cache, refresher: refresher)
    cache.setRows([item("fresh")], parent: nil)
    let observer = RecordingChangeObserver()
    enumerator.enumerateChanges(for: observer, from: NSFileProviderSyncAnchor(Data("stale-empty".utf8)))
    assertProviderError(observer.error, code: .syncAnchorExpired, "populated stale empty anchor")
    assert(observer.finishedAnchor == nil, "stale empty anchor falsely finished up-to-date")
    let listing = RecordingObserver()
    enumerator.enumerateItems(for: listing, startingAt: NSFileProviderPage(Data()))
    assert(listing.wait(seconds: 0.1), "rebuilt populated listing blocked")
    assert(listing.snapshot.counts == [1], "rebuild missed cached row")
    enumerator.invalidate()
  }

  static func unchangedSnapshotDoesNotRestartEnumeration() {
    let cache = MockCache(rowsByParent: ["root": [item("stable")]])
    let enumerator = makeEnumerator(cache: cache, refresher: MockRefresher(cache: cache, outcome: .success))
    let anchor = readAnchor(enumerator)
    let observer = RecordingChangeObserver()
    enumerator.enumerateChanges(for: observer, from: anchor)
    assert(observer.error == nil, "unchanged listing caused reload loop")
    assert(observer.finishedAnchor == anchor, "unchanged listing did not finish at same anchor")
    assert(observer.updatedCount == 0 && observer.deletedCount == 0, "unchanged listing emitted false delta")
  }

  static func deletionRequestsCompleteRebuild() {
    let cache = MockCache(rowsByParent: ["root": [item("deleted")]])
    let enumerator = makeEnumerator(cache: cache, refresher: MockRefresher(cache: cache, outcome: .success))
    let anchor = readAnchor(enumerator)
    cache.setRows([], parent: nil)
    let observer = RecordingChangeObserver()
    enumerator.enumerateChanges(for: observer, from: anchor)
    assertProviderError(observer.error, code: .syncAnchorExpired, "removed item anchor")
    assert(observer.finishedAnchor == nil, "removed item falsely reported current")
  }

  static func subfolderSnapshotTracksMetadataChanges() {
    let old = CachedItem(id: "child", parentId: "folder", nameDecrypted: "before")
    let cache = MockCache(rowsByParent: ["folder": [old]])
    let enumerator = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("folder"), cache: cache, refresher: MockRefresher(cache: cache, outcome: .success))
    let anchor = readAnchor(enumerator)
    cache.setRows([CachedItem(id: "child", parentId: "folder", nameDecrypted: "after")], parent: "folder")
    let observer = RecordingChangeObserver()
    enumerator.enumerateChanges(for: observer, from: anchor)
    assertProviderError(observer.error, code: .syncAnchorExpired, "renamed subfolder item")
    assert(readAnchor(enumerator) != anchor, "subfolder metadata absent from anchor")
  }

  static func cacheWriteAfterListingDoesNotAdvanceDeliveredAnchor() {
    let cache = MockCache(rowsByParent: ["root": [item("delivered")]])
    let enumerator = makeEnumerator(cache: cache, refresher: MockRefresher(cache: cache, outcome: .serverUnreachable))
    let baseline = readAnchor(enumerator)
    let listing = RecordingObserver()
    enumerator.enumerateItems(for: listing, startingAt: NSFileProviderPage(Data()))
    assert(listing.wait(seconds: 0.1), "initial cached listing did not finish")
    cache.setRows([item("delivered"), item("not-yet-delivered")], parent: nil)
    let deliveredAnchor = readAnchor(enumerator)
    assert(deliveredAnchor == baseline, "anchor advanced to rows not delivered to Files")
    let change = RecordingChangeObserver()
    enumerator.enumerateChanges(for: change, from: deliveredAnchor)
    assertProviderError(change.error, code: .syncAnchorExpired, "cache write after listing")
    enumerator.invalidate()
  }

  static func populatedFirstMountRefreshesBeforeSuccess() async {
    let cache = MockCache()
    let refresher = MockRefresher(cache: cache, outcome: .success, rowsAfterSuccess: [item("fresh")])
    let observer = RecordingObserver()
    makeEnumerator(cache: cache, refresher: refresher).enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    assert(observer.wait(seconds: 2), "populated first mount did not finish")
    let snapshot = observer.snapshot
    assert(snapshot.counts == [1], "populated first mount counts \(snapshot.counts)")
    assert(snapshot.error == nil, "populated first mount unexpected error")
    assert(refresher.callCount == 1, "populated first mount refresh count \(refresher.callCount)")
  }

  static func trueEmptyFolderSucceedsAfterRefresh() async {
    let cache = MockCache()
    let refresher = MockRefresher(cache: cache, outcome: .success, rowsAfterSuccess: [])
    let observer = RecordingObserver()
    makeEnumerator(cache: cache, refresher: refresher).enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    assert(observer.wait(seconds: 2), "true empty folder did not finish")
    let snapshot = observer.snapshot
    assert(snapshot.counts == [0], "true empty folder counts \(snapshot.counts)")
    assert(snapshot.error == nil, "true empty folder unexpected error")
  }

  static func knownEmptyFolderReturnsImmediatelyAndRefreshesInBackground() async {
    let cache = MockCache(anchors: ["container.io.beebeeb.root.anchor": "synced-empty"])
    let refresher = MockRefresher(
      cache: cache,
      outcome: .success,
      rowsAfterSuccess: [item("late")],
      delayNanos: 200_000_000
    )
    let observer = RecordingObserver()
    makeEnumerator(cache: cache, refresher: refresher).enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    assert(observer.wait(seconds: 0.05), "known empty folder waited for refresh")
    let snapshot = observer.snapshot
    assert(snapshot.counts == [0], "known empty folder counts \(snapshot.counts)")
    assert(snapshot.error == nil, "known empty folder unexpected error")
    try? await Task.sleep(nanoseconds: 350_000_000)
    assert(refresher.callCount == 1, "known empty folder refresh count \(refresher.callCount)")
    assert(cache.children(parent: nil).count == 1, "known empty folder background refresh did not update cache")
  }

  static func failedInitialRefreshReportsAuthError() async {
    let cache = MockCache()
    let refresher = MockRefresher(cache: cache, outcome: .notAuthenticated)
    let observer = RecordingObserver()
    makeEnumerator(cache: cache, refresher: refresher).enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    assert(observer.wait(seconds: 2), "auth failure did not finish")
    let snapshot = observer.snapshot
    assert(snapshot.counts.isEmpty, "auth failure enumerated items")
    assertProviderError(snapshot.error, code: .notAuthenticated, "auth failure")
  }

  static func failedInitialRefreshReportsServerError() async {
    let cache = MockCache()
    let refresher = MockRefresher(cache: cache, outcome: .serverUnreachable)
    let observer = RecordingObserver()
    makeEnumerator(cache: cache, refresher: refresher).enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    assert(observer.wait(seconds: 2), "server failure did not finish")
    let snapshot = observer.snapshot
    assert(snapshot.counts.isEmpty, "server failure enumerated items")
    assertProviderError(snapshot.error, code: .serverUnreachable, "server failure")
  }

  static func cancellationDoesNotCompleteInvalidatedObserver() async {
    let cache = MockCache()
    let refresher = MockRefresher(
      cache: cache,
      outcome: .success,
      rowsAfterSuccess: [item("late")],
      delayNanos: 200_000_000
    )
    let observer = RecordingObserver()
    let enumerator = makeEnumerator(cache: cache, refresher: refresher)
    enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    try? await Task.sleep(nanoseconds: 20_000_000)
    enumerator.invalidate()
    try? await Task.sleep(nanoseconds: 300_000_000)
    let snapshot = observer.snapshot
    assert(!snapshot.didFinish, "cancelled observer should not finish")
    assert(snapshot.counts.isEmpty, "cancelled observer enumerated items")
  }
}
`;

describe('iOS File Provider initial enumeration refresh', () => {
  nativeSwiftHarnessTest('actual Swift enumerator handles first-mount populated, true-empty, failed refresh, and cancel paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beebeeb-file-provider-enumerator-'));
    const harness = join(dir, 'Harness.swift');
    const binary = join(dir, 'Harness');
    const outputPath = join(dir, 'output.log');
    writeFileSync(harness, swiftHarness);
    execFileSync('xcrun', [
      'swiftc',
      '-framework', 'FileProvider',
      '-framework', 'UniformTypeIdentifiers',
      ENUMERATOR,
      harness,
      '-o', binary,
    ], { stdio: 'pipe' });
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'enumerator-harness', binary, outputPath], { timeout: 30_000 });
    const output = readFileSync(outputPath, 'utf8');
    expect(output).toContain('swift-enumerator-harness: 11 pass');
  }, 15_000);

  test('an empty cached listing branches on typed refresh outcome before finishing', () => {
    const src = readFileSync(ENUMERATOR, 'utf8');
    const body = bracedBody(src, 'func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage)');

    const emptyCheck = body.indexOf('if rows.isEmpty');
    expect(emptyCheck).toBeGreaterThanOrEqual(0);

    const refresh = body.indexOf('await refresher.refreshContainer(containerId: containerId)', emptyCheck);
    expect(refresh).toBeGreaterThan(emptyCheck);

    const switchOutcome = body.indexOf('switch outcome', refresh);
    expect(switchOutcome).toBeGreaterThan(refresh);

    const success = body.indexOf('case .success:', switchOutcome);
    const reread = body.indexOf('cache.children(parent: parent)', success);
    const finish = body.indexOf('observer.finishEnumerating(upTo: nil)', reread);
    expect(success).toBeGreaterThan(switchOutcome);
    expect(reread).toBeGreaterThan(success);
    expect(finish).toBeGreaterThan(reread);

    const failure = body.indexOf('case .notAuthenticated, .serverUnreachable:', switchOutcome);
    const finishError = body.indexOf('observer.finishEnumeratingWithError(outcome.fileProviderError)', failure);
    expect(failure).toBeGreaterThan(switchOutcome);
    expect(finishError).toBeGreaterThan(failure);
  });

  test('an anchored empty cached listing finishes immediately and refreshes in the background', () => {
    const src = readFileSync(ENUMERATOR, 'utf8');
    const body = bracedBody(src, 'func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage)');

    const anchorProbe = body.indexOf('cache.syncState(key: "container.\\(containerId).anchor")');
    expect(anchorProbe).toBeGreaterThanOrEqual(0);

    const knownEmpty = body.indexOf('if rows.isEmpty && hasCachedListing', anchorProbe);
    expect(knownEmpty).toBeGreaterThan(anchorProbe);

    const enumerateEmpty = body.indexOf('observer.didEnumerate([])', knownEmpty);
    const finishEmpty = body.indexOf('observer.finishEnumerating(upTo: nil)', enumerateEmpty);
    expect(enumerateEmpty).toBeGreaterThan(knownEmpty);
    expect(finishEmpty).toBeGreaterThan(enumerateEmpty);

    const backgroundRefresh = body.indexOf('Task.detached', finishEmpty);
    expect(backgroundRefresh).toBeGreaterThan(finishEmpty);
  });

  test('extension refresh maps auth and transport failures to File Provider outcomes', () => {
    const src = readFileSync(SYNC_ENGINE, 'utf8');
    expect(src).toContain('enum FileProviderRefreshOutcome');
    expect(src).toContain('case .notAuthenticated, .accountMismatch:');
    expect(src).toContain('return .notAuthenticated');
    expect(src).toContain('return .serverUnreachable');
    expect(src).not.toContain('NSFileProviderManager.default.signalEnumerator');
    expect(src).toContain('NSFileProviderManager(for: BeebeebConstants.fileProviderDomain)');
  });
});
