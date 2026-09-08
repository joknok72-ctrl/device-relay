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
 * v2.6/v2.7 — runs rule-based game bots entirely on the phone.
 * Bot definitions arrive from the relay (bot_sync) as raw JSON and are persisted in SharedPreferences,
 * so the notification can start them even when the relay is unreachable.
 *
 * Rule = { name, when:[conditions], then:[actions], cooldownMs, priority, exclusive, enabled, maxFires }
 * Each tick: one screenshot → evaluate rules by priority → run actions of the first (or all non-exclusive) matching rules.
 *
 * v2.7 additions: object_present/absent (blob detection, pick largest/nearest/topmost/lowest, size filter),
 * multi-colour `colors:[..]` (any-of), `forMs` (condition must hold continuously), tap_all_found, aim_to_found (aimbot),
 * aim.alternate (camera sweep), maxFires per rule, per-rule hit counters + avg tick time in status.
 */
object BotEngine {
    private const val TAG = "BotEngine"
    private const val PREFS = "bots"

    data class Status(
        val running: Boolean, val botId: String? = null, val name: String? = null,
        val ticks: Int = 0, val fired: Int = 0, val lastRule: String? = null,
        val startedAt: Long? = null, val stoppedBy: String? = null, val error: String? = null,
        val ruleHits: Map<String, Int> = emptyMap(), val avgTickMs: Int = 0,
        /** v2.8 self-tuned params: "<rule>/<actionIdx>/sensitivity" → value */
        val learned: Map<String, Float> = emptyMap(),
    )

    /** v2.8 aim auto-tune state per action key */
    private class AimTune(var gain: Float, var lastEx: Int = 0, var lastEy: Int = 0, var lastDx: Float = 0f, var lastDy: Float = 0f, var pending: Boolean = false, var samples: Int = 0,
        /** v3.0 target tracking for lead prediction: last seen position/time and smoothed velocity (px/ms) */
        var tx: Int = 0, var ty: Int = 0, var tAt: Long = 0L, var vx: Float = 0f, var vy: Float = 0f)

    /** What a condition "found": a single point plus (for object_present) every detected object. */
    private class Found(val x: Int, val y: Int, val all: List<Pair<Int, Int>> = listOf(x to y))

    /** v3.1 per-condition last picked target (x, y, at) for target lock */
    private val lockTargets = HashMap<String, Triple<Int, Int, Long>>()
    private val scope = CoroutineScope(Dispatchers.Default)
    private var job: Job? = null
    /** v3.1 error (px) of the most recent aim_to_found correction in this tick — consumed by fire_burst.gateErr */
    @Volatile private var lastAimErr = 0
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
        lockTargets.clear()
        emit(Status(true, id, name, startedAt = startedAt))
        job = scope.launch {
            var ticks = 0; var fired = 0; var lastRule: String? = null; var stoppedBy = "stopped"
            val lastFired = HashMap<String, Long>()
            val fires = HashMap<String, Int>()
            val everyLast = HashMap<String, Long>()
            val holdSince = HashMap<String, Long>()      // v2.7 forMs: when a condition first became true
            val altState = HashMap<String, Boolean>()    // v2.7 aim.alternate flip state
            val aimTune = HashMap<String, AimTune>()      // v2.8 aim_to_found gain learning
            var lastHash: String? = null
            var tickTimeSum = 0L
            val st = { Status(true, id, name, ticks, fired, lastRule, startedAt, ruleHits = fires.toMap(), avgTickMs = if (ticks > 0) (tickTimeSum / ticks).toInt() else 0, learned = aimTune.filter { it.value.samples >= 3 }.mapValues { Math.round(it.value.gain * 100f) / 100f }.mapKeys { it.key + "/sensitivity" }) }
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
                        val maxFires = rule.int("maxFires") ?: 0
                        if (maxFires > 0 && (fires[rname] ?: 0) >= maxFires) continue
                        val conds = rule["when"]?.jsonArray?.map { it.jsonObject } ?: continue
                        var found: Found? = null
                        var all = true
                        for ((ci, c) in conds.withIndex()) {
                            val (ok0, f) = eval(svc, bmp, c, lastHash, everyLast, rname, now)
                            // v2.7 forMs: condition must hold continuously
                            val forMs = c.long("forMs") ?: 0L
                            val key = "$rname/$ci"
                            val ok = if (forMs <= 0) ok0 else {
                                if (!ok0) { holdSince.remove(key); false }
                                else { val since = holdSince.getOrPut(key) { now }; now - since >= forMs }
                            }
                            if (!ok) { all = false; break }
                            if (f != null && found == null) found = f
                        }
                        if (!all) continue
                        // fire
                        lastFired[rname] = now; fired++; lastRule = rname; firedThisTick = true
                        fires[rname] = (fires[rname] ?: 0) + 1
                        if (maxFires > 0 && fires[rname] == maxFires) conds.indices.forEach { holdSince.remove("$rname/$it") }
                        val actions = rule["then"]?.jsonArray?.map { it.jsonObject } ?: emptyList()
                        var stop = false
                        for ((ai, a) in actions.withIndex()) {
                            val r = runAction(svc, a, found, bmp, "$rname/$ai", altState, aimTune)
                            if (r == "stop") { stop = true; stoppedBy = "rule:$rname"; break }
                        }
                        if (ticks % 5 == 0 || fired % 5 == 0) emit(st())
                        if (stop) break
                        if (rule["exclusive"]?.jsonPrimitive?.booleanOrNull != false) break
                    }
                    if (stoppedBy.startsWith("rule:")) break
                    // update screen hash for screen_changed
                    lastHash = quickHash(bmp)
                    val spent = SystemClock.elapsedRealtime() - now
                    tickTimeSum += spent
                    if (!firedThisTick && ticks % 25 == 0) emit(st())
                    delay((tickMs - spent).coerceAtLeast(15))
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                stoppedBy = status.stoppedBy ?: "stopped"
                emit(st().copy(running = false, stoppedBy = stoppedBy))
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "bot crashed", e); stoppedBy = "error"
                emit(st().copy(running = false, stoppedBy = stoppedBy, error = e.message)); return@launch
            } finally {
                // lift any held fingers even when cancelled
                runCatching { withContext(kotlinx.coroutines.NonCancellable + Dispatchers.Main) { svc.execute(Action(type = "finger_up", finger = -1)) } }
            }
            emit(st().copy(running = false, stoppedBy = stoppedBy))
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
        if (status.ruleHits.isNotEmpty()) put("ruleHits", buildJsonObject { status.ruleHits.forEach { (k, v) -> put(k, v) } })
        if (status.learned.isNotEmpty()) put("learned", buildJsonObject { status.learned.forEach { (k, v) -> put(k, v) } })
        put("avgTickMs", status.avgTickMs)
        put("ts", System.currentTimeMillis())
    }

    // ------------------------------------------------------------ conditions
    /** colours to test: `colors:[..]` (any-of) or single `color` */
    private fun colorsOf(c: JsonObject): List<String> = c["colors"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }?.takeIf { it.isNotEmpty() } ?: listOfNotNull(c.str("color"))

    /** returns (matched, found point(s) or null) */
    private suspend fun eval(svc: AutomationAccessibilityService, bmp: Bitmap, c: JsonObject, lastHash: String?, everyLast: HashMap<String, Long>, rule: String, now: Long): Pair<Boolean, Found?> {
        return when (c.str("type")) {
            "always" -> true to null
            "every_ms" -> { val ms = c.long("ms") ?: 1000L; val key = "$rule/${c.hashCode()}"; val last = everyLast[key]; if (last == null || now - last >= ms) { everyLast[key] = now; true to null } else false to null }
            "color_present", "color_absent" -> {
                val tol = (c.int("tolerance") ?: 24).coerceIn(0, 128); val region = c.region(); val minCount = c.int("minCount") ?: 20
                var best: Found? = null; var bestCount = 0L
                for (hex in colorsOf(c)) {
                    val r = svc.scanColorPublic(bmp, hex, tol, region, c.str("match") ?: "rgb")
                    val count = r["count"]?.jsonPrimitive?.longOrNull ?: 0L
                    if (count >= minCount && count > bestCount) { bestCount = count; best = Found(r["cx"]?.jsonPrimitive?.intOrNull ?: 0, r["cy"]?.jsonPrimitive?.intOrNull ?: 0) }
                }
                val present = best != null
                (if (c.str("type") == "color_present") present else !present) to best
            }
            "object_present", "object_absent" -> {
                val tol = (c.int("tolerance") ?: 24).coerceIn(0, 128); val region = c.region()
                val minSize = (c.int("minSize") ?: 12).coerceIn(1, 2000); val maxSize = c.int("maxSize") ?: 0
                val objs = ArrayList<Triple<Int, Int, Int>>() // cx, cy, area
                for (hex in colorsOf(c)) {
                    val r = svc.scanObjectsPublic(bmp, hex, tol, region, minSize, 12, c.str("match") ?: "rgb")
                    r["objects"]?.jsonArray?.forEach { o ->
                        val ob = o.jsonObject; val b = ob["bounds"]?.jsonObject
                        val w = b?.get("w")?.jsonPrimitive?.intOrNull ?: 0; val h = b?.get("h")?.jsonPrimitive?.intOrNull ?: 0
                        if (maxSize > 0 && (w > maxSize || h > maxSize)) return@forEach
                        objs.add(Triple(ob["cx"]?.jsonPrimitive?.intOrNull ?: 0, ob["cy"]?.jsonPrimitive?.intOrNull ?: 0, ob["area"]?.jsonPrimitive?.intOrNull ?: 0))
                    }
                }
                val minCount = c.int("minCount") ?: 1
                val present = objs.size >= minCount
                if (c.str("type") == "object_absent") return (!present) to null
                if (!present) return false to null
                val nearX = c.int("nearX") ?: bmp.width / 2; val nearY = c.int("nearY") ?: bmp.height / 2
                var sorted = when (c.str("pick") ?: "largest") {
                    "nearest" -> objs.sortedBy { (it.first - nearX).toLong() * (it.first - nearX) + (it.second - nearY).toLong() * (it.second - nearY) }
                    "topmost" -> objs.sortedBy { it.second }
                    "lowest" -> objs.sortedByDescending { it.second }
                    else -> objs.sortedByDescending { it.third }
                }
                // v3.1 target lock: keep tracking the object we picked last tick (if it is still within lockRadius px) instead of hopping between enemies
                val lockR = c.int("lockRadius") ?: 220
                val lockKey = "$rule/${c.hashCode()}"
                val prev = lockTargets[lockKey]
                if (lockR > 0 && prev != null && now - prev.third < 700) {
                    val same = sorted.minByOrNull { (it.first - prev.first).toLong() * (it.first - prev.first) + (it.second - prev.second).toLong() * (it.second - prev.second) }
                    if (same != null && Math.abs(same.first - prev.first) <= lockR && Math.abs(same.second - prev.second) <= lockR) sorted = listOf(same) + sorted.filter { it !== same }
                }
                lockTargets[lockKey] = Triple(sorted[0].first, sorted[0].second, now)
                true to Found(sorted[0].first, sorted[0].second, sorted.map { it.first to it.second })
            }
            "pixel_is", "pixel_not" -> {
                val x = (c.int("x") ?: 0).coerceIn(0, bmp.width - 1); val y = (c.int("y") ?: 0).coerceIn(0, bmp.height - 1)
                val px = bmp.getPixel(x, y); val tol = (c.int("tolerance") ?: 24).coerceIn(0, 128)
                val target = (c.str("color") ?: "#000000").removePrefix("#").toIntOrNull(16) ?: 0
                val match = Math.abs(((px shr 16) and 0xFF) - ((target shr 16) and 0xFF)) <= tol && Math.abs(((px shr 8) and 0xFF) - ((target shr 8) and 0xFF)) <= tol && Math.abs((px and 0xFF) - (target and 0xFF)) <= tol
                (if (c.str("type") == "pixel_is") match else !match) to (if (match) Found(x, y) else null)
            }
            "text_present", "text_absent" -> {
                val lines = svc.readTextPublic(bmp, c.region())
                val q = (c.str("text") ?: "").lowercase().trim()
                val hit = lines.firstOrNull { it.first.lowercase().contains(q) }
                (if (c.str("type") == "text_present") hit != null else hit == null) to hit?.let { Found(it.second.first, it.second.second) }
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
    private suspend fun runAction(svc: AutomationAccessibilityService, a: JsonObject, found: Found?, bmp: Bitmap, key: String, altState: HashMap<String, Boolean>, aimTune: HashMap<String, AimTune> = HashMap()): String? {
        val type = a.str("type") ?: return null
        val action: Action? = when (type) {
            "stop_bot" -> return "stop"
            "wait" -> { delay((a.long("ms") ?: 200L).coerceIn(0, 10_000)); return null }
            "tap_found" -> { val f = found ?: return null; Action(type = "tap", x = (f.x + (a.int("offsetX") ?: 0)).toFloat(), y = (f.y + (a.int("offsetY") ?: 0)).toFloat()) }
            "tap_all_found" -> {
                // v2.7: tap every detected object, closest-first order as delivered by the condition
                val f = found ?: return null
                val max = (a.int("max") ?: 5).coerceIn(1, 20); val iv = (a.long("intervalMs") ?: 40L).coerceIn(0, 2000)
                val ox = a.int("offsetX") ?: 0; val oy = a.int("offsetY") ?: 0
                for ((i, p) in f.all.take(max).withIndex()) {
                    if (i > 0 && iv > 0) delay(iv)
                    runCatching { withContext(Dispatchers.Main) { svc.execute(Action(type = "tap", x = (p.first + ox).toFloat(), y = (p.second + oy).toFloat())) } }
                }
                return null
            }
            "aim_to_found" -> {
                // v2.7 aimbot: drag the look area so the crosshair lands on the target. Proportional step, clamped, with a deadzone.
                val f = found ?: return null
                val cx = a.int("crosshairX") ?: bmp.width / 2; val cy = a.int("crosshairY") ?: bmp.height / 2
                val tune = aimTune.getOrPut(key) { AimTune((a.float("sensitivity") ?: 1f).coerceIn(0.05f, 5f)) }
                // v3.0 lead prediction: smoothed target velocity from consecutive detections (only when the same target is tracked: jump < 250 px)
                val nowT = SystemClock.elapsedRealtime()
                var px = f.x + (a.int("offsetX") ?: 0); var py = f.y + (a.int("offsetY") ?: 0)
                val predictMs = a.int("predictMs") ?: 0
                if (tune.tAt > 0 && nowT - tune.tAt in 15..400 && Math.abs(f.x - tune.tx) < 250 && Math.abs(f.y - tune.ty) < 250) {
                    val dt = (nowT - tune.tAt).toFloat()
                    // the camera drag we injected also moves the target on screen: subtract the expected shift (-lastDx*? unknown gain) — keep it simple: only trust motion when we did not drag last tick
                    val ivx = (f.x - tune.tx) / dt; val ivy = (f.y - tune.ty) / dt
                    if (!tune.pending) { tune.vx = tune.vx * 0.5f + ivx * 0.5f; tune.vy = tune.vy * 0.5f + ivy * 0.5f }
                    if (predictMs > 0) { px += (tune.vx * predictMs).toInt().coerceIn(-200, 200); py += (tune.vy * predictMs).toInt().coerceIn(-200, 200) }
                } else { tune.vx = 0f; tune.vy = 0f }
                tune.tx = f.x; tune.ty = f.y; tune.tAt = nowT
                val ex = px - cx; val ey = py - cy
                // v3.0 assist range: the user aims coarsely — only nudge when the target is already close to the crosshair
                val maxRange = a.int("maxRange") ?: 0
                if (maxRange > 0 && (Math.abs(ex) > maxRange || Math.abs(ey) > maxRange)) { tune.pending = false; return null }
                val dz = a.int("deadzone") ?: 12
                // v2.8 auto-tune: compare how far the target actually moved after the previous drag with what we asked for.
                // ratio = observed movement / requested drag → if the crosshair moved less than the error we corrected (undershoot) raise gain, if it overshot lower it.
                if (a["autoTune"]?.jsonPrimitive?.booleanOrNull != false && tune.pending && Math.abs(tune.lastDx) > 20) {
                    val moved = (tune.lastEx - ex).toFloat()          // px the target shifted on screen (positive = we reduced the error)
                    val want = tune.lastEx.toFloat()                  // we wanted to remove the whole error
                    if (Math.abs(want) > dz) {
                        val ratio = (moved / want).coerceIn(-1f, 3f)  // 1 = perfect, <1 undershoot, >1 overshoot
                        if (ratio > 0.05f) { tune.gain = (tune.gain * (1f + 0.35f * (1f - ratio))).coerceIn(0.05f, 5f); tune.samples++ }
                    }
                }
                if (Math.abs(ex) <= dz && Math.abs(ey) <= dz) { tune.pending = false; return null }
                val sens = tune.gain; val maxStep = (a.int("maxStep") ?: 300).coerceIn(5, 1500).toFloat()
                val dx = (ex * sens).coerceIn(-maxStep, maxStep); val dy = (ey * sens).coerceIn(-maxStep, maxStep)
                tune.lastEx = ex; tune.lastEy = ey; tune.lastDx = dx; tune.lastDy = dy; tune.pending = true
                lastAimErr = Math.max(Math.abs(ex), Math.abs(ey))
                Action(type = "aim", x = a.float("x"), y = a.float("y"), dx = dx, dy = dy, duration = (a.long("duration") ?: 60L), finger = a.int("finger") ?: 1, steps = 3, release = true)
            }
            "tap" -> Action(type = "tap", x = a.float("x"), y = a.float("y"))
            "long_press" -> Action(type = "long_press", x = a.float("x"), y = a.float("y"), duration = a.long("duration"))
            "swipe" -> Action(type = "swipe", x1 = a.float("x1"), y1 = a.float("y1"), x2 = a.float("x2"), y2 = a.float("y2"), duration = a.long("duration"))
            "tap_sequence" -> Action(type = "tap_sequence", points = a["points"]?.let { runCatching { RelayJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(SeqPoint.serializer()), it) }.getOrNull() })
            "repeat_tap" -> Action(type = "repeat_tap", x = a.float("x"), y = a.float("y"), count = a.int("count"), intervalMs = a.long("intervalMs"))
            "joystick" -> Action(type = "joystick", x = a.float("x"), y = a.float("y"), angle = a["angle"]?.jsonPrimitive?.doubleOrNull, distance = a.float("distance"), duration = a.long("duration"), finger = a.int("finger"), release = a["release"]?.jsonPrimitive?.booleanOrNull)
            "aim" -> {
                // v2.7 alternate: flip direction each run → camera sweeps left/right (or up/down) to look for enemies
                var dx = a.float("dx") ?: 0f; var dy = a.float("dy") ?: 0f
                if (a["alternate"]?.jsonPrimitive?.booleanOrNull == true) { val flip = altState[key] ?: false; if (flip) { dx = -dx; dy = -dy }; altState[key] = !flip }
                Action(type = "aim", x = a.float("x"), y = a.float("y"), dx = dx, dy = dy, duration = a.long("duration"), finger = a.int("finger"), steps = a.int("steps"), release = a["release"]?.jsonPrimitive?.booleanOrNull)
            }
            "fire_burst" -> {
                // v3.0 trigger-bot: only fire when the found target is within maxRange px of the crosshair (user aims, bot shoots)
                val maxRange = a.int("maxRange") ?: 0
                if (maxRange > 0) {
                    val f = found ?: return null
                    val cx = a.int("crosshairX") ?: bmp.width / 2; val cy = a.int("crosshairY") ?: bmp.height / 2
                    if (Math.abs(f.x - cx) > maxRange || Math.abs(f.y - cy) > maxRange) return null
                }
                // v3.1 fire gate: if the aim action just before us had to correct more than gateErr px, the crosshair is still travelling — wait for the next tick instead of wasting the burst
                val gate = a.int("gateErr") ?: 0
                if (gate > 0 && lastAimErr > gate) { lastAimErr = 0; return null }
                lastAimErr = 0
                Action(type = "fire_burst", x = a.float("x"), y = a.float("y"), count = a.int("count"), intervalMs = a.long("intervalMs"), holdMs = a.long("holdMs"))
            }
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
