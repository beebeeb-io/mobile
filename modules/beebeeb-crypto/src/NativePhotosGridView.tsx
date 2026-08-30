import { requireNativeViewManager } from 'expo-modules-core'
import * as React from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

export interface NativePhotoGridItem {
  id: string
  displayName?: string | null
  mimeType?: string | null
  monthKey: string
  monthLabel: string
  thumbnailUri?: string | null
  localAssetId?: string | null
  placeholderColor: string
  isVideo: boolean
  isFromBackup: boolean
}

interface NativeEvent<T> {
  nativeEvent: T
}

interface NativePhotosGridProps {
  items: NativePhotoGridItem[]
  selectedIds: string[]
  selectionMode: boolean
  refreshing: boolean
  /** 1298 — month-header ink, resolved by the RN theme (hex). */
  headerTextColor?: string
  headerCountColor?: string
  onPhotoPress?: (event: NativeEvent<{ id: string }>) => void
  onSelectionChange?: (event: NativeEvent<{ selectedIds: string[]; selectionMode: boolean }>) => void
  onVisiblePhotoIdsChange?: (event: NativeEvent<{ ids: string[] }>) => void
  onRefresh?: () => void
  onZoomChange?: (event: NativeEvent<{ columns: number }>) => void
  onPerfEvent?: (event: NativeEvent<Record<string, unknown>>) => void
  style?: StyleProp<ViewStyle>
}

const NativeView = requireNativeViewManager<NativePhotosGridProps>('NativePhotosGridView')

export function NativePhotosGridView(props: NativePhotosGridProps) {
  if (process.env.EXPO_OS === 'android') return null
  return <NativeView {...props} />
}
