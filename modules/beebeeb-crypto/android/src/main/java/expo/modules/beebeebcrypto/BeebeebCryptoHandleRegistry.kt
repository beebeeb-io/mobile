package expo.modules.beebeebcrypto

import expo.modules.kotlin.exception.CodedException
import java.util.concurrent.atomic.AtomicInteger
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

  /** App-wide adopted handle (for future native background readers, M3+). */
  @Volatile
  private var adoptedId: Int? = null

  @Volatile
  private var adoptedOwnerId: String? = null

  fun store(handle: MasterKeyHandle): Int {
    val id = nextId.getAndIncrement()
    synchronized(handles) { handles[id] = handle }
    return id
  }

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
    }
  }
}
