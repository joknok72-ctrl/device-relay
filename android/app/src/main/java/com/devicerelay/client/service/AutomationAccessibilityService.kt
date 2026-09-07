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
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
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

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "AccessibilityService connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event?.packageName?.let { lastPackage = it.toString() }
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
        "screenshot" -> screenshot(action.maxWidth, action.quality, action.format)
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
    private suspend fun screenshot(maxWidth: Int? = null, quality: Int? = null, format: String? = null): Outcome {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return Outcome.Fail("screenshot requires Android 11+")
        return suspendCoroutine { cont ->
            takeScreenshot(Display.DEFAULT_DISPLAY, screenshotExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        val bmp = hw?.copy(Bitmap.Config.ARGB_8888, false)
                        result.hardwareBuffer.close()
                        if (bmp == null) { cont.resume(Outcome.Fail("bitmap null")); return }
                        val maxW = (maxWidth ?: 540).coerceIn(120, 2160)
                        val scale = (maxW.toFloat() / bmp.width).coerceAtMost(1f)
                        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
                        val out = ByteArrayOutputStream()
                        val jpeg = format.equals("jpeg", true) || format.equals("jpg", true)
                        scaled.compress(if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, (quality ?: 80).coerceIn(10, 100), out)
                        cont.resume(Outcome.Ok(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), mime = if (jpeg) "image/jpeg" else "image/png"))
                    } catch (e: Exception) {
                        cont.resume(Outcome.Fail("screenshot encode failed: ${e.message}"))
                    }
                }
                override fun onFailure(errorCode: Int) { cont.resume(Outcome.Fail("screenshot failed code=$errorCode")) }
            })
        }
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
