import { createContext, useContext } from 'react';
import type { User } from './api';

export interface AuthContextValue {
  user: User | null;
  /** Call after successful login/signup to refresh auth state. */
  refreshAuth: () => Promise<void>;
  /** Sign out — clears token and resets state. */
  signOut: () => Promise<void>;
  /**
   * True once the user has verified their recovery phrase (or for legacy users
   * who pre-date the phrase flow). Persisted in SecureStore across restarts.
   */
  phraseVerified: boolean;
  /**
   * Called when OPAQUE registration succeeds and the user is about to enter the
   * recovery-phrase flow. Marks phrase as pending (gates upload) and dismisses
   * the onboarding welcome overlay so it doesn't cover the phrase screens.
   */
  skipOnboarding: () => void;
  /** Called after the user successfully enters all verification words. */
  markPhraseVerified: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  refreshAuth: async () => {},
  signOut: async () => {},
  phraseVerified: true,
  skipOnboarding: () => {},
  markPhraseVerified: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
