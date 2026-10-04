// @ts-nocheck
// Regression guard for Guus's iOS report: the native video playhead was drawn
// behind Preview's floating bottom menu. The source-level shape is what we can
// verify in Bun: every native VideoView must receive a bottom inset that keeps
// expo-video's controls above Beebeeb's own chrome.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');
const photoPageVideoSource = readFileSync(
  join(import.meta.dir, '../components/preview/PhotoPageVideo.tsx'),
  'utf-8',
);

function styleObjectBody(styleName: string): string {
  const re = new RegExp(`\\n  ${styleName}\\s*:\\s*\\{([^}]*)\\}`, 's');
  const m = source.match(re);
  if (!m) throw new Error(`style "${styleName}" not found in source`);
  return m[1];
}

describe('Preview video controls', () => {
  test('the video control inset is derived from the same safe-area floor as the bottom chrome', () => {
    expect(source).toContain('const previewVideoControlsBottomInset = useMemo(');
    expect(source).toContain('Math.max(insets.bottom, 16) + PREVIEW_VIDEO_CONTROLS_BOTTOM_CLEARANCE');
    expect(source).toMatch(/PREVIEW_VIDEO_CONTROLS_BOTTOM_CLEARANCE\s*=\s*84/);
  });

  test('all single-file VideoView paths use the inset video style, not the full-height styles directly', () => {
    expect(source).not.toContain('style={styles.mediaVideo}');
    expect(source).not.toContain('style={styles.video}');
    expect((source.match(/style=\{\[styles\.videoControlsSurface, videoControlsBottomStyle\]\}/g) ?? []).length).toBe(2);
  });

  test('pager video pages receive and apply the same bottom inset', () => {
    expect(source).toContain('videoControlsBottomInset={previewVideoControlsBottomInset}');
    expect(source).toContain('videoControlsBottomInset: number;');
    expect(source).toContain('style={[styles.videoControlsSurface, { bottom: videoControlsBottomInset }]}');
    expect(photoPageVideoSource).toContain('StyleProp<ViewStyle>');
  });

  test('the video stage keeps the full black ground while the VideoView itself is shortened', () => {
    const stage = styleObjectBody('mediaVideoStageWrap');
    const surface = styleObjectBody('videoControlsSurface');
    expect(stage).toMatch(/height:\s*'100%'/);
    expect(stage).toMatch(/backgroundColor:\s*'#000000'/);
    expect(surface).toMatch(/position:\s*'absolute'/);
    expect(surface).toMatch(/bottom:\s*0/);
  });
});
