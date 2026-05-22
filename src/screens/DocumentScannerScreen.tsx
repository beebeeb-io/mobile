import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList } from '../App';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
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

  const [captures, setCaptures] = useState<CapturePage[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);

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
      addCapture(page);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      Alert.alert('Scan failed', friendlyError(err));
    } finally {
      setCapturing(false);
    }
  }, [addCapture, cameraReady, capturing]);

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

      const uploaded = await encryptedUpload({
        fileId,
        uri: pdfUri,
        name: fileName,
        parentId: route.params?.parentId ?? undefined,
        mimeType: 'application/pdf',
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
  }, [captures, encryptChunk, encryptMetadata, isUnlocked, navigation, route.params?.parentId, saving, showToast]);

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
    ...StyleSheet.absoluteFillObject,
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
});
