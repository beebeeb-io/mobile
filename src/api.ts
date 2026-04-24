/**
 * Beebeeb API client.
 *
 * Talks to the Rust backend at localhost:3001 in dev.
 * All file data is encrypted ciphertext -- the server never sees plaintext.
 */

import * as SecureStore from 'expo-secure-store';

const BASE_URL = 'http://localhost:3001';
const TOKEN_KEY = 'beebeeb_session_token';

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
  return cachedToken;
}

export async function setToken(token: string): Promise<void> {
  cachedToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  cachedToken = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
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
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: await headers(auth),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? res.statusText);
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

export async function restoreFile(id: string): Promise<void> {
  await request('POST', `/api/v1/files/${id}/restore`);
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
