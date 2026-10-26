import React, { useCallback, useState } from 'react';
import { Platform, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { getNativeBackupDiagnostics } from '../../../modules/beebeeb-crypto';
import { useCrypto } from '../../lib/crypto-context';
import { useTheme } from '../../lib/theme-context';
import { formatRuntimeTraceJsonl, getRuntimeTraceSnapshot, recordRuntimeTrace } from '../../lib/runtime-trace';

/** Development tools have one home in Help, away from everyday photo choices. */
export default function SettingsDiagnostics() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors: c } = useTheme();
  const { getUnlockDiagnostics } = useCrypto();
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  const copyDiagnostics = useCallback(async () => {
    recordRuntimeTrace('advanced.diagnostics.copy_request');
    const payload = {
      generatedAt: new Date().toISOString(),
      platform: Platform.OS,
      vault: getUnlockDiagnostics(),
      backup: await getNativeBackupDiagnostics().catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
      runtimeTrace: getRuntimeTraceSnapshot(),
      runtimeTraceJsonl: formatRuntimeTraceJsonl(),
    };
    await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
    setCopiedDiagnostics(true);
    setTimeout(() => setCopiedDiagnostics(false), 1800);
  }, [getUnlockDiagnostics]);

  return (
    <View style={{ marginTop: 16, gap: 12 }}>
      <Text style={{ color: c.ink3 }}>Development tools</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Copy backup diagnostics" onPress={() => void copyDiagnostics()} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: c.ink }}>{copiedDiagnostics ? 'Copied diagnostics' : 'Copy diagnostics'}</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open the glass primitives gallery" onPress={() => navigation.navigate('GlassGallery')} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: c.ink }}>Glass primitives gallery</Text>
      </TouchableOpacity>
    </View>
  );
}
