/**
 * AccountStateProvider (task 1037). Reads `account_state` from
 * `GET /api/v1/billing/subscription` for the signed-in account and shares it
 * with:
 *  - `NeedsPlanOverlay`, which blocks the file UI for `needs_plan`;
 *  - FilesScreen, which shows the lapsed banner and a read-only message
 *    instead of starting an upload;
 *  - BackupProvider, which keeps the native backup engines off while uploads
 *    are refused, so it does not retry uploads the server will reject.
 *
 * The value is re-read when the app returns to the foreground (at most once
 * per `FOREGROUND_REFRESH_MS`), when an upload is refused for quota
 * (`requestAccountStateRefresh`), and when the user taps Refresh on the
 * needs_plan screen.
 *
 * A failed fetch keeps the last known gate. On first load that is `ok`: a
 * network error must never lock anyone out, and the server enforces the
 * quota either way.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getSubscription, type Subscription } from './api';
import {
  accountGateFor,
  registerAccountStateRefresher,
  setCurrentAccountGate,
  type AccountGate,
} from './account-state';

const FOREGROUND_REFRESH_MS = 60_000;

export interface AccountStateValue {
  /** False until the first fetch for this account has settled. */
  ready: boolean;
  gate: AccountGate;
  /** Last subscription payload read, or null when unknown. */
  subscription: Subscription | null;
  /** Re-read the account state now. Resolves with the resulting gate. */
  refresh: () => Promise<AccountGate>;
}

const OK_GATE: AccountGate = { kind: 'ok' };

const AccountStateContext = createContext<AccountStateValue>({
  ready: true,
  gate: OK_GATE,
  subscription: null,
  refresh: async () => OK_GATE,
});

export function AccountStateProvider({
  userId,
  children,
}: {
  /** Signed-in user id, or null when signed out (then the gate is always ok). */
  userId: string | null;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(userId === null);
  const [gate, setGate] = useState<AccountGate>(OK_GATE);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const gateRef = useRef<AccountGate>(OK_GATE);
  const lastFetchAtRef = useRef(0);
  const inflightRef = useRef<Promise<AccountGate> | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<AccountGate> => {
    if (!userId) return OK_GATE;
    if (inflightRef.current) return inflightRef.current;
    const run = (async () => {
      lastFetchAtRef.current = Date.now();
      const sub = await getSubscription();
      if (!mountedRef.current) return gateRef.current;
      if (sub) {
        const next = accountGateFor(sub);
        gateRef.current = next;
        setCurrentAccountGate(next);
        setGate(next);
        setSubscription(sub);
      }
      setReady(true);
      return gateRef.current;
    })();
    inflightRef.current = run;
    try {
      return await run;
    } finally {
      inflightRef.current = null;
    }
  }, [userId]);

  useEffect(() => {
    mountedRef.current = true;
    setCurrentAccountGate(OK_GATE);
    if (userId) void refresh();
    const unregister = registerAccountStateRefresher(() => { void refresh(); });
    return () => {
      mountedRef.current = false;
      unregister();
      // Signed out or switched account: the next account starts from ok.
      setCurrentAccountGate(OK_GATE);
    };
  }, [refresh, userId]);

  useEffect(() => {
    if (!userId) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (Date.now() - lastFetchAtRef.current < FOREGROUND_REFRESH_MS) return;
      void refresh();
    });
    return () => sub.remove();
  }, [refresh, userId]);

  const value = useMemo<AccountStateValue>(
    () => ({ ready, gate, subscription, refresh }),
    [ready, gate, subscription, refresh],
  );

  return <AccountStateContext.Provider value={value}>{children}</AccountStateContext.Provider>;
}

export function useAccountState(): AccountStateValue {
  return useContext(AccountStateContext);
}
