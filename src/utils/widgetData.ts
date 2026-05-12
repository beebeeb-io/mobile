import { Platform } from 'react-native'
import { File, Paths } from 'expo-file-system/next'

interface WidgetData {
  storageUsed: number
  storageTotal: number
  recentFiles: { name: string; updatedAt: string }[]
}

const APP_GROUP = 'group.io.beebeeb.shared'
const WIDGET_DATA_FILE = 'widget-data.json'
const MAX_RECENT_FILES = 5

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizeWidgetData(data: WidgetData): WidgetData {
  return {
    storageUsed: finiteNonNegative(data.storageUsed),
    storageTotal: finiteNonNegative(data.storageTotal),
    recentFiles: data.recentFiles.slice(0, MAX_RECENT_FILES).map((file) => ({
      name: String(file.name || 'Untitled').slice(0, 160),
      updatedAt: String(file.updatedAt || ''),
    })),
  }
}

export async function writeWidgetData(data: WidgetData): Promise<void> {
  if (Platform.OS !== 'ios') return

  try {
    const groupDirectory = Paths.appleSharedContainers[APP_GROUP]
    if (!groupDirectory?.exists) return

    const file = new File(groupDirectory, WIDGET_DATA_FILE)
    if (!file.exists) {
      file.create()
    }
    file.write(JSON.stringify(normalizeWidgetData(data)))
  } catch {
    // Best-effort: widget data must never block settings or storage loading.
  }
}
