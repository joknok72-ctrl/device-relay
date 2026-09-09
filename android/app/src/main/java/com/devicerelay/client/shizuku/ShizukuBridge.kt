package com.devicerelay.client.shizuku

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Log
import rikka.shizuku.Shizuku

/**
 * v3.4 — owns the Shizuku permission + the TouchProxy user-service binding.
 * Everything is best-effort: when Shizuku is not installed/running the app keeps working exactly as before (v3.3 engine).
 */
object ShizukuBridge {
    private const val TAG = "ShizukuBridge"
    private const val REQ = 4471

    @Volatile var proxy: ITouchProxy? = null; private set
    @Volatile var lastError: String? = null; private set
    var onChange: (() -> Unit)? = null
    private var appCtx: Context? = null
    private var binding = false

    val available: Boolean get() = runCatching { Shizuku.pingBinder() }.getOrDefault(false)
    val granted: Boolean get() = available && runCatching { Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED }.getOrDefault(false)
    val ready: Boolean get() = proxy?.let { runCatching { it.isReady }.getOrDefault(false) } ?: false

    fun init(ctx: Context) {
        appCtx = ctx.applicationContext
        runCatching {
            Shizuku.addBinderReceivedListenerSticky { Log.i(TAG, "shizuku binder received"); if (granted) bind() ; onChange?.invoke() }
            Shizuku.addBinderDeadListener { Log.w(TAG, "shizuku binder dead"); proxy = null; binding = false; onChange?.invoke() }
            Shizuku.addRequestPermissionResultListener { code, result -> if (code == REQ) { if (result == PackageManager.PERMISSION_GRANTED) bind(); onChange?.invoke() } }
        }.onFailure { lastError = it.toString() }
    }

    /** ask for the Shizuku permission (shows the Shizuku dialog); binds automatically once granted */
    fun request(): Boolean {
        if (!available) { lastError = "Shizuku is not running"; return false }
        if (granted) { bind(); return true }
        return runCatching { if (Shizuku.shouldShowRequestPermissionRationale()) { lastError = "permission denied permanently — allow in the Shizuku app"; false } else { Shizuku.requestPermission(REQ); true } }.getOrElse { lastError = it.toString(); false }
    }

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            binding = false
            if (binder == null || !binder.pingBinder()) { lastError = "user service binder invalid"; onChange?.invoke(); return }
            proxy = ITouchProxy.Stub.asInterface(binder)
            lastError = null
            Log.i(TAG, "touch proxy connected: " + runCatching { proxy?.describe() }.getOrNull())
            onChange?.invoke()
        }
        override fun onServiceDisconnected(name: ComponentName?) { proxy = null; binding = false; onChange?.invoke() }
    }

    fun bind(): Boolean {
        val ctx = appCtx ?: return false
        if (proxy != null || binding) return true
        if (!granted) return false
        return runCatching {
            val args = Shizuku.UserServiceArgs(ComponentName(ctx.packageName, TouchProxyService::class.java.name))
                .daemon(false).processNameSuffix("touch").debuggable(false).version(BuildConfigVersion.CODE)
            binding = true
            Shizuku.bindUserService(args, conn); true
        }.getOrElse { lastError = it.toString(); binding = false; false }
    }

    fun unbind() {
        val ctx = appCtx ?: return
        runCatching {
            val args = Shizuku.UserServiceArgs(ComponentName(ctx.packageName, TouchProxyService::class.java.name)).daemon(false).processNameSuffix("touch").version(BuildConfigVersion.CODE)
            Shizuku.unbindUserService(args, conn, true)
        }
        proxy = null
    }

    /** one-line status for UI / relay */
    fun state(): String = when {
        !available -> "absent"
        !granted -> "denied"
        proxy == null -> if (binding) "binding" else "granted"
        !ready -> "proxy-not-ready"
        else -> "ready"
    }
}

/** kept separate so the user service (which has no BuildConfig at runtime in the shell process) can be versioned */
object BuildConfigVersion { const val CODE = 17 }
