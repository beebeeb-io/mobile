/**
 * CreateFileRequestScreen (0643)
 *
 * Owner creates a file request: pick a target folder + caps + expiry, generate
 * a per-request X25519 keypair (R_priv wrapped under the master key, all
 * native), POST to the server, then present the self-contained link
 * `…/r/<token>#<R_pub>` via the native share sheet.
 *
 * Mirrors repos/web/src/pages/file-request.tsx. R_pub rides in the link
 * fragment and is NEVER sent to the server.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { useTheme } from '../lib/theme-context';
import { useCrypto } from '../lib/crypto-context';
import { createFileRequest, listAllFiles, type FileEntry } from '../lib/api';
import { toBase64, toBase64url } from '../lib/file-request-crypto';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Crumb {
  id: string | null;
  name: string;
}

const EXPIRY_OPTIONS: { label: string; secs: number | null }[] = [
  { label: 'Never', secs: null },
  { label: '1 day', secs: 86400 },
  { label: '7 days', secs: 7 * 86400 },
  { label: '30 days', secs: 30 * 86400 },
];

const SIZE_OPTIONS: { label: string; bytes: number | null }[] = [
  { label: 'No limit', bytes: null },
  { label: '100 MB', bytes: 100 * 1024 * 1024 },
  { label: '500 MB', bytes: 500 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
  { label: '5 GB', bytes: 5 * 1024 * 1024 * 1024 },
];

function parseName(plaintext: string): string {
  try {
    const parsed = JSON.parse(plaintext) as { name?: unknown };
    if (typeof parsed.name === 'string') return parsed.name;
  } catch {
    // fall through
  }
  return plaintext;
}

export default function CreateFileRequestScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { isUnlocked, createRequestKeypair, decryptMetadata } = useCrypto();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [folderPath, setFolderPath] = useState<Crumb[]>([{ id: null, name: 'My files' }]);
  const [subfolders, setSubfolders] = useState<{ id: string; name: string }[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [maxFiles, setMaxFiles] = useState('1');
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [expirySecs, setExpirySecs] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = folderPath[folderPath.length - 1];
  const targetFolderId = current?.id ?? null;

  // Load subfolders for the current folder, decrypting their names.
  useEffect(() => {
    let cancelled = false;
    setLoadingFolders(true);
    listAllFiles(current?.id ?? undefined)
      .then(async (files: FileEntry[]) => {
        const folders = files.filter((f) => f.is_folder);
        const named = await Promise.all(
          folders.map(async (f) => {
            let name = f.name_encrypted;
            if (isUnlocked) {
              try {
                const payload = encryptedMetadataPayloadToBytes(f.name_encrypted);
                if (payload) {
                  name = parseName(await decryptMetadata(f.id, payload.nonce, payload.ciphertext));
                }
              } catch {
                // keep raw
              }
            }
            return { id: f.id, name };
          }),
        );
        if (!cancelled) setSubfolders(named);
      })
      .catch(() => {
        if (!cancelled) setSubfolders([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFolders(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id, isUnlocked, decryptMetadata]);

  const handleCreate = useCallback(async () => {
    if (!title.trim()) {
      setError('Give your request a title so people know what to send.');
      return;
    }
    if (!isUnlocked) {
      setError('Your vault is locked. Unlock it to create a request.');
      return;
    }
    setCreating(true);
    setError(null);

    let keypair: { publicKey: Uint8Array; wrapped: Uint8Array; nonce: Uint8Array } | null = null;
    try {
      keypair = await createRequestKeypair();
      const parsedMax = Math.max(1, Math.min(1000, Number.parseInt(maxFiles, 10) || 1));
      const result = await createFileRequest({
        title: title.trim(),
        description: description.trim() || undefined,
        target_folder_id: targetFolderId ?? undefined,
        max_files: parsedMax,
        max_total_bytes: maxBytes ?? undefined,
        expires_in_secs: expirySecs ?? undefined,
        wrapped_private_key: toBase64(keypair.wrapped),
        wrap_nonce: toBase64(keypair.nonce),
      });
      const base = result.request_url ?? '';
      if (!base) {
        throw new Error('Server did not return a request link.');
      }
      const link = `${base}#${toBase64url(keypair.publicKey)}`;
      // Present the universal link via the native share sheet.
      await Share.share({ message: link, title: title.trim() });
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the request. Please try again.');
    } finally {
      // R_priv never entered JS; only R_pub is here and it is public — nothing to zero.
      keypair = null;
      setCreating(false);
    }
  }, [title, description, targetFolderId, maxFiles, maxBytes, expirySecs, isUnlocked, createRequestKeypair, navigation]);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>New file request</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.intro, { color: c.ink2 }]}>
          Create a link anyone can use to send files straight into your vault — no account needed.
          Files are encrypted on their device and sealed so only you can open them.
        </Text>

        <Text style={[styles.label, { color: c.ink2 }]}>Title</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Send me your signed contract"
          placeholderTextColor={c.ink4}
          maxLength={200}
          style={[styles.input, { color: c.ink, borderColor: c.line, backgroundColor: c.paper2 }]}
        />

        <Text style={[styles.label, { color: c.ink2 }]}>Description (optional)</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="A short note shown on the upload page"
          placeholderTextColor={c.ink4}
          maxLength={2000}
          multiline
          style={[styles.input, styles.inputMultiline, { color: c.ink, borderColor: c.line, backgroundColor: c.paper2 }]}
        />

        <Text style={[styles.label, { color: c.ink2 }]}>Where files land</Text>
        <View style={[styles.folderCard, { borderColor: c.line, backgroundColor: c.paper2 }]}>
          <View style={[styles.crumbs, { borderBottomColor: c.line }]}>
            {folderPath.map((crumb, i) => {
              const isLast = i === folderPath.length - 1;
              return (
                <View key={`${crumb.id ?? 'root'}-${i}`} style={styles.crumbRow}>
                  {i > 0 && <Ionicons name="chevron-forward" size={11} color={c.ink4} />}
                  {isLast ? (
                    <Text style={[styles.crumbCurrent, { color: c.ink }]} numberOfLines={1}>
                      {crumb.name}
                    </Text>
                  ) : (
                    <TouchableOpacity onPress={() => setFolderPath(folderPath.slice(0, i + 1))}>
                      <Text style={[styles.crumbLink, { color: c.amberDeep }]} numberOfLines={1}>
                        {crumb.name}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>
          {loadingFolders ? (
            <Text style={[styles.folderEmpty, { color: c.ink3 }]}>Loading…</Text>
          ) : subfolders.length === 0 ? (
            <Text style={[styles.folderEmpty, { color: c.ink4 }]}>No subfolders here</Text>
          ) : (
            subfolders.map((f) => (
              <TouchableOpacity
                key={f.id}
                onPress={() => setFolderPath([...folderPath, { id: f.id, name: f.name }])}
                style={styles.folderRow}
              >
                <Ionicons name="folder-outline" size={15} color={c.ink3} />
                <Text style={[styles.folderName, { color: c.ink }]} numberOfLines={1}>
                  {f.name}
                </Text>
                <Ionicons name="chevron-forward" size={13} color={c.ink4} />
              </TouchableOpacity>
            ))
          )}
        </View>
        <Text style={[styles.hint, { color: c.ink4 }]}>
          Uploads land in {current?.name ?? 'My files'}. Open a subfolder above to change it.
        </Text>

        <Text style={[styles.label, { color: c.ink2 }]}>Max files</Text>
        <TextInput
          value={maxFiles}
          onChangeText={(t) => setMaxFiles(t.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder="1"
          placeholderTextColor={c.ink4}
          style={[styles.input, { color: c.ink, borderColor: c.line, backgroundColor: c.paper2 }]}
        />

        <Text style={[styles.label, { color: c.ink2 }]}>Total size</Text>
        <View style={styles.chipRow}>
          {SIZE_OPTIONS.map((o) => {
            const selected = maxBytes === o.bytes;
            return (
              <TouchableOpacity
                key={o.label}
                onPress={() => setMaxBytes(o.bytes)}
                style={[styles.chip, { borderColor: selected ? c.amber : c.line, backgroundColor: selected ? c.amberBg : 'transparent' }]}
              >
                <Text style={[styles.chipText, { color: selected ? c.amberDeep : c.ink2 }]}>{o.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={[styles.label, { color: c.ink2 }]}>Expires</Text>
        <View style={styles.chipRow}>
          {EXPIRY_OPTIONS.map((o) => {
            const selected = expirySecs === o.secs;
            return (
              <TouchableOpacity
                key={o.label}
                onPress={() => setExpirySecs(o.secs)}
                style={[styles.chip, { borderColor: selected ? c.amber : c.line, backgroundColor: selected ? c.amberBg : 'transparent' }]}
              >
                <Text style={[styles.chipText, { color: selected ? c.amberDeep : c.ink2 }]}>{o.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: c.amberBg, borderColor: c.red }]}>
            <Text style={[styles.errorText, { color: c.red }]}>{error}</Text>
          </View>
        )}

        <TouchableOpacity
          onPress={handleCreate}
          disabled={creating}
          style={[styles.cta, { backgroundColor: c.amber, opacity: creating ? 0.7 : 1 }]}
        >
          {creating ? (
            <ActivityIndicator color="#16110a" />
          ) : (
            <Text style={styles.ctaText}>Create &amp; share link</Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.fragmentNote, { color: c.ink4 }]}>
          The part of the link after # is the encryption key. It is never sent to our servers — keep
          the whole link intact when you share it.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
  scroll: { flex: 1 },
  intro: { fontSize: 13, lineHeight: 19, marginBottom: 18 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6, marginTop: 14 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 11 : 8,
    fontSize: 14,
  },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  folderCard: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  crumbs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  crumbCurrent: { fontSize: 12, fontWeight: '600', maxWidth: 180 },
  crumbLink: { fontSize: 12, fontWeight: '500', maxWidth: 140 },
  folderEmpty: { fontSize: 12, paddingHorizontal: 12, paddingVertical: 14, textAlign: 'center' },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  folderName: { flex: 1, fontSize: 13 },
  hint: { fontSize: 11, marginTop: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 12, fontWeight: '500' },
  errorBox: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 16 },
  errorText: { fontSize: 12 },
  cta: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
  },
  ctaText: { fontSize: 15, fontWeight: '600', color: '#16110a' },
  fragmentNote: { fontSize: 11, lineHeight: 16, marginTop: 14, textAlign: 'center' },
});
