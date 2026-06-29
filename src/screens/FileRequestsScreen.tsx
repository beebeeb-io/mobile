/**
 * FileRequestsScreen (0643)
 *
 * Lists the owner's file requests with received counts + status, lets them
 * re-share the link (rebuilt client-side from the wrapped private key) and close
 * a request to new uploads. Mirrors repos/web/src/pages/file-request.tsx.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { useTheme } from '../lib/theme-context';
import { useCrypto } from '../lib/crypto-context';
import { listFileRequests, closeFileRequest, type FileRequest } from '../lib/api';
import { fromBase64, toBase64url } from '../lib/file-request-crypto';
import { formatBytes } from '../lib/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Status = 'open' | 'closed' | 'expired';

function statusOf(r: FileRequest): Status {
  if (r.closed) return 'closed';
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return 'expired';
  return 'open';
}


// `embedded` (task 0782): rendered inside the Shared tab's "Requests" segment —
// suppress the screen's own header (the Shared screen provides the title + the "+").
export default function FileRequestsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { isUnlocked, rebuildRequestPublicKey } = useCrypto();

  const [requests, setRequests] = useState<FileRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { file_requests } = await listFileRequests();
      setRequests(file_requests);
    } catch {
      // leave the previous list; a transient failure shouldn't blank the screen
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const handleCopyLink = useCallback(
    async (r: FileRequest) => {
      if (!r.request_url || !r.wrapped_private_key || !r.wrap_nonce) {
        Alert.alert('Cannot rebuild link', 'This request is missing the key material needed to rebuild its link.');
        return;
      }
      if (!isUnlocked) {
        Alert.alert('Vault locked', 'Unlock your vault to rebuild the link.');
        return;
      }
      setBusyId(r.id);
      try {
        const rPub = await rebuildRequestPublicKey(fromBase64(r.wrapped_private_key), fromBase64(r.wrap_nonce));
        const link = `${r.request_url}#${toBase64url(rPub)}`;
        await Share.share({ message: link, title: r.title });
      } catch {
        Alert.alert('Could not rebuild the link', 'Please try again.');
      } finally {
        setBusyId(null);
      }
    },
    [isUnlocked, rebuildRequestPublicKey],
  );

  const handleClose = useCallback(
    (r: FileRequest) => {
      Alert.alert(
        'Close this request?',
        'No new uploads will be accepted. Files already received are kept.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Close request',
            style: 'destructive',
            onPress: async () => {
              setBusyId(r.id);
              try {
                await closeFileRequest(r.id);
                await refresh();
              } catch {
                Alert.alert('Could not close the request', 'Please try again.');
              } finally {
                setBusyId(null);
              }
            },
          },
        ],
      );
    },
    [refresh],
  );

  const statusColor = (s: Status): string => (s === 'open' ? c.green : c.ink3);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {!embedded && (
        <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: c.ink }]}>File requests</Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('CreateFileRequest')}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="New file request"
          >
            <Ionicons name="add" size={26} color={c.amberDeep} />
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={c.amber} />}
      >
        {loading ? (
          <Text style={[styles.muted, { color: c.ink3 }]}>Loading your requests…</Text>
        ) : requests.length === 0 ? (
          <View style={[styles.empty, { borderColor: c.line2, backgroundColor: c.paper2 }]}>
            <Ionicons name="link-outline" size={26} color={c.ink3} />
            <Text style={[styles.emptyTitle, { color: c.ink }]}>No file requests yet</Text>
            <Text style={[styles.emptyBody, { color: c.ink3 }]}>
              Create one to collect files from anyone — securely.
            </Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('CreateFileRequest')}
              style={[styles.cta, { backgroundColor: c.amber }]}
            >
              <Text style={styles.ctaText}>New request</Text>
            </TouchableOpacity>
          </View>
        ) : (
          requests.map((r) => {
            const status = statusOf(r);
            return (
              <View key={r.id} style={[styles.card, { borderColor: c.line2, backgroundColor: c.paper2 }]}>
                <View style={styles.cardTop}>
                  <Text style={[styles.cardTitle, { color: c.ink }]} numberOfLines={1}>
                    {r.title}
                  </Text>
                  <View style={[styles.pill, { backgroundColor: status === 'open' ? c.amberBg : c.paper }]}>
                    <Text style={[styles.pillText, { color: statusColor(status) }]}>
                      {status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : 'Expired'}
                    </Text>
                  </View>
                </View>
                {r.description ? (
                  <Text style={[styles.cardDesc, { color: c.ink3 }]} numberOfLines={2}>
                    {r.description}
                  </Text>
                ) : null}
                <View style={styles.metaRow}>
                  <Text style={[styles.meta, { color: c.ink3 }]}>
                    {r.files_received} / {r.max_files} files
                  </Text>
                  <Text style={[styles.meta, { color: c.ink3 }]}>
                    {formatBytes(r.total_bytes_received)}
                    {r.max_total_bytes != null ? ` / ${formatBytes(r.max_total_bytes)}` : ''} received
                  </Text>
                  {r.expires_at ? (
                    <Text style={[styles.meta, { color: c.ink3 }]}>
                      {status === 'expired' ? 'expired ' : 'expires '}
                      {new Date(r.expires_at).toLocaleDateString()}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.actions, { borderTopColor: c.line }]}>
                  {status === 'open' && (
                    <TouchableOpacity
                      onPress={() => handleCopyLink(r)}
                      disabled={busyId === r.id}
                      style={styles.action}
                    >
                      {busyId === r.id ? (
                        <ActivityIndicator size="small" color={c.amberDeep} />
                      ) : (
                        <>
                          <Ionicons name="share-outline" size={14} color={c.amberDeep} />
                          <Text style={[styles.actionText, { color: c.amberDeep }]}>Share link</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                  {status === 'open' && (
                    <TouchableOpacity
                      onPress={() => handleClose(r)}
                      disabled={busyId === r.id}
                      style={[styles.action, styles.actionRight]}
                    >
                      <Text style={[styles.actionText, { color: c.ink3 }]}>Close</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })
        )}
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
  muted: { fontSize: 13, textAlign: 'center', marginTop: 40 },
  empty: { borderWidth: 1, borderRadius: 14, padding: 28, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '600', marginTop: 4 },
  emptyBody: { fontSize: 12, textAlign: 'center', marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 10.5, fontWeight: '600' },
  cardDesc: { fontSize: 12, marginTop: 4 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  meta: { fontSize: 11 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionRight: { marginLeft: 'auto' },
  actionText: { fontSize: 12, fontWeight: '500' },
  cta: { borderRadius: 10, paddingVertical: 11, paddingHorizontal: 20, marginTop: 6 },
  ctaText: { fontSize: 14, fontWeight: '600', color: '#16110a' },
});
