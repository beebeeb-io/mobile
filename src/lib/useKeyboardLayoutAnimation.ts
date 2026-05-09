import { useEffect } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

export function useKeyboardLayoutAnimation() {
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;

    const schedule = (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
    };

    const show = Keyboard.addListener('keyboardWillShow', schedule);
    const hide = Keyboard.addListener('keyboardWillHide', schedule);

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
}
