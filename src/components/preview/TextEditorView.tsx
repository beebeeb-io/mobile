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
 *   engine (CodeMirror/Monaco) underneath it. Task 1575 (build 217 fix)
 *   found this drift gets much worse than "drift" on a real long file: past
 *   the gutter's own (un-wrapped, therefore too-short) content height, the
 *   raw scroll offset pushes EVERY number off the top of the clipped
 *   viewport at once — a fully blank gutter, not just misaligned ones.
 *   `clampGutterOffset` (lib/text-editor-inset.ts) caps the gutter's own
 *   transform at its own content bounds so it stays visible (pinned at its
 *   last line) instead of vanishing — the drift limitation itself is
 *   unchanged and still needs the full text-layout engine to fix properly.
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
import { clampGutterOffset, computeEditorContentPadding } from '../../lib/text-editor-inset';

const ACCESSORY_ID = 'beebeeb-editor-accessory';
const LINE_HEIGHT = 19.2;
const FONT_SIZE = 12;

interface TextEditorViewProps {
  initialText: string;
  /** From `detectCodeLanguage` — markdown files get the markdown key group. */
  language: string;
  onChangeText: (text: string) => void;
  /**
   * Preview redesign item 7 (design section 02, "Edit" phone) — Done,
   * "Edited · not saved"/saved status, and Save all moved to PreviewScreen's
   * OWN edit-mode top bar, which is never covered by the keyboard (it's
   * pinned above it, unlike this component's old internal Save row — see
   * the removed `statusBar`'s history below). This view is now just the
   * text area + the key row above the keyboard; dirty/save state lives one
   * level up.
   *
   * Extra bottom clearance so the last line of text can scroll clear of the
   * home indicator / safe-area bottom, now that there's no bottom bar of
   * any kind while editing (item 7).
   */
  bottomInset?: number;
  /**
   * Build 217 bug fix — the floating Done/title/Save bar's own real height
   * (from `computePreviewContentInset(...).top` at the call site, the SAME
   * value CodeRenderer's read-only sibling already uses via its own
   * `topInset` prop). Before this fix, edit mode passed nothing here: the
   * TextInput and gutter had a bare 12pt top padding with no allowance for
   * the header, so line 1 sat under it and, since the un-padded content was
   * often shorter than the viewport, there was nothing to scroll either.
   * See `computeEditorContentPadding`'s own doc comment for the mechanism.
   */
  topInset?: number;
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
  onChangeText,
  bottomInset = 0,
  topInset = 0,
}: TextEditorViewProps) {
  const isMarkdown = language === 'markdown';
  const [history, setHistory] = useState<EditorHistory>(() =>
    initHistory({ text: initialText, selection: { start: 0, end: 0 } }),
  );
  const selectionRef = useRef(history.present.selection);
  const [gutterOffset, setGutterOffset] = useState(0);
  // Measured real height of `gutterClip` (its own `onLayout`) — the gutter's
  // own visible viewport, needed to clamp `gutterOffset` to the gutter's own
  // content bounds (see `clampGutterOffset`'s doc comment for why).
  const [gutterViewportHeight, setGutterViewportHeight] = useState(0);
  const contentPadding = useMemo(
    () => computeEditorContentPadding(topInset, bottomInset),
    [topInset, bottomInset],
  );

  const lineCount = useMemo(() => history.present.text.split('\n').length, [history.present.text]);
  const totalDigits = Math.max(2, String(lineCount).length);
  const clampedGutterOffset = useMemo(
    () =>
      clampGutterOffset(
        gutterOffset,
        lineCount,
        LINE_HEIGHT,
        contentPadding.paddingTop,
        contentPadding.paddingBottom,
        gutterViewportHeight,
      ),
    [
      gutterOffset,
      lineCount,
      contentPadding.paddingTop,
      contentPadding.paddingBottom,
      gutterViewportHeight,
    ],
  );

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
        <View
          style={[styles.gutterClip, { paddingTop: contentPadding.paddingTop }]}
          pointerEvents="none"
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setGutterViewportHeight((prev) => (prev === h ? prev : h));
          }}
        >
          <View style={[styles.gutterInner, { transform: [{ translateY: -clampedGutterOffset }] }]}>
            {lineNumbers.map((n, i) => (
              <Text key={i} style={styles.gutterLine}>{n}</Text>
            ))}
          </View>
        </View>
        <TextInput
          testID="text-editor-input"
          style={[
            styles.input,
            { paddingTop: contentPadding.paddingTop, paddingBottom: contentPadding.paddingBottom },
          ]}
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
            {/* Preview redesign item 7 — Save now lives in PreviewScreen's
                edit-mode top bar (always above the keyboard, unlike this
                component's old internal Save row it replaced — see this
                prop's own doc comment). This key is now a plain
                dismiss-the-keyboard convenience, same as any text editor's
                "Done" key, not a workaround for reaching a hidden button. */}
            <AccessoryButton onPress={() => Keyboard.dismiss()} accessibilityLabel="Dismiss keyboard">
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
    // paddingTop is set inline from `computeEditorContentPadding` (build 217
    // fix) so it always matches the TextInput's own top padding exactly —
    // see the JSX call site.
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
    // paddingTop/paddingBottom are set inline from
    // `computeEditorContentPadding` (build 217 fix) — see the JSX call site.
    paddingHorizontal: 12,
  },
  // statusBar/dirtyRow/dirtyDot/dirtyLabel/savedLabel/saveButton*: removed
  // (preview redesign item 7 — this component no longer owns Save/status
  // UI; see the `bottomInset` prop's doc comment for where it moved).
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
