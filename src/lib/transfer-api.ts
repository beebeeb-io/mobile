/**
 * Constellation peer transfer API client.
 *
 * Companion to api.ts — covers the `/api/v1/transfer/*` surface that powers
 * the "Send via Constellation" flow. Sender endpoints are bearer-authenticated
 * (Beebeeb users only); receiver endpoints use the per-session
 * `download_token` returned at join time.
 *
 * Server contract documented in docs/superpowers/specs/2026-05-02-constellation-peer-transfer-design.md
 */

import { Platform } from 'react-native';
import { ApiError, getApiUrl, getToken } from './api';

/**
 * Wraps unknown fetch failures (offline, DNS, mobile interface flap) in the
 * shared ApiError shape so callers can use `friendlyError()` from api.ts.
 */
async function safeFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
}

/** Throws ApiError if the response is not OK. */
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  let message = res.statusText;
  try {
    const body = await res.json();
    message = body.error ?? body.message ?? message;
  } catch {
    // ignore JSON parse failure — fall back to statusText
  }
  throw new ApiError(res.status, message);
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (extra) Object.assign(h, extra);
  return h;
}

// ---------------------------------------------------------------------------
// Sender — authenticated endpoints
// ---------------------------------------------------------------------------

export interface InitTransferResponse {
  /** UUID of the new session. Encoded into the constellation. */
  session_id: string;
  /** 6-digit numeric code shown as the manual fallback. */
  fallback_code: string;
}

/**
 * POST /api/v1/transfer/init — sender creates a session.
 * `senderPk` is base64 of the ephemeral 32-byte X25519 public key.
 */
export async function initTransfer(senderPk: string): Promise<InitTransferResponse> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/init`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ sender_pk: senderPk }),
  });
  await ensureOk(res);
  return res.json() as Promise<InitTransferResponse>;
}

export interface TransferStatus {
  status: 'waiting' | 'joined' | 'approved' | 'ready' | 'downloaded' | 'complete' | 'cancelled' | 'expired';
  /** Present once the receiver has joined. */
  receiver_pk?: string;
  /** Present once the sender has approved + uploaded. */
  blob_size?: number;
  /** Encrypted (with transfer_key) filename hint. Base64. */
  file_name_hint?: string;
}

/**
 * GET /api/v1/transfer/{id}/status — sender or receiver polls for state.
 *
 * Sender uses bearer auth; receiver uses the download token they got at
 * join time. We send both when available so the same call works for both
 * roles without a second code path.
 */
export async function getTransferStatus(sessionId: string, downloadToken?: string): Promise<TransferStatus> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (downloadToken) headers['X-Transfer-Token'] = downloadToken;
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}/status`, {
    method: 'GET',
    headers,
  });
  await ensureOk(res);
  return res.json() as Promise<TransferStatus>;
}

/**
 * POST /api/v1/transfer/{id}/approve — sender confirms the SAS matches and
 * authorises the upload. No body. The server flips `sender_approved` and
 * unlocks the PUT /blob endpoint.
 */
export async function approveTransfer(sessionId: string): Promise<void> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}/approve`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  await ensureOk(res);
}

/**
 * PUT /api/v1/transfer/{id}/blob — sender uploads the encrypted blob.
 *
 * `blob` is the AES-256-GCM ciphertext (nonce prepended). The optional
 * `fileNameHint` is the encrypted, base64-encoded filename and is sent in
 * the `X-File-Name-Hint` header so it travels with the blob without a
 * multipart envelope.
 */
export async function uploadTransferBlob(
  sessionId: string,
  blob: Blob,
  fileNameHint?: string,
): Promise<void> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (fileNameHint) headers['X-File-Name-Hint'] = fileNameHint;
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}/blob`, {
    method: 'PUT',
    headers,
    body: blob,
  });
  await ensureOk(res);
}

/**
 * DELETE /api/v1/transfer/{id} — sender cancels (e.g. after "Don't match").
 */
export async function cancelTransfer(sessionId: string): Promise<void> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  // 404 here means the session is already gone — treat as success.
  if (!res.ok && res.status !== 404) await ensureOk(res);
}

// ---------------------------------------------------------------------------
// Receiver — token-authenticated endpoints
// ---------------------------------------------------------------------------

export interface JoinTransferResponse {
  /** Sender's ephemeral X25519 public key (base64). */
  sender_pk: string;
  /** One-time token the receiver presents on download / status / ack. */
  download_token: string;
}

/**
 * POST /api/v1/transfer/{id}/join — receiver joins by sending their pk.
 *
 * Unauthenticated (anyone with a session_id can join). The server applies
 * a per-IP-per-session rate limit so a brute-force scan over the fallback
 * code space is impractical.
 */
export async function joinTransfer(sessionId: string, receiverPk: string): Promise<JoinTransferResponse> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiver_pk: receiverPk }),
  });
  await ensureOk(res);
  return res.json() as Promise<JoinTransferResponse>;
}

/**
 * Resolve a 6-digit fallback code to a session_id + sender_pk + token in one
 * shot. The server looks up the active session by code, treats this as a
 * join, and returns the same shape as `joinTransfer`.
 */
export async function joinTransferByCode(
  fallbackCode: string,
  receiverPk: string,
): Promise<JoinTransferResponse & { session_id: string }> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/join-by-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fallback_code: fallbackCode, receiver_pk: receiverPk }),
  });
  await ensureOk(res);
  return res.json() as Promise<JoinTransferResponse & { session_id: string }>;
}

/**
 * GET /api/v1/transfer/{id}/blob — receiver downloads the ciphertext.
 *
 * Returns the raw encrypted bytes (nonce-prefixed). Caller decrypts with
 * the transfer_key derived from the shared secret.
 */
export async function downloadTransferBlob(sessionId: string, token: string): Promise<ArrayBuffer> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}/blob`, {
    method: 'GET',
    headers: { 'X-Transfer-Token': token },
  });
  await ensureOk(res);
  return res.arrayBuffer();
}

/**
 * POST /api/v1/transfer/{id}/ack — receiver confirms successful decrypt.
 * Triggers server-side blob deletion and marks the session `complete`.
 */
export async function ackTransfer(sessionId: string, token: string): Promise<void> {
  const res = await safeFetch(`${getApiUrl()}/api/v1/transfer/${sessionId}/ack`, {
    method: 'POST',
    headers: { 'X-Transfer-Token': token, 'Content-Type': 'application/json' },
  });
  await ensureOk(res);
}

// ---------------------------------------------------------------------------
// Crypto helpers (v1 — JS-only stand-ins until UniFFI exposes the core)
// ---------------------------------------------------------------------------

/**
 * Generate `n` "random" bytes. v1 uses Math.random — fine for the mock
 * shared secret and ephemeral keypair material we send over the wire while
 * the real X25519 is being wired up. The security property comes from the
 * SAS verification step, not from this RNG.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Prefer crypto.getRandomValues if the runtime has it (Hermes on iOS does
  // since RN 0.71+); fall back to Math.random for older targets / Web.
  const gv = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto?.getRandomValues;
  if (typeof gv === 'function') {
    gv.call((globalThis as { crypto: object }).crypto, out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Hex-encode a byte array (lowercase, no separator). */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Base64-encode a byte array. Uses the platform `btoa` when available
 * (Hermes ≥ 0.74 polyfills it; web has it natively); falls back to a
 * minimal pure-JS encoder for older environments.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return btoa(s);
  }
  // pure-JS fallback (only hit on legacy RN without btoa polyfill)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++]!;
    const b2 = i < bytes.length ? bytes[i++]! : 0;
    const b3 = i < bytes.length ? bytes[i++]! : 0;
    out += chars[b1 >> 2];
    out += chars[((b1 & 0x03) << 4) | (b2 >> 4)];
    out += i - 2 < bytes.length ? chars[((b2 & 0x0f) << 2) | (b3 >> 6)] : '=';
    out += i - 1 < bytes.length ? chars[b3 & 0x3f] : '=';
  }
  return out;
}

// Suppress unused-import warning on platforms that don't reference Platform
// directly here — we keep the import handy for future native-bridge calls.
void Platform;
