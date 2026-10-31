import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  PixelRatio,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { encodePhotoPreviewSample, originalPhotoForCompare } from '../../modules/beebeeb-crypto';
import { SyncedZoomImage } from '../components/preview-compare/SyncedZoomImage';
import {
  baseSize,
  fitViewport,
  oneToOneScale,
  panBy,
  viewportForResize,
  zoomAt,
  zoomLabel,
  zoomToScaleAtCentre,
  type Box,
  type Viewport,
} from '../lib/compare-viewport';
import { createEncodeQueue, type EncodeQueue } from '../lib/compare-encode-queue';
import { formatBytes } from '../lib/format';
import {
  DEFAULT_PHOTO_PREVIEW_SETTING,
  PREVIEW_SIZE_OPTIONS,
  loadPhotoPreviewSetting,
  type PreviewFormat,
  type PreviewPx,
} from '../lib/photo-preview-settings';

type Mode = 'stacked' | 'wipe' | 'hold';
type Sample = { uri: string; bytes: number; width: number; height: number };
type Original = { uri: string; width: number; height: number; bytes?: number };

const MODES: { id: Mode; label: string }[] = [
  { id: 'stacked', label: 'Stacked' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'hold', label: 'Hold to flip' },
];
const FORMATS: { label: string; value: PreviewFormat }[] = [
  { label: 'HEIC', value: 'heic' },
  { label: 'JPEG', value: 'jpeg' },
];
const ORIGINAL_MAX_PX = 3840;
const STACK_GAP = 4;
const HANDLE_W = 44;
const AMBER = '#F5B800';

const fileUri = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);
const sampleKey = (id: string, format: PreviewFormat, px: number) => `${id}|${format}:${px}`;
const SAMPLES_DIR_MARK = '/beebeeb-previews-v1/samples/';

/** Remove compare copies; only ever touches the plaintext samples folder in Caches. */
function deleteCompareFiles(uris: string[]): void {
  for (const uri of uris) {
    if (!uri.includes(SAMPLES_DIR_MARK)) continue;
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}
const sizeLabel = (px: PreviewPx) => PREVIEW_SIZE_OPTIONS.find((o) => o.px === px)?.label ?? String(px);

export default function PhotoPreviewCompareScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'PhotoPreviewCompare'>>();
  const insets = useSafeAreaInsets();

  const [localId, setLocalId] = useState<string | undefined>(route.params?.localIdentifier);
  const [mode, setMode] = useState<Mode>('stacked');
  const [format, setFormat] = useState<PreviewFormat>(DEFAULT_PHOTO_PREVIEW_SETTING.format);
  const [px, setPx] = useState<PreviewPx>(DEFAULT_PHOTO_PREVIEW_SETTING.px);
  const [original, setOriginal] = useState<Original | null>(null);
  const [samples, setSamples] = useState<Record<string, Sample | 'failed'>>({});
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<Box>({ w: 0, h: 0 });
  const [view, setView] = useState<Viewport>({ scale: 1, x: 0, y: 0 });
  const [wipe, setWipe] = useState(0.5);
  const [holding, setHolding] = useState(false);

  const touchedSetting = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Start from the user's saved choice, unless they already tapped a chip.
  useEffect(() => {
    let alive = true;
    loadPhotoPreviewSetting()
      .then((s) => {
        if (!alive || touchedSetting.current) return;
        setFormat(s.format);
        setPx(s.px);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const aspect = original && original.height > 0 ? original.width / original.height : 1;
  const paneBox: Box = useMemo(
    () =>
      mode === 'stacked'
        ? { w: area.w, h: Math.max((area.h - STACK_GAP) / 2, 0) }
        : { w: area.w, h: area.h },
    [mode, area],
  );
  const base = useMemo(() => baseSize(paneBox, aspect), [paneBox, aspect]);
  const baseRef = useRef(base);
  baseRef.current = base;
  const boxRef = useRef(paneBox);
  boxRef.current = paneBox;

  // New photo or first layout: start at fit.
  const sizeKey = `${Math.round(paneBox.w)}x${Math.round(paneBox.h)}:${original?.uri ?? ''}`;
  const lastFit = useRef('');
  useEffect(() => {
    if (!original || paneBox.w <= 0 || paneBox.h <= 0) return;
    const id = `${original.uri}`;
    if (lastFit.current === id) return;
    lastFit.current = id;
    setView(fitViewport(paneBox, baseSize(paneBox, aspect)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeKey]);

  // Files made for the photo on screen; removed when the photo changes or the screen closes.
  const filesRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  const localIdRef = useRef<string | undefined>(localId);
  localIdRef.current = localId;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueRef.current?.clear();
      deleteCompareFiles(filesRef.current);
      filesRef.current = [];
    };
  }, []);

  // One serial queue for the screen's lifetime; results are stored by photo|format|size,
  // independent of which chip is selected when they land.
  const queueRef = useRef<EncodeQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = createEncodeQueue<Sample>(
      async (key) => {
        const [id, rest] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
        const [f, p] = rest.split(':');
        const r = await encodePhotoPreviewSample(id, f as PreviewFormat, Number(p));
        return { uri: fileUri(r.path), bytes: r.bytes, width: r.width, height: r.height };
      },
      (key, outcome) => {
        const id = key.slice(0, key.lastIndexOf('|'));
        if (outcome.ok && (!mountedRef.current || id !== localIdRef.current)) {
          deleteCompareFiles([outcome.value.uri]); // landed after the photo changed or the screen closed
          return;
        }
        if (!mountedRef.current) return;
        if (outcome.ok) filesRef.current.push(outcome.value.uri);
        setSamples((prev) => ({ ...prev, [key]: outcome.ok ? outcome.value : 'failed' }));
      },
    );
  }

  // Original side: downsampled decode of the PhotoKit original.
  useEffect(() => {
    if (!localId) return;
    let alive = true;
    setOriginal(null);
    setError(null);
    lastFit.current = '';
    originalPhotoForCompare(localId, ORIGINAL_MAX_PX)
      .then((o) => {
        const uri = fileUri(o.path);
        if (!alive || !mountedRef.current) {
          deleteCompareFiles([uri]);
          return;
        }
        filesRef.current.push(uri);
        setOriginal({ uri, width: o.width, height: o.height, bytes: o.originalBytes });
      })
      .catch(() => {
        if (alive) setError('Could not open this photo.');
      });
    return () => {
      alive = false;
      // New photo (or unmount): drop this photo's compare copies and any waiting encodes.
      queueRef.current?.clear();
      queueRef.current?.forgetDone();
      deleteCompareFiles(filesRef.current);
      filesRef.current = [];
      setSamples({});
    };
  }, [localId]);

  // The selected option jumps the line; the rest of the chip row follows.
  useEffect(() => {
    const q = queueRef.current;
    if (!localId || !q) return;
    q.prioritize(sampleKey(localId, format, px));
    for (const o of PREVIEW_SIZE_OPTIONS) q.enqueue(sampleKey(localId, format, o.px));
    for (const o of FORMATS) q.enqueue(sampleKey(localId, o.value, px));
  }, [localId, format, px]);

  const current = localId ? samples[sampleKey(localId, format, px)] : undefined;
  const currentSample = current && current !== 'failed' ? current : null;

  // ── Mode switch: keep the viewed spot ───────────────────────────────────────
  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      const nextBox: Box =
        next === 'stacked'
          ? { w: area.w, h: Math.max((area.h - STACK_GAP) / 2, 0) }
          : { w: area.w, h: area.h };
      setView(viewportForResize(viewRef.current, boxRef.current, nextBox, aspect));
      setHolding(false);
      setMode(next);
    },
    [mode, area, aspect],
  );

  const areaRef = useRef(area);
  areaRef.current = area;
  const onAreaLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      const prev = areaRef.current;
      if (Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1) return;
      if (prev.w > 0 && original) {
        const nextBox: Box =
          mode === 'stacked' ? { w: width, h: Math.max((height - STACK_GAP) / 2, 0) } : { w: width, h: height };
        setView(viewportForResize(viewRef.current, boxRef.current, nextBox, aspect));
      }
      areaRef.current = { w: width, h: height };
      setArea({ w: width, h: height });
    },
    [original, mode, aspect],
  );

  // ── Gestures: one factory so each pane gets its own instances ───────────────
  const makeGesture = useCallback(() => {
    let lastScale = 1;
    let lastTx = 0;
    let lastTy = 0;
    const clampView = (v: Viewport) => panBy(v, 0, 0, boxRef.current, baseRef.current);
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        lastScale = 1;
      })
      .onUpdate((e) => {
        const factor = e.scale / lastScale;
        lastScale = e.scale;
        setView(clampView(zoomAt(viewRef.current, e.focalX, e.focalY, factor)));
      });
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(4)
      .onStart(() => {
        lastTx = 0;
        lastTy = 0;
      })
      .onUpdate((e) => {
        const dx = e.translationX - lastTx;
        const dy = e.translationY - lastTy;
        lastTx = e.translationX;
        lastTy = e.translationY;
        setView(panBy(viewRef.current, dx, dy, boxRef.current, baseRef.current));
      });
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((e, success) => {
        if (!success) return;
        const v = viewRef.current;
        const b = baseRef.current;
        if (v.scale > 1.01) {
          setView(fitViewport(boxRef.current, b));
        } else {
          const target = oneToOneScale(originalWidthRef.current, b.w, PixelRatio.get());
          const focus = zoomAt(v, e.x, e.y, Math.max(target, 2) / v.scale, 1, Math.max(target, 2));
          setView(panBy(focus, 0, 0, boxRef.current, b));
        }
      });
    const press = Gesture.LongPress()
      .runOnJS(true)
      .minDuration(160)
      .maxDistance(10000)
      .onStart(() => {
        if (modeRef.current === 'hold') setHolding(true);
      })
      .onFinalize(() => {
        setHolding(false);
      });
    return Gesture.Simultaneous(pinch, pan, doubleTap, press);
  }, []);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const originalWidthRef = useRef(1);
  originalWidthRef.current = original?.width ?? 1;
  const gestureA = useMemo(makeGesture, [makeGesture]);
  const gestureB = useMemo(makeGesture, [makeGesture]);

  const wipeStart = useRef(0.5);
  const wipeGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onStart(() => {
          wipeStart.current = wipeRef.current;
        })
        .onUpdate((e) => {
          const w = boxRef.current.w;
          if (w > 0) setWipe(Math.min(Math.max(wipeStart.current + e.translationX / w, 0), 1));
        }),
    [],
  );
  const wipeRef = useRef(wipe);
  wipeRef.current = wipe;

  const fit = useCallback(() => setView(fitViewport(boxRef.current, baseRef.current)), []);
  const oneToOne = useCallback(() => {
    const b = baseRef.current;
    const target = oneToOneScale(originalWidthRef.current, b.w, PixelRatio.get());
    setView((v) => panBy(zoomToScaleAtCentre(v, boxRef.current, target), 0, 0, boxRef.current, b));
  }, []);

  const choosePhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Permission required', 'Allow photo library access to pick a photo.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (res.canceled || res.assets.length === 0) return;
      const id = res.assets[0].assetId;
      if (!id) {
        Alert.alert('Cannot compare this photo', 'Pick a photo from your library.');
        return;
      }
      setLocalId(id);
    } catch {
      Alert.alert('Could not open the photo picker', 'Try again.');
    }
  }, []);

  // ── Rendering ───────────────────────────────────────────────────────────────
  const originalUri = original?.uri ?? null;
  const settingUri = currentSample?.uri ?? null;
  const settingLabel = currentSample
    ? `${sizeLabel(px)} ${format.toUpperCase()} · ${formatBytes(currentSample.bytes)}`
    : current === 'failed'
      ? `${sizeLabel(px)} ${format.toUpperCase()} · unavailable`
      : `${sizeLabel(px)} ${format.toUpperCase()} · …`;
  const originalLabel = original?.bytes ? `Original · ${formatBytes(original.bytes)}` : 'Original';
  // Relative to the original's pixels (1:1 = one original pixel per device pixel), the same in every mode.
  const zoomText = zoomLabel(view.scale, base.w, original?.width ?? 0, PixelRatio.get());

  const chipSize = (p: PreviewPx) => {
    const s = localId ? samples[sampleKey(localId, format, p)] : undefined;
    return s && s !== 'failed' ? formatBytes(s.bytes) : s === 'failed' ? '—' : '…';
  };
  const chipFormat = (f: PreviewFormat) => {
    const s = localId ? samples[sampleKey(localId, f, px)] : undefined;
    return s && s !== 'failed' ? formatBytes(s.bytes) : s === 'failed' ? '—' : '…';
  };

  const originalPixels: Box = { w: original?.width ?? 0, h: original?.height ?? 0 };
  const settingPixels: Box = { w: currentSample?.width ?? 0, h: currentSample?.height ?? 0 };

  const pane = (uri: string | null, pixels: Box, gesture: ReturnType<typeof makeGesture>, label: string, extra?: React.ReactNode) => (
    <GestureDetector gesture={gesture}>
      <View style={{ width: paneBox.w, height: paneBox.h, overflow: 'hidden', backgroundColor: '#000' }}>
        <SyncedZoomImage uri={uri} pixels={pixels} box={paneBox} base={base} viewport={view} />
        {extra}
        <View style={styles.labelWrap} pointerEvents="none">
          <Text style={styles.label}>{label}</Text>
        </View>
      </View>
    </GestureDetector>
  );

  let content: React.ReactNode = null;
  if (!localId) {
    content = (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Pick a photo to compare its original with a preview.</Text>
      </View>
    );
  } else if (error) {
    content = (
      <View style={styles.center}>
        <Text style={styles.emptyText}>{error}</Text>
      </View>
    );
  } else if (!original || area.w <= 0) {
    content = (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  } else if (mode === 'stacked') {
    content = (
      <View style={{ gap: STACK_GAP }}>
        {pane(originalUri, originalPixels, gestureA, originalLabel)}
        {pane(settingUri, settingPixels, gestureB, settingLabel)}
      </View>
    );
  } else if (mode === 'wipe') {
    const divX = paneBox.w * wipe;
    content = (
      <View style={{ width: paneBox.w, height: paneBox.h }}>
        <GestureDetector gesture={gestureA}>
          <View style={{ width: paneBox.w, height: paneBox.h, overflow: 'hidden', backgroundColor: '#000' }}>
            <SyncedZoomImage uri={originalUri} pixels={originalPixels} box={paneBox} base={base} viewport={view} />
            <SyncedZoomImage uri={settingUri} pixels={settingPixels} box={paneBox} base={base} viewport={view} clipLeft={divX} />
            <View style={[styles.labelWrap, { left: 10 }]} pointerEvents="none">
              <Text style={styles.label}>{originalLabel}</Text>
            </View>
            <View style={[styles.labelWrap, { right: 10, left: undefined }]} pointerEvents="none">
              <Text style={styles.label}>{settingLabel}</Text>
            </View>
          </View>
        </GestureDetector>
        <View pointerEvents="none" style={[styles.divider, { left: divX - 1 }]} />
        <GestureDetector gesture={wipeGesture}>
          <View style={[styles.handleHit, { left: divX - HANDLE_W / 2 }]}>
            <View style={styles.knob}>
              <Ionicons name="swap-horizontal" size={18} color="#111" />
            </View>
          </View>
        </GestureDetector>
      </View>
    );
  } else {
    content = pane(
      holding ? originalUri : settingUri,
      holding ? originalPixels : settingPixels,
      gestureA,
      holding ? originalLabel : `${settingLabel} · hold for original`,
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          <Ionicons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.seg}>
          {MODES.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={[styles.segItem, mode === m.id && styles.segItemOn]}
              onPress={() => switchMode(m.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m.id }}
              accessibilityLabel={m.label}
            >
              <Text style={[styles.segText, mode === m.id && styles.segTextOn]}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.zoomRow}>
        <Text style={styles.zoomText}>{zoomText}</Text>
        <TouchableOpacity onPress={fit} style={styles.zoomBtn} accessibilityRole="button" accessibilityLabel="Fit">
          <Text style={styles.zoomBtnText}>Fit</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={oneToOne} style={styles.zoomBtn} accessibilityRole="button" accessibilityLabel="1 to 1">
          <Text style={styles.zoomBtnText}>1:1</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.area} onLayout={onAreaLayout}>
        {content}
      </View>

      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {PREVIEW_SIZE_OPTIONS.map((o) => (
            <Chip
              key={o.px}
              label={o.label}
              sub={chipSize(o.px)}
              on={o.px === px}
              onPress={() => {
                touchedSetting.current = true;
                setPx(o.px);
              }}
            />
          ))}
          <View style={styles.chipSep} />
          {FORMATS.map((f) => (
            <Chip
              key={f.value}
              label={f.label}
              sub={chipFormat(f.value)}
              on={f.value === format}
              onPress={() => {
                touchedSetting.current = true;
                setFormat(f.value);
              }}
            />
          ))}
        </ScrollView>
        <TouchableOpacity onPress={choosePhoto} style={styles.choose} accessibilityRole="button" accessibilityLabel="Choose photo">
          <Ionicons name="images-outline" size={18} color="#fff" />
          <Text style={styles.chooseText}>Choose photo</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Chip({ label, sub, on, onPress }: { label: string; sub: string; on: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${label}, ${sub}`}
    >
      <Text style={[styles.chipLabel, on && styles.chipLabelOn]}>{label}</Text>
      <Text style={[styles.chipSub, on && styles.chipLabelOn]}>{sub}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b0c' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, gap: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  seg: { flex: 1, flexDirection: 'row', backgroundColor: '#1c1c1e', borderRadius: 10, padding: 3 },
  segItem: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  segItemOn: { backgroundColor: '#3a3a3c' },
  segText: { color: '#a1a1a6', fontSize: 13, fontWeight: '500' },
  segTextOn: { color: '#fff' },
  zoomRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 6, gap: 10 },
  zoomText: { color: '#a1a1a6', fontSize: 12, flex: 1 },
  zoomBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, backgroundColor: '#1c1c1e' },
  zoomBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  area: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: '#a1a1a6', fontSize: 14, textAlign: 'center' },
  labelWrap: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  label: { color: '#fff', fontSize: 11, fontWeight: '600' },
  divider: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#fff' },
  handleHit: { position: 'absolute', top: 0, bottom: 0, width: HANDLE_W, alignItems: 'center', justifyContent: 'center' },
  knob: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  bottom: { paddingTop: 10, paddingHorizontal: 12, gap: 10 },
  chips: { gap: 6, alignItems: 'center', paddingHorizontal: 2 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#1c1c1e', alignItems: 'center', minWidth: 62 },
  chipOn: { backgroundColor: AMBER },
  chipLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  chipLabelOn: { color: '#111' },
  chipSub: { color: '#a1a1a6', fontSize: 10, marginTop: 1 },
  chipSep: { width: 1, height: 28, backgroundColor: '#3a3a3c', marginHorizontal: 4 },
  choose: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#555',
  },
  chooseText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
