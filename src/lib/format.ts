// ---------------------------------------------------------------------------
// Shared formatters — single source of truth for human-readable sizes/rates.
//
// Storage sizes use SI (1000-based) units, matching the rest of the product:
// B, KB, MB, GB, TB. One decimal for GB/TB, whole numbers below. This is the
// canonical implementation; per-screen copies were de-duplicated into this.
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable SI string (1 KB = 1,000 bytes).
 *
 *   0            -> "0 B"
 *   |bytes| <1e3 -> "<bytes> B"
 *   <1e6         -> "<n> KB"   (whole)
 *   <1e9         -> "<n> MB"   (whole)
 *   <1e12        -> "<n.n> GB" (one decimal)
 *   else         -> "<n.n> TB" (one decimal)
 *
 * Negative inputs keep their sign so delta/diff displays render correctly.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1_000) return `${bytes} B`;
  if (abs < 1_000_000) return `${sign}${Math.round(abs / 1_000)} KB`;
  if (abs < 1_000_000_000) return `${sign}${Math.round(abs / 1_000_000)} MB`;
  if (abs < 1_000_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)} GB`;
  return `${sign}${(abs / 1_000_000_000_000).toFixed(1)} TB`;
}

/**
 * Format a transfer rate given in KB/s into a human-readable SI string.
 *
 *   >1000 KB/s -> "<n.n> MB/s" (one decimal)
 *   else       -> "<n> KB/s"   (whole)
 */
export function formatThroughput(kbPerSec: number): string {
  return kbPerSec > 1000
    ? `${(kbPerSec / 1000).toFixed(1)} MB/s`
    : `${Math.round(kbPerSec)} KB/s`;
}
