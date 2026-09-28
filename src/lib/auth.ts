import { createContext, useContext } from 'react';
import type { User } from './api';

export interface AuthContextValue {
  user: User | null;
  /** Call after a successful login to refresh auth state. */
  refreshAuth: () => Promise<void>;
  /** Sign out — clears token and resets state. */
  signOut: () => Promise<void>;
  /**
   * True once the user has verified their recovery phrase (or for legacy users
   * who pre-date the phrase flow). Persisted in SecureStore across restarts.
   */
  phraseVerified: boolean;
  /** Called after the user successfully enters all verification words. */
  markPhraseVerified: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  refreshAuth: async () => {},
  signOut: async () => {},
  phraseVerified: true,
  markPhraseVerified: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
