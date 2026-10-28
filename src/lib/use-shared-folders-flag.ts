import { useEffect, useState } from 'react';
import { getEvaluateFlags } from './api';
import { accountEpoch, isCurrentAccountEpoch, onAccountEpochAdvance, sameAccountEpoch, type AccountEpoch } from './account-epoch';

let cached: { epoch: AccountEpoch; result: Promise<boolean> } | null = null;
onAccountEpochAdvance(() => { cached = null; });
/** Coalesce evaluation once per account epoch; a late result cannot enable another account. */
export function loadSharedFoldersFlag(): Promise<boolean> {
  const epoch = accountEpoch();
  if (cached && sameAccountEpoch(cached.epoch, epoch)) return cached.result;
  const result = getEvaluateFlags().then(
    data => isCurrentAccountEpoch(epoch) && data.flags?.shared_folders_v1 === true,
    () => false,
  );
  cached = { epoch, result };
  return result;
}
export function useSharedFoldersFlag(): { enabled: boolean; loading: boolean } {
  const [state, setState] = useState({ enabled: false, loading: true });
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const load = () => {
      cancel?.();
      let active = true;
      setState({ enabled: false, loading: true });
      // Fail closed after three seconds, including an unresponsive old server.
      const timer = setTimeout(() => { active = false; setState({ enabled: false, loading: false }); }, 3000);
      void loadSharedFoldersFlag().then(enabled => {
        if (active) { clearTimeout(timer); setState({ enabled, loading: false }); }
      });
      cancel = () => { active = false; clearTimeout(timer); };
    };
    load();
    const unsubscribe = onAccountEpochAdvance(load);
    return () => { cancel?.(); unsubscribe(); };
  }, []);
  return state;
}
