package expo.modules.beebeebcrypto

class SharedKeyRegistry<H : Any>(
  private val dispose: (H) -> Unit = { (it as? AutoCloseable)?.close() }
) {
  companion object { const val maxFiles = 100_000 }
  data class Folder<H>(val handle: H, val folderId: String)
  private val folders = HashMap<Int, Folder<H>>()
  private val files = HashMap<String, H>()
  private val references = java.util.IdentityHashMap<H, Int>()
  private var nextId = 1
  private var epoch = 0L
  val generation: Long @Synchronized get() = epoch
  @Synchronized fun storeFolder(handle: H, folderId: String): Int {
    retain(handle)
    val id = nextId++; folders[id] = Folder(handle, folderId); return id
  }
  @Synchronized fun storeFolderIfCurrent(handle: H, folderId: String, generation: Long): Int? =
    if (epoch == generation) storeFolder(handle, folderId) else {
      disposeIfUnreferenced(handle); null
    }
  @Synchronized fun folder(id: Int): Folder<H>? = folders[id]
  @Synchronized fun releaseFolder(id: Int) {
    folders.remove(id)?.let { releaseOwned(it.handle) }
  }
  @Synchronized fun storeFile(fileId: String, handle: H, generation: Long? = null): Boolean {
    if ((generation != null && generation != epoch) || (fileId !in files && files.size >= maxFiles)) {
      disposeIfUnreferenced(handle)
      return false
    }
    val previous = files.put(fileId, handle)
    if (previous !== handle) {
      retain(handle)
      if (previous != null) releaseOwned(previous)
    }
    return true
  }
  @Synchronized fun file(fileId: String): H? = files[fileId]
  @Synchronized fun clear() {
    epoch++
    val discarded = java.util.IdentityHashMap(references)
    folders.clear(); files.clear(); references.clear()
    // UniFFI's call counter keeps active native calls alive until they drain.
    // Revoked handles are no longer available from the registry.
    var failure: Throwable? = null
    discarded.keys.forEach {
      try { dispose(it) } catch (error: Throwable) { if (failure == null) failure = error }
    }
    failure?.let { throw it }
  }
  private fun retain(handle: H) { references[handle] = (references[handle] ?: 0) + 1 }
  private fun releaseOwned(handle: H) {
    val count = references[handle] ?: error("Missing shared-key ownership")
    if (count == 1) { references.remove(handle); dispose(handle) }
    else references[handle] = count - 1
  }
  private fun disposeIfUnreferenced(handle: H) {
    if (!references.containsKey(handle)) dispose(handle)
  }
}

fun <H> pickKey(table: H?, derive: () -> H): H = table ?: derive()

fun <T> mergeNameResults(count: Int, fromTable: List<Pair<Int, T>>, fromMaster: List<Pair<Int, T>>): List<T> {
  val ordered = (fromTable + fromMaster).sortedBy { it.first }
  require(ordered.map { it.first } == (0 until count).toList())
  return ordered.map { it.second }
}

// Registry keys are borrowed; only locally derived handles belong to the consumer.
class SharedKeyAccess<H : Any>(val handle: H, val owned: Boolean, private val dispose: (H) -> Unit) : AutoCloseable {
  private var released = false
  @Synchronized override fun close() {
    if (!released) {
      released = true
      if (owned) dispose(handle)
    }
  }
}
