package com.devicerelay.client.service

import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import com.devicerelay.client.net.Action
import com.devicerelay.client.net.ComboStep
import com.devicerelay.client.net.Region
import com.devicerelay.client.net.RelayJson
import com.devicerelay.client.net.SeqPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * v2.6 — runs rule-based game bots entirely on the phone.
 * Bot definitions arrive from the relay (bot_sync) as raw JSON and are persisted in SharedPreferences,
 * so the notification can start them even when the relay is unreachable.
 *
 * Rule = { name, when:[conditions], then:[actions], cooldownMs, priority, exclusive, enabled }
 * Each tick: one screenshot → evaluate rules by priority → run actions of the first (or all non-exclusive) matching rules.
 */
object BotEngine {
    private const val TAG = "BotEngine"
    private const val PREFS = "bots"

    data class Status(
        val running: Boolean, val botId: String? = null, val name: String? = null,
        val ticks: Int = 0, val fired: Int = 0, val lastRule: String? = null,
        val startedAt: Long? = null, val stoppedBy: String? = null, val error: String? = null,
    )

    private val scope = CoroutineScope(Dispatchers.Default)
    private var job: Job? = null
    @Volatile var status = Status(running = false); private set
    /** callback → RelayConnectionService forwards to the relay + updates the notification */
    var onStatus: ((Status) -> Unit)? = null

    // ------------------------------------------------------------ storage
    fun save(ctx: Context, botsJson: JsonArray) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("bots", botsJson.toString()).apply()
    }
    fun load(ctx: Context): List<JsonObject> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("bots", null) ?: return emptyList()
        return runCatching { RelayJson.parseToJsonElement(raw).jsonArray.map { it.jsonObject } }.getOrDefault(emptyList())
    }
    fun find(ctx: Context, id: String): JsonObject? = load(ctx).firstOrNull { it.str("id") == id }
    /** Bots for the app currently in the foreground (for the notification). */
    fun forApp(ctx: Context, pkg: String?): List<JsonObject> = load(ctx).filter { pkg == null || it.str("app") == pkg }

    // ------------------------------------------------------------ control
    fun start(ctx: Context, bot: JsonObject): Boolean {
        val svc = AutomationAccessibilityService.instance ?: run { emit(Status(false, bot.str("id"), bot.str("name"), error = "accessibility service not enabled", stoppedBy = "error")); return false }
        stop("restart")
        val id = bot.str("id") ?: return false
        val name = bot.str("name") ?: id
        val rules = bot["rules"]?.jsonArray?.map { it.jsonObject }?.filter { it["enabled"]?.jsonPrimitive?.booleanOrNull != false }?.sortedByDescending { it.int("priority") ?: 0 } ?: emptyList()
        val tickMs = (bot.long("tickMs") ?: 120L).coerceIn(50, 2000)
        val maxRunMs = (bot.long("maxRunMs") ?: 1_800_000L).coerceIn(10_000, 21_600_000)
        val stopOnAppChange = bot["stopOnAppChange"]?.jsonPrimitive?.booleanOrNull != false
        val app = bot.str("app")
        val t0 = SystemClock.elapsedRealtime()
        val startedAt = System.currentTimeMillis()
        emit(Status(true, id, name, startedAt = startedAt))
        job = scope.launch {
            var ticks = 0; var fired = 0; var lastRule: String? = null; var stoppedBy = "stopped"
            val lastFired = HashMap<String, Long>()
            val everyLast = HashMap<String, Long>()
            var lastHash: String? = null
            val textCache = HashMap<String, Pair<Long, List<Pair<String, Region?>>>>()
            try {
                while (true) {
                    val now = SystemClock.elapsedRealtime()
                    if (now - t0 > maxRunMs) { stoppedBy = "maxRunMs"; break }
                    if (stopOnAppChange && app != null && ticks % 8 == 7) {
                        val fg = withContext(Dispatchers.Main) { svc.currentPackage() }
                        if (fg != null && fg != app && fg != ctx.packageName) { stoppedBy = "appChanged:$fg"; break }
                    }
                    val bmp = withContext(Dispatchers.Main) { svc.captureForBot() }
                    ticks++
                    if (bmp == null) { delay(tickMs); continue }
                    var firedThisTick = false
                    for (rule in rules) {
                        val rname = rule.str("name") ?: "rule"
                        val cd = rule.long("cooldownMs") ?: 300L
                        if (now - (lastFired[rname] ?: Long.MIN_VALUE / 2) < cd) continue
                        val conds = rule["when"]?.jsonArray?.map { it.jsonObject } ?: continue
                        var found: Pair<Int, Int>? = null
                        var all = true
                        for (c in conds) {
                            val (ok, pt) = eval(svc, bmp, c, lastHash, everyLast, rname, now)
                            if (!ok) { all = false; break }
                            if (pt != null && found == null) found = pt
                        }
                        if (!all) continue
                        // fire
                        lastFired[rname] = now; fired++; lastRule = rname; firedThisTick = true
                        val actions = rule["then"]?.jsonArray?.map { it.jsonObject } ?: emptyList()
                        var stop = false
                        for (a in actions) {
                            val r = runAction(svc, a, found)
                            if (r == "stop") { stop = true; stoppedBy = "rule:$rname"; break }
                        }
                        if (ticks % 5 == 0 || fired % 5 == 0) emit(Status(true, id, name, ticks, fired, lastRule, startedAt))
                        if (stop) break
                        if (rule["exclusive"]?.jsonPrimitive?.booleanOrNull != false) break
                    }
                    if (stoppedBy.startsWith("rule:")) break
                    // update screen hash for screen_changed
                    lastHash = quickHash(bmp)
                    if (!firedThisTick && ticks % 25 == 0) emit(Status(true, id, name, ticks, fired, lastRule, startedAt))
                    val spent = SystemClock.elapsedRealtime() - now
                    delay((tickMs - spent).coerceAtLeast(15))
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                stoppedBy = status.stoppedBy ?: "stopped"
                emit(Status(false, id, name, ticks, fired, lastRule, startedAt, stoppedBy))
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "bot crashed", e); stoppedBy = "error"
                emit(Status(false, id, name, ticks, fired, lastRule, startedAt, stoppedBy, e.message)); return@launch
            } finally {
                // lift any held fingers even when cancelled
                runCatching { withContext(kotlinx.coroutines.NonCancellable + Dispatchers.Main) { svc.execute(Action(type = "finger_up", finger = -1)) } }
            }
            emit(Status(false, id, name, ticks, fired, lastRule, startedAt, stoppedBy))
        }
        return true
    }

    fun stop(reason: String = "user") {
        val j = job ?: return
        job = null
        status = status.copy(stoppedBy = reason)
        j.cancel()
    }

    private fun emit(s: Status) { status = s; onStatus?.invoke(s) }

    fun statusJson(): JsonObject = buildJsonObject {
        put("running", status.running); status.botId?.let { put("botId", it) }; status.name?.let { put("name", it) }
        put("ticks", status.ticks); put("fired", status.fired); status.lastRule?.let { put("lastRule", it) }
        status.startedAt?.let { put("startedAt", it) }; status.stoppedBy?.let { put("stoppedBy", it) }; status.error?.let { put("error", it) }
        put("ts", System.currentTimeMillis())
    }

    // ------------------------------------------------------------ conditions
    /** returns (matched, centre-of-colour-match or null) */
    private suspend fun eval(svc: AutomationAccessibilityService, bmp: Bitmap, c: JsonObject, lastHash: String?, everyLast: HashMap<String, Long>, rule: String, now: Long): Pair<Boolean, Pair<Int, Int>?> {
        return when (c.str("type")) {
            "always" -> true to null
            "every_ms" -> { val ms = c.long("ms") ?: 1000L; val key = "$rule/${c.hashCode()}"; val last = everyLast[key]; if (last == null || now - last >= ms) { everyLast[key] = now; true to null } else false to null }
            "color_present", "color_absent" -> {
                val r = svc.scanColorPublic(bmp, c.str("color") ?: "#000000", (c.int("tolerance") ?: 24).coerceIn(0, 128), c.region())
                val count = r["count"]?.jsonPrimitive?.longOrNull ?: 0L
                val present = count >= (c.int("minCount") ?: 20)
                val pt = if (present) (r["cx"]?.jsonPrimitive?.intOrNull ?: 0) to (r["cy"]?.jsonPrimitive?.intOrNull ?: 0) else null
                (if (c.str("type") == "color_present") present else !present) to pt
            }
            "pixel_is", "pixel_not" -> {
                val x = (c.int("x") ?: 0).coerceIn(0, bmp.width - 1); val y = (c.int("y") ?: 0).coerceIn(0, bmp.height - 1)
                val px = bmp.getPixel(x, y); val tol = (c.int("tolerance") ?: 24).coerceIn(0, 128)
                val target = (c.str("color") ?: "#000000").removePrefix("#").toIntOrNull(16) ?: 0
                val match = Math.abs(((px shr 16) and 0xFF) - ((target shr 16) and 0xFF)) <= tol && Math.abs(((px shr 8) and 0xFF) - ((target shr 8) and 0xFF)) <= tol && Math.abs((px and 0xFF) - (target and 0xFF)) <= tol
                (if (c.str("type") == "pixel_is") match else !match) to (if (match) x to y else null)
            }
            "text_present", "text_absent" -> {
                val lines = svc.readTextPublic(bmp, c.region())
                val q = (c.str("text") ?: "").lowercase().trim()
                val hit = lines.firstOrNull { it.first.lowercase().contains(q) }
                (if (c.str("type") == "text_present") hit != null else hit == null) to hit?.second
            }
            "number_below", "number_above" -> {
                val lines = svc.readTextPublic(bmp, c.region())
                val num = lines.mapNotNull { parseNumber(it.first) }.firstOrNull()
                val v = c["value"]?.jsonPrimitive?.doubleOrNull ?: 0.0
                if (num == null) false to null else (if (c.str("type") == "number_below") num < v else num > v) to null
            }
            "screen_changed" -> { val h = quickHash(bmp); (lastHash != null && h != lastHash) to null }
            else -> false to null
        }
    }

    private fun parseNumber(s: String): Double? {
        val t = s.replace(Regex("[\\u0660-\\u0669]")) { (it.value[0] - '\u0660').toString() }
        val m = Regex("-?\\d[\\d,.]*").find(t) ?: return null
        val raw = m.value.replace(",", "")
        return raw.toDoubleOrNull()
    }

    private fun quickHash(bmp: Bitmap): String {
        val w = 12; val h = 20
        val small = Bitmap.createScaledBitmap(bmp, w, h, false)
        val px = IntArray(w * h); small.getPixels(px, 0, w, 0, 0, w, h)
        val grey = IntArray(w * h) { val c = px[it]; (((c shr 16) and 0xFF) * 3 + ((c shr 8) and 0xFF) * 6 + (c and 0xFF)) / 10 }
        val avg = grey.average(); val sb = StringBuilder()
        var bits = 0; var n = 0
        for (g in grey) { bits = (bits shl 1) or (if (g > avg) 1 else 0); n++; if (n == 4) { sb.append(Integer.toHexString(bits)); bits = 0; n = 0 } }
        return sb.toString()
    }

    // ------------------------------------------------------------ actions
    /** returns "stop" to end the bot, else null */
    private suspend fun runAction(svc: AutomationAccessibilityService, a: JsonObject, found: Pair<Int, Int>?): String? {
        val type = a.str("type") ?: return null
        val action: Action? = when (type) {
            "stop_bot" -> return "stop"
            "wait" -> { delay((a.long("ms") ?: 200L).coerceIn(0, 10_000)); return null }
            "tap_found" -> { val f = found ?: return null; Action(type = "tap", x = (f.first + (a.int("offsetX") ?: 0)).toFloat(), y = (f.second + (a.int("offsetY") ?: 0)).toFloat()) }
            "tap" -> Action(type = "tap", x = a.float("x"), y = a.float("y"))
            "long_press" -> Action(type = "long_press", x = a.float("x"), y = a.float("y"), duration = a.long("duration"))
            "swipe" -> Action(type = "swipe", x1 = a.float("x1"), y1 = a.float("y1"), x2 = a.float("x2"), y2 = a.float("y2"), duration = a.long("duration"))
            "tap_sequence" -> Action(type = "tap_sequence", points = a["points"]?.let { runCatching { RelayJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(SeqPoint.serializer()), it) }.getOrNull() })
            "repeat_tap" -> Action(type = "repeat_tap", x = a.float("x"), y = a.float("y"), count = a.int("count"), intervalMs = a.long("intervalMs"))
            "joystick" -> Action(type = "joystick", x = a.float("x"), y = a.float("y"), angle = a["angle"]?.jsonPrimitive?.doubleOrNull, distance = a.float("distance"), duration = a.long("duration"), finger = a.int("finger"), release = a["release"]?.jsonPrimitive?.booleanOrNull)
            "aim" -> Action(type = "aim", x = a.float("x"), y = a.float("y"), dx = a.float("dx"), dy = a.float("dy"), duration = a.long("duration"), finger = a.int("finger"), steps = a.int("steps"), release = a["release"]?.jsonPrimitive?.booleanOrNull)
            "fire_burst" -> Action(type = "fire_burst", x = a.float("x"), y = a.float("y"), count = a.int("count"), intervalMs = a.long("intervalMs"), holdMs = a.long("holdMs"))
            "combo" -> Action(type = "combo", steps2 = a["combo"]?.let { runCatching { RelayJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(ComboStep.serializer()), it) }.getOrNull() })
            "finger_up" -> Action(type = "finger_up", finger = a.int("finger") ?: -1)
            "back" -> Action(type = "back")
            "home" -> Action(type = "home")
            else -> null
        }
        if (action != null) runCatching { withContext(Dispatchers.Main) { svc.execute(action) } }.onFailure { Log.w(TAG, "action ${action.type} failed", it) }
        return null
    }

    // ------------------------------------------------------------ json helpers
    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.int(k: String) = this[k]?.jsonPrimitive?.intOrNull
    private fun JsonObject.long(k: String) = this[k]?.jsonPrimitive?.longOrNull ?: this[k]?.jsonPrimitive?.doubleOrNull?.toLong()
    private fun JsonObject.float(k: String) = this[k]?.jsonPrimitive?.floatOrNull
    private fun JsonObject.region(): Region? = this["region"]?.let { r -> runCatching { RelayJson.decodeFromJsonElement(Region.serializer(), r) }.getOrNull() }
}
