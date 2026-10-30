# C: the largest chunk 0 any File Provider build could have written since 2026-05-01

`classifyOwnerContent` reads at most C bytes of `chunks/0`. C must cover every
first chunk a **shipped** build could have uploaded since the 2026-05-01
cutover, so a legitimate chunk 0 is never mistaken for "too large".

Source: `git log -p --since=2026-05-01 -- targets/file-provider/FileProviderExtension.swift`
(plus the File Provider plugin/`app.json` wiring, which decides whether a
target was actually in a build).

| Commit | Date | Live File Provider source | First-chunk size |
|---|---|---|---|
| `0eaf5cf2` | 2026-05-01 | `targets/file-provider/FileProviderExtension.swift` | whole file as ONE chunk (`chunks: [encryptedChunk]`) — **not shipped**: the File Provider plugin was not in `app.json`/`app.config.js` until `6e320942` (no `app.config.js` existed before `b8212749`; `b8212749`/`4960344e` only extend `app.json`, no provider plugin) |
| `751fb052` | 2026-05-01 | same `targets/` tree | whole file as ONE chunk — still not wired into a build |
| `6e320942` | 2026-05-19 | `plugins/file-provider/` (activated by `app.json`) | `kChunkSize = 4 * 1024 * 1024` (`plugins/file-provider/FileProviderCrypto.swift:17`), `encryptFile` chunked |
| `717636a1` | 2026-05-23 | `plugins/file-provider/` still live | 4 MiB; adds `uploadChunkSizeBytes = 1 MiB` to the (not yet live) `targets/` tree |
| `5c8f203f` | 2026-05-31 | `targets/` becomes the live source | 1 MiB (`uploadChunkSizeBytes` at `FileProviderExtension.swift:746`), used by `createItem`'s upload loop (`:776`) |
| `4f714735`, `e8140375`, `21eaf075`, HEAD | after 2026-05-31 | `targets/` | 1 MiB |

No build since 2026-05-01 uploaded a file as ONE frame of unbounded size: the
unbounded `targets/` code existed before any File Provider target was wired
into a build, and every shipped build writes 1 MiB or 4 MiB chunks.

Therefore the largest possible chunk 0 is **4 MiB** (the `plugins/` build from
2026-05-19 through 2026-05-31), and the cap adds the AEAD overhead
(`CHUNK_OVERHEAD = NONCE_LEN(12) + TAG_LEN(16) = 28`):

```
C = 4 * 1024 * 1024 + 28 = 4,194,332 bytes
```

C is pinned by the Swift harness (`classifyReadsAtMostCBytesFromChunks0`) and by
`OwnerContentClassifier.MAX_CHUNK_ZERO_BYTES` /
`OwnerContentClassifier.maxChunkZeroBytes` on both platforms.
