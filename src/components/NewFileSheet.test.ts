// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1587 — source checks on the New file sheet that a unit test of the
// pure module cannot see: the "Soon" tiles are inert (no press handler, no
// press feedback), the live tiles are buttons, and the "+" menu is wired to
// the sheet (not the old two-item menu).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_LABEL_ADVANCE_EM, ICON_LABEL_MARGIN_UNITS, docIconLabelMetrics } from '../lib/new-document'

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

  test('creation is the tested flow (lib/create-new-document.ts) wired to encryptedUpload + abandon', () => {
    // The behaviour (fresh re-list clash, abandon on failure, the Preview
    // params) is tested with mocks in create-new-document.test.ts; this only
    // pins that FilesScreen wires the REAL encrypted path and abandon into it.
    const start = files.indexOf('const createNewDocument = useCallback')
    const fn = files.slice(start, files.indexOf('}, [isUnlocked, currentFolder.id, freshFolderNames', start))
    expect(fn).toContain('await createNewDocumentFile(')
    expect(fn).toMatch(/upload: \(\{[^}]*\}\) => encryptedUpload\(\{/)
    expect(fn).toContain('encryptChunkFn: encryptChunk')
    expect(fn).toContain('abandonUpload: abandonTextFileUpload')
    expect(fn).toContain('listFolderNames: freshFolderNames')
    expect(fn).toContain("navigation.navigate('Preview', previewParamsForNewDocument(uploaded, req))")
    expect(fn).not.toMatch(/uploadEncryptedChunked|uploadFile\(/)
  })

  test('the unlock path opens the sheet only when the vault really is open', () => {
    const start = files.indexOf('const openNewFileSheet = useCallback')
    const fn = files.slice(start, files.indexOf('}, [phraseVerified, isUnlocked, unlock', start))
    expect(fn).toMatch(/\.then\(\(\) => \{[\s\S]*getMasterKeyHandleId\(\)[\s\S]*if \(open\) setNewFileOpen\(true\);/)
    expect(fn).not.toContain('.then(() => setNewFileOpen(true))')
  })

  test('the "+" menu passes the platform (Android gets the flat list)', () => {
    expect(files).toContain('buildAddMenuActions(c.ink, Platform.OS)')
  })
})

describe('DocOutlineIcon label fit', () => {
  test('the sheet takes its label size + inset from docIconLabelMetrics', () => {
    expect(sheet).toContain('docIconLabelMetrics(width, label)')
    expect(sheet).toMatch(/left: inset,\s*right: inset,/)
    expect(sheet).toContain('adjustsFontSizeToFit')
  })

  test('"DOCX" / "XLSX" / "PPTX" / "TXT" / "MD" fit inside the outline with a margin, at every icon size the sheet uses', () => {
    // The sheet's icon is round(well × 0.494), well = min(72, colW × 0.83):
    // 375-pt to 440-pt wide phones and the 72-pt cap.
    for (const iconW of [30, 32, 34, 36]) {
      const s = iconW / 30
      const stroke = Math.max(1, 1.5 * s)
      for (const label of ['DOCX', 'XLSX', 'PPTX', 'TXT', 'MD']) {
        const m = docIconLabelMetrics(iconW, label)
        const textW = label.length * ICON_LABEL_ADVANCE_EM * m.fontSize + (label.length - 1) * m.letterSpacing
        expect([label, iconW, textW <= m.boxWidth]).toEqual([label, iconW, true])
        // At least ICON_LABEL_MARGIN_UNITS of clear space from each stroke.
        expect(m.inset - stroke).toBeGreaterThanOrEqual(ICON_LABEL_MARGIN_UNITS * s - 1e-9)
      }
    }
  })
})
