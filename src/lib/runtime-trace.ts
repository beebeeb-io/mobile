import { logDiagnostic } from '../../modules/beebeeb-crypto';

type TraceFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TraceFieldValue[]
  | { [key: string]: TraceFieldValue };

export interface RuntimeTraceEvent {
  seq: number;
  at: string;
  uptimeMs: number;
  name: string;
  fields: Record<string, TraceFieldValue>;
}

const MAX_EVENTS = 1500;
const bootTimeMs = Date.now();
let sequence = 0;
const events: RuntimeTraceEvent[] = [];

function traceEnabled(): boolean {
  const globalFlag = (globalThis as typeof globalThis & {
    __BEEBEEB_RUNTIME_TRACE__?: boolean;
  }).__BEEBEEB_RUNTIME_TRACE__;
  return __DEV__ || globalFlag === true || process.env.EXPO_PUBLIC_BEEBEEB_RUNTIME_TRACE === '1';
}

function sanitizeValue(key: string, value: unknown, depth = 0): TraceFieldValue {
  if (value == null) return value as null | undefined;
  const lowerKey = key.toLowerCase();
  if (
    lowerKey.includes('token') ||
    lowerKey.includes('password') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('keybytes') ||
    lowerKey.includes('masterkey') ||
    lowerKey.includes('ciphertext') ||
    lowerKey.includes('plaintext')
  ) {
    return '[redacted]';
  }
  if (value instanceof Uint8Array) return `[bytes:${value.byteLength}]`;
  if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`;
    return value.slice(0, 20).map((item, index) => sanitizeValue(String(index), item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '[object]';
    const out: Record<string, TraceFieldValue> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[childKey] = sanitizeValue(childKey, childValue, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeFields(fields: Record<string, unknown> = {}): Record<string, TraceFieldValue> {
  const out: Record<string, TraceFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = sanitizeValue(key, value);
  }
  return out;
}

export function recordRuntimeTrace(name: string, fields: Record<string, unknown> = {}): RuntimeTraceEvent | null {
  if (!traceEnabled()) return null;
  const event: RuntimeTraceEvent = {
    seq: ++sequence,
    at: new Date().toISOString(),
    uptimeMs: Date.now() - bootTimeMs,
    name,
    fields: sanitizeFields(fields),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  try {
    console.info('[BeebeebRuntimeTrace]', JSON.stringify(event));
  } catch {
    console.info('[BeebeebRuntimeTrace]', name);
  }
  logDiagnostic('runtime.trace', event as unknown as Record<string, unknown>);
  return event;
}

export function getRuntimeTraceSnapshot(): RuntimeTraceEvent[] {
  return events.slice();
}

export function formatRuntimeTraceJsonl(): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

export function clearRuntimeTrace(): void {
  events.length = 0;
}
