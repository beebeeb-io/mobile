/**
 * share-key-store — tiny module-level singleton that captures the #key=
 * fragment from share URLs before React Navigation's routing strips them.
 *
 * Flow:
 *   1. App.tsx's Linking handler captures the raw URL
 *   2. setPendingShareKey(token, key) stores {token, key}
 *   3. SharedViewScreen mounts with route.params.token
 *   4. consumeShareKey(token) returns the key and clears the store
 *
 * Only holds one entry at a time — double-tapping two different share
 * links in quick succession would drop the first, but that's fine.
 */

interface PendingShareKey {
  token: string
  shareKey: string
}

let pending: PendingShareKey | null = null

/** Called by App.tsx when a URL with a #key= fragment is intercepted. */
export function setPendingShareKey(token: string, shareKey: string): void {
  pending = { token, shareKey }
}

/**
 * Called by SharedViewScreen on mount.
 * Returns the share key if this token has a pending fragment, null otherwise.
 * Clears the store entry after returning.
 */
export function consumeShareKey(token: string): string | null {
  if (pending?.token === token) {
    const key = pending.shareKey
    pending = null
    return key
  }
  return null
}
