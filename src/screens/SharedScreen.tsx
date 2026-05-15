import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import SkeletonRow from '../components/SkeletonRow';
import { useCrypto } from '../lib/crypto-context';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import { guessMimeType } from '../lib/media';
import { getIncomingInvites, listMyShares, friendlyError } from '../lib/api';
import type { ShareInvite, MyShareLink } from '../lib/api';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an ISO date string into a short date. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  const month = date.toLocaleString('en', { month: 'short' });
  const day = date.getDate();
  const year = date.getFullYear();
  if (year === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${year}`;
}

/** Display name for an invite's encrypted filename (fallback when crypto unavailable). */
function displayInviteName(invite: ShareInvite): string {
  const raw = invite.file_name_encrypted;
  if (!raw) return invite.is_folder ? 'Shared folder' : 'Shared file';
  if (raw.startsWith('{')) return invite.is_folder ? 'Encrypted folder' : 'Encrypted file';
  if (raw.length > 28) return raw.slice(0, 24) + '...';
  return raw;
}

/** Display name for a share link's encrypted filename (fallback when crypto unavailable). */
function displayShareLinkName(link: MyShareLink): string {
  const raw = link.file.name_encrypted;
  if (!raw) return 'Shared file';
  if (raw.startsWith('{')) return 'Encrypted file';
  if (raw.length > 28) return raw.slice(0, 24) + '...';
  return raw;
}

/**
 * Parse decrypted metadata JSON into a display name and optional MIME type.
 * Decrypted metadata is either `{"name":"file.jpg","mime_type":"image/jpeg"}`
 * or a bare filename string (legacy format).
 */
function parseDecryptedMetadata(plaintext: string): { name: string; mimeType: string | null } {
  try {
    const metadata = JSON.parse(plaintext) as { name?: unknown; mime_type?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string') {
      const name = metadata.name.trim();
      if (name) {
        return {
          name,
          mimeType: typeof metadata.mime_type === 'string' ? metadata.mime_type : null,
        };
      }
    }
  } catch {
    // Legacy metadata format: plaintext is the bare filename.
  }
  return { name: plaintext || 'Shared file', mimeType: null };
}

function expiryLabel(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt);
  const now = new Date();
  if (Number.isNaN(expires.getTime())) return null;
  const diffMs = expires.getTime() - now.getTime();
  if (diffMs <= 0) return 'Expired';
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `Expires in ${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 48) return `Expires in ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) return `Expires in ${diffDays}d`;
  return `Expires ${formatDate(expiresAt)}`;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function mimeIcon(mime: string | null | undefined): IoniconName {
  const m = mime ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'document-text';
  if (m.startsWith('audio/')) return 'musical-notes';
  if (m.startsWith('video/')) return 'videocam';
  if (m.startsWith('text/') || m.includes('document')) return 'document';
  return 'document-outline';
}

function fileTypeIconForInvite(invite: ShareInvite): IoniconName {
  if (invite.is_folder || invite.is_folder_share) return 'folder';
  return mimeIcon(invite.mime_type);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

const INVITE_STATUS_INFO: Record<string, { label: string; text: string; lightBg: string; darkBg: string }> = {
  claimed:  { label: 'Claimed',  text: '#1a73e8', lightBg: '#e8f4fd', darkBg: 'rgba(26,115,232,0.15)' },
  approved: { label: 'Approved', text: '#2d7d2d', lightBg: '#e6f7e6', darkBg: 'rgba(45,125,45,0.15)' },
  denied:   { label: 'Denied',   text: '#d84040', lightBg: '#fde8e8', darkBg: 'rgba(216,64,64,0.12)' },
};

function InviteStatusBadge({ status }: { status: string }) {
  const { colors: c, resolved } = useTheme();
  const isDark = resolved === 'dark';

  if (status === 'expired') {
    return (
      <View style={[styles.badge, { backgroundColor: c.paper2 }]}>
        <Text style={[styles.badgeText, { color: c.ink3 }]}>Expired</Text>
      </View>
    );
  }
  if (status === 'pending') {
    return (
      <View style={[styles.badge, { backgroundColor: c.amberBg }]}>
        <Text style={[styles.badgeText, { color: c.amberDeep }]}>Pending</Text>
      </View>
    );
  }
  const info = INVITE_STATUS_INFO[status];
  if (!info) return null;
  const bg = isDark ? info.darkBg : info.lightBg;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: info.text }]}>{info.label}</Text>
    </View>
  );
}

function ShareLinkBadge({ link }: { link: MyShareLink }) {
  const { colors: c, resolved } = useTheme();
  const isDark = resolved === 'dark';

  if (link.revoked) {
    return (
      <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(216,64,64,0.12)' : '#fde8e8' }]}>
        <Text style={[styles.badgeText, { color: '#d84040' }]}>Revoked</Text>
      </View>
    );
  }

  // Check if expired
  if (link.expires_at) {
    const expires = new Date(link.expires_at);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() <= Date.now()) {
      return (
        <View style={[styles.badge, { backgroundColor: c.paper2 }]}>
          <Text style={[styles.badgeText, { color: c.ink3 }]}>Expired</Text>
        </View>
      );
    }
  }

  return (
    <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(45,125,45,0.15)' : '#e6f7e6' }]}>
      <Text style={[styles.badgeText, { color: '#2d7d2d' }]}>Active</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = 'incoming' | 'links';

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SharedScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [activeTab, setActiveTab] = useState<Tab>('links');
  const [isScrolled, setIsScrolled] = useState(false);

  // Crypto — for decrypting share link filenames
  const { isUnlocked, decryptMetadata } = useCrypto();

  // Incoming invites
  const [incoming, setIncoming] = useState<ShareInvite[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(true);
  const [incomingRefreshing, setIncomingRefreshing] = useState(false);
  const [incomingError, setIncomingError] = useState<string | null>(null);

  // My share links
  const [links, setLinks] = useState<MyShareLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksRefreshing, setLinksRefreshing] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [decryptedLinkNames, setDecryptedLinkNames] = useState<Record<string, string>>({});
  const [decryptedLinkMimes, setDecryptedLinkMimes] = useState<Record<string, string | null>>({});

  // ------------------------------------------------------------------
  // Fetch functions
  // ------------------------------------------------------------------

  const fetchIncoming = useCallback(async (isRefresh = false) => {
    if (isRefresh) setIncomingRefreshing(true);
    else setIncomingLoading(true);
    setIncomingError(null);

    try {
      const result = await getIncomingInvites();
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setIncoming(result);
    } catch (err) {
      setIncomingError(friendlyError(err));
    } finally {
      setIncomingLoading(false);
      setIncomingRefreshing(false);
    }
  }, []);

  const fetchLinks = useCallback(async (isRefresh = false) => {
    if (isRefresh) setLinksRefreshing(true);
    else setLinksLoading(true);
    setLinksError(null);

    try {
      const result = await listMyShares();
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setLinks(result);
    } catch (err) {
      setLinksError(friendlyError(err));
    } finally {
      setLinksLoading(false);
      setLinksRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchIncoming();
      fetchLinks();
    }, [fetchIncoming, fetchLinks])
  );

  // Decrypt share link filenames when links or unlock state changes
  useEffect(() => {
    if (!isUnlocked || links.length === 0) {
      if (!isUnlocked) {
        setDecryptedLinkNames({});
        setDecryptedLinkMimes({});
      }
      return;
    }
    const names: Record<string, string> = {};
    const mimes: Record<string, string | null> = {};
    Promise.all(
      links.map(async (link) => {
        try {
          const raw = link.file.name_encrypted ?? '';
          if (!raw.startsWith('{')) {
            // Legacy unencrypted name — use directly
            if (raw) names[link.id] = raw;
            return;
          }
          const payload = encryptedMetadataPayloadToBytes(raw);
          if (!payload) return;
          const plaintext = await decryptMetadata(link.file_id, payload.nonce, payload.ciphertext);
          const metadata = parseDecryptedMetadata(plaintext);
          names[link.id] = metadata.name;
          mimes[link.id] = metadata.mimeType;
        } catch {
          // Decryption failure — displayShareLinkName() handles the fallback
        }
      }),
    ).then(() => {
      // Enrich MIME types from decrypted filenames when server row has no MIME
      for (const link of links) {
        if (link.file.mime_type != null) continue;
        const name = names[link.id];
        if (!name) continue;
        const guessed = guessMimeType(name);
        if (guessed) mimes[link.id] = mimes[link.id] ?? guessed;
      }
      setDecryptedLinkNames({ ...names });
      setDecryptedLinkMimes({ ...mimes });
    });
  }, [links, isUnlocked, decryptMetadata]);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const inviteMimeColor = (invite: ShareInvite): string => {
    if (invite.is_folder || invite.is_folder_share) return c.amberDeep;
    const mime = invite.mime_type ?? '';
    if (mime.startsWith('image/')) return c.amber;
    if (mime === 'application/pdf') return c.red;
    if (mime.startsWith('audio/')) return c.green;
    return c.ink3;
  };

  const linkMimeColor = (link: MyShareLink): string => {
    const mime = decryptedLinkMimes[link.id] ?? link.file.mime_type ?? '';
    if (mime.startsWith('image/')) return c.amber;
    if (mime === 'application/pdf') return c.red;
    if (mime.startsWith('audio/')) return c.green;
    return c.ink3;
  };

  const linkIcon = (link: MyShareLink): IoniconName => {
    const mime = decryptedLinkMimes[link.id] ?? link.file.mime_type;
    return mimeIcon(mime);
  };

  const openInvitePreview = useCallback(
    (item: ShareInvite) => {
      Haptics.selectionAsync();
      navigation.navigate('Preview', {
        fileId: item.file_id,
        fileName: item.file_name_encrypted ?? (item.is_folder || item.is_folder_share ? 'Shared folder' : 'Shared file'),
        mimeType: item.mime_type,
        sizeBytes: item.size_bytes,
        createdAt: item.created_at,
        chunkCount: item.chunk_count,
      });
    },
    [navigation],
  );

  const openShareLinkPreview = useCallback(
    (link: MyShareLink) => {
      Haptics.selectionAsync();
      const name = decryptedLinkNames[link.id] ?? displayShareLinkName(link);
      const mime = decryptedLinkMimes[link.id] ?? link.file.mime_type ?? undefined;
      navigation.navigate('Preview', {
        fileId: link.file_id,
        fileName: name,
        mimeType: mime,
        sizeBytes: link.file.size_bytes,
        createdAt: link.created_at,
      });
    },
    [navigation, decryptedLinkNames, decryptedLinkMimes],
  );

  const renderIncomingItem = ({ item }: { item: ShareInvite }) => {
    const tappable = item.status === 'approved';
    return (
      <TouchableOpacity
        activeOpacity={tappable ? 0.6 : 1}
        onPress={tappable ? () => openInvitePreview(item) : undefined}
        accessibilityRole="button"
        accessibilityLabel={`Shared file ${displayInviteName(item)} from ${item.sender_email ?? 'unknown'}`}
        style={[styles.row, { borderBottomColor: c.line }]}
      >
        <View style={[styles.fileIcon, { backgroundColor: inviteMimeColor(item) }]}>
          <Ionicons name={fileTypeIconForInvite(item)} size={16} color="#FFFFFF" />
        </View>
        <View style={styles.rowInfo}>
          <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={1}>{displayInviteName(item)}</Text>
          <Text style={[styles.rowMeta, { color: c.ink3 }]} numberOfLines={1}>
            {[`From ${item.sender_email ?? 'unknown'}`, formatDate(item.created_at), expiryLabel(item.expires_at)]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </View>
        <InviteStatusBadge status={item.status} />
      </TouchableOpacity>
    );
  };

  const renderLinkItem = ({ item }: { item: MyShareLink }) => {
    const name = decryptedLinkNames[item.id] ?? displayShareLinkName(item);
    const stats: string[] = [];
    if (item.open_count > 0) stats.push(`${item.open_count} view${item.open_count !== 1 ? 's' : ''}`);
    if (item.download_count > 0) stats.push(`${item.download_count} download${item.download_count !== 1 ? 's' : ''}`);
    const expiry = expiryLabel(item.expires_at);

    const metaParts = [
      formatBytes(item.file.size_bytes),
      formatDate(item.created_at),
      ...stats,
      expiry,
    ].filter(Boolean);

    return (
      <TouchableOpacity
        activeOpacity={item.revoked ? 1 : 0.6}
        onPress={item.revoked ? undefined : () => openShareLinkPreview(item)}
        accessibilityRole="button"
        accessibilityLabel={`Share link for ${name}`}
        style={[styles.row, { borderBottomColor: c.line }, item.revoked && { opacity: 0.55 }]}
      >
        <View style={[styles.fileIcon, { backgroundColor: linkMimeColor(item) }]}>
          <Ionicons name={linkIcon(item)} size={16} color="#FFFFFF" />
        </View>
        <View style={styles.rowInfo}>
          <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={1}>{name}</Text>
          <Text style={[styles.rowMeta, { color: c.ink3 }]} numberOfLines={1}>
            {metaParts.join('  ·  ')}
          </Text>
        </View>
        <ShareLinkBadge link={item} />
      </TouchableOpacity>
    );
  };

  const renderEmpty = (
    message: string,
    icon: React.ComponentProps<typeof Ionicons>['name'],
  ) => () => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name={icon} size={44} color={c.amberDeep} />
      </View>
      <Text style={[styles.emptyTitle, { color: c.ink2 }]}>{message}</Text>
      <Text style={[styles.emptyBody, { color: c.ink3 }]}>
        End-to-end encrypted — the server never sees your data.
      </Text>
    </View>
  );

  const renderError = (error: string, onRetry: () => void) => (
    <View style={styles.errorContainer}>
      <Ionicons name="cloud-offline-outline" size={48} color={c.ink3} />
      <Text style={[styles.errorText, { color: c.ink2 }]}>{error}</Text>
      <TouchableOpacity
        style={[styles.retryButton, { backgroundColor: c.amber }]}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry"
      >
        <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  // Current tab data
  const isIncoming = activeTab === 'incoming';

  // ------------------------------------------------------------------
  // Main render
  // ------------------------------------------------------------------

  const currentError = isIncoming ? incomingError : linksError;
  const currentLoading = isIncoming
    ? (incomingLoading && !incomingRefreshing)
    : (linksLoading && !linksRefreshing);
  const currentRefreshing = isIncoming ? incomingRefreshing : linksRefreshing;
  const onRefresh = isIncoming
    ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); fetchIncoming(true); }
    : () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); fetchLinks(true); };
  const onRetry = isIncoming ? () => fetchIncoming() : () => fetchLinks();

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.paper }]}>
      {/* Header area */}
      <View style={[isScrolled && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line }]}>
      {/* Title */}
      <Text style={[styles.title, { color: c.ink }]}>Shared</Text>

      {/* Tabs */}
      <View style={styles.tabBar} accessibilityRole="tablist">
        <TouchableOpacity
          style={[styles.tab, !isIncoming && [styles.tabActive, { borderBottomColor: c.amber }]]}
          onPress={() => setActiveTab('links')}
          activeOpacity={0.7}
          accessibilityRole="tab"
          accessibilityState={{ selected: !isIncoming }}
          accessibilityLabel="My links"
        >
          <Text style={[styles.tabText, { color: c.ink3 }, !isIncoming && [styles.tabTextActive, { color: c.ink }]]}>
            My links
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, isIncoming && [styles.tabActive, { borderBottomColor: c.amber }]]}
          onPress={() => setActiveTab('incoming')}
          activeOpacity={0.7}
          accessibilityRole="tab"
          accessibilityState={{ selected: isIncoming }}
          accessibilityLabel="Shared with me"
        >
          <Text style={[styles.tabText, { color: c.ink3 }, isIncoming && [styles.tabTextActive, { color: c.ink }]]}>
            Shared with me
          </Text>
        </TouchableOpacity>
      </View>
      </View>{/* end header area */}

      {/* Content */}
      {currentError ? (
        renderError(currentError, onRetry)
      ) : currentLoading ? (
        <View>
          {[0, 1, 2].map((i) => <SkeletonRow key={i} />)}
        </View>
      ) : isIncoming ? (
        <FlatList
          data={incoming}
          keyExtractor={(item) => item.id}
          renderItem={renderIncomingItem}
          ListEmptyComponent={renderEmpty('No shared files yet', 'people-outline')}
          onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
          scrollEventThrottle={100}
          refreshControl={
            <RefreshControl
              refreshing={incomingRefreshing}
              onRefresh={onRefresh}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
          contentContainerStyle={incoming.length === 0 ? styles.emptyList : undefined}
          keyboardDismissMode="on-drag"
        />
      ) : (
        <FlatList
          data={links}
          keyExtractor={(item) => item.id}
          renderItem={renderLinkItem}
          ListEmptyComponent={renderEmpty('No share links yet', 'link-outline')}
          onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
          scrollEventThrottle={100}
          refreshControl={
            <RefreshControl
              refreshing={linksRefreshing}
              onRefresh={onRefresh}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
          contentContainerStyle={links.length === 0 ? styles.emptyList : undefined}
          keyboardDismissMode="on-drag"
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
  title: { fontSize: 28, fontWeight: '700', paddingHorizontal: spacing.lg, paddingTop: 6, paddingBottom: 4 },

  // Tab bar
  tabBar: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 4 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: 'transparent' },
  tabText: { fontSize: 14, fontWeight: '500' },
  tabTextActive: { fontWeight: '600' },

  // List rows
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: spacing.lg, borderBottomWidth: 1, gap: 12 },
  fileIcon: { width: 32, height: 32, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 14, fontWeight: '500' },
  rowMeta: { fontSize: 11, marginTop: 2 },

  // Status badge
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.sm },
  badgeText: { fontSize: 11, fontWeight: '600' },

  // Loading
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Empty
  emptyList: { flexGrow: 1 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 8 },
  emptyIconWrap: { marginBottom: 8, opacity: 0.85 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyBody: { fontSize: 13, textAlign: 'center', lineHeight: 20 },

  // Error
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: 16 },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: radii.md },
  retryButtonText: { fontSize: 14, fontWeight: '600' },
});
