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
 * once, and the device log before the 08:41 jetsam kill shows 14 of them
 * deallocating together. Hooks cannot be conditional, so the player moved
 * into this component, which `PhotoPage` mounts only while a VIDEO page holds
 * a loaded `uri`: an image page owns 0 players, an inactive video page owns 0
 * (its `uri` is released when it stops being the active page), and the active
 * video page owns exactly 1.
 */
export function PhotoPageVideo({
  uri,
  style,
}: {
  uri: string;
  style: React.ComponentProps<typeof VideoView>['style'];
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
    />
  );
}
