/** Wire shapes of the shared-folder routes the key resolver and the key publisher call (2237c). */
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
export interface SharedFolderInfo {
  folder_id: string;
  role: 'owner' | 'member';
  access_level: FolderAccessLevel;
  key_version: number;
  owner_wrapped_folder_key: string | null;
  wrapped_folder_key: string | null;
}
export interface SharedFolderKeyRow { file_id: string; encrypted_file_key: string }
