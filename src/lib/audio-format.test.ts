// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1568 — audio preview player. See audio-format.ts's own doc comment
// for why this mapping was extracted into a pure module: PreviewScreen.tsx
// cannot be imported in this project's test runner (no React reconciler).
// RED/GREEN mutation proof for this file is pasted in
// .claude/tasks/backlog/1568-mobile-audio-preview-player.md's Notes section.
import { describe, expect, test } from 'bun:test';
import { extensionForAudio, formatAudioRemaining, formatAudioTime } from './audio-format';

describe('extensionForAudio', () => {
  test('maps audio/mpeg to .mp3', () => {
    expect(extensionForAudio('audio/mpeg')).toBe('.mp3');
  });

  test('maps audio/mp4 (m4a container) to .m4a', () => {
    expect(extensionForAudio('audio/mp4')).toBe('.m4a');
  });

  test('maps audio/x-m4a to .m4a', () => {
    expect(extensionForAudio('audio/x-m4a')).toBe('.m4a');
  });

  test('maps audio/wav to .wav', () => {
    expect(extensionForAudio('audio/wav')).toBe('.wav');
  });

  test('maps audio/x-wav to .wav', () => {
    expect(extensionForAudio('audio/x-wav')).toBe('.wav');
  });

  test('maps audio/aac to .aac (not .m4a — different container)', () => {
    expect(extensionForAudio('audio/aac')).toBe('.aac');
  });

  test('maps audio/flac to .flac', () => {
    expect(extensionForAudio('audio/flac')).toBe('.flac');
  });

  test('mime match is case-insensitive', () => {
    expect(extensionForAudio('AUDIO/WAV')).toBe('.wav');
  });

  test('falls back to the filename\'s own extension when the mime is unrecognized', () => {
    expect(extensionForAudio('application/octet-stream', 'field-recording.flac')).toBe('.flac');
  });

  test('filename fallback is case-insensitive', () => {
    expect(extensionForAudio(null, 'Track.WAV')).toBe('.wav');
  });

  test('mime wins over a conflicting filename extension', () => {
    // Real-world case this guards: an .m4a uploaded from a source that
    // still reports the generic audio/mp4 container mime is fine (m4a IS
    // audio/mp4 wearing a friendlier extension) — but if mime and filename
    // actively disagree, the OS-reported mime is trusted first, same as
    // every other category in extensionForMime.
    expect(extensionForAudio('audio/wav', 'song.mp3')).toBe('.wav');
  });

  test('falls back to .mp3 when neither mime nor filename is recognized', () => {
    expect(extensionForAudio(null, null)).toBe('.mp3');
  });

  test('falls back to .mp3 for an unrecognized mime and no filename', () => {
    expect(extensionForAudio('application/octet-stream')).toBe('.mp3');
  });
});

describe('formatAudioTime', () => {
  test('formats sub-minute durations as 0:SS', () => {
    expect(formatAudioTime(7)).toBe('0:07');
  });

  test('formats minutes:seconds', () => {
    expect(formatAudioTime(185)).toBe('3:05');
  });

  test('floors fractional seconds rather than rounding up', () => {
    // 179.9s must read as 2:59, not 3:00 — rounding up would show the clock
    // hitting the next minute a full second before playback actually does.
    expect(formatAudioTime(179.9)).toBe('2:59');
  });

  test('formats past one hour as H:MM:SS', () => {
    expect(formatAudioTime(3725)).toBe('1:02:05');
  });

  test('treats NaN as 0:00 (duration not known yet)', () => {
    expect(formatAudioTime(NaN)).toBe('0:00');
  });

  test('treats a negative value as 0:00', () => {
    expect(formatAudioTime(-5)).toBe('0:00');
  });

  test('zero is 0:00', () => {
    expect(formatAudioTime(0)).toBe('0:00');
  });
});

describe('formatAudioRemaining', () => {
  test('counts down with a leading minus', () => {
    expect(formatAudioRemaining(60, 185)).toBe('-2:05');
  });

  test('reads -0:00 at the very end, not a negative countdown past it', () => {
    expect(formatAudioRemaining(185, 185)).toBe('-0:00');
  });

  test('clamps to -0:00 if currentTime overshoots duration by a frame', () => {
    expect(formatAudioRemaining(185.2, 185)).toBe('-0:00');
  });

  test('reads -0:00 when duration is not known yet (0)', () => {
    expect(formatAudioRemaining(0, 0)).toBe('-0:00');
  });

  test('reads -0:00 for a NaN duration', () => {
    expect(formatAudioRemaining(0, NaN)).toBe('-0:00');
  });
});
