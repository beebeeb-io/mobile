import { useCallback } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

interface FilesBackState {
  selecting: boolean;
  searching: boolean;
  folderDepth: number;
  exitSelection: () => void;
  closeSearch: () => void;
  goToParent: () => void;
}

/** Keep Android Back inside the focused file browser until it reaches its root. */
export function useAndroidFilesBack(state: FilesBackState): void {
  const { selecting, searching, folderDepth, exitSelection, closeSearch, goToParent } = state;
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selecting) {
        exitSelection();
        return true;
      }
      if (searching) {
        closeSearch();
        return true;
      }
      if (folderDepth > 1) {
        goToParent();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [selecting, searching, folderDepth, exitSelection, closeSearch, goToParent]));
}
