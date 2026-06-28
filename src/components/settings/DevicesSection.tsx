/**
 * Devices & Backups section for the Settings screen.
 *
 * Fetches the user's registered devices and their sync/backup sessions,
 * displaying each device as a card with session status indicators.
 *
 * 0780 — Status visual language (three unambiguous device states):
 *   Active now  — amber filled presence dot + amber "Active now" / "Syncing N of M…" label
 *   Idle        — no dot; recency in "Last active X ago" text
 *   Stopped     — hollow gray ring; muted text; only inside "Show stopped (N)" group
 *
 * HARD RULE: the platform glyph brightness is CONSTANT for every Active + Idle device.
 * Never vary glyph opacity to imply recency.
 *
 * Session-level status (expanded rows):
 *   Green: heartbeat within 2× interval   Amber: 2–5× interval (stale)
 *   Red:   >5× interval or error          Grey:  no heartbeat / stopped
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Colors, fonts, radii } from '../../theme';
import { formatBytes } from '../../lib/format';
import {
  deleteClientSession,
  listClientDevices,
  listClientSessions,
  friendlyError,
  type ClientDevice,
  type ClientSession,
} from '../../lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}


type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function platformIcon(platform: string): IoniconName {
  const p = platform.toLowerCase();
  if (p === 'ios' || p === 'macos' || p === 'darwin') return 'logo-apple';
  if (p === 'android') return 'logo-android';
  if (p === 'linux') return 'logo-tux';
  if (p === 'windows') return 'logo-windows';
  return 'desktop-outline';
}

function sessionTypeLabel(t: string): string {
  switch (t) {
    case 'backup': return 'Backup';
    case 'sync': return 'Sync';
    case 'mount': return 'Mount';
    default: return t;
  }
}

interface SessionStatusInfo {
  color: string;
  label: string;
}

function sessionStatus(
  session: ClientSession,
  c: Colors,
): SessionStatusInfo {
  if (session.status === 'stopped') {
    return { color: c.ink4, label: 'Stopped' };
  }
  if (session.status === 'error') {
    return { color: c.red, label: 'Error' };
  }
  if (!session.last_heartbeat) {
    return { color: c.ink4, label: 'No heartbeat' };
  }

  const ageSec = (Date.now() - new Date(session.last_heartbeat).getTime()) / 1000;
  const interval = session.heartbeat_interval_secs || 60;

  if (ageSec <= interval * 2) {
    return { color: c.green, label: 'Active' };
  }
  if (ageSec <= interval * 5) {
    return { color: c.amber, label: 'Stale' };
  }
  return { color: c.red, label: 'Offline' };
}

// 0780 — device-level status. The reported bug (IMG_5522) was encoding recency in
// the platform-glyph brightness; instead derive an explicit status from the
// server's session state (fallback: last_seen math) and signal it with a presence
// dot + status text, keeping the glyph a CONSTANT brightness for active+idle.
type DeviceState = 'active' | 'idle' | 'stopped';

const FIVE_MIN_MS = 5 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function deviceState(
  device: ClientDevice,
  deviceSessions: ClientSession[],
): { state: DeviceState; syncing: { synced: number; total: number } | null } {
  const live = deviceSessions.filter((s) => s.status !== 'stopped' && s.status !== 'error');
  const transferring = live.find(
    (s) => s.files_synced != null && s.files_total != null && s.files_synced < s.files_total,
  );
  if (transferring) {
    return {
      state: 'active',
      syncing: { synced: transferring.files_synced as number, total: transferring.files_total as number },
    };
  }
  const recent = live.some(
    (s) => s.last_heartbeat && Date.now() - new Date(s.last_heartbeat).getTime() < FIVE_MIN_MS,
  );
  const lastSeenMs = device.last_seen ? Date.now() - new Date(device.last_seen).getTime() : Infinity;
  if (recent || lastSeenMs < FIVE_MIN_MS) return { state: 'active', syncing: null };
  const allStopped = deviceSessions.length > 0 && live.length === 0;
  if (lastSeenMs > THIRTY_DAYS_MS || allStopped) return { state: 'stopped', syncing: null };
  return { state: 'idle', syncing: null };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

interface Props {
  c: Colors;
}

export default function DevicesSection({ c }: Props) {
  const [devices, setDevices] = useState<ClientDevice[]>([]);
  const [sessions, setSessions] = useState<ClientSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());
  // Stopped sessions are hidden by default — they clutter the list with dead
  // backups. Users opt in to seeing (and forgetting) them via "Show stopped".
  const [showStopped, setShowStopped] = useState(false);
  // Session IDs currently being forgotten — disables their row while in flight.
  const [forgetting, setForgetting] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [devRes, sesRes] = await Promise.all([
        listClientDevices(),
        listClientSessions(),
      ]);
      setDevices(devRes.devices ?? []);
      setSessions(sesRes.sessions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  const forgetSession = useCallback(
    async (session: ClientSession) => {
      setForgetting((prev) => new Set(prev).add(session.id));
      try {
        await deleteClientSession(session.id);
        // Drop it locally so it disappears immediately, then refresh from the
        // server to reconcile device session counts.
        setSessions((prev) => prev.filter((s) => s.id !== session.id));
        await fetchData();
      } catch (err) {
        Alert.alert('Could not forget session', friendlyError(err));
      } finally {
        setForgetting((prev) => {
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
      }
    },
    [fetchData],
  );

  const confirmForgetSession = useCallback(
    (session: ClientSession) => {
      Alert.alert(
        'Forget this session?',
        `"${session.name}" will be removed from your devices. This does not affect any files — only the sync/backup record. The session reappears if the device reconnects.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Forget',
            style: 'destructive',
            onPress: () => void forgetSession(session),
          },
        ],
      );
    },
    [forgetSession],
  );

  useEffect(() => {
    void fetchData();
    pollRef.current = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchData]);

  const toggleDevice = useCallback((deviceId: string) => {
    setExpandedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
      }
      return next;
    });
  }, []);

  // Stopped sessions are hidden by default. Group only the visible ones by
  // device_id, and count the hidden ones so we can offer a "Show stopped" toggle.
  // All sessions grouped per device — used both for status derivation and the
  // expansion list (0780; no longer hides stopped sessions at the session level —
  // dimming now happens only at the device level, inside "Show stopped").
  const sessionsByDevice = useMemo(() => {
    const map = new Map<string, ClientSession[]>();
    for (const s of sessions) {
      const did = s.device_id ?? '';
      const list = map.get(did) ?? [];
      list.push(s);
      map.set(did, list);
    }
    return map;
  }, [sessions]);

  // Partition devices by computed status: active/idle render live; stopped collapse
  // into the explicitly-labeled "Show stopped (N)" group (the one place dimming is
  // allowed). 0780.
  const deviceRows = useMemo(
    () =>
      devices.map((device) => ({
        device,
        ...deviceState(device, sessionsByDevice.get(device.id) ?? []),
      })),
    [devices, sessionsByDevice],
  );
  const liveDevices = useMemo(() => deviceRows.filter((d) => d.state !== 'stopped'), [deviceRows]);
  const stoppedDevices = useMemo(() => deviceRows.filter((d) => d.state === 'stopped'), [deviceRows]);
  const stoppedCount = stoppedDevices.length;

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={c.ink4} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
        <View style={styles.emptyRow}>
          <Ionicons name="alert-circle-outline" size={16} color={c.red} style={{ marginRight: 8 }} />
          <Text style={{ fontSize: 13, color: c.ink3, flex: 1 }}>{error}</Text>
        </View>
      </View>
    );
  }

  if (devices.length === 0) {
    return (
      <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
        <View style={styles.emptyRow}>
          <Ionicons name="desktop-outline" size={16} color={c.ink4} style={{ marginRight: 8 }} />
          <Text style={{ fontSize: 13, color: c.ink3 }}>
            No devices registered yet
          </Text>
        </View>
      </View>
    );
  }

  const renderDevice = (
    entry: { device: ClientDevice; state: DeviceState; syncing: { synced: number; total: number } | null },
    idx: number,
  ) => {
    const { device, state, syncing } = entry;
    const deviceSessions = sessionsByDevice.get(device.id) ?? [];
    const isExpanded = expandedDevices.has(device.id);
    const stopped = state === 'stopped';
    // HARD RULE (0780): the platform glyph brightness is CONSTANT for every active
    // + idle device. Only stopped (inside this labeled group) is dimmed.
    const glyphColor = stopped ? c.ink3 : c.ink;

    return (
      <React.Fragment key={device.id}>
        {idx > 0 && <View style={[styles.rowSep, { backgroundColor: c.line }]} />}

        {/* Device header */}
        <TouchableOpacity
          style={styles.deviceRow}
          activeOpacity={0.6}
          onPress={() => toggleDevice(device.id)}
          accessibilityRole="button"
          accessibilityLabel={`${device.hostname}, ${state === 'active' ? 'active now' : state === 'idle' ? 'idle' : 'stopped'}`}
        >
          {/* Icon tile — constant-brightness glyph + a status presence dot. */}
          <View style={[styles.tile, { backgroundColor: c.paper2 }]}>
            <Ionicons name={platformIcon(device.platform)} size={20} color={glyphColor} />
            {state === 'active' && (
              <View style={[styles.presenceDot, { backgroundColor: c.amber, borderColor: c.paper }]} />
            )}
            {state === 'stopped' && (
              <View style={[styles.presenceRing, { borderColor: c.ink4, backgroundColor: c.paper }]} />
            )}
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{ fontSize: 17, fontWeight: stopped ? '500' : '600', color: stopped ? c.ink3 : c.ink }}
              numberOfLines={1}
            >
              {device.hostname}
            </Text>
            <Text style={{ fontSize: 13, marginTop: 2 }} numberOfLines={1}>
              <Text style={{ fontFamily: fonts.mono, color: c.ink3 }}>
                {device.platform}{device.bb_version ? ` ${device.bb_version}` : ''}
              </Text>
              <Text style={{ color: c.ink3 }}>{'  ·  '}</Text>
              {state === 'active' ? (
                <Text style={{ color: c.amber, fontWeight: '600' }}>
                  {syncing
                    ? `Syncing ${syncing.synced.toLocaleString()} of ${syncing.total.toLocaleString()}…`
                    : 'Active now'}
                </Text>
              ) : state === 'idle' ? (
                <Text>
                  <Text style={{ color: c.ink3 }}>Last active </Text>
                  <Text style={{ color: c.ink2 }}>{device.last_seen ? timeAgo(device.last_seen) : 'unknown'}</Text>
                </Text>
              ) : (
                <Text style={{ color: c.ink3 }}>
                  Stopped{device.last_seen ? ` · ${timeAgo(device.last_seen)}` : ''}
                </Text>
              )}
            </Text>
          </View>

          {deviceSessions.length > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 6 }}>
              <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: c.ink3 }}>
                {deviceSessions.length}
              </Text>
              <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={c.ink3} />
            </View>
          )}
        </TouchableOpacity>

        {/* Sessions under this device */}
        {isExpanded && deviceSessions.length > 0 && (
              <View style={{ paddingBottom: 4 }}>
                {deviceSessions.map((session, sIdx) => {
                  const status = sessionStatus(session, c);
                  // "Forget" is offered for SYNC sessions only — backups and
                  // mounts are managed elsewhere.
                  const canForget = session.session_type === 'sync';
                  const isForgetting = forgetting.has(session.id);
                  return (
                    <View key={session.id}>
                      {sIdx > 0 && (
                        <View
                          style={{
                            height: 1,
                            backgroundColor: c.line,
                            marginLeft: 44,
                          }}
                        />
                      )}
                      <View style={styles.sessionRow}>
                        {/* Status dot */}
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: status.color },
                          ]}
                        />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text
                              style={{
                                fontSize: 13,
                                fontWeight: '400',
                                color: c.ink,
                              }}
                              numberOfLines={1}
                            >
                              {session.name}
                            </Text>
                            <View
                              style={{
                                backgroundColor: c.paper2,
                                borderRadius: 3,
                                paddingHorizontal: 5,
                                paddingVertical: 1,
                              }}
                            >
                              <Text style={{ fontSize: 9, fontWeight: '600', color: c.ink3, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                                {sessionTypeLabel(session.session_type)}
                              </Text>
                            </View>
                          </View>
                          <Text style={{ fontSize: 11, color: c.ink3, marginTop: 2 }}>
                            {status.label}
                            {session.last_heartbeat
                              ? ` · ${timeAgo(session.last_heartbeat)}`
                              : ''}
                            {session.remote_path
                              ? ` · ${session.remote_path}`
                              : ''}
                          </Text>
                          {session.files_synced != null && session.files_total != null && (
                            <Text style={{ fontSize: 10, color: c.ink4, marginTop: 2 }}>
                              {session.files_synced.toLocaleString()} / {session.files_total.toLocaleString()} files
                              {session.bytes_synced != null ? ` · ${formatBytes(session.bytes_synced)}` : ''}
                            </Text>
                          )}
                        </View>
                        {canForget && (
                          isForgetting ? (
                            <ActivityIndicator
                              size="small"
                              color={c.ink4}
                              style={styles.forgetButton}
                            />
                          ) : (
                            <TouchableOpacity
                              style={styles.forgetButton}
                              activeOpacity={0.6}
                              onPress={() => confirmForgetSession(session)}
                              accessibilityRole="button"
                              accessibilityLabel={`Forget session ${session.name}`}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              <Text style={{ fontSize: 12, fontWeight: '500', color: c.red }}>
                                Forget
                              </Text>
                            </TouchableOpacity>
                          )
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </React.Fragment>
        );
  };

  return (
    <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      {liveDevices.map((entry, idx) => renderDevice(entry, idx))}

      {/* Stopped DEVICES collapse into this explicitly-labeled group — the one
          place dimming is allowed (0780). */}
      {stoppedCount > 0 && (
        <>
          <View style={[styles.rowSep, { backgroundColor: c.line }]} />
          <TouchableOpacity
            style={styles.toggleRow}
            activeOpacity={0.6}
            onPress={() => setShowStopped((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={showStopped ? 'Hide stopped devices' : 'Show stopped devices'}
          >
            <Ionicons name="moon-outline" size={16} color={c.ink3} style={{ marginRight: 8 }} />
            <Text style={{ fontSize: 15, color: c.ink2 }}>
              {showStopped ? 'Hide stopped' : `Show stopped (${stoppedCount})`}
            </Text>
            <View style={{ flex: 1 }} />
            <Ionicons name={showStopped ? 'chevron-up' : 'chevron-down'} size={16} color={c.ink3} />
          </TouchableOpacity>
          {showStopped && stoppedDevices.map((entry, idx) => renderDevice(entry, idx))}
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  loadingRow: {
    paddingVertical: 18,
    alignItems: 'center',
  },
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowSep: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presenceDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  presenceRing: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    paddingLeft: 44,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginTop: 5,
    marginRight: 8,
  },
  forgetButton: {
    marginLeft: 8,
    paddingVertical: 2,
    paddingHorizontal: 4,
    alignSelf: 'center',
    minWidth: 44,
    alignItems: 'flex-end',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
});
