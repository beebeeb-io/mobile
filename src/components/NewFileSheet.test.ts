// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1587 — source checks on the New file sheet that a unit test of the
// pure module cannot see: the "Soon" tiles are inert (no press handler, no
// press feedback), the live tiles are buttons, and the "+" menu is wired to
// the sheet (not the old two-item menu).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sheet = readFileSync(join(import.meta.dir, 'NewFileSheet.tsx'), 'utf-8')
const files = readFileSync(join(import.meta.dir, '../screens/FilesScreen.tsx'), 'utf-8')

describe('NewFileSheet', () => {
  test('a live tile is a Pressable that opens the name step; a soon tile is a plain View', () => {
    const m = sheet.match(/return live \? \(([\s\S]*?)\) : \(([\s\S]*?)\);\n\s*\}\)\}/)
    expect(m).not.toBeNull()
    const [, liveBranch, soonBranch] = m
    expect(liveBranch).toContain('<Pressable')
    expect(liveBranch).toContain('onPress={() => openNameStep(tile)}')
    expect(soonBranch).not.toContain('Pressable')
    expect(soonBranch).not.toContain('onPress')
    // No touch/responder handler of any kind, and no route to the name step.
    expect(soonBranch).not.toMatch(/\bon[A-Z]\w*=/)
    expect(soonBranch).not.toContain('openNameStep')
    expect(soonBranch).toContain('accessibilityState={{ disabled: true }}')
    expect(soonBranch).toContain('accessibilityLabel={tileAccessibilityLabel(tile)}')
  })

  test('openNameStep refuses a tile without a creatable type', () => {
    expect(sheet).toMatch(/const type = documentTypeForTile\(tile\);\s*if \(!type\) return;/)
  })

  test('the soon tiles say SOON and fade to 35 %', () => {
    expect(sheet).toContain('>SOON<')
    expect(sheet).toContain('opacity: live ? 1 : 0.35')
  })

  test('the amber accent is only the Markdown well, the selected chip, the field ring and the CTA', () => {
    const amberUses = sheet.match(/c\.amber\b/g) ?? []
    // accentLine + palette dep, lock glyph, field ring, chip border, chip text, CTA
    expect(amberUses.length).toBeLessThanOrEqual(8)
  })
})

describe('FilesScreen wiring', () => {
  test('the "+" menu opens the sheet; the old per-type menu ids are gone', () => {
    expect(files).toContain('if (nativeEvent.event === NEW_FILE_ACTION_ID) openNewFileSheet();')
    expect(files).not.toContain('newDocumentTypeForAction')
    expect(files).toContain('<NewFileSheet')
  })

  test('creation goes through encryptedUpload, never a plaintext upload', () => {
    const fn = files.slice(files.indexOf('const createNewDocument'), files.indexOf('const createNewDocument') + 4000)
    expect(fn).toContain('await assertNameFreeInFolder(name, parentId)')
    expect(fn).toContain('await encryptedUpload({')
    expect(fn).toContain('encryptChunkFn: encryptChunk')
    expect(fn).toContain('startInEditMode: opensInEditor')
    expect(fn).toContain('created · encrypted')
  })
})
