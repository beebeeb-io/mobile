import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { getIncomingInvites, getSentInvites, friendlyError } from '../lib/api';
import type { ShareInvite } from '../lib/api';

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

/**
 * Display name for an encrypted filename.
 * Until UniFFI crypto bindings land, show a truncated version.
 */
function displayName(invite: ShareInvite): string {
  const raw = invite.file_name_encrypted;
  if (!raw) return invite.is_folder ? 'Shared folder' : 'Shared file';
  if (raw.length > 28) return raw.slice(0, 24) + '...';
  return raw;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function fileTypeIcon(invite: ShareInvite): IoniconName {
  if (invite.is_folder || invite.is_folder_share) return 'folder';
  const mime = invite.mime_type ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'document-text';
  if (mime.startsWith('audio/')) return 'musical-notes';
  if (mime.startsWith('video/')) return 'videocam';
  if (mime.startsWith('text/') || mime.includes('document')) return 'document';
  return 'document-outline';
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_INFO: Record<string, { label: string; text: string; lightBg: string; darkBg: string }> = {
  claimed:  { label: 'Claimed',  text: '#1a73e8', lightBg: '#e8f4fd', darkBg: 'rgba(26,115,232,0.15)' },
  approved: { label: 'Approved', text: '#2d7d2d', lightBg: '#e6f7e6', darkBg: 'rgba(45,125,45,0.15)' },
  denied:   { label: 'Denied',   text: '#d84040', lightBg: '#fde8e8', darkBg: 'rgba(216,64,64,0.12)' },
};

function StatusBadge({ status }: { status: string }) {
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
  const info = STATUS_INFO[status];
  if (!info) return null;
  const bg = isDark ? info.darkBg : info.lightBg;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: info.text }]}>{info.label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = 'incoming' | 'sent';

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SharedScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>('incoming');

  // Incoming invites
  const [incoming, setIncoming] = useState<ShareInvite[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(true);
  const [incomingRefreshing, setIncomingRefreshing] = useState(false);
  const [incomingError, setIncomingError] = useState<string | null>(null);

  // Sent invites
  const [sent, setSent] = useState<ShareInvite[]>([]);
  const [sentLoading, setSentLoading] = useState(true);
  const [sentRefreshing, setSentRefreshing] = useState(false);
  const [sentError, setSentError] = useState<string | null>(null);

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

  const fetchSent = useCallback(async (isRefresh = false) => {
    if (isRefresh) setSentRefreshing(true);
    else setSentLoading(true);
    setSentError(null);

    try {
      const result = await getSentInvites();
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setSent(result);
    } catch (err) {
      setSentError(friendlyError(err));
    } finally {
      setSentLoading(false);
      setSentRefreshing(false);
    }
  }, []);

  // Fetch both on mount
  useEffect(() => {
    fetchIncoming();
    fetchSent();
  }, [fetchIncoming, fetchSent]);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const fileTypeColor = (invite: ShareInvite): string => {
    if (invite.is_folder || invite.is_folder_share) return c.amberDeep;
    const mime = invite.mime_type ?? '';
    if (mime.startsWith('image/')) return c.amber;
    if (mime === 'application/pdf') return c.red;
    if (mime.startsWith('audio/')) return c.green;
    return c.ink3;
  };

  const renderIncomingItem = ({ item }: { item: ShareInvite }) => (
    <View style={[styles.row, { borderBottomColor: c.line }]}>
      <View style={[styles.fileIcon, { backgroundColor: fileTypeColor(item) }]}>
        <Ionicons name={fileTypeIcon(item)} size={16} color="#FFFFFF" />
      </View>
      <View style={styles.rowInfo}>
        <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={1}>{displayName(item)}</Text>
        <Text style={[styles.rowMeta, { color: c.ink3 }]} numberOfLines={1}>
          From {item.sender_email ?? 'unknown'}  ·  {formatDate(item.created_at)}
        </Text>
      </View>
    </View>
  );

  const renderSentItem = ({ item }: { item: ShareInvite }) => (
    <View style={[styles.row, { borderBottomColor: c.line }]}>
      <View style={[styles.fileIcon, { backgroundColor: fileTypeColor(item) }]}>
        <Ionicons name={fileTypeIcon(item)} size={16} color="#FFFFFF" />
      </View>
      <View style={styles.rowInfo}>
        <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={1}>{displayName(item)}</Text>
        <Text style={[styles.rowMeta, { color: c.ink3 }]} numberOfLines={1}>
          To {item.recipient_email}  ·  {formatDate(item.created_at)}
        </Text>
      </View>
      <StatusBadge status={item.status} />
    </View>
  );

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
      <TouchableOpacity style={[styles.retryButton, { backgroundColor: c.amber }]} onPress={onRetry}>
        <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  // Current tab data
  const isIncoming = activeTab === 'incoming';
  const data = isIncoming ? incoming : sent;
  const loading = isIncoming ? incomingLoading : sentLoading;
  const refreshing = isIncoming ? incomingRefreshing : sentRefreshing;
  const error = isIncoming ? incomingError : sentError;
  const onRefresh = isIncoming
    ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); fetchIncoming(true); }
    : () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); fetchSent(true); };
  const onRetry = isIncoming ? () => fetchIncoming() : () => fetchSent();
  const renderItem = isIncoming ? renderIncomingItem : renderSentItem;
  const emptyMessage = isIncoming
    ? 'No shared files yet'
    : 'Nothing sent yet';
  const emptyIcon: React.ComponentProps<typeof Ionicons>['name'] = isIncoming
    ? 'people-outline'
    : 'share-outline';

  // ------------------------------------------------------------------
  // Main render
  // ------------------------------------------------------------------

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.paper }]}>
      {/* Header */}
      <Text style={[styles.title, { color: c.ink }]}>Shared</Text>

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, isIncoming && [styles.tabActive, { borderBottomColor: c.amber }]]}
          onPress={() => setActiveTab('incoming')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, { color: c.ink3 }, isIncoming && [styles.tabTextActive, { color: c.ink }]]}>
            Shared with me
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, !isIncoming && [styles.tabActive, { borderBottomColor: c.amber }]]}
          onPress={() => setActiveTab('sent')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, { color: c.ink3 }, !isIncoming && [styles.tabTextActive, { color: c.ink }]]}>
            Shared by me
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {error ? (
        renderError(error, onRetry)
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.amber} size="large" />
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty(emptyMessage, emptyIcon)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
          contentContainerStyle={data.length === 0 ? styles.emptyList : undefined}
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
  title: { fontSize: 24, fontWeight: '700', paddingHorizontal: spacing.lg, paddingTop: 6, paddingBottom: 4 },

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
