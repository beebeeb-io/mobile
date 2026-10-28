package expo.modules.beebeebcrypto

import org.junit.Assert.*
import org.junit.Test
import kotlin.concurrent.thread

class SharedKeyRegistryTest {
  @Test fun registry_returns_a_stored_file_handle() {
    val r = SharedKeyRegistry<Any>(); val key = Any()
    assertTrue(r.storeFile("a", key)); assertSame(key, r.file("a"))
  }
  @Test fun registry_refuses_the_100001st_file() {
    val r = SharedKeyRegistry<Any>(); val key = Any()
    repeat(100000) { assertTrue(r.storeFile("$it", key)) }
    assertFalse(r.storeFile("overflow", key)); assertTrue(r.storeFile("0", key))
  }
  @Test fun clear_drops_folders_and_files() {
    val r = SharedKeyRegistry<Any>(); val id = r.storeFolder(Any(), "root")
    r.storeFile("a", Any()); r.clear(); assertNull(r.folder(id)); assertNull(r.file("a"))
  }
  @Test fun a_released_folder_id_is_invalid() {
    val r = SharedKeyRegistry<Any>(); val id = r.storeFolder(Any(), "root")
    r.releaseFolder(id); assertNull(r.folder(id))
  }
  @Test fun ids_are_never_reused_after_clear() {
    val r = SharedKeyRegistry<Any>(); val id = r.storeFolder(Any(), "root")
    r.clear(); assertTrue(r.storeFolder(Any(), "root") > id)
  }
  @Test fun table_entry_wins_over_derivation() {
    val key = Any(); var calls = 0
    assertSame(key, pickKey(key) { calls++; Any() }); assertEquals(0, calls)
  }
  @Test fun concurrent_store_and_clear_never_crash() {
    val r = SharedKeyRegistry<Any>()
    val workers = (0..7).map { w -> thread { repeat(1000) { i ->
      r.storeFile("$w-$i", Any()); r.file("$w-$i"); if (i % 4 == 0) r.clear()
    } } }; workers.forEach { it.join() }; r.clear(); assertNull(r.file("0-0"))
  }
  @Test fun handle_registry_release_and_clear_invoke_the_shared_clear_hook() {
    val r = BeebeebCryptoHandleRegistry(); var calls = 0
    r.onCleared = { calls++ }
    r.release(-1); assertEquals(1, calls)
    r.clear(); assertEquals(2, calls)
  }
}
