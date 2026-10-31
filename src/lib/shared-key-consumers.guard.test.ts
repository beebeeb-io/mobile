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
      const allowed = rel === swift ? ['deriveFileKey', 'handleDeriveFileKey', 'generateAndUploadThumbnailNative', 'generateAndUploadPhotoLibraryThumbnailNative', 'uploadPhotoPreviewNative', 'downloadPhotoPreviewNative']
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
  expect(read(swift)).toContain('SharedKeyOps.chunkDecryptor(master: master, fileId: fileId, expectedChunkFormat: expectedChunkFormat)')
  const preview = read(kotlin).split('private fun decryptPreviewChunks')[1]?.split('private fun ')[0] ?? ''
  expect(preview).toContain('SharedKeyOps.borrowFileKey')
})
test('both_video_streamers_use_table_first', () => {
  expect(read('ios/NativeVideoStreamer.swift')).toContain('SharedKeyOps.fileKey')
  expect(read('android/src/main/java/expo/modules/beebeebcrypto/VideoStreamer.kt')).toContain('SharedKeyOps.borrowFileKey')
})
test('android_offline_decrypt_uses_an_opaque_file_handle', () => {
  expect(block(read(kotlin), 'decryptLocalFileNative')).toContain('pickKey')
  const chunks = read(kotlin).split('private fun decryptLocalFileChunks')[1]?.split('private fun ')[0] ?? ''
  expect(chunks).toContain('fileKey: FileKeyHandle')
  expect(chunks).toContain('fileKey.decryptChunk')
})

// F1: ported from rv-mobile236's native-source probe. Real crypto is in the iOS KAT.
test('preview_core_finish_precedes_plaintext_promotion', () => {
  const delegate = read(swift).split('private final class PreviewStreamingDownloadDelegate')[1].split('public class BeebeebCryptoModule')[0]
  expect(delegate).toContain('decryptor.pushFrame')
  expect(delegate.includes('finishDecryption: { _ = try decryptor.finish() }')).toBe(true)
  const pipeline = read('ios/PreviewChunkPipeline.swift').split('func finish() throws -> Result')[1].split('func cleanup()')[0]
  expect(pipeline.indexOf('try finishDecryption()')).toBeGreaterThan(0)
  expect(pipeline.indexOf('try finishDecryption()')).toBeLessThan(pipeline.indexOf('moveItem(at: tmpURL, to: outputURL)'))
})

// F5: source-contract port of the review probe; strict-v2 behavior runs in XCTest.
test('preview_forwards_only_the_authenticated_metadata_pin', () => {
  const ops = read('ios/SharedKeyOps.swift')
  const factory = ops.split('static func chunkDecryptor')[1].split('static func mintLink')[0]
  expect(factory.includes('expectedChunkFormat: UInt8')).toBe(true)
  expect(factory.includes('expectedChunkFormat: 0')).toBe(false)
  expect(factory.match(/expectedChunkFormat: expectedChunkFormat/g)?.length).toBe(2)
  const module = read(swift)
  expect(module.includes('SharedKeyOps.previewChunkFormat(master: master, fileId: fileId, nameEncrypted: metadata.nameEncrypted)')).toBe(true)
  expect(module.includes('expectedChunkFormat: expectedChunkFormat')).toBe(true)
  const metadata = ops.split('static func previewChunkFormat')[1]?.split('static func chunkDecryptor')[0] ?? ''
  expect(metadata.includes('decryptFileMetadata')).toBe(true)
  expect(metadata.includes('.chunkFormat')).toBe(true)
})

// F3: native source contract; borrow/own behavior is also tested by Gradle + real KAT.
test('android_preview_closes_only_a_locally_owned_key_access', () => {
  const preview = read(kotlin).split('private fun decryptPreviewChunks')[1].split('private fun decryptLocalFileChunks')[0]
  expect(/finally\s*\{\s*fileKey.close\(\)/.test(preview)).toBe(false)
  expect(preview.includes('SharedKeyOps.borrowFileKey(master, fileId)')).toBe(true)
  expect(preview.includes('keyAccess.close()')).toBe(true)
  const video = read('android/src/main/java/expo/modules/beebeebcrypto/VideoStreamer.kt')
  expect(video.includes('fileKey?.close()')).toBe(false)
  expect(video.includes('keyAccess?.close()')).toBe(true)
})

// F4: ported native publisher probes; real random-key round trips are platform KATs.
for (const [path, start, end, resolver] of [
  ['ios/SharedKeyOps.swift', 'static func wrapChildKeys', 'static func adoptWrap', 'fileKey(master: master, fileId: id, registry: registry)'],
  ['android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt', 'fun wrapChildKeys', 'fun adoptWrap', 'borrowFileKey(master, id, registry)'],
]) test(`${path}: child_publication_uses_the_loaded_key`, () => {
  const publisher = read(path).split(start)[1].split(end)[0]
  expect(publisher.includes(resolver)).toBe(true)
  expect(publisher.includes('master.deriveFileKey')).toBe(false)
})

// F7: ported disposal probe. JVM tests count actual close calls on owned fake handles.
test('android_registry_explicitly_disposes_released_replaced_and_cleared_handles', () => {
  const registry = read('android/src/main/java/expo/modules/beebeebcrypto/SharedKeyRegistry.kt')
  expect(registry.includes('private val dispose: (H) -> Unit')).toBe(true)
  expect(registry.includes('disposeIfUnreferenced')).toBe(true)
  expect(registry.includes('java.util.IdentityHashMap<H, Int>')).toBe(true)
  expect(registry.includes('files.values.none')).toBe(false)
  expect(registry.includes('discarded.keys.forEach')).toBe(true)
  expect(registry.includes('try { dispose(it) }')).toBe(true)
  const ops = read('android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt')
  expect(ops.includes('SharedKeyRegistry<FileKeyHandle> { it.close() }')).toBe(true)
})
