package expo.modules.beebeebcrypto

class SharedKeyRegistry<H : Any> {
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
    if (epoch == generation) storeFolder(handle, folderId) else null
  @Synchronized fun folder(id: Int): Folder<H>? = folders[id]
  @Synchronized fun releaseFolder(id: Int) { folders.remove(id) }
  @Synchronized fun storeFile(fileId: String, handle: H, generation: Long? = null): Boolean {
    if (generation != null && generation != epoch) return false
    if (fileId !in files && files.size >= maxFiles) return false
    files[fileId] = handle; return true
  }
  @Synchronized fun file(fileId: String): H? = files[fileId]
  @Synchronized fun clear() { epoch++; folders.clear(); files.clear() }
}

fun <H> pickKey(table: H?, derive: () -> H): H = table ?: derive()
