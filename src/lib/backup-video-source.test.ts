// @ts-nocheck -- native helper only; no app/device or PhotoKit library access.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const nativeTest = process.platform === 'darwin' ? test : test.skip;

nativeTest('composition exports are bounded file sources, clean failures/cancel, and preserve original files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-video-source-'));
  writeFileSync(join(dir, 'Driver.swift'), String.raw`
import AVFoundation
import Foundation

enum PlaintextStorageProtection { static func protect(_ url: URL) -> Bool { true } }
@main struct Driver {
  static func main() async throws {
    let directory = URL(fileURLWithPath: CommandLine.arguments[1])
    let original = directory.appendingPathComponent("original.mov")
    // A readable original is streamed without opening/decoding its full bytes.
    try Data(repeating: 7, count: 1024).write(to: original)
    let direct = try await BackupVideoFileSource.resolve(asset: AVURLAsset(url: original), audioMix: nil, exportDirectory: directory)
    guard direct.url == original, direct.sizeBytes == 1024, !direct.ownsFile else { fatalError("original path changed") }
    direct.cleanup()
    guard FileManager.default.fileExists(atPath: original.path) else { fatalError("original deleted") }
    // Empty composition cannot export: it must attempt the disk path and clean
    // its owned destination, rather than returning nil for a Data fallback.
    do {
      _ = try await BackupVideoFileSource.resolve(asset: AVMutableComposition(), audioMix: nil, exportDirectory: directory)
      fatalError("invalid composition accepted")
    } catch {
      guard (error as NSError).domain != "BackupVideoFileSource" else { fatalError("composition still rejected before export") }
    }
    let cancelled = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await BackupVideoFileSource.resolve(asset: AVMutableComposition(), audioMix: nil, exportDirectory: directory)
    }
    do { _ = try await cancelled.value; fatalError("cancel accepted") } catch is CancellationError {} catch { fatalError("lost cancellation") }
    let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix("backup-video-") }
    guard remaining.isEmpty else { fatalError("orphaned export") }
    let ownedURL = directory.appendingPathComponent("owned.mov")
    try Data([1]).write(to: ownedURL)
    let owned = BackupVideoFileSource(asset: AVURLAsset(url: ownedURL), url: ownedURL, uti: "com.apple.quicktime-movie", sizeBytes: 1, ownsFile: true)
    owned.cleanup()
    guard !FileManager.default.fileExists(atPath: ownedURL.path) else { fatalError("owned file retained") }
    print("video source: 6 assertions passed, 0 failed")
  }
}
`);
  execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), join(import.meta.dir, '../../modules/beebeeb-crypto/ios/BackupVideoFileSource.swift'), join(dir, 'Driver.swift'), '-o', join(dir, 'video')], { timeout: 60000 });
  expect(execFileSync(join(dir, 'video'), [dir], {encoding: 'utf8', timeout: 15000})).toContain('video source: 6 assertions passed, 0 failed');
}, 90000);

// Native recovery uses the same source file compiled by the app.
nativeTest('backup startup sweeps abandoned exports while preserving active exports and originals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-video-recovery-'));
  writeFileSync(join(dir, 'Driver.swift'), String.raw`
import AVFoundation
import Foundation
enum PlaintextStorageProtection { static func protect(_ url: URL) -> Bool { true } }
@main struct Driver {
  static func main() throws {
    let directory = URL(fileURLWithPath: CommandLine.arguments[1])
    let stale = directory.appendingPathComponent("backup-video-abandoned.mov")
    let unrelated = directory.appendingPathComponent("original.mov")
    let lookalike = directory.appendingPathComponent("backup-video-not-a-movie.txt")
    let subdirectory = directory.appendingPathComponent("backup-video-directory.mov")
    for url in [stale, unrelated, lookalike] { try Data([1]).write(to: url) }
    try FileManager.default.createDirectory(at: subdirectory, withIntermediateDirectories: true)
    let active = BackupVideoFileSource.reserveExportURL(in: directory, fileExtension: "mov")
    try Data([2]).write(to: active)
    BackupVideoFileSource.sweepAbandonedExports(in: directory)
    guard !FileManager.default.fileExists(atPath: stale.path) else { fatalError("abandoned export retained") }
    guard FileManager.default.fileExists(atPath: active.path) else { fatalError("active export deleted") }
    guard FileManager.default.fileExists(atPath: unrelated.path) else { fatalError("original deleted") }
    guard FileManager.default.fileExists(atPath: lookalike.path) else { fatalError("unrelated file deleted") }
    guard FileManager.default.fileExists(atPath: subdirectory.path) else { fatalError("directory deleted") }
    let source = BackupVideoFileSource(asset: AVURLAsset(url: active), url: active, uti: "com.apple.quicktime-movie", sizeBytes: 1, ownsFile: true)
    source.cleanup()
    guard !FileManager.default.fileExists(atPath: active.path) else { fatalError("active cleanup failed") }
    // The reservation also protects a destination before export creates it.
    let exporting = BackupVideoFileSource.reserveExportURL(in: directory, fileExtension: "mp4")
    BackupVideoFileSource.sweepAbandonedExports(in: directory)
    try Data([3]).write(to: exporting)
    BackupVideoFileSource.sweepAbandonedExports(in: directory)
    guard FileManager.default.fileExists(atPath: exporting.path) else { fatalError("in-progress export deleted") }
    BackupVideoFileSource(asset: AVURLAsset(url: exporting), url: exporting, uti: "public.mpeg-4", sizeBytes: 1, ownsFile: true).cleanup()
    print("video recovery: 7 assertions passed, 0 failed")
  }
}
`);
  execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), join(import.meta.dir, '../../modules/beebeeb-crypto/ios/BackupVideoFileSource.swift'), join(dir, 'Driver.swift'), '-o', join(dir, 'recovery')], {timeout: 60000});
  expect(execFileSync(join(dir, 'recovery'), [dir], {encoding: 'utf8', timeout: 15000})).toContain('video recovery: 7 assertions passed, 0 failed');
  const engine = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/ios/NativeBackupEngine.swift'), 'utf8');
  const batch = engine.slice(engine.indexOf('func processBatch('));
  expect(batch.indexOf('BackupVideoFileSource.sweepAbandonedExports')).toBeGreaterThan(batch.indexOf('defer { finishBatchProcessing() }'));
  expect(batch.indexOf('BackupVideoFileSource.sweepAbandonedExports')).toBeLessThan(batch.indexOf('ensureManifestReadyForUploads'));
}, 90000);
