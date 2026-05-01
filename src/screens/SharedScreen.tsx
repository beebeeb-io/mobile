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
import { colors, radii, spacing } from '../theme';
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

/** Determine file type label from the invite. */
function fileTypeLabel(invite: ShareInvite): string {
  if (invite.is_folder || invite.is_folder_share) return 'DIR';
  const mime = invite.mime_type ?? '';
  if (mime.startsWith('image/')) return 'IMG';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('audio/')) return 'AUD';
  if (mime.startsWith('video/')) return 'VID';
  if (mime.startsWith('text/') || mime.includes('document')) return 'DOC';
  return 'FILE';
}

function fileTypeColor(invite: ShareInvite): string {
  if (invite.is_folder || invite.is_folder_share) return colors.amberDeep;
  const mime = invite.mime_type ?? '';
  if (mime.startsWith('image/')) return colors.amber;
  if (mime === 'application/pdf') return colors.red;
  if (mime.startsWith('audio/')) return colors.green;
  return colors.ink3;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: colors.amberBg, text: colors.amberDeep, label: 'Pending' },
  claimed: { bg: '#e8f4fd', text: '#1a73e8', label: 'Claimed' },
  approved: { bg: '#e6f7e6', text: '#2d7d2d', label: 'Approved' },
  denied: { bg: '#fde8e8', text: colors.red, label: 'Denied' },
  expired: { bg: colors.paper2, text: colors.ink3, label: 'Expired' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      <Text style={[styles.badgeText, { color: s.text }]}>{s.label}</Text>
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

  const renderIncomingItem = ({ item }: { item: ShareInvite }) => (
    <View style={styles.row}>
      <View style={[styles.fileIcon, { backgroundColor: fileTypeColor(item) }]}>
        <Text style={styles.fileIconText}>{fileTypeLabel(item)}</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1}>{displayName(item)}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          From {item.sender_email ?? 'unknown'}  ·  {formatDate(item.created_at)}
        </Text>
      </View>
    </View>
  );

  const renderSentItem = ({ item }: { item: ShareInvite }) => (
    <View style={styles.row}>
      <View style={[styles.fileIcon, { backgroundColor: fileTypeColor(item) }]}>
        <Text style={styles.fileIconText}>{fileTypeLabel(item)}</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1}>{displayName(item)}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
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
        <Ionicons name={icon} size={44} color={colors.amberDeep} />
      </View>
      <Text style={styles.emptyTitle}>{message}</Text>
      <Text style={styles.emptyBody}>
        End-to-end encrypted — the server never sees your data.
      </Text>
    </View>
  );

  const renderError = (error: string, onRetry: () => void) => (
    <View style={styles.errorContainer}>
      <Text style={styles.errorText}>{error}</Text>
      <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
        <Text style={styles.retryButtonText}>Retry</Text>
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
    <View style={styles.root}>
      {/* Header */}
      <Text style={styles.title}>Shared</Text>

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, isIncoming && styles.tabActive]}
          onPress={() => setActiveTab('incoming')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, isIncoming && styles.tabTextActive]}>
            Shared with me
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, !isIncoming && styles.tabActive]}
          onPress={() => setActiveTab('sent')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, !isIncoming && styles.tabTextActive]}>
            Shared by me
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {error ? (
        renderError(error, onRetry)
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.amber} size="large" />
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
              tintColor={colors.amber}
              colors={[colors.amber]}
            />
          }
          contentContainerStyle={data.length === 0 ? styles.emptyList : undefined}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    paddingHorizontal: spacing.lg,
    paddingTop: 6,
    paddingBottom: 4,
  },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: colors.amber,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink3,
  },
  tabTextActive: {
    color: colors.ink,
    fontWeight: '600',
  },

  // List rows
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 12,
  },
  fileIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileIconText: {
    color: colors.paper,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink,
  },
  rowMeta: {
    fontSize: 11,
    color: colors.ink3,
    marginTop: 2,
  },

  // Status badge
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.sm,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },

  // Loading
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Empty
  emptyList: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 8,
  },
  emptyIconWrap: {
    marginBottom: 8,
    opacity: 0.85,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink2,
  },
  emptyBody: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Error
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 16,
  },
  errorText: {
    fontSize: 14,
    color: colors.red,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.amber,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
});
