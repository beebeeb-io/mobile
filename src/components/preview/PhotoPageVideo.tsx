import React from 'react';
import { useVideoPlayer, VideoView } from 'expo-video';

/**
 * Task 1669 Issue 1 — the ONE place a swipe-pager page owns a native
 * `AVPlayer`.
 *
 * `PhotoPage` used to call `useVideoPlayer(isVideoEntry && uri ? uri : null)`
 * unconditionally, on EVERY mounted page — image pages included. expo-video's
 * `useVideoPlayer(null)` still constructs a native player
 * (`new NativeVideoModule.VideoPlayer(null, ...)` → `AVPlayer()` in
 * `ios/VideoModule.swift`), so opening the pager with FlatList's default
 * `initialNumToRender` (10) plus its window created 10+ idle `AVPlayer`s at
 * once (per the task 1669 evidence transcription of the 08:41 device log, 14
 * AVPlayers were deallocated together just before the jetsam kill; that log is
 * not in any repo). Hooks cannot be conditional, so the player moved
 * into this component, which `PhotoPage` mounts only while a VIDEO page holds
 * a loaded `uri`: an image page owns 0 players, an inactive video page owns 0
 * (its `uri` is released when it stops being the active page), and the active
 * video page owns exactly 1.
 */
export function PhotoPageVideo({
  uri,
  style,
  onPictureInPictureStart,
  onPictureInPictureStop,
}: {
  uri: string;
  style: React.ComponentProps<typeof VideoView>['style'];
  /**
   * expo-video 57 `VideoView` events (VideoView.types.ts): fired when this
   * player enters / leaves Picture in Picture. The pager uses them to keep a
   * PiP player alive after its page stops being current (releasing it would
   * kill the PiP window) and to release it once PiP ends.
   */
  onPictureInPictureStart?: () => void;
  onPictureInPictureStop?: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={style}
      contentFit="contain"
      nativeControls
      fullscreenOptions={{ enable: true }}
      allowsPictureInPicture
      onPictureInPictureStart={onPictureInPictureStart}
      onPictureInPictureStop={onPictureInPictureStop}
    />
  );
}
