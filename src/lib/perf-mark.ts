type PerfFields = Record<string, string | number | boolean | null | undefined>;

interface PerfMarkerOptions {
  now?: () => number;
  log?: (line: string) => void;
  enabled?: boolean;
}

function formatFields(fields: PerfFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
    .join(' ');
}

export function createPerfMarker(options: PerfMarkerOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? console.info;
  const enabled = options.enabled ?? (typeof __DEV__ !== 'undefined' ? __DEV__ : false);

  return {
    start(label: string, fields: PerfFields = {}) {
      const startAt = now();
      return (endFields: PerfFields = {}) => {
        if (!enabled) return;
        const elapsedMs = Math.max(0, Math.round(now() - startAt));
        const suffix = formatFields({ ...fields, ...endFields });
        log(`[BeebeebPerf] ${label} ${elapsedMs}ms${suffix ? ` ${suffix}` : ''}`);
      };
    },
    event(label: string, fields: PerfFields = {}) {
      if (!enabled) return;
      const suffix = formatFields(fields);
      log(`[BeebeebPerf] ${label}${suffix ? ` ${suffix}` : ''}`);
    },
  };
}

export const perfMark = createPerfMarker();
