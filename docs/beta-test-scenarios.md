# Beebeeb iOS Beta Test Scenarios

Run these against the live API:

```sh
bunx expo start --dev-client --host localhost --clear
```

The checked-in simulator/dev-client default targets `https://api.beebeeb.io`. Confirm this in `Settings` -> `About` by checking `API environment` and the `API target` URL, or in runtime logs for `[Beebeeb] API environment: Production (https://api.beebeeb.io)`.

Only use local API mode when intentionally testing against a local server:

```sh
EXPO_PUBLIC_API_URL=http://localhost:3001 bunx expo start --dev-client --host localhost --clear
```

## Scenario 1 — Fresh Signup and European Positioning

**Goal:** verify a new beta user can create an account, understands the recovery warning, and sees Europe-focused positioning.

1. Open the app on a clean install.
2. Confirm sign-in footer says `Stored in Europe.`
3. Tap `Create account`.
4. Confirm signup footer says `Stored in Europe.` and `Operated by Beebeeb.io, Netherlands.`
5. Create a unique test user.
6. Acknowledge the recovery warning.
7. Verify the recovery phrase flow appears and can be completed.
8. Verify the app lands on the authenticated file area.

## Scenario 2 — Login With Existing Account

**Goal:** verify the existing-user login path works after app restart.

1. Force quit the app.
2. Relaunch the app.
3. Sign out if a session was restored.
4. Sign in with the test user from Scenario 1.
5. Verify the authenticated file area loads without a redbox or native crash.

## Scenario 3 — Encrypted File Round Trip

**Goal:** verify the core storage promise: upload, preview, download, delete.

1. Upload a small text file from the simulator.
2. Verify the file appears in `Files`.
3. Open preview and verify the plaintext renders client-side.
4. Download/share-save the file where available.
5. Delete the file, then verify it no longer appears in the active file list.

## Scenario 4 — Sharing

**Goal:** verify encrypted share creation and opening.

1. Upload a small file.
2. Open the share sheet for the file.
3. Create a share link.
4. Open the share link in the mobile app or Safari.
5. Verify the shared file can be opened/downloaded.
6. Revoke the share where available and verify it stops working.

## Scenario 5 — Photos and Permissions

**Goal:** verify the photo backup/camera permission surfaces do not crash.

1. Open `Photos`.
2. Trigger photo-library permission.
3. Confirm denial and acceptance states behave cleanly.
4. Start a small backup/import where simulator media is available.

## Scenario 6 — Settings, Region, Privacy, and Storage

**Goal:** verify beta-critical account screens and Europe/GDPR surfaces.

1. Open `Settings`.
2. Verify account email and storage usage render.
3. Open privacy/GDPR tools.
4. Open storage/region surfaces and verify Europe, Falkenstein, Helsinki, and Ede copy where present.
5. Toggle notification settings and verify no crash.

## Known External Caveat

Push delivery uses Expo Push Service. The app should not crash when notification permissions are requested; end-to-end delivery still requires a real development/TestFlight device with push credentials available through EAS.
