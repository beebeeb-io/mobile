// @ts-nocheck
// Task 2335 — an iPhone video that can't play says so, instead of failing
// silently. Source-level contract (bun test here has no React reconciler;
// PreviewScreen cannot be rendered in a unit test — the convention of
// PreviewScreen.streaming-ui.test.ts). The pure rules (the format gate, the
// copy, the buffering text) are unit-tested in src/lib/video-playability.test.ts
// and src/lib/video-stream.test.ts; this file pins that the screen uses them.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const screen = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');
const pageVideo = readFileSync(join(import.meta.dir, '..', 'components', 'preview', 'PhotoPageVideo.tsx'), 'utf-8');
const nativeDecrypt = readFileSync(join(import.meta.dir, '..', 'lib', 'native-decrypt.ts'), 'utf-8');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('2335 fix 1 — a container the player cannot open never reaches it', () => {
  test('both video paths (single file and pager) ask the one format gate', () => {
    expect(count(screen, 'inAppVideoPlayability(Platform.OS, ')).toBe(2);
  });

  test('the single-file load effect returns before any fetch for an unplayable video', () => {
    expect(screen).toMatch(/if \(hasSwipe\) return;\n\s+if \(Platform\.OS === 'web'\) return;\n[\s\S]{0,300}if \(!videoPlayability\.playable\) return;\n[\s\S]{0,200}fetchAndDecrypt\(\{ signal: controller\.signal, onStreamProgress: setStreamBufferPct \}\)/);
  });

  test('the pager never loads the full video for an unplayable entry', () => {
    expect(screen).toMatch(/const loadFull = isVideoEntry \? shouldLoadFull && isCurrent && videoPlayability\.playable : shouldLoadFull;/);
  });

  test('one card shows the name, the honest line and Save to Files, on both paths', () => {
    expect(count(screen, 'function UnplayableVideoCard(')).toBe(1);
    expect(count(screen, '<UnplayableVideoCard')).toBe(2);
    expect(count(screen, 'testID="preview-video-unsupported"')).toBe(1);
    expect(count(screen, 'unplayableVideoMessage(deviceNoun())')).toBe(1);
    expect(count(screen, 'unplayableVideoActionHint(formatLabel)')).toBe(1);
    expect(count(screen, '>Save to Files</Text>')).toBe(1);
  });

  test('Save to Files is the existing Save path (share sheet with the real file name)', () => {
    // The single-file stage's card and the pager page's prop.
    expect(count(screen, 'onSaveToFiles={handleDownload}')).toBe(2);
  });

  test('Save to Files is disabled while a save runs, on both paths (one export at a time)', () => {
    expect(screen).toMatch(/onPress=\{onSaveToFiles\}\n\s+disabled=\{saving\}/);
    expect(screen).toContain('saving={downloading}');
    expect(screen).toContain('saveToFilesBusy={downloading}');
    expect(screen).toContain('saving={saveToFilesBusy}');
  });

  test('the export decrypts a whole file, never a stream the share sheet cannot take', () => {
    expect(screen).toContain('fetchAndDecrypt: () => fetchAndDecrypt({ signal, onExportProgress, streamVideo: false })');
    expect(screen).toMatch(/streamVideo: options\.streamVideo,/);
  });
});

describe('2335 fix 2 — a player error is never silent', () => {
  test('both players listen for statusChange', () => {
    expect(screen).toContain("player.addListener('statusChange'");
    expect(pageVideo).toContain("player.addListener('statusChange'");
  });

  test('readyToPlay is traced once per player, not after every rebuffer or seek', () => {
    expect(screen).toMatch(/let readyTraced = false;[\s\S]{0,300}if \(readyTraced\) return;\n\s+readyTraced = true;/);
    expect(pageVideo).toMatch(/let readyReported = false;[\s\S]{0,300}if \(readyReported\) return;\n\s+readyReported = true;/);
  });

  test('an error status is traced and shown with the honest message', () => {
    expect(count(screen, "recordRuntimeTrace('preview.video.player_status'")).toBe(2);
    expect(count(screen, 'videoPlayerErrorMessage(')).toBe(2);
  });

  test('a failed play shows "Couldn’t play video" with Try again (single file)', () => {
    expect(screen).toMatch(/videoPlayerError \? \(\s*renderLoadError\("Couldn't play video", videoPlayerError, 'media'\)/);
    expect(screen).toMatch(/const retryLoad = \(\) => \{[\s\S]{0,600}setVideoPlayerError\(null\);/);
  });

  test('a failed play in the pager has a Try again that reloads the page', () => {
    expect(screen).toContain('testID="preview-page-video-retry"');
    expect(screen).toMatch(/\[loadFull, uri, entry, isUnlocked, getFileKeyBytes, getMasterKeyHandleId, isVideoEntry, isRawEntry, previewProfile, locked, loadAttempt\]/);
  });

  test('a stopped player releases its stream, so the pump stops pulling the file', () => {
    expect(screen).toMatch(/status !== 'error'[\s\S]{0,900}isLoopbackStreamUri\(uri\)[\s\S]{0,300}releasePreviewCopy\(/);
    expect(screen).toMatch(/const handleVideoPlayerStatus = useCallback\([\s\S]{0,800}releasePreviewCopyLease\(\);/);
  });

  test('the stream traces are kept', () => {
    for (const line of [
      'preview.decrypt.stream.request',
      'preview.decrypt.stream.playable',
      'preview.decrypt.stream.failed_fallback',
    ]) {
      expect(nativeDecrypt).toContain(`'${line}'`);
    }
  });
});

describe('2335 fix 3 — buffering progress before the player starts', () => {
  test('the progress state carries the native buffering flag, per event', () => {
    expect(screen).toContain('buffering: event.buffering === true,');
  });

  test('the progress row shows bytes done of bytes needed while buffering', () => {
    expect(screen).toMatch(/const bufferingText = startupBufferingText\(progress\);\n\s+if \(bufferingText\) return bufferingText;/);
  });
});
