import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  runAtTargetFps,
} from 'react-native-vision-camera'
import { useRunOnJS } from 'react-native-worklets-core'

import { colors, radii, spacing } from '../theme'
import type { RootStackParamList } from '../App'
import { constellationDecodeFrame } from '../lib/constellationPlugin'
import type { ConstellationFrameResult } from '../lib/constellationPlugin'

type Nav = NativeStackNavigationProp<RootStackParamList>

// Number of dots in the progress ring
const RING_DOTS = 32

function ProgressRing({ progress }: { progress: number }) {
  const activeDots = Math.round(progress * RING_DOTS)
  const radius = 90
  const dotSize = 5

  return (
    <View style={ringStyles.container}>
      {Array.from({ length: RING_DOTS }, (_, i) => {
        const angle = (i / RING_DOTS) * 2 * Math.PI - Math.PI / 2
        const x = radius * Math.cos(angle)
        const y = radius * Math.sin(angle)
        const active = i < activeDots
        return (
          <View
            key={i}
            style={[
              ringStyles.dot,
              {
                left: radius + 10 + x - dotSize / 2,
                top: radius + 10 + y - dotSize / 2,
                backgroundColor: active ? colors.amber : 'rgba(255,255,255,0.18)',
              },
            ]}
          />
        )
      })}
    </View>
  )
}

const ringStyles = StyleSheet.create({
  container: {
    width: 200,
    height: 200,
    position: 'absolute',
  },
  dot: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: 3,
  },
})

export default function ConstellationScannerScreen() {
  const navigation = useNavigation<Nav>()
  const insets = useSafeAreaInsets()
  const { hasPermission, requestPermission } = useCameraPermission()
  const device = useCameraDevice('back')

  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState<'requesting' | 'denied' | 'scanning' | 'done'>('requesting')
  const decodedRef = useRef(false)

  // Pulse animation for the scanning frame
  const pulseAnim = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.04, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulseAnim])

  useEffect(() => {
    if (!hasPermission) {
      requestPermission().then((granted) => {
        setStatus(granted ? 'scanning' : 'denied')
      })
    } else {
      setStatus('scanning')
    }
  }, [hasPermission, requestPermission])

  const onDecodeResult = useRunOnJS(
    (result: ConstellationFrameResult) => {
      if (decodedRef.current) return
      setProgress(result.progress)
      if (result.decoded) {
        decodedRef.current = true
        setStatus('done')
        navigation.navigate('PairingConfirm', {
          progress: result.progress,
          nodeCount: result.nodeCount,
        })
      }
    },
    [navigation],
  )

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet'
      runAtTargetFps(5, () => {
        'worklet'
        const result = constellationDecodeFrame(frame)
        if (result != null) {
          onDecodeResult(result)
        }
      })
    },
    [onDecodeResult],
  )

  const handleBack = useCallback(() => {
    navigation.goBack()
  }, [navigation])

  // --- Permission denied ---
  if (status === 'denied') {
    return (
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.backRow} onPress={handleBack} activeOpacity={0.7}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View style={styles.center}>
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Camera access required</Text>
            <Text style={styles.errorSub}>
              Open Settings and allow Beebeeb to use the camera to scan the pairing pattern.
            </Text>
          </View>
        </View>
      </View>
    )
  }

  // --- No device (simulator) ---
  if (status === 'scanning' && !device) {
    return (
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.backRow} onPress={handleBack} activeOpacity={0.7}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View style={styles.center}>
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>No camera available</Text>
            <Text style={styles.errorSub}>Run on a physical device to use the constellation scanner.</Text>
          </View>
        </View>
      </View>
    )
  }

  // --- Camera scanner ---
  return (
    <View style={styles.root}>
      {/* Live camera preview */}
      {device != null && (
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={status === 'scanning'}
          frameProcessor={frameProcessor}
          pixelFormat="yuv"
        />
      )}

      {/* Dark overlay with cutout */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={[styles.topMask, { height: insets.top + 56 + 48 }]} />
        <View style={styles.middleRow}>
          <View style={styles.sideMask} />
          <View style={styles.cutout} />
          <View style={styles.sideMask} />
        </View>
        <View style={styles.bottomMask} />
      </View>

      {/* Progress ring + center indicator */}
      <View style={styles.ringWrapper} pointerEvents="none">
        <ProgressRing progress={progress} />
        <Animated.View style={[styles.scanFrame, { transform: [{ scale: pulseAnim }] }]}>
          <View style={styles.scanCornerTL} />
          <View style={styles.scanCornerTR} />
          <View style={styles.scanCornerBL} />
          <View style={styles.scanCornerBR} />
        </Animated.View>
      </View>

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton} activeOpacity={0.7}>
          <Text style={styles.backText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Scan pairing pattern</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        {progress > 0 && (
          <View style={styles.progressBadge}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` as `${number}%` }]} />
            <Text style={styles.progressText}>{Math.round(progress * 100)}% decoded</Text>
          </View>
        )}
        <Text style={styles.hint}>
          {status === 'done'
            ? 'Pattern decoded — confirming…'
            : 'Hold steady and point at the amber constellation on the other device.'}
        </Text>
      </View>
    </View>
  )
}

const CUTOUT = 220

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.darkBg,
  },

  // Overlay masks
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  topMask: {
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  middleRow: {
    flexDirection: 'row',
    height: CUTOUT,
  },
  sideMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  cutout: {
    width: CUTOUT,
    borderRadius: radii.lg,
  },
  bottomMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },

  // Ring + frame wrapper — centered over cutout
  ringWrapper: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: CUTOUT,
    height: CUTOUT,
    position: 'absolute',
  },
  // Corner accent lines (amber)
  scanCornerTL: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 28,
    height: 28,
    borderTopWidth: 2.5,
    borderLeftWidth: 2.5,
    borderColor: colors.amber,
    borderTopLeftRadius: radii.lg,
  },
  scanCornerTR: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 28,
    height: 28,
    borderTopWidth: 2.5,
    borderRightWidth: 2.5,
    borderColor: colors.amber,
    borderTopRightRadius: radii.lg,
  },
  scanCornerBL: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 28,
    height: 28,
    borderBottomWidth: 2.5,
    borderLeftWidth: 2.5,
    borderColor: colors.amber,
    borderBottomLeftRadius: radii.lg,
  },
  scanCornerBR: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderBottomWidth: 2.5,
    borderRightWidth: 2.5,
    borderColor: colors.amber,
    borderBottomRightRadius: radii.lg,
  },

  // Header
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    minWidth: 60,
  },
  backText: {
    fontSize: 14,
    color: colors.paper,
    opacity: 0.85,
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.paper,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  headerSpacer: {
    minWidth: 60,
  },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: 12,
  },
  hint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
    textAlign: 'center',
    lineHeight: 18,
  },

  // Progress bar
  progressBadge: {
    height: 24,
    borderRadius: radii.round,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minWidth: 130,
  },
  progressFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: colors.amber,
    opacity: 0.3,
    borderRadius: radii.round,
  },
  progressText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.amber,
    textAlign: 'center',
    letterSpacing: 0.5,
  },

  // Error states
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  errorBox: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    padding: spacing.xl,
    alignItems: 'center',
  },
  errorTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.paper,
    marginBottom: 8,
  },
  errorSub: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    lineHeight: 18,
  },

  backRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
})
