/** Shared-folder wire contract (2237c); unknown access levels fail closed. */
export type FolderAccessLevel = 'view' | 'add' | 'edit';
export interface FolderLink {
  id: string;
  folder_id: string;
  access_level: FolderAccessLevel;
  label_encrypted: string | null;
  expires_at: string | null;
  max_opens: number | null;
  open_count: number | null;
  download_count: number | null;
  paused: boolean;
  cap_bytes: number | null;
  cap_used_bytes: number;
  passphrase_protected: boolean;
  created_at: string;
  revoked_at: string | null;
  wrapped_folder_key: string | null;
  owner_wrapped_key: string | null;
  owner_wrapped_token: string | null;
}
export interface CreatedFolderLink extends FolderLink { token: string; key_version: number }
export interface FolderMember { user_id: string; email: string; role: 'owner' | 'member'; access_level: FolderAccessLevel; is_owner?: boolean }
export interface SharedFolderInfo {
  folder_id: string;
  role: 'owner' | 'member';
  access_level: FolderAccessLevel;
  key_version: number;
  owner_wrapped_folder_key: string | null;
  wrapped_folder_key: string | null;
}
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
export interface SharedFolderKeyRow { file_id: string; encrypted_file_key: string }
export function parseFolderAccessLevel(value: string): FolderAccessLevel {
  return value === 'add' || value === 'edit' ? value : 'view';
}
const linkCodes = ['folder_key_missing', 'too_many_links', 'token_taken', 'nested_share', 'cap_below_used', 'shared_folders_v1'] as const;
export function linkErrorCode(err: unknown): typeof linkCodes[number] | 'unknown' {
  if (!err || typeof err !== 'object') return 'unknown';
  const { code, status } = err as { code?: unknown; status?: unknown };
  if (status === 501) return 'shared_folders_v1';
  return linkCodes.find(value => value === code) ?? 'unknown';
}
