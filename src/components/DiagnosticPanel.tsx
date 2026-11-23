import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  ScrollView,
  useWindowDimensions,
} from 'react-native'
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
  /** Set when startup got a 429: busy copy with a countdown, no diagnostics, no Sign in. */
  rateLimited?: { retryAfterSeconds?: number }
}

/** Wait used when the 429 carried no Retry-After. */
export const RATE_LIMITED_DEFAULT_WAIT_SECONDS = 30

export const RATE_LIMITED_TITLE = 'Beebeeb is busy'

export function rateLimitedBody(secondsLeft: number): string {
  return `Too many requests from your network. Trying again in ${Math.max(0, Math.ceil(secondsLeft))} s.`
}

export function DiagnosticPanel({ onRetry, onSignIn, rateLimited }: Props) {
  const isRateLimited = rateLimited !== undefined
  const waitSeconds = rateLimited?.retryAfterSeconds ?? RATE_LIMITED_DEFAULT_WAIT_SECONDS
  const [secondsLeft, setSecondsLeft] = useState(waitSeconds)
  const onRetryRef = useRef(onRetry)
  onRetryRef.current = onRetry
  const { colors: c } = useTheme()
  const { fontScale } = useWindowDimensions()
  const accessibilityLayout = fontScale >= 1.3
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

  // Rate-limited: count down to the server's Retry-After, then retry startup.
  useEffect(() => {
    if (!isRateLimited) return
    const deadline = Date.now() + waitSeconds * 1000
    setSecondsLeft(waitSeconds)
    const tick = setInterval(() => {
      const left = Math.ceil((deadline - Date.now()) / 1000)
      if (left <= 0) {
        clearInterval(tick)
        setSecondsLeft(0)
        onRetryRef.current()
      } else {
        setSecondsLeft(left)
      }
    }, 1000)
    return () => clearInterval(tick)
  }, [isRateLimited, waitSeconds])

  useEffect(() => {
    if (isRateLimited) return
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
  }, [runChecks, onRetry, isRateLimited])

  return (
    <ScrollView
      style={{ width: '100%', flexShrink: 1 }}
      contentContainerStyle={{ paddingHorizontal: 32, alignItems: 'center' }}
      showsVerticalScrollIndicator={accessibilityLayout}
    >
      <Text style={{ color: c.ink, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 4 }}>
        {isRateLimited ? RATE_LIMITED_TITLE : "Couldn't reach our servers"}
      </Text>
      <Text style={{ color: c.ink3, fontSize: 13, textAlign: 'center', marginBottom: 20 }}>
        {isRateLimited ? rateLimitedBody(secondsLeft) : 'Running diagnostics...'}
      </Text>

      <View style={{ width: '100%', maxWidth: 300 }}>
        {!isRateLimited && result?.checks.map(check => (
          <CheckRow key={check.id} check={check} accessibilityLayout={accessibilityLayout} fontScale={fontScale} />
        ))}
      </View>

      {!isRateLimited && result?.summary && !result.summary.includes('Running') ? (
        <Text style={{ color: c.ink2, fontSize: 13, textAlign: 'center', marginTop: 16, lineHeight: 18 }}>
          {result.summary}
        </Text>
      ) : null}

      {lastConnected ? (
        <Text style={{ color: c.ink4, fontSize: 11, marginTop: 8, fontFamily: 'JetBrainsMono-Regular' }}>
          Last connected: {formatRelative(lastConnected)}
        </Text>
      ) : null}

      <View style={{ flexDirection: accessibilityLayout ? 'column' : 'row', gap: 12, marginTop: 24, width: accessibilityLayout ? '100%' : undefined, maxWidth: 300 }}>
        <TouchableOpacity
          onPress={onRetry}
          style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: c.amber, minHeight: accessibilityLayout ? 48 : undefined, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: '#1a1a2e', fontSize: 14, fontWeight: '600' }}>Retry</Text>
        </TouchableOpacity>
        {!isRateLimited ? (
        <TouchableOpacity
          onPress={onSignIn}
          style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: c.line, minHeight: accessibilityLayout ? 48 : undefined, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: c.ink2, fontSize: 14 }}>Sign in</Text>
        </TouchableOpacity>
        ) : null}
      </View>

      <TouchableOpacity
        onPress={() => Linking.openURL('https://status.beebeeb.io')}
        style={{ marginTop: 16 }}
      >
        <Text style={{ color: c.ink3, fontSize: 12, textDecorationLine: 'underline' }}>
          status.beebeeb.io
        </Text>
      </TouchableOpacity>
    </ScrollView>
  )
}

function CheckRow({ check, accessibilityLayout, fontScale }: {
  check: DiagnosticCheck
  accessibilityLayout: boolean
  fontScale: number
}) {
  const { colors: c } = useTheme()
  const icon = STATUS_ICONS[check.status]
  const iconWidth = accessibilityLayout ? Math.ceil(18 * fontScale) : 18
  const iconColor = check.status === 'pass' ? c.green
    : check.status === 'fail' ? c.red
    : check.status === 'running' ? c.amber
    : c.ink4

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: accessibilityLayout ? 'wrap' : 'nowrap', paddingVertical: 4 }}>
      {check.status === 'running' ? (
        <ActivityIndicator size="small" color={c.amber} style={{ width: iconWidth }} />
      ) : (
        <Text style={{ color: iconColor, fontSize: 14, width: iconWidth, fontWeight: '600' }}>{icon}</Text>
      )}
      <Text style={{ color: c.ink2, fontSize: 13, flex: 1, marginLeft: 8 }}>{check.label}</Text>
      {check.durationMs !== undefined ? (
        <Text style={{ color: c.ink4, fontSize: 11, fontFamily: 'JetBrainsMono-Regular', flexBasis: accessibilityLayout ? '100%' : undefined, marginLeft: accessibilityLayout ? iconWidth + 8 : undefined }}>{check.durationMs}ms</Text>
      ) : check.detail ? (
        <Text style={{ color: check.status === 'fail' ? c.red : c.ink4, fontSize: 11, fontFamily: 'JetBrainsMono-Regular', flexBasis: accessibilityLayout ? '100%' : undefined, marginLeft: accessibilityLayout ? iconWidth + 8 : undefined }}>
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
