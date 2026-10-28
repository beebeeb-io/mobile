// @ts-nocheck — source guards run in Bun; app tsconfig has no Bun ambient types.
import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dir, '../..')
const base = resolve(root, 'modules/beebeeb-crypto')
const read = (p: string) => readFileSync(resolve(base, p), 'utf8')
const swift = 'ios/BeebeebCryptoModule.swift'
const kotlin = 'android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt'
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = resolve(dir, e.name)
    return e.isDirectory() ? (e.name === 'uniffi' ? [] : files(p)) : /\.(swift|kt)$/.test(p) ? [p] : []
  })
}
function block(source: string, name: string): string {
  return source.split(`AsyncFunction("${name}")`)[1]?.split(/\n    (?:AsyncFunction|Function)\(/)[0] ?? ''
}
test('every_deriveFileKey_site_has_an_explicit_ownership_reason', () => {
  const ownUploads = new Set(['ios/NativeBackupEngine.swift', 'ios/ThumbnailEncryptUpload.swift',
    'ios/NativeManualUploader.swift', 'ios/BeebeebCryptoBridge.swift',
    'android/src/main/java/expo/modules/beebeebcrypto/NativeManualUploader.kt'])
  const sources = [...readdirSync(resolve(base, 'ios')).filter(p => p.endsWith('.swift')).map(p => resolve(base, 'ios', p)),
    ...files(resolve(base, 'android/src/main'))]
  const violations: string[] = []
  let checked = 0
  for (const p of sources) {
    const rel = relative(base, p)
    if (rel.endsWith('beebeeb_uniffi.swift') || rel.includes('/uniffi/')) continue
    const source = readFileSync(p, 'utf8')
    for (const match of source.matchAll(/deriveFileKey\s*\(/g)) {
      checked++
      if (ownUploads.has(rel) || rel.endsWith('/SharedKeyOps.swift') || rel.endsWith('/SharedKeyOps.kt')) continue
      const prefix = source.slice(0, match.index)
      const enclosing = [...prefix.matchAll(/^    (?:AsyncFunction|Function)\("([^"]+)"\)/gm)].at(-1)?.[1]
      const allowed = rel === swift ? ['deriveFileKey', 'handleDeriveFileKey', 'generateAndUploadThumbnailNative', 'generateAndUploadPhotoLibraryThumbnailNative']
        : rel === kotlin ? ['deriveFileKey', 'handleDeriveFileKey'] : []
      if (!enclosing || !allowed.includes(enclosing)) violations.push(`${rel}:${prefix.split('\n').length}:${enclosing ?? 'native reader'}`)
    }
  }
  expect(checked).toBeGreaterThan(10)
  expect(violations).toEqual([])
})
for (const path of [swift, kotlin]) test(`${path}:_handle_operations_use_table_first`, () => {
  for (const name of ['handleEncryptChunk', 'handleDecryptChunk', 'handleEncryptMetadata', 'handleDecryptMetadata']) {
    expect(block(read(path), name)).toContain('SharedKeyOps.fileKey')
  }
})
for (const path of [swift, kotlin]) test(`${path}:_names_split_table_and_master`, () => {
  expect(block(read(path), 'decryptNames')).toContain('SharedKeyOps.decryptNames')
  const ops = read(path === swift ? 'ios/SharedKeyOps.swift' : 'android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt')
  const names = ops.split('func decryptNames')[1] ?? ops.split('fun decryptNames')[1] ?? ''
  expect(names).toContain('registry.file')
  expect(names).toContain('decryptNameMetadata')
  expect(names).toContain('mergeNameResults')
})
test('preview_download_uses_a_table_handle_before_the_master_constructor', () => {
  expect(read(swift)).toContain('SharedKeyOps.chunkDecryptor(master: master, fileId: fileId)')
  const preview = read(kotlin).split('private fun decryptPreviewChunks')[1]?.split('private fun ')[0] ?? ''
  expect(preview).toContain('SharedKeyOps.fileKey')
})
test('both_video_streamers_use_table_first', () => {
  expect(read('ios/NativeVideoStreamer.swift')).toContain('SharedKeyOps.fileKey')
  expect(read('android/src/main/java/expo/modules/beebeebcrypto/VideoStreamer.kt')).toContain('SharedKeyOps.fileKey')
})
test('android_offline_decrypt_uses_an_opaque_file_handle', () => {
  expect(block(read(kotlin), 'decryptLocalFileNative')).toContain('pickKey')
  const chunks = read(kotlin).split('private fun decryptLocalFileChunks')[1]?.split('private fun ')[0] ?? ''
  expect(chunks).toContain('fileKey: FileKeyHandle')
  expect(chunks).toContain('fileKey.decryptChunk')
})
