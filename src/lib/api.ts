/**
 * Beebeeb API client.
 *
 * Talks to the Rust backend at localhost:3001 in dev.
 * All file data is encrypted ciphertext -- the server never sees plaintext.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

const BASE_URL = Platform.OS === 'web' ? 'http://localhost:3001' : 'http://10.100.0.55:3001';
const TOKEN_KEY = 'beebeeb_session_token';

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
    if (err.status === 409) return 'An account with this email already exists.';
    if (err.status === 422) return err.message || 'Invalid input. Please check your details.';
    return err.message || 'Something went wrong. Please try again.';
  }
  if (err instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

async function headers(auth = true): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  }
  return h;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: await headers(auth),
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

export async function permanentDeleteFile(id: string): Promise<void> {
  await request('DELETE', `/api/v1/files/${id}/permanent`);
}

export async function emptyTrash(): Promise<void> {
  await request('POST', '/api/v1/files/trash/empty');
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
}

export async function createShare(
  fileId: string,
  opts?: { expires_in_hours?: number; max_opens?: number; passphrase?: string },
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

/**
 * Round 1 of OPAQUE login.
 * Throws ApiError with status 404 when server does not support OPAQUE — caller
 * should fall back to the legacy /auth/login endpoint.
 */
export async function opaqueLoginStart(email: string): Promise<OpaqueLoginStartResult> {
  const { state, message } = await BeebeebCrypto.opaqueLoginStart(email);
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
  state: Uint8Array,
  serverMessage: Uint8Array,
): Promise<OpaqueLoginResult> {
  const { sessionKey } = await BeebeebCrypto.opaqueLoginFinish(state, serverMessage);
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
 */
export async function opaqueRegistrationStart(
  email: string,
  password: string,
): Promise<OpaqueRegistrationStartResult> {
  const { state, message } = await BeebeebCrypto.opaqueRegistrationStart(email, password);
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
  state: Uint8Array,
  serverMessage: Uint8Array,
): Promise<{ sessionToken: string }> {
  const { record } = await BeebeebCrypto.opaqueRegistrationFinish(state, serverMessage);
  const data = await request<{ session_token: string }>(
    'POST',
    '/api/v1/auth/opaque/register-finish',
    { email, record: uint8ToBase64(record) },
    false,
  );
  await setToken(data.session_token);
  return { sessionToken: data.session_token };
}
