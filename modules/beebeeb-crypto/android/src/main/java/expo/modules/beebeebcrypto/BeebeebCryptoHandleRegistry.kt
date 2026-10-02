package expo.modules.beebeebcrypto

import expo.modules.kotlin.exception.CodedException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.beebeeb_uniffi.MasterKeyHandle

/**
 * JS-facing `Int` ids over Rust `MasterKeyHandle` objects — mirrors iOS
 * `masterKeyHandles` / `storeHandle` / `getHandle` (BeebeebCryptoModule.swift:1888–1906)
 * plus the app-wide cache adoption gated by `confirmMasterKeyHandle`
 * (task 1594; iOS `BeebeebCryptoBridge.setCachedMasterKey`).
 *
 * In-process only. Ids are monotonically increasing positive `Int`s; invalid
 * ids throw `CodedException("INVALID_HANDLE")` (iOS `getHandle` uses NSError
 * code 1 — nothing in JS branches on either today).
 */
class BeebeebCryptoHandleRegistry {

  private val nextId = AtomicInteger(1)
  private val handles = HashMap<Int, MasterKeyHandle>()

  /**
   * Task 1683h — the module's key-loaded signal. Completed the first time a
   * handle enters the registry after a fresh/cleared state; the preview
   * decrypt's native key resolution awaits it instead of JS polling. On
   * `clear()` a FRESH incomplete latch is installed so a subsequent
   * sign-out → sign-in cycle gets its own signal (store() completes it).
   * Completed latches are consumed once: `awaitKey()` swaps in a fresh one
   * after a successful await so the NEXT launch's load produces a new signal.
   */
  private val keyLoaded = CompletableDeferred<Unit>()

  /** App-wide adopted handle (for future native background readers, M3+). */
  @Volatile
  private var adoptedId: Int? = null

  @Volatile
  private var adoptedOwnerId: String? = null

  fun store(handle: MasterKeyHandle): Int {
    val id = nextId.getAndIncrement()
    synchronized(handles) {
      handles[id] = handle
      if (adoptedId == null) adoptedId = id
      keyLoaded.complete(Unit)
    }
    return id
  }

  /**
   * Await the key-loaded signal. Returns immediately when a handle is already
   * loaded; otherwise suspends until the keychain load stores one. An error
   * signal (vault locked, load failed) completes the latch exceptionally and
   * surfaces here. A timeout keeps the caller recoverable rather than hung
   * forever (bounded wait — the load itself normally lands in ~1.5–2 s).
   */
  suspend fun awaitKey(timeoutMs: Long = 30_000): MasterKeyHandle =
    withTimeoutOrNull(timeoutMs) {
      val adoptedNow = adopted()
      if (adoptedNow != null) return@withTimeoutOrNull adoptedNow
      keyLoaded.await()
      // After the latch fires, read the adopted handle; if store() happened
      // without adopt (a plain store), fall back to the newest handle.
      adopted() ?: synchronized(handles) { handles.values.lastOrNull() }
        ?: throw CodedException("ERR_VAULT_LOCKED", "Vault is locked — unlock to continue", null)
    } ?: throw CodedException(
      "ERR_VAULT_LOCKED",
      "Vault is locked — unlock to continue",
      null,
    )

  fun get(id: Int): MasterKeyHandle =
    synchronized(handles) { handles[id] }
      ?: throw CodedException("INVALID_HANDLE", "invalid master key handle id: $id", null)

  fun release(id: Int) {
    synchronized(handles) {
      handles.remove(id)
      if (adoptedId == id || handles.isEmpty()) {
        adoptedId = null
        adoptedOwnerId = null
      }
    }
  }

  /**
   * Ownership-verdict adoption — the genuine new-authentication choke point
   * (iOS clears its sticky mismatch reasons here; Android has no background
   * engine yet, so adoption just records the verified handle + owner).
   * `""` is normalized to null: an empty string is never a real account id.
   */
  fun adopt(id: Int, ownerId: String?): Boolean {
    get(id) // throws for invalid ids, mirroring iOS getHandle
    synchronized(handles) {
      adoptedId = id
      adoptedOwnerId = ownerId?.takeIf { it.isNotEmpty() }
    }
    return true
  }

  /** The adopted handle, for native background readers (M3+). */
  fun adopted(): MasterKeyHandle? = synchronized(handles) { adoptedId?.let { handles[it] } }

  fun clear() {
    synchronized(handles) {
      handles.clear()
      adoptedId = null
      adoptedOwnerId = null
      // A fresh incomplete latch: the next keychain load (new sign-in) must
      // produce a NEW key-loaded signal.
      keyLoaded = CompletableDeferred()
    }
  }
}
