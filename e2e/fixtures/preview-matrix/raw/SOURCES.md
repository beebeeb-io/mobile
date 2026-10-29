# RAW fixture sources (task 1565)

All RAW camera samples below come from **raw.pixls.us**, a community-run
repository of camera RAW files for testing RAW decoders. Every sample listed
here is filtered on the site's own `getrepository.php` metadata for a CC0
license grant (`https://creativecommons.org/publicdomain/zero/1.0/`) — each
contributor explicitly "declares full rights to this file and releases it
under CC0 into the public domain" at upload time (site's own upload form
copy, checked 2026-09-26). No file from any other host was used for RAW
samples, per task instructions.

Two samples are small enough (<5MB) to commit directly into this directory.
The other four are fetched on demand by `./fetch-raw.sh`, which verifies the
sha256 below before keeping the download (see that script for exact URLs).

| Ext | Committed? | Camera | Size | SHA-256 | Source URL |
|-----|------------|--------|------|---------|-------------|
| `.dng` | Yes (`sample.dng`) | Canon EOS 5D Mark III (Adobe DNG Converter output, Lossy JPEG compression, RGB, 3:2) | 2.37 MB | `b22f1e36331f679abb8b13e433b9bbde3988723adf10fee7aa0dda6381016a98` | https://raw.pixls.us/getfile.php/1033/nice/Adobe%20DNG%20Converter%20-%20Canon%20EOS%205D%20Mark%20III%20-%20Lossy%20JPEG%20compression%2C%20rgb%20(3:2).DNG |
| `.nef` | Yes (`sample.nef`) | Nikon D2H (12-bit compressed, Lossy type 1, 3:2) | 3.09 MB | `155edb938f884ea7372ce98d4ff5f965c3e413b43b95bc9923da6e92082cf914` | https://raw.pixls.us/getfile.php/5227/nice/Nikon%20-%20D2H%20-%2012bit%2012bit%20compressed%20(Lossy%20(type%201))%20(3:2).NEF |
| `.cr2` | No — via `fetch-raw.sh` | Canon EOS 40D (sRAW2/sRAW mode, 3:2) | 5.54 MB | `ba644e7dd2abe74eca260e67f0206ff113bf0f62e710f8130611e964d6be5bf1` | https://raw.pixls.us/getfile.php/2102/nice/Canon%20-%20EOS%2040D%20-%20sRAW2%20(sRAW)%20(3:2).CR2 |
| `.cr3` | No — via `fetch-raw.sh` | Canon EOS R6 (3:2) | 5.03 MB | `74abb0a113d075ad9887a058082f40dd2a938c4813a08474d82356f11a027778` | https://raw.pixls.us/getfile.php/4659/nice/Canon%20-%20EOS%20R6%20-%203:2.CR3 |
| `.arw` | No — via `fetch-raw.sh` | Sony ILCE-7S (14-bit compressed, 3:2) | 5.88 MB | `a35ebb2fbec929daa5beb20d1ce5c15a8aac7b1a7a231455387f3df8a7442e07` | https://raw.pixls.us/getfile.php/1582/nice/Sony%20-%20ILCE-7S%20-%2014bit%2014bit%20compressed%20(3:2).ARW |
| `.raf` | No — via `fetch-raw.sh` | Fujifilm FinePix S5000 (4:3) | 6.53 MB | `dabd5e74521a6980156be9fd4b88d0c37b0fe4d0e0e6f5c12db8cffff1b76297` | https://raw.pixls.us/getfile.php/2726/nice/Fujifilm%20-%20FinePix%20S5000%20-%204:3.RAF |

Each SHA-256 above was verified against the downloaded byte stream on
2026-09-26 (matches raw.pixls.us's own published checksum for that file in
`getrepository.php?set=all`) and cross-checked with `file(1)`:

```
sample.dng: TIFF image data, little-endian, ... manufacturer=Canon, model=Canon EOS 5D Mark III
sample.nef: TIFF image data, big-endian, ... manufacturer=NIKON CORPORATION, model=NIKON D2H
sample.cr2: Canon CR2 raw image data, version 2.0
sample.cr3: ISO Media (Canon CR3 container)
sample.arw: TIFF image data, little-endian, ... manufacturer=SONY, model=ILCE-7S
sample.raf: Fujifilm RAF raw image data, format version 0201, camera FinePix S5000
```

## No Apple ProRAW sample

Apple ProRAW is a DNG variant produced by iPhone Camera; raw.pixls.us's
`Apple` maker bucket in the repository does not carry a ProRAW-tagged CC0
sample as of 2026-09-26, and generating a real one requires an iPhone
(12 Pro or later) taking an actual photo — not something this fixture set
can produce deterministically from this machine. `sample.dng` above stands
in for generic DNG handling; a genuine ProRAW file is a Phase B follow-up if
Guus wants one from his own device.

## Why raw.pixls.us and not another host

Per task instructions, RAW samples were sourced ONLY from raw.pixls.us — no
other host was used, and none was needed: raw.pixls.us covers every
requested brand (Canon, Sony, Nikon, Fujifilm) plus genuine DNG samples.
