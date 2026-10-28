import React, { useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../lib/theme-context';
import type { CreateFolderLinkInput } from '../../lib/folder-link-create';
import type { FolderAccessLevel } from '../../lib/folder-link-types';
import { folderAccessCopy } from './FolderLinkRow';
interface Props {
  folderId: string;
  disabled: boolean;
  busy: boolean;
  progress: { phase: 'preparing' | 'securing'; done: number; total: number } | null;
  passphraseFailed: boolean;
  onCreate(input: CreateFolderLinkInput): Promise<void>;
  onCancel(): void;
}
export function CreateFolderLinkForm({ folderId, disabled, busy, progress, passphraseFailed, onCreate, onCancel }: Props) {
  const { colors: c } = useTheme();
  const [label, setLabel] = useState('');
  const [level, setLevel] = useState<FolderAccessLevel>('add');
  const [hours, setHours] = useState<number | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const submit = (withoutPassphrase = false) => onCreate({ folderId, label: label.trim() || null, accessLevel: level, expiresInHours: hours, capBytes: cap, passphrase: withoutPassphrase ? null : passphrase || null });
  const chip = (text: string, selected: boolean, onPress: () => void, testID?: string) => <TouchableOpacity key={text} testID={testID} disabled={busy} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected, disabled: busy }} style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: selected ? c.ink : c.line, backgroundColor: selected ? c.ink : c.paper2 }}><Text style={{ color: selected ? c.paper : c.ink2, fontSize: 13 }}>{text}</Text></TouchableOpacity>;
  const inputStyle = { color: c.ink, borderColor: c.line, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 14, backgroundColor: c.paper };
  return <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 20, gap: 12 }}>
    <Text style={{ color: c.ink, fontWeight: '600', fontSize: 16 }}>Create a folder link</Text>
    <TextInput testID="folder-link-label" accessibilityLabel="Link label" placeholder="Label (optional)" placeholderTextColor={c.ink3} maxLength={40} value={label} onChangeText={setLabel} editable={!busy} style={inputStyle} />
    <Text style={{ color: c.ink2 }}>Access</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(['view', 'add', 'edit'] as const).map(value => chip(folderAccessCopy[value], level === value, () => setLevel(value), `folder-link-level-${value}`))}</View>
    <Text style={{ color: c.ink2 }}>Expires</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{([[null, 'Never'], [24, '1 day'], [168, '7 days'], [720, '30 days']] as const).map(([value, text]) => chip(text, hours === value, () => setHours(value)))}</View>
    <Text style={{ color: c.ink2 }}>Storage limit</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{([[null, 'No limit'], [1e9, '1 GB'], [5e9, '5 GB'], [25e9, '25 GB']] as const).map(([value, text]) => chip(text, cap === value, () => setCap(value)))}</View>
    <TextInput testID="folder-link-passphrase" accessibilityLabel="Passphrase (optional)" placeholder="Passphrase (optional)" placeholderTextColor={c.ink3} secureTextEntry autoCapitalize="none" autoCorrect={false} value={passphrase} onChangeText={setPassphrase} editable={!busy} style={inputStyle} />
    {progress && <Text accessibilityLiveRegion="polite" style={{ color: c.ink2 }}>{progress.phase === 'securing' ? 'Securing link...' : `Preparing: ${progress.done} of ${progress.total}`}</Text>}
    {passphraseFailed && <View style={{ gap: 10 }}>
      <Text style={{ color: c.ink2 }}>This device couldn't secure the link with a passphrase. Try again, or choose to create a link without a passphrase.</Text>
      <TouchableOpacity testID="folder-link-without-passphrase" disabled={busy || disabled} accessibilityRole="button" onPress={() => submit(true)} style={{ paddingVertical: 12 }}><Text style={{ color: c.ink, fontWeight: '600' }}>Create without a passphrase</Text></TouchableOpacity>
    </View>}
    <TouchableOpacity testID="folder-link-create" accessibilityRole="button" disabled={disabled || busy} onPress={() => submit()} style={{ backgroundColor: c.amber, borderRadius: 12, padding: 14, alignItems: 'center', opacity: disabled || busy ? 0.5 : 1 }}><Text style={{ color: c.black, fontWeight: '700' }}>Create link</Text></TouchableOpacity>
    {busy && <TouchableOpacity testID="folder-link-cancel" accessibilityRole="button" onPress={onCancel} style={{ paddingVertical: 12 }}><Text style={{ color: c.ink, textAlign: 'center' }}>Cancel</Text></TouchableOpacity>}
  </View>;
}
