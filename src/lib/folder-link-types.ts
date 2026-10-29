/** Shared-folder wire contract (2237c); unknown access levels fail closed. */
// The link, folder-info and key-row shapes live with the resolver and publisher that need them (#233).
import type { FolderAccessLevel, FolderLink, SharedFolderInfo, SharedFolderKeyRow } from './shared-folder-api-types';
export type { FolderAccessLevel, FolderLink, SharedFolderInfo, SharedFolderKeyRow } from './shared-folder-api-types';
export interface CreatedFolderLink extends FolderLink { token: string; key_version: number }
export interface FolderMember { user_id: string; email: string; role: 'owner' | 'member'; access_level: FolderAccessLevel; is_owner?: boolean }
export interface SharedFolderActivityRow {
  id: string;
  kind: 'files_added' | 'items_renamed' | 'items_moved' | 'items_deleted';
  share_id: string | null;
  share_label_encrypted: string | null;
  actor_user_id: string | null;
  actor_name_encrypted: string | null;
  item_count: number;
  first_at: string;
  last_at: string;
}
export interface CreateFolderLinkBody {
  folder_id: string;
  token: string;
  access_level: FolderAccessLevel;
  wrapped_folder_key: string;
  owner_wrapped_key: string;
  owner_wrapped_token: string;
  label_encrypted?: string;
  expires_in_hours?: number;
  cap_bytes?: number;
  passphrase?: string;
}
export interface FolderLinkPatch {
  access_level?: FolderAccessLevel;
  label_encrypted?: string;
  expires_in_hours?: number | null;
  cap_bytes?: number | null;
  paused?: boolean;
}
export function parseFolderAccessLevel(value: string): FolderAccessLevel {
  return value === 'add' || value === 'edit' ? value : 'view';
}
const linkCodes = ['folder_key_missing', 'too_many_links', 'token_taken', 'nested_share', 'cap_below_used', 'shared_folders_v1'] as const;
// The 409 codes request() must keep on ApiError.code: link creation branches on them. `shared_folders_v1` is
// derived from the 501 status, and `key_version_conflict` belongs to the custody registration.
const serverCodes: readonly string[] = [...linkCodes.filter(code => code !== 'shared_folders_v1'), 'key_version_conflict'];
export function isFolderLinkServerCode(code: unknown): boolean { return typeof code === 'string' && serverCodes.includes(code); }
export function linkErrorCode(err: unknown): typeof linkCodes[number] | 'unknown' {
  if (!err || typeof err !== 'object') return 'unknown';
  const { code, status } = err as { code?: unknown; status?: unknown };
  if (status === 501) return 'shared_folders_v1';
  return linkCodes.find(value => value === code) ?? 'unknown';
}
