# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-02

## [Unreleased]

### Added
- Nothing yet.

### Changed
- Nothing yet.

### Fixed
- The app stays cool when left open: background sync and backup checks pause while the app is locked or in the background, and reconnect attempts back off instead of hammering the network.
- Uploads are sturdier: only one upload loop runs at a time (a second pick is queued behind the running one with an honest notice), progress updates are throttled, thumbnails load through a bounded queue, and Resume is offered only when a resume can actually run.
- New uploads stay visible in Files while they run; previews close properly with a tap or swipe-down even right after a fresh upload.
- Photo library permission is re-asked cleanly after a denial instead of looping.
- Fixed a header fade glitch in light mode.
- Sharing always produces one complete link now — the decryption key is embedded in the link. The old split presentation is gone.
- Sign-in failures show plain, honest messages instead of raw technical error text.
- After an email password reset, your vault re-arms automatically on devices that already hold it. On a fresh device you land on a clear "Vault locked" screen and unlock with your 12-word phrase.

### Removed
- Nothing yet.

### Security
- Nothing yet.

## [1.0.0] - 2026-05-13

### Added
- Automatic photo and video backup with background upload
- Biometric unlock (Face ID / Touch ID / fingerprint)
- File browser with folder navigation and search
- Share extension for uploading from other apps
- Home screen widgets for storage usage and recent files
- Push notifications for share invites and storage alerts

### Changed
- Nothing yet.

### Fixed
- Nothing yet.

### Removed
- Nothing yet.

### Security
- Encryption keys stored in device keychain with biometric access policy
- Locally bundled fonts (no external CDN requests)
