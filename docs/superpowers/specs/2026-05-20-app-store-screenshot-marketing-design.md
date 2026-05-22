# App Store Screenshot Marketing Design

Date: 2026-05-20
Status: Corrected direction after visual rejection
Owner: Codex

## Goal

Create App Store Connect-ready Beebeeb iOS screenshots that look modern, centered, and intentionally designed. The output must use an official Apple Product Bezel-derived iPhone 17 Pro Max frame and real simulator captures from the current Beebeeb iOS app, seeded with intentional demo data.

## Output

- iPhone 6.9-inch: six PNGs at `1320 x 2868`.
- iPhone 6.7-inch: six PNGs at `1290 x 2796`.
- iPhone 5.5-inch: six PNGs at `1242 x 2208`.
- iPad 13-inch: six PNGs at `2064 x 2752`.
- Editable SVGs for every PNG.
- Destination: `marketing/app-store/`.

## Visual Requirements

- Use the existing SVG generator: `scripts/generate-app-store-screenshots.mjs`.
- Use real app screenshots captured under `screenshots/app-store-raw-real-2026-05-20/` for phone screen content. Slides 2 and 4 must use captured app states for sharing and encryption/proof rather than synthetic UI.
- Keep the official iPhone 17 Pro Max shell, dynamic island, screen clipping, and centered composition.
- Keep the iPad set in a 13-inch iPad-style shell with an iPad status bar. Do not show the iPhone Dynamic Island inside the iPad frame.
- Keep slide copy large, aligned, and readable at App Store thumbnail size.
- Use the official Beebeeb logo and icon assets from `marketing/assets/brand/`, not a hand-drawn replacement mark.
- Use Beebeeb dark mobile surfaces, amber active state, compact tab bar, and current app grid/list density as captured from the app.
- Use local stock/AI-style photo assets in `marketing/assets/stock/` only as simulator seed media, then capture the real app rendering.
- Use the local Apple Product Bezel-derived frame asset in `marketing/assets/apple-bezels/`; it is subject to Apple's design-resource license and is for iOS UI mockups only.
- Do not use geometric placeholder images or hand-drawn fake phone frames.

## Slide Set

1. `Your files, encrypted.` — Drive list and encrypted storage.
2. `Share without compromising.` — encrypted share link controls.
3. `Back up your memories.` — camera roll backup with stock/AI-style thumbnails.
4. `Decrypted on your device.` — zero-knowledge proof/glassbox preview.
5. `Know before you upload.` — built-in diagnostics with route, transfer, and local encryption speed.
6. `Made in Europe.` — European storage and operator trust closer.

## Sanitization

Use intentional demo data only. Do not show real personal emails, UUID filenames, personal photos, or live user data. Demo filenames and the `demo+ios@beebeeb.io` test account are acceptable when captured from the seeded simulator account. Stock/AI-style images are acceptable only after they are imported into the simulator and rendered by the real app.

## Acceptance Criteria

- `node scripts/generate-app-store-screenshots.mjs` completes successfully from `repos/mobile`.
- Twenty-four PNGs are generated: six for `iphone-6.9`, six for `iphone-6.7`, six for `iphone-5.5`, six for `ipad-13`.
- PNG dimensions match App Store requirements.
- A contact sheet shows centered, realistic iPhone mockups with photographic image thumbnails.
- The old ugly Pillow-generated screenshots are not the regeneration path.
