/**
 * The pre-account onboarding document for the signed-out screens (task 1746):
 * Welcome and Login ask it one question, "can this binary create an account
 * natively right now?". Every failure is the legacy answer "no" (spec 5.8 rule 6):
 * the existing "create your account on the web" line stays.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOnboardingRaw } from '../api';
import { fetchOnboardingDocument } from './client';
import type { PreAccountState } from './pre-account';

export function usePreAccountDocument(): { state: PreAccountState; reload: () => void } {
  const [state, setState] = useState<PreAccountState>({ status: 'loading' });
  const mounted = useRef(true);
  const run = useRef(0);

  const reload = useCallback(() => {
    const id = ++run.current;
    setState({ status: 'loading' });
    void fetchOnboardingDocument(fetchOnboardingRaw, false).then((out) => {
      if (!mounted.current || id !== run.current) return;
      if (out.kind === 'document') setState({ status: 'document', doc: out.doc });
      else if (out.kind === 'unsupported_schema') setState({ status: 'unsupported_schema' });
      else setState({ status: 'legacy', reason: out.reason });
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return { state, reload };
}
