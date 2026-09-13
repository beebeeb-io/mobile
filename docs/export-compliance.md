# Export compliance — encryption self-classification

**Status:** written 2026-09-13 (task 1401) · **Scope:** iOS submission for `io.beebeeb.app`

This document is the source of truth for Beebeeb's U.S. export-compliance
self-classification and the App Store Connect (ASC) encryption questionnaire.
Every algorithm claim below was verified directly against `repos/core` on
2026-09-13 (file:line citations, re-checked — not copied from an earlier
review without confirming). It supersedes the export-compliance placeholder
in `repos/mobile/docs/app-store/review-notes.md` §4, which points here.

## 1. Why the key must be `true`

Apple, "Complying with Encryption Export Regulations": *"Set the value to NO
if your app… doesn't use encryption, or if it only uses forms of encryption
that are exempt… Otherwise, set it to YES."* and *"the use of encryption
that's built into the operating system… is exempt… whereas the use of
proprietary encryption is not."*

Beebeeb statically links `libbeebeeb_uniffi.a` (`ios/BeebeebCore.xcframework`)
— a Rust static library compiled from `repos/core`, called via UniFFI-generated
Swift bindings. It performs its own AES-256-GCM, Argon2id, OPAQUE, X25519, and
HKDF operations in that Rust code, not through CryptoKit/CommonCrypto. The
"encryption built into the operating system" exemption does not apply, even
though every algorithm used is a standard, published one — so
`ITSAppUsesNonExemptEncryption` must be `true`, and the questionnaire below
must be answered.

## 2. Algorithm inventory (verified against `repos/core`, 2026-09-13)

| Algorithm | Purpose | File:line (repos/core) | Standard? |
|---|---|---|---|
| AES-256-GCM | File/chunk content encryption (the `ChunkEncryptor`/`ChunkDecryptor` streaming primitive every client uses) | `beebeeb-core/src/encrypt.rs:1-2` (`aes_gcm::aead::Aead`; `Aes256Gcm, KeyInit, Nonce`) | Yes — NIST SP 800-38D |
| AES-256-GCM | Opaque-blob encryption (search-index shard pages) | `beebeeb-core/src/blob.rs:7-8` | Yes — NIST SP 800-38D |
| AES-256-GCM | Device-to-device transfer channel ("Amber Constellation" pairing) | `beebeeb-core/src/transfer/encrypt.rs:6-7` | Yes — NIST SP 800-38D |
| AES-256-GCM | `bb` CLI browser-login handshake payload | `beebeeb-core/src/cli_auth.rs:45-47` | Yes — NIST SP 800-38D |
| Argon2id | Master-key derivation from the user's password (256 MiB / 4 iter / 2 par) | `beebeeb-core/src/kdf.rs:1` (import), `:94` (`Algorithm::Argon2id` selected explicitly), params documented `:65` | Yes — RFC 9106 |
| OPAQUE (PAKE) over ristretto255 | Password login/registration — the password itself never crosses the wire | `beebeeb-core/src/opaque_protocol.rs:2-7` (imports), ciphersuite `impl CipherSuite … OprfCs = opaque_ke::Ristretto255; KeyExchange = TripleDh<Ristretto255, Sha512>` at `:57-59` | Yes — IETF CFRG draft-irtf-cfrg-opaque (standards-track) |
| X25519 (ECDH) | Device-pairing shared-secret ("Amber Constellation") | `beebeeb-core/src/constellation/mod.rs:32` | Yes — RFC 7748 |
| X25519 (ECDH) | Ephemeral-keypair transfer channel (CLI/browser handoff) | `beebeeb-core/src/transfer/crypto.rs:12` | Yes — RFC 7748 |
| P-256 ECDH | `bb` CLI login handshake key exchange (matches the web client's WebCrypto implementation byte-for-byte) | `beebeeb-core/src/cli_auth.rs:49-50` | Yes — NIST SP 800-186 |
| HKDF-SHA256 | Master-key → per-file key derivation; transfer-key + SAS-word derivation | `beebeeb-core/src/kdf.rs:2-3`; `beebeeb-core/src/transfer/crypto.rs:10-11` | Yes — RFC 5869 |
| HKDF-SHA256 | SAS (short-authentication-string) word derivation exposed to all clients | `beebeeb-core/src/hash.rs:6-7` | Yes — RFC 5869 |
| BLAKE3 | Keyed hash routing search-index entries to shards (not a confidentiality primitive — a deterministic bucket-assignment hash) | `beebeeb-core/src/search_index.rs:140` (`blake3::hash`); dependency pinned `beebeeb-core/Cargo.toml:30` | Yes — public, open specification |
| BIP39 | Recovery-phrase (mnemonic) generation — the offline backup of the master key | `beebeeb-core/src/recovery.rs:2` (`use bip39::Mnemonic;`) | Yes — BIP-0039, widely implemented |
| TLS (network transport) | HTTPS to `api.beebeeb.io` | `beebeeb-upload/Cargo.toml:11` pins `reqwest` to `features = ["json", "native-tls"], default-features = false` — no Rust-implemented TLS stack is compiled in for this path | **OS-provided/exempt** — `native-tls` on iOS is a thin wrapper over Apple's own Security.framework, not a Rust crypto implementation |

**No primitive above is proprietary or hand-rolled.** Every one is a
standard, published algorithm from a recognized spec (NIST, IETF RFC/CFRG
draft, BIP), matching the counsel review recorded in task 1401 (see §5).

### The aws-lc question (counsel's open item, now closed with evidence)

`Cargo.lock` (workspace-wide) lists `aws-lc-rs`/`aws-lc-sys`/`rustls`/
`rustls-webpki` as transitive dependencies of `quinn-proto`/`rustls-webpki`/
`rustls` somewhere in the workspace dependency graph. That does **not** by
itself mean they are linked into the shipped iOS static library — checked
directly:

```
$ nm ios/BeebeebCore.xcframework/ios-arm64/libbeebeeb_uniffi.a | grep -ic "aws_lc\|aws-lc"
0
$ nm ios/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/libbeebeeb_uniffi_sim_fat.a | grep -ic "aws_lc\|aws-lc"
0
$ nm ios/BeebeebCore.xcframework/ios-arm64/libbeebeeb_uniffi.a | grep -ic "rustls"
101
$ nm ios/BeebeebCore.xcframework/ios-arm64/libbeebeeb_uniffi.a | grep -ic "_ring_"
0
```

**Result: zero `aws_lc`/`AWS_LC` symbols in either the device or simulator
static library.** The 101 `rustls`-matching symbols are **all** from the
`rustls_pki_types` crate (`rustls_pki_types::pem::…`, `CertificateDer`,
`PrivateKeyDer`, `ServerName`, `SubjectPublicKeyInfoDer`, PEM-parsing
iterators) — pure data-type/parsing definitions with **no** TLS handshake
code and **no** crypto-provider symbols (0 `aws_lc`, 0 `_ring_`) alongside
them. This is consistent with §2's TLS row: the actual network TLS
handshake on iOS goes through `native-tls` → Security.framework, not a
Rust-implemented `rustls` connection. **Conclusion: aws-lc is not linked
into the shipped app; this does not change the classification** (TLS via
the OS remains exempt regardless), but the doc records the evidence rather
than asserting it from the dependency graph alone, per counsel's request in
task 1401.

## 3. App Store Connect questionnaire answers, in order

Apple asks these questions once, the first time a build with
`ITSAppUsesNonExemptEncryption = true` is submitted (every later build shows
"Missing Compliance" until answered):

| # | Question | Answer |
|---|---|---|
| 1 | Does your app use encryption? | **Yes** |
| 2 | Does your app qualify for any of the exemptions provided in Category 5, Part 2 of the U.S. Export Administration Regulations (EAR)? | **No** |
| 3 | Does your app implement any encryption algorithms that are proprietary or not accepted as standard by international standards bodies (IEEE, IETF, ITU-T, etc.)? | **No** — every algorithm in §2 is a published, standard algorithm |
| 4 | Does your app implement any standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system? | **Yes** — AES-256-GCM/Argon2id/OPAQUE/X25519/HKDF run in the Rust core, not CryptoKit |
| 5 | Is your app available for use in France, or do you provide App Store Connect access to any developer accounts based in France? | **Yes** (worldwide storefront) |

⇒ Resulting classification: **5D992.c**, mass-market, eligible for the
**Cryptography Note (Note 3)** self-classification exception — no export
license required, no CCATS filing needed. Apple issues an
**`ITSEncryptionExportComplianceCode`** once the questionnaire is answered
in App Store Connect for the first `true` build.

## 4. `ITSEncryptionExportComplianceCode` slot

Not yet issued — Apple assigns this after the questionnaire above is
answered in App Store Connect against the first build carrying
`ITSAppUsesNonExemptEncryption = true`. Decision 1398 §6 names the one-time
Guus-facing (or lead-with-ASC-API-key) action: answer the questionnaire, then
paste the code here **and** into `app.json`'s `ios.infoPlist` as
`ITSEncryptionExportComplianceCode`.

```
ITSEncryptionExportComplianceCode: <PENDING — filled in after ASC issues it>
```

## 5. BIS annual self-classification report — counsel review

Recorded verbatim from the `legal-counsel` agent's review (task 1401 Notes,
`counsel-1401`, 2026-09-13 12:50) — **AI-generated legal research, not a
licensed attorney's advice; human/licensed-advisor sign-off is still
required** before relying on it (per decision 1398 §7):

> **§2 BIS annual self-classification: file it** (risk of not filing:
> medium-formal / low-practical). Once the .ipa is on Apple's US servers it
> is "an item in the United States" (15 CFR 734.3(a)(1)); Apple's DPLA makes
> the developer responsible for export compliance (Apple = agent/
> commissionaire, not exporter of record). Mass-market (742.15(b)(1)) / ENC
> (740.17(b)(1)) are conditional on the annual report (Supp. No. 8 to Part
> 742): email to crypt@bis.gov + enc@nsa.gov by 1 February for the prior
> calendar year, free, one row per product. Belt-and-braces: the one-time
> 742.15(b)/734.7(b) "published source code" notification with the GitHub
> URLs of `core` and `mobile` (public). Over-reporting has no penalty. →
> Guus action (add to 1398): first report due 2027-02-01 for 2026.

**Verdict: required.** Owner: Guus / Initlabs B.V. (not Apple, not this
codebase — decision 1398 §7 tracks it as a founder action). Not yet filed as
of 2026-09-13 (first filing isn't due until 2027-02-01 for calendar year
2026).

For completeness, the same review's adjacent findings (also in task 1401
Notes, not re-litigated here):

- **EU dual-use export control (Reg. (EU) 2021/821): no authorisation
  needed** — decontrolled by the Cryptography Note (Note 3 to Category 5,
  Part 2); `repos/core` is public, AGPL-3.0-licensed software, covered by the
  General Software Note. Risk: low.
- **France / ANSSI declaration: required, not yet filed.** LCEN art. 30 +
  Décret 2007-663 — supplying a cryptology means with a confidentiality
  function in France needs a prior declaration (not an authorisation);
  standard algorithms do not exempt it. Filed by Initlabs B.V. (the
  supplier), not Apple — Apple's questionnaire (§3, question 5 above) only
  asks whether the app is available in France, it does not file the
  declaration. One free form + a technical annex — **this document serves
  as that annex**. Covers the whole product family (iOS/web/desktop/CLI);
  no renewal unless the crypto changes materially. Owner: Guus / Initlabs
  B.V. (decision 1398 §7).

## 6. Extension targets — no key needed

Only the main app target's `Info.plist` carries
`ITSAppUsesNonExemptEncryption` — Apple's compliance questionnaire and the
Info.plist key apply to the app bundle App Review evaluates, not to each
extension separately. Verified directly (2026-09-13):

```
$ grep -c ITSAppUsesNonExemptEncryption ios/Beebeeb/Info.plist              # main app
1
$ grep -c ITSAppUsesNonExemptEncryption ios/BeebeebFileProvider/Info.plist  # 0
$ grep -c ITSAppUsesNonExemptEncryption ios/BeebeebShare/Info.plist         # 0
$ grep -c ITSAppUsesNonExemptEncryption ios/BeebeebWidget/Info.plist        # 0
```

The three extension targets (`BeebeebFileProvider`, `BeebeebShare`,
`BeebeebWidget`) all link the same `libbeebeeb_uniffi.a` core (they decrypt
content the same way the main app does), but they carry no
`ITSAppUsesNonExemptEncryption` key of their own — 1 file has the key set to
`true`, 3 extension Info.plists have no key at all, matching Apple's
documented behavior of evaluating export compliance at the app-bundle level.
