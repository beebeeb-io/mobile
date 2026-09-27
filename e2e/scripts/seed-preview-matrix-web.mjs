#!/usr/bin/env node
// Task 1565 — seeds the local-only QA account with every preview-matrix
// fixture by driving the REAL web app (localhost:5173), the same way a
// person would: the app does client-side E2E encryption in the browser, so
// there is no shortcut through a plain curl/API upload here — Playwright is
// the actual and correct tool, not a heavier-than-needed one (this is the
// same reasoning the web e2e harness itself already runs on).
//
// PRECONDITIONS (this script does not start these for you):
//   1. Local API on :3001:      cd repos/server && cargo run -p beebeeb-api
//   2. Local Postgres on :5434: docker compose up -d postgres
//   3. Local web dev server:    cd repos/web && bun dev   (serves :5173)
//   4. The qa0688content@beebeeb.io account already exists on that LOCAL DB
//      (it does, per .claude/skills/beebeeb-test-accounts.md — this is a
//      localhost-only seeded account; login on prod fails for it).
//
// After this script completes, every fixture is a real file in that
// account's Drive — open the SAME account in the iOS simulator (pointed at
// the local API, see mobile CLAUDE.md "API environment: localhost:3001") and
// e2e/maestro/1565-preview-matrix/run.yaml can open and screenshot every one.
//
// Usage:
//   node e2e/scripts/seed-preview-matrix-web.mjs
//   E2E_WEB_URL=http://localhost:5174 node e2e/scripts/seed-preview-matrix-web.mjs
//
// Idempotent-ish: re-running uploads a SECOND copy of each file (the app's
// same-name-reupload path would version it instead, which is a different
// code path than "every fixture exists as file N of type X" — if you need a
// clean slate, delete the account's files via the web UI first, or empty the
// account's rows in the local dev DB directly (localhost-only, never prod).

import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { FIXTURES, FIXTURES_ROOT_REL } from './preview-matrix-fixtures.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBILE_ROOT = path.join(__dirname, '..', '..')
const FIXTURES_ROOT = path.join(MOBILE_ROOT, FIXTURES_ROOT_REL)

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173'
const QA_EMAIL = process.env.BB_QA_EMAIL ?? 'qa0688content@beebeeb.io'
const QA_PASSWORD = process.env.BB_QA_PASSWORD ?? 'BeebeebQA0688content!'

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Same rationale as the web spec (e2e/1565-preview-matrix.spec.ts, repos/web):
 *  Playwright/Maestro row-name matching is un-anchored, and several fixture
 *  basenames are literal substrings of another (sample.doc ⊂ sample.docx,
 *  sample.c ⊂ sample.cs/.css/.cpp/.csv/.cr2/.cr3, sample.ts ⊂ sample.tsx,
 *  sample.js ⊂ sample.json, sample.h ⊂ sample.html). A distinct zero-padded
 *  numeric prefix makes every uploaded name safe to match again — except the
 *  bare `Dockerfile` fixture, which must stay literally "Dockerfile" (mobile
 *  routes purely on OS-reported mime_type, not filename, so the prefix
 *  can't break anything there — but the RUNNER script matches Drive rows by
 *  this exact name, so consistency with the web convention matters more than
 *  any code-path reason on the mobile side). */
function uploadNameFor(n, origBase) {
  if (origBase === 'Dockerfile') return origBase
  return `${String(n).padStart(2, '0')}-${origBase}`
}

async function main() {
  console.log(`[seed-1565] fetching RAW samples (idempotent, sha256-verified)...`)
  execFileSync('bash', ['fetch-raw.sh'], { cwd: path.join(FIXTURES_ROOT, 'raw'), stdio: 'inherit' })

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-seed-1565-'))
  const browser = await chromium.launch({ headless: process.env.HEADFUL !== '1' })
  const page = await browser.newPage()

  try {
    console.log(`[seed-1565] logging in as ${QA_EMAIL} at ${WEB_URL} ...`)
    await page.goto(`${WEB_URL}/login?nodev=1`)
    await page.getByLabel(/email/i).fill(QA_EMAIL)
    await page.getByPlaceholder('Your password').fill(QA_PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForURL(/\/(?:$|\?|#)/, { timeout: 30_000 })
    await page.getByText(/All files/i).first().waitFor({ timeout: 15_000 })
    console.log('[seed-1565] logged in, vault unlocked.')

    // Best-effort dismiss of first-run overlays — an already-seeded account
    // shouldn't show these, but don't assume.
    for (const label of ['Essential only', /^Skip for now$/]) {
      const btn = page.getByRole('button', { name: label })
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) await btn.click().catch(() => {})
    }

    let ok = 0
    for (let i = 0; i < FIXTURES.length; i++) {
      const fx = FIXTURES[i]
      const n = i + 1
      const origBase = path.basename(fx.rel)
      const uploadName = uploadNameFor(n, origBase)
      const srcPath = path.join(FIXTURES_ROOT, fx.rel)
      const uploadPath = path.join(scratchDir, uploadName)
      fs.copyFileSync(srcPath, uploadPath)

      process.stdout.write(`[seed-1565] ${String(n).padStart(2, '0')}/${FIXTURES.length} ${uploadName} ... `)
      try {
        await page.locator('input[type="file"]').first().setInputFiles(uploadPath)
        await page
          .getByRole('row', { name: new RegExp(escapeRe(uploadName)) })
          .first()
          .waitFor({ timeout: 30_000 })
        console.log('uploaded.')
        ok++
      } catch (err) {
        console.log(`FAILED: ${err instanceof Error ? err.message : err}`)
      }
    }

    console.log(`\n[seed-1565] ${ok} of ${FIXTURES.length} fixtures uploaded to ${QA_EMAIL}'s Drive.`)
    if (ok !== FIXTURES.length) {
      console.log('[seed-1565] Not all fixtures uploaded — re-run, or check the failures above before running Maestro.')
      process.exitCode = 1
    }
  } finally {
    await browser.close()
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[seed-1565] fatal:', err)
  process.exit(1)
})
