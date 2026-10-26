// @ts-nocheck -- execute real config-plugin mutations on a parsed project fixture.
import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mods: Array<(config: any) => Promise<any>> = [];
mock.module('@expo/config-plugins', () => ({
  withXcodeProject: (config, mod) => { mods.push(mod); return config; },
  withInfoPlist: (config) => config,
  withEntitlementsPlist: (config) => config,
}));
const root = join(import.meta.dir, '../..');
const xcode = require('xcode');
const fp = require('../../plugins/file-provider/withFileProvider');
const share = require('../../plugins/share-extension/withShareExtension');
function membership(project) {
  const o = project.hash.project.objects;
  const refs = new Set(Object.entries(o.PBXFileReference).filter(([id, f]) => typeof f === 'object' && f.path?.replaceAll('"','') === 'Beebeeb/beebeeb_uniffi.swift').map(([id]) => id));
  const groups = Object.entries(o.PBXGroup).filter(([id, g]) => typeof g === 'object' && g.children?.some(c => refs.has(c.value))).map(([id]) => id);
  const files = Object.entries(o.PBXBuildFile).filter(([id, f]) => typeof f === 'object' && refs.has(f.fileRef)).map(([id]) => id);
  const sourceMembership = Object.values(o.PBXSourcesBuildPhase).filter(p => typeof p === 'object').flatMap(p => p.files.filter(f => files.includes(f.value)).map(f => f.value));
  return { groups, sourceMembership };
}
test('extension plugins keep UniFFI in one navigator group and every source phase, including repeated runs', async () => {
  const project = xcode.project(join(root, 'ios/Beebeeb.xcodeproj/project.pbxproj')); project.parseSync();
  // Recreate legacy navigator aliases even after the committed project is regenerated.
  const o = project.hash.project.objects;
  const alias = 'DEADBEEFDEADBEEFDEADBEEF';
  const original = Object.entries(o.PBXFileReference).find(([id, f]) => typeof f === 'object' && f.path === 'Beebeeb/beebeeb_uniffi.swift');
  o.PBXFileReference[alias] = { ...original[1] };
  for (const group of Object.values(o.PBXGroup)) {
    if (typeof group === 'object' && ['BeebeebFileProvider', 'BeebeebShare'].includes(group.name))
      group.children.push({value:alias, comment:'beebeeb_uniffi.swift'});
  }
  const before = membership(project);
  expect(before.groups.length).toBeGreaterThan(1);
  expect(before.sourceMembership.length).toBe(4);
  const dir = mkdtempSync(join(tmpdir(), 'bb-xcode-groups-'));
  try {
    fp({}); share({});
    let config = { modResults: project, modRequest: { projectRoot: root, platformProjectRoot: dir } };
    for (const mod of mods) config = await mod(config);
    const once = membership(project);
    expect(once.groups.length).toBe(1);
    expect(once.sourceMembership.length).toBe(4);
    expect(new Set(once.sourceMembership).size).toBe(4);
    for (const mod of mods) config = await mod(config);
    expect(membership(project)).toEqual(once);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
