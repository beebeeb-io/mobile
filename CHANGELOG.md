# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-10-24

### Changed
- Storage locations are shown by country, including the location selected for an upload. Unavailable locations have a clear refusal state.
- Sharing produces one complete encrypted link with its decryption key embedded.

### Fixed
- Fixed a startup crash caused by duplicate camera-roll manifest storage in recent TestFlight builds.
- Photo backup checks the server before uploading duplicates, keeps its history scoped to the account across sign-out, and updates the displayed count after backup is turned off and on.
- File changes catch up after a live connection closes or requests a resync; repeated file-index loads share one request.
- Busy uploads respect the server's retry delay.
- Background sync and backup checks pause while the app is locked or in the background, and reconnect attempts back off.
- Only one upload loop runs at a time, progress updates are throttled, thumbnails use a bounded queue, and Resume is offered only when a resume can run.
- New uploads stay visible in the file browser. Preview controls remain accessible, and closing a video preview cancels its background work.
- Photo library permission is requested cleanly after a denial.
- Fixed a header fade glitch in light mode.
- Sign-in failures show plain messages instead of raw technical errors.
- After an email password reset, devices that already hold the vault key re-arm automatically. A fresh device shows a clear "Vault locked" screen and asks for the 12-word recovery phrase.

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
