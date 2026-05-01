import { requireNativeViewManager } from 'expo-modules-core'
import * as React from 'react'
import type { ViewStyle } from 'react-native'

// ─── Types matching Rust ConstellationFrame ──────────────────────────────────

export interface ConstellationNode {
  /** 0 = outer ring node, 1 = core node */
  kind: number
  x: number
  y: number
  z: number
  /** 0–1. Encodes payload bits. Drives sphere size and glow intensity. */
  brightness: number
  /** Radians. Drives the pulse animation phase. */
  pulsePhase: number
}

export interface ConstellationEdge {
  fromIdx: number
  toIdx: number
  /** 0–1. Encodes payload bits. Drives edge opacity. */
  weight: number
  /** Speed at which the flow animation runs along this edge. */
  flowSpeed: number
}

export interface ConstellationFrame {
  frameIndex: number
  /** u64 seed — cosmetic, not data-carrying. May lose precision for very large values. */
  seed: number
  /** 0–1 ring rotation phase. */
  ringPhase: number
  nodes: ConstellationNode[]
  edges: ConstellationEdge[]
}

// ─── Native view ─────────────────────────────────────────────────────────────

const NativeConstellationView = requireNativeViewManager('ConstellationView')

interface Props {
  /** Current frame from the Rust encoder. Pass a new object each animation tick. */
  frame?: ConstellationFrame
  style?: ViewStyle
}

/**
 * Renders the Amber Constellation — Beebeeb's visual device-pairing pattern.
 *
 * Mount this view and push a new `frame` prop every ~16 ms (from
 * `constellation_encode(payload, frameIndex)` via the Rust UniFFI binding).
 * The native SceneKit renderer updates node positions, brightness, and edge
 * weights in-place without reallocating GPU geometry.
 *
 * iOS only. Falls back to null on Android (camera scanner is used instead).
 */
export function ConstellationView({ frame, style }: Props) {
  if (process.env.EXPO_OS === 'android') return null

  return <NativeConstellationView frame={frame} style={style} />
}
