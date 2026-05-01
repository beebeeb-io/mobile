import { VisionCameraProxy } from 'react-native-vision-camera'
import type { Frame } from 'react-native-vision-camera'

export type ConstellationNode = {
  x: number
  y: number
  brightness: number
}

export type ConstellationFrameResult = {
  progress: number
  nodeCount: number
  nodes: ConstellationNode[]
  decoded: boolean
}

// Initialize once at module load time — VisionCameraProxy caches the plugin instance.
const _plugin = VisionCameraProxy.initFrameProcessorPlugin('constellationDecode', {})

// Called on the VisionCamera worklet thread — must be a worklet ('worklet' directive).
export function constellationDecodeFrame(frame: Frame): ConstellationFrameResult | null {
  'worklet'
  if (_plugin == null) return null
  return _plugin.call(frame) as unknown as ConstellationFrameResult
}
