import React, { useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../../lib/theme-context';
import { formatBytes } from '../../lib/format';
import { formatDateTime } from '../../lib/date-format';
import type { FolderAccessLevel, FolderLink } from '../../lib/folder-link-types';
export const folderAccessCopy: Record<FolderAccessLevel, string> = { view: 'Can view', add: 'Can add', edit: 'Can edit' };
export const revokeLimitNote = 'Stops the link now. Someone who already saved the folder key could still decrypt files they downloaded.';
interface Props {
  link: FolderLink;
  label: string | null;
  url: string | null;
  busy: boolean;
  onPause(): Promise<void>;
  onRevoke(): Promise<void>;
  onError(): void;
}
export function FolderLinkRow({ link, label, url, busy, onPause, onRevoke, onError }: Props) {
  const { colors: c } = useTheme();
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async () => {
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url); setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      // Like the file sheet, clear after 60 seconds. Do not erase a later copy.
      timer.current = setTimeout(async () => {
        try { if (await Clipboard.getStringAsync() === url) await Clipboard.setStringAsync(''); } catch { /* clipboard unavailable */ }
      }, 60_000);
    } catch { onError(); }
  };
  const action = { color: c.ink, fontWeight: '600' as const, fontSize: 13 };
  return <View testID={`folder-link-row-${link.id}`} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingVertical: 16, gap: 8 }}>
    <Text style={{ color: c.ink, fontWeight: '600', fontSize: 15 }}>{label || 'Untitled link'}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: c.ink2, backgroundColor: c.paper2, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>{folderAccessCopy[link.access_level] ?? folderAccessCopy.view}</Text>
      {link.paused && <Text style={{ color: c.ink2 }}>Paused</Text>}
      {link.passphrase_protected && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Ionicons name="lock-closed-outline" size={14} color={c.ink2} /><Text style={{ color: c.ink2 }}>Passphrase protected</Text></View>}
    </View>
    <Text style={{ color: c.ink3 }}>{link.expires_at ? `Expires ${formatDateTime(link.expires_at)}` : 'Never expires'}</Text>
    <Text style={{ color: c.ink3 }}>{link.cap_bytes == null ? 'No limit' : `${formatBytes(link.cap_used_bytes)} of ${formatBytes(link.cap_bytes)} used`}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 20 }}>
      <TouchableOpacity testID={`folder-link-copy-${link.id}`} accessibilityRole="button" accessibilityLabel="Copy link" disabled={!url || busy} onPress={copy} style={{ paddingVertical: 8, opacity: !url || busy ? 0.5 : 1 }}><Text style={action}>{copied ? 'Copied' : 'Copy link'}</Text></TouchableOpacity>
      <TouchableOpacity testID={`folder-link-pause-${link.id}`} accessibilityRole="button" disabled={busy} onPress={onPause} style={{ paddingVertical: 8 }}><Text style={action}>{link.paused ? 'Resume' : 'Pause'}</Text></TouchableOpacity>
      <TouchableOpacity testID={`folder-link-revoke-${link.id}`} accessibilityRole="button" disabled={busy} onPress={() => setConfirm(true)} style={{ paddingVertical: 8 }}><Text style={{ ...action, color: c.red }}>Revoke</Text></TouchableOpacity>
    </View>
    {!url && <Text style={{ color: c.ink3, fontSize: 12 }}>Made on another device. Create a new link to copy it.</Text>}
    {confirm && <View style={{ backgroundColor: c.paper2, padding: 12, borderRadius: 12, gap: 10 }}>
      <Text style={{ color: c.ink, fontWeight: '600' }}>Revoke link?</Text>
      <Text style={{ color: c.ink2, lineHeight: 20 }}>{revokeLimitNote}</Text>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        <TouchableOpacity testID={`folder-link-revoke-confirm-${link.id}`} accessibilityRole="button" disabled={busy} onPress={onRevoke} style={{ paddingVertical: 8 }}><Text style={{ ...action, color: c.red }}>Revoke</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => setConfirm(false)} style={{ paddingVertical: 8 }}><Text style={action}>Cancel</Text></TouchableOpacity>
      </View>
    </View>}
  </View>;
}
