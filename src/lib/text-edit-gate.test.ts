// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 — the size/UTF-8 editability gate. No react-native dependency
// (this file and `./format` are both pure), so no module mocking needed.
import { describe, expect, test } from 'bun:test'
import { evaluateTextEditGate, MAX_EDITABLE_TEXT_BYTES } from './text-edit-gate'

describe('evaluateTextEditGate', () => {
  test('still loading (no text yet) is not editable, and gives no reason to display', () => {
    const result = evaluateTextEditGate({ sizeBytes: 100, decodedText: null, decodeFailed: false })
    expect(result).toEqual({ editable: false, reason: null })
  })

  test('a decode failure is not editable, with an honest reason', () => {
    const result = evaluateTextEditGate({ sizeBytes: 100, decodedText: null, decodeFailed: true })
    expect(result.editable).toBe(false)
    expect(result.reason).toBe("This file couldn't be read as text.")
  })

  test('a small, clean UTF-8 file is editable', () => {
    const result = evaluateTextEditGate({ sizeBytes: 1024, decodedText: 'hello world', decodeFailed: false })
    expect(result.editable).toBe(true)
    expect(result.reason).toBeNull()
  })

  test('exactly at the 2 MB boundary is still editable', () => {
    const result = evaluateTextEditGate({
      sizeBytes: MAX_EDITABLE_TEXT_BYTES,
      decodedText: 'x',
      decodeFailed: false,
    })
    expect(result.editable).toBe(true)
  })

  test('one byte over the 2 MB boundary is read-only, with the limit named in the reason', () => {
    const result = evaluateTextEditGate({
      sizeBytes: MAX_EDITABLE_TEXT_BYTES + 1,
      decodedText: 'x',
      decodeFailed: false,
    })
    expect(result.editable).toBe(false)
    expect(result.reason).toContain('2 MB')
  })

  test('an unknown size (null/undefined) is treated as NOT editable, never a silent pass', () => {
    expect(evaluateTextEditGate({ sizeBytes: null, decodedText: 'x', decodeFailed: false }).editable).toBe(false)
    expect(evaluateTextEditGate({ sizeBytes: undefined, decodedText: 'x', decodeFailed: false }).editable).toBe(false)
  })

  test('a lossy UTF-8 decode (replacement character present) is read-only even under 2 MB', () => {
    const result = evaluateTextEditGate({
      sizeBytes: 10,
      decodedText: 'abc�def',
      decodeFailed: false,
    })
    expect(result.editable).toBe(false)
    expect(result.reason).toBe("This file isn't valid UTF-8 text, so it opens read-only.")
  })

  test('a genuine U+FFFD character typed by a user (not a decode artifact) is indistinguishable here — documented limitation, not a bug', () => {
    // This is a known, accepted heuristic limitation (see the doc comment in
    // text-edit-gate.ts): there is no way to tell "this came from a lossy
    // decode" from "the file legitimately contains U+FFFD" once we only have
    // the decoded JS string. Asserting the CURRENT behavior here so a future
    // change to the heuristic is a deliberate, reviewed decision, not a
    // silent regression.
    const result = evaluateTextEditGate({ sizeBytes: 10, decodedText: '�', decodeFailed: false })
    expect(result.editable).toBe(false)
  })
})
