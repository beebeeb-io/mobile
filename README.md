<p align="center">
  <h3 align="center">Beebeeb Mobile</h3>
  <p align="center">Beebeeb for iOS and Android — your encrypted vault in your pocket.</p>
</p>

<p align="center">
  <a href="https://github.com/beebeeb-io/mobile/blob/main/LICENSE"><img src="https://img.shields.io/github/license/beebeeb-io/mobile" alt="License"></a>
  <a href="https://github.com/beebeeb-io/mobile/actions"><img src="https://img.shields.io/github/actions/workflow/status/beebeeb-io/mobile/ci.yml?branch=main" alt="CI"></a>
  <a href="https://github.com/beebeeb-io/mobile/graphs/contributors"><img src="https://img.shields.io/github/contributors/beebeeb-io/mobile" alt="Contributors"></a>
  <a href="https://github.com/beebeeb-io/mobile/stargazers"><img src="https://img.shields.io/github/stars/beebeeb-io/mobile" alt="Stars"></a>
  <a href="https://github.com/beebeeb-io/mobile/issues"><img src="https://img.shields.io/github/issues/beebeeb-io/mobile" alt="Issues"></a>
</p>

---

## What is Beebeeb?

Beebeeb is end-to-end encrypted cloud storage. Your files are encrypted before they leave your device and can only be decrypted by you. The server never sees your data, your keys, or your plaintext.

This is the **mobile app** — Beebeeb on iOS and Android. Browse, preview, and share your encrypted files from your phone.

> Crypto will run natively via UniFFI bindings (Swift on iOS, Kotlin on Android) — not in JavaScript.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native |
| Platform | Expo (managed workflow) |
| Language | TypeScript |
| Navigation | React Navigation 7 (bottom tabs + native stack) |
| Secure storage | expo-secure-store |
| Crypto (planned) | `beebeeb-core` via UniFFI (native speed) |
| Package manager | Bun |

## Platform support

| Platform | Minimum version |
|----------|----------------|
| iOS | 16+ |
| Android | 12+ |

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (latest)
- [Expo CLI](https://docs.expo.dev/get-started/installation/)
- iOS Simulator (macOS) or Android emulator, or a physical device with [Expo Go](https://expo.dev/go)
- The [Beebeeb API server](https://github.com/beebeeb-io/server) running at `http://localhost:3001`

### Clone, install, and run

```sh
git clone https://github.com/beebeeb-io/mobile.git
cd mobile
bun install
bunx expo start
```

From there, press `i` for iOS Simulator, `a` for Android emulator, or scan the QR code with Expo Go on your device.

### Platform-specific commands

```sh
bunx expo start --ios       # Start on iOS Simulator
bunx expo start --android   # Start on Android emulator
```

## Project structure

```
src/
  App.tsx                   # Root component, navigation setup
  api.ts                    # API client (same endpoints as web)
  theme.ts                  # Design tokens (RGB, converted from web's OKLCH)
  screens/
    FilesScreen.tsx         # Files tab — pinned folders, recent files
    SharedScreen.tsx        # Shared tab — files shared with you
    PhotosScreen.tsx        # Photos tab — date grid, auto-backup indicator
    SettingsScreen.tsx      # Settings tab — security, backup, app config
    PreviewScreen.tsx       # File preview — PDF, images, with actions
app.json                    # Expo configuration
assets/                     # App icons and splash screen
```

## Screens

- **Files** -- Pinned folders, recent files, folder navigation
- **Shared** -- Files and folders shared with you
- **Photos** -- Date-grouped photo grid with camera backup indicator
- **Settings** -- Security, backup configuration, app preferences
- **Preview** -- PDF and image preview with share/download actions
- **Share sheet** -- Bottom sheet for link sharing with permission controls
- **Biometric lock** -- Face ID / fingerprint authentication

## Contributing

Contributions are welcome. To get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Ensure pre-commit hooks pass
5. Open a pull request

Please read [SECURITY.md](SECURITY.md) before submitting security-related changes.

## Security

If you discover a security vulnerability, please report it responsibly. See [SECURITY.md](SECURITY.md) for details.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Copyright (C) 2025-2026 [Initlabs B.V.](https://initlabs.nl)

## Part of Beebeeb

| Repository | Description |
|-----------|-------------|
| [web](https://github.com/beebeeb-io/web) | Web client |
| [mobile](https://github.com/beebeeb-io/mobile) | iOS and Android app (you are here) |
| [server](https://github.com/beebeeb-io/server) | API server |
| [site](https://github.com/beebeeb-io/site) | Marketing website |

[beebeeb.io](https://beebeeb.io)
