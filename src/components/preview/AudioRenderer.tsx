/**
 * AudioRenderer — native audio player for Preview's audio branch (task 1568).
 *
 * mp3, m4a, wav, aac (+flac where the platform decodes it — iOS's
 * AVFoundation does; there is no format-specific branch here, so an
 * unsupported container surfaces via `status.error` as an honest "Couldn't
 * play this audio" card rather than a silent blank/spinner).
 *
 * Uses `expo-audio` (`useAudioPlayer`/`useAudioPlayerStatus`) — the app
 * already depends on its sibling `expo-video` for the video preview branch
 * (same SDK-57 generation of Expo's AV libraries, replacing the older,
 * deprecated `expo-av`); adding `expo-audio` alongside it keeps both media
 * branches on the same, current library family instead of mixing an old and
 * a new one. Playback-only: the config plugin
 * (`app.json` → `expo-audio`) explicitly disables the microphone permission
 * and background playback capability this app never uses — see that
 * plugin's own options in `app.json` for why.
 *
 * A calm, waveform-less design consistent with the rest of the preview
 * frame: a centered card (title, format/duration, play/pause, scrub bar),
 * no album art (none exists for an arbitrary encrypted file), no visualizer.
 * Amber is used ONLY to mark the "currently playing" state (brand rule: one
 * accent color, reserved for encryption state and primary actions) — the
 * play button is neutral (paper2/ink) at rest and turns amber while
 * `status.playing` is true; everything else (icon, borders, track) stays on
 * the theme's neutral ink/paper/line tokens.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { fonts } from '../../theme';
import type { Colors } from '../../theme';
import { formatAudioRemaining, formatAudioTime, isTrackFinished } from '../../lib/audio-format';

interface AudioRendererProps {
  /** On-disk decrypted file the player reads from (deleted by the caller on
   * unmount — see PreviewScreen.tsx's audio cleanup effect). */
  uri: string;
  fileName: string;
  /** Format chip, e.g. "MP3", "WAV" — derived by the caller from the same
   * extension resolution the decrypt step used, so the label always matches
   * what's actually on disk. */
  formatLabel: string;
  colors: Colors;
  topInset?: number;
  bottomInset?: number;
}

export function AudioRenderer({
  uri,
  fileName,
  formatLabel,
  colors: c,
  topInset = 0,
  bottomInset = 0,
}: AudioRendererProps) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  // While the user is actively dragging the thumb, show ITS position, not
  // the player's own currentTime (which would otherwise fight the drag —
  // the player keeps reporting its pre-seek position until the seek lands).
  // Cleared back to `null` (follow the player again) once the drag ends.
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null);
  // Set true the instant a finished-track replay calls `player.replace(uri)`;
  // cleared (and `player.play()` fired) the moment the fresh item's status
  // reports `isLoaded`. See the effect below and `togglePlayback`'s comment
  // for the on-device debugging that led here — a ref because it drives an
  // imperative one-shot action, not a value the render output depends on.
  const pendingReplayPlayRef = useRef(false);

  const duration = status.duration > 0 ? status.duration : 0;
  const displayedTime = scrubSeconds ?? status.currentTime;
  const sliderMax = duration > 0 ? duration : 0.1;
  const isPlaying = status.playing;

  // Fires `play()` for a pending post-replace replay once (and only once)
  // the FRESH item `replace()` swapped in actually reports ready — see
  // `togglePlayback`'s comment for why this can't be done synchronously.
  // Depends on the whole `status` OBJECT, not `status.isLoaded`: expo-audio
  // emits a new status object on every native `playbackStatusUpdate` event,
  // even when a given field's VALUE is unchanged (e.g. `isLoaded` may already
  // read `true`, stale from the item `replace()` just tore down), so a
  // value-only dependency could miss the transition entirely. Depending on
  // the object means this re-checks the freshly-computed `status.isLoaded`
  // (native `currentStatus()` always reflects the CURRENT item, never
  // cached) on every event until the right one lands.
  useEffect(() => {
    if (pendingReplayPlayRef.current && status.isLoaded) {
      pendingReplayPlayRef.current = false;
      player.play();
    }
  }, [status, player]);

  const togglePlayback = () => {
    if (isPlaying) {
      player.pause();
      return;
    }
    // Task 1568 (Codex P2 follow-up, PR #125 review): once a track reaches
    // the end, `status.playing` becomes false but `status.currentTime` stays
    // parked AT `duration`. See `isTrackFinished`'s own doc comment
    // (audio-format.ts, unit-tested) for why this checks BOTH
    // `didJustFinish` (edge-triggered) and `currentTime >= duration`
    // (level-triggered) rather than either alone.
    //
    // Three approaches were tried on-device (bb-ios27 sim) before this one;
    // all three were root-caused by reading expo-audio's native source
    // (`node_modules/expo-audio/ios/AudioPlayer.swift`), and all three
    // failed for DIFFERENT reasons, so the reasoning is kept in full:
    //
    // 1. `seekTo(0).then(() => player.play())` (2bcd188): flips
    //    `status.playing` true (Pause icon shows) but `status.currentTime`
    //    never advances. The underlying player is an `AVQueuePlayer`; once
    //    its one-and-only item has played to `AVPlayerItemDidPlayToEndTime`,
    //    a `seek(to: 0)` on that SAME item resolves its completion handler
    //    (the promise does resolve, even reporting `currentTime: 0`) but a
    //    subsequent `play()` on the queue player never re-arms playback — a
    //    documented AVQueuePlayer quirk once its item list has been fully
    //    consumed, not a bug in the seek/play call sequence itself.
    //
    // 2. `player.replace(uri)` then `player.play()`: `replace()` DOES tear
    //    the old item down and insert a brand-new `AVPlayerItem` (confirmed
    //    via `log stream` — a fresh `FigFilePlayer` item id is queued),
    //    which starts at position 0 — but that new item is not yet
    //    `.readyToPlay` the instant `replace()` returns, and `play()`'s
    //    native call (`ref.playImmediately(atRate:)`) requires the current
    //    item to already be ready. Called one tick too early, it silently
    //    no-ops: two screenshots after this sequence showed the Play icon
    //    and the pre-replace `0:03/-0:00` completely unchanged.
    //
    // 3. `player.play()` THEN `player.replace(uri)` (reversed order,
    //    intending to piggyback on `replaceCurrentSource`'s own
    //    `wasPlaying` → `onReady { play() }` auto-resume): UNRELIABLE, not
    //    fixed — confirmed by two DIFFERENT outcomes across repeated
    //    on-device runs. Sometimes `ref.timeControlStatus` really did read
    //    `.playing` at the moment `replace()` captured `wasPlaying`, and
    //    the track played a full, correct 3.03s (`log stream` showed a
    //    fresh item playing start-to-natural-end). Other times the capture
    //    read `.playing` as still false (this sim was under heavy
    //    concurrent-session load throughout — `uptime`'s 15-minute average
    //    hit 46 on a 12-core box — so exactly how far `playImmediately` on
    //    the dead-ended OLD item had progressed by the time `replace()` ran
    //    the very next native call was genuinely timing-dependent), so
    //    `replaceCurrentSource` took its plain (no auto-play) branch: the
    //    new item loaded at a correctly-reset `0:00/-0:03`, but sat there,
    //    Play icon showing, never starting on its own. A call sequence
    //    whose correctness depends on a race is not a fix.
    //
    // What's actually deterministic: `replace()` alone (no preceding
    // `play()` — don't touch the dead item at all), then explicitly call
    // `player.play()` OURSELVES once `status.isLoaded` confirms the fresh
    // item is ready, via the effect above. This is the exact same
    // Combine-publisher-driven wait (`ref.publisher(for:
    // \.currentItem?.status)`, filtering for `.readyToPlay`) that
    // `replaceCurrentSource`'s own internal `onReady` helper uses — the
    // difference is doing it explicitly from JS, which can't race a native
    // capture of `wasPlaying` because it isn't reading one.
    if (isTrackFinished(status.didJustFinish, status.currentTime, duration)) {
      pendingReplayPlayRef.current = true;
      player.replace(uri);
      return;
    }
    player.play();
  };

  return (
    <View
      style={[styles.container, { paddingTop: topInset, paddingBottom: bottomInset }]}
      testID="audio-renderer"
    >
      <View style={styles.card}>
        <View style={[styles.iconCircle, { backgroundColor: c.paper2 }]}>
          <Ionicons name="musical-notes" size={32} color={c.ink3} />
        </View>

        <Text style={[styles.title, { color: c.ink }]} numberOfLines={2} testID="audio-title">
          {fileName}
        </Text>
        <Text style={[styles.formatLine, styles.mono, { color: c.ink3 }]} testID="audio-duration">
          {duration > 0 ? `${formatLabel} · ${formatAudioTime(duration)}` : formatLabel}
        </Text>

        {status.error ? (
          <View style={styles.errorBlock}>
            <Ionicons name="alert-circle-outline" size={22} color={c.red} />
            <Text style={[styles.errorText, { color: c.ink3 }]}>
              Couldn't play this audio. {status.error}
            </Text>
          </View>
        ) : (
          <>
            <TouchableOpacity
              onPress={togglePlayback}
              disabled={!status.isLoaded}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
              testID="audio-play-pause"
              style={[
                styles.playButton,
                { backgroundColor: isPlaying ? c.amber : c.paper2 },
                !status.isLoaded && styles.playButtonDisabled,
              ]}
            >
              {status.isLoaded ? (
                <Ionicons
                  name={isPlaying ? 'pause' : 'play'}
                  size={28}
                  // Fixed literal, not a theme token: amber (`c.amber`) is
                  // the SAME hex value in both light and dark mode (see
                  // theme.ts), so the icon riding on top of it needs one
                  // fixed high-contrast color too, not the theme's own
                  // (theme-following) ink token — c.ink flips to a LIGHT
                  // color in dark mode, which would read poorly against the
                  // still-bright amber fill. When paused (neutral paper2
                  // background, which DOES follow the theme) the icon
                  // correctly uses the theme-aware c.ink instead.
                  color={isPlaying ? '#000000' : c.ink}
                />
              ) : (
                <Ionicons name="hourglass-outline" size={24} color={c.ink3} />
              )}
            </TouchableOpacity>

            <View style={styles.scrubBlock}>
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={sliderMax}
                value={Math.min(displayedTime, sliderMax)}
                onValueChange={(value) => setScrubSeconds(value)}
                onSlidingComplete={(value) => {
                  void player.seekTo(value);
                  setScrubSeconds(null);
                }}
                minimumTrackTintColor={c.amber}
                maximumTrackTintColor={c.line2}
                thumbTintColor={c.amber}
                disabled={!status.isLoaded || duration <= 0}
                accessibilityLabel="Playback position"
                testID="audio-scrub"
              />
              <View style={styles.timeRow}>
                <Text style={[styles.timeText, styles.mono, { color: c.ink3 }]} testID="audio-elapsed">
                  {formatAudioTime(displayedTime)}
                </Text>
                <Text style={[styles.timeText, styles.mono, { color: c.ink3 }]} testID="audio-remaining">
                  {formatAudioRemaining(displayedTime, duration)}
                </Text>
              </View>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const CARD_MAX_WIDTH = 360;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: CARD_MAX_WIDTH,
    alignItems: 'center',
    gap: 6,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  formatLine: {
    fontSize: 13,
    marginBottom: 20,
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  playButtonDisabled: {
    opacity: 0.6,
  },
  scrubBlock: {
    width: '100%',
  },
  slider: {
    width: '100%',
    height: 32,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  timeText: {
    fontSize: 12,
  },
  errorBlock: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    marginTop: 8,
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
  },
  mono: {
    fontFamily: fonts.mono,
  },
});
