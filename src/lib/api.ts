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

export async function uploadFile(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  chunks: Blob[],
): Promise<FileEntry> {
  const token = await getToken();
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  chunks.forEach((chunk, i) => {
    form.append(`chunk_${i}`, chunk);
  });

  const res = await fetch(`${BASE_URL}/api/v1/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? res.statusText);
  }
  return res.json() as Promise<FileEntry>;
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
