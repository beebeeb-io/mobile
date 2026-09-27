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

import React, { useState } from 'react';
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

  const duration = status.duration > 0 ? status.duration : 0;
  const displayedTime = scrubSeconds ?? status.currentTime;
  const sliderMax = duration > 0 ? duration : 0.1;
  const isPlaying = status.playing;

  const togglePlayback = () => {
    if (isPlaying) {
      player.pause();
      return;
    }
    // Task 1568 (Codex P2 follow-up, PR #125 review): once a track reaches
    // the end, `status.playing` becomes false but `status.currentTime` stays
    // parked AT `duration` — this branch showed a Play button, but calling
    // `player.play()` from that end position does not rewind the underlying
    // native player, so pressing Play did nothing audible. See
    // `isTrackFinished`'s own doc comment (audio-format.ts, unit-tested) for
    // why this checks BOTH `didJustFinish` (edge-triggered) and
    // `currentTime >= duration` (level-triggered) rather than either alone.
    if (isTrackFinished(status.didJustFinish, status.currentTime, duration)) {
      void player.seekTo(0).then(() => player.play());
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
