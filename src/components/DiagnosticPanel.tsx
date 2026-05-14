import React, { useEffect, useState, useCallback } from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator, Linking } from 'react-native'
import { useTheme } from '../lib/theme-context'
import { runDiagnostics, type DiagnosticResult, type DiagnosticCheck } from '../lib/diagnostics'
import * as SecureStore from 'expo-secure-store'
import { getApiUrl } from '../lib/api'

const API_URL = getApiUrl()

export const LAST_CONNECTED_KEY = 'beebeeb_last_connected'

const STATUS_ICONS: Record<string, string> = {
  pending: '○',  // ○
  running: '◌',  // ◌
  pass: '✓',     // ✓
  fail: '✗',     // ✗
  skip: '—',     // —
}

interface Props {
  onRetry: () => void
  onSignIn: () => void
}

export function DiagnosticPanel({ onRetry, onSignIn }: Props) {
  const { colors: c } = useTheme()
  const [result, setResult] = useState<DiagnosticResult | null>(null)
  const [lastConnected, setLastConnected] = useState<string | null>(null)

  const checkVault = useCallback(async (): Promise<string> => {
    try {
      const key = await SecureStore.getItemAsync('beebeeb_master_key')
      return key ? 'unlocked' : 'none'
    } catch {
      return 'none'
    }
  }, [])

  const runChecks = useCallback(async () => {
    setResult(null)
    const gen = runDiagnostics(API_URL, checkVault)
    for await (const r of gen) {
      setResult({ ...r })
    }
  }, [checkVault])

  useEffect(() => {
    void runChecks()
    SecureStore.getItemAsync(LAST_CONNECTED_KEY).then(setLastConnected).catch(() => null)
    // Auto-retry every 30s
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/health`, { method: 'GET' })
        if (res.ok) onRetry()
      } catch { /* still down */ }
    }, 30_000)
    return () => clearInterval(interval)
  }, [runChecks, onRetry])

  return (
    <View style={{ paddingHorizontal: 32, alignItems: 'center', width: '100%' }}>
      <Text style={{ color: c.ink, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 4 }}>
        Couldn't reach our servers
      </Text>
      <Text style={{ color: c.ink3, fontSize: 13, textAlign: 'center', marginBottom: 20 }}>
        Running diagnostics...
      </Text>

      <View style={{ width: '100%', maxWidth: 300 }}>
        {result?.checks.map(check => (
          <CheckRow key={check.id} check={check} />
        ))}
      </View>

      {result?.summary && !result.summary.includes('Running') ? (
        <Text style={{ color: c.ink2, fontSize: 13, textAlign: 'center', marginTop: 16, lineHeight: 18 }}>
          {result.summary}
        </Text>
      ) : null}

      {lastConnected ? (
        <Text style={{ color: c.ink4, fontSize: 11, marginTop: 8, fontFamily: 'JetBrainsMono-Regular' }}>
          Last connected: {formatRelative(lastConnected)}
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 12, marginTop: 24 }}>
        <TouchableOpacity
          onPress={onRetry}
          style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: c.amber }}
        >
          <Text style={{ color: '#1a1a2e', fontSize: 14, fontWeight: '600' }}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onSignIn}
          style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: c.line }}
        >
          <Text style={{ color: c.ink2, fontSize: 14 }}>Sign in</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        onPress={() => Linking.openURL('https://status.beebeeb.io')}
        style={{ marginTop: 16 }}
      >
        <Text style={{ color: c.ink3, fontSize: 12, textDecorationLine: 'underline' }}>
          status.beebeeb.io
        </Text>
      </TouchableOpacity>
    </View>
  )
}

function CheckRow({ check }: { check: DiagnosticCheck }) {
  const { colors: c } = useTheme()
  const icon = STATUS_ICONS[check.status]
  const iconColor = check.status === 'pass' ? c.green
    : check.status === 'fail' ? c.red
    : check.status === 'running' ? c.amber
    : c.ink4

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
      {check.status === 'running' ? (
        <ActivityIndicator size="small" color={c.amber} style={{ width: 18 }} />
      ) : (
        <Text style={{ color: iconColor, fontSize: 14, width: 18, fontWeight: '600' }}>{icon}</Text>
      )}
      <Text style={{ color: c.ink2, fontSize: 13, flex: 1, marginLeft: 8 }}>{check.label}</Text>
      {check.durationMs !== undefined ? (
        <Text style={{ color: c.ink4, fontSize: 11, fontFamily: 'JetBrainsMono-Regular' }}>{check.durationMs}ms</Text>
      ) : check.detail ? (
        <Text style={{ color: check.status === 'fail' ? c.red : c.ink4, fontSize: 11, fontFamily: 'JetBrainsMono-Regular' }}>
          {check.detail}
        </Text>
      ) : null}
    </View>
  )
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
