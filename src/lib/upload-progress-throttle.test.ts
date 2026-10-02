// @ts-nocheck
// Task 1685 fix 5 — RED-first tests for the upload progress throttle.
//
// FilesScreen called setUpload() on EVERY progress event (native poll ≈150 ms,
// JS loop per chunk), re-rendering the 5,400-line screen + its FlatList on
// every tick. The throttle must cap surfaced samples at ≈4 Hz while never
// swallowing a stage transition (preparing → uploading → finalizing).
import { describe, expect, test } from 'bun:test';
import { UPLOAD_PROGRESS_MIN_INTERVAL_MS, createProgressThrottle } from './upload-progress-throttle';

function sample(phase: string, bytesUploaded = 0) {
  return { phase, bytesUploaded, bytesTotal: 1000 };
}

describe('createProgressThrottle', () => {
  test('UPLOAD_PROGRESS_MIN_INTERVAL_MS targets ≈4 Hz', () => {
    expect(UPLOAD_PROGRESS_MIN_INTERVAL_MS).toBe(250);
  });

  test('always allows the first sample (immediate feedback)', () => {
    const throttle = createProgressThrottle(250, () => 0);
    expect(throttle.allow(sample('uploading'))).toBe(true);
  });

  test('blocks same-phase samples inside the interval, allows after it elapses', () => {
    let t = 0;
    const throttle = createProgressThrottle(250, () => t);
    expect(throttle.allow(sample('uploading'))).toBe(true); // t=0 emitted
    t = 100;
    expect(throttle.allow(sample('uploading'))).toBe(false); // inside window
    t = 249;
    expect(throttle.allow(sample('uploading'))).toBe(false);
    t = 250;
    expect(throttle.allow(sample('uploading'))).toBe(true); // window elapsed
  });

  test('never swallows a stage transition, even inside the interval', () => {
    let t = 0;
    const throttle = createProgressThrottle(250, () => t);
    expect(throttle.allow(sample('preparing'))).toBe(true);
    t = 5;
    expect(throttle.allow(sample('uploading'))).toBe(true); // preparing→uploading
    t = 10;
    expect(throttle.allow(sample('uploading'))).toBe(false);
    t = 15;
    expect(throttle.allow(sample('finalizing'))).toBe(true); // uploading→finalizing
  });

  test('caps surfaced samples at ≈4 Hz over a long burst', () => {
    let t = 0;
    const throttle = createProgressThrottle(250, () => t);
    // Native poll cadence: one sample every 60 ms for 30 s → 500 samples.
    let allowed = 0;
    for (let i = 0; i < 500; i++) {
      if (throttle.allow(sample('uploading', i))) allowed += 1;
      t += 60;
    }
    // 30_000 / 250 = 120 windows upper bound; with 60 ms cadence the window
    // is actually reached every 5th sample → exactly 100. The cap is the
    // load-bearing assertion; the floor just proves throttling didn't stall.
    expect(allowed).toBeLessThanOrEqual(121);
    expect(allowed).toBeGreaterThanOrEqual(99);
  });
});