import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import type { FileEntry } from '../lib/api';
import { getFileIndex } from '../lib/api';
import { loadCachedFileIndex, saveCachedFileIndex } from '../lib/file-index-cache';
import { useCrypto } from '../lib/crypto-context';
import { useTheme } from '../lib/theme-context';
import { NativeSwitch } from '../components/NativeSwitch';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import {
  getExcludedPhotoFolderIds,
  setExcludedPhotoFolderIds,
  setPhotoFolderExcluded,
  mediaCountByFolder,
} from '../lib/photo-library-prefs';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Folder names created by the native backup engine (see BackupService.ts:
 * ROOT_FOLDER_NAME = 'Backups', CATEGORY_FOLDERS.camera_roll = 'Camera Roll').
 * These hold the user's phone backup, so in this first cut they are pinned and
 * non-excludable — the default must never hide a user's own camera roll.
 */
const PROTECTED_FOLDER_NAMES = new Set(['Backups', 'Camera Roll']);

interface PhotoFolderRow {
  id: string;
  name: string;
  parentName: string | null;
  count: number;
  isProtected: boolean;
}

function isMediaCandidate(entry: FileEntry): boolean {
  if (entry.is_folder || entry.is_uploading) return false;
  if (entry.is_media === true) return true;
  // Encrypted-thumbnail candidate: a JSON-encrypted name with a thumbnail blob.
  return (
    entry.has_thumbnail === true &&
    typeof entry.name_encrypted === 'string' &&
    entry.name_encrypted.startsWith('{')
  );
}

function parseFolderName(plaintext: string): string {
  try {
    const meta = JSON.parse(plaintext) as { name?: unknown };
    if (meta && typeof meta === 'object' && typeof meta.name === 'string' && meta.name.trim()) {
      return meta.name.trim();
    }
  } catch {
    // Legacy format: plaintext is the bare folder name.
  }
  return plaintext.trim() || 'Untitled folder';
}

export default function PhotoLibrarySettingsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { isUnlocked, decryptMetadata } = useCrypto();

  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<PhotoFolderRow[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cached = await loadCachedFileIndex();
      const index = await getFileIndex(cached?.hash);
      const files = !index.changed && cached
        ? cached.files
        : index.files ?? cached?.files ?? [];
      if (index.changed && index.files) await saveCachedFileIndex(index.hash, index.files);

      const media = files.filter(isMediaCandidate);
      const counts = mediaCountByFolder(files, media);

      const folderById = new Map<string, FileEntry>();
      for (const f of files) if (f.is_folder) folderById.set(f.id, f);

      // Decrypt names for the media-containing folders plus their direct parents
      // (the parent label disambiguates two folders with the same name).
      const toDecrypt = new Set<string>();
      for (const id of counts.keys()) {
        toDecrypt.add(id);
        const parent = folderById.get(id)?.parent_id ?? null;
        if (parent) toDecrypt.add(parent);
      }

      const nameById = new Map<string, string>();
      if (isUnlocked) {
        await Promise.all(
          Array.from(toDecrypt).map(async (id) => {
            const folder = folderById.get(id);
            if (!folder) return;
            const raw = folder.name_encrypted ?? '';
            try {
              if (!raw.startsWith('{')) {
                if (raw) nameById.set(id, raw);
                return;
              }
              const payload = encryptedMetadataPayloadToBytes(raw);
              if (!payload) return;
              const plaintext = await decryptMetadata(id, payload.nonce, payload.ciphertext);
              nameById.set(id, parseFolderName(plaintext));
            } catch {
              // Decryption failure — fall back to "Untitled folder".
            }
          }),
        );
      }

      const rows: PhotoFolderRow[] = Array.from(counts.entries()).map(([id, count]) => {
        const name = nameById.get(id) ?? 'Untitled folder';
        const parentId = folderById.get(id)?.parent_id ?? null;
        const parentName = parentId ? nameById.get(parentId) ?? null : null;
        return { id, name, parentName, count, isProtected: PROTECTED_FOLDER_NAMES.has(name) };
      });

      // A folder that CONTAINS a protected folder (e.g. the device folder above
      // "Camera Roll") must also be pinned "Always shown": excluding it would
      // transitively hide the protected camera roll, contradicting the label and
      // emptying the Photos tab. Pin every protected folder + all its ancestors.
      const alwaysShownIds = new Set<string>();
      for (const row of rows) {
        if (!PROTECTED_FOLDER_NAMES.has(row.name)) continue;
        alwaysShownIds.add(row.id);
        let cur = folderById.get(row.id)?.parent_id ?? null;
        let depth = 0;
        const seen = new Set<string>();
        while (cur && depth < 64 && !seen.has(cur)) {
          alwaysShownIds.add(cur);
          seen.add(cur);
          cur = folderById.get(cur)?.parent_id ?? null;
          depth += 1;
        }
      }
      for (const row of rows) {
        if (alwaysShownIds.has(row.id)) row.isProtected = true;
      }

      rows.sort((a, b) => {
        if (a.isProtected !== b.isProtected) return a.isProtected ? -1 : 1;
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) return byName;
        return b.count - a.count;
      });

      setFolders(rows);

      // Self-heal: drop any persisted exclusion that is now pinned (protected or
      // an ancestor of one) — otherwise a folder excluded before this fix would
      // keep the camera roll hidden with no toggle to turn it back on.
      const persisted = new Set(await getExcludedPhotoFolderIds());
      let healed = false;
      for (const id of Array.from(persisted)) {
        if (alwaysShownIds.has(id)) { persisted.delete(id); healed = true; }
      }
      if (healed) await setExcludedPhotoFolderIds(Array.from(persisted));
      setExcluded(persisted);
    } catch {
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [isUnlocked, decryptMetadata]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(async (folderId: string, shown: boolean) => {
    // "Show in Photos" on  → folder NOT excluded.
    // "Show in Photos" off → folder excluded.
    const next = await setPhotoFolderExcluded(folderId, !shown);
    setExcluded(new Set(next));
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Folders in Photos</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
      >
        {/* 1299 — only promise a switch when at least one row actually has one:
            in the common all-backup-folders vault every row is pinned and the
            old copy promised a control the screen did not offer. */}
        <Text style={[styles.body, { color: c.ink2 }]}>
          {folders.length > 0 && folders.every((f) => f.isProtected)
            ? 'These folders hold your phone backup, so they always show in Photos.'
            : 'Choose which folders appear in Photos. Folders that hold your phone backup always show. Turn off folders like album artwork you do not want mixed in.'}
        </Text>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={c.amber} />
          </View>
        ) : folders.length === 0 ? (
          <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
            <Text style={[styles.body, { color: c.ink3, marginBottom: 0 }]}>
              No folders contain photos yet. Media you back up or upload into folders will appear
              here.
            </Text>
          </View>
        ) : (
          <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
            {folders.map((folder, i) => {
              const shown = !excluded.has(folder.id);
              const countLabel = `${folder.count.toLocaleString()} ${folder.count === 1 ? 'item' : 'items'}`;
              const subtitle = folder.parentName
                ? `${folder.parentName} · ${countLabel}`
                : countLabel;
              return (
                <View key={folder.id}>
                  {i > 0 ? <View style={[styles.divider, { backgroundColor: c.line }]} /> : null}
                  <View style={styles.row}>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowLabel, { color: c.ink }]} numberOfLines={1}>
                        {folder.name}
                      </Text>
                      <Text style={[styles.rowSubtitle, { color: c.ink3 }]} numberOfLines={1}>
                        {subtitle}
                      </Text>
                    </View>
                    {folder.isProtected ? (
                      <Text style={[styles.pinnedLabel, { color: c.ink3 }]}>Always shown</Text>
                    ) : (
                      <NativeSwitch
                        value={shown}
                        onValueChange={(v) => void handleToggle(folder.id, v)}
                        colors={c}
                      />
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {!loading && folders.length > 0 ? (
          <Text style={[styles.note, { color: c.ink3 }]}>
            {folders.every((f) => f.isProtected)
              ? 'Other folders will appear here with a switch once they contain photos.'
              : 'Turning a folder off hides its photos from this device only. The files stay in your vault and remain visible under Files.'}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '800' },
  scroll: { flex: 1 },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 16 },
  loadingBox: { paddingVertical: 32, alignItems: 'center' },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  rowSubtitle: { fontSize: 12, marginTop: 2 },
  pinnedLabel: { fontSize: 12, fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 17, marginTop: 14 },
});
