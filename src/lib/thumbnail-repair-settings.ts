import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ThumbnailRepairSettings {
  autoRepairWhileIdle: boolean;
}

export type ThumbnailRepairPhase =
  | 'idle'
  | 'queued'
  | 'scanning'
  | 'repairing'
  | 'paused'
  | 'completed'
  | 'failed';

export interface ThumbnailRepairActivity {
  at: number;
  message: string;
}

export interface ThumbnailRepairStatus {
  requestedAt: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  running: boolean;
  phase: ThumbnailRepairPhase;
  checked: number;
  remaining: number;
  repaired: number;
  skipped: number;
  failed: number;
  totalMissing: number;
  lastRunAt: number | null;
  lastMessage: string | null;
  currentAction: string | null;
  currentFileName: string | null;
  activity: ThumbnailRepairActivity[];
}

const SETTINGS_KEY = 'beebeeb:thumbnail-repair-settings:v1';
const STATUS_KEY = 'beebeeb:thumbnail-repair-status:v1';

export const DEFAULT_THUMBNAIL_REPAIR_SETTINGS: ThumbnailRepairSettings = {
  autoRepairWhileIdle: false,
};

export const DEFAULT_THUMBNAIL_REPAIR_STATUS: ThumbnailRepairStatus = {
  requestedAt: null,
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  running: false,
  phase: 'idle',
  checked: 0,
  remaining: 0,
  repaired: 0,
  skipped: 0,
  failed: 0,
  totalMissing: 0,
  lastRunAt: null,
  lastMessage: null,
  currentAction: null,
  currentFileName: null,
  activity: [],
};

function normalizeSettings(value: Partial<ThumbnailRepairSettings> | null): ThumbnailRepairSettings {
  return {
    autoRepairWhileIdle: value?.autoRepairWhileIdle === true,
  };
}

function normalizeStatus(value: Partial<ThumbnailRepairStatus> | null): ThumbnailRepairStatus {
  const phase = value?.phase;
  const activity = Array.isArray(value?.activity)
    ? value.activity
        .filter((item) => (
          item &&
          typeof item.at === 'number' &&
          typeof item.message === 'string' &&
          item.message.trim().length > 0
        ))
        .slice(0, 8)
    : [];

  return {
    requestedAt: typeof value?.requestedAt === 'number' ? value.requestedAt : null,
    startedAt: typeof value?.startedAt === 'number' ? value.startedAt : null,
    updatedAt: typeof value?.updatedAt === 'number' ? value.updatedAt : null,
    completedAt: typeof value?.completedAt === 'number' ? value.completedAt : null,
    running: value?.running === true,
    phase: phase === 'queued' ||
      phase === 'scanning' ||
      phase === 'repairing' ||
      phase === 'paused' ||
      phase === 'completed' ||
      phase === 'failed'
      ? phase
      : 'idle',
    checked: typeof value?.checked === 'number' ? value.checked : 0,
    remaining: typeof value?.remaining === 'number' ? value.remaining : 0,
    repaired: typeof value?.repaired === 'number' ? value.repaired : 0,
    skipped: typeof value?.skipped === 'number' ? value.skipped : 0,
    failed: typeof value?.failed === 'number' ? value.failed : 0,
    totalMissing: typeof value?.totalMissing === 'number' ? value.totalMissing : 0,
    lastRunAt: typeof value?.lastRunAt === 'number' ? value.lastRunAt : null,
    lastMessage: typeof value?.lastMessage === 'string' ? value.lastMessage : null,
    currentAction: typeof value?.currentAction === 'string' ? value.currentAction : null,
    currentFileName: typeof value?.currentFileName === 'string' ? value.currentFileName : null,
    activity,
  };
}

export async function getThumbnailRepairSettings(): Promise<ThumbnailRepairSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY).catch(() => null);
  if (!raw) return DEFAULT_THUMBNAIL_REPAIR_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<ThumbnailRepairSettings>);
  } catch {
    await AsyncStorage.removeItem(SETTINGS_KEY).catch(() => {});
    return DEFAULT_THUMBNAIL_REPAIR_SETTINGS;
  }
}

export async function setThumbnailRepairSettings(
  next: ThumbnailRepairSettings,
): Promise<ThumbnailRepairSettings> {
  const normalized = normalizeSettings(next);
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function getThumbnailRepairStatus(): Promise<ThumbnailRepairStatus> {
  const raw = await AsyncStorage.getItem(STATUS_KEY).catch(() => null);
  if (!raw) return DEFAULT_THUMBNAIL_REPAIR_STATUS;
  try {
    return normalizeStatus(JSON.parse(raw) as Partial<ThumbnailRepairStatus>);
  } catch {
    await AsyncStorage.removeItem(STATUS_KEY).catch(() => {});
    return DEFAULT_THUMBNAIL_REPAIR_STATUS;
  }
}

export async function setThumbnailRepairStatus(
  next: ThumbnailRepairStatus,
): Promise<ThumbnailRepairStatus> {
  const normalized = normalizeStatus(next);
  await AsyncStorage.setItem(STATUS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function requestThumbnailRepair(): Promise<ThumbnailRepairStatus> {
  const current = await getThumbnailRepairStatus();
  const now = Date.now();
  return setThumbnailRepairStatus({
    ...current,
    requestedAt: now,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    running: true,
    phase: 'queued',
    checked: 0,
    remaining: 0,
    repaired: 0,
    skipped: 0,
    failed: 0,
    totalMissing: 0,
    lastMessage: 'Repair queued. Keep Beebeeb open and unlocked.',
    currentAction: 'Waiting for repair worker',
    currentFileName: null,
    activity: [
      { at: now, message: 'Repair queued' },
      ...current.activity,
    ].slice(0, 8),
  });
}

export async function pauseThumbnailRepair(): Promise<ThumbnailRepairStatus> {
  const current = await getThumbnailRepairStatus();
  const now = Date.now();
  return setThumbnailRepairStatus({
    ...current,
    requestedAt: null,
    updatedAt: now,
    running: false,
    phase: 'paused',
    lastMessage: 'Repair paused',
    currentAction: 'Paused by you',
    currentFileName: null,
    activity: [
      { at: now, message: 'Repair paused' },
      ...current.activity,
    ].slice(0, 8),
  });
}
