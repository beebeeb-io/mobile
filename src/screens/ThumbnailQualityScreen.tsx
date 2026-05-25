import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import {
  fromSliderT,
  toSliderT,
  toPreset,
  getThumbnailQuality,
  setThumbnailQuality,
  DEFAULT_QUALITY,
} from '../lib/thumbnail-quality';
import { BeebeebThumbnails } from '../../modules/beebeeb-crypto';
import { getFileIndex } from '../lib/api';
import { loadCachedFileIndex, saveCachedFileIndex } from '../lib/file-index-cache';
import { getRemoteToLocalMap } from '../services/BackupDatabase';
import { useTheme } from '../lib/theme-context';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Baseline for delta estimation — matches the default medium thumbnail size. */
const BASELINE_BYTES = 48 * 1024;

function formatBytes(bytes: number): string {
  if (Math.abs(bytes) < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (Math.abs(bytes) < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `~${mins}m`;
  const hours = Math.round(mins / 60);
  return `~${hours}h`;
}

/** Estimate bytes per thumbnail for a given quality setting. */
function estimateBytesPerThumb(q: { width: number; quality: number }): number {
  // Very rough model: default (768px, q0.82) ≈ 48 KB.
  // Scale by (width/768)^1.5 * (quality/0.82).
  const widthFactor = (q.width / 768) ** 1.5;
  const qualFactor = q.quality / 0.82;
  return BASELINE_BYTES * widthFactor * qualFactor;
}

export default function ThumbnailQualityScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();

  // Slider state
  const [sliderValue, setSliderValue] = useState(toSliderT(DEFAULT_QUALITY));
  const [savedSliderValue, setSavedSliderValue] = useState(toSliderT(DEFAULT_QUALITY));

  // Live preview
  const [previewSrcUri, setPreviewSrcUri] = useState<string | null>(null);
  const [originalFileSize, setOriginalFileSize] = useState<number | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewFileSize, setPreviewFileSize] = useState<number | null>(null);
  const [generatingPreview, setGeneratingPreview] = useState(false);

  // Scope state
  const [eligibleCount, setEligibleCount] = useState<number | null>(null);
  const [eligibleIds, setEligibleIds] = useState<string[]>([]);
  const [loadingScope, setLoadingScope] = useState(false);

  // Apply state
  const [applying, setApplying] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial quality + first photo + scope on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const q = await getThumbnailQuality();
        if (cancelled) return;
        const t = toSliderT(q);
        setSliderValue(t);
        setSavedSliderValue(t);
      } catch {
        // Fall through to defaults.
      }
    })();

    void (async () => {
      try {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (cancelled || status !== 'granted') return;
        const result = await MediaLibrary.getAssetsAsync({
          first: 1,
          mediaType: MediaLibrary.MediaType.photo,
          sortBy: MediaLibrary.SortBy.creationTime,
        });
        const asset = result.assets[0];
        if (!asset || cancelled) return;

        const info = await MediaLibrary.getAssetInfoAsync(asset);
        const uri = info.localUri ?? info.uri;
        setPreviewSrcUri(uri);

        // Measure original preview file
        const fsInfo = await FileSystem.getInfoAsync(uri);
        if (!cancelled && fsInfo.exists) {
          setOriginalFileSize(fsInfo.size ?? null);
        }
      } catch {
        // No photo access or no photos.
      }
    })();

    void loadScope();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadScope = useCallback(async () => {
    setLoadingScope(true);
    try {
      const cached = await loadCachedFileIndex();
      const index = await getFileIndex(cached?.hash);
      const files = !index.changed && cached
        ? cached.files
        : index.files ?? cached?.files ?? [];
      if (index.changed && index.files) await saveCachedFileIndex(index.hash, index.files);

      const localMap = await getRemoteToLocalMap();
      const eligible = files.filter((f) => (
        !f.is_folder && !f.is_uploading && localMap.has(f.id)
      ));
      setEligibleIds(eligible.map((f) => f.id));
      setEligibleCount(eligible.length);
    } catch {
      setEligibleCount(0);
    } finally {
      setLoadingScope(false);
    }
  }, []);

  // Regenerate preview whenever the slider settles
  const regeneratePreview = useCallback(async (t: number) => {
    if (!previewSrcUri) return;
    const q = fromSliderT(t);
    setGeneratingPreview(true);
    try {
      const result = await ImageManipulator.manipulateAsync(
        previewSrcUri,
        [{ resize: { width: q.width } }],
        { compress: q.quality, format: ImageManipulator.SaveFormat.WEBP },
      );
      setPreviewUri(result.uri);
      const fsInfo = await FileSystem.getInfoAsync(result.uri);
      if (fsInfo.exists) setPreviewFileSize(fsInfo.size ?? null);
    } catch {
      setPreviewUri(null);
    } finally {
      setGeneratingPreview(false);
    }
  }, [previewSrcUri]);

  // Trigger when previewSrcUri is available
  useEffect(() => {
    if (previewSrcUri) {
      void regeneratePreview(sliderValue);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSrcUri]);

  const handleSliderChange = useCallback((t: number) => {
    setSliderValue(t);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void regeneratePreview(t);
    }, 80);
  }, [regeneratePreview]);

  const handleApply = useCallback(async () => {
    if (applying || eligibleIds.length === 0) return;
    setApplying(true);
    try {
      const q = fromSliderT(sliderValue);
      await setThumbnailQuality(q);
      setSavedSliderValue(sliderValue);
      const preset = toPreset(q);
      await BeebeebThumbnails.enqueueApplyQuality(eligibleIds, preset);
      navigation.navigate('ThumbnailWorker');
    } catch {
      // Non-fatal: native module may be unavailable on Android / Expo Go.
    } finally {
      setApplying(false);
    }
  }, [applying, eligibleIds, sliderValue, navigation]);

  const q = fromSliderT(sliderValue);
  const savedQ = fromSliderT(savedSliderValue);
  const estBytesPerThumb = estimateBytesPerThumb(q);
  const savedBytesPerThumb = estimateBytesPerThumb(savedQ);
  const deltaPerFile = estBytesPerThumb - savedBytesPerThumb;
  const totalDeltaBytes = eligibleCount != null ? deltaPerFile * eligibleCount : null;
  const etaSec = eligibleCount != null ? eligibleCount / 8.0 : null;
  const isChanged = Math.abs(sliderValue - savedSliderValue) > 0.005;

  const presetLabel = (() => {
    if (q.width <= 384) return 'Small';
    if (q.width <= 768) return 'Medium';
    if (q.width <= 1024) return 'Large';
    return 'Extra large';
  })();

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Thumbnail quality</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
      >
        {/* Description */}
        <Text style={[styles.body, { color: c.ink2 }]}>
          Choose how sharp saved thumbnails should be. Higher quality uses more storage.
        </Text>

        {/* Slider card */}
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={styles.sliderLabelRow}>
            <Text style={[styles.sliderLabelLeft, { color: c.ink3 }]}>Small</Text>
            <View style={styles.sliderCenter}>
              <Text style={[styles.sliderPresetLabel, { color: c.ink }]}>{presetLabel}</Text>
              <Text style={[styles.caption, { color: c.ink3 }]}>
                {`${q.width}px · q${Math.round(q.quality * 100)}`}
              </Text>
            </View>
            <Text style={[styles.sliderLabelRight, { color: c.ink3 }]}>Extra large</Text>
          </View>

          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            value={sliderValue}
            onValueChange={handleSliderChange}
            minimumTrackTintColor={c.amber}
            maximumTrackTintColor={c.line2}
            thumbTintColor={c.amber}
            accessibilityLabel="Thumbnail quality slider"
          />

          {/* Tick marks */}
          <View style={styles.tickRow}>
            {[0, 0.5, 1].map((t) => (
              <View key={t} style={[styles.tick, { backgroundColor: c.line2 }]} />
            ))}
          </View>
        </View>

        {/* Live preview */}
        {previewSrcUri ? (
          <>
            <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Preview</Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              <View style={styles.previewRow}>
                <View style={styles.previewCell}>
                  <Text style={[styles.previewCellLabel, { color: c.ink3 }]}>Original</Text>
                  <Image source={{ uri: previewSrcUri }} style={styles.previewImage} resizeMode="cover" />
                  {originalFileSize != null ? (
                    <Text style={[styles.caption, { color: c.ink4 }]}>{formatBytes(originalFileSize)}</Text>
                  ) : null}
                </View>
                <View style={styles.previewCell}>
                  <Text style={[styles.previewCellLabel, { color: c.ink3 }]}>This setting</Text>
                  {generatingPreview ? (
                    <View style={[styles.previewImage, styles.previewPlaceholder, { backgroundColor: c.line }]}>
                      <ActivityIndicator color={c.amber} />
                    </View>
                  ) : previewUri ? (
                    <Image source={{ uri: previewUri }} style={styles.previewImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.previewImage, styles.previewPlaceholder, { backgroundColor: c.line }]} />
                  )}
                  {previewFileSize != null && !generatingPreview ? (
                    <Text style={[styles.caption, { color: c.ink4 }]}>{formatBytes(previewFileSize)}</Text>
                  ) : null}
                </View>
              </View>
            </View>
          </>
        ) : null}

        {/* Scope helper */}
        {Platform.OS === 'ios' ? (
          <>
            <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Apply to existing photos</Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              {loadingScope ? (
                <ActivityIndicator color={c.amber} />
              ) : (
                <>
                  <View style={styles.statGrid}>
                    <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                      <Text style={[styles.statValue, { color: c.ink }]}>
                        {eligibleCount?.toLocaleString() ?? '—'}
                      </Text>
                      <Text style={[styles.statLabel, { color: c.ink3 }]}>photos</Text>
                    </View>
                    <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                      <Text style={[styles.statValue, { color: c.ink }]}>
                        {totalDeltaBytes != null
                          ? (totalDeltaBytes > 0 ? '+' : '') + formatBytes(totalDeltaBytes)
                          : '—'}
                      </Text>
                      <Text style={[styles.statLabel, { color: c.ink3 }]}>storage delta</Text>
                    </View>
                    <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                      <Text style={[styles.statValue, { color: c.ink }]}>
                        {etaSec != null ? formatTime(etaSec) : '—'}
                      </Text>
                      <Text style={[styles.statLabel, { color: c.ink3 }]}>est. time</Text>
                    </View>
                  </View>

                  <Text style={[styles.caption, { color: c.ink3 }]}>
                    Only photos still available on this iPhone are eligible. Runs 8 workers in parallel.
                  </Text>

                  <TouchableOpacity
                    style={[
                      styles.primaryButton,
                      {
                        backgroundColor:
                          (!isChanged && eligibleCount === 0) || applying
                            ? c.line2
                            : c.amber,
                      },
                    ]}
                    onPress={handleApply}
                    disabled={applying || eligibleIds.length === 0}
                    accessibilityRole="button"
                    accessibilityLabel="Apply quality setting to existing photos"
                  >
                    {applying ? (
                      <ActivityIndicator color="#16110a" />
                    ) : (
                      <Text style={styles.primaryButtonText}>
                        {eligibleCount === 0
                          ? 'No eligible photos'
                          : `Apply to ${eligibleCount?.toLocaleString() ?? '…'} photos`}
                      </Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          </>
        ) : (
          <>
            <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Apply to existing photos</Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              <Text style={[styles.applyTitle, { color: c.ink }]}>Apply to existing photos</Text>
              <Text style={[styles.body, { color: c.ink2 }]}>Thumbnail regeneration is available on iOS only in this version. Coming to Android soon.</Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const PREVIEW_IMAGE_SIZE = 132;

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '800' },
  scroll: { flex: 1 },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 16 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 18,
    marginBottom: 8,
  },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', padding: 12, gap: 12 },
  sliderLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sliderLabelLeft: { fontSize: 11, fontWeight: '700', width: 48 },
  sliderLabelRight: { fontSize: 11, fontWeight: '700', width: 60, textAlign: 'right' },
  sliderCenter: { flex: 1, alignItems: 'center' },
  sliderPresetLabel: { fontSize: 15, fontWeight: '900' },
  slider: { width: '100%', height: 36 },
  tickRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, marginTop: -4 },
  tick: { width: 2, height: 6, borderRadius: 1 },
  caption: { fontSize: 12, lineHeight: 17 },
  previewRow: { flexDirection: 'row', gap: 12 },
  previewCell: { flex: 1, gap: 6, alignItems: 'center' },
  previewCellLabel: { fontSize: 12, fontWeight: '700' },
  previewImage: { width: PREVIEW_IMAGE_SIZE, height: PREVIEW_IMAGE_SIZE, borderRadius: 8 },
  previewPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  statGrid: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 10 },
  statValue: { fontSize: 18, fontWeight: '900' },
  statLabel: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  primaryButton: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  primaryButtonText: { color: '#16110a', fontSize: 15, fontWeight: '900' },
  applyTitle: { fontSize: 15, fontWeight: '800' },
});
