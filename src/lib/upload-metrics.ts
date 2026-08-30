// ---------------------------------------------------------------------------
// Pure helpers for live upload metrics (task 1301).
//
// The upload activity card shows three live numbers: on-device encryption
// throughput, network throughput, and a time-remaining estimate. Chunk
// uploads land in ~4 MB jumps at irregular intervals, so raw deltas flicker;
// rates are smoothed with a time-weighted exponential moving average and the
// ETA derives from the smoothed rate. All pure + unit-tested — no RN imports.
// ---------------------------------------------------------------------------

/**
 * Time-weighted EMA over a monotonically increasing byte counter.
 * ~3s half-life: steady enough to read, responsive enough to trust.
 */
export class RateMeter {
  private lastBytes: number | null = null;
  private lastAt: number | null = null;
  private ema: number | null = null; // bytes/sec

  /** Feed the current total + timestamp (ms); returns smoothed bytes/sec. */
  sample(totalBytes: number, atMs: number): number | null {
    if (this.lastBytes == null || this.lastAt == null || totalBytes < this.lastBytes) {
      // First sample, or the counter restarted (retry / next file in a batch).
      this.lastBytes = totalBytes;
      this.lastAt = atMs;
      return this.ema;
    }
    const dBytes = totalBytes - this.lastBytes;
    const dtMs = atMs - this.lastAt;
    if (dtMs <= 0) return this.ema;
    this.lastBytes = totalBytes;
    this.lastAt = atMs;
    const inst = (dBytes / dtMs) * 1000;
    const alpha = 1 - Math.exp(-dtMs / 3000);
    this.ema = this.ema == null ? inst : this.ema + alpha * (inst - this.ema);
    return this.ema;
  }

  rate(): number | null {
    return this.ema;
  }

  reset(): void {
    this.lastBytes = null;
    this.lastAt = null;
    this.ema = null;
  }
}

/** "412 MB/s" / "11.8 MB/s" / "850 kB/s" — SI units, matching formatBytes. */
export function formatRate(bytesPerSec: number | null | undefined): string | null {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return null;
  const mbps = bytesPerSec / 1_000_000;
  if (mbps >= 100) return `${Math.round(mbps)} MB/s`;
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1_000))} kB/s`;
}

/** "~24s" / "~3m" / "~2h" — deliberately coarse; an ETA is a promise. */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return `~${Math.max(1, Math.ceil(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `~${minutes}m`;
  return `~${Math.round(minutes / 60)}h`;
}

export function etaSeconds(bytesRemaining: number, bytesPerSec: number | null): number | null {
  if (bytesPerSec == null || bytesPerSec <= 0 || bytesRemaining <= 0) return null;
  return bytesRemaining / bytesPerSec;
}

/**
 * Ring geometry for the pure-RN donut (no react-native-svg): the arc is two
 * filled half-discs, each inside a half-window clip, rotated around the ring
 * center. Returns the rotation (deg) for each layer given progress 0..1.
 *
 *   right layer: sweeps 0°→180° of arc (12 o'clock → 6 o'clock, clockwise)
 *   left layer:  sweeps 180°→360°
 */
export function ringRotations(progress: number): { right: number; left: number } {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const deg = p * 360;
  return {
    right: deg <= 180 ? deg - 180 : 0,
    left: deg > 180 ? deg - 360 : -180,
  };
}
