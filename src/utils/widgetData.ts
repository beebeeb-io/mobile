import * as FileSystem from 'expo-file-system'

interface WidgetData {
  storageUsed: number
  storageTotal: number
  recentFiles: { name: string; updatedAt: string }[]
}

const APP_GROUP = 'group.io.beebeeb.shared'

export async function writeWidgetData(data: WidgetData): Promise<void> {
  try {
    const groupUrl = FileSystem.cacheDirectory?.replace(
      /\/Library\/Caches\/.*/,
      `/Library/Application Support/${APP_GROUP}/`
    )
    if (!groupUrl) return
    await FileSystem.makeDirectoryAsync(groupUrl, { intermediates: true }).catch(() => {})
    await FileSystem.writeAsStringAsync(
      groupUrl + 'widget-data.json',
      JSON.stringify(data),
      { encoding: FileSystem.EncodingType.UTF8 }
    )
  } catch {
    // Best-effort — widget data is non-critical
  }
}
