# beebeeb-io/mobile

Beebeeb for iOS and Android. React Native + Expo.

## Stack

React Native + Expo (managed workflow) + TypeScript. Package manager: **bun**.

## API

Backend at `http://localhost:3001`. Same endpoints as the web client — see `repos/server/CLAUDE.md` for the full API reference.

## Design references

- `../../design/hifi/hifi-ios-app.jsx` — iOS screens (Home, Photos, Preview, Share, Settings, Biometric, Camera backup)
- `../../design/hifi/hifi-android-app.jsx` — Android screens
- `../../design/hifi/hifi-mobile-extra.jsx` — Offline, upgrade, share extension, push notifications
- `../../design/hifi/hifi-mobile-sync.jsx` — Mobile sync features

## Screens

- Files (tab) — pinned folders, recent files
- Shared (tab) — shared with me
- Photos (tab) — date grid, auto-backup indicator
- Settings (tab) — security, backup, app config
- File preview — PDF/image with actions
- Share sheet — bottom sheet with link settings
- Biometric lock — Face ID / fingerprint

## Brand

Same design tokens as web but converted to RGB (OKLCH not supported in React Native). See `src/theme.ts` for the color mapping.

## Crypto

Will consume `beebeeb-core` via UniFFI-generated Swift/Kotlin bindings. Crypto runs at native speed, not in JS.


## Keep shared docs in sync

When you add/change/remove endpoints, types, build commands, or dependencies: update the relevant skill file in `/home/guus/code/beebeeb.io/.claude/skills/` (beebeeb-api.md, beebeeb-designs.md, beebeeb-stack.md, beebeeb-dev.md). Other agents depend on these being accurate.
