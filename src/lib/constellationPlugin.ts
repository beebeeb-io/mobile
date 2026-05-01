// Placeholder — react-native-vision-camera frame processor plugin
// Will be wired when vision-camera is re-added with a compatible build

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

export function constellationDecodeFrame(_frame: unknown): ConstellationFrameResult | null {
  return null
}
