// ---------------------------------------------------------------------------
// Shared formatters — single source of truth for human-readable sizes/rates.
//
// Storage sizes use SI (1000-based) units, matching the rest of the product:
// B, kB, MB, GB, TB (SI symbol for kilobyte is lowercase "kB"). One decimal for
// GB/TB, whole numbers below. This is the canonical implementation; per-screen
// copies were de-duplicated into this.
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable SI string (1 kB = 1,000 bytes).
 *
 *   0            -> "0 B"
 *   |bytes| <1e3 -> "<bytes> B"
 *   <1e6         -> "<n> kB"   (whole)
 *   <1e9         -> "<n> MB"   (whole)
 *   <1e12        -> "<n.n> GB" (one decimal)
 *   else         -> "<n.n> TB" (one decimal)
 *
 * Carry-aware at unit boundaries: a value that ROUNDS up to 1000 within a unit
 * is promoted to the next unit, so 999,500 B is "1 MB" (not "1000 kB") and
 * 999.95 GB is "1.0 TB" (not "1000.0 GB").
 *
 * Negative inputs keep their sign so delta/diff displays render correctly.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1_000) return `${bytes} B`;

  const kb = Math.round(abs / 1_000);
  if (abs < 1_000_000 && kb < 1_000) return `${sign}${kb} kB`;

  const mb = Math.round(abs / 1_000_000);
  if (abs < 1_000_000_000 && mb < 1_000) return `${sign}${mb} MB`;

  const gb = abs / 1_000_000_000;
  if (abs < 1_000_000_000_000 && Number(gb.toFixed(1)) < 1_000) {
    return `${sign}${gb.toFixed(1)} GB`;
  }

  return `${sign}${(abs / 1_000_000_000_000).toFixed(1)} TB`;
}

/**
 * Format a transfer rate given in kB/s into a human-readable SI string.
 *
 *   >1000 kB/s -> "<n.n> MB/s" (one decimal)
 *   else       -> "<n> kB/s"   (whole)
 */
export function formatThroughput(kbPerSec: number): string {
  return kbPerSec > 1000
    ? `${(kbPerSec / 1000).toFixed(1)} MB/s`
    : `${Math.round(kbPerSec)} kB/s`;
}
