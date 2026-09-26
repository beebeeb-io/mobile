/**
 * TextEditorView — native multiline text/markdown/code editor.
 *
 * Task 1563, Guus's ruling (2026-09-26 18:50): "at edit its just regular
 * like now" — so this deliberately matches CodeRenderer.tsx's existing dark
 * monospace look (same background `#282c34`, same gutter styling) rather
 * than inventing a new editor chrome, with the source shown as PLAIN
 * editable text (see "What shipped" below).
 *
 * What shipped vs. deferred (say-which-you-shipped, per the task brief):
 * - Line numbers: YES, synced to the TextInput's own scroll via `onScroll`.
 *   Known limitation: RN's multiline TextInput always soft-wraps, and a
 *   wrapped (very long) line will drift the gutter's 1-number-per-line
 *   assumption below that point — acceptable for a first step; the same
 *   limitation any single-column gutter has without a full text-layout
 *   engine (CodeMirror/Monaco) underneath it.
 * - Live per-token syntax colouring while typing: NOT shipped — keeping a
 *   colour overlay pixel-aligned with a live-editing native TextInput
 *   (cursor, IME, autocorrect, selection) needs a measured-per-character
 *   layout engine RN doesn't give you for free; attempting it under this
 *   task's time budget would have shipped an unreliable visual, not a
 *   working one. Plain monospace editing instead — exactly what the brief
 *   allows as the first step.
 * - Undo/redo: a JS-side history stack (`lib/editor-key-actions.ts`), since
 *   RN's TextInput has no JS-callable native undo to hook a custom toolbar
 *   button into.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputSelectionChangeEventData,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../../theme';
import {
  applyAccessoryKey,
  canRedo,
  canUndo,
  initHistory,
  pushHistory,
  redo,
  undo,
  type AccessoryKey,
  type EditorHistory,
} from '../../lib/editor-key-actions';

const ACCESSORY_ID = 'beebeeb-editor-accessory';
const LINE_HEIGHT = 19.2;
const FONT_SIZE = 12;

interface TextEditorViewProps {
  initialText: string;
  /** From `detectCodeLanguage` — markdown files get the markdown key group. */
  language: string;
  dirty: boolean;
  saving: boolean;
  statusLine: string | null;
  onChangeText: (text: string) => void;
  onSave: () => void;
  /**
   * Extra bottom clearance so the (non-scrolling, tappable) Save bar never
   * sits under the always-present `DetailsSheet` collapsed peek — same
   * `Math.max(insets.bottom, 16) + 40` PreviewScreen already uses for its
   * own e2e badge, for exactly this reason. Confirmed needed on-device
   * (bb-ios27): without it the status bar rendered flush against the
   * screen bottom, right under the peek's peek row.
   */
  bottomInset?: number;
}

function AccessoryButton({
  onPress,
  disabled,
  children,
  accessibilityLabel,
}: {
  onPress: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  accessibilityLabel: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.accKey, disabled ? styles.accKeyDisabled : null]}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
    >
      {children}
    </TouchableOpacity>
  );
}

export function TextEditorView({
  initialText,
  language,
  dirty,
  saving,
  statusLine,
  onChangeText,
  onSave,
  bottomInset = 0,
}: TextEditorViewProps) {
  const isMarkdown = language === 'markdown';
  const [history, setHistory] = useState<EditorHistory>(() =>
    initHistory({ text: initialText, selection: { start: 0, end: 0 } }),
  );
  const selectionRef = useRef(history.present.selection);
  const [gutterOffset, setGutterOffset] = useState(0);

  const lineCount = useMemo(() => history.present.text.split('\n').length, [history.present.text]);
  const totalDigits = Math.max(2, String(lineCount).length);

  const applyEdit = useCallback(
    (next: { text: string; selection: { start: number; end: number } }) => {
      setHistory((h) => pushHistory(h, next));
      selectionRef.current = next.selection;
      onChangeText(next.text);
    },
    [onChangeText],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      // A plain typed edit — selection follows the caret; RN reports the new
      // selection via a separate onSelectionChange right after this fires,
      // so keep the CURRENT ref position as a same-length best guess until
      // that lands (avoids briefly showing a stale, too-far-left cursor).
      const delta = text.length - history.present.text.length;
      const approxPos = Math.max(0, selectionRef.current.end + delta);
      applyEdit({ text, selection: { start: approxPos, end: approxPos } });
    },
    [applyEdit, history.present.text.length],
  );

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = e.nativeEvent.selection;
    },
    [],
  );

  const runKey = useCallback(
    (key: AccessoryKey) => {
      const edit = applyAccessoryKey(history.present.text, selectionRef.current, key);
      applyEdit(edit);
    },
    [applyEdit, history.present.text],
  );

  const handleUndo = useCallback(() => {
    setHistory((h) => {
      const next = undo(h);
      selectionRef.current = next.present.selection;
      onChangeText(next.present.text);
      return next;
    });
  }, [onChangeText]);

  const handleRedo = useCallback(() => {
    setHistory((h) => {
      const next = redo(h);
      selectionRef.current = next.present.selection;
      onChangeText(next.present.text);
      return next;
    });
  }, [onChangeText]);

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      setGutterOffset(e.nativeEvent.contentOffset.y);
    },
    [],
  );

  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => String(i + 1).padStart(totalDigits, ' ')),
    [lineCount, totalDigits],
  );

  return (
    // Task 1563 — without keyboard avoidance the Save bar (a fixed, tappable
    // row BELOW the scrollable text area, not part of the InputAccessoryView)
    // sat behind the keyboard the instant it appeared, confirmed on-device
    // (bb-ios27): typing was fine, but Save was invisible AND untappable
    // until the keyboard was dismissed some other way. `behavior="padding"`
    // is the standard iOS fix — it shrinks this column by the keyboard's
    // height instead of letting the keyboard overlay it.
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.body}>
        <View style={styles.gutterClip} pointerEvents="none">
          <View style={[styles.gutterInner, { transform: [{ translateY: -gutterOffset }] }]}>
            {lineNumbers.map((n, i) => (
              <Text key={i} style={styles.gutterLine}>{n}</Text>
            ))}
          </View>
        </View>
        <TextInput
          testID="text-editor-input"
          style={styles.input}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          value={history.present.text}
          onChangeText={handleChangeText}
          onSelectionChange={handleSelectionChange}
          onScroll={handleScroll}
          inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
          textAlignVertical="top"
          accessibilityLabel="File contents editor"
        />
      </View>

      <View style={[styles.statusBar, { paddingBottom: 10 + bottomInset }]}>
        {dirty ? (
          <View style={styles.dirtyRow}>
            <View style={styles.dirtyDot} />
            <Text style={styles.dirtyLabel}>Unsaved changes</Text>
          </View>
        ) : statusLine ? (
          <Text style={styles.savedLabel}>{statusLine}</Text>
        ) : (
          <Text style={styles.savedLabel}>No changes yet</Text>
        )}
        <TouchableOpacity
          testID="text-editor-save"
          onPress={onSave}
          disabled={!dirty || saving}
          style={[styles.saveButton, (!dirty || saving) ? styles.saveButtonDisabled : null]}
          accessibilityRole="button"
          accessibilityLabel="Save"
        >
          <Text style={styles.saveButtonLabel}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>
      </View>

      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={ACCESSORY_ID} backgroundColor="#21262d">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.accessoryBar}
          >
            <AccessoryButton onPress={() => runKey('tab')} accessibilityLabel="Insert tab">
              <Text style={styles.accKeyLabel}>{'⇥'}</Text>
            </AccessoryButton>
            <AccessoryButton onPress={() => runKey('brace')} accessibilityLabel="Insert curly braces">
              <Text style={styles.accKeyLabel}>{'{ }'}</Text>
            </AccessoryButton>
            <AccessoryButton onPress={() => runKey('bracket')} accessibilityLabel="Insert square brackets">
              <Text style={styles.accKeyLabel}>{'[ ]'}</Text>
            </AccessoryButton>
            <AccessoryButton onPress={() => runKey('paren')} accessibilityLabel="Insert parentheses">
              <Text style={styles.accKeyLabel}>{'( )'}</Text>
            </AccessoryButton>
            <View style={styles.accSep} />
            <AccessoryButton onPress={handleUndo} disabled={!canUndo(history)} accessibilityLabel="Undo">
              <Ionicons name="arrow-undo" size={17} color={canUndo(history) ? '#c9d1d9' : '#4b5263'} />
            </AccessoryButton>
            <AccessoryButton onPress={handleRedo} disabled={!canRedo(history)} accessibilityLabel="Redo">
              <Ionicons name="arrow-redo" size={17} color={canRedo(history) ? '#c9d1d9' : '#4b5263'} />
            </AccessoryButton>
            {isMarkdown && (
              <>
                <View style={styles.accSep} />
                <AccessoryButton onPress={() => runKey('heading')} accessibilityLabel="Insert heading">
                  <Text style={styles.accKeyLabelMd}>H</Text>
                </AccessoryButton>
                <AccessoryButton onPress={() => runKey('bullet')} accessibilityLabel="Insert bullet">
                  <Text style={styles.accKeyLabelMd}>{'•'}</Text>
                </AccessoryButton>
                <AccessoryButton onPress={() => runKey('link')} accessibilityLabel="Insert link">
                  <Ionicons name="link" size={16} color="#f5b800" />
                </AccessoryButton>
                <AccessoryButton onPress={() => runKey('backtick')} accessibilityLabel="Insert inline code">
                  <Text style={styles.accKeyLabelMd}>{'`'}</Text>
                </AccessoryButton>
              </>
            )}
            <View style={styles.accSep} />
            {/* Task 1563 — the Save bar below sits BELOW the keyboard/accessory
                view (no reliable way to keep a separate fixed row above an
                InputAccessoryView-paired keyboard on iOS; KeyboardAvoidingView
                does not resize this column while an inputAccessoryViewID is
                attached — confirmed on-device, bb-ios27). "Done" dismisses
                the keyboard so the status bar's own Save button becomes
                reachable, without losing the draft (still in-memory state). */}
            <AccessoryButton onPress={() => Keyboard.dismiss()} accessibilityLabel="Done editing, show keyboard">
              <Text style={styles.accKeyLabelMd}>Done</Text>
            </AccessoryButton>
          </ScrollView>
        </InputAccessoryView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#282c34',
  },
  body: {
    flex: 1,
    flexDirection: 'row',
  },
  gutterClip: {
    width: 34,
    overflow: 'hidden',
    paddingTop: 12,
    backgroundColor: '#282c34',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#3a3f4b',
  },
  gutterInner: {
    paddingTop: 0,
  },
  gutterLine: {
    color: '#4b5263',
    textAlign: 'right',
    paddingRight: 8,
    fontFamily: fonts.mono,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
  },
  input: {
    flex: 1,
    color: '#abb2bf',
    fontFamily: fonts.mono,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    paddingTop: 12,
    paddingHorizontal: 12,
    paddingBottom: 32,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3a3f4b',
    backgroundColor: '#21262d',
  },
  dirtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f5b800',
    marginRight: 6,
  },
  dirtyLabel: {
    color: '#8b949e',
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  savedLabel: {
    color: '#8b949e',
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  saveButton: {
    backgroundColor: '#f5b800',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  saveButtonDisabled: {
    backgroundColor: '#4b5263',
  },
  saveButtonLabel: {
    color: '#1e1e22',
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '700',
  },
  accessoryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
  },
  accKey: {
    minWidth: 36,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#30363d',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  accKeyDisabled: {
    opacity: 0.4,
  },
  accKeyLabel: {
    color: '#c9d1d9',
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  accKeyLabelMd: {
    color: '#f5b800',
    fontFamily: fonts.mono,
    fontSize: 15,
    fontWeight: '700',
  },
  accSep: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: '#484f58',
    marginHorizontal: 4,
  },
});
