/**
 * Beebeeb API client.
 *
 * Talks to the Rust backend at localhost:3001 in dev.
 * All file data is encrypted ciphertext -- the server never sees plaintext.
 */

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

// Dev defaults per platform. Override at build time with EXPO_PUBLIC_API_URL
// or via expoConfig.extra.apiUrl (e.g. through eas.json env or app.config.ts).
// - iOS simulator + web reach the host via `localhost`.
// - Android emulator reaches the host via the special 10.0.2.2 loopback.
// - Physical devices need EXPO_PUBLIC_API_URL set to the LAN URL of the API.
function resolveBaseUrl(): string {
  const configured =
    (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
    process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured;

  if (Platform.OS === 'android') return 'http://10.0.2.2:3001';
  return 'http://localhost:3001';
}

const BASE_URL = resolveBaseUrl();
const TOKEN_KEY = 'beebeeb_session_token';

/** Base URL for raw fetch / SSE callers that bypass `request()`. */
export function getApiUrl(): string {
  return BASE_URL;
}

// expo-secure-store has no web implementation — fall back to localStorage so
// the dev preview works in a browser. Native targets always use SecureStore.
const tokenStore = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

// ---------------------------------------------------------------------------
// Session-expired callback (registered by AuthProvider)
// ---------------------------------------------------------------------------

type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler | null = null;

/** Register a callback invoked when the server returns 401 (token expired). */
export function registerSessionExpiredHandler(fn: SessionExpiredHandler): void {
  onSessionExpired = fn;
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await tokenStore.get(TOKEN_KEY);
  return cachedToken;
}

export async function setToken(token: string): Promise<void> {
  cachedToken = token;
  await tokenStore.set(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  cachedToken = null;
  await tokenStore.remove(TOKEN_KEY);
}

/** Fast check: is there a stored session token? */
export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Return a human-friendly message for common API errors. */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 401) {
      // The message is set by the caller's path: login/signup => "Wrong email or password",
      // authenticated requests => "Session expired".
      return err.message || 'Session expired. Please sign in again.';
    }
    if (err.status === 409) return err.message || 'A resource with that name already exists.';
    if (err.status === 422) return err.message || 'Invalid input. Please check your details.';
    return err.message || 'Something went wrong. Please try again.';
  }
  if (err instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

async function headers(auth = true, extra?: Record<string, string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  }
  if (extra) Object.assign(h, extra);
  return h;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: await headers(auth, extraHeaders),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 401) {
    // Only treat 401s on authenticated calls as session expiry — a 401 from
    // /auth/login or /auth/signup means "wrong credentials" and should NOT
    // trigger sign-out.
    if (auth) {
      await clearToken();
      onSessionExpired?.();
      throw new ApiError(401, 'Session expired');
    }
    throw new ApiError(401, 'Wrong email or password.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? err.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthResponse {
  user_id: string;
  session_token: string;
  salt: string;
}

export interface User {
  user_id: string;
  email: string;
  email_verified: boolean;
  created_at: string;
}

export async function signup(email: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('POST', '/api/v1/auth/signup', { email, password }, false);
  await setToken(data.session_token);
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('POST', '/api/v1/auth/login', { email, password }, false);
  await setToken(data.session_token);
  return data;
}

export async function logout(): Promise<void> {
  await request('POST', '/api/v1/auth/logout');
  await clearToken();
}

export async function getMe(): Promise<User> {
  return request<User>('GET', '/api/v1/auth/me');
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('POST', '/api/v1/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export interface ConfirmActionResponse {
  confirmation_token: string;
  expires_at: string;
}

/** Thrown when /auth/confirm rejects the password — distinct from session expiry. */
export class IncorrectPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'IncorrectPasswordError';
  }
}

/**
 * Step-up re-auth: exchange the user's password for a short-lived
 * confirmation token. Destructive endpoints require it via the
 * X-Confirm-Token header.
 *
 * Uses a direct fetch (not `request()`) because a 401 here means
 * "wrong password," not "session expired" — we must NOT clear the token
 * or trigger sign-out. A typo on step-up should let the user retry.
 */
export async function confirmAction(password: string): Promise<ConfirmActionResponse> {
  const token = await getToken();
  if (!token) {
    // No session at all — surface as session expiry through the normal path.
    onSessionExpired?.();
    throw new ApiError(401, 'Session expired');
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/v1/auth/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ password }),
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 401) {
    throw new IncorrectPasswordError();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? err.message ?? res.statusText);
  }
  return res.json() as Promise<ConfirmActionResponse>;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileEntry {
  id: string;
  name_encrypted: string;
  mime_type: string | null;
  size_bytes: number;
  is_folder: boolean;
  chunk_count: number;
  created_at: string;
  updated_at: string;
  storage_pool_id?: string | null;
  /** Active share count — populated by the server when shares exist on the entry. */
  share_count?: number;
}

/**
 * Map a storage pool ID to a human-readable physical location.
 * Beebeeb stores files across multiple European data centers — users
 * can see exactly where each file lives.
 */
export interface StorageLocation {
  label: string;
  flag: string;
  shortCode: string;
}

export function storageLocation(poolId: string | null | undefined): StorageLocation {
  switch (poolId) {
    case 'hetzner-fsn':
    case 'fsn1':
    case 'falkenstein':
      return { label: 'Falkenstein, DE', flag: '🇩🇪', shortCode: 'DE' };
    case 'hetzner-hel':
    case 'hel1':
    case 'helsinki':
      return { label: 'Helsinki, FIN', flag: '🇫🇮', shortCode: 'FIN' };
    default:
      return { label: 'Europe', flag: '', shortCode: '' };
  }
}

/**
 * Trust-display location for the encryption details panel.
 * Always names the city + provider — the brand voice rule.
 */
export interface TrustLocation {
  region: string; // "Europe"
  city: string; // "Falkenstein"
  provider: string; // "Hetzner"
}

export function trustLocation(poolId: string | null | undefined): TrustLocation {
  switch (poolId) {
    case 'hetzner-fsn':
    case 'fsn1':
    case 'falkenstein':
      return { region: 'Europe', city: 'Falkenstein', provider: 'Hetzner' };
    case 'hetzner-hel':
    case 'hel1':
    case 'helsinki':
      return { region: 'Europe', city: 'Helsinki', provider: 'Hetzner' };
    default:
      // Until storage pools are wired through, default to Falkenstein.
      return { region: 'Europe', city: 'Falkenstein', provider: 'Hetzner' };
  }
}

export interface ListFilesResponse {
  files: FileEntry[];
}

export async function createFolder(name: string, parentId?: string): Promise<FileEntry> {
  return request<FileEntry>('POST', '/api/v1/files/folder', {
    name_encrypted: name,
    parent_id: parentId ?? null,
  });
}

export async function listFiles(parentId?: string, trashed = false): Promise<FileEntry[]> {
  const params = new URLSearchParams();
  if (parentId) params.set('parent_id', parentId);
  if (trashed) params.set('trashed', 'true');
  const qs = params.toString();
  const path = `/api/v1/files${qs ? `?${qs}` : ''}`;
  const data = await request<ListFilesResponse>('GET', path);
  return data.files;
}

export async function getFile(id: string): Promise<FileEntry> {
  return request<FileEntry>('GET', `/api/v1/files/${id}`);
}

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk
const SIMPLE_UPLOAD_THRESHOLD = 5 * 1024 * 1024; // 5 MB — below this, use simple upload

export interface UploadProgress {
  phase: 'preparing' | 'uploading' | 'finalizing';
  chunksTotal: number;
  chunksUploaded: number;
  bytesTotal: number;
  bytesUploaded: number;
}

export async function uploadFile(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  fileBlob: Blob,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FileEntry> {
  if (fileBlob.size <= SIMPLE_UPLOAD_THRESHOLD) {
    return uploadFileSimple(metadata, fileBlob, onProgress);
  }
  return uploadFileChunked(metadata, fileBlob, onProgress);
}

async function uploadFileSimple(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  fileBlob: Blob,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FileEntry> {
  onProgress?.({ phase: 'uploading', chunksTotal: 1, chunksUploaded: 0, bytesTotal: fileBlob.size, bytesUploaded: 0 });

  const token = await getToken();
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('chunk_0', fileBlob);

  const res = await fetch(`${BASE_URL}/api/v1/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? res.statusText);
  }

  onProgress?.({ phase: 'finalizing', chunksTotal: 1, chunksUploaded: 1, bytesTotal: fileBlob.size, bytesUploaded: fileBlob.size });
  return res.json() as Promise<FileEntry>;
}

/**
 * Encrypted chunked upload.
 *
 * Differs from the plain `uploadFileChunked` in two ways:
 * 1. Sends a client-generated `file_id` to the init endpoint so the server
 *    stores that UUID. The caller encrypts every chunk with a key derived from
 *    that UUID — the server must return the same ID so decryption works later.
 * 2. Accepts pre-encrypted binary chunks (nonce || ciphertext, each as
 *    Uint8Array) rather than plain Blob slices.
 *
 * `sizeBytes` must be the total **ciphertext** size, not the plaintext size.
 * For AES-256-GCM the overhead is deterministic: 12 (nonce) + 16 (auth tag)
 * = 28 bytes per chunk, so `ciphertextSize = plaintextSize + chunkCount × 28`.
 */
export async function uploadEncryptedChunked(params: {
  fileId: string                // client-generated UUID, sent to server
  nameEncrypted: string         // JSON {nonce:b64, ciphertext:b64}
  parentId?: string
  mimeType?: string
  sizeBytes: number             // total ciphertext size
  chunkCount: number
  onProgress?: (p: UploadProgress) => void
  /** Called once per chunk index — must return nonce||ciphertext bytes */
  readEncryptedChunk: (index: number) => Promise<Uint8Array>
}): Promise<FileEntry> {
  const { fileId, nameEncrypted, parentId, mimeType, sizeBytes, chunkCount, onProgress, readEncryptedChunk } = params
  const token = await getToken()

  onProgress?.({ phase: 'preparing', chunksTotal: chunkCount, chunksUploaded: 0, bytesTotal: sizeBytes, bytesUploaded: 0 })

  // ── Step 1: Init — register the file with the client-supplied file_id ──
  const initRes = await fetch(`${BASE_URL}/api/v1/files/upload/init`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: fileId,
      name_encrypted: nameEncrypted,
      parent_id: parentId ?? null,
      mime_type: mimeType ?? null,
      size_bytes: sizeBytes,
      chunk_count: chunkCount,
    }),
  })
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ error: initRes.statusText }))
    throw new ApiError(initRes.status, (err as { error?: string }).error ?? initRes.statusText)
  }
  const { file_id: serverFileId } = (await initRes.json()) as { file_id: string }

  // ── Step 2: Upload each encrypted chunk sequentially ───────────────────
  let bytesUploaded = 0
  for (let i = 0; i < chunkCount; i++) {
    const encBytes = await readEncryptedChunk(i)

    const chunkRes = await fetch(`${BASE_URL}/api/v1/files/${serverFileId}/chunks/${i}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      // Blob wrapping is the safest way to pass binary data to React Native's fetch
      body: new Blob([encBytes], { type: 'application/octet-stream' }),
    })
    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({ error: chunkRes.statusText }))
      throw new ApiError(chunkRes.status, (err as { error?: string }).error ?? `Chunk ${i} failed`)
    }

    bytesUploaded += encBytes.length
    onProgress?.({ phase: 'uploading', chunksTotal: chunkCount, chunksUploaded: i + 1, bytesTotal: sizeBytes, bytesUploaded })
  }

  // ── Step 3: Complete ───────────────────────────────────────────────────
  onProgress?.({ phase: 'finalizing', chunksTotal: chunkCount, chunksUploaded: chunkCount, bytesTotal: sizeBytes, bytesUploaded: sizeBytes })

  const completeRes = await fetch(`${BASE_URL}/api/v1/files/${serverFileId}/upload/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ error: completeRes.statusText }))
    throw new ApiError(completeRes.status, (err as { error?: string }).error ?? 'Finalize failed')
  }
  return completeRes.json() as Promise<FileEntry>
}

async function uploadFileChunked(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  fileBlob: Blob,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FileEntry> {
  const token = await getToken();
  const totalSize = fileBlob.size;
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);

  onProgress?.({ phase: 'preparing', chunksTotal: chunkCount, chunksUploaded: 0, bytesTotal: totalSize, bytesUploaded: 0 });

  // Step 1: Init upload — server creates the file record
  const initRes = await fetch(`${BASE_URL}/api/v1/files/upload/init`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name_encrypted: metadata.name_encrypted,
      parent_id: metadata.parent_id ?? null,
      mime_type: metadata.mime_type ?? null,
      size_bytes: metadata.size_bytes,
      chunk_count: chunkCount,
    }),
  });
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ error: initRes.statusText }));
    throw new ApiError(initRes.status, err.error ?? err.message ?? initRes.statusText);
  }
  const { file_id } = (await initRes.json()) as { file_id: string; chunk_count: number };

  // Step 2: Upload each chunk sequentially
  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunk = fileBlob.slice(start, end);

    const chunkRes = await fetch(`${BASE_URL}/api/v1/files/${file_id}/chunks/${i}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({ error: chunkRes.statusText }));
      throw new ApiError(chunkRes.status, err.error ?? `Chunk ${i} upload failed`);
    }

    onProgress?.({
      phase: 'uploading',
      chunksTotal: chunkCount,
      chunksUploaded: i + 1,
      bytesTotal: totalSize,
      bytesUploaded: end,
    });
  }

  // Step 3: Complete upload — server finalizes the file
  onProgress?.({ phase: 'finalizing', chunksTotal: chunkCount, chunksUploaded: chunkCount, bytesTotal: totalSize, bytesUploaded: totalSize });

  const completeRes = await fetch(`${BASE_URL}/api/v1/files/${file_id}/upload/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ error: completeRes.statusText }));
    throw new ApiError(completeRes.status, err.error ?? 'Failed to finalize upload');
  }
  return completeRes.json() as Promise<FileEntry>;
}

/**
 * Upload a thumbnail blob for a file. Server caps payloads at 512KB.
 * Best-effort: callers should fire-and-forget so a failed thumbnail
 * never blocks the upload success flow.
 */
export async function uploadThumbnail(fileId: string, blob: Blob): Promise<void> {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}/api/v1/files/${fileId}/thumbnail`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: blob,
  });
  if (!res.ok) {
    throw new ApiError(res.status, `Thumbnail upload failed (HTTP ${res.status})`);
  }
}

export async function downloadFile(id: string): Promise<Response> {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}/api/v1/files/${id}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, 'Download failed');
  }
  return res;
}

export async function deleteFile(id: string): Promise<void> {
  await request('DELETE', `/api/v1/files/${id}`);
}

export async function renameFile(id: string, newName: string): Promise<void> {
  await request('POST', `/api/v1/files/${id}/rename`, { name_encrypted: newName });
}

export async function moveFile(fileId: string, newParentId: string | null): Promise<void> {
  await request('POST', `/api/v1/files/${fileId}/move`, { parent_id: newParentId });
}

export async function restoreFile(id: string): Promise<void> {
  await request('POST', `/api/v1/files/${id}/restore`);
}

export async function permanentDeleteFile(id: string, confirmToken?: string): Promise<void> {
  await request(
    'DELETE',
    `/api/v1/files/${id}/permanent`,
    undefined,
    true,
    confirmToken ? { 'X-Confirm-Token': confirmToken } : undefined,
  );
}

export async function emptyTrash(confirmToken?: string): Promise<void> {
  await request(
    'POST',
    '/api/v1/files/trash/empty',
    undefined,
    true,
    confirmToken ? { 'X-Confirm-Token': confirmToken } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Proof of Existence
// ---------------------------------------------------------------------------

/**
 * A timestamp-verifiable proof that a specific file existed at a specific moment,
 * without revealing the file's content. The server stores `hash` (SHA-256 of the
 * encrypted blob) + `timestamp`; anyone with the `proofId` can verify both later.
 */
export interface ProofOfExistence {
  hash: string;
  timestamp: string;
  proofId: string;
}

export async function createProofOfExistence(fileId: string): Promise<ProofOfExistence> {
  return request<ProofOfExistence>('POST', `/api/v1/files/${fileId}/proof`);
}

export async function getProofOfExistence(fileId: string): Promise<ProofOfExistence | null> {
  try {
    return await request<ProofOfExistence>('GET', `/api/v1/files/${fileId}/proof`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export interface Share {
  id: string;
  token: string;
  url: string;
  expires_at: string | null;
  max_opens: number | null;
  /** True when the share was created in double-encrypted mode. */
  double_encrypted?: boolean;
}

export interface ShareCreateOpts {
  expires_in_hours?: number;
  max_opens?: number;
  passphrase?: string;
  /**
   * Double-encrypted mode: base64(nonce(12) || AES-256-GCM-ciphertext(48)) = 80 chars.
   * When set, the server stores this opaque blob. The client key K_c lives only in
   * the URL fragment (#key=…) and is never sent to the server.
   */
  wrapped_file_key?: string;
}

export async function createShare(
  fileId: string,
  opts?: ShareCreateOpts,
): Promise<Share> {
  return request<Share>('POST', '/api/v1/shares', { file_id: fileId, ...opts });
}

export async function listMyShares(): Promise<Share[]> {
  return request<Share[]>('GET', '/api/v1/shares/mine');
}

export interface ShareInfo {
  token: string;
  file_name_encrypted?: string;
  size_bytes?: number;
  mime_type?: string | null;
  sender_email?: string;
  expires_at?: string | null;
  passphrase_required?: boolean;
  is_folder?: boolean;
  /**
   * True when the share was created in double-encrypted mode.
   * The #key= fragment in the URL holds K_c (not the file key directly).
   * The server stores an opaque wrapped_file_key blob.
   */
  double_encrypted?: boolean;
}

/** Fetch public share metadata by token — no auth required. */
export async function getShareByToken(token: string): Promise<ShareInfo> {
  return request<ShareInfo>('GET', `/api/v1/shares/token/${token}`, undefined, false);
}

// ---------------------------------------------------------------------------
// Share invites
// ---------------------------------------------------------------------------

export interface ShareInvite {
  id: string;
  file_id: string;
  sender_id: string;
  recipient_email: string;
  status: string;
  created_at: string;
  claimed_at?: string;
  approved_at?: string;
  file_name_encrypted?: string;
  sender_email?: string;
  sender_public_key?: string;
  recipient_public_key?: string;
  can_reshare?: boolean;
  expires_at?: string | null;
  size_bytes?: number;
  is_folder?: boolean;
  chunk_count?: number;
  mime_type?: string;
  encrypted_file_key?: string;
  is_folder_share?: boolean;
  encrypted_folder_key?: string;
  encrypted_owner_folder_key?: string;
}

export async function getIncomingInvites(): Promise<ShareInvite[]> {
  const data = await request<{ invites: ShareInvite[] }>('GET', '/api/v1/shares/invites/incoming');
  return data.invites ?? [];
}

export async function getSentInvites(): Promise<ShareInvite[]> {
  const data = await request<{ invites: ShareInvite[] }>('GET', '/api/v1/shares/invites/sent');
  return data.invites ?? [];
}

// ---------------------------------------------------------------------------
// Folder presence (collaborators currently viewing a folder)
// ---------------------------------------------------------------------------

export interface PresenceUser {
  id: string;
  email: string;
  initials: string;
}

/**
 * Returns the list of users currently active in a shared folder.
 * The endpoint is best-effort — returns an empty list if it is unavailable
 * (e.g. server has not been upgraded yet, or the folder is not shared).
 */
export async function getFolderPresence(folderId: string): Promise<PresenceUser[]> {
  return request<PresenceUser[]>('GET', `/api/v1/files/${folderId}/presence`).catch(() => []);
}

// ---------------------------------------------------------------------------
// Storage usage
// ---------------------------------------------------------------------------

export interface StorageUsage {
  used_bytes: number;
  plan_limit_bytes: number;
  plan_name: string;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  return request<StorageUsage>('GET', '/api/v1/files/usage');
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getPreference(key: string): Promise<string | null> {
  try {
    const data = await request<{ key: string; value: string }>('GET', `/api/v1/preferences/${key}`);
    return data.value ?? null;
  } catch {
    return null;
  }
}

export async function setPreference(key: string, value: string): Promise<void> {
  await request('PUT', `/api/v1/preferences/${key}`, { value });
}

// ---------------------------------------------------------------------------
// Billing / subscription
// ---------------------------------------------------------------------------

export interface Subscription {
  plan: string;
  billing_cycle: string | null;
  status: string;
  current_period_end: string | null;
}

export async function getSubscription(): Promise<Subscription | null> {
  try {
    const data = await request<{ subscription: Subscription | null }>('GET', '/api/v1/billing/subscription');
    return data.subscription ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface Region {
  region: string;
  operator: string;
  jurisdiction: string;
}

export async function getRegion(): Promise<Region> {
  return request<Region>('GET', '/api/v1/region', undefined, false);
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/** Returns the authenticated download URL for use with expo-file-system. */
export function getDownloadUrl(id: string): string {
  return `${BASE_URL}/api/v1/files/${id}/download`;
}

// ---------------------------------------------------------------------------
// Base64 helpers for binary transport
// ---------------------------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// OPAQUE authentication
// ---------------------------------------------------------------------------

export interface OpaqueLoginStartResult {
  state: Uint8Array;
  serverMessage: Uint8Array;
}

export interface OpaqueLoginResult {
  sessionToken: string;
  masterKey: Uint8Array;
}

export interface OpaqueRegistrationStartResult {
  state: Uint8Array;
  serverMessage: Uint8Array;
}

/** Sentinel thrown when OPAQUE can't run because the native crypto module is absent. */
export class NativeCryptoUnavailableError extends Error {
  readonly code = 'NATIVE_CRYPTO_UNAVAILABLE' as const;
  constructor(method: string) {
    super(`Native crypto module not available — cannot run ${method}. Use plain auth fallback.`);
    this.name = 'NativeCryptoUnavailableError';
  }
}

/**
 * Round 1 of OPAQUE login.
 * Throws ApiError with status 404 when server does not support OPAQUE — caller
 * should fall back to the legacy /auth/login endpoint.
 * Throws NativeCryptoUnavailableError when running in Expo Go without the
 * native module — caller should fall back to plain login().
 */
export async function opaqueLoginStart(email: string, password: string): Promise<OpaqueLoginStartResult> {
  if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueLoginStart');
  let state: Uint8Array;
  let message: Uint8Array;
  try {
    ({ state, message } = await BeebeebCrypto.opaqueLoginStart(email, password));
  } catch {
    throw new NativeCryptoUnavailableError('opaqueLoginStart');
  }
  const data = await request<{ server_message: string }>(
    'POST',
    '/api/v1/auth/opaque/login-start',
    { email, client_message: uint8ToBase64(message) },
    false,
  );
  return { state, serverMessage: base64ToUint8(data.server_message) };
}

/**
 * Round 2 of OPAQUE login.
 * Returns the session token and the derived master key (sessionKey from OPAQUE).
 */
export async function opaqueLoginFinish(
  email: string,
  password: string,
  state: Uint8Array,
  serverMessage: Uint8Array,
): Promise<OpaqueLoginResult> {
  if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueLoginFinish');
  let sessionKey: Uint8Array;
  try {
    ({ sessionKey } = await BeebeebCrypto.opaqueLoginFinish(state, serverMessage, password));
  } catch {
    throw new NativeCryptoUnavailableError('opaqueLoginFinish');
  }
  const data = await request<{ session_token: string }>(
    'POST',
    '/api/v1/auth/opaque/login-finish',
    { email, session_key: uint8ToBase64(sessionKey) },
    false,
  );
  await setToken(data.session_token);
  return { sessionToken: data.session_token, masterKey: sessionKey };
}

/**
 * Round 1 of OPAQUE registration.
 * Throws ApiError with status 404 when server does not support OPAQUE — caller
 * should fall back to the legacy /auth/signup endpoint.
 * Throws NativeCryptoUnavailableError when running in Expo Go without the
 * native module — caller should fall back to plain signup().
 */
export async function opaqueRegistrationStart(
  email: string,
  password: string,
): Promise<OpaqueRegistrationStartResult> {
  if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueRegistrationStart');
  let state: Uint8Array;
  let message: Uint8Array;
  try {
    ({ state, message } = await BeebeebCrypto.opaqueRegistrationStart(email, password));
  } catch {
    throw new NativeCryptoUnavailableError('opaqueRegistrationStart');
  }
  const data = await request<{ server_message: string }>(
    'POST',
    '/api/v1/auth/opaque/register-start',
    { email, client_message: uint8ToBase64(message) },
    false,
  );
  return { state, serverMessage: base64ToUint8(data.server_message) };
}

/**
 * Round 2 of OPAQUE registration.
 * Uploads the credential record to the server and returns the session token.
 */
export async function opaqueRegistrationFinish(
  email: string,
  password: string,
  state: Uint8Array,
  serverMessage: Uint8Array,
): Promise<{ sessionToken: string }> {
  if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueRegistrationFinish');
  let record: Uint8Array;
  try {
    ({ record } = await BeebeebCrypto.opaqueRegistrationFinish(state, serverMessage, password));
  } catch {
    throw new NativeCryptoUnavailableError('opaqueRegistrationFinish');
  }
  const data = await request<{ session_token: string }>(
    'POST',
    '/api/v1/auth/opaque/register-finish',
    { email, record: uint8ToBase64(record) },
    false,
  );
  await setToken(data.session_token);
  return { sessionToken: data.session_token };
}

// ---------------------------------------------------------------------------
// Sync engine (CRDT op log + SSE)
// Spec: docs/superpowers/specs/2026-05-02-crdt-sync-engine-design.md
// ---------------------------------------------------------------------------

export interface SyncNode {
  id: string;
  name_encrypted: string;
  parent_id: string | null;
  is_folder: boolean;
  size_bytes: number;
  mime_type: string | null;
  content_hash: string | null;
  version_number: number;
  has_thumbnail: boolean;
  storage_pool_id: string | null;
  is_trashed: boolean;
  is_starred: boolean;
  chunk_count?: number;
  created_at: string;
  updated_at: string;
}

export interface SyncOp {
  seq_id: number;
  op_type: string;
  client_op_id?: string;
  payload: Record<string, unknown>;
  device_id?: string;
  created_at: string;
}

export interface SyncSnapshot {
  seq_id: number;
  nodes: SyncNode[];
}

export interface SubmittedSyncOp {
  client_op_id: string;
  op_type: string;
  payload: Record<string, unknown>;
  device_id?: string;
}

export interface SyncOpsResult {
  applied: { seq_id: number; client_op_id: string }[];
  rejected: {
    client_op_id: string;
    reason: string;
    winning_op?: { op_type: string; payload: Record<string, unknown> };
  }[];
}

export interface StreamTokenResponse {
  stream_token: string;
  expires_at: string;
}

export async function getSnapshot(): Promise<SyncSnapshot> {
  return request<SyncSnapshot>('GET', '/api/v1/sync/snapshot');
}

export async function getSyncOps(since: number): Promise<SyncOp[]> {
  const data = await request<{ ops: SyncOp[] }>(
    'GET',
    `/api/v1/sync/ops?since=${encodeURIComponent(String(since))}`,
  );
  return data.ops ?? [];
}

export async function submitSyncOps(ops: SubmittedSyncOp[]): Promise<SyncOpsResult> {
  return request<SyncOpsResult>('POST', '/api/v1/sync/ops', { ops });
}

export async function getStreamToken(): Promise<StreamTokenResponse> {
  return request<StreamTokenResponse>('POST', '/api/v1/sync/stream-token');
}

// ---------------------------------------------------------------------------
// Photo backup
// ---------------------------------------------------------------------------

/** Ask the server which of these local identifiers have NOT been backed up yet. */
export async function photoBackupCheck(
  identifiers: string[],
): Promise<{ needs_backup: string[] }> {
  return request<{ needs_backup: string[] }>(
    'POST',
    '/api/v1/files/photo-backup/check',
    { identifiers },
  );
}

/** Mark a local asset as successfully backed up and link it to the uploaded file. */
export async function photoBackupMark(
  identifier: string,
  fileId: string,
): Promise<void> {
  await request<void>(
    'POST',
    '/api/v1/files/photo-backup/mark',
    { identifier, file_id: fileId },
  );
}

export interface PhotoBackupStats {
  backed_up: number;
  total_estimated: number;
}

/** Get overall photo-backup progress stats for the current user. */
export async function photoBackupStats(): Promise<PhotoBackupStats> {
  return request<PhotoBackupStats>('GET', '/api/v1/files/photo-backup/stats');
}

// ─── Push notification registration ──────────────────────────────────────────

/** POST /api/v1/notifications/register-device */
export async function registerDeviceToken(params: {
  token: string;
  platform: 'ios' | 'android';
  device_id: string;
}): Promise<void> {
  await request<void>('POST', '/api/v1/notifications/register-device', params);
}

/** DELETE /api/v1/notifications/unregister-device */
export async function unregisterDeviceToken(): Promise<void> {
  await request<void>('DELETE', '/api/v1/notifications/unregister-device');
}

// ─── Notification preferences ─────────────────────────────────────────────────

export interface MobileNotificationPreferences {
  share_received: boolean;
  storage_warning: boolean;
  new_device_login: boolean;
  backup_complete: boolean;
}

/** GET /api/v1/notifications/preferences */
export async function getNotificationPreferences(): Promise<MobileNotificationPreferences> {
  return request<MobileNotificationPreferences>('GET', '/api/v1/notifications/preferences');
}

/** PUT /api/v1/notifications/preferences */
export async function setNotificationPreferences(
  prefs: MobileNotificationPreferences,
): Promise<MobileNotificationPreferences> {
  return request<MobileNotificationPreferences>('PUT', '/api/v1/notifications/preferences', prefs);
}

// ─── Privacy / DSAR (spec 025) ────────────────────────────────────────────────

export interface TrackingPreference {
  tracking_opted_in: boolean;
  opted_in_at: string | null;
  opted_out_at: string | null;
}

/** GET /api/v1/me/tracking */
export async function getTrackingPreference(): Promise<TrackingPreference> {
  return request<TrackingPreference>('GET', '/api/v1/me/tracking');
}

/** PUT /api/v1/me/tracking */
export async function setTrackingPreference(optedIn: boolean): Promise<TrackingPreference> {
  return request<TrackingPreference>('PUT', '/api/v1/me/tracking', { opted_in: optedIn });
}

export interface DataExportRequest {
  export_id: string;
  status: string;
  estimated_seconds?: number;
}

export interface DataExportStatus {
  export_id: string;
  status: string;
  file_count?: number;
  total_bytes?: number;
  download_url?: string;
  expires_at?: string;
}

/** POST /api/v1/me/data-export */
export async function requestDataExport(): Promise<DataExportRequest> {
  return request<DataExportRequest>('POST', '/api/v1/me/data-export');
}

/** GET /api/v1/me/data-export/:id */
export async function getDataExportStatus(exportId: string): Promise<DataExportStatus> {
  return request<DataExportStatus>('GET', `/api/v1/me/data-export/${exportId}`);
}

/** POST /api/v1/me/freeze */
export async function freezeAccount(): Promise<{ frozen: boolean }> {
  return request<{ frozen: boolean }>('POST', '/api/v1/me/freeze');
}

/** POST /api/v1/me/unfreeze */
export async function unfreezeAccount(): Promise<{ frozen: boolean }> {
  return request<{ frozen: boolean }>('POST', '/api/v1/me/unfreeze');
}

// ─── Plans + billing checkout ─────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  price_eur: number;
  price_yearly_eur: number;
  storage_bytes: number;
  storage_label: string;
  features: string[];
  is_active?: boolean;
}

/** GET /api/v1/billing/plans */
export async function getPlans(): Promise<Plan[]> {
  try {
    const data = await request<{ plans?: Plan[] } | Plan[]>('GET', '/api/v1/billing/plans');
    if (Array.isArray(data)) return data;
    if (Array.isArray((data as { plans?: Plan[] }).plans)) return (data as { plans: Plan[] }).plans;
    return [];
  } catch {
    return [];
  }
}

/** POST /api/v1/billing/checkout — starts a Stripe Checkout session */
export async function createCheckoutSession(params: {
  plan: string;
  billing_cycle: 'monthly' | 'yearly';
  seats?: number;
}): Promise<{ url: string }> {
  return request<{ url: string }>('POST', '/api/v1/billing/checkout', params);
}

/** POST /api/v1/billing/portal — opens Stripe Customer Portal */
export async function createPortalSession(): Promise<{ url: string } | null> {
  try {
    return await request<{ url: string }>('POST', '/api/v1/billing/portal');
  } catch {
    return null;
  }
}

// ─── Data residency (task 0051) ───────────────────────────────────────────────

export interface AvailableRegion {
  continent: string;
  display_name: string;
  city: string;
  provider: string;
  is_default: boolean;
}

/** GET /api/v1/me/region — user's preferred region + available list */
export async function getUserRegion(): Promise<{
  preferred_region: string | null;
  regions: AvailableRegion[];
}> {
  return request<{ preferred_region: string | null; regions: AvailableRegion[] }>(
    'GET', '/api/v1/me/region',
  );
}

/** PUT /api/v1/me/region — set preferred region */
export async function setUserRegion(continent: string): Promise<{ preferred_region: string }> {
  return request<{ preferred_region: string }>(
    'PUT', '/api/v1/me/region', { continent },
  );
}
