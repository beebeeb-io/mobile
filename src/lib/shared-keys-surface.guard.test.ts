// @ts-nocheck — run by bun's isolated file runner.
import { test, expect, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const swift = () => readFileSync(resolve(root, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'), 'utf8')
const kotlin = () => readFileSync(resolve(root, 'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt'), 'utf8')
const names = ['sharedFolderOpenOwnerKey', 'sharedFolderGenerate', 'sharedFolderRelease', 'sharedFileKeysLoad',
  'sharedFileKeyOpenOwnerWrap', 'sharedFileKeyIsLoaded', 'sharedWrapChildKeys', 'sharedAdoptWrap',
  'sharedFolderEncryptName', 'sharedFolderDecryptName', 'folderLinkMint', 'folderLinkRecoverKc', 'sharedKeysClear']
const native: any = Object.fromEntries(names.map(n => [n, () => {}]))
mock.module('expo', () => ({ requireNativeModule: () => native }))
mock.module('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }))
const bridge = await import('../../modules/beebeeb-crypto/src/BeebeebCrypto')

test('both_native_platforms_and_JS_expose_the_same_13_names', () => {
  for (const source of [swift(), kotlin()]) {
    const exposed = [...source.matchAll(/(?:AsyncFunction|Function)\("([^"]+)"\)/g)].map(m => m[1])
    expect(names.filter(n => exposed.includes(n))).toEqual(names)
  }
  for (const name of names) expect(typeof bridge[name]).toBe('function')
})
test('complete_native_surface_is_ready', () => { expect(bridge.isSharedKeysNativeReady()).toBe(true) })
for (const name of names) test(`isSharedKeysNativeReady_is_false_when_${name}_is_missing`, () => {
  const fn = native[name]; delete native[name]
  try { expect(bridge.isSharedKeysNativeReady()).toBe(false) } finally { native[name] = fn }
})
test('releaseHandle_clears_the_shared_registry', () => {
  const s = swift()
  for (const name of ['releaseHandle', 'clearCachedMasterKey', 'purgePlaintextStorage']) {
    const block = s.split(`AsyncFunction("${name}")`)[1]?.split(/\n    (?:AsyncFunction|Function)\(/)[0]
    expect(block).toContain('sharedKeys.clear()')
    if (name === 'releaseHandle') expect(block.indexOf('sharedKeys.clear()')).toBeLessThan(block.indexOf('if self.masterKeyHandles.isEmpty'))
  }
})
test('android_release_and_clear_are_wired_to_shared_clear', () => {
  const s = readFileSync(resolve(root, 'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoHandleRegistry.kt'), 'utf8')
  expect(s.split('fun release(')[1]?.split('/**')[0]).toContain('onCleared?.invoke()')
  expect(s.split('fun clear()')[1]).toContain('onCleared?.invoke()')
  expect(kotlin()).toContain('onCleared = { sharedKeys.clear() }')
})
test('owner_wrapping_keeps_master_bytes_inside_Rust', () => {
  for (const source of [swift(), kotlin()]) {
    const block = source.split('AsyncFunction("wrapForOwnerWithHandle")')[1]?.split('AsyncFunction("unwrapForOwnerWithHandle")')[0]
    expect(block).toContain('wrapBytes')
    expect(block).not.toContain('exportForKeychain')
  }
  for (const relative of ['ios/SharedKeyOps.swift', 'android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt']) {
    expect(readFileSync(resolve(root, 'modules/beebeeb-crypto', relative), 'utf8')).not.toContain('exportForKeychain')
  }
})

test('L7_child_paths_bind_root_item_and_kind_without_legacy_retry', () => {
  for (const relative of ['ios/SharedKeyOps.swift', 'android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt']) {
    const source = readFileSync(resolve(root, 'modules/beebeeb-crypto', relative), 'utf8')
    const load = source.split('func loadFileKeys')[1]?.split('func openOwnerFileKey')[0] ?? source.split('fun loadFileKeys')[1]?.split('fun openOwnerFileKey')[0]
    expect(load).toContain('unwrapFolderChild')
    expect(load).toContain('entry.kind')
    expect(load).toContain('folder.folderId')
    expect(load).not.toMatch(/unwrap\(key|unwrapKey/)
    const wrap = source.split('func wrapChildKeys')[1]?.split('func adoptWrap')[0] ?? source.split('fun wrapChildKeys')[1]?.split('fun adoptWrap')[0]
    expect(wrap).toContain('wrapFolderChild')
    expect(wrap).toContain('folder.folderId')
    expect(wrap).not.toContain('wrapKey(')
  }
})
test('L7_bridge_preserves_kind_on_read', async () => {
  let args: any[] = []
  native.sharedFileKeysLoad = (...a) => { args = a; return {loaded: [], failed: []} }
  await bridge.sharedFileKeysLoad(1, 2, [{fileId: 'item', kind: 2, wrapped: new Uint8Array([3])}])
  expect(args[2]).toEqual([{fileId: 'item', kind: 2, wrapped: [3]}])
})
test('L7_bridge_preserves_kind_on_write', async () => {
  let args: any[] = []
  native.sharedWrapChildKeys = (...a) => { args = a; return [{fileId: 'item', kind: 2, wrapped: new Uint8Array([3])}] }
  const rows = await bridge.sharedWrapChildKeys(1, 2, ['item'], 2)
  expect(args[3]).toBe(2)
  expect(rows[0].kind).toBe(2)
})

// L8/F2: native-source ports of rv-mobile236's owner-wrap confusion probe.
// Real content/name rejection and the pinned L8 vector run in platform KATs.
for (const [path, fn] of [['ios/SharedKeyOps.swift', 'func'], ['android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt', 'fun']]) {
  test(`${path}: owner_file_wrap_uses_only_the_L8_handle_API`, () => {
    const source = readFileSync(resolve(root, 'modules/beebeeb-crypto', path), 'utf8')
    const open = source.split(`${fn} openOwnerFileKey`)[1].split(`${fn} wrapChildKeys`)[0]
    const seal = source.split(`${fn} adoptWrap`)[1].split(`${fn} fileKey`)[0]
    expect(open.includes('unwrapOwnerFileKey')).toBe(true)
    expect(open.includes('deriveFileKey')).toBe(false)
    expect(open.includes('unwrapKey(')).toBe(false)
    expect(seal.includes('wrapOwnerFileKey')).toBe(true)
    expect(seal.includes('deriveFileKey')).toBe(false)
  })
}
test('core_pin_and_fixtures_are_the_exact_L8_merge', () => {
  expect(readFileSync(resolve(root, 'modules/beebeeb-crypto/CORE_REV'), 'utf8').trim()).toBe('c08defc70c35428926be6784d18ff091be6d004c')
  const { createHash } = require('node:crypto')
  for (const path of ['ios/BeebeebNativeTests/Vectors/core-vectors.v10.json', 'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v10.json'])
    expect(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')).toBe('11f7522056d0c12eff92d2f37a5fa6975ce460cf36899e3a6a92f3455a4d754a')
})
