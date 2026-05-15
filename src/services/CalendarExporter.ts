/**
 * CalendarExporter — exports each device calendar to a separate iCalendar
 * file (.ics) and uploads them to Backups/{device}/Calendar/.
 *
 * Pure JS — no native modules. Uses expo-calendar to read events and string
 * concatenation to emit RFC 5545 iCalendar.
 */

let Calendar: any = null;
try { Calendar = require('expo-calendar'); } catch {}
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { deleteFile, listFiles, type FileEntry } from '../lib/api';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import { ensureBackupFolders } from './BackupService';

const PRODID = '-//Beebeeb//Mobile Backup//EN';
const WINDOW_PAST_DAYS = 365;
const WINDOW_FUTURE_DAYS = 365;
const LAST_HASH_KEY_PREFIX = 'beebeeb_calendar_last_hash_';
const LAST_FILE_ID_KEY_PREFIX = 'beebeeb_calendar_file_id_';
const SECURE_STORE_SAFE_KEY_CHAR = /^[A-Za-z0-9._-]$/;

export interface BackupEncryptors {
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
  decryptMetadataFn: (fileId: string, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<string>;
}

export interface CalendarExportResult {
  exported: boolean;
  calendarCount: number;
  eventCount: number;
  reason?: 'no_permission' | 'no_calendars';
}

function permissionGranted(permission: { status?: string; granted?: boolean } | null | undefined): boolean {
  return permission?.granted === true || permission?.status === 'granted';
}

// ---------------------------------------------------------------------------
// iCalendar escaping — RFC 5545 §3.3.11
// ---------------------------------------------------------------------------

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Fold lines longer than 75 octets — RFC 5545 §3.1. */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let remaining = line;
  out.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 74) {
    out.push(' ' + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  if (remaining.length > 0) out.push(' ' + remaining);
  return out.join('\r\n');
}

function emit(line: string, lines: string[]): void {
  lines.push(foldLine(line));
}

// ---------------------------------------------------------------------------
// Date formatting — convert ISO/Date to UTC iCal stamp YYYYMMDDTHHMMSSZ
// ---------------------------------------------------------------------------

function formatUtc(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return formatUtc(new Date());
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function formatDateOnly(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return formatDateOnly(new Date());
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// VEVENT emission
// ---------------------------------------------------------------------------

function eventToVEvent(ev: any, dtstamp: string): string[] {
  const lines: string[] = [];
  emit('BEGIN:VEVENT', lines);

  // UID — prefer the platform id; fall back to a deterministic slug.
  const uid = `${ev.id ?? `${ev.startDate}-${ev.title}`}@beebeeb.io`;
  emit(`UID:${escapeIcsText(uid)}`, lines);
  emit(`DTSTAMP:${dtstamp}`, lines);

  if (ev.allDay) {
    emit(`DTSTART;VALUE=DATE:${formatDateOnly(ev.startDate)}`, lines);
    emit(`DTEND;VALUE=DATE:${formatDateOnly(ev.endDate)}`, lines);
  } else {
    emit(`DTSTART:${formatUtc(ev.startDate)}`, lines);
    emit(`DTEND:${formatUtc(ev.endDate)}`, lines);
  }

  emit(`SUMMARY:${escapeIcsText(ev.title ?? '')}`, lines);

  if (ev.notes) emit(`DESCRIPTION:${escapeIcsText(ev.notes)}`, lines);
  if (ev.location) emit(`LOCATION:${escapeIcsText(ev.location)}`, lines);

  emit('END:VEVENT', lines);
  return lines;
}

function buildIcs(calendarTitle: string, events: any[]): string {
  const lines: string[] = [];
  const dtstamp = formatUtc(new Date());

  emit('BEGIN:VCALENDAR', lines);
  emit('VERSION:2.0', lines);
  emit(`PRODID:${PRODID}`, lines);
  emit(`X-WR-CALNAME:${escapeIcsText(calendarTitle)}`, lines);
  emit('CALSCALE:GREGORIAN', lines);
  emit('METHOD:PUBLISH', lines);

  for (const ev of events) {
    lines.push(...eventToVEvent(ev, dtstamp));
  }

  emit('END:VCALENDAR', lines);
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Filename sanitization — calendar titles are user-supplied
// ---------------------------------------------------------------------------

function safeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleaned || 'Calendar'}.ics`;
}

// ---------------------------------------------------------------------------
// Hash for change detection
// ---------------------------------------------------------------------------

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function secureStoreCalendarKey(prefix: string, calendarId: string): string {
  const suffix = Array.from(calendarId)
    .map((ch) => {
      if (SECURE_STORE_SAFE_KEY_CHAR.test(ch)) return ch;
      return `_${ch.codePointAt(0)?.toString(16) ?? '0'}_`;
    })
    .join('');
  return prefix + suffix;
}

async function getLastHash(calendarId: string): Promise<string | null> {
  const key = secureStoreCalendarKey(LAST_HASH_KEY_PREFIX, calendarId);
  if (Platform.OS === 'web') {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function setLastHash(calendarId: string, hash: string): Promise<void> {
  const key = secureStoreCalendarKey(LAST_HASH_KEY_PREFIX, calendarId);
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, hash);
    return;
  }
  await SecureStore.setItemAsync(key, hash);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function decryptFileName(
  entry: FileEntry,
  decryptMetadataFn: BackupEncryptors['decryptMetadataFn'],
): Promise<string | null> {
  const parsed = encryptedMetadataPayloadToBytes(entry.name_encrypted);
  if (!parsed) return entry.name_encrypted; // legacy plaintext
  try {
    const json = await decryptMetadataFn(entry.id, parsed.nonce, parsed.ciphertext);
    const metadata = JSON.parse(json) as { name?: string };
    return metadata.name ?? null;
  } catch {
    return null;
  }
}

async function findFile(
  parentId: string,
  name: string,
  decryptMetadataFn: BackupEncryptors['decryptMetadataFn'],
): Promise<FileEntry | null> {
  const children = await listFiles(parentId);
  for (const f of children) {
    if (f.is_folder) continue;
    const decrypted = await decryptFileName(f, decryptMetadataFn);
    if (decrypted === name) return f;
  }
  return null;
}

export async function exportCalendars(encryption: BackupEncryptors): Promise<CalendarExportResult> {
  const getPermission = Calendar?.getCalendarPermissionsAsync ?? Calendar?.getPermissionsAsync;
  if (typeof getPermission !== 'function') {
    return { exported: false, calendarCount: 0, eventCount: 0, reason: 'no_permission' };
  }

  const perm = await getPermission();
  if (!permissionGranted(perm)) {
    return { exported: false, calendarCount: 0, eventCount: 0, reason: 'no_permission' };
  }

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  if (calendars.length === 0) {
    return { exported: false, calendarCount: 0, eventCount: 0, reason: 'no_calendars' };
  }

  const now = new Date();
  const start = new Date(now.getTime() - WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000);

  const { categoryFolderId } = await ensureBackupFolders('calendar');

  let totalEvents = 0;
  let exportedAny = false;

  for (const cal of calendars) {
    const events = await Calendar.getEventsAsync([cal.id], start, end);
    totalEvents += events.length;

    const ics = buildIcs(cal.title, events);
    const hash = djb2(ics);

    const previous = await getLastHash(cal.id);
    if (previous === hash) continue;

    const filename = safeFilename(cal.title);
    const lastFileIdKey = secureStoreCalendarKey(LAST_FILE_ID_KEY_PREFIX, cal.id);
    const previousFileId = await SecureStore.getItemAsync(lastFileIdKey);
    if (previousFileId) {
      await deleteFile(previousFileId).catch(() => {});
    }

    const existing = await findFile(categoryFolderId, filename, encryption.decryptMetadataFn);
    if (existing) {
      await deleteFile(existing.id);
    }

    if (!FileSystem.cacheDirectory) throw new Error('File cache unavailable');
    const fileId = generateFileId();
    const uri = `${FileSystem.cacheDirectory}calendar_${fileId}.ics`;
    let uploaded: FileEntry;
    await FileSystem.writeAsStringAsync(uri, ics);
    try {
      uploaded = await encryptedUpload({
        fileId,
        uri,
        name: filename,
        parentId: categoryFolderId,
        mimeType: 'text/calendar',
        ...encryption,
      });
    } finally {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }

    await setLastHash(cal.id, hash);
    await SecureStore.setItemAsync(lastFileIdKey, uploaded.id);
    exportedAny = true;
  }

  return {
    exported: exportedAny,
    calendarCount: calendars.length,
    eventCount: totalEvents,
  };
}
