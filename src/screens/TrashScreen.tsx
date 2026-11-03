import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { GlassCapsule, GlassCircle, SCROLL_EDGE, ScrollEdgeBlur, glassMaterial } from '../components/glass';
import { useToast } from '../lib/toast-context';
import { onFilesDeleted } from '../lib/delete-cascade';
import {
  listFilesPage,
  restoreFile,
  permanentDeleteFile,
  permanentDeleteFiles,
  confirmDeviceOwnerAction,
  friendlyError,
} from '../lib/api';
import type { FileEntry } from '../lib/api';
import {
  deleteTrashItems,
  deleteTrashItemsInBatches,
  emptyTrashProgressLabel,
  goneTrashIds,
  trashDeleteError,
  trashDeletionMessage,
  type EmptyTrashProgress,
} from '../lib/trash-delete';
import { requestDeviceOwnerAuth } from '../lib/device-owner-auth';
import {
  removeFromFileProviderCache,
  signalFileProviderTrashChanged,
  syncDecryptedEntriesToFileProvider,
} from '../lib/file-provider-mount';
import { useCrypto } from '../lib/crypto-context';
import { useProtectedBackupsRootId } from '../lib/use-protected-backups-root';
import { formatBytes as formatSize } from '../lib/format';
import type { RootStackParamList } from '../App';
import {
  adjustTrashCount,
  knownTrashParentMap,
  notifyTrashChanged,
  projectTopLevelTrashItems,
  projectVisibleTopLevelTrashItems,
  setTrashCount,
} from '../lib/trash-count';
import { paginateTrashInBackground } from '../lib/trash-pagination';
import { revealOptimisticallyTrashed } from '../lib/trash-optimistic';
import { useSync } from '../lib/sync-context';
import { loadCachedFileIndex } from '../lib/file-index-cache';
import { decryptNamesInBackground } from '../lib/background-name-decrypt';
import { recordRuntimeTrace } from '../lib/runtime-trace';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Tracks the currently open Swipeable so we can close it when another opens.
let _openSwipeable: Swipeable | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function formatDate(iso: string): string {
  const date = new Date(iso);
  const month = date.toLocaleString('en', { month: 'short' });
  const day = date.getDate();
  const year = date.getFullYear();
  const now = new Date();
  if (year === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${year}`;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function fileTypeBadge(entry: FileEntry): { icon: IoniconName; color: string } {
  if (entry.is_folder) return { icon: 'folder', color: '#b8860b' };
  const mime = entry.mime_type ?? '';
  if (mime.startsWith('image/')) return { icon: 'image', color: '#f5b800' };
  if (mime === 'application/pdf') return { icon: 'document-text', color: '#d84040' };
  if (mime.startsWith('audio/')) return { icon: 'musical-notes', color: '#4abe4a' };
  if (mime.startsWith('video/')) return { icon: 'videocam', color: '#8a867f' };
  return { icon: 'document-outline', color: '#8a867f' };
}

function displayName(entry: FileEntry): string {
  const raw = entry.name_encrypted;
  if (!raw) return entry.is_folder ? 'Untitled folder' : 'Untitled file';
  if (raw.startsWith('{')) return entry.is_folder ? 'Encrypted folder' : 'Encrypted file';
  if (raw.length > 32) return raw.slice(0, 24) + '...';
  return raw;
}

// ---------------------------------------------------------------------------
// Trash row (swipeable)
// ---------------------------------------------------------------------------

interface TrashRowProps {
  item: FileEntry;
  decryptedName: string | null;
  onRestore: (item: FileEntry) => void;
  onDelete: (item: FileEntry) => void;
}

const TrashRow = React.memo(function TrashRow({ item, decryptedName, onRestore, onDelete }: TrashRowProps) {
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const swipeableRef = useRef<Swipeable>(null);
  const badge = fileTypeBadge(item);

  const handleSwipeOpen = useCallback((_dir: 'left' | 'right', swipeable: Swipeable) => {
    if (_openSwipeable && _openSwipeable !== swipeable) {
      _openSwipeable.close();
    }
    _openSwipeable = swipeable;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const handleSwipeClose = useCallback(() => {
    if (_openSwipeable === swipeableRef.current) {
      _openSwipeable = null;
    }
  }, []);

  const renderRightActions = useCallback(() => (
    <View style={styles.swipeActions}>
      <TouchableOpacity
        style={[styles.swipeAction, accessibilityLayout && { width: Math.ceil(80 * Math.min(fontScale, 1.5)) }, { backgroundColor: c.green }]}
        activeOpacity={0.8}
        onPress={() => { swipeableRef.current?.close(); onRestore(item); }}
      >
        <Ionicons name="arrow-undo-outline" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Restore</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.swipeAction, accessibilityLayout && { width: Math.ceil(80 * Math.min(fontScale, 1.5)) }, { backgroundColor: c.red }]}
        activeOpacity={0.8}
        onPress={() => { swipeableRef.current?.close(); onDelete(item); }}
      >
        <Ionicons name="trash-outline" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Delete</Text>
      </TouchableOpacity>
    </View>
  ), [accessibilityLayout, c, fontScale, item, onRestore, onDelete]);

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      onSwipeableOpen={handleSwipeOpen}
      onSwipeableClose={handleSwipeClose}
      overshootRight={false}
      rightThreshold={40}
    >
      <View style={[styles.row, accessibilityLayout && { minHeight: Math.ceil(52 * Math.min(fontScale, 2)) }, { borderBottomColor: c.line, backgroundColor: c.paper }]}>
        <View style={[styles.rowIcon, { backgroundColor: badge.color }]}>
          <Ionicons name={badge.icon} size={16} color="#FFFFFF" />
        </View>
        <View style={styles.rowInfo}>
          <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={accessibilityLayout ? 3 : 1}>
            {decryptedName ?? displayName(item)}
          </Text>
          <Text style={[styles.rowMeta, { color: c.ink3 }]}>
            {item.is_folder ? 'Folder' : formatSize(item.size_bytes)}
            {'  ·  Deleted '}
            {formatDate(item.updated_at)}
          </Text>
        </View>
        <Ionicons name="chevron-back" size={14} color={c.ink4} style={{ opacity: 0.5 }} />
      </View>
    </Swipeable>
  );
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function TrashScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const { colors: c, resolved: themeScheme } = useTheme();
  const { showToast } = useToast();

  const { isUnlocked, decryptNames } = useCrypto();
  const sync = useSync();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [allTrashEntries, setAllTrashEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listingComplete, setListingComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [emptyProgress, setEmptyProgress] = useState<EmptyTrashProgress | null>(null);
  const fetchGeneration = useRef(0);
  const backupsRootId = useProtectedBackupsRootId();
  const cachedParentsRef = useRef(new Map<string, string | null>());
  const [localParentVersion, setLocalParentVersion] = useState(0);
  const getNodeById = sync.getNode;
  const localParentOf = useCallback((id: string): string | null | undefined => {
    const node = getNodeById(id);
    if (node) return node.parent_id;
    return cachedParentsRef.current.get(id);
  }, [getNodeById]);

  useEffect(() => {
    let cancelled = false;
    void loadCachedFileIndex().then((cached) => {
      if (cancelled || !cached) return;
      cachedParentsRef.current = knownTrashParentMap(cached.files);
      setLocalParentVersion((version) => version + 1);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Rows paint first. Encrypted names then resolve in bounded batches, with a
  // yield between batches so a large Trash cannot monopolize the JS thread.
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const results: Record<string, string> = {};
      await decryptNamesInBackground(
        allTrashEntries
          .filter((file) => (file.name_encrypted ?? '').startsWith('{'))
          .map((file) => ({ fileId: file.id, nameEncrypted: file.name_encrypted ?? '' })),
        decryptNames,
        (item, result) => { if (result.name) results[item.fileId] = result.name; },
        () => cancelled,
      );
      if (!cancelled) setDecryptedNames(results);
    })();
    return () => { cancelled = true; };
  }, [allTrashEntries, isUnlocked, decryptNames]);

  const nameFor = useCallback(
    (item: FileEntry) => decryptedNames[item.id] ?? displayName(item),
    [decryptedNames],
  );

  const localTrashName = useCallback((entry: FileEntry): string | null => {
    const raw = entry.name_encrypted ?? '';
    if (!raw.startsWith('{')) return raw || null;
    return decryptedNames[entry.id] ?? null;
  }, [decryptedNames]);

  useEffect(() => {
    let cancelled = false;
    void backupsRootId;
    void localParentVersion;
    void sync.treeVersion;
    void projectVisibleTopLevelTrashItems(allTrashEntries, localParentOf, localTrashName)
      .then((projection) => {
        if (cancelled) return;
        const visible = [...projection.visible].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
        setFiles(visible);
        setHiddenIds(projection.hidden.map((entry) => entry.id));
        setTrashCount(listingComplete ? projection.count : null);
      });
    return () => { cancelled = true; };
  }, [allTrashEntries, backupsRootId, listingComplete, localParentOf, localParentVersion, localTrashName, sync.treeVersion]);

  const fetchTrash = useCallback(async (isRefresh = false) => {
    const mine = ++fetchGeneration.current;
    let paintedFirstPage = false;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setPageError(null);
    setListingComplete(false);
    setTrashCount(null);
    try {
      const firstPage = await listFilesPage({ trashed: true });
      if (mine !== fetchGeneration.current) return;
      const firstProjection = projectTopLevelTrashItems(firstPage.files, localParentOf);
      setAllTrashEntries(firstPage.files);
      setFiles(firstProjection.topLevel);
      paintedFirstPage = true;
      setHiddenIds([]);
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(firstPage.next_cursor !== null);

      const pagination = await paginateTrashInBackground({
        initialItems: firstPage.files,
        initialNextCursor: firstPage.next_cursor,
        fetchPage: async (cursor) => {
          const page = await listFilesPage({ trashed: true, cursor });
          return { items: page.files, nextCursor: page.next_cursor };
        },
        onPage: setAllTrashEntries,
        isCancelled: () => mine !== fetchGeneration.current,
      });
      if (!pagination.complete || mine !== fetchGeneration.current) return;
      setListingComplete(true);
    } catch (err) {
      if (mine !== fetchGeneration.current) return;
      if (paintedFirstPage) setPageError(friendlyError(err));
      else setError(friendlyError(err));
    } finally {
      if (mine === fetchGeneration.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [localParentOf]);

  useEffect(() => {
    void fetchTrash();
    return () => { fetchGeneration.current += 1; };
  }, [fetchTrash]);

  const handleRestore = useCallback((item: FileEntry) => {
    const name = nameFor(item);
    Alert.alert(
      'Restore',
      `"${name}" will be restored to your Drive.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            try {
              const result = await restoreFile(item.id);
              void signalFileProviderTrashChanged();
              if (!result.complete) {
                notifyTrashChanged();
                showToast({
                  type: 'info',
                  message: `Restore started for "${name}". It is finishing in the background.`,
                });
                void fetchTrash(true);
                return;
              }
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setFiles((prev) => prev.filter((f) => f.id !== item.id));
              setAllTrashEntries((prev) => prev.filter((f) => f.id !== item.id));
              revealOptimisticallyTrashed([item.id]);
              void syncDecryptedEntriesToFileProvider(
                [item],
                { [item.id]: decryptedNames[item.id] ?? name },
                item.parent_id ?? null,
              );
              adjustTrashCount(-1);
              notifyTrashChanged();
              showToast({ type: 'success', message: `"${name}" restored to Drive` });
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [decryptedNames, fetchTrash, showToast, nameFor]);

  const handleDelete = useCallback((item: FileEntry) => {
    const name = nameFor(item);
    Alert.alert(
      'Delete permanently',
      `"${name}" will be deleted forever. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete permanently',
          style: 'destructive',
          onPress: async () => {
            const auth = await requestDeviceOwnerAuth('Authenticate to permanently delete this item');
            if (!auth.ok) {
              showToast({ type: auth.reason === 'cancelled' ? 'info' : 'error', message: auth.message });
              return;
            }
            try {
              const { confirmation_token } = await confirmDeviceOwnerAction({
                platform: auth.platform,
                method: auth.method,
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              const result = await deleteTrashItems(
                [item.id],
                id => permanentDeleteFile(id, confirmation_token),
              );
              if (result.failedIds.length > 0) throw result.error;
              setFiles((prev) => prev.filter((f) => f.id !== item.id));
              setAllTrashEntries((prev) => prev.filter((f) => f.id !== item.id));
              void removeFromFileProviderCache([item.id]);
              // 0818 — final cleanup across derived stores (idempotent; descendants
              // were already cascaded at trash time).
              void onFilesDeleted([item.id], { kind: 'permanent' });
              adjustTrashCount(-1);
              notifyTrashChanged();
              showToast({ type: 'info', message: `"${name}" permanently deleted` });
            } catch (err) {
              Alert.alert('Error', trashDeleteError(err));
            }
          },
        },
      ],
    );
  }, [showToast, nameFor]);

  const handleEmptyTrash = useCallback(() => {
    if (files.length === 0 || !listingComplete) return;
    const items = files;
    const visibleIds = new Set(items.map((file) => file.id));
    // Hidden manifest copies go with it: the user's confirmation below covers them, and they
    // are internal leftovers nobody could want back.
    const idsToDelete = [...new Set([...visibleIds, ...hiddenIds])];
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Empty Trash',
      `${items.length} item${items.length === 1 ? '' : 's'} will be permanently deleted. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Empty Trash',
          style: 'destructive',
          onPress: async () => {
            const auth = await requestDeviceOwnerAuth('Authenticate to empty Trash');
            if (!auth.ok) {
              showToast({ type: auth.reason === 'cancelled' ? 'info' : 'error', message: auth.message });
              return;
            }
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              setEmptyProgress({ kind: 'indeterminate', total: idsToDelete.length });
              const result = await deleteTrashItemsInBatches(idsToDelete, async batch => {
                const { confirmation_token } = await confirmDeviceOwnerAction({
                  platform: auth.platform,
                  method: auth.method,
                });
                return permanentDeleteFiles(batch, confirmation_token);
              }, progress => {
                setEmptyProgress(progress);
                if (progress.kind === 'determinate') {
                  const goneIds = [...(progress.deletedIds ?? []), ...(progress.missingIds ?? [])];
                  if (goneIds.length === 0) return;
                  const gone = new Set(goneIds);
                  setFiles(prev => prev.filter(file => !gone.has(file.id)));
                  setAllTrashEntries(prev => prev.filter(file => !gone.has(file.id)));
                  const visibleGone = goneIds.filter(id => visibleIds.has(id)).length;
                  if (visibleGone > 0) adjustTrashCount(-visibleGone);
                }
              }, recordRuntimeTrace);
              const goneIds = goneTrashIds(result);
              if (goneIds.length > 0) {
                void removeFromFileProviderCache(goneIds);
                void onFilesDeleted(goneIds, { kind: 'permanent' });
              }
              showToast({
                type: result.failedIds.length > 0 ? 'error' : 'success',
                message: trashDeletionMessage(result),
              });
              notifyTrashChanged();
              if (result.failedIds.length > 0) void fetchTrash(true);
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
              // Mid-loop failure: some rows are already server-deleted but the
              // optimistic removal below never ran — reconcile from the server.
              void fetchTrash(true);
            } finally {
              setEmptyProgress(null);
            }
          },
        },
      ],
    );
  }, [files, hiddenIds, listingComplete, showToast, fetchTrash]);

  const renderItem = useCallback(({ item }: { item: FileEntry }) => (
    <TrashRow
      item={item}
      decryptedName={decryptedNames[item.id] ?? null}
      onRestore={handleRestore}
      onDelete={handleDelete}
    />
  ), [decryptedNames, handleRestore, handleDelete]);

  const renderEmpty = () => {
    if (loading || loadingMore || emptyProgress) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="trash-outline" size={48} color={c.ink4} style={{ marginBottom: 12, opacity: 0.5 }} />
        <Text style={[styles.emptyTitle, { color: c.ink2 }]}>Trash is empty</Text>
        <Text style={[styles.emptySubtitle, { color: c.ink3 }]}>
          Files you delete will appear here before being permanently removed.
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {/* 1315 — content runs under the chrome. */}
      {isScrolled ? <ScrollEdgeBlur height={headerHeight || SCROLL_EDGE.chromeFallback} /> : null}
      <View
        style={[styles.header, styles.floatingHeader, { paddingTop: insets.top }]}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setHeaderHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
        }}
      >
        {/* 1342 — was a flat backgroundColor: c.paper2 / borderColor: c.line
            circle (the same off-recipe shape FilesScreen's back-button had
            before 1341). Now a GlassCircle reading the shared glassMaterial(),
            same as every other floating circle. The TouchableOpacity is the
            OUTER element wrapping GlassCircle (not nested inside it) — RN
            clips hitSlop to the parent view's bounds, so an inner pressable's
            hitSlop would be clipped to the fixed 30×30 circle instead of
            extending the touch target (the lesson FilesScreen's back-button
            hit-target fix learned the hard way). */}
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <GlassCircle scheme={themeScheme} size={30}>
            <Ionicons name="chevron-back" size={22} color={glassMaterial(themeScheme).label} />
          </GlassCircle>
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Trash</Text>
        <View style={{ flex: 1 }} />
        {files.length > 0 && listingComplete && (
          // 1342 — LIFTED VERBATIM from Trash.dc.html:82: a glass capsule,
          // height 42, radius 999, padding "0 18px", 15/600 red text — was a
          // bare Text touchable with no fill/border/glass at all. Colour
          // stays the app's c.red token (not the canvas's raw #E8443A),
          // matching FilesScreen's literal-destructive-red precedent (1341).
          <TouchableOpacity
            onPress={handleEmptyTrash}
            disabled={emptyProgress !== null || loadingMore}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Empty trash"
          >
            <GlassCapsule scheme={themeScheme} contentStyle={[styles.emptyTrashBody, emptyProgress ? styles.emptyTrashDisabled : undefined]}>
              {emptyProgress ? <ActivityIndicator size="small" color={c.red} /> : <Text style={[styles.emptyTrashBtn, { color: c.red }]}>Empty</Text>}
            </GlassCapsule>
          </TouchableOpacity>
        )}
      </View>

      {/* Content */}
      {error ? (
        <View style={styles.errorContainer}>
          <Text style={[styles.errorText, { color: c.red }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.retryButton, { backgroundColor: c.amber }]}
            onPress={() => fetchTrash()}
          >
            <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.amber} size="large" />
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          // Swipe hint — the list's own header, so it sits BELOW the floating
          // chrome (the contentContainer's paddingTop: headerHeight). Task 1588:
          // it used to be a normal-flow sibling of the absolutely positioned
          // header, which put it at y=0 — under the status bar on an iPhone and
          // above the header, under the window controls, on an iPad (compat
          // mode, iPadOS 27).
          ListHeaderComponent={
            <View>
              {emptyProgress ? (
                <View
                  style={[styles.progressBanner, { backgroundColor: c.amberBg, borderBottomColor: c.line }]}
                  accessibilityLiveRegion="polite"
                  accessibilityLabel={emptyTrashProgressLabel(emptyProgress)}
                >
                  <ActivityIndicator size="small" color={c.amberDeep} />
                  <Text style={[styles.progressText, { color: c.ink }]}>{emptyTrashProgressLabel(emptyProgress)}</Text>
                </View>
              ) : null}
              {loadingMore ? (
                <View
                  style={[styles.progressBanner, { backgroundColor: c.paper2, borderBottomColor: c.line }]}
                  accessibilityLiveRegion="polite"
                >
                  <ActivityIndicator size="small" color={c.amberDeep} />
                  <Text style={[styles.progressText, { color: c.ink }]}>Loading more items…</Text>
                </View>
              ) : null}
              {pageError ? (
                <View style={[styles.pageErrorBanner, { backgroundColor: c.paper2, borderBottomColor: c.line }]}>
                  <Text style={[styles.pageErrorText, { color: c.red }]}>{pageError}</Text>
                  <TouchableOpacity onPress={() => fetchTrash(true)} accessibilityRole="button">
                    <Text style={[styles.pageRetryText, { color: c.amberDeep }]}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {files.length > 0 ? (
                <View style={[styles.hintBanner, { backgroundColor: c.paper2, borderBottomColor: c.line }]}>
                  <Text style={[styles.hintText, { color: c.ink3 }]}>
                    Swipe left to restore or permanently delete
                  </Text>
                </View>
              ) : null}
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); fetchTrash(true); }}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
          contentContainerStyle={[files.length === 0 ? styles.emptyList : undefined, { paddingTop: headerHeight, paddingBottom: insets.bottom + 40 }]}
          // Without this `isScrolled` stays false forever and the blur never
          // appears — the same dead-state bug found on Photos in 1322.
          onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
          scrollEventThrottle={100}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },
  floatingHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // 1342 — the 30×30 circle itself is now a GlassCircle (glass-recipe.ts);
  // the outer TouchableOpacity (rendered inline above) just wraps it for an
  // unclipped hitSlop. backButtonText stays unused pre-existing dead code
  // (out of scope for this fidelity sweep).
  backButtonText: { fontSize: 20, fontWeight: '600', marginTop: -2 },
  title: { fontSize: 22, fontWeight: '700' },
  // 1342 — the capsule itself is a GlassCapsule (glass-recipe.ts, radius 999
  // from GLASS_RADII.capsule); this is the fixed 42pt height + "0 18px"
  // padding lifted verbatim from Trash.dc.html:82. fontSize 15/600 also
  // lifted (was 14/600, an app-default size with no canvas backing).
  emptyTrashBody: { minHeight: 42, paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  emptyTrashDisabled: { opacity: 0.65 },
  emptyTrashBtn: { fontSize: 15, fontWeight: '600' },

  progressBanner: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  progressText: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pageErrorBanner: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pageErrorText: { flex: 1, fontSize: 12 },
  pageRetryText: { fontSize: 13, fontWeight: '700' },

  hintBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hintText: { fontSize: 11 },

  // Swipe actions
  swipeActions: { flexDirection: 'row' },
  swipeAction: { width: 80, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeActionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: '500' },
  rowMeta: { fontSize: 11, marginTop: 2 },

  // Loading
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Empty
  emptyList: { flexGrow: 1 },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 8,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptySubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  // Error
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 16,
  },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: radii.md },
  retryButtonText: { fontSize: 14, fontWeight: '600' },
});
