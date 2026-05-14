/**
 * ContactsExporter — exports the device address book to a single vCard 3.0
 * file and uploads it to Backups/{device}/Contacts/contacts.vcf.
 *
 * Pure JS — no native modules. Uses expo-contacts to read and string
 * concatenation to emit the vCard.
 */

let Contacts: any = null;
try { Contacts = require('expo-contacts'); } catch {}
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { deleteFile, listFiles, type FileEntry } from '../lib/api';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import { ensureBackupFolders } from './BackupService';

const CONTACTS_FILENAME = 'contacts.vcf';
const LAST_HASH_KEY = 'beebeeb_contacts_last_hash';
const LAST_FILE_ID_KEY = 'beebeeb_contacts_file_id';

export interface BackupEncryptors {
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
  decryptMetadataFn: (fileId: string, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<string>;
}

export interface ContactsExportResult {
  exported: boolean;
  contactCount: number;
  fileId?: string;
  reason?: 'unchanged' | 'no_permission' | 'empty';
}

function permissionGranted(permission: { status?: string; granted?: boolean } | null | undefined): boolean {
  return permission?.granted === true || permission?.status === 'granted';
}

// ---------------------------------------------------------------------------
// vCard 3.0 escaping — RFC 2426 §4
// ---------------------------------------------------------------------------

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Fold lines longer than 75 octets per RFC 2425 §5.8.1 — continuation lines
 *  start with a single space. We approximate octets as characters; UTF-8
 *  multibyte sequences will fold a bit early but remain valid. */
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

function emitLine(parts: string[], lines: string[]): void {
  lines.push(foldLine(parts.join('')));
}

// ---------------------------------------------------------------------------
// Label mapping — expo-contacts uses iOS-style labels; vCard expects TYPE=
// ---------------------------------------------------------------------------

function phoneType(label: string | undefined): string {
  switch ((label ?? '').toLowerCase()) {
    case 'mobile':
    case 'iphone':
      return 'CELL';
    case 'home':
      return 'HOME';
    case 'work':
      return 'WORK';
    case 'main':
      return 'VOICE';
    case 'fax':
    case 'home fax':
    case 'work fax':
      return 'FAX';
    default:
      return 'VOICE';
  }
}

function emailType(label: string | undefined): string {
  switch ((label ?? '').toLowerCase()) {
    case 'home':
      return 'HOME';
    case 'work':
      return 'WORK';
    default:
      return 'INTERNET';
  }
}

function addressType(label: string | undefined): string {
  switch ((label ?? '').toLowerCase()) {
    case 'home':
      return 'HOME';
    case 'work':
      return 'WORK';
    default:
      return 'OTHER';
  }
}

// ---------------------------------------------------------------------------
// vCard emission
// ---------------------------------------------------------------------------

function contactToVCard(c: any): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');

  const fn = c.name?.trim() || [c.firstName, c.middleName, c.lastName].filter(Boolean).join(' ').trim();
  emitLine(['FN:', escapeVCardValue(fn || 'Unknown')], lines);

  // N:Family;Given;Additional;Prefix;Suffix
  const n = [
    escapeVCardValue(c.lastName ?? ''),
    escapeVCardValue(c.firstName ?? ''),
    escapeVCardValue(c.middleName ?? ''),
    escapeVCardValue(c.namePrefix ?? ''),
    escapeVCardValue(c.nameSuffix ?? ''),
  ].join(';');
  emitLine(['N:', n], lines);

  if (c.company) {
    emitLine(['ORG:', escapeVCardValue(c.company)], lines);
  }
  if (c.jobTitle) {
    emitLine(['TITLE:', escapeVCardValue(c.jobTitle)], lines);
  }

  for (const phone of c.phoneNumbers ?? []) {
    if (!phone.number) continue;
    emitLine([`TEL;TYPE=${phoneType(phone.label)}:`, escapeVCardValue(phone.number)], lines);
  }

  for (const email of c.emails ?? []) {
    if (!email.email) continue;
    emitLine([`EMAIL;TYPE=${emailType(email.label)}:`, escapeVCardValue(email.email)], lines);
  }

  for (const addr of c.addresses ?? []) {
    // ADR:PostBox;ExtAddr;Street;Locality;Region;PostalCode;Country
    const parts = [
      '',
      '',
      escapeVCardValue(addr.street ?? ''),
      escapeVCardValue(addr.city ?? ''),
      escapeVCardValue(addr.region ?? ''),
      escapeVCardValue(addr.postalCode ?? ''),
      escapeVCardValue(addr.country ?? ''),
    ].join(';');
    emitLine([`ADR;TYPE=${addressType(addr.label)}:`, parts], lines);
  }

  if (c.birthday && c.birthday.month != null && c.birthday.day != null) {
    const y = c.birthday.year ?? 1604; // vCard sentinel for unknown year
    const mm = String(c.birthday.month + 1).padStart(2, '0');
    const dd = String(c.birthday.day).padStart(2, '0');
    emitLine(['BDAY:', `${y}-${mm}-${dd}`], lines);
  }

  if (c.note) {
    emitLine(['NOTE:', escapeVCardValue(c.note)], lines);
  }

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Hash for change detection — djb2 is plenty for "did anything change"
// ---------------------------------------------------------------------------

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

async function getLastHash(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(LAST_HASH_KEY);
  }
  return SecureStore.getItemAsync(LAST_HASH_KEY);
}

async function setLastHash(hash: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.localStorage.setItem(LAST_HASH_KEY, hash);
    return;
  }
  await SecureStore.setItemAsync(LAST_HASH_KEY, hash);
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

export async function exportContacts(encryption: BackupEncryptors): Promise<ContactsExportResult> {
  if (!Contacts || typeof Contacts.getPermissionsAsync !== 'function') {
    return { exported: false, contactCount: 0, reason: 'no_permission' };
  }

  const perm = await Contacts.getPermissionsAsync();
  if (!permissionGranted(perm)) {
    return { exported: false, contactCount: 0, reason: 'no_permission' };
  }

  const { data } = await Contacts.getContactsAsync({
    fields: [
      Contacts.Fields.Name,
      Contacts.Fields.FirstName,
      Contacts.Fields.MiddleName,
      Contacts.Fields.LastName,
      Contacts.Fields.NamePrefix,
      Contacts.Fields.NameSuffix,
      Contacts.Fields.Company,
      Contacts.Fields.JobTitle,
      Contacts.Fields.PhoneNumbers,
      Contacts.Fields.Emails,
      Contacts.Fields.Addresses,
      Contacts.Fields.Birthday,
      Contacts.Fields.Note,
    ],
  });

  if (data.length === 0) {
    return { exported: false, contactCount: 0, reason: 'empty' };
  }

  const vcards = data.map(contactToVCard).join('\r\n');
  const hash = djb2(vcards);

  const previous = await getLastHash();
  if (previous === hash) {
    return { exported: false, contactCount: data.length, reason: 'unchanged' };
  }

  const { categoryFolderId } = await ensureBackupFolders('contacts');

  const previousFileId = await SecureStore.getItemAsync(LAST_FILE_ID_KEY);
  if (previousFileId) {
    await deleteFile(previousFileId).catch(() => {});
  }

  // Replace any legacy plaintext-name contacts.vcf so the latest export is authoritative.
  const existing = await findFile(categoryFolderId, CONTACTS_FILENAME, encryption.decryptMetadataFn);
  if (existing) {
    await deleteFile(existing.id);
  }

  if (!FileSystem.cacheDirectory) throw new Error('File cache unavailable');
  const fileId = generateFileId();
  const uri = `${FileSystem.cacheDirectory}contacts_${fileId}.vcf`;
  await FileSystem.writeAsStringAsync(uri, vcards);
  let uploaded: FileEntry;
  try {
    uploaded = await encryptedUpload({
      fileId,
      uri,
      name: CONTACTS_FILENAME,
      parentId: categoryFolderId,
      mimeType: 'text/vcard',
      ...encryption,
    });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }

  await setLastHash(hash);
  await SecureStore.setItemAsync(LAST_FILE_ID_KEY, uploaded.id);

  return { exported: true, contactCount: data.length, fileId: uploaded.id };
}
