/**
 * Announcement context — reads server-sent banners from the
 * `X-Beebeeb-Announcement` response header and surfaces them app-wide.
 *
 * The interceptor in api.ts calls `setAnnouncement` / `clearAnnouncement`
 * on every API response. The banner auto-hides when the server stops
 * sending the header, and the user can dismiss a specific announcement
 * (but a *new* announcement will re-appear).
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface AnnouncementContextValue {
  /** Current announcement text, or null when there is nothing to show. */
  announcement: string | null;
  /** Dismiss the current announcement. A new, different announcement will re-show. */
  dismiss: () => void;
}

const AnnouncementContext = createContext<AnnouncementContextValue>({
  announcement: null,
  dismiss: () => {},
});

export function useAnnouncement(): AnnouncementContextValue {
  return useContext(AnnouncementContext);
}

// ---------------------------------------------------------------------------
// Module-level store — api.ts writes here, the provider reads
// ---------------------------------------------------------------------------

type Listener = (text: string | null) => void;
let listener: Listener | null = null;

/** Called by the API response interceptor when the header is present. */
export function setAnnouncement(text: string): void {
  listener?.(text);
}

/** Called by the API response interceptor when the header is absent. */
export function clearAnnouncement(): void {
  listener?.(null);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AnnouncementProvider({ children }: { children: React.ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const dismissedRef = useRef<string | null>(null);

  // Subscribe to module-level updates from the API interceptor.
  // Using a ref-backed listener avoids re-renders when the value hasn't changed.
  const handleUpdate = useCallback((incoming: string | null) => {
    if (incoming === null) {
      setText(null);
      return;
    }
    setText(incoming);
    // If this is a different announcement than what was dismissed, reset dismissed state
    if (dismissedRef.current !== incoming) {
      dismissedRef.current = null;
    }
  }, []);

  // Register the listener once. React strict mode double-mounts are fine:
  // only the latest provider instance will own the listener.
  React.useEffect(() => {
    listener = handleUpdate;
    return () => {
      if (listener === handleUpdate) listener = null;
    };
  }, [handleUpdate]);

  const dismiss = useCallback(() => {
    dismissedRef.current = text;
    setText(null);
  }, [text]);

  // If the user dismissed this exact text, hide it even though `text` is set.
  const visible = text !== null && dismissedRef.current !== text ? text : null;

  const value = useMemo(
    () => ({ announcement: visible, dismiss }),
    [visible, dismiss],
  );

  return (
    <AnnouncementContext.Provider value={value}>
      {children}
    </AnnouncementContext.Provider>
  );
}
