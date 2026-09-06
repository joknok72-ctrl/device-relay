package com.devicerelay.client.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import com.devicerelay.client.net.Action
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Official Android AccessibilityService. It never reads screen content
 * (canRetrieveWindowContent=false); it only dispatches gestures and global actions
 * that arrive from the relay via [RelayConnectionService].
 */
class AutomationAccessibilityService : AccessibilityService() {

    sealed class Outcome {
        data class Ok(val screenshotBase64: String? = null) : Outcome()
        data class Fail(val error: String) : Outcome()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "AccessibilityService connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* not used */ }
    override fun onInterrupt() { /* not used */ }

    // ---------------------------------------------------------------- execution
    suspend fun execute(action: Action): Outcome = when (action.type) {
        "tap" -> gesture(tapPath(action.x, action.y), 60)
        "long_press" -> gesture(tapPath(action.x, action.y), action.duration ?: 800)
        "swipe" -> gesture(swipePath(action), action.duration ?: 300)
        "back" -> global(GLOBAL_ACTION_BACK)
        "home" -> global(GLOBAL_ACTION_HOME)
        "recents" -> global(GLOBAL_ACTION_RECENTS)
        "notifications" -> global(GLOBAL_ACTION_NOTIFICATIONS)
        "lock" -> if (Build.VERSION.SDK_INT >= 28) global(GLOBAL_ACTION_LOCK_SCREEN) else Outcome.Fail("lock requires Android 9+")
        "screenshot" -> screenshot()
        "ping" -> Outcome.Ok()
        else -> Outcome.Fail("unsupported action: ${action.type}")
    }

    private fun tapPath(x: Float?, y: Float?): Path? {
        if (x == null || y == null) return null
        return Path().apply { moveTo(x, y) }
    }

    private fun swipePath(a: Action): Path? {
        if (a.x1 == null || a.y1 == null || a.x2 == null || a.y2 == null) return null
        return Path().apply { moveTo(a.x1, a.y1); lineTo(a.x2, a.y2) }
    }

    private suspend fun gesture(path: Path?, durationMs: Long): Outcome {
        if (path == null) return Outcome.Fail("missing coordinates")
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(1, 60_000))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return suspendCancellableCoroutine { cont ->
            val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
                override fun onCompleted(g: GestureDescription?) { if (cont.isActive) cont.resume(Outcome.Ok()) }
                override fun onCancelled(g: GestureDescription?) { if (cont.isActive) cont.resume(Outcome.Fail("gesture cancelled")) }
            }, null)
            if (!dispatched && cont.isActive) cont.resume(Outcome.Fail("dispatchGesture returned false"))
        }
    }

    private fun global(actionId: Int): Outcome =
        if (performGlobalAction(actionId)) Outcome.Ok() else Outcome.Fail("global action failed")

    private suspend fun screenshot(): Outcome {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return Outcome.Fail("screenshot requires Android 11+")
        return suspendCoroutine { cont ->
            takeScreenshot(Display.DEFAULT_DISPLAY, screenshotExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        val bmp = hw?.copy(Bitmap.Config.ARGB_8888, false)
                        result.hardwareBuffer.close()
                        if (bmp == null) { cont.resume(Outcome.Fail("bitmap null")); return }
                        // Downscale to keep WebSocket payload small (max width 540px)
                        val scale = (540f / bmp.width).coerceAtMost(1f)
                        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
                        val out = ByteArrayOutputStream()
                        scaled.compress(Bitmap.CompressFormat.PNG, 80, out)
                        cont.resume(Outcome.Ok(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)))
                    } catch (e: Exception) {
                        cont.resume(Outcome.Fail("screenshot encode failed: ${e.message}"))
                    }
                }
                override fun onFailure(errorCode: Int) { cont.resume(Outcome.Fail("screenshot failed code=$errorCode")) }
            })
        }
    }

    companion object {
        private const val TAG = "AutomationA11y"
        private val screenshotExecutor = Executors.newSingleThreadExecutor()

        @Volatile
        var instance: AutomationAccessibilityService? = null
            private set

        val isEnabled get() = instance != null
    }
}
