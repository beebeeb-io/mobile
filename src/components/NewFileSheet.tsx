/**
 * Task 1587 — "+" → New file: the type picker + name step, in the shared
 * BottomSheet (task 1586).
 *
 * The picker is Guus's pick D3 "icon wells" (design/ios-new-file-d-variants.html,
 * V3): four across; a rounded-square well with a hairline border wraps ONLY
 * the icon, a thin outline document with the extension printed inside; the
 * name sits under the well, outside the border (Finder / home-screen style).
 *   - Markdown: amber 1.5pt well + a faint amber fill, amber icon, semibold name.
 *   - Text: hairline well, ink icon.
 *   - Word / Excel / PowerPoint: a fainter well, icon + name at 35 %, "SOON"
 *     under the name; inert (no press feedback), VoiceOver says so in words.
 *
 * The name step (design/ios-new-file.html, step 3) is a second step in the
 * same sheet: Markdown keeps a fixed ".md"; Text has its own editable
 * extension segment + suggestion chips, with Office/ODF/binary extensions
 * refused (rules + copy in lib/new-document.ts, unit-tested there).
 *
 * The sheet itself never touches crypto or the network: `onCreate` (from
 * FilesScreen) does the fresh-listing clash check, the encrypted upload and
 * the navigation, and throws a user-facing Error that is shown inline here.
 *
 * No SVG library in the tree (and no new native deps allowed), so the outline
 * document is drawn from six hairline Views — the same geometry as the mock's
 * `<path d="M4 2.5h14.5l7.5 7.5v25.5H4z"/>` + its fold.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { fonts } from '../theme';
import { useTheme } from '../lib/theme-context';
import { BottomSheet, BottomSheetScrollView } from './sheet/BottomSheet';
import {
  NEW_FILE_TYPES,
  TEXT_EXTENSION_SUGGESTIONS,
  checkNewDocumentName,
  checkTextExtension,
  defaultNewDocumentBase,
  documentTypeForTile,
  normalizeExtension,
  tileAccessibilityLabel,
  tileIconLabel,
  type NewDocumentType,
  type NewFileTypeTile,
} from '../lib/new-document';

const MONO_MEDIUM = 'JetBrainsMono-Medium';
const SIDE = 24;
const COLS = 4;
const COL_GAP = 8;

export interface NewFileRequest {
  type: NewDocumentType;
  name: string;
  mimeType: string;
  opensInEditor: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Decrypted names of every sibling in the current folder (on-screen list;
   *  the authoritative fresh re-list happens inside `onCreate`). */
  existingNames: () => string[];
  /** Name of the folder the file lands in ("Drive" at the root). */
  folderLabel: string;
  /** Create + encrypt + upload + open. Throws an Error whose message is
   *  user-facing; resolves once the sheet may close. */
  onCreate: (req: NewFileRequest) => Promise<void>;
}

type Step =
  | { kind: 'types' }
  | { kind: 'name'; type: NewDocumentType };

interface Draft {
  base: string;
  ext: string;
}

// ─── The thin outline document with the extension inside ─────────────────────

function DocOutlineIcon({ width, color, label }: { width: number; color: string; label: string }) {
  // Mock viewBox 30×38; the document spans x 4→26, y 2.5→35.5, fold 7.5.
  const s = width / 30;
  const W = 22 * s;
  const H = 33 * s;
  const f = 7.5 * s;
  const t = Math.max(1, 1.5 * s);
  const diag = f * Math.SQRT2;
  const fontSize = (label.length >= 4 ? 5.6 : label.length === 3 ? 6.4 : 7.2) * s;
  return (
    <View style={{ width: 30 * s, height: 38 * s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: W, height: H }}>
        <View style={{ position: 'absolute', left: 0, top: 0, width: W - f, height: t, backgroundColor: color }} />
        <View style={{ position: 'absolute', left: 0, top: 0, width: t, height: H, backgroundColor: color }} />
        <View style={{ position: 'absolute', left: 0, top: H - t, width: W, height: t, backgroundColor: color }} />
        <View style={{ position: 'absolute', left: W - t, top: f, width: t, height: H - f, backgroundColor: color }} />
        <View style={{ position: 'absolute', left: W - f - t / 2, top: 0, width: t, height: f, backgroundColor: color }} />
        <View style={{ position: 'absolute', left: W - f, top: f - t / 2, width: f, height: t, backgroundColor: color }} />
        <View
          style={{
            position: 'absolute',
            left: W - f / 2 - diag / 2,
            top: f / 2 - t / 2,
            width: diag,
            height: t,
            backgroundColor: color,
            transform: [{ rotate: '45deg' }],
          }}
        />
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: H * 0.56,
            textAlign: 'center',
            color,
            fontFamily: MONO_MEDIUM,
            fontSize,
            lineHeight: fontSize * 1.25,
            letterSpacing: 0.2,
          }}
        >
          {label}
        </Text>
      </View>
    </View>
  );
}

// ─── The sheet ──────────────────────────────────────────────────────────────

export default function NewFileSheet({ visible, onClose, existingNames, folderLabel, onCreate }: Props) {
  const { colors: c, resolved } = useTheme();
  const dark = resolved === 'dark';
  const { width: screenW } = useWindowDimensions();

  const [modalMounted, setModalMounted] = useState(visible);
  const [step, setStep] = useState<Step>({ kind: 'types' });
  const [drafts, setDrafts] = useState<Partial<Record<'md' | 'txt', Draft>>>({});
  const [error, setError] = useState<{ field: 'name' | 'extension'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  // Every open starts fresh at the type grid.
  useEffect(() => {
    if (visible) {
      setModalMounted(true);
      setStep({ kind: 'types' });
      setDrafts({});
      setError(null);
      setCreating(false);
      creatingRef.current = false;
    }
  }, [visible]);

  const requestClose = useCallback(() => {
    if (creatingRef.current) return; // never abandon an upload mid-flight
    onClose();
  }, [onClose]);

  // ── Palette (D3 is drawn dark; the light values follow design/ios-new-file.html's light tiles)
  const pal = useMemo(
    () => ({
      wellLine: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
      wellLineOff: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
      accentLine: dark ? c.amber : '#D99E14',
      accentIcon: dark ? c.amber : '#8A5A00',
      accentFill: dark ? 'rgba(245,184,46,0.08)' : 'rgba(245,184,46,0.10)',
      fieldBg: dark ? c.paper2 : '#FFFFFF',
      extBg: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)',
    }),
    [dark, c.amber, c.paper2],
  );

  const colW = (screenW - SIDE * 2 - COL_GAP * (COLS - 1)) / COLS;
  const well = Math.round(Math.min(72, colW * 0.83));
  const iconW = Math.round(well * 0.494);

  // ── Steps
  const openNameStep = useCallback(
    (tile: NewFileTypeTile) => {
      const type = documentTypeForTile(tile);
      if (!type) return; // "soon" tiles are inert
      setDrafts((cur) =>
        cur[type.id]
          ? cur
          : { ...cur, [type.id]: { base: defaultNewDocumentBase(type, existingNames()), ext: type.ext } },
      );
      setError(null);
      setStep({ kind: 'name', type });
    },
    [existingNames],
  );

  const backToTypes = useCallback(() => {
    if (creatingRef.current) return;
    setError(null);
    setStep({ kind: 'types' }); // drafts survive: the typed name is kept
  }, []);

  const type = step.kind === 'name' ? step.type : null;
  const draft = type ? drafts[type.id] : undefined;

  const setDraft = useCallback(
    (patch: Partial<Draft>) => {
      if (!type) return;
      setDrafts((cur) => ({ ...cur, [type.id]: { ...(cur[type.id] ?? { base: '', ext: type.ext }), ...patch } }));
      setError(null);
    },
    [type],
  );

  // Live verdict on the extension (a refused one shows before the tap).
  const extVerdict = type?.extensionEditable && draft ? checkTextExtension(draft.ext) : null;
  const liveExtError = extVerdict && !extVerdict.ok && normalizeExtension(draft?.ext ?? '') ? extVerdict.reason : null;
  const extNote = extVerdict && extVerdict.ok ? extVerdict.note : null;
  const shownError = error?.text ?? liveExtError;
  const errorField = error?.field ?? (liveExtError ? 'extension' : null);

  const canCreate = !!type && !!draft && draft.base.trim().length > 0 && !liveExtError && !creating;

  const submit = useCallback(async () => {
    if (!type || !draft || creatingRef.current) return;
    const check = checkNewDocumentName(draft.base, draft.ext, type, existingNames());
    if (!check.ok) {
      setError({ field: check.field, text: check.reason });
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    try {
      await onCreate({ type, name: check.name, mimeType: check.mimeType, opensInEditor: check.opensInEditor });
    } catch (e) {
      setError({ field: 'name', text: e instanceof Error ? e.message : String(e) });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [type, draft, existingNames, onCreate]);

  // ── Render pieces
  const header =
    step.kind === 'types' ? (
      <View style={styles.headerBlock}>
        <Text style={[styles.title, { color: c.ink }]} accessibilityRole="header">
          New file
        </Text>
        <View style={styles.lockLine}>
          <Ionicons name="lock-closed" size={11} color={c.amber} />
          <Text style={[styles.lockText, { color: c.ink3 }]}>Encrypted on this device before it leaves</Text>
        </View>
      </View>
    ) : (
      <View style={styles.headerBlock}>
        <Pressable
          onPress={backToTypes}
          hitSlop={10}
          style={styles.backRow}
          accessibilityRole="button"
          accessibilityLabel="Back to file types"
          testID="new-file-back"
        >
          <Ionicons name="chevron-back" size={15} color={c.ink3} />
          <Text style={[styles.backText, { color: c.ink3 }]}>File types</Text>
        </Pressable>
        <Text style={[styles.title, { color: c.ink }]} accessibilityRole="header">
          {type?.stepTitle}
        </Text>
      </View>
    );

  const typesBody = (
    <>
      <Text style={[styles.sectionLabel, { color: c.ink3 }]}>PICK A TYPE</Text>
      <View style={styles.grid} accessibilityRole="list">
        {NEW_FILE_TYPES.map((tile) => {
          const live = tile.status === 'live';
          const accent = tile.accent;
          const wellStyle = [
            styles.well,
            {
              width: well,
              height: well,
              borderRadius: Math.round(well * 0.27),
              borderColor: accent ? pal.accentLine : live ? pal.wellLine : pal.wellLineOff,
              borderWidth: accent ? 1.5 : StyleSheet.hairlineWidth * 2,
              backgroundColor: accent ? pal.accentFill : 'transparent',
            },
          ];
          const iconColor = accent ? pal.accentIcon : c.ink;
          const inner = (
            <>
              <View style={wellStyle}>
                <View style={{ opacity: live ? 1 : 0.35 }}>
                  <DocOutlineIcon width={iconW} color={iconColor} label={tileIconLabel(tile)} />
                </View>
              </View>
              <Text
                numberOfLines={1}
                style={[
                  styles.tileName,
                  { color: accent ? c.ink : c.ink2, fontWeight: accent ? '600' : '500', opacity: live ? 1 : 0.35 },
                ]}
              >
                {tile.name}
              </Text>
              {live ? null : <Text style={[styles.soon, { color: c.ink3 }]}>SOON</Text>}
            </>
          );
          return live ? (
            <Pressable
              key={tile.id}
              onPress={() => openNameStep(tile)}
              style={({ pressed }) => [styles.tile, { width: colW, opacity: pressed ? 0.6 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={tileAccessibilityLabel(tile)}
              accessibilityHint="Opens the name step."
              testID={`new-file-tile-${tile.id}`}
            >
              {inner}
            </Pressable>
          ) : (
            <View
              key={tile.id}
              style={[styles.tile, { width: colW }]}
              accessible
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              accessibilityLabel={tileAccessibilityLabel(tile)}
              testID={`new-file-tile-${tile.id}`}
            >
              {inner}
            </View>
          );
        })}
      </View>
    </>
  );

  const nameBody =
    type && draft ? (
      <>
        <View
          style={[
            styles.field,
            {
              backgroundColor: pal.fieldBg,
              borderColor: shownError ? c.red : c.amber,
            },
          ]}
        >
          <TextInput
            value={draft.base}
            onChangeText={(base) => setDraft({ base })}
            placeholder="File name"
            placeholderTextColor={c.ink4}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            editable={!creating}
            style={[styles.baseInput, { color: c.ink }]}
            accessibilityLabel="File name"
            testID="new-file-name-input"
          />
          {type.extensionEditable ? (
            <View
              style={[
                styles.extSegment,
                {
                  backgroundColor: pal.extBg,
                  borderLeftColor: errorField === 'extension' ? c.red : c.line,
                },
              ]}
            >
              <Text style={[styles.extDot, { color: c.ink2 }]}>.</Text>
              <TextInput
                value={draft.ext}
                onChangeText={(ext) => setDraft({ ext: ext.replace(/^\.+/, '') })}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
                editable={!creating}
                maxLength={17}
                style={[styles.extInput, { color: errorField === 'extension' ? c.red : c.ink }]}
                accessibilityLabel="Extension"
                accessibilityHint="Any plain-text extension, like py or json."
                testID="new-file-ext-input"
              />
            </View>
          ) : (
            <Text style={[styles.fixedExt, { color: c.ink3 }]} accessibilityLabel="Extension .md, fixed">
              .md
            </Text>
          )}
        </View>

        {shownError ? (
          <Text style={[styles.message, { color: c.red }]} accessibilityLiveRegion="polite" testID="new-file-error">
            {shownError}
          </Text>
        ) : extNote ? (
          <Text style={[styles.message, { color: c.ink3 }]} testID="new-file-note">
            {extNote}
          </Text>
        ) : (
          <Text style={[styles.message, { color: c.ink3 }]}>
            {type.extensionEditable
              ? 'The extension is yours to change, like renaming a file on your Mac. It stays plain text.'
              : 'Markdown notes keep .md, so they open formatted everywhere.'}
          </Text>
        )}

        {type.extensionEditable ? (
          <View style={styles.chips}>
            {TEXT_EXTENSION_SUGGESTIONS.map((ext) => {
              const on = normalizeExtension(draft.ext) === ext;
              return (
                <Pressable
                  key={ext}
                  onPress={() => setDraft({ ext })}
                  disabled={creating}
                  style={[styles.chip, { borderColor: on ? c.amber : c.line2 }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Use .${ext}`}
                  testID={`new-file-ext-chip-${ext}`}
                >
                  <Text style={[styles.chipText, { color: on ? (dark ? c.amber : '#8A5A00') : c.ink2 }]}>.{ext}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={[styles.kv, { borderTopColor: c.line }]}>
          <Text style={[styles.kvKey, { color: c.ink3 }]}>Saves to</Text>
          <Text style={[styles.kvVal, { color: c.ink }]} numberOfLines={1}>
            {folderLabel}
          </Text>
        </View>

        <Pressable
          onPress={() => void submit()}
          disabled={!canCreate}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: c.amber, opacity: !canCreate ? 0.5 : pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={type.createLabel}
          accessibilityState={{ disabled: !canCreate, busy: creating }}
          testID="new-file-create"
        >
          <Text style={[styles.ctaText, { color: '#1F1D19' }]}>{creating ? 'Encrypting…' : type.createLabel}</Text>
        </Pressable>
      </>
    ) : null;

  return (
    <Modal
      visible={modalMounted}
      animationType="none"
      transparent
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <GestureHandlerRootView style={styles.fill}>
        <BottomSheet
          visible={visible}
          onRequestClose={requestClose}
          onDismissed={() => setModalMounted(false)}
          detents={['half', 'default']}
          initialDetent="half"
          avoidKeyboard
          header={header}
          contentStyle={styles.content}
          handleAccessibilityLabel="New file sheet"
          scrimAccessibilityLabel="Close new file"
          testID="new-file-sheet"
        >
          <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollBody}>
            {step.kind === 'types' ? typesBody : nameBody}
          </BottomSheetScrollView>
        </BottomSheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: SIDE },
  scrollBody: { paddingBottom: 16 },
  headerBlock: { paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: '600', letterSpacing: -0.4 },
  lockLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  lockText: { fontFamily: fonts.mono, fontSize: 11.5 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 10, alignSelf: 'flex-start' },
  backText: { fontSize: 14 },
  sectionLabel: { fontFamily: MONO_MEDIUM, fontSize: 10.5, letterSpacing: 1.3, marginTop: 16, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: COL_GAP, rowGap: 16 },
  tile: { alignItems: 'center' },
  well: { alignItems: 'center', justifyContent: 'center' },
  tileName: { fontSize: 12, marginTop: 7, textAlign: 'center' },
  soon: { fontFamily: MONO_MEDIUM, fontSize: 9.5, letterSpacing: 0.8, marginTop: 2 },
  field: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1.5,
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 10,
  },
  baseInput: { flex: 1, fontSize: 17, fontWeight: '500', paddingHorizontal: 14, paddingVertical: 13 },
  extSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    paddingLeft: 10,
    paddingRight: 12,
    minWidth: 76,
  },
  extDot: { fontFamily: fonts.mono, fontSize: 15 },
  extInput: { fontFamily: fonts.mono, fontSize: 15, minWidth: 44, paddingVertical: 13 },
  fixedExt: { fontFamily: fonts.mono, fontSize: 15, alignSelf: 'center', paddingRight: 14 },
  message: { fontSize: 13, lineHeight: 18, marginTop: 8, marginBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 12 },
  chip: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 11, paddingVertical: 6 },
  chipText: { fontFamily: fonts.mono, fontSize: 13 },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 11,
    gap: 12,
  },
  kvKey: { fontSize: 14 },
  kvVal: { fontSize: 14, flexShrink: 1 },
  cta: { marginTop: 8, borderRadius: 99, paddingVertical: 14, alignItems: 'center' },
  ctaText: { fontSize: 16, fontWeight: '600' },
});
