import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList } from '../App';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { normalizeImageOrientation } from '../lib/image-orientation';
import { recognizeDocumentText } from '../../modules/beebeeb-crypto';
import { summarizeDocument } from '../lib/doc-summary';
import type { DocSummary } from '../lib/doc-summary';
import { friendlyError, trustLocation } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import { useTheme } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import { buildJpegPdfBytes } from '../lib/minimal-pdf';
import type { PdfImagePage } from '../lib/minimal-pdf';
import { fonts, radii, shadows, spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'DocumentScanner'>;

type CameraCapturedPicture = {
  uri: string;
  base64?: string;
  width: number;
  height: number;
};

type CameraRef = {
  takePictureAsync(options: {
    base64: boolean;
    imageType: 'jpg';
    quality: number;
    skipProcessing: boolean;
  }): Promise<CameraCapturedPicture>;
};

type CameraPermission = {
  granted: boolean;
  canAskAgain: boolean;
} | null;

type CameraModule = {
  CameraView: React.ComponentType<{
    ref?: React.Ref<CameraRef>;
    style?: object;
    facing: 'back';
    onCameraReady: () => void;
  }>;
  useCameraPermissions: () => [CameraPermission, () => Promise<CameraPermission>];
};

let cachedCameraModule: CameraModule | null | undefined;

function getCameraModule(): CameraModule | null {
  if (cachedCameraModule !== undefined) return cachedCameraModule;
  try {
    cachedCameraModule = require('expo-camera') as CameraModule;
  } catch {
    cachedCameraModule = null;
  }
  return cachedCameraModule;
}

interface CapturePage {
  uri: string;
  base64: string;
  width: number;
  height: number;
  /** On-device OCR text for this page (task 0802); '' when none / unavailable. */
  ocrText?: string;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
  }
  return btoa(binary);
}

function safeCapturedPage(photo: CameraCapturedPicture | undefined): CapturePage | null {
  if (!photo?.base64) return null;
  return {
    uri: photo.uri,
    base64: photo.base64,
    width: Math.max(1, Math.round(photo.width)),
    height: Math.max(1, Math.round(photo.height)),
  };
}

function scannedPdfName(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `Scanned document ${stamp}.pdf`;
}

export default function DocumentScannerScreen() {
  const camera = getCameraModule();
  if (!camera) return <DocumentScannerUnavailable />;
  return <DocumentScannerCameraScreen camera={camera} />;
}

function DocumentScannerUnavailable() {
  const navigation = useNavigation<Nav>();
  const { colors: c } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={styles.unavailableContent}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={[styles.iconButton, { backgroundColor: c.paper2, borderColor: c.line }]}
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
        >
          <Ionicons name="close" size={20} color={c.ink2} />
        </TouchableOpacity>
        <View style={styles.permissionState}>
          <Ionicons name="camera-outline" size={32} color={c.ink3} />
          <Text style={[styles.permissionTitle, { color: c.ink }]}>Scanner unavailable</Text>
          <Text style={[styles.permissionCopy, { color: c.ink3 }]}>
            This build is missing the native camera module required to scan documents.
          </Text>
        </View>
      </View>
    </View>
  );
}

function DocumentScannerCameraScreen({ camera }: { camera: CameraModule }) {
  const { CameraView, useCameraPermissions } = camera;
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { colors: c } = useTheme();
  const { showToast } = useToast();
  const { isUnlocked, encryptChunk, encryptMetadata } = useCrypto();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraRef | null>(null);
  const capturesRef = useRef<CapturePage[]>([]);
  const pdfUriRef = useRef<string | null>(null);
  const ocrPendingRef = useRef(0);

  const [captures, setCaptures] = useState<CapturePage[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Task 0802: on-device OCR/summary state.
  const [ocrBusy, setOcrBusy] = useState(false);
  const [aiNoteCleared, setAiNoteCleared] = useState(false);

  useEffect(() => {
    capturesRef.current = captures;
  }, [captures]);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission().catch(() => {});
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    return () => {
      for (const page of capturesRef.current) {
        FileSystem.deleteAsync(page.uri, { idempotent: true }).catch(() => {});
      }
      if (pdfUriRef.current) {
        FileSystem.deleteAsync(pdfUriRef.current, { idempotent: true }).catch(() => {});
      }
    };
  }, []);

  const addCapture = useCallback((page: CapturePage) => {
    setCaptures((prev) => [...prev, page]);
    setPreviewing(true);
  }, []);

  // Task 0802: extract text from a captured page entirely on-device (Apple
  // Vision). Best-effort and non-blocking — OCR runs after the page is added so
  // capturing stays snappy, and a failure never interrupts scanning. ZERO
  // network: the pixels and recognized text never leave the device.
  const runOcrForPage = useCallback(async (uri: string) => {
    ocrPendingRef.current += 1;
    setOcrBusy(true);
    try {
      const result = await recognizeDocumentText(uri);
      const text = result?.text?.trim() ?? '';
      if (text) {
        setCaptures((prev) => prev.map((p) => (p.uri === uri ? { ...p, ocrText: text } : p)));
      }
    } catch {
      // OCR is an enhancement, not a requirement — swallow and move on.
    } finally {
      ocrPendingRef.current = Math.max(0, ocrPendingRef.current - 1);
      if (ocrPendingRef.current === 0) setOcrBusy(false);
    }
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || !cameraReady || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        imageType: 'jpg',
        quality: 0.82,
        skipProcessing: false,
      });
      const page = safeCapturedPage(photo);
      if (!page) {
        Alert.alert('Scan failed', 'Could not capture this page. Please try again.');
        return;
      }

      // Task 0801: bake the EXIF orientation into the pixels. The captured JPEG
      // is embedded raw into a PDF image XObject, which ignores orientation
      // tags — without this the page renders rotated. Re-encoding normalizes the
      // pixels to "up" and gives us the post-rotation width/height for the PDF
      // page sizing. Best-effort: if the manipulator binding is missing we keep
      // the original capture rather than failing the scan.
      let normalizedPage = page;
      try {
        const normalized = await normalizeImageOrientation(photo.uri, { quality: 0.82 });
        if (normalized) {
          normalizedPage = {
            uri: normalized.uri,
            base64: normalized.base64,
            width: normalized.width,
            height: normalized.height,
          };
          if (normalized.uri !== photo.uri) {
            FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});
          }
        }
      } catch {
        // Keep the original capture — a mis-oriented page beats a failed scan.
      }

      addCapture(normalizedPage);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // Fire-and-forget on-device OCR for this page (task 0802).
      void runOcrForPage(normalizedPage.uri);
    } catch (err) {
      Alert.alert('Scan failed', friendlyError(err));
    } finally {
      setCapturing(false);
    }
  }, [addCapture, cameraReady, capturing, runOcrForPage]);

  const handleRetakeLast = useCallback(() => {
    setCaptures((prev) => {
      const next = prev.slice(0, -1);
      const removed = prev[prev.length - 1];
      if (removed) FileSystem.deleteAsync(removed.uri, { idempotent: true }).catch(() => {});
      setPreviewing(next.length > 0);
      return next;
    });
  }, []);

  const handleAddAnotherPage = useCallback(() => {
    setPreviewing(false);
    setCameraReady(false);
  }, []);

  // Task 0802: combine every page's on-device OCR text and locally summarize it.
  const combinedOcr = useMemo(
    () => captures.map((p) => p.ocrText ?? '').filter((t) => t.length > 0).join('\n\n').trim(),
    [captures],
  );
  const docSummary: DocSummary | null = useMemo(
    () => (combinedOcr.length > 0 ? summarizeDocument(combinedOcr) : null),
    [combinedOcr],
  );
  const showAiNote = !aiNoteCleared && combinedOcr.length > 0;

  const handleClearAiNote = useCallback(() => {
    setAiNoteCleared(true);
  }, []);

  const handleSaveToVault = useCallback(async () => {
    if (captures.length === 0 || saving) return;
    if (!isUnlocked) {
      Alert.alert('Vault is locked', 'Unlock the vault before saving scanned documents.');
      return;
    }

    setSaving(true);
    const fileId = await generateFileId();
    const fileName = scannedPdfName();
    const pdfUri = `${FileSystem.cacheDirectory ?? ''}${fileId}.pdf`;
    pdfUriRef.current = pdfUri;

    try {
      const pdfPages: PdfImagePage[] = captures.map((page) => ({
        jpeg: base64ToUint8Array(page.base64),
        width: page.width,
        height: page.height,
      }));
      const pdfBytes = buildJpegPdfBytes(pdfPages);
      await FileSystem.writeAsStringAsync(pdfUri, uint8ArrayToBase64(pdfBytes), {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Task 0802: attach the on-device OCR note + local summary to the file's
      // E2E-encrypted metadata (unless the user cleared it). All computed on
      // device; never sent in plaintext. The OCR text rides in the encrypted
      // metadata blob so a follow-up can feed it into the search index (0778).
      const noteText = aiNoteCleared ? '' : combinedOcr;
      const summary = noteText.length > 0 ? summarizeDocument(noteText) : null;
      const metadataExtras = noteText.length > 0
        ? {
            note: noteText,
            aiSummary: summary?.summary,
            aiDocType: summary?.docType,
            ai: true,
          }
        : undefined;

      const uploaded = await encryptedUpload({
        fileId,
        uri: pdfUri,
        name: fileName,
        parentId: route.params?.parentId ?? undefined,
        mimeType: 'application/pdf',
        metadataExtras,
        encryptChunkFn: encryptChunk,
        encryptMetadataFn: encryptMetadata,
      });
      const loc = trustLocation(uploaded.storage_pool_id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: 'success', message: `"${fileName}" stored in ${loc.city}` });
      navigation.goBack();
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Save failed', friendlyError(err));
    } finally {
      setSaving(false);
    }
  }, [aiNoteCleared, captures, combinedOcr, encryptChunk, encryptMetadata, isUnlocked, navigation, route.params?.parentId, saving, showToast]);

  const lastCapture = captures[captures.length - 1] ?? null;
  const hasPermission = permission?.granted === true;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={[styles.iconButton, { backgroundColor: c.paper2, borderColor: c.line }]}
            accessibilityRole="button"
            accessibilityLabel="Close scanner"
          >
            <Ionicons name="close" size={20} color={c.ink2} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: c.ink }]}>Scan document</Text>
            <Text style={[styles.subtitle, { color: c.ink3 }]}>
              {captures.length === 0 ? 'Capture the first page' : `${captures.length} page${captures.length === 1 ? '' : 's'} captured`}
            </Text>
          </View>
        </View>

        <View style={[styles.previewFrame, { backgroundColor: c.paper2, borderColor: c.line }]}>
          {previewing && lastCapture ? (
            <Image source={{ uri: lastCapture.uri }} style={styles.previewImage} resizeMode="contain" />
          ) : hasPermission ? (
            <Pressable onPress={handleCapture} style={styles.cameraPressable} accessibilityRole="button" accessibilityLabel="Capture page">
              <CameraView
                ref={cameraRef}
                style={styles.camera}
                facing="back"
                onCameraReady={() => setCameraReady(true)}
              />
              <View style={styles.captureHint}>
                <Ionicons name="scan-outline" size={18} color="#fff" />
                <Text style={styles.captureHintText}>Tap to capture</Text>
              </View>
            </Pressable>
          ) : (
            <View style={styles.permissionState}>
              <Ionicons name="camera-outline" size={32} color={c.ink3} />
              <Text style={[styles.permissionTitle, { color: c.ink }]}>Camera access needed</Text>
              <Text style={[styles.permissionCopy, { color: c.ink3 }]}>
                Allow camera access to scan document pages into an encrypted PDF.
              </Text>
              <TouchableOpacity
                onPress={() => requestPermission()}
                style={[styles.primaryButton, { backgroundColor: c.amber }]}
                accessibilityRole="button"
              >
                <Text style={[styles.primaryButtonText, { color: c.ink }]}>Allow camera</Text>
              </TouchableOpacity>
            </View>
          )}
          {(capturing || saving) && (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.busyText}>{saving ? 'Saving to vault...' : 'Capturing...'}</Text>
            </View>
          )}
        </View>

        {/*
          Task 0802: AI note + summary, computed on-device. Placeholder treatment
          pending the ux-designer's 0802 spec (final badge/icon, edit affordance).
          The data wiring (note, summary, doc type, "on your device" signal,
          clear control) is complete; only the exact styling is the designer's.
        */}
        {previewing && (showAiNote || ocrBusy) && (
          <View style={[styles.aiCard, { backgroundColor: c.paper2, borderColor: c.line }]}>
            <View style={styles.aiCardHeader}>
              <View style={styles.aiBadge}>
                <Ionicons name="sparkles" size={14} color={c.amber} />
                <Text style={[styles.aiBadgeText, { color: c.ink }]}>AI summary</Text>
              </View>
              <View style={styles.aiCardHeaderRight}>
                <View style={[styles.aiPill, { borderColor: c.line }]}>
                  <Ionicons name="lock-closed" size={10} color={c.ink3} />
                  <Text style={[styles.aiPillText, { color: c.ink3 }]}>On your device</Text>
                </View>
                {showAiNote && (
                  <TouchableOpacity
                    onPress={handleClearAiNote}
                    accessibilityRole="button"
                    accessibilityLabel="Remove AI note"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={16} color={c.ink3} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
            {ocrBusy && !showAiNote ? (
              <View style={styles.aiBusyRow}>
                <ActivityIndicator size="small" color={c.amber} />
                <Text style={[styles.aiBusyText, { color: c.ink3 }]}>Reading text…</Text>
              </View>
            ) : showAiNote ? (
              <>
                {docSummary && (
                  <Text style={[styles.aiSummary, { color: c.ink }]} numberOfLines={2}>
                    {docSummary.summary}
                  </Text>
                )}
                <Text style={[styles.aiNotePreview, { color: c.ink3 }]} numberOfLines={3}>
                  {combinedOcr}
                </Text>
                <Text style={[styles.aiFootnote, { color: c.ink4 }]}>
                  Extracted on this device · saved encrypted with the document
                </Text>
              </>
            ) : null}
          </View>
        )}

        <View style={styles.actionRow}>
          {previewing && (
            <TouchableOpacity
              onPress={handleAddAnotherPage}
              disabled={saving}
              style={[styles.secondaryButton, { borderColor: c.line, backgroundColor: c.paper2 }, saving && styles.disabled]}
              accessibilityRole="button"
            >
              <Ionicons name="add" size={18} color={c.ink2} />
              <Text style={[styles.secondaryButtonText, { color: c.ink2 }]}>Add another page</Text>
            </TouchableOpacity>
          )}
          {previewing && (
            <TouchableOpacity
              onPress={handleRetakeLast}
              disabled={saving}
              style={[styles.secondaryButton, { borderColor: c.line, backgroundColor: c.paper2 }, saving && styles.disabled]}
              accessibilityRole="button"
            >
              <Ionicons name="refresh" size={18} color={c.ink2} />
              <Text style={[styles.secondaryButtonText, { color: c.ink2 }]}>Retake</Text>
            </TouchableOpacity>
          )}
          {!previewing && hasPermission && (
            <TouchableOpacity
              onPress={handleCapture}
              disabled={!cameraReady || capturing || saving}
              style={[styles.primaryButton, { backgroundColor: c.amber }, (!cameraReady || capturing || saving) && styles.disabled]}
              accessibilityRole="button"
            >
              <Ionicons name="scan-outline" size={18} color={c.ink} />
              <Text style={[styles.primaryButtonText, { color: c.ink }]}>Capture page</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleSaveToVault}
            disabled={captures.length === 0 || saving}
            style={[styles.primaryButton, { backgroundColor: c.amber }, (captures.length === 0 || saving) && styles.disabled]}
            accessibilityRole="button"
          >
            <Ionicons name="lock-closed" size={18} color={c.ink} />
            <Text style={[styles.primaryButtonText, { color: c.ink }]}>Save to vault</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  unavailableContent: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerText: { flex: 1 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { marginTop: 3, fontSize: 13, fontFamily: fonts.sans },
  previewFrame: {
    minHeight: 460,
    borderWidth: 1,
    borderRadius: radii.lg,
    overflow: 'hidden',
    ...shadows.md,
  },
  cameraPressable: { flex: 1, minHeight: 460 },
  camera: { flex: 1 },
  previewImage: { width: '100%', minHeight: 460 },
  captureHint: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
  },
  captureHintText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  permissionState: {
    minHeight: 460,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  permissionTitle: { fontSize: 17, fontWeight: '700' },
  permissionCopy: { textAlign: 'center', lineHeight: 20 },
  busyOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.46)',
  },
  busyText: { color: '#fff', fontWeight: '700' },
  actionRow: { gap: spacing.sm },
  primaryButton: {
    minHeight: 48,
    borderRadius: radii.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
  },
  primaryButtonText: { fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radii.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
  },
  secondaryButtonText: { fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  // Task 0802 — AI note card (placeholder treatment, pending designer spec).
  aiCard: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  aiCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiBadgeText: { fontSize: 14, fontWeight: '700' },
  aiCardHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  aiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  aiPillText: { fontSize: 11, fontWeight: '600' },
  aiBusyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aiBusyText: { fontSize: 13, fontFamily: fonts.sans },
  aiSummary: { fontSize: 14, fontWeight: '600', lineHeight: 19 },
  aiNotePreview: { fontSize: 12, lineHeight: 17, fontFamily: fonts.sans },
  aiFootnote: { fontSize: 11, lineHeight: 15, fontFamily: fonts.sans },
});
