package com.devicerelay.client.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.devicerelay.client.net.Action
import com.devicerelay.client.net.ReactLane
import com.devicerelay.client.net.Region
import com.devicerelay.client.net.SeqPoint
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Official Android AccessibilityService. Performs gestures / global actions and
 * (since v1.2) reads the UI tree so an AI agent can tap elements by text/id and type text.
 */
class AutomationAccessibilityService : AccessibilityService() {

    sealed class Outcome {
        data class Ok(val screenshotBase64: String? = null, val data: JsonElement? = null, val mime: String? = null) : Outcome()
        data class Fail(val error: String) : Outcome()
    }

    // ------------------------------------------------------------ v2.8 hands-free bot controls
    /** floating ▶/■ bubble over the game (TYPE_ACCESSIBILITY_OVERLAY, no extra permission) */
    val overlay: BotOverlay by lazy { BotOverlay(this) }
    /** RelayConnectionService registers these so the bubble / volume keys / auto-start can drive BotEngine */
    var onBotToggle: (() -> Unit)? = null
    var onBotStartRequest: ((reason: String) -> Unit)? = null
    var onForegroundApp: ((pkg: String) -> Unit)? = null
    private var overlayHiddenFor: String? = null
    private var lastVolDownAt = 0L; private var lastVolUpAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // ask for hardware key events (volume double-press = start/stop bot) — flag is added at runtime so older configs keep working
        runCatching { serviceInfo = serviceInfo.apply { flags = flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS } }
        overlay.onTap = { onBotToggle?.invoke() }
        overlay.onLongPress = { overlayHiddenFor = lastPackage; overlay.hide() }
        Log.i(TAG, "AccessibilityService connected")
    }

    override fun onDestroy() {
        runCatching { overlay.hide() }
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && pkg != lastPackage && pkg != packageName && !pkg.startsWith("com.android.systemui")) {
            lastPackage = pkg
            if (overlayHiddenFor != null && overlayHiddenFor != pkg) overlayHiddenFor = null
            onForegroundApp?.invoke(pkg)
        } else if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) lastPackage = pkg
    }

    /** volume keys: double-press Vol-Down within 500 ms = stop bot, double-press Vol-Up = start current bot. Single presses pass through. */
    override fun onKeyEvent(event: android.view.KeyEvent): Boolean {
        if (event.action != android.view.KeyEvent.ACTION_DOWN) return false
        val now = android.os.SystemClock.elapsedRealtime()
        when (event.keyCode) {
            android.view.KeyEvent.KEYCODE_VOLUME_DOWN -> { if (now - lastVolDownAt < 500 && BotEngine.status.running) { lastVolDownAt = 0; BotEngine.stop("volume"); return true }; lastVolDownAt = now }
            android.view.KeyEvent.KEYCODE_VOLUME_UP -> { if (now - lastVolUpAt < 500 && !BotEngine.status.running) { lastVolUpAt = 0; onBotStartRequest?.invoke("volume"); return true }; lastVolUpAt = now }
        }
        return false
    }

    /** show/refresh the bubble for the current foreground app (called by RelayConnectionService) */
    fun updateOverlay(text: String, sub: String, running: Boolean, hasBots: Boolean) {
        if (!hasBots && !running) { overlay.hide(); return }
        if (overlayHiddenFor != null && overlayHiddenFor == lastPackage && !running) { overlay.hide(); return }
        overlay.show(text, sub, running)
    }

    override fun onInterrupt() { /* not used */ }

    // ---------------------------------------------------------------- dispatcher
    suspend fun execute(action: Action): Outcome = when (action.type) {
        "tap" -> gesture(tapPath(action.x, action.y), 60)
        "double_tap" -> doubleTap(action.x, action.y)
        "long_press" -> gesture(tapPath(action.x, action.y), action.duration ?: 800)
        "swipe" -> gesture(swipePath(action), action.duration ?: 300)
        "back" -> global(GLOBAL_ACTION_BACK)
        "home" -> global(GLOBAL_ACTION_HOME)
        "recents" -> global(GLOBAL_ACTION_RECENTS)
        "notifications" -> global(GLOBAL_ACTION_NOTIFICATIONS)
        "quick_settings" -> global(GLOBAL_ACTION_QUICK_SETTINGS)
        "lock" -> if (Build.VERSION.SDK_INT >= 28) global(GLOBAL_ACTION_LOCK_SCREEN) else Outcome.Fail("lock requires Android 9+")
        "wake" -> wakeScreen()
        "screenshot" -> screenshot(action.maxWidth, action.quality, action.format, action.grid, action.region)
        "ui_dump" -> Outcome.Ok(data = uiDump())
        "tap_element" -> tapElement(action)
        "type_text" -> typeText(action)
        "open_app" -> openApp(action.text)
        "open_url" -> openUrl(action.url)
        "list_apps" -> Outcome.Ok(data = listApps())
        "current_app" -> Outcome.Ok(data = buildJsonObject {
            put("package", rootInActiveWindow?.packageName?.toString() ?: lastPackage)
            put("label", appLabel(rootInActiveWindow?.packageName?.toString() ?: lastPackage))
        })
        "ping" -> Outcome.Ok()
        // v1.4
        "drag" -> drag(action)
        "pinch" -> pinch(action)
        "scroll_element" -> scrollElement(action)
        "set_clipboard" -> setClipboard(action)
        "get_notifications" -> RelayNotificationListener.instance?.let { Outcome.Ok(data = it.dump(action.limit ?: 20)) }
            ?: Outcome.Fail("notification access not enabled: open Device Relay app and enable 'Notification access'")
        "device_info" -> Outcome.Ok(data = deviceInfo())
        // v1.5
        "tap_sequence" -> tapSequence(action.points)
        "multi_tap" -> multiTap(action.points, action.duration)
        "swipe_path" -> swipePath(action.points, action.duration)
        "repeat_tap" -> repeatTap(action)
        "pixel" -> pixels(action.points)
        "find_color" -> findColor(action)
        "screen_hash" -> screenHash()
        // v1.6
        "screen_diff" -> screenDiff(action)
        "watch_color" -> watchColor(action)
        "wait_pixel" -> waitPixel(action)
        "find_image" -> findImage(action)
        // v1.7
        "read_text" -> readText(action)
        "find_colors" -> findColors(action)
        "stream" -> Outcome.Fail("stream is handled by the connection service") // never reached
        // v1.9
        "find_objects" -> findObjects(action)
        "auto_react" -> autoReact(action)
        // v2.1
        "sample_colors" -> sampleColors(action)
        "track_object" -> trackObject(action)
        // v2.5 multi-touch engine (shooters / action games)
        "finger_down" -> fingerDown(action)
        "finger_move" -> fingerMove(action)
        "finger_up" -> fingerUp(action)
        "joystick" -> joystick(action)
        "aim" -> aim(action)
        "fire_burst" -> fireBurst(action)
        "combo" -> combo(action)
        else -> Outcome.Fail("unsupported action: ${action.type}")
    }

    // ---------------------------------------------------------------- gestures
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

    private suspend fun doubleTap(x: Float?, y: Float?): Outcome {
        val first = gesture(tapPath(x, y), 40)
        if (first is Outcome.Fail) return first
        delay(80)
        return gesture(tapPath(x, y), 40)
    }

    private fun global(actionId: Int): Outcome =
        if (performGlobalAction(actionId)) Outcome.Ok() else Outcome.Fail("global action failed")

    @Suppress("DEPRECATION")
    private fun wakeScreen(): Outcome {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isInteractive) return Outcome.Ok(data = buildJsonObject { put("alreadyAwake", true) })
        val wl = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
            "DeviceRelay:wake",
        )
        wl.acquire(3000)
        wl.release()
        return Outcome.Ok()
    }

    /** Long-press then move: drag-and-drop. */
    private suspend fun drag(a: Action): Outcome {
        if (a.x1 == null || a.y1 == null || a.x2 == null || a.y2 == null) return Outcome.Fail("missing coordinates")
        val hold = (a.holdMs ?: 500L).coerceIn(0, 5000)
        val move = (a.duration ?: 600L).coerceIn(50, 10_000)
        val holdPath = Path().apply { moveTo(a.x1, a.y1) }
        val movePath = Path().apply { moveTo(a.x1, a.y1); lineTo(a.x2, a.y2) }
        val b = GestureDescription.Builder()
        if (hold > 0) {
            val s1 = GestureDescription.StrokeDescription(holdPath, 0, hold, true)
            b.addStroke(s1)
            b.addStroke(s1.continueStroke(movePath, 0, move, false))
        } else {
            b.addStroke(GestureDescription.StrokeDescription(movePath, 0, move))
        }
        return dispatch(b.build())
    }

    /** Two-finger pinch around (x,y). scale > 1 = zoom in. */
    private suspend fun pinch(a: Action): Outcome {
        val cx = a.x ?: return Outcome.Fail("missing x")
        val cy = a.y ?: return Outcome.Fail("missing y")
        val scale = (a.scale ?: 2f).coerceIn(0.1f, 10f)
        val dur = (a.duration ?: 400L).coerceIn(50, 5000)
        val dm = resources.displayMetrics
        val maxR = (minOf(dm.widthPixels, dm.heightPixels) / 2f) * 0.8f
        val (r0, r1) = if (scale >= 1f) 60f to (60f * scale).coerceAtMost(maxR)
                       else maxR.coerceAtMost(400f) to (maxR.coerceAtMost(400f) * scale).coerceAtLeast(30f)
        fun stroke(sign: Int) = GestureDescription.StrokeDescription(
            Path().apply { moveTo(cx + sign * r0, cy); lineTo(cx + sign * r1, cy) }, 0, dur,
        )
        return dispatch(GestureDescription.Builder().addStroke(stroke(1)).addStroke(stroke(-1)).build())
    }

    private suspend fun dispatch(g: GestureDescription): Outcome = suspendCancellableCoroutine { cont ->
        val ok = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(gd: GestureDescription?) { if (cont.isActive) cont.resume(Outcome.Ok()) }
            override fun onCancelled(gd: GestureDescription?) { if (cont.isActive) cont.resume(Outcome.Fail("gesture cancelled")) }
        }, null)
        if (!ok && cont.isActive) cont.resume(Outcome.Fail("dispatchGesture returned false"))
    }

    /** Accessibility scroll on a scrollable node (found by text/id, else the biggest scrollable). */
    private fun scrollElement(a: Action): Outcome {
        val forward = a.direction != "backward"
        var node: AccessibilityNodeInfo? = null
        if (!a.text.isNullOrBlank() || !a.elementId.isNullOrBlank()) {
            node = findElements(a).firstOrNull()?.node
            var hops = 0
            while (node != null && !node.isScrollable && hops < 6) { node = node.parent; hops++ }
        }
        if (node == null || !node.isScrollable) {
            node = collectNodes().filter { it.node.isScrollable }.maxByOrNull { it.bounds.width() * it.bounds.height() }?.node
        }
        val n = node ?: return Outcome.Fail("no scrollable element found")
        val ok = n.performAction(if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
        return if (ok) Outcome.Ok(data = buildJsonObject { put("scrolled", true); put("direction", if (forward) "forward" else "backward"); n.viewIdResourceName?.let { put("id", it.substringAfter('/')) } })
        else Outcome.Fail("scroll action rejected (end of list?)")
    }

    private fun setClipboard(a: Action): Outcome {
        val text = a.text ?: return Outcome.Fail("set_clipboard requires text")
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("device-relay", text))
        var pasted = false
        if (a.paste == true) {
            val field = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                ?: collectNodes().firstOrNull { it.node.isEditable && it.node.isFocused }?.node
            pasted = field?.performAction(AccessibilityNodeInfo.ACTION_PASTE) == true
            if (!pasted && field != null) {
                val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, (field.text?.toString() ?: "") + text) }
                pasted = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            }
        }
        return Outcome.Ok(data = buildJsonObject { put("copied", text.length); put("pasted", pasted) })
    }

    fun deviceInfo(): JsonElement {
        val bm = getSystemService(BatteryManager::class.java)
        val pm = getSystemService(PowerManager::class.java)
        val km = getSystemService(KeyguardManager::class.java)
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm?.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        val net = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val ssid = runCatching {
            @Suppress("DEPRECATION")
            (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo?.ssid?.trim('"')
        }.getOrNull()?.takeIf { it != "<unknown ssid>" }
        val stat = runCatching { StatFs(Environment.getDataDirectory().path) }.getOrNull()
        val pkg = rootInActiveWindow?.packageName?.toString() ?: lastPackage
        return buildJsonObject {
            put("battery", batteryPercent())
            put("charging", bm?.isCharging == true)
            put("screenOn", pm.isInteractive)
            put("locked", km?.isKeyguardLocked == true)
            put("orientation", if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait")
            put("network", net)
            ssid?.let { put("wifiSsid", it) }
            stat?.let { put("freeStorageMb", it.availableBytes / 1_048_576) }
            put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("android", Build.VERSION.RELEASE)
            put("sdk", Build.VERSION.SDK_INT)
            put("notificationAccess", RelayNotificationListener.isEnabled)
            pkg?.let { put("package", it); appLabel(it)?.let { l -> put("label", l) } }
        }
    }

    fun batteryPercent(): Int {
        val bm = getSystemService(BatteryManager::class.java)
        val p = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        if (p in 0..100) return p
        val i = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return -1
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        return if (level >= 0) level * 100 / scale else -1
    }

    // ---------------------------------------------------------------- screenshot
    /** Grab a full-resolution ARGB frame (Android 11+). */
    private suspend fun captureBitmap(): Bitmap? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return suspendCoroutine { cont ->
            takeScreenshot(Display.DEFAULT_DISPLAY, screenshotExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val bmp = runCatching {
                        val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        hw?.copy(Bitmap.Config.ARGB_8888, true)
                    }.getOrNull()
                    result.hardwareBuffer.close()
                    cont.resume(bmp)
                }
                override fun onFailure(errorCode: Int) { cont.resume(null) }
            })
        }
    }

    private suspend fun screenshot(maxWidth: Int? = null, quality: Int? = null, format: String? = null, grid: Int? = null, region: Region? = null): Outcome {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return Outcome.Fail("screenshot requires Android 11+")
        var bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        return try {
            // optional crop (original px)
            var ox = 0; var oy = 0
            if (region != null) {
                val x = region.x.coerceIn(0, bmp.width - 1); val y = region.y.coerceIn(0, bmp.height - 1)
                val w = region.w.coerceIn(8, bmp.width - x); val h = region.h.coerceIn(8, bmp.height - y)
                bmp = Bitmap.createBitmap(bmp, x, y, w, h); ox = x; oy = y
            }
            // optional labelled coordinate grid (drawn at full res so labels stay readable after scaling)
            if (grid != null && grid >= 20) drawGrid(bmp, grid, ox, oy)
            val maxW = (maxWidth ?: 540).coerceIn(120, 2160)
            val scale = (maxW.toFloat() / bmp.width).coerceAtMost(1f)
            val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
            val out = ByteArrayOutputStream()
            val jpeg = format.equals("jpeg", true) || format.equals("jpg", true)
            scaled.compress(if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, (quality ?: 80).coerceIn(10, 100), out)
            val meta = buildJsonObject {
                if (region != null) { put("cropX", ox); put("cropY", oy); put("cropW", bmp.width); put("cropH", bmp.height) }
                if (grid != null && grid >= 20) put("grid", grid)
            }
            Outcome.Ok(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), data = if (meta.isEmpty()) null else meta, mime = if (jpeg) "image/jpeg" else "image/png")
        } catch (e: Exception) {
            Outcome.Fail("screenshot encode failed: ${e.message}")
        }
    }

    /** Draw grid lines every `step` px with coordinate labels (absolute screen coords, honouring crop offset). */
    private fun drawGrid(bmp: Bitmap, step: Int, ox: Int, oy: Int) {
        val c = android.graphics.Canvas(bmp)
        val line = android.graphics.Paint().apply { color = 0x66FF00FF.toInt(); strokeWidth = 2f }
        val major = android.graphics.Paint().apply { color = 0xAAFF00FF.toInt(); strokeWidth = 3f }
        val textSz = (bmp.width / 36f).coerceIn(18f, 40f)
        val txt = android.graphics.Paint().apply { color = 0xFFFFFF00.toInt(); textSize = textSz; isAntiAlias = true; setShadowLayer(3f, 0f, 0f, 0xFF000000.toInt()) }
        // vertical lines: start from first multiple of step >= ox
        var x = ((ox + step - 1) / step) * step
        while (x - ox < bmp.width) { val lx = (x - ox).toFloat(); c.drawLine(lx, 0f, lx, bmp.height.toFloat(), if (x % (step * 5) == 0) major else line); c.drawText(x.toString(), lx + 4f, textSz + 2f, txt); x += step }
        var y = ((oy + step - 1) / step) * step
        while (y - oy < bmp.height) { val ly = (y - oy).toFloat(); c.drawLine(0f, ly, bmp.width.toFloat(), ly, if (y % (step * 5) == 0) major else line); c.drawText(y.toString(), 4f, ly - 4f, txt); y += step }
    }

    // ---------------------------------------------------------------- v1.5 vision helpers
    private suspend fun pixels(points: List<SeqPoint>?): Outcome {
        if (points.isNullOrEmpty()) return Outcome.Fail("pixel requires points")
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        return Outcome.Ok(data = buildJsonObject {
            put("pixels", buildJsonArray {
                for (p in points) {
                    val x = p.x.toInt().coerceIn(0, bmp.width - 1); val y = p.y.toInt().coerceIn(0, bmp.height - 1)
                    val c = bmp.getPixel(x, y)
                    add(buildJsonObject { put("x", x); put("y", y); put("hex", String.format("#%06x", c and 0xFFFFFF)); put("r", (c shr 16) and 0xFF); put("g", (c shr 8) and 0xFF); put("b", c and 0xFF) })
                }
            })
        })
    }

    private suspend fun findColor(a: Action): Outcome {
        val hex = a.color?.removePrefix("#") ?: return Outcome.Fail("find_color requires color")
        val target = hex.toIntOrNull(16) ?: return Outcome.Fail("bad color")
        val tr = (target shr 16) and 0xFF; val tg = (target shr 8) and 0xFF; val tb = target and 0xFF
        val tol = (a.tolerance ?: 24).coerceIn(0, 128)
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        val rx = a.region?.x?.coerceIn(0, bmp.width - 1) ?: 0; val ry = a.region?.y?.coerceIn(0, bmp.height - 1) ?: 0
        val rw = a.region?.w?.coerceIn(1, bmp.width - rx) ?: (bmp.width - rx); val rh = a.region?.h?.coerceIn(1, bmp.height - ry) ?: (bmp.height - ry)
        // sample every 2px for speed on big screens
        val stepPx = if (rw * rh > 1_500_000) 3 else if (rw * rh > 400_000) 2 else 1
        val row = IntArray(rw)
        var minX = Int.MAX_VALUE; var minY = Int.MAX_VALUE; var maxX = -1; var maxY = -1; var count = 0L; var sumX = 0L; var sumY = 0L
        var y = ry
        while (y < ry + rh) {
            bmp.getPixels(row, 0, rw, rx, y, rw, 1)
            var i = 0
            while (i < rw) {
                val c = row[i]
                if (Math.abs(((c shr 16) and 0xFF) - tr) <= tol && Math.abs(((c shr 8) and 0xFF) - tg) <= tol && Math.abs((c and 0xFF) - tb) <= tol) {
                    val x = rx + i
                    count++; sumX += x; sumY += y
                    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
                }
                i += stepPx
            }
            y += stepPx
        }
        return Outcome.Ok(data = buildJsonObject {
            put("found", count > 0); put("count", count * stepPx * stepPx); put("sampleStep", stepPx)
            if (count > 0) {
                put("cx", (sumX / count).toInt()); put("cy", (sumY / count).toInt())
                put("bounds", buildJsonObject { put("x", minX); put("y", minY); put("w", maxX - minX + 1); put("h", maxY - minY + 1) })
            }
        })
    }

    /** Cheap perceptual hash of the frame (16x28 grey thumbnail → hex). Used by wait_for_screen. */
    private suspend fun screenHash(): Outcome {
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        val w = 16; val h = 28
        val small = Bitmap.createScaledBitmap(bmp, w, h, true)
        val px = IntArray(w * h); small.getPixels(px, 0, w, 0, 0, w, h)
        val grey = IntArray(w * h) { val c = px[it]; (((c shr 16) and 0xFF) * 3 + ((c shr 8) and 0xFF) * 6 + (c and 0xFF)) / 10 }
        val avg = grey.average()
        val sb = StringBuilder()
        var bits = 0; var n = 0
        for (g in grey) { bits = (bits shl 1) or (if (g > avg) 1 else 0); n++; if (n == 4) { sb.append(Integer.toHexString(bits)); bits = 0; n = 0 } }
        return Outcome.Ok(data = buildJsonObject { put("hash", sb.toString()); put("w", bmp.width); put("h", bmp.height) })
    }

    // ---------------------------------------------------------------- v1.6 reflexes (phone waits/reacts; agent does not poll)

    /** Shared colour-match scan. Returns (count, cx, cy, bounds) for pixels within tol of target in region. */
    /**
     * v3.1 colour matcher. mode "rgb" = per-channel tolerance (default). mode "hue" = compare hue (0-360) within tol degrees
     * and require saturation/value above minSat/minVal — robust to lighting/shading changes on 3D objects (enemy outlines, name tags).
     */
    class ColorMatcher(hex: String, private val tol: Int, private val mode: String = "rgb") {
        private val target = hex.removePrefix("#").toIntOrNull(16) ?: 0
        private val tr = (target shr 16) and 0xFF; private val tg = (target shr 8) and 0xFF; private val tb = target and 0xFF
        private val th: Float; private val ts: Float
        init { val hsv = FloatArray(3); android.graphics.Color.RGBToHSV(tr, tg, tb, hsv); th = hsv[0]; ts = hsv[1] }
        private val hsvTmp = FloatArray(3)
        fun matches(c: Int): Boolean {
            val r = (c shr 16) and 0xFF; val g = (c shr 8) and 0xFF; val b = c and 0xFF
            if (mode != "hue") return Math.abs(r - tr) <= tol && Math.abs(g - tg) <= tol && Math.abs(b - tb) <= tol
            val mx = maxOf(r, g, b); val mn = minOf(r, g, b)
            if (mx < 60) return false                                  // too dark to have a hue
            val sat = (mx - mn).toFloat() / mx
            if (sat < Math.max(0.25f, ts * 0.45f)) return false         // washed-out pixels don't count
            android.graphics.Color.RGBToHSV(r, g, b, hsvTmp)
            var dh = Math.abs(hsvTmp[0] - th); if (dh > 180f) dh = 360f - dh
            return dh <= tol
        }
    }

    private fun scanColor(bmp: Bitmap, hex: String, tol: Int, region: Region?, mode: String = "rgb"): JsonObject {
        val m = ColorMatcher(hex, tol, mode)
        val rx = region?.x?.coerceIn(0, bmp.width - 1) ?: 0; val ry = region?.y?.coerceIn(0, bmp.height - 1) ?: 0
        val rw = region?.w?.coerceIn(1, bmp.width - rx) ?: (bmp.width - rx); val rh = region?.h?.coerceIn(1, bmp.height - ry) ?: (bmp.height - ry)
        val stepPx = if (rw * rh > 1_500_000) 3 else if (rw * rh > 400_000) 2 else 1
        val row = IntArray(rw)
        var minX = Int.MAX_VALUE; var minY = Int.MAX_VALUE; var maxX = -1; var maxY = -1; var count = 0L; var sumX = 0L; var sumY = 0L
        var y = ry
        while (y < ry + rh) {
            bmp.getPixels(row, 0, rw, rx, y, rw, 1)
            var i = 0
            while (i < rw) {
                val c = row[i]
                if (m.matches(c)) {
                    val x = rx + i; count++; sumX += x; sumY += y
                    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
                }
                i += stepPx
            }
            y += stepPx
        }
        return buildJsonObject {
            put("found", count > 0); put("count", count * stepPx * stepPx)
            if (count > 0) { put("cx", (sumX / count).toInt()); put("cy", (sumY / count).toInt()); put("bounds", buildJsonObject { put("x", minX); put("y", minY); put("w", maxX - minX + 1); put("h", maxY - minY + 1) }) }
        }
    }

    // ---------------------------------------------------------------- v1.9 object detection + phone-side reflex loop

    /**
     * Connected-component labelling of colour matches on a downsampled grid (cell = stepPx).
     * Returns blobs sorted by area desc: {i, cx, cy, area, bounds}. Area is in original px (approx).
     */
    private fun scanObjects(bmp: Bitmap, hex: String, tol: Int, region: Region?, minSize: Int, maxResults: Int, mode: String = "rgb"): JsonObject {
        val m = ColorMatcher(hex, tol, mode)
        val rx = region?.x?.coerceIn(0, bmp.width - 1) ?: 0; val ry = region?.y?.coerceIn(0, bmp.height - 1) ?: 0
        val rw = region?.w?.coerceIn(1, bmp.width - rx) ?: (bmp.width - rx); val rh = region?.h?.coerceIn(1, bmp.height - ry) ?: (bmp.height - ry)
        val step = if (rw * rh > 1_500_000) 4 else if (rw * rh > 400_000) 3 else 2
        val gw = (rw + step - 1) / step; val gh = (rh + step - 1) / step
        val mask = BooleanArray(gw * gh)
        val row = IntArray(rw)
        var gy = 0
        while (gy < gh) {
            val y = ry + gy * step
            bmp.getPixels(row, 0, rw, rx, y, rw, 1)
            var gx = 0
            while (gx < gw) {
                val c = row[gx * step]
                if (m.matches(c)) mask[gy * gw + gx] = true
                gx++
            }
            gy++
        }
        // BFS labelling (4-connectivity)
        val labels = IntArray(gw * gh)
        data class Blob(var n: Int = 0, var sx: Long = 0, var sy: Long = 0, var minX: Int = Int.MAX_VALUE, var minY: Int = Int.MAX_VALUE, var maxX: Int = -1, var maxY: Int = -1)
        val blobs = ArrayList<Blob>()
        val queue = IntArray(gw * gh)
        var total = 0
        for (start in mask.indices) {
            if (!mask[start] || labels[start] != 0) continue
            val id = blobs.size + 1; val b = Blob(); blobs.add(b); total++
            var head = 0; var tail = 0; queue[tail++] = start; labels[start] = id
            while (head < tail) {
                val idx = queue[head++]; val cx = idx % gw; val cy = idx / gw
                b.n++; b.sx += cx; b.sy += cy
                if (cx < b.minX) b.minX = cx; if (cx > b.maxX) b.maxX = cx; if (cy < b.minY) b.minY = cy; if (cy > b.maxY) b.maxY = cy
                if (cx > 0) { val j = idx - 1; if (mask[j] && labels[j] == 0) { labels[j] = id; queue[tail++] = j } }
                if (cx < gw - 1) { val j = idx + 1; if (mask[j] && labels[j] == 0) { labels[j] = id; queue[tail++] = j } }
                if (cy > 0) { val j = idx - gw; if (mask[j] && labels[j] == 0) { labels[j] = id; queue[tail++] = j } }
                if (cy < gh - 1) { val j = idx + gw; if (mask[j] && labels[j] == 0) { labels[j] = id; queue[tail++] = j } }
            }
        }
        val minCells = Math.max(1, minSize / step)
        val kept = blobs.filter { (it.maxX - it.minX + 1) >= minCells && (it.maxY - it.minY + 1) >= minCells }.sortedByDescending { it.n }.take(maxResults)
        return buildJsonObject {
            put("found", kept.isNotEmpty()); put("count", kept.size); put("total", total); put("sampleStep", step)
            put("objects", buildJsonArray {
                kept.forEachIndexed { i, b ->
                    add(buildJsonObject {
                        put("i", i); put("cx", rx + (b.sx / b.n).toInt() * step + step / 2); put("cy", ry + (b.sy / b.n).toInt() * step + step / 2)
                        put("area", b.n * step * step)
                        put("bounds", buildJsonObject { put("x", rx + b.minX * step); put("y", ry + b.minY * step); put("w", (b.maxX - b.minX + 1) * step); put("h", (b.maxY - b.minY + 1) * step) })
                    })
                }
            })
        }
    }

    private suspend fun findObjects(a: Action): Outcome {
        val color = a.color ?: return Outcome.Fail("find_objects requires color")
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        return Outcome.Ok(data = scanObjects(bmp, color, (a.tolerance ?: 24).coerceIn(0, 128), a.region, (a.minSize ?: 12).coerceIn(1, 2000), (a.maxResults ?: 10).coerceIn(1, 40), a.match ?: "rgb"))
    }

    // ---------------------------------------------------------------- v2.1 colour discovery + motion tracking

    /** Dominant colours: quantise each sampled pixel to a bucket, count, skip greys, report top buckets with average colour + centroid. */
    private suspend fun sampleColors(a: Action): Outcome {
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        val region = a.region
        val rx = region?.x?.coerceIn(0, bmp.width - 1) ?: 0; val ry = region?.y?.coerceIn(0, bmp.height - 1) ?: 0
        val rw = region?.w?.coerceIn(1, bmp.width - rx) ?: (bmp.width - rx); val rh = region?.h?.coerceIn(1, bmp.height - ry) ?: (bmp.height - ry)
        val q = (a.quant ?: 32).coerceIn(8, 64); val maxColors = (a.maxColors ?: 8).coerceIn(1, 24); val skipGrey = a.ignoreGrey != false
        val step = if (rw * rh > 1_500_000) 6 else if (rw * rh > 400_000) 4 else 2
        class Bucket(var n: Long = 0, var r: Long = 0, var g: Long = 0, var b: Long = 0, var sx: Long = 0, var sy: Long = 0)
        val buckets = HashMap<Int, Bucket>()
        val row = IntArray(rw); var analysed = 0L
        var y = ry
        while (y < ry + rh) {
            bmp.getPixels(row, 0, rw, rx, y, rw, 1)
            var i = 0
            while (i < rw) {
                val c = row[i]; val r = (c shr 16) and 0xFF; val g = (c shr 8) and 0xFF; val b = c and 0xFF
                analysed++
                val mx = maxOf(r, g, b); val mn = minOf(r, g, b)
                if (!skipGrey || (mx - mn) >= 40) {
                    val key = (r / q shl 16) or (g / q shl 8) or (b / q)
                    val bk = buckets.getOrPut(key) { Bucket() }
                    bk.n++; bk.r += r; bk.g += g; bk.b += b; bk.sx += (rx + i); bk.sy += y
                }
                i += step
            }
            y += step
        }
        val top = buckets.values.sortedByDescending { it.n }.take(maxColors)
        return Outcome.Ok(data = buildJsonObject {
            put("analysedPx", analysed); put("quant", q); put("sampleStep", step)
            if (region != null) put("region", buildJsonObject { put("x", rx); put("y", ry); put("w", rw); put("h", rh) })
            put("colors", buildJsonArray {
                for (bk in top) add(buildJsonObject {
                    put("hex", String.format("#%02x%02x%02x", (bk.r / bk.n).toInt(), (bk.g / bk.n).toInt(), (bk.b / bk.n).toInt()))
                    put("share", Math.round(bk.n * 1000.0 / analysed) / 10.0)
                    put("count", bk.n * step * step)
                    put("cx", (bk.sx / bk.n).toInt()); put("cy", (bk.sy / bk.n).toInt())
                })
            })
        })
    }

    /** Sample a colour blob's centre N times and fit velocity (least squares) to predict where it will be. */
    private suspend fun trackObject(a: Action): Outcome {
        val color = a.color ?: return Outcome.Fail("track_object requires color")
        val tol = (a.tolerance ?: 24).coerceIn(0, 128); val minCount = (a.minCount ?: 20).coerceAtLeast(1)
        val n = (a.samples ?: 5).coerceIn(2, 12); val interval = (a.intervalMs ?: 120L).coerceIn(40, 1000); val predictMs = (a.predictMs ?: 300L).coerceIn(0, 3000)
        val t0 = android.os.SystemClock.elapsedRealtime()
        val ts = ArrayList<Long>(); val xs = ArrayList<Int>(); val ys = ArrayList<Int>(); val counts = ArrayList<Long>()
        for (i in 0 until n) {
            val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
            val r = scanColor(bmp, color, tol, a.region)
            val count = r["count"]?.toString()?.toLongOrNull() ?: 0L
            if (count >= minCount) {
                ts.add(android.os.SystemClock.elapsedRealtime() - t0); xs.add(r["cx"]?.toString()?.toIntOrNull() ?: 0); ys.add(r["cy"]?.toString()?.toIntOrNull() ?: 0); counts.add(count)
            }
            if (i < n - 1) delay(interval)
        }
        if (xs.isEmpty()) return Outcome.Ok(data = buildJsonObject { put("found", false); put("visible", 0); put("samples", buildJsonArray {}) })
        val samplesJson = buildJsonArray { for (i in xs.indices) add(buildJsonObject { put("t", ts[i]); put("x", xs[i]); put("y", ys[i]); put("count", counts[i]) }) }
        // least-squares slope of x(t), y(t) in px/s
        fun slope(v: List<Int>): Double {
            if (v.size < 2) return 0.0
            val mt = ts.average(); val mv = v.average()
            var num = 0.0; var den = 0.0
            for (i in v.indices) { val dt = ts[i] - mt; num += dt * (v[i] - mv); den += dt * dt }
            return if (den == 0.0) 0.0 else num / den * 1000.0
        }
        val vx = slope(xs); val vy = slope(ys)
        val speed = Math.hypot(vx, vy)
        val angle = Math.toDegrees(Math.atan2(vy, vx))
        val dir = if (speed < 15) "still" else when {
            angle > -45 && angle <= 45 -> "right"; angle > 45 && angle <= 135 -> "down"; angle > -135 && angle <= -45 -> "up"; else -> "left"
        }
        val lastX = xs.last(); val lastY = ys.last()
        return Outcome.Ok(data = buildJsonObject {
            put("found", true); put("visible", xs.size); put("samples", samplesJson)
            put("cx", lastX); put("cy", lastY)
            put("vx", Math.round(vx)); put("vy", Math.round(vy)); put("speed", Math.round(speed)); put("direction", dir); put("angle", Math.round(angle))
            put("predicted", buildJsonObject { put("x", Math.round(lastX + vx * predictMs / 1000.0).toInt()); put("y", Math.round(lastY + vy * predictMs / 1000.0).toInt()); put("inMs", predictMs) })
        })
    }

    /** Phone-side reflex loop: watch a colour, tap the instant it appears, repeat. No network round-trips between taps. */
    private suspend fun autoReact(a: Action): Outcome {
        val color = a.color ?: return Outcome.Fail("auto_react requires color")
        val tol = (a.tolerance ?: 24).coerceIn(0, 128)
        val minCount = (a.minCount ?: 20).coerceAtLeast(1)
        val maxTriggers = (a.maxTriggers ?: 20).coerceIn(1, 200)
        val timeout = (a.timeoutMs ?: 10_000L).coerceIn(500, 40_000)
        val interval = (a.intervalMs ?: 80L).coerceIn(30, 2000)
        val cooldown = (a.cooldownMs ?: 250L).coerceIn(0, 5000)
        // v2.0: lane 0 = top-level fields; extra lanes each have their own colour/region/reaction + cooldown
        val lanes: List<ReactLane> = listOf(ReactLane(color = color, tolerance = tol, region = a.region, minCount = minCount, tapX = a.tapX, tapY = a.tapY, tapOffsetX = a.tapOffsetX, tapOffsetY = a.tapOffsetY, cooldownMs = cooldown, name = "lane0")) + (a.lanes ?: emptyList())
        val readyAt = LongArray(lanes.size) // per-lane cooldown deadline (elapsedRealtime)
        val stopColor = a.stopColor; val stopMin = (a.stopMinCount ?: 200).coerceAtLeast(1)
        val t0 = android.os.SystemClock.elapsedRealtime()
        var polls = 0; var triggers = 0; var stoppedBy = "timeout"
        val taps = ArrayList<JsonObject>()
        outer@ while (android.os.SystemClock.elapsedRealtime() - t0 < timeout) {
            val bmp = captureBitmap()
            if (bmp == null) { stoppedBy = "screenshot failed"; break }
            polls++
            val now = android.os.SystemClock.elapsedRealtime()
            if (stopColor != null) {
                val s = scanColor(bmp, stopColor, tol, a.stopRegion)
                if ((s["count"]?.toString()?.toLongOrNull() ?: 0L) >= stopMin) { stoppedBy = "stopColor"; break }
            }
            var fired = false
            for (li in lanes.indices) {
                if (now < readyAt[li]) continue
                val l = lanes[li]
                val r = scanColor(bmp, l.color, (l.tolerance ?: tol).coerceIn(0, 128), l.region)
                val count = r["count"]?.toString()?.toLongOrNull() ?: 0L
                if (count < (l.minCount ?: minCount).coerceAtLeast(1)) continue
                val cx = r["cx"]?.toString()?.toIntOrNull() ?: 0; val cy = r["cy"]?.toString()?.toIntOrNull() ?: 0
                val tx = (l.tapX ?: (cx + (l.tapOffsetX ?: 0))).toFloat(); val ty = (l.tapY ?: (cy + (l.tapOffsetY ?: 0))).toFloat()
                val sw = l.swipe
                val g = if (sw != null) {
                    val p = Path().apply { moveTo(tx, ty); lineTo(tx + sw.dx, ty + sw.dy) }
                    gesture(p, (sw.durationMs ?: 120L).coerceIn(20, 3000))
                } else gesture(tapPath(tx, ty), 40)
                triggers++; fired = true
                val at = android.os.SystemClock.elapsedRealtime() - t0
                taps.add(buildJsonObject {
                    put("t", at); put("lane", li); l.name?.let { put("name", it) }
                    put("x", tx.toInt()); put("y", ty.toInt()); put("count", count); put("ok", g is Outcome.Ok)
                    if (sw != null) { put("swipe", true); put("x2", (tx + sw.dx).toInt()); put("y2", (ty + sw.dy).toInt()) }
                })
                readyAt[li] = android.os.SystemClock.elapsedRealtime() + (l.cooldownMs ?: cooldown).coerceIn(0, 5000)
                if (triggers >= maxTriggers) { stoppedBy = "maxTriggers"; break@outer }
            }
            if (!fired) delay(interval)
        }
        val tapsJson = buildJsonArray { for (t in taps) add(t) }
        return Outcome.Ok(data = buildJsonObject { put("triggers", triggers); put("taps", tapsJson); put("polls", polls); put("lanes", lanes.size); put("stoppedBy", stoppedBy); put("elapsedMs", android.os.SystemClock.elapsedRealtime() - t0) })
    }

    private suspend fun watchColor(a: Action): Outcome {
        val color = a.color ?: return Outcome.Fail("watch_color requires color")
        val tol = (a.tolerance ?: 24).coerceIn(0, 128); val appear = a.appear != false
        val timeout = (a.timeoutMs ?: 5000L).coerceIn(200, 30_000); val interval = (a.intervalMs ?: 150L).coerceIn(50, 2000)
        val minCount = (a.minCount ?: 20).coerceAtLeast(1)
        val t0 = android.os.SystemClock.elapsedRealtime(); var polls = 0; var last: JsonObject? = null
        while (android.os.SystemClock.elapsedRealtime() - t0 < timeout) {
            val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
            val r = scanColor(bmp, color, tol, a.region); polls++; last = r
            val present = (r["count"]?.toString()?.toLongOrNull() ?: 0L) >= minCount
            if (present == appear) return Outcome.Ok(data = buildJsonObject { put("matched", true); put("appear", appear); put("waitedMs", android.os.SystemClock.elapsedRealtime() - t0); put("polls", polls); for ((k, v) in r) put(k, v) })
            delay(interval)
        }
        return Outcome.Fail("color ${if (appear) "did not appear" else "did not disappear"} within ${timeout}ms (polls=$polls, lastCount=${last?.get("count")})")
    }

    private suspend fun waitPixel(a: Action): Outcome {
        val x = a.x?.toInt() ?: return Outcome.Fail("missing x"); val y = a.y?.toInt() ?: return Outcome.Fail("missing y")
        val target = a.color?.removePrefix("#")?.toIntOrNull(16) ?: return Outcome.Fail("wait_pixel requires color")
        val tr = (target shr 16) and 0xFF; val tg = (target shr 8) and 0xFF; val tb = target and 0xFF
        val tol = (a.tolerance ?: 24).coerceIn(0, 128); val appear = a.appear != false
        val timeout = (a.timeoutMs ?: 5000L).coerceIn(200, 30_000); val interval = (a.intervalMs ?: 100L).coerceIn(50, 2000)
        val t0 = android.os.SystemClock.elapsedRealtime(); var polls = 0; var lastHex = ""
        while (android.os.SystemClock.elapsedRealtime() - t0 < timeout) {
            val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
            val c = bmp.getPixel(x.coerceIn(0, bmp.width - 1), y.coerceIn(0, bmp.height - 1)); polls++
            lastHex = String.format("#%06x", c and 0xFFFFFF)
            val match = Math.abs(((c shr 16) and 0xFF) - tr) <= tol && Math.abs(((c shr 8) and 0xFF) - tg) <= tol && Math.abs((c and 0xFF) - tb) <= tol
            if (match == appear) return Outcome.Ok(data = buildJsonObject { put("matched", true); put("appear", appear); put("hex", lastHex); put("waitedMs", android.os.SystemClock.elapsedRealtime() - t0); put("polls", polls); put("cx", x); put("cy", y) })
            delay(interval)
        }
        return Outcome.Fail("pixel ${if (appear) "did not match" else "kept matching"} within ${timeout}ms (last=$lastHex, polls=$polls)")
    }

    /** Frame-to-frame change map. Keeps a small grey thumbnail of the previous frame. */
    private var diffPrev: IntArray? = null
    private var diffPrevCols = 0; private var diffPrevRows = 0
    private suspend fun screenDiff(a: Action): Outcome {
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        val cell = (a.cell ?: 60).coerceIn(20, 400); val thr = (a.threshold?.toInt() ?: 32).coerceIn(4, 128)
        val cols = (bmp.width + cell - 1) / cell; val rows = (bmp.height + cell - 1) / cell
        val small = Bitmap.createScaledBitmap(bmp, cols, rows, true)
        val px = IntArray(cols * rows); small.getPixels(px, 0, cols, 0, 0, cols, rows)
        val grey = IntArray(cols * rows) { val c = px[it]; (((c shr 16) and 0xFF) * 3 + ((c shr 8) and 0xFF) * 6 + (c and 0xFF)) / 10 }
        val prev = diffPrev
        diffPrev = grey; diffPrevCols = cols; diffPrevRows = rows
        if (prev == null || prev.size != grey.size) return Outcome.Ok(data = buildJsonObject { put("baseline", true); put("changedPct", 0); put("cells", cols * rows) })
        // changed cells → merge into regions (simple row-scan of flagged cells into boxes)
        val changed = BooleanArray(grey.size) { Math.abs(grey[it] - prev[it]) >= thr }
        val n = changed.count { it }
        val regions = buildJsonArray {
            val seen = BooleanArray(grey.size)
            var emitted = 0
            for (idx in changed.indices) {
                if (!changed[idx] || seen[idx] || emitted >= 12) continue
                // flood fill 4-neighbour
                var minC = Int.MAX_VALUE; var minR = Int.MAX_VALUE; var maxC = -1; var maxR = -1; var size = 0
                val stack = ArrayDeque<Int>(); stack.add(idx); seen[idx] = true
                while (stack.isNotEmpty()) {
                    val k = stack.removeLast(); size++
                    val cc = k % cols; val rr = k / cols
                    if (cc < minC) minC = cc; if (cc > maxC) maxC = cc; if (rr < minR) minR = rr; if (rr > maxR) maxR = rr
                    for ((dc, dr) in listOf(1 to 0, -1 to 0, 0 to 1, 0 to -1)) {
                        val nc = cc + dc; val nr = rr + dr
                        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
                        val nk = nr * cols + nc
                        if (changed[nk] && !seen[nk]) { seen[nk] = true; stack.add(nk) }
                    }
                }
                val x = minC * cell; val y = minR * cell; val w = ((maxC - minC + 1) * cell).coerceAtMost(bmp.width - x); val h = ((maxR - minR + 1) * cell).coerceAtMost(bmp.height - y)
                add(buildJsonObject { put("x", x); put("y", y); put("w", w); put("h", h); put("cx", x + w / 2); put("cy", y + h / 2); put("cells", size) })
                emitted++
            }
        }
        return Outcome.Ok(data = buildJsonObject { put("changedPct", Math.round(n * 1000.0 / grey.size) / 10.0); put("changedCells", n); put("cells", grey.size); put("regions", regions) })
    }

    /** Template matching (normalised cross-correlation on downscaled grey, refined at full res). */
    private suspend fun findImage(a: Action): Outcome {
        val b64 = a.image ?: return Outcome.Fail("find_image requires image")
        val tplBytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() ?: return Outcome.Fail("bad base64")
        val tplFull = android.graphics.BitmapFactory.decodeByteArray(tplBytes, 0, tplBytes.size) ?: return Outcome.Fail("cannot decode template image")
        val screen = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        val thr = (a.threshold ?: 0.85f).coerceIn(0.5f, 1f); val maxRes = (a.maxResults ?: 5).coerceIn(1, 20)
        val rx = a.region?.x?.coerceIn(0, screen.width - 1) ?: 0; val ry = a.region?.y?.coerceIn(0, screen.height - 1) ?: 0
        val rw = a.region?.w?.coerceIn(1, screen.width - rx) ?: (screen.width - rx); val rh = a.region?.h?.coerceIn(1, screen.height - ry) ?: (screen.height - ry)
        if (tplFull.width > rw || tplFull.height > rh) return Outcome.Fail("template larger than search region")
        // downscale factor so the search area is <= ~250k px
        val f = Math.max(1, Math.ceil(Math.sqrt(rw.toDouble() * rh / 250_000.0)).toInt())
        val sw = rw / f; val sh = rh / f; val tw = Math.max(2, tplFull.width / f); val th = Math.max(2, tplFull.height / f)
        if (tw >= sw || th >= sh) return Outcome.Fail("template too large relative to region")
        val sBmp = Bitmap.createScaledBitmap(Bitmap.createBitmap(screen, rx, ry, rw, rh), sw, sh, true)
        val tBmp = Bitmap.createScaledBitmap(tplFull, tw, th, true)
        fun grey(b: Bitmap): FloatArray { val p = IntArray(b.width * b.height); b.getPixels(p, 0, b.width, 0, 0, b.width, b.height); return FloatArray(p.size) { val c = p[it]; ((((c shr 16) and 0xFF) * 3 + ((c shr 8) and 0xFF) * 6 + (c and 0xFF)) / 10).toFloat() } }
        val S = grey(sBmp); val T = grey(tBmp)
        val tMean = T.average().toFloat(); var tVar = 0f; for (v in T) tVar += (v - tMean) * (v - tMean)
        if (tVar < 1e-3f) return Outcome.Fail("template is flat (single colour) — use find_color instead")
        val tNorm = Math.sqrt(tVar.toDouble()).toFloat()
        val scores = ArrayList<Triple<Float, Int, Int>>()
        val step = if (sw * sh > 120_000) 2 else 1
        var y = 0
        while (y + th <= sh) {
            var x = 0
            while (x + tw <= sw) {
                var sSum = 0f; var sSq = 0f; var cross = 0f
                for (j in 0 until th) { val rowS = (y + j) * sw + x; val rowT = j * tw; for (i in 0 until tw) { val sv = S[rowS + i]; val tv = T[rowT + i] - tMean; sSum += sv; sSq += sv * sv; cross += sv * tv } }
                val nPx = (tw * th).toFloat(); val sMean = sSum / nPx
                val sVar = sSq - nPx * sMean * sMean
                val score = if (sVar <= 1e-3f) 0f else (cross / (Math.sqrt(sVar.toDouble()).toFloat() * tNorm))
                if (score >= thr) scores.add(Triple(score, x, y))
                x += step
            }
            y += step
        }
        scores.sortByDescending { it.first }
        // non-max suppression
        val picked = ArrayList<Triple<Float, Int, Int>>()
        for (s in scores) { if (picked.none { Math.abs(it.second - s.second) < tw / 2 && Math.abs(it.third - s.third) < th / 2 }) picked.add(s); if (picked.size >= maxRes) break }
        return Outcome.Ok(data = buildJsonObject {
            put("found", picked.isNotEmpty()); put("count", picked.size); put("scale", f)
            put("matches", buildJsonArray { for ((sc, x, y) in picked) { val ox = rx + x * f; val oy = ry + y * f; add(buildJsonObject { put("score", Math.round(sc * 1000) / 1000.0); put("x", ox); put("y", oy); put("w", tplFull.width); put("h", tplFull.height); put("cx", ox + tplFull.width / 2); put("cy", oy + tplFull.height / 2) }) } })
        })
    }

    // ---------------------------------------------------------------- v1.7 OCR + multi-colour
    /** Public so the connection service can grab preview frames. */
    suspend fun previewFrame(maxWidth: Int, quality: Int): Pair<ByteArray, String>? {
        val bmp = captureBitmap() ?: return null
        val scale = (maxWidth.toFloat() / bmp.width).coerceAtMost(1f)
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
        val out = ByteArrayOutputStream(); scaled.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(10, 90), out)
        return out.toByteArray() to "image/jpeg"
    }

    private fun recognizerFor(lang: String?) = when (lang) {
        "zh" -> com.google.mlkit.vision.text.TextRecognition.getClient(com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions.Builder().build())
        "ja" -> com.google.mlkit.vision.text.TextRecognition.getClient(com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions.Builder().build())
        "ko" -> com.google.mlkit.vision.text.TextRecognition.getClient(com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions.Builder().build())
        "hi" -> com.google.mlkit.vision.text.TextRecognition.getClient(com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions.Builder().build())
        else -> com.google.mlkit.vision.text.TextRecognition.getClient(com.google.mlkit.vision.text.latin.TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    private suspend fun readText(a: Action): Outcome {
        var bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        var ox = 0; var oy = 0
        a.region?.let { r ->
            val x = r.x.coerceIn(0, bmp.width - 1); val y = r.y.coerceIn(0, bmp.height - 1)
            val w = r.w.coerceIn(8, bmp.width - x); val h = r.h.coerceIn(8, bmp.height - y)
            bmp = Bitmap.createBitmap(bmp, x, y, w, h); ox = x; oy = y
        }
        val recognizer = recognizerFor(a.lang)
        return try {
            val result: Text = recognizer.process(InputImage.fromBitmap(bmp, 0)).await()
            val lines = buildJsonArray {
                for (block: Text.TextBlock in result.textBlocks) for (line: Text.Line in block.lines) {
                    val b: Rect = line.boundingBox ?: continue
                    add(buildJsonObject {
                        put("text", line.text)
                        put("x", b.left + ox); put("y", b.top + oy); put("w", b.width()); put("h", b.height())
                        put("cx", b.centerX() + ox); put("cy", b.centerY() + oy)
                        put("confidence", Math.round(line.confidence * 100) / 100.0)
                    })
                }
            }
            Outcome.Ok(data = buildJsonObject { put("count", lines.size); put("lines", lines); put("text", result.text.take(4000)); if (a.region != null) put("region", buildJsonObject { put("x", ox); put("y", oy); put("w", bmp.width); put("h", bmp.height) }) })
        } catch (e: Exception) {
            Outcome.Fail("ocr failed: ${e.message}")
        } finally { runCatching { recognizer.close() } }
    }

    // ---------------------------------------------------------------- v2.6 BotEngine hooks (public, run on Main)
    suspend fun captureForBot(): Bitmap? = captureBitmap()
    fun scanColorPublic(bmp: Bitmap, hex: String, tol: Int, region: Region?, mode: String = "rgb"): JsonObject = scanColor(bmp, hex, tol, region, mode)
    fun scanObjectsPublic(bmp: Bitmap, hex: String, tol: Int, region: Region?, minSize: Int, maxResults: Int, mode: String = "rgb"): JsonObject = scanObjects(bmp, hex, tol, region, minSize, maxResults, mode)
    fun currentPackage(): String? = rootInActiveWindow?.packageName?.toString() ?: lastPackage
    /** OCR lines as (text, centre) for bot conditions; latin recognizer, reused across ticks. */
    private val botRecognizer by lazy { recognizerFor(null) }
    suspend fun readTextPublic(bmp0: Bitmap, region: Region?): List<Pair<String, Pair<Int, Int>>> {
        var bmp = bmp0; var ox = 0; var oy = 0
        region?.let { r ->
            val x = r.x.coerceIn(0, bmp.width - 1); val y = r.y.coerceIn(0, bmp.height - 1)
            val w = r.w.coerceIn(8, bmp.width - x); val h = r.h.coerceIn(8, bmp.height - y)
            bmp = Bitmap.createBitmap(bmp, x, y, w, h); ox = x; oy = y
        }
        return try {
            val result: Text = botRecognizer.process(InputImage.fromBitmap(bmp, 0)).await()
            val out = ArrayList<Pair<String, Pair<Int, Int>>>()
            for (block: Text.TextBlock in result.textBlocks) for (line: Text.Line in block.lines) { val b: Rect = line.boundingBox ?: continue; out.add(line.text to ((b.centerX() + ox) to (b.centerY() + oy))) }
            out
        } catch (e: Exception) { emptyList() }
    }

    private suspend fun findColors(a: Action): Outcome {
        val colors = a.colors?.take(8) ?: return Outcome.Fail("find_colors requires colors")
        val bmp = captureBitmap() ?: return Outcome.Fail("screenshot failed")
        val tol = (a.tolerance ?: 24).coerceIn(0, 128)
        return Outcome.Ok(data = buildJsonObject {
            put("results", buildJsonArray { for (c in colors) add(buildJsonObject { put("color", c); for ((k, v) in scanColor(bmp, c, tol, a.region)) put(k, v) }) })
        })
    }

    // ---------------------------------------------------------------- v1.5 precision input
    // ---------------------------------------------------------------- v2.5 multi-touch engine
    // Persistent "fingers": a finger is a stroke chain (willContinue=true) that stays down until finger_up.
    // While a finger is down, other gestures (taps, other fingers) can be dispatched concurrently in the same builder.
    private class Finger(var x: Float, var y: Float, var stroke: GestureDescription.StrokeDescription, val since: Long)
    private val fingers = HashMap<Int, Finger>()

    /** Dispatch strokes for the given fingers as ONE gesture (they must share a GestureDescription to be simultaneous). */
    private suspend fun dispatchStrokes(strokes: List<GestureDescription.StrokeDescription>): Outcome {
        if (strokes.isEmpty()) return Outcome.Ok()
        val b = GestureDescription.Builder()
        for (s in strokes.take(10)) b.addStroke(s)
        return dispatch(b.build())
    }

    /** Put finger `id` down at (x,y) and keep it there (willContinue). */
    private suspend fun fingerDown(a: Action): Outcome {
        val id = (a.finger ?: 0).coerceIn(0, 3); val x = a.x ?: return Outcome.Fail("missing x"); val y = a.y ?: return Outcome.Fail("missing y")
        if (fingers.containsKey(id)) return Outcome.Fail("finger $id already down; finger_up first")
        if (fingers.size >= 4) return Outcome.Fail("max 4 fingers")
        val hold = (a.duration ?: 60L).coerceIn(20, 1000)
        val s = GestureDescription.StrokeDescription(Path().apply { moveTo(x, y) }, 0, hold, true)
        val r = dispatchStrokes(listOf(s))
        if (r is Outcome.Fail) return r
        fingers[id] = Finger(x, y, s, android.os.SystemClock.elapsedRealtime())
        return Outcome.Ok(data = buildJsonObject { put("finger", id); put("x", x.toInt()); put("y", y.toInt()); put("down", fingers.size) })
    }

    /** Move finger `id` to (x,y) over duration ms (path may include intermediate points). Stays down afterwards. */
    private suspend fun fingerMove(a: Action): Outcome {
        val id = (a.finger ?: 0).coerceIn(0, 3)
        val f = fingers[id] ?: return Outcome.Fail("finger $id is not down; finger_down first")
        val pts = a.points?.takeIf { it.isNotEmpty() } ?: listOfNotNull(if (a.x != null && a.y != null) SeqPoint(a.x, a.y) else null)
        if (pts.isEmpty()) return Outcome.Fail("finger_move requires x,y or points")
        val dur = (a.duration ?: 150L).coerceIn(20, 10_000)
        val path = Path().apply { moveTo(f.x, f.y); for (p in pts) lineTo(p.x, p.y) }
        val s = f.stroke.continueStroke(path, 0, dur, true)
        val r = dispatchStrokes(listOf(s))
        if (r is Outcome.Fail) return r
        f.stroke = s; f.x = pts.last().x; f.y = pts.last().y
        return Outcome.Ok(data = buildJsonObject { put("finger", id); put("x", f.x.toInt()); put("y", f.y.toInt()) })
    }

    /** Lift finger `id` (or all fingers when finger=-1). */
    private suspend fun fingerUp(a: Action): Outcome {
        val ids = if (a.finger == -1) fingers.keys.toList() else listOf((a.finger ?: 0).coerceIn(0, 3))
        val strokes = ArrayList<GestureDescription.StrokeDescription>()
        for (id in ids) { val f = fingers[id] ?: continue; strokes.add(f.stroke.continueStroke(Path().apply { moveTo(f.x, f.y) }, 0, 20, false)) }
        if (strokes.isEmpty()) return Outcome.Ok(data = buildJsonObject { put("lifted", 0); put("down", fingers.size) })
        val r = dispatchStrokes(strokes)
        for (id in ids) fingers.remove(id)
        if (r is Outcome.Fail) return Outcome.Fail("finger_up: ${r.error}")
        return Outcome.Ok(data = buildJsonObject { put("lifted", strokes.size); put("down", fingers.size) })
    }

    /**
     * Virtual joystick: press at centre (cx,cy), push to angle/distance, hold for durationMs, optionally release.
     * angle in degrees: 0 = right, 90 = down (screen coords), 180 = left, 270 = up. Uses finger slot `finger` (default 0).
     * If the finger is already down (a previous joystick call with release=false) it just moves it — seamless direction changes.
     */
    private suspend fun joystick(a: Action): Outcome {
        val cx = a.x ?: return Outcome.Fail("joystick requires x,y (stick centre)"); val cy = a.y ?: return Outcome.Fail("missing y")
        val id = (a.finger ?: 0).coerceIn(0, 3)
        val angle = Math.toRadians((a.angle ?: 270.0)); val dist = (a.distance ?: 150f).coerceIn(10f, 800f)
        val tx = cx + (Math.cos(angle) * dist).toFloat(); val ty = cy + (Math.sin(angle) * dist).toFloat()
        val hold = (a.duration ?: 500L).coerceIn(50, 40_000); val release = a.release != false
        val t0 = android.os.SystemClock.elapsedRealtime()
        val existing = fingers[id]
        if (existing == null) {
            val down = fingerDown(Action(type = "finger_down", x = cx, y = cy, finger = id, duration = 40))
            if (down is Outcome.Fail) return down
        }
        val mv = fingerMove(Action(type = "finger_move", x = tx, y = ty, finger = id, duration = 80))
        if (mv is Outcome.Fail) return mv
        // hold the stick: keep the stroke alive with tiny continuation segments (max 1s each) so the game keeps receiving MOVE events
        var remaining = hold - 80
        while (remaining > 0) {
            val seg = Math.min(remaining, 900L)
            val f = fingers[id] ?: break
            val s = f.stroke.continueStroke(Path().apply { moveTo(f.x, f.y); lineTo(f.x + 0.5f, f.y) }, 0, seg, true)
            val r = dispatchStrokes(listOf(s)); if (r is Outcome.Fail) return Outcome.Fail("joystick hold: ${r.error}")
            f.stroke = s; f.x += 0.5f
            remaining -= seg
        }
        if (release) fingerUp(Action(type = "finger_up", finger = id))
        return Outcome.Ok(data = buildJsonObject { put("finger", id); put("angle", a.angle ?: 270.0); put("distance", dist.toInt()); put("heldMs", android.os.SystemClock.elapsedRealtime() - t0); put("released", release); put("tipX", tx.toInt()); put("tipY", ty.toInt()) })
    }

    /** Aim/camera drag: swipe by (dx,dy) starting at (x,y) on the look area, with a separate finger so the movement stick can stay held. */
    private suspend fun aim(a: Action): Outcome {
        val x = a.x ?: return Outcome.Fail("aim requires x,y (start point on the look area)"); val y = a.y ?: return Outcome.Fail("missing y")
        val dx = a.dx ?: 0f; val dy = a.dy ?: 0f
        if (dx == 0f && dy == 0f) return Outcome.Fail("aim requires dx and/or dy")
        val id = (a.finger ?: 1).coerceIn(0, 3); val dur = (a.duration ?: 120L).coerceIn(20, 3000)
        val steps = (a.steps ?: 1).coerceIn(1, 20)
        if (fingers.containsKey(id)) fingerUp(Action(type = "finger_up", finger = id))
        // one continuous drag with `steps` intermediate points so games sample smooth motion
        val pts = (1..steps).map { i -> SeqPoint(x + dx * i / steps, y + dy * i / steps) }
        val down = fingerDown(Action(type = "finger_down", x = x, y = y, finger = id, duration = 30)); if (down is Outcome.Fail) return down
        val mv = fingerMove(Action(type = "finger_move", points = pts, finger = id, duration = dur)); if (mv is Outcome.Fail) return mv
        if (a.release != false) fingerUp(Action(type = "finger_up", finger = id))
        return Outcome.Ok(data = buildJsonObject { put("finger", id); put("dx", dx.toInt()); put("dy", dy.toInt()); put("durationMs", dur) })
    }

    /** Fire button burst: `count` taps at (x,y) every intervalMs, on its own finger so movement/aim fingers stay down. holdMs>0 = hold the button instead of tapping. */
    private suspend fun fireBurst(a: Action): Outcome {
        val x = a.x ?: return Outcome.Fail("fire_burst requires x,y"); val y = a.y ?: return Outcome.Fail("missing y")
        val holdMs = (a.holdMs ?: 0L)
        val t0 = android.os.SystemClock.elapsedRealtime()
        if (holdMs > 0) {
            val r = gesture(tapPath(x, y), holdMs.coerceIn(50, 30_000))
            return if (r is Outcome.Fail) r else Outcome.Ok(data = buildJsonObject { put("held", holdMs); put("elapsedMs", android.os.SystemClock.elapsedRealtime() - t0) })
        }
        val count = (a.count ?: 5).coerceIn(1, 200); val interval = (a.intervalMs ?: 90L).coerceIn(30, 2000)
        var done = 0
        for (i in 0 until count) {
            val r = gesture(tapPath(x, y), 35); if (r is Outcome.Fail) return Outcome.Fail("shot ${i + 1}/$count failed: ${r.error}")
            done++
            val target = t0 + (i + 1) * interval; val wait = target - android.os.SystemClock.elapsedRealtime(); if (i < count - 1 && wait > 0) delay(wait)
        }
        return Outcome.Ok(data = buildJsonObject { put("shots", done); put("elapsedMs", android.os.SystemClock.elapsedRealtime() - t0) })
    }

    /**
     * combo: a timed script of multi-touch steps executed on the phone with no network jitter.
     * steps[]: {op:"down"|"move"|"up"|"tap"|"wait"|"joystick"|"aim"|"fire", finger?, x?, y?, dx?, dy?, angle?, distance?, duration?, delayMs?, count?}
     */
    private suspend fun combo(a: Action): Outcome {
        val steps = a.steps2 ?: return Outcome.Fail("combo requires steps")
        if (steps.isEmpty() || steps.size > 40) return Outcome.Fail("combo steps must be 1..40")
        val t0 = android.os.SystemClock.elapsedRealtime(); var done = 0
        for ((i, s) in steps.withIndex()) {
            if ((s.delayMs ?: 0L) > 0) delay(s.delayMs!!)
            val r: Outcome = when (s.op) {
                "down" -> fingerDown(Action(type = "finger_down", x = s.x, y = s.y, finger = s.finger, duration = s.duration))
                "move" -> fingerMove(Action(type = "finger_move", x = s.x, y = s.y, finger = s.finger, duration = s.duration))
                "up" -> fingerUp(Action(type = "finger_up", finger = s.finger ?: 0))
                "tap" -> gesture(tapPath(s.x, s.y), (s.duration ?: 40L).coerceIn(20, 5000))
                "wait" -> { delay((s.duration ?: 100L).coerceIn(0, 10_000)); Outcome.Ok() }
                "joystick" -> joystick(Action(type = "joystick", x = s.x, y = s.y, finger = s.finger, angle = s.angle, distance = s.distance, duration = s.duration, release = s.release))
                "aim" -> aim(Action(type = "aim", x = s.x, y = s.y, dx = s.dx, dy = s.dy, finger = s.finger, duration = s.duration, release = s.release))
                "fire" -> fireBurst(Action(type = "fire_burst", x = s.x, y = s.y, count = s.count, intervalMs = s.intervalMs, holdMs = s.holdMs))
                else -> Outcome.Fail("unknown op ${s.op}")
            }
            if (r is Outcome.Fail) { fingerUp(Action(type = "finger_up", finger = -1)); return Outcome.Fail("combo step ${i + 1} (${s.op}) failed: ${r.error}") }
            done++
        }
        return Outcome.Ok(data = buildJsonObject { put("steps", done); put("elapsedMs", android.os.SystemClock.elapsedRealtime() - t0); put("fingersDown", fingers.size) })
    }

    private suspend fun tapSequence(points: List<SeqPoint>?): Outcome {
        if (points.isNullOrEmpty()) return Outcome.Fail("tap_sequence requires points")
        var done = 0
        for (p in points) {
            if ((p.delayMs ?: 0) > 0) delay(p.delayMs!!)
            val r = gesture(tapPath(p.x, p.y), (p.durationMs ?: 60L))
            if (r is Outcome.Fail) return Outcome.Fail("tap ${done + 1}/${points.size} failed: ${r.error}")
            done++
        }
        return Outcome.Ok(data = buildJsonObject { put("taps", done) })
    }

    private suspend fun multiTap(points: List<SeqPoint>?, duration: Long?): Outcome {
        if (points.isNullOrEmpty()) return Outcome.Fail("multi_tap requires points")
        val d = (duration ?: 60L).coerceIn(20, 5000)
        val b = GestureDescription.Builder()
        for (p in points.take(10)) b.addStroke(GestureDescription.StrokeDescription(Path().apply { moveTo(p.x, p.y) }, 0, d))
        return dispatch(b.build())
    }

    private suspend fun swipePath(points: List<SeqPoint>?, duration: Long?): Outcome {
        if (points == null || points.size < 2) return Outcome.Fail("swipe_path requires >= 2 points")
        val path = Path().apply { moveTo(points[0].x, points[0].y); for (i in 1 until points.size) lineTo(points[i].x, points[i].y) }
        return gesture(path, (duration ?: 500L).coerceIn(50, 30_000))
    }

    private suspend fun repeatTap(a: Action): Outcome {
        val x = a.x ?: return Outcome.Fail("missing x"); val y = a.y ?: return Outcome.Fail("missing y")
        val count = (a.count ?: 5).coerceIn(1, 100); val interval = (a.intervalMs ?: 100L).coerceIn(30, 5000)
        var done = 0
        val t0 = android.os.SystemClock.elapsedRealtime()
        for (i in 0 until count) {
            val r = gesture(tapPath(x, y), 40)
            if (r is Outcome.Fail) return Outcome.Fail("tap ${i + 1}/$count failed: ${r.error}")
            done++
            if (i < count - 1) {
                // keep cadence stable regardless of gesture completion latency
                val target = t0 + (i + 1) * interval
                val wait = target - android.os.SystemClock.elapsedRealtime()
                if (wait > 0) delay(wait)
            }
        }
        return Outcome.Ok(data = buildJsonObject { put("taps", done); put("elapsedMs", android.os.SystemClock.elapsedRealtime() - t0) })
    }

    // ---------------------------------------------------------------- UI tree
    private data class Node(val node: AccessibilityNodeInfo, val bounds: Rect, val depth: Int)

    /** Depth-first walk of all interactive windows, returns visible nodes. */
    private fun collectNodes(maxNodes: Int = 400): List<Node> {
        val out = ArrayList<Node>()
        val roots = ArrayList<AccessibilityNodeInfo>()
        rootInActiveWindow?.let { roots.add(it) }
        if (Build.VERSION.SDK_INT >= 21) {
            for (w in windows) {
                val r = w.root ?: continue
                if (roots.none { it == r }) roots.add(r)
            }
        }
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || out.size >= maxNodes) return
            val b = Rect()
            n.getBoundsInScreen(b)
            if (n.isVisibleToUser && b.width() > 0 && b.height() > 0) out.add(Node(n, b, depth))
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        roots.forEach { walk(it, 0) }
        return out
    }

    private fun isInteresting(n: AccessibilityNodeInfo): Boolean =
        n.isClickable || n.isLongClickable || n.isEditable || n.isCheckable || n.isScrollable ||
            !n.text.isNullOrBlank() || !n.contentDescription.isNullOrBlank()

    /** Compact JSON list of meaningful UI elements with screen coordinates (original pixels). */
    private fun uiDump(): JsonElement {
        val nodes = collectNodes()
        val pkg = rootInActiveWindow?.packageName?.toString() ?: lastPackage
        val elements = buildJsonArray {
            var i = 0
            for (nd in nodes) {
                val n = nd.node
                if (!isInteresting(n)) continue
                add(buildJsonObject {
                    put("i", i++)
                    n.text?.toString()?.takeIf { it.isNotBlank() }?.let { put("text", it.take(120)) }
                    n.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { put("desc", it.take(120)) }
                    n.viewIdResourceName?.substringAfter('/')?.let { put("id", it) }
                    n.className?.toString()?.substringAfterLast('.')?.let { put("cls", it) }
                    n.hintText?.toString()?.takeIf { it.isNotBlank() }?.let { put("hint", it.take(60)) }
                    put("cx", nd.bounds.centerX()); put("cy", nd.bounds.centerY())
                    put("bounds", "${nd.bounds.left},${nd.bounds.top},${nd.bounds.right},${nd.bounds.bottom}")
                    if (n.isClickable) put("clickable", true)
                    if (n.isEditable) put("editable", true)
                    if (n.isScrollable) put("scrollable", true)
                    if (n.isCheckable) put("checked", n.isChecked)
                    if (n.isFocused) put("focused", true)
                    if (!n.isEnabled) put("disabled", true)
                })
            }
        }
        return buildJsonObject {
            put("package", pkg)
            put("label", appLabel(pkg))
            put("count", elements.size)
            put("elements", elements)
        }
    }

    private fun findElements(a: Action): List<Node> {
        val q = a.text?.trim()?.lowercase()
        val id = a.elementId?.trim()
        return collectNodes().filter { nd ->
            val n = nd.node
            val idOk = id == null || n.viewIdResourceName?.substringAfter('/')?.equals(id, true) == true || n.viewIdResourceName?.equals(id, true) == true
            val textOk = q == null || listOfNotNull(n.text, n.contentDescription, n.hintText).any { it.toString().lowercase().contains(q) }
            idOk && textOk && (id != null || q != null)
        }
    }

    /** Tap an element by text/desc/id. Prefers exact matches and clickable ancestors. */
    private suspend fun tapElement(a: Action): Outcome {
        if (a.text.isNullOrBlank() && a.elementId.isNullOrBlank()) return Outcome.Fail("tap_element requires text or elementId")
        var matches = findElements(a)
        if (matches.isEmpty()) return Outcome.Fail("no element matching ${a.text ?: a.elementId}")
        val q = a.text?.trim()?.lowercase()
        if (q != null) {
            val exact = matches.filter { listOfNotNull(it.node.text, it.node.contentDescription).any { t -> t.toString().trim().lowercase() == q } }
            if (exact.isNotEmpty()) matches = exact
        }
        val idx = (a.index ?: 0).coerceIn(0, matches.lastIndex)
        val target = matches[idx]
        // Try ACTION_CLICK on node or its clickable ancestor first (most reliable), else gesture at center
        var n: AccessibilityNodeInfo? = target.node
        var hops = 0
        while (n != null && !n.isClickable && hops < 5) { n = n.parent; hops++ }
        val clicked = n?.isClickable == true && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        val data = buildJsonObject {
            put("matched", matches.size); put("index", idx)
            put("text", target.node.text?.toString() ?: target.node.contentDescription?.toString() ?: "")
            put("cx", target.bounds.centerX()); put("cy", target.bounds.centerY())
            put("method", if (clicked) "action_click" else "gesture")
        }
        if (clicked) return Outcome.Ok(data = data)
        val g = gesture(tapPath(target.bounds.centerX().toFloat(), target.bounds.centerY().toFloat()), 60)
        return if (g is Outcome.Ok) Outcome.Ok(data = data) else g
    }

    /** Type text into the focused field (or the one matching text/elementId). */
    private suspend fun typeText(a: Action): Outcome {
        val text = a.text ?: return Outcome.Fail("type_text requires text")
        var field: AccessibilityNodeInfo? = null
        if (!a.elementId.isNullOrBlank()) field = findElements(Action(type = "x", elementId = a.elementId)).firstOrNull { it.node.isEditable }?.node
        if (field == null) field = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (field == null) field = collectNodes().firstOrNull { it.node.isEditable && it.node.isFocused }?.node
        if (field == null) {
            val editables = collectNodes().filter { it.node.isEditable }
            if (editables.size == 1) field = editables[0].node
        }
        if (field == null) return Outcome.Fail("no focused editable field; tap a text field first (or pass elementId)")

        field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val existing = if (a.clear == false) field.text?.toString() ?: "" else ""
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, existing + text) }
        val ok = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (!ok) return Outcome.Fail("ACTION_SET_TEXT failed (field may not support it)")
        var submitted = false
        if (a.submit == true) {
            delay(150)
            submitted = if (Build.VERSION.SDK_INT >= 30) {
                field.performAction(android.R.id.accessibilityActionImeEnter)
            } else false
        }
        return Outcome.Ok(data = buildJsonObject { put("typed", text.length); put("submitted", submitted) })
    }

    // ---------------------------------------------------------------- apps
    private fun appLabel(pkg: String?): String? = pkg?.let {
        runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(it, 0)).toString() }.getOrNull()
    }

    private fun listApps(): JsonElement {
        val pm = packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val list = pm.queryIntentActivities(intent, 0)
            .map { it.activityInfo.packageName to (it.loadLabel(pm)?.toString() ?: it.activityInfo.packageName) }
            .distinctBy { it.first }
            .sortedBy { it.second.lowercase() }
        return buildJsonArray {
            for ((p, l) in list) add(buildJsonObject { put("package", p); put("label", l) })
        }
    }

    /** Launch by package name or by (case-insensitive, partial) app label. */
    private fun openApp(query: String?): Outcome {
        if (query.isNullOrBlank()) return Outcome.Fail("open_app requires text (package name or app name)")
        val pm = packageManager
        var pkg: String? = null
        // exact package
        runCatching { pm.getPackageInfo(query, 0) }.onSuccess { pkg = query }
        if (pkg == null) {
            val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val apps = pm.queryIntentActivities(intent, 0).map { it.activityInfo.packageName to (it.loadLabel(pm)?.toString() ?: "") }
            val q = query.lowercase()
            pkg = apps.firstOrNull { it.second.lowercase() == q }?.first
                ?: apps.firstOrNull { it.second.lowercase().startsWith(q) }?.first
                ?: apps.firstOrNull { it.second.lowercase().contains(q) || it.first.lowercase().contains(q) }?.first
        }
        val p = pkg ?: return Outcome.Fail("no app matching '$query'")
        val launch = pm.getLaunchIntentForPackage(p) ?: return Outcome.Fail("app $p has no launcher activity")
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return try {
            startActivity(launch)
            Outcome.Ok(data = buildJsonObject { put("package", p); put("label", appLabel(p)) })
        } catch (e: Exception) {
            Outcome.Fail("launch failed: ${e.message}")
        }
    }

    private fun openUrl(url: String?): Outcome {
        if (url.isNullOrBlank()) return Outcome.Fail("open_url requires url")
        val u = if (url.contains("://")) url else "https://$url"
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            Outcome.Ok(data = buildJsonObject { put("url", u) })
        } catch (e: Exception) {
            Outcome.Fail("open_url failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "AutomationA11y"
        private val screenshotExecutor = Executors.newSingleThreadExecutor()

        @Volatile
        var instance: AutomationAccessibilityService? = null
            private set

        @Volatile
        var lastPackage: String? = null
            private set

        val isEnabled get() = instance != null
    }
}
