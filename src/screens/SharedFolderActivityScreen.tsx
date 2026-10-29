import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../App';
import { useTheme } from '../lib/theme-context';
import { useSharedFoldersFlag } from '../lib/use-shared-folders-flag';
import { loadAccountFolderActivity, loadFolderActivity, type FolderActivityGroup } from '../lib/folder-activity';
import { accountEpoch, isCurrentAccountEpoch, isStaleAccountError, onAccountEpochAdvance } from '../lib/account-epoch';
import { formatDateTime } from '../lib/date-format';
export default function SharedFolderActivityScreen() {
  const { colors: c } = useTheme();
  const { params } = useRoute<RouteProp<RootStackParamList, 'SharedFolderActivity'>>();
  const folderId = params?.folderId;
  const flag = useSharedFoldersFlag();
  const [groups, setGroups] = useState<FolderActivityGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => onAccountEpochAdvance(() => { setGroups([]); setFailed(false); }), []);
  useEffect(() => {
    let active = true;
    const epoch = accountEpoch();
    setGroups([]); setFailed(false);
    if (flag.loading || !flag.enabled) { setLoading(flag.loading); return () => { active = false; }; }
    setLoading(true);
    const load = async () => {
      try {
        const next = folderId ? [{ folderId, rows: await loadFolderActivity(folderId, 50), failed: false }] : await loadAccountFolderActivity();
        if (active && isCurrentAccountEpoch(epoch)) setGroups(next);
      } catch (err) {
        if (active && isCurrentAccountEpoch(epoch) && !isStaleAccountError(err)) setFailed(true);
      } finally { if (active && isCurrentAccountEpoch(epoch)) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [folderId, flag.enabled, flag.loading, attempt]);
  const retry = <TouchableOpacity accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={{ paddingVertical: 12 }}><Text style={{ color: c.ink, fontWeight: '600' }}>Retry</Text></TouchableOpacity>;
  const hasRows = groups.some(group => group.rows.length > 0);
  return <ScrollView testID="shared-folder-activity-screen" style={{ flex: 1, backgroundColor: c.paper }} contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 16 }}>
    {loading ? <ActivityIndicator color={c.ink3} /> : !flag.enabled ? <Text style={{ color: c.ink2 }}>Folder activity is not available.</Text> : failed ? <View><Text style={{ color: c.ink2 }}>Couldn't load activity. Try again.</Text>{retry}</View> : <>
      {!hasRows && !groups.some(group => group.failed) && <Text style={{ color: c.ink3 }}>No activity yet.</Text>}
      {groups.map((group, index) => <View key={group.folderId} testID={`folder-activity-group-${group.folderId}`} style={{ gap: 8 }}>
        {!folderId && <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>Shared folder {index + 1}</Text>}
        {group.failed ? <View><Text style={{ color: c.ink2 }}>Couldn't load activity for this folder.</Text>{retry}</View> : group.rows.map(row => <View key={row.id} style={{ borderBottomWidth: 1, borderBottomColor: c.line, paddingVertical: 12, gap: 6 }}>
          <Text style={{ color: c.ink, fontSize: 14, lineHeight: 21 }}>{row.text}</Text>
          <Text style={{ color: c.ink3, fontSize: 12 }}>{formatDateTime(row.last_at)}</Text>
        </View>)}
      </View>)}
    </>}
  </ScrollView>;
}
