import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import ToastOverlay from '../components/Toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  showToast: (opts: { type: ToastType; message: string }) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ToastMessage | null>(null);
  const queue = useRef<ToastMessage[]>([]);
  const isShowing = useRef(false);

  const showNext = useCallback(() => {
    const next = queue.current.shift();
    if (next) {
      setCurrent(next);
      isShowing.current = true;
    } else {
      setCurrent(null);
      isShowing.current = false;
    }
  }, []);

  const showToast = useCallback(({ type, message }: { type: ToastType; message: string }) => {
    const msg: ToastMessage = { id: ++nextId, type, message };
    if (isShowing.current) {
      queue.current.push(msg);
    } else {
      setCurrent(msg);
      isShowing.current = true;
    }
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {current && (
        <ToastOverlay key={current.id} toast={current} onDismiss={showNext} />
      )}
    </ToastContext.Provider>
  );
}
