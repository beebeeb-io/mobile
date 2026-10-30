package expo.modules.beebeebcrypto

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import com.facebook.react.modules.network.CookieJarContainer
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.network.ReactCookieJarContainer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executor

/**
 * Task 1962 round 4, adversarial matrix row 6 (Bug 6e): with the lifecycle
 * factory installed, the client RN's `NetworkingModule` would get has no disk
 * cache and keeps the cookie jar `FrescoModule` casts to `CookieJarContainer`;
 * `cacheDir/http-cache` is gone after the listener's `onCreate`.
 *
 * JVM only: `OkHttpClientProvider.createClientBuilder(context, 0)` never
 * touches the Context, so a `ContextWrapper` with an overridden `getCacheDir`
 * is enough; no Robolectric.
 */
class HttpCacheLifecycleTest {
  private lateinit var cacheRoot: File

  private val context: Context = object : ContextWrapper(null) {
    override fun getCacheDir(): File = cacheRoot
  }

  private class FakeApplication(private val dir: File) : Application() {
    override fun getCacheDir(): File = dir
  }

  @Before
  fun setUp() {
    cacheRoot = Files.createTempDirectory("bb-http-cache-lifecycle").toFile()
  }

  @After
  fun tearDown() {
    // The static factory outlives the test class; reset it so another test
    // class never inherits a client holding this test's context.
    OkHttpClientProvider.setOkHttpClientFactory(null)
    cacheRoot.deleteRecursively()
  }

  @Test
  fun `factory client has no disk cache and keeps a CookieJarContainer`() {
    BeebeebHttpCache.install(context)

    val client = OkHttpClientProvider.createClient(context)

    assertNull("factory client must not carry an OkHttp disk cache", client.cache)
    // The exact cast FrescoModule.getDefaultConfigBuilder performs.
    val container = client.cookieJar as CookieJarContainer
    assertTrue(container is ReactCookieJarContainer)
  }

  @Test
  fun `onCreate deletes a legacy cacheDir http-cache directory`() {
    val legacy = File(BeebeebHttpCache.httpCacheDirectory(cacheRoot), "entries")
    assertTrue(legacy.mkdirs())
    File(legacy, "Cache.db").writeText("previous account")
    assertTrue(File(legacy, "Cache.db").isFile)

    BeebeebCryptoLifecycleListener().onCreate(FakeApplication(cacheRoot))

    val dir = BeebeebHttpCache.httpCacheDirectory(cacheRoot)
    val deadline = System.currentTimeMillis() + 5_000
    while (dir.exists() && System.currentTimeMillis() < deadline) Thread.sleep(10)
    assertFalse(
      "cacheDir/http-cache must be gone after the background cleanup",
      dir.exists()
    )
  }

  @Test
  fun `install hands the legacy delete to the background executor, not the caller`() {
    val legacy = File(BeebeebHttpCache.httpCacheDirectory(cacheRoot), "entries")
    assertTrue(legacy.mkdirs())
    File(legacy, "Cache.db").writeText("previous account")
    val queued = mutableListOf<Runnable>()

    BeebeebHttpCache.install(context, Executor { queued.add(it) })

    assertTrue("the delete must not run on the caller thread", legacy.exists())
    assertEquals(1, queued.size)
    queued.single().run()
    assertFalse("the queued cleanup removes the legacy directory", legacy.exists())
  }

  @Test
  fun `the autolinked package registers the lifecycle listener`() {
    val listeners = BeebeebCryptoLifecyclePackage().createApplicationLifecycleListeners(context)
    assertEquals(1, listeners.size)
    assertTrue(listeners.single() is BeebeebCryptoLifecycleListener)
  }
}
