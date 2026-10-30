package expo.modules.beebeebcrypto

import android.app.Application
import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.core.BasePackage
import expo.modules.core.interfaces.ApplicationLifecycleListener
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Task 1962 round 4 (Bug 6e) — RN's `NetworkingModule` asks
 * `OkHttpClientProvider.createClient(context)` for its client, and that
 * default adds a 10 MB disk cache at `cacheDir/http-cache` that survives
 * sign-out: the next account on the device could read the previous account's
 * API responses from it. Nothing reads the HTTP cache on purpose (images load
 * from `file://`, previews are incognito WebViews).
 *
 * This listener runs from `ApplicationLifecycleDispatcher.onApplicationCreate`
 * (MainApplication.onCreate, after `loadReactNative` and before any RN module
 * exists), installs a factory whose client has NO disk cache, and deletes the
 * cache directory older builds left behind. With no disk cache there is
 * nothing left to clear at sign-out (contract 6f).
 *
 * The factory deliberately uses `createClientBuilder(context, 0)`: it skips
 * the disk cache but keeps RN's `ReactCookieJarContainer`, which
 * `FrescoModule` hard-casts to `CookieJarContainer`.
 *
 * The file name ends in `Package` and imports `expo.modules.core.BasePackage`
 * so expo-modules-autolinking picks the package up into the generated
 * `ExpoModulesPackageList` (proved by the JVM test + the build's generated
 * list).
 */
class BeebeebCryptoLifecycleListener : ApplicationLifecycleListener {
  override fun onCreate(application: Application) {
    BeebeebHttpCache.install(application)
  }
}

class BeebeebCryptoLifecyclePackage : BasePackage() {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(BeebeebCryptoLifecycleListener())
}

internal object BeebeebHttpCache {
  /** The factory must be installed synchronously; the legacy delete must not
   *  block Application.onCreate. */
  private val cleanupExecutor: Executor by lazy {
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "beebeeb-http-cache-cleanup").apply { isDaemon = true }
    }
  }

  /** Must run before RN creates its networking client. */
  internal fun install(context: Context) = install(context, cleanupExecutor)

  internal fun install(context: Context, cleanupExecutor: Executor) {
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(context, 0).build()
    }
    // The factory install above must stay synchronous (RN asks for its client
    // during startup), but deleting a large legacy cache tree must not block
    // Application.onCreate (round 5 review finding).
    val legacy = httpCacheDirectory(context.cacheDir)
    cleanupExecutor.execute { legacy.deleteRecursively() }
  }

  internal fun httpCacheDirectory(cacheDir: File): File = File(cacheDir, "http-cache")
}
