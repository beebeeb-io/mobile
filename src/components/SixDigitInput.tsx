/**
 * 6-box one-time-code input.
 *
 * Mirrors the web / admin 2FA pattern: each digit lives in its own visual box,
 * typing auto-advances, backspace on an empty box returns focus + clears the
 * previous digit, pasting a 6-digit string auto-distributes across all six
 * boxes, and `onComplete` fires the instant the sixth digit lands.
 *
 * iOS gives us free SMS / authenticator autofill via `textContentType="oneTimeCode"`
 * on the first box — the OS pastes the whole code into the field as a single
 * `onChangeText` call, which we then split across all six boxes.
 */
import React, { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../lib/theme-context';
import { fonts, radii } from '../theme';

const LENGTH = 6;

export interface SixDigitInputHandle {
  /** Move focus into the first empty box (or the last box if all are filled). */
  focus: () => void;
  /** Clear all six boxes and refocus the first one. */
  clear: () => void;
}

export interface SixDigitInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired the moment the 6th digit lands. Called with the full 6-character string. */
  onComplete: (code: string) => void;
  disabled?: boolean;
  /** Forces a red border around every box (e.g. after a failed verification). */
  invalid?: boolean;
  /** Optional test ID prefix — each box exposes `<testID>-<index>`. */
  testID?: string;
  accessibilityLabel?: string;
}

function sanitize(input: string): string {
  return input.replace(/\D/g, '').slice(0, LENGTH);
}

export const SixDigitInput = React.forwardRef<SixDigitInputHandle, SixDigitInputProps>(
  function SixDigitInput(
    { value, onChange, onComplete, disabled, invalid, testID, accessibilityLabel },
    ref,
  ) {
    const { colors: c } = useTheme();
    const refs = useRef<Array<TextInput | null>>([]);

    const digits = useMemo(() => {
      const padded = sanitize(value).padEnd(LENGTH, ' ');
      return padded.split('').slice(0, LENGTH);
    }, [value]);

    const styles = useMemo(
      () =>
        StyleSheet.create({
          row: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: 8,
          },
          box: {
            flex: 1,
            height: 56,
            borderWidth: 1,
            borderRadius: radii.md,
            borderColor: c.line,
            backgroundColor: c.paper,
            textAlign: 'center',
            fontSize: 22,
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
          const sanitized = sanitize(value);
          const target = Math.min(sanitized.length, LENGTH - 1);
          refs.current[target]?.focus();
        },
        clear: () => {
          onChange('');
          requestAnimationFrame(() => refs.current[0]?.focus());
        },
      }),
      [value, onChange],
    );

    // Auto-focus the first box on mount.
    useEffect(() => {
      const id = setTimeout(() => refs.current[0]?.focus(), 200);
      return () => clearTimeout(id);
    }, []);

    function handleChange(index: number, raw: string) {
      const digitsOnly = sanitize(raw);
      const currentValue = sanitize(value);

      // Multi-digit path (paste, SMS autofill, or iOS OTP autofill into box 0).
      // Distribute across every box starting at `index`, then focus the next
      // empty box (or the last box) and fire `onComplete` if we filled them all.
      if (digitsOnly.length > 1) {
        const slots = currentValue.padEnd(LENGTH, ' ').split('');
        const incoming = digitsOnly.split('');
        for (let i = 0; i < incoming.length && index + i < LENGTH; i++) {
          slots[index + i] = incoming[i]!;
        }
        // Compact prefix: take leading non-space run from box 0.
        let next = '';
        for (let i = 0; i < LENGTH; i++) {
          if (slots[i] === ' ') break;
          next += slots[i];
        }
        onChange(next);
        const lastFilled = Math.min(index + incoming.length, LENGTH) - 1;
        const focusTarget = Math.min(lastFilled + 1, LENGTH - 1);
        requestAnimationFrame(() => refs.current[focusTarget]?.focus());
        if (next.length === LENGTH) onComplete(next);
        return;
      }

      // Single-character path (typed digit) OR deletion (raw === '').
      const slots = currentValue.padEnd(LENGTH, ' ').split('');
      slots[index] = digitsOnly.length === 1 ? digitsOnly : ' ';
      // Compact prefix again.
      let next = '';
      for (let i = 0; i < LENGTH; i++) {
        if (slots[i] === ' ') break;
        next += slots[i];
      }
      onChange(next);

      if (digitsOnly.length === 1) {
        if (index < LENGTH - 1) {
          requestAnimationFrame(() => refs.current[index + 1]?.focus());
        }
        if (next.length === LENGTH) onComplete(next);
      }
    }

    function handleKeyPress(index: number, key: string) {
      if (key !== 'Backspace') return;
      const isEmpty = digits[index] === ' ';
      if (isEmpty && index > 0) {
        // Backspace on an empty box: move focus back AND clear that previous digit.
        const current = sanitize(value).padEnd(LENGTH, ' ').split('');
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
          const isFocusTarget = i === sanitize(value).length;
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
              maxLength={LENGTH}
              editable={!disabled}
              selectTextOnFocus
              autoCorrect={false}
              autoCapitalize="none"
              // Only the first box advertises one-time-code so iOS' keyboard
              // suggestion strip fills the whole sequence into one onChangeText
              // call — we then distribute across boxes in handleChange.
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

export const SIX_DIGIT_LENGTH = LENGTH;
