/**
 * Configurable-length one-time-code box input (task 1551).
 *
 * Adapted from `SixDigitInput.tsx` (the existing 2FA input) with `length` as
 * a prop instead of a hardcoded module constant, so the signup email-code
 * step (8 digits, task 1525's widened code) can reuse the same box-per-digit
 * UX without touching `SixDigitInput` itself — that component backs the
 * live 2FA flow and this lane has no simulator/Maestro access to verify a
 * shared-component change against it, so it stays byte-for-byte untouched.
 * A follow-up could unify the two behind one parametrized component; flagged
 * here rather than done silently (see task 1551 Notes).
 *
 * Same behavior as SixDigitInput: each digit lives in its own visual box,
 * typing auto-advances, backspace on an empty box returns focus + clears the
 * previous digit, pasting an N-digit string auto-distributes across all N
 * boxes, and `onComplete` fires the instant the last digit lands. iOS gives
 * free autofill via `textContentType="oneTimeCode"` on the first box — the
 * OS pastes the whole code into the field as a single `onChangeText` call,
 * distributed across boxes in `handleChange`.
 */
import React, { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../lib/theme-context';
import { fonts, radii } from '../theme';

function sanitize(input: string, length: number): string {
  return input.replace(/\D/g, '').slice(0, length);
}

export interface DigitCodeInputHandle {
  /** Move focus into the first empty box (or the last box if all are filled). */
  focus: () => void;
  /** Clear all boxes and refocus the first one. */
  clear: () => void;
}

export interface DigitCodeInputProps {
  length: number;
  value: string;
  onChange: (next: string) => void;
  /** Fired the moment the last digit lands. Called with the full code string. */
  onComplete: (code: string) => void;
  disabled?: boolean;
  /** Forces a red border around every box (e.g. after a failed verification). */
  invalid?: boolean;
  /** Optional test ID prefix — each box exposes `<testID>-<index>`. */
  testID?: string;
  accessibilityLabel?: string;
}

export const DigitCodeInput = React.forwardRef<DigitCodeInputHandle, DigitCodeInputProps>(
  function DigitCodeInput(
    { length, value, onChange, onComplete, disabled, invalid, testID, accessibilityLabel },
    ref,
  ) {
    const { colors: c } = useTheme();
    const refs = useRef<Array<TextInput | null>>([]);

    const digits = useMemo(() => {
      const padded = sanitize(value, length).padEnd(length, ' ');
      return padded.split('').slice(0, length);
    }, [value, length]);

    const styles = useMemo(
      () =>
        StyleSheet.create({
          row: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: 6,
          },
          box: {
            flexGrow: 1,
            flexBasis: 32,
            height: 48,
            borderWidth: 1,
            borderRadius: radii.md,
            borderColor: c.line,
            backgroundColor: c.paper,
            textAlign: 'center',
            fontSize: 18,
            fontWeight: '600',
            color: c.ink,
            fontFamily: fonts.mono,
            paddingHorizontal: 0,
            paddingVertical: 0,
          },
          boxFilled: {
            borderColor: c.line2,
          },
          boxFocus: {
            borderColor: c.amberDeep,
          },
          boxInvalid: {
            borderColor: c.red,
          },
          boxDisabled: {
            opacity: 0.6,
          },
        }),
      [c],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const sanitized = sanitize(value, length);
          const target = Math.min(sanitized.length, length - 1);
          refs.current[target]?.focus();
        },
        clear: () => {
          onChange('');
          requestAnimationFrame(() => refs.current[0]?.focus());
        },
      }),
      [value, length, onChange],
    );

    // Auto-focus the first box on mount.
    useEffect(() => {
      const id = setTimeout(() => refs.current[0]?.focus(), 200);
      return () => clearTimeout(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function handleChange(index: number, raw: string) {
      const digitsOnly = sanitize(raw, length);
      const currentValue = sanitize(value, length);

      // Multi-digit path (paste, or iOS OTP autofill into box 0). Distribute
      // across every box starting at `index`, then focus the next empty box
      // (or the last box) and fire `onComplete` if we filled them all.
      if (digitsOnly.length > 1) {
        const slots = currentValue.padEnd(length, ' ').split('');
        const incoming = digitsOnly.split('');
        for (let i = 0; i < incoming.length && index + i < length; i++) {
          slots[index + i] = incoming[i]!;
        }
        let next = '';
        for (let i = 0; i < length; i++) {
          if (slots[i] === ' ') break;
          next += slots[i];
        }
        onChange(next);
        const lastFilled = Math.min(index + incoming.length, length) - 1;
        const focusTarget = Math.min(lastFilled + 1, length - 1);
        requestAnimationFrame(() => refs.current[focusTarget]?.focus());
        if (next.length === length) onComplete(next);
        return;
      }

      // Single-character path (typed digit) OR deletion (raw === '').
      const slots = currentValue.padEnd(length, ' ').split('');
      slots[index] = digitsOnly.length === 1 ? digitsOnly : ' ';
      let next = '';
      for (let i = 0; i < length; i++) {
        if (slots[i] === ' ') break;
        next += slots[i];
      }
      onChange(next);

      if (digitsOnly.length === 1) {
        if (index < length - 1) {
          requestAnimationFrame(() => refs.current[index + 1]?.focus());
        }
        if (next.length === length) onComplete(next);
      }
    }

    function handleKeyPress(index: number, key: string) {
      if (key !== 'Backspace') return;
      const isEmpty = digits[index] === ' ';
      if (isEmpty && index > 0) {
        const current = sanitize(value, length).padEnd(length, ' ').split('');
        current[index - 1] = ' ';
        const next = current.join('').split(' ')[0]!;
        onChange(next);
        requestAnimationFrame(() => refs.current[index - 1]?.focus());
      }
    }

    return (
      <View style={styles.row} accessibilityLabel={accessibilityLabel}>
        {digits.map((d, i) => {
          const trimmed = d.trim();
          const filled = trimmed.length > 0;
          const isFocusTarget = i === sanitize(value, length).length;
          return (
            <TextInput
              key={i}
              ref={(node) => {
                refs.current[i] = node;
              }}
              style={[
                styles.box,
                filled && styles.boxFilled,
                !filled && isFocusTarget && styles.boxFocus,
                invalid && styles.boxInvalid,
                disabled && styles.boxDisabled,
              ]}
              value={trimmed}
              onChangeText={(t) => handleChange(i, t)}
              onKeyPress={(e) => handleKeyPress(i, e.nativeEvent.key)}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={length}
              editable={!disabled}
              selectTextOnFocus
              autoCorrect={false}
              autoCapitalize="none"
              // Only the first box advertises one-time-code so iOS' keyboard
              // suggestion strip fills the whole sequence into one
              // onChangeText call — distributed across boxes in handleChange.
              textContentType={i === 0 ? 'oneTimeCode' : 'none'}
              autoComplete={i === 0 ? (Platform.OS === 'android' ? 'sms-otp' : 'one-time-code') : 'off'}
              testID={testID ? `${testID}-${i}` : undefined}
              accessibilityLabel={`Digit ${i + 1}`}
            />
          );
        })}
      </View>
    );
  },
);
