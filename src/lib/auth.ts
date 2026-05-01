import { createContext, useContext } from 'react';
import type { User } from './api';

export interface AuthContextValue {
  user: User | null;
  /** Call after successful login/signup to refresh auth state. */
  refreshAuth: () => Promise<void>;
  /** Sign out — clears token and resets state. */
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  refreshAuth: async () => {},
  signOut: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
