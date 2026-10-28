package expo.modules.beebeebcrypto

class SharedKeyRegistry<H : Any>(
  private val dispose: (H) -> Unit = { (it as? AutoCloseable)?.close() }
) {
  companion object { const val maxFiles = 100_000 }
  data class Folder<H>(val handle: H, val folderId: String)
  private val folders = HashMap<Int, Folder<H>>()
  private val files = HashMap<String, H>()
  private var nextId = 1
  private var epoch = 0L
  val generation: Long @Synchronized get() = epoch
  @Synchronized fun storeFolder(handle: H, folderId: String): Int {
    val id = nextId++; folders[id] = Folder(handle, folderId); return id
  }
  @Synchronized fun storeFolderIfCurrent(handle: H, folderId: String, generation: Long): Int? =
    if (epoch == generation) storeFolder(handle, folderId) else {
      disposeIfUnreferenced(handle); null
    }
  @Synchronized fun folder(id: Int): Folder<H>? = folders[id]
  @Synchronized fun releaseFolder(id: Int) {
    folders.remove(id)?.let { disposeIfUnreferenced(it.handle) }
  }
  @Synchronized fun storeFile(fileId: String, handle: H, generation: Long? = null): Boolean {
    if ((generation != null && generation != epoch) || (fileId !in files && files.size >= maxFiles)) {
      disposeIfUnreferenced(handle)
      return false
    }
    val previous = files.put(fileId, handle)
    if (previous != null && previous !== handle) disposeIfUnreferenced(previous)
    return true
  }
  @Synchronized fun file(fileId: String): H? = files[fileId]
  @Synchronized fun clear() {
    epoch++
    val discarded = java.util.IdentityHashMap<H, Boolean>()
    folders.values.forEach { discarded[it.handle] = true }
    files.values.forEach { discarded[it] = true }
    folders.clear(); files.clear()
    // UniFFI destroy defers Rust Drop until any active native call returns;
    // subsequent calls through a revoked borrowed reference fail closed.
    var failure: Throwable? = null
    discarded.keys.forEach {
      try { dispose(it) } catch (error: Throwable) { if (failure == null) failure = error }
    }
    failure?.let { throw it }
  }
  private fun disposeIfUnreferenced(handle: H) {
    if (files.values.none { it === handle } && folders.values.none { it.handle === handle }) dispose(handle)
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
