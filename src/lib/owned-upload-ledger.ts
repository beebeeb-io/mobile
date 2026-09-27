/**
 * Task 1578 (Codex P1 on PR #134) — which in-flight uploads THIS device started.
 *
 * The server answers `POST /uploads/init` with 409 "upload is already in
 * progress for this file" whether the in-flight upload is an orphan left by
 * this device's own interrupted save or a live upload running on another
 * device, and `POST /files/:id/upload/abandon` is file-scoped. So the editor
 * may only abandon an upload it knows it started: an entry is written once
 * `init` is accepted and removed when that upload completes or is abandoned.
 *
 * Entries expire after `OWNED_UPLOAD_TTL_MS` (6 days), under the server's
 * 7-day stale-upload sweep: once the sweep may have cleared our orphan,
 * another device may have started a fresh upload, and a stale entry must not
 * authorise abandoning that one.
 */

export interface LedgerStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}

export const OWNED_UPLOAD_LEDGER_KEY = 'beebeeb:owned-uploads:v1'
export const OWNED_UPLOAD_TTL_MS = 6 * 24 * 60 * 60 * 1000

type Entries = Record<string, number>

export function createOwnedUploadLedger(storage: LedgerStorage, now: () => number = Date.now) {
  // Serialise read-modify-write so concurrent add/remove calls don't lose updates.
  let chain: Promise<unknown> = Promise.resolve()

  async function read(): Promise<Entries> {
    try {
      const raw = await storage.getItem(OWNED_UPLOAD_LEDGER_KEY)
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Entries) : {}
    } catch {
      return {}
    }
  }

  function prune(entries: Entries): Entries {
    const cutoff = now() - OWNED_UPLOAD_TTL_MS
    const out: Entries = {}
    for (const [id, at] of Object.entries(entries)) {
      if (typeof at === 'number' && at > cutoff) out[id] = at
    }
    return out
  }

  function mutate(fn: (entries: Entries) => void): Promise<void> {
    const next = chain.then(async () => {
      const entries = prune(await read())
      fn(entries)
      try {
        await storage.setItem(OWNED_UPLOAD_LEDGER_KEY, JSON.stringify(entries))
      } catch {
        // Storage unavailable: we simply won't be able to prove ownership later.
      }
    })
    chain = next.catch(() => {})
    return next
  }

  return {
    add(fileId: string): Promise<void> {
      return mutate((e) => {
        e[fileId] = now()
      })
    },
    remove(fileId: string): Promise<void> {
      return mutate((e) => {
        delete e[fileId]
      })
    },
    async has(fileId: string): Promise<boolean> {
      await chain
      return fileId in prune(await read())
    },
  }
}

export type OwnedUploadLedger = ReturnType<typeof createOwnedUploadLedger>
