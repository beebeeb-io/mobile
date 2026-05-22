# Photo Preview Smoothness Tactical Plan

Date: 2026-05-20
Owner: Codex
Status: Tactical fix verified

## Problem

Opening photos from the Photos tab can feel random and progressively slow. Real-account reproduction showed the preview path can load full originals, decrypt, cache, and prefetch around the selected item while the UI is still interactive. Swiping from an image to a video can also leave the preview pager path, which makes the flow feel broken.

## Tactical Fix Scope

1. Bound the Photos-to-Preview handoff so a tap passes a small media window around the selected item, not the full account photo list.
2. Keep the Preview media pager active for both images and videos so swiping across mixed media does not trap the user.
3. Remove duplicate image loading when the pager is active. The pager's `PhotoPage` path should own full-image loading for swipe mode.
4. Disable full-original neighbor prefetch for now. Thumbnails remain the first visual response; originals load on demand.
5. Keep thumbnail repair and backup logic untouched except where directly needed for preview smoothness.

## Verification

- `bunx tsc --noEmit` passed.
- Simulator smoke test passed on the logged-in account:
  - opened Photos tab
  - tapped `IMG_0406.HEIC`
  - confirmed preview opens as `1 of 13`, not the full account list
  - swiped to `IMG_0379.MP4` and `IMG_0365.MP4`; pager stayed active as `2 of 13` and `3 of 13`
  - swiped to `IMG_0337.JPG`; full image loaded as `4 of 13`
  - closed preview and confirmed tab navigation remains responsive

## Later Native Work

Move full-original download/decrypt/cache to native streaming file I/O. JS should not hold encrypted bytes, decrypted bytes, and base64 copies of large media in memory.
