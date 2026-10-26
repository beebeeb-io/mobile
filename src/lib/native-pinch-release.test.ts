// @ts-nocheck -- execute native gesture control flow with UIKit boundary stubs.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const nativeTest = process.platform === 'darwin' ? test : test.skip;

nativeTest('native pinch freezes layout until one cross-dissolve on release; cancellation stays visible', () => {
  const source = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/ios/NativePhotosGridView.swift'), 'utf8');
  const extract = (marker: string) => {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    let p = source.indexOf('{', start), depth = 1;
    while (depth && ++p < source.length) { if (source[p] === '{') depth++; else if (source[p] === '}') depth--; }
    return source.slice(start, p + 1).replace('@objc ', '');
  };
  const methods = ['@objc private func handlePinch(', '  private func finishPinch(', '  private func cancelPinch(', '  private func columnsFor('].map(extract).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'bb-native-pinch-'));
  writeFileSync(join(dir, 'main.swift'), String.raw`
import Foundation
import CoreGraphics
enum GestureState { case began, changed, ended, cancelled, failed, possible }
final class UIPinchGestureRecognizer {
  var state = GestureState.began
  var scale: CGFloat = 1
  func location(in view: Any) -> CGPoint { CGPoint(x: 100, y: 200) }
}
final class Layer { var zPosition: CGFloat = 0 }
final class Grid { let layer = Layer() }
enum UIView {
  enum Option { case transitionCrossDissolve, allowUserInteraction, allowAnimatedContent }
  static var transitions = 0
  static func transition(with: Grid, duration: Double, options: [Option], animations: () -> Void, completion: ((Bool) -> Void)? = nil) {
    precondition(options.contains(.transitionCrossDissolve)); transitions += 1; animations(); completion?(true)
  }
}
func CACurrentMediaTime() -> Double { Date().timeIntervalSince1970 }
final class Fixture {
  let collectionView = Grid()
  let columns = [2,4,7,12]
  var currentColumns = 4
  var pinchStartColumns = 4, pinchTargetColumns = 4
  var pinchAnchor = CGPoint.zero
  var isPinchingGrid = false
  var visibleDispatchWorkItem: DispatchWorkItem?, preheatWorkItem: DispatchWorkItem?
  var pinchChangedCount = 0, pinchAppliedFrameCount = 0
  var pinchLayoutTotalMs: Double = 0, pinchLayoutMaxMs: Double = 0
  var relayouts: [Bool] = []
  func resetPinchMetrics() {}
  func emitPinchPerfEvent(result: String, columns: Int) {}
  func dispatchVisibleIds() {}
  func updatePhotoKitPreheat() {}
  func relayout(columns: Int, anchor: CGPoint, animated: Bool = false) { currentColumns = columns; relayouts.append(animated) }
${methods}
  func run() {
    let gesture = UIPinchGestureRecognizer()
    handlePinch(gesture)
    gesture.state = .changed
    for scale: CGFloat in [0.95,0.8,0.5] { gesture.scale = scale; handlePinch(gesture) }
    precondition(pinchAppliedFrameCount == 0 && relayouts.isEmpty && currentColumns == 4, "layout changed during active pinch")
    gesture.state = .ended; handlePinch(gesture)
    precondition(UIView.transitions == 1 && relayouts == [false], "release must cross-dissolve instead of moving tiles")
    precondition(currentColumns == 12 && !isPinchingGrid)
    gesture.state = .began; handlePinch(gesture)
    gesture.state = .changed; gesture.scale = 2.2; handlePinch(gesture)
    gesture.state = .cancelled; handlePinch(gesture)
    precondition(currentColumns == 12 && relayouts == [false], "cancel changed layout")
    precondition(!isPinchingGrid && collectionView.layer.zPosition == 0)
    print("native pinch: 5 assertions passed, 0 failed")
  }
}
Fixture().run()
`);
  execFileSync('swiftc', ['-module-cache-path',join(dir,'modules'),join(dir,'main.swift'),'-o',join(dir,'pinch')], {timeout:60000});
  expect(execFileSync(join(dir,'pinch'), [], {encoding:'utf8'})).toContain('5 assertions passed, 0 failed');
}, 90000);
