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
