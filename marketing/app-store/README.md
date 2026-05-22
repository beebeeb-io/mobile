# App Store screenshots

Generated marketing screenshots for task 0044.

Run:

```sh
node scripts/generate-app-store-screenshots.mjs
```

The generator writes both editable SVGs and App Store-ready PNGs for:

- `iphone-6.9`: 1320 x 2868
- `iphone-6.7`: 1290 x 2796
- `iphone-5.5`: 1242 x 2208
- `ipad-13`: 2064 x 2752

These are high-fidelity deterministic mockups built from real simulator screenshots in `screenshots/app-store-raw-real-2026-05-20/`, captured from the seeded `demo+ios@beebeeb.io` account. They do not claim App Store Connect, TestFlight tester groups, privacy questionnaire, or reviewer account setup is complete.

The iPhone 17 Pro Max shell is based on Apple's official Product Bezel design resource. The iPad set uses a deterministic SVG iPad-style shell sized for Apple's 13-inch iPad screenshot slot. Both are only used to depict Beebeeb's iOS interface in App Store screenshot mockups.
