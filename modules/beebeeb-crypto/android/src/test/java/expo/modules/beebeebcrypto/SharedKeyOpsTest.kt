package expo.modules.beebeebcrypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.beebeeb_uniffi.FileKeyHandle
import uniffi.beebeeb_uniffi.OwnerKeyConvention

/**
 * SF-0002 M2a step 2: the pure half of the read-only owner resolvers. The native
 * call paths are covered by the Swift harness and the KATs; this pins the
 * boundary decision, the read-only shape of [OwnerReadKey] and the fact that the
 * convention cache holds conventions only and empties on lock.
 */
class SharedKeyOpsTest {
  @Test
  fun anOwnedFileInAnOwnedSharedFolderFallsThroughToTheOwnerResolver() {
    assertEquals(
      NameResolutionPlan.OWNER_RESOLVE,
      SharedKeyOps.nameResolutionPlan(tablePresent = true, tableFailed = true, isForeign = false),
    )
  }

  @Test
  fun aForeignWrongTableKeyStaysFinal() {
    assertEquals(
      NameResolutionPlan.ERROR_FINAL,
      SharedKeyOps.nameResolutionPlan(tablePresent = true, tableFailed = true, isForeign = true),
    )
  }

  @Test
  fun aTableHitIsFinalForOwnedAndForeignFiles() {
    for (foreign in listOf(false, true)) {
      assertEquals(
        NameResolutionPlan.TABLE_FINAL,
        SharedKeyOps.nameResolutionPlan(tablePresent = true, tableFailed = false, isForeign = foreign),
      )
    }
  }

  @Test
  fun aResolverKeyCanNeitherEncryptNorWrap() {
    val methods = OwnerReadKey::class.java.declaredMethods
      .filter { !it.isSynthetic }
      .map { it.name }
      .toSet()
    // UByte parameters are inline classes, so Kotlin mangles makeDecryptor's JVM name.
    assertEquals(3, methods.size)
    assertTrue(methods.contains("decryptFileMetadata"))
    assertTrue(methods.contains("decryptNameMetadata"))
    assertTrue(methods.any { it.startsWith("makeDecryptor") })
    val fields = OwnerReadKey::class.java.declaredFields
    assertEquals(1, fields.size)
    assertEquals(FileKeyHandle::class.java, fields.single().type)
    assertTrue(java.lang.reflect.Modifier.isPrivate(fields.single().modifiers))
    for (forbidden in listOf("encrypt", "wrap", "adopt", "fileKey")) {
      assertFalse("OwnerReadKey must not expose $forbidden", methods.any { it.contains(forbidden) })
    }
  }

  @Test
  fun theConventionCacheHoldsNoKeysAndClearsOnLock() {
    val cache = OwnerConventionCache()
    assertEquals(0, cache.count())
    cache.storeName(OwnerKeyConvention.UPPER_REPAIR, 1L, "file-a", "sealed-name")
    cache.storeContent(OwnerKeyConvention.STRING, 1L, "file-a", "version-1")
    assertEquals(2, cache.count())
    assertEquals(OwnerKeyConvention.UPPER_REPAIR, cache.name(1L, "file-a", "sealed-name"))
    assertEquals(OwnerKeyConvention.STRING, cache.content(1L, "file-a", "version-1"))
    // A different epoch (account switch) cannot read the old entries.
    assertNull(cache.name(2L, "file-a", "sealed-name"))
    cache.clear()
    assertEquals(0, cache.count())
    assertNull(cache.name(1L, "file-a", "sealed-name"))
    assertNull(cache.content(1L, "file-a", "version-1"))
    val fields = OwnerConventionCache::class.java.declaredFields
    assertFalse(
      "the convention cache must never hold a key handle",
      fields.any { it.type == FileKeyHandle::class.java },
    )
  }
}
