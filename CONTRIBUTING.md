# Contributing to Beebeeb Mobile

Thanks for your interest in contributing to the Beebeeb iOS and Android app.

## Prerequisites

- [Bun](https://bun.sh/) (package manager)
- Node.js 20+
- Git
- iOS: Xcode 16+, CocoaPods
- Android: Android Studio, JDK 17

## Development setup

```sh
git clone https://github.com/beebeeb-io/mobile.git
cd mobile
bun install
cd ios && pod install && cd ..
```

## Native build commands

Use the local Expo development builds for day-to-day verification:

```sh
bun run ios
bun run android
```

For release candidates, build locally so the work runs on the developer machine:

```sh
eas build --platform ios --profile production --local --output ./build/beebeeb.ipa
eas build --platform android --profile production --local --output ./build/beebeeb.aab
```

## Pre-commit hook

Install the secrets check hook before making commits:

```sh
cp check-secrets.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Code quality checks

Run before submitting a pull request:

```sh
bunx tsc --noEmit
```

## Pull request process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, ensuring the type check passes.
3. Test on at least one platform (iOS or Android) before submitting.
4. Open a pull request with a clear description of what and why.

## Contributor license

Beebeeb does not require a separate Contributor License Agreement at this time.
By opening a pull request, you confirm you have the right to submit the work and
agree that it is licensed under AGPL-3.0-or-later.

## Security

If you discover a security vulnerability, **do not open a public issue**. Email [security@beebeeb.io](mailto:security@beebeeb.io) instead.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later](LICENSE).
