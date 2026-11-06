// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 2335 — the in-app video format gate. A CLI-pushed 17.48 GB `.mkv` was
 * handed to AVPlayer on iOS, which has no Matroska demuxer, and the preview
 * showed nothing. The gate keeps such a file away from the player on iOS and
 * names the format instead; Android (ExoPlayer) is unchanged.
 *
 * The refused list is the measured one (AVFoundation on macOS 26.6.2, the
 * research lane's `mimes.out`): 3 of the 13 streamable extensions are refused.
 */
import { describe, expect, test } from 'bun:test';
import { STREAMABLE_VIDEO_EXTENSIONS } from './video-stream';
import {
  IOS_UNPLAYABLE_VIDEO_EXTENSIONS,
  inAppVideoPlayability,
  unplayableVideoActionHint,
  unplayableVideoMessage,
  videoPlayerErrorMessage,
} from './video-playability';

describe('2335 inAppVideoPlayability — iOS refuses the containers AVFoundation cannot open', () => {
  test('mkv, webm and wmv are refused on iOS by MIME type', () => {
    expect(inAppVideoPlayability('ios', 'video/x-matroska', 'movie')).toEqual({ playable: false, formatLabel: 'MKV' });
    expect(inAppVideoPlayability('ios', 'video/webm', 'clip')).toEqual({ playable: false, formatLabel: 'WebM' });
    expect(inAppVideoPlayability('ios', 'video/x-ms-wmv', 'old')).toEqual({ playable: false, formatLabel: 'WMV' });
  });

  test('the file name decides when the MIME type does not (case-insensitive)', () => {
    expect(inAppVideoPlayability('ios', 'video/mp4', 'Holiday.MKV')).toEqual({ playable: false, formatLabel: 'MKV' });
    expect(inAppVideoPlayability('ios', null, 'talk.webm')).toEqual({ playable: false, formatLabel: 'WebM' });
    expect(inAppVideoPlayability('ios', undefined, 'a.b.wmv')).toEqual({ playable: false, formatLabel: 'WMV' });
  });

  test('MIME parameters and case do not hide a refused container', () => {
    expect(inAppVideoPlayability('ios', 'Video/WebM; codecs="vp9, opus"', null).playable).toBe(false);
    // RFC 9559 registered the same container as video/matroska.
    expect(inAppVideoPlayability('ios', 'video/matroska', null).playable).toBe(false);
  });

  test('the 10 containers AVFoundation accepted stay playable on iOS', () => {
    const accepted = [
      ['mp4', 'video/mp4'], ['m4v', 'video/x-m4v'], ['mov', 'video/quicktime'], ['3gp', 'video/3gpp'],
      ['3g2', 'video/3gpp2'], ['avi', 'video/x-msvideo'], ['mpg', 'video/mpeg'], ['mpeg', 'video/mpeg'],
      ['ts', 'video/mp2t'], ['m2ts', 'video/mp2t'],
    ];
    for (const [ext, mime] of accepted) {
      expect(inAppVideoPlayability('ios', mime, `clip.${ext}`)).toEqual({ playable: true });
    }
    expect(accepted.length).toBe(10);
  });

  test('exactly 3 of the 13 streamable extensions are refused on iOS (the measured list)', () => {
    const refused = [...STREAMABLE_VIDEO_EXTENSIONS].filter(
      (ext) => !inAppVideoPlayability('ios', null, `x.${ext}`).playable,
    );
    expect(STREAMABLE_VIDEO_EXTENSIONS.size).toBe(13);
    expect(refused.sort()).toEqual(['mkv', 'webm', 'wmv']);
    expect([...IOS_UNPLAYABLE_VIDEO_EXTENSIONS].sort()).toEqual(['mkv', 'webm', 'wmv']);
  });

  test('Android keeps every container (ExoPlayer plays them; behaviour unchanged)', () => {
    for (const ext of STREAMABLE_VIDEO_EXTENSIONS) {
      expect(inAppVideoPlayability('android', null, `x.${ext}`)).toEqual({ playable: true });
    }
    expect(inAppVideoPlayability('android', 'video/x-matroska', 'movie.mkv')).toEqual({ playable: true });
  });

  test('a file with no name and no MIME type is not refused (nothing to judge)', () => {
    expect(inAppVideoPlayability('ios', null, null)).toEqual({ playable: true });
    expect(inAppVideoPlayability('ios', '', '')).toEqual({ playable: true });
  });
});

describe('2335 the honest copy', () => {
  test('the unsupported-format state names the device and the format', () => {
    expect(unplayableVideoMessage('iPhone')).toBe("This format can't play on iPhone.");
    expect(unplayableVideoActionHint('MKV')).toBe('Save it to Files to open it in an app that plays MKV.');
  });

  test('a player error is never silent: it says the player stopped, with the reason when there is one', () => {
    expect(videoPlayerErrorMessage({ message: 'Cannot Open' })).toBe("The video player couldn't open this file (Cannot Open).");
    // expo-video 57 on iOS wraps AVFoundation's reason (VideoExceptions.swift).
    expect(videoPlayerErrorMessage({ message: 'Failed to load the player item: Cannot Open' }))
      .toBe("The video player couldn't open this file (Cannot Open).");
    expect(videoPlayerErrorMessage({ message: 'Failed to initialise the player: The operation could not be completed' }))
      .toBe("The video player couldn't open this file (The operation could not be completed).");
    expect(videoPlayerErrorMessage({ message: '  ' })).toBe("The video player couldn't open this file.");
    expect(videoPlayerErrorMessage(undefined)).toBe("The video player couldn't open this file.");
    expect(videoPlayerErrorMessage(null)).toBe("The video player couldn't open this file.");
  });
});
