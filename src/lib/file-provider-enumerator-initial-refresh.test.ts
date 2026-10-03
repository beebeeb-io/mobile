// @ts-nocheck — bun runs this; guards native File Provider behavior.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ENUMERATOR = join(ROOT, 'targets', 'file-provider', 'FileProviderEnumerator.swift');
const SYNC_ENGINE = join(ROOT, 'targets', 'file-provider', 'SyncEngine.swift');

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

  init(rowsByParent: [String: [CachedItem]] = [:]) {
    self.rowsByParent = rowsByParent
  }

  func setRows(_ rows: [CachedItem], parent: String?) {
    lock.lock(); defer { lock.unlock() }
    rowsByParent[parent ?? "root"] = rows
  }

  func children(parent: String?) -> [CachedItem] {
    lock.lock(); defer { lock.unlock() }
    return rowsByParent[parent ?? "root"] ?? []
  }

  func syncState(key: String) -> String? { nil }
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
    await failedInitialRefreshReportsAuthError()
    await failedInitialRefreshReportsServerError()
    await cancellationDoesNotCompleteInvalidatedObserver()
    print("swift-enumerator-harness: 5 pass")
  }

  static func makeEnumerator(cache: MockCache, refresher: MockRefresher) -> FileProviderEnumerator {
    FileProviderEnumerator(containerIdentifier: .rootContainer, cache: cache, refresher: refresher)
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
  test('actual Swift enumerator handles first-mount populated, true-empty, failed refresh, and cancel paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beebeeb-file-provider-enumerator-'));
    const harness = join(dir, 'Harness.swift');
    const binary = join(dir, 'Harness');
    writeFileSync(harness, swiftHarness);
    execFileSync('xcrun', [
      'swiftc',
      '-framework', 'FileProvider',
      '-framework', 'UniformTypeIdentifiers',
      ENUMERATOR,
      harness,
      '-o', binary,
    ], { stdio: 'pipe' });
    const output = execFileSync(binary, [], { encoding: 'utf8' });
    expect(output).toContain('swift-enumerator-harness: 5 pass');
  });

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
