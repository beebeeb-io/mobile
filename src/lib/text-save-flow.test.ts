// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 — editor Save orchestration (build 218: false "another device"
// dialog on a single device, then a Save that never finished). Pure module,
// no mocking needed.
import { describe, expect, test } from 'bun:test'
import { classifySaveConflict, createSingleFlight, refreshMetaForConflict, runTextSave, runTextSaveConfirmingClear } from './text-save-flow'

// The exact wire texts of the server's two init-time 409s
// (beebeeb-api/src/routes/uploads.rs, init_upload) as the mobile ApiError
// carries them: body `{"error": "<text>"}` -> message = code = text.
function apiError(status: number, text: string) {
  const err = new Error(text) as Error & { status: number; code: string }
  err.status = status
  err.code = text
  return err
}
const STALE = () => apiError(409, 'stale base version for replacement upload')
const IN_PROGRESS = () => apiError(409, 'upload is already in progress for this file')
const NETWORK = () => apiError(0, 'Could not reach the server. Check your connection and try again.')

function withMarker(err: Error, uploadStarted: boolean) {
  ;(err as any).__started = uploadStarted
  return err
}

function makeDeps(script: Array<(base: number) => number | Error>, opts: { current?: number } = {}) {
  const calls = { save: [] as number[], abandon: 0, readCurrent: 0 }
  let i = 0
  const deps = {
    save: async (base: number) => {
      calls.save.push(base)
      const step = script[Math.min(i++, script.length - 1)]
      const out = step(base)
      if (out instanceof Error) throw out
      return out
    },
    uploadStarted: (err: unknown) => (err as any)?.__started === true,
    abandon: async () => {
      calls.abandon++
    },
    readCurrentVersion: async () => {
      calls.readCurrent++
      return opts.current ?? 7
    },
  }
  return { deps, calls }
}

describe('classifySaveConflict', () => {
  test('the stale-base 409 is a stale-version conflict', () => {
    expect(classifySaveConflict(STALE())).toBe('stale-version')
  })

  test('"upload is already in progress" is NOT a stale-version conflict (the build-218 false dialog)', () => {
    expect(classifySaveConflict(IN_PROGRESS())).toBe('upload-in-progress')
  })

  test('an unrecognised 409 and non-409s are not save conflicts at all', () => {
    expect(classifySaveConflict(apiError(409, 'upload session no longer exists'))).toBeNull()
    expect(classifySaveConflict(apiError(500, 'stale base version for replacement upload'))).toBeNull()
    expect(classifySaveConflict(NETWORK())).toBeNull()
    expect(classifySaveConflict(null)).toBeNull()
  })
})

describe('runTextSave — "upload is already in progress" (Issue 1 + Codex P1/P2, PR #134)', () => {
  test('in-progress 409 -> ALWAYS needs confirmation: nothing abandoned, no retry, never a conflict', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS(), (base) => base + 1])
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'needs-confirmation' })
    expect(calls.abandon).toBe(0)
    expect(calls.save).toEqual([4])
    expect(calls.readCurrent).toBe(0)
  })

  test('a save that fails AFTER init succeeded abandons its OWN upload so the next save is not refused', async () => {
    const { deps, calls } = makeDeps([() => withMarker(NETWORK(), true)])
    const result = await runTextSave(deps, { baseVersionNumber: 2 })
    expect(result.kind).toBe('error')
    expect(calls.abandon).toBe(1)
    expect(calls.save).toEqual([2])
  })

  test('a save that fails BEFORE init does not abandon (it never marked the file uploading)', async () => {
    const { deps, calls } = makeDeps([() => withMarker(NETWORK(), false)])
    const result = await runTextSave(deps, { baseVersionNumber: 2 })
    expect(result.kind).toBe('error')
    expect(calls.abandon).toBe(0)
  })
})

describe('runTextSaveConfirmingClear — the user decides whether to clear an in-flight upload', () => {
  test('the user confirms -> re-check, abandon once, retry on the SAME base, saved', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS(), () => IN_PROGRESS(), (base) => base + 1])
    let asked = 0
    const result = await runTextSaveConfirmingClear(deps, { baseVersionNumber: 4 }, async () => {
      asked++
      return true
    })
    expect(result).toEqual({ kind: 'saved', versionNumber: 5 })
    expect(asked).toBe(1)
    expect(calls.abandon).toBe(1)
    expect(calls.save).toEqual([4, 4, 4])
    expect(calls.readCurrent).toBe(0)
  })

  test('the user cancels -> nothing abandoned, no second save, and the save gate (spinner) releases', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS(), (base) => base + 1])
    const gate = createSingleFlight()
    let saving = false
    const result = await gate.run(async () => {
      saving = true
      try {
        return await runTextSaveConfirmingClear(deps, { baseVersionNumber: 4 }, async () => false)
      } finally {
        saving = false
      }
    })
    expect(result).toEqual({ kind: 'cancelled' })
    expect(calls.abandon).toBe(0)
    expect(calls.save).toEqual([4])
    expect(saving).toBe(false)
    expect(gate.busy).toBe(false)
  })

  test('a confirm prompt that rejects counts as cancel', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS()])
    const result = await runTextSaveConfirmingClear(deps, { baseVersionNumber: 4 }, async () => {
      throw new Error('alert failed')
    })
    expect(result).toEqual({ kind: 'cancelled' })
    expect(calls.abandon).toBe(0)
  })

  test('confirmed, but the retry is refused again -> busy (bounded: one abandon, no loop)', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS()])
    const result = await runTextSaveConfirmingClear(deps, { baseVersionNumber: 4 }, async () => true)
    expect(result).toEqual({ kind: 'busy' })
    expect(calls.abandon).toBe(1)
    expect(calls.save).toEqual([4, 4, 4])
  })

  test('confirmed, and the other upload finished meanwhile -> saved without abandoning anything', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS(), (base) => base + 1])
    const result = await runTextSaveConfirmingClear(deps, { baseVersionNumber: 4 }, async () => true)
    expect(result).toEqual({ kind: 'saved', versionNumber: 5 })
    expect(calls.abandon).toBe(0)
  })

  test('an abandon that rejects does not break the confirmed retry', async () => {
    const { deps } = makeDeps([() => IN_PROGRESS(), () => IN_PROGRESS(), (base) => base + 1])
    deps.abandon = async () => {
      throw new Error('404')
    }
    const result = await runTextSaveConfirmingClear(deps, { baseVersionNumber: 1 }, async () => true)
    expect(result).toEqual({ kind: 'saved', versionNumber: 2 })
  })

  test('a stale-version conflict is never turned into the clear prompt', async () => {
    const { deps, calls } = makeDeps([() => STALE()], { current: 9 })
    let asked = 0
    const result = await runTextSaveConfirmingClear(deps, { baseVersionNumber: 4 }, async () => {
      asked++
      return true
    })
    expect(result).toEqual({ kind: 'conflict', freshVersionNumber: 9 })
    expect(asked).toBe(0)
    expect(calls.abandon).toBe(0)
  })
})

describe('runTextSave — real stale-version conflict (dialog, as on main)', () => {
  test('hands the server current version back for the dialog and does not save again', async () => {
    const { deps, calls } = makeDeps([() => STALE(), (base) => base + 1], { current: 7 })
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'conflict', freshVersionNumber: 7 })
    expect(calls.save).toEqual([4])
    expect(calls.readCurrent).toBe(1)
    expect(calls.abandon).toBe(0)
  })

  test('a stale conflict whose version read fails is an error, not a dialog with a made-up version', async () => {
    const { deps } = makeDeps([() => STALE()])
    deps.readCurrentVersion = async () => {
      throw NETWORK()
    }
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result.kind).toBe('error')
  })
})

describe('refreshMetaForConflict — a conflict refreshes name + parent + version (Codex P2, PR #134)', () => {
  test('a stale-version conflict reloads the FULL metadata once and hands its version to the dialog', async () => {
    const { deps, calls } = makeDeps([() => STALE()])
    let meta = { nameEncrypted: 'old-name', parentId: 'old-parent', versionNumber: 4 }
    let loads = 0
    const load = async () => {
      loads++
      meta = { nameEncrypted: 'renamed-elsewhere', parentId: 'moved-elsewhere', versionNumber: 6 }
      return meta
    }
    deps.readCurrentVersion = () => refreshMetaForConflict(load)
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'conflict', freshVersionNumber: 6 })
    expect(loads).toBe(1)
    expect(meta).toEqual({ nameEncrypted: 'renamed-elsewhere', parentId: 'moved-elsewhere', versionNumber: 6 })
    expect(calls.abandon).toBe(0)
  })

  test('a metadata reload that fails is an error, not a conflict dialog with a made-up version', async () => {
    const { deps } = makeDeps([() => STALE()])
    deps.readCurrentVersion = () => refreshMetaForConflict(async () => null)
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result.kind).toBe('error')
  })
})

describe('runTextSave always settles (Issue 2 — the Save spinner must clear)', () => {
  test('every failing dependency still resolves the promise (a finally{setSaving(false)} always runs)', async () => {
    const scripts = [
      [() => STALE()],
      [() => IN_PROGRESS()],
      [() => withMarker(NETWORK(), true)],
      [() => apiError(409, 'something else')],
    ]
    for (const script of scripts) {
      const { deps } = makeDeps(script)
      deps.readCurrentVersion = async () => {
        throw NETWORK()
      }
      const settled = await Promise.race([
        runTextSave(deps, { baseVersionNumber: 1 }).then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
      ])
      expect(settled).toBe('settled')
    }
  })
})

describe('createSingleFlight — one save at a time', () => {
  test('a second tap while a save is running does not start a second upload', async () => {
    const gate = createSingleFlight()
    let runs = 0
    let release: () => void = () => {}
    const first = gate.run(async () => {
      runs++
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'first'
    })
    const second = await gate.run(async () => {
      runs++
      return 'second'
    })
    expect(second).toBeUndefined()
    expect(gate.busy).toBe(true)
    release()
    expect(await first).toBe('first')
    expect(runs).toBe(1)
    expect(gate.busy).toBe(false)
  })

  test('the gate reopens after a failed run', async () => {
    const gate = createSingleFlight()
    await gate.run(async () => {
      throw new Error('boom')
    }).catch(() => {})
    expect(gate.busy).toBe(false)
    expect(await gate.run(async () => 'again')).toBe('again')
  })
})
