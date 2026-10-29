// @ts-nocheck — bun:test types are outside the Expo tsconfig.
import { expect, test } from 'bun:test';
import { parseFolderAccessLevel, linkErrorCode } from './folder-link-types';
test('parseFolderAccessLevel_degrades_unknown_to_view', () => {
  expect(['view', 'add', 'edit', 'owner', 'future'].map(parseFolderAccessLevel)).toEqual(['view', 'add', 'edit', 'view', 'view']);
});
test('linkErrorCode_reads_the_server_code', () => {
  for (const code of ['folder_key_missing', 'too_many_links', 'token_taken', 'nested_share', 'cap_below_used', 'shared_folders_v1']) expect(linkErrorCode({ code })).toBe(code);
  expect(linkErrorCode({ status: 501 })).toBe('shared_folders_v1');
  expect(linkErrorCode(new Error('token_taken'))).toBe('unknown');
});
