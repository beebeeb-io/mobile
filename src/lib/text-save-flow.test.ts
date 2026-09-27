// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 — editor Save orchestration (build 218: false "another device"
// dialog on a single device, then a Save that never finished). Pure module,
// no mocking needed.
import { describe, expect, test } from 'bun:test'
import { classifySaveConflict, createSingleFlight, runTextSave } from './text-save-flow'

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

function makeDeps(script: Array<(base: number) => number | Error>, opts: { current?: number; owned?: boolean } = {}) {
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
    ownsInFlightUpload: async () => opts.owned ?? true,
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

describe('runTextSave — stuck upload from an interrupted earlier save (Issue 1)', () => {
  test('in-progress 409 -> abandon the stuck upload, retry on the SAME base, save; never a conflict', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS(), (base) => base + 1])
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'saved', versionNumber: 5 })
    expect(calls.abandon).toBe(1)
    expect(calls.save).toEqual([4, 4])
    expect(calls.readCurrent).toBe(0)
  })

  test('in-progress again after one abandon -> busy (bounded, no loop, no dialog)', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS()])
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'busy', elsewhere: false })
    expect(calls.save).toHaveLength(2)
    expect(calls.abandon).toBe(1)
  })

  test('a save that fails AFTER init succeeded abandons its own upload so the next save is not refused', async () => {
    const { deps, calls } = makeDeps([() => withMarker(NETWORK(), true)])
    const result = await runTextSave(deps, { baseVersionNumber: 2 })
    expect(result.kind).toBe('error')
    expect(calls.abandon).toBe(1)
  })

  test('a save that fails BEFORE init does not abandon (it never marked the file uploading)', async () => {
    const { deps, calls } = makeDeps([() => withMarker(NETWORK(), false)])
    const result = await runTextSave(deps, { baseVersionNumber: 2 })
    expect(result.kind).toBe('error')
    expect(calls.abandon).toBe(0)
  })

  test('an abandon that rejects does not break the flow', async () => {
    const { deps } = makeDeps([() => IN_PROGRESS(), (base) => base + 1])
    deps.abandon = async () => {
      throw new Error('404')
    }
    const result = await runTextSave(deps, { baseVersionNumber: 1 })
    expect(result).toEqual({ kind: 'saved', versionNumber: 2 })
  })
})

describe('runTextSave — an upload started on ANOTHER device (Codex P1, PR #134)', () => {
  test('in-progress 409 for an upload this device did not start -> busy elsewhere, never abandoned', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS(), (base) => base + 1], { owned: false })
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'busy', elsewhere: true })
    expect(calls.abandon).toBe(0)
    expect(calls.save).toEqual([4])
  })

  test('an ownership check that throws is treated as not ours', async () => {
    const { deps, calls } = makeDeps([() => IN_PROGRESS()])
    deps.ownsInFlightUpload = async () => {
      throw new Error('storage unavailable')
    }
    const result = await runTextSave(deps, { baseVersionNumber: 4 })
    expect(result).toEqual({ kind: 'busy', elsewhere: true })
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
