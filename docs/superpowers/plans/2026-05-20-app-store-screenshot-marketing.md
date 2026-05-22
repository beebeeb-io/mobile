# App Store Screenshot Marketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerate polished Beebeeb iOS App Store screenshots from the existing SVG generator, with iPhone 17 Pro Max-style framing, current dark Beebeeb mobile UI, and stock/AI-style photo thumbnails.

**Architecture:** Use `repos/mobile/scripts/generate-app-store-screenshots.mjs` as the single source of truth. The generator writes SVG and PNG outputs for the 6.9-inch, 6.7-inch, and 5.5-inch iPhone size classes under `marketing/app-store/`.

**Tech Stack:** Node.js, SVG, `rsvg-convert`, local JPEG stock assets, Beebeeb mobile marketing assets.

---

### Task 1: Replace geometric photo placeholders

**Files:**
- Modify: `scripts/generate-app-store-screenshots.mjs`
- Create: `marketing/assets/stock/photo-01.jpg` through `photo-08.jpg`

- [ ] Add local stock/AI-style JPEG assets.
- [ ] Embed them as base64 images in the Photos slide SVG.
- [ ] Preserve rounded thumbnail clipping and App Store-safe dimensions.

### Task 2: Regenerate official outputs

**Files:**
- Generate: `marketing/app-store/iphone-6.9/*.png`
- Generate: `marketing/app-store/iphone-6.9/*.svg`
- Generate: `marketing/app-store/iphone-6.7/*.png`
- Generate: `marketing/app-store/iphone-6.7/*.svg`
- Generate: `marketing/app-store/iphone-5.5/*.png`
- Generate: `marketing/app-store/iphone-5.5/*.svg`
- Generate: `marketing/app-store/manifest.json`

- [ ] Run `node scripts/generate-app-store-screenshots.mjs`.
- [ ] Verify 6.9-inch PNGs are `1320 x 2868`.
- [ ] Verify 6.7-inch PNGs are `1290 x 2796`.
- [ ] Verify 5.5-inch PNGs are `1242 x 2208`.
- [ ] Build a contact sheet for visual review.

### Task 3: Update regeneration skill

**Files:**
- Modify: `.agents/skills/beebeeb-app-store-screenshots/SKILL.md`
- Modify: `.agents/skills/beebeeb-app-store-screenshots/references/app-store-screenshot-design.md`

- [ ] Point the skill at `node scripts/generate-app-store-screenshots.mjs`.
- [ ] Remove the failed Pillow-generator path from the skill.
- [ ] Document the stock asset folder and expected output sizes.
