import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { BottomSheetScrollView } from '../sheet/BottomSheet';
import { useCrypto } from '../../lib/crypto-context';
import { useTheme } from '../../lib/theme-context';
import { friendlyError, getFolderMembers, listFolderLinks, revokeFolderLink, updateFolderLink } from '../../lib/api';
import { linkErrorCode, type FolderLink, type FolderMember } from '../../lib/folder-link-types';
import { createFolderLinkPorts, createFolderLinkWithKeys, folderLinkNative, FolderPassphraseError, recoverLinkUrl, type CreateFolderLinkInput } from '../../lib/folder-link-create';
import { accountEpoch, isCurrentAccountEpoch, isStaleAccountError } from '../../lib/account-epoch';
import { cachedNameConvention } from '../../lib/sf-0002-write-state';
import { FolderLinkRow, folderAccessCopy } from './FolderLinkRow';
import { CreateFolderLinkForm } from './CreateFolderLinkForm';
interface Props { folderId: string; folderName: string; onClose(): void; onUnavailable?(): void }
interface LinkView { link: FolderLink; label: string | null; url: string | null }
export function FolderSharePanel({ folderId, folderName, onClose, onUnavailable }: Props) {
  const { colors: c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList & { SharedFolderActivity: { folderId?: string } | undefined }>>();
  const { getMasterKeyHandleId } = useCrypto();
  // SF-0002 M2a run 3: leave out descendants whose name is Binary/UpperRepair
  // (the name half is already cached from folder listing).
  const ports = useMemo(() => ({
    ...createFolderLinkPorts(getMasterKeyHandleId),
    excluded: (id: string) => {
      const convention = cachedNameConvention(id);
      return convention === 'binary' || convention === 'upper_repair';
    },
  }), [getMasterKeyHandleId]);
  const [rows, setRows] = useState<LinkView[]>([]);
  const [members, setMembers] = useState<FolderMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: 'preparing' | 'securing'; done: number; total: number } | null>(null);
  const [passphraseFailed, setPassphraseFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const urls = useRef(new Map<string, string>());
  const report = useCallback((err: unknown) => {
    if (isStaleAccountError(err) || !active.current) return;
    if (linkErrorCode(err) === 'shared_folders_v1') { onUnavailable?.(); return; }
    setError(friendlyError(err));
  }, [onUnavailable]);
  const load = useCallback(async () => {
    const epoch = accountEpoch();
    const [links, people] = await Promise.all([listFolderLinks(folderId), getFolderMembers(folderId)]);
    if (!active.current || !isCurrentAccountEpoch(epoch)) return;
    // C2 Task 5 Interface, pending merge. Tests use a MARKED MOCK.
    const resolver = (require('../../lib/shared-folder-keys') as { getSharedKeyResolver(): { folderHandleFor(id: string): Promise<number | null> } | null }).getSharedKeyResolver();
    const handle = await resolver?.folderHandleFor(folderId) ?? null;
    if (!active.current || !isCurrentAccountEpoch(epoch)) return;
    const next: LinkView[] = [];
    for (const link of links.filter(row => !row.revoked_at)) {
      let label: string | null = null;
      if (handle !== null && link.label_encrypted) {
        try { label = await folderLinkNative.sharedFolderDecryptName(handle, link.label_encrypted); } catch { /* unknown label */ }
      }
      const url = urls.current.get(link.id) ?? (handle !== null ? await recoverLinkUrl(link, handle, ports) : null);
      if (!active.current || !isCurrentAccountEpoch(epoch)) return;
      next.push({ link, label, url });
    }
    setMembers(people.members.filter(person => !person.is_owner && person.role !== 'owner'));
    setRows(next);
  }, [folderId, ports]);
  useEffect(() => {
    active.current = true; setLoading(true);
    void load().catch(report).finally(() => { if (active.current) setLoading(false); });
    return () => { active.current = false; controller.current?.abort(); urls.current.clear(); };
  }, [load, report]);
  const create = async (input: CreateFolderLinkInput) => {
    if (working !== null) return;
    const epoch = accountEpoch();
    const abort = new AbortController(); controller.current = abort;
    setWorking('create'); setError(null); setNotice(null); setPassphraseFailed(false); setProgress({ phase: 'preparing', done: 0, total: 0 });
    try {
      const result = await createFolderLinkWithKeys({ ...input, signal: abort.signal, onProgress: value => { if (active.current && isCurrentAccountEpoch(epoch)) setProgress(value); } }, ports);
      if (!active.current || !isCurrentAccountEpoch(epoch)) return;
      if (result.excludedCount) setNotice(`${result.excludedCount} ${result.excludedCount === 1 ? 'file' : 'files'} can't be shared yet`);
      urls.current.set(result.id, result.url); await load();
    } catch (err) {
      if (!active.current || !isCurrentAccountEpoch(epoch) || isStaleAccountError(err) || (err as Error)?.name === 'AbortError') return;
      if (err instanceof FolderPassphraseError) setPassphraseFailed(true); else report(err);
    } finally {
      if (active.current && isCurrentAccountEpoch(epoch)) { setWorking(null); setProgress(null); }
      controller.current = null;
    }
  };
  const mutate = async (row: LinkView, revoke: boolean) => {
    if (working !== null) return;
    const epoch = accountEpoch(); setWorking(row.link.id); setError(null);
    try {
      if (revoke) {
        await revokeFolderLink(row.link.id);
        if (active.current && isCurrentAccountEpoch(epoch)) { urls.current.delete(row.link.id); setRows(values => values.filter(value => value.link.id !== row.link.id)); }
      } else {
        const updated = await updateFolderLink(row.link.id, { paused: !row.link.paused });
        if (active.current && isCurrentAccountEpoch(epoch)) setRows(values => values.map(value => value.link.id === updated.id ? { ...value, link: updated } : value));
      }
    } catch (err) { if (isCurrentAccountEpoch(epoch)) report(err); }
    finally { if (active.current && isCurrentAccountEpoch(epoch)) setWorking(null); }
  };
  return <BottomSheetScrollView testID="folder-share-panel" contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 32, gap: 12 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 20, fontWeight: '600' }}>{folderName}</Text>
    <Text style={{ color: c.ink, paddingVertical: 12 }}>You (owner)</Text>
    {members.map(member => <View key={member.user_id} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingVertical: 12, gap: 4 }}><Text style={{ color: c.ink }}>{member.email}</Text><Text style={{ color: c.ink3 }}>{folderAccessCopy[member.access_level] ?? folderAccessCopy.view}</Text></View>)}
    {loading && <ActivityIndicator color={c.ink3} />}
    {rows.map(row => <FolderLinkRow key={row.link.id} {...row} busy={working !== null} onPause={() => mutate(row, false)} onRevoke={() => mutate(row, true)} onError={() => setError("Couldn't copy this link. Try again.")} />)}
    {notice && <Text accessibilityRole="text" style={{ color: c.ink2 }}>{notice}</Text>}
    {error && <Text accessibilityRole="alert" style={{ color: c.red }}>{error}</Text>}
    {error && !loading && <TouchableOpacity accessibilityRole="button" onPress={() => { setError(null); void load().catch(report); }}><Text style={{ color: c.ink, paddingVertical: 8 }}>Retry</Text></TouchableOpacity>}
    {rows.length >= 20 && <Text style={{ color: c.ink2 }}>A folder can have at most 20 links.</Text>}
    <CreateFolderLinkForm folderId={folderId} disabled={loading || working !== null || rows.length >= 20} busy={working === 'create'} progress={progress} passphraseFailed={passphraseFailed} onCreate={create} onCancel={() => controller.current?.abort()} />
    <TouchableOpacity testID="folder-link-activity" accessibilityRole="button" onPress={() => navigation.navigate('SharedFolderActivity', { folderId })} style={{ paddingVertical: 16, borderTopWidth: 1, borderTopColor: c.line }}><Text style={{ color: c.ink, fontWeight: '600' }}>Activity</Text></TouchableOpacity>
    <TouchableOpacity accessibilityRole="button" onPress={onClose} style={{ paddingVertical: 12 }}><Text style={{ color: c.ink, textAlign: 'center' }}>Done</Text></TouchableOpacity>
  </BottomSheetScrollView>;
}
