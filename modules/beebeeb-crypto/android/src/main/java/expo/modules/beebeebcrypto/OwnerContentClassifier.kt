package expo.modules.beebeebcrypto

import java.io.ByteArrayOutputStream
import okhttp3.OkHttpClient
import okhttp3.Request
import uniffi.beebeeb_uniffi.FileKeyHandle
import uniffi.beebeeb_uniffi.MasterKeyHandle

/**
 * SF-0002 M2a: classify one owned content version as `string`, `binary`,
 * `string_or_binary`, `upper_repair` or `unknown`.
 *
 * Ordered rules, each early rule costing zero requests:
 *  1. a cached convention for (epoch, fileId, objectVersionId);
 *  2. `createdAt` before the 2026-05-01 cutover -> `string_or_binary`;
 *  3. an UpperRepair name already known -> `upper_repair`;
 *  4. ONE GET /api/v1/files/{id}/chunks/0 (the native video streamer's path and
 *     auth): a declared length over C aborts without reading the body ->
 *     `string_or_binary`; otherwise read at most C bytes, resolve the first
 *     frame through the owner content resolver and cache its exact convention;
 *  5. any failure -> `unknown`, never cached.
 *
 * C is the largest chunk 0 any File Provider build since 2026-05-01 could have
 * written (4 MiB) plus the AEAD overhead (12-byte nonce + 16-byte tag); see C.md.
 */
object OwnerContentClassifier {
  const val MAX_CHUNK_ZERO_BYTES = 4 * 1024 * 1024 + 28

  private val client = OkHttpClient()

  fun classify(master: MasterKeyHandle, fileId: String, objectVersionId: String,
    createdAt: String, apiUrl: String, token: String, clientVersion: String,
    registry: SharedKeyRegistry<FileKeyHandle> = SharedKeyOps.registry): String {
    val epoch = registry.generation
    SharedKeyOps.ownerConventions.content(epoch, fileId, objectVersionId)?.let {
      return SharedKeyOps.conventionCode(it)
    }
    if (createdAt.take(10) < "2026-05-01") return "string_or_binary"
    if (SharedKeyOps.ownerConventions.isUpperRepairName(epoch, fileId)) return "upper_repair"
    return try {
      val url = "${apiUrl.trimEnd('/')}/api/v1/files/$fileId/chunks/0"
      val request = Request.Builder()
        .url(url)
        .header("Authorization", "Bearer $token")
        .header("X-Beebeeb-Client", "mobile-android")
        .header("X-Beebeeb-Client-Version", clientVersion)
        .build()
      client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) return "unknown"
        val declared = response.header("Content-Length")?.toLongOrNull() ?: -1L
        if (declared > MAX_CHUNK_ZERO_BYTES) return "string_or_binary"
        val stream = response.body?.byteStream() ?: return "unknown"
        val body = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0
        while (true) {
          val n = stream.read(buffer)
          if (n < 0) break
          total += n
          if (total > MAX_CHUNK_ZERO_BYTES) return "string_or_binary"
          body.write(buffer, 0, n)
        }
        if (total == 0) return "unknown"
        val (_, convention) = SharedKeyOps.resolveOwnerContent(master, fileId, body.toByteArray(), registry)
        SharedKeyOps.ownerConventions.storeContent(convention, epoch, fileId, objectVersionId)
        SharedKeyOps.conventionCode(convention)
      }
    } catch (_: Exception) {
      "unknown"
    }
  }
}
