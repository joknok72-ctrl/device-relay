package com.devicerelay.client.service

import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.min

/**
 * v3.3 — AimEngine: a NATIVE shooter assist loop (replaces the rule bot for shooters).
 *
 * The rule bot takes one screenshot per tick and dispatches separate gestures — for a fire button that means
 * DOWN/UP/DOWN/UP → the game sees separate taps (burst-stop-burst). AimEngine instead:
 *   • runs a tight capture loop (~30 fps) and analyses the Bitmap directly (no JSON, no rules),
 *   • keeps ONE real finger on the fire button with chained continueStroke segments that are re-issued BEFORE the
 *     previous one ends → the game sees a single uninterrupted touch, exactly like a human holding the button,
 *   • releases the finger the moment the trigger condition disappears (with hysteresis so detector flicker never lifts),
 *   • optionally nudges the camera (separate finger) onto the nearest target colour (smooth proportional aim),
 *   • pauses fire and taps reload when the ammo counter turns red.
 *
 * Trigger modes:
 *   "reticle" — fire while the game's own crosshair is red (colour present in reticleBox). The GAME decides the enemy is
 *               under the crosshair → zero false positives.
 *   "target"  — fire while the target colour (enemy/head marker) is inside the small box under the crosshair.
 *   "both"    — either.
 */
object AimEngine {
    private const val TAG = "AimEngine"
    private const val PREF = "aim_engine"

    @Serializable
    data class Box(val x: Int, val y: Int, val w: Int, val h: Int)

    @Serializable
    data class Config(
        val app: String = "com.dts.freefireth",
        val name: String = "Free Fire Aim",
        // ---- fire
        val fireX: Int = 1235, val fireY: Int = 485,
        val trigger: String = "reticle",                 // reticle | target | both
        val reticleColor: String = "#f83830", val reticleTol: Int = 34, val reticleMin: Int = 40,
        val reticleBox: Box = Box(770, 330, 60, 62),
        val targetColor: String = "#e6a68a", val targetTol: Int = 30, val targetMin: Int = 8,
        val targetBox: Box = Box(786, 346, 28, 28),
        val armFrames: Int = 1,                           // consecutive positive frames before pressing
        val releaseFrames: Int = 3,                       // consecutive negative frames before lifting
        val maxHoldMs: Long = 8000,                       // safety: lift after this even if still red (then re-arm)
        // ---- aim assist (optional)
        val aimEnabled: Boolean = false,
        val aimColor: String = "#e6a68a", val aimTol: Int = 30, val aimMinSize: Int = 8, val aimMaxSize: Int = 90,
        val aimBox: Box = Box(330, 60, 1000, 420),
        val crosshairX: Int = 800, val crosshairY: Int = 360,
        val lookX: Int = 1050, val lookY: Int = 300,
        val aimGain: Float = 1.5f, val aimMaxStep: Int = 220, val aimDeadzone: Int = 4, val aimRange: Int = 380,
        val aimOffsetY: Int = 0,
        // ---- reload
        val reloadEnabled: Boolean = true,
        val reloadColor: String = "#a82818", val reloadTol: Int = 40, val reloadMin: Int = 60,
        val reloadBox: Box = Box(1290, 25, 150, 95), val reloadX: Int = 1490, val reloadY: Int = 80,
        // ---- loop
        val fps: Int = 30,
        val autoStart: Boolean = true,
        val stopOnAppChange: Boolean = true,
    )

    data class Status(
        val running: Boolean, val name: String? = null, val app: String? = null, val startedAt: Long = 0,
        val frames: Int = 0, val fps: Int = 0, val holding: Boolean = false, val holdCount: Int = 0, val heldMs: Long = 0,
        val aimMoves: Int = 0, val reloads: Int = 0, val lastTrigger: String? = null, val stoppedBy: String? = null,
        val error: String? = null, val startedBy: String? = null,
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null
    @Volatile var status = Status(running = false); private set
    @Volatile var config: Config? = null; private set
    var onStatus: ((Status) -> Unit)? = null

    // -------------------------------------------------------------------- persistence
    fun load(ctx: Context): Config? {
        config?.let { return it }
        val raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString("config", null) ?: return null
        return runCatching { json.decodeFromString(Config.serializer(), raw) }.getOrNull()?.also { config = it }
    }
    fun save(ctx: Context, raw: String): Config? {
        val cfg = runCatching { json.decodeFromString(Config.serializer(), raw) }.getOrElse { Log.w(TAG, "bad aim config", it); return null }
        config = cfg
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString("config", json.encodeToString(cfg)).apply()
        return cfg
    }
    fun clear(ctx: Context) { stop("cleared"); config = null; ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().clear().apply() }

    fun statusJson(): JsonObject = buildJsonObject {
        val s = status
        put("engine", "aim"); put("running", s.running); s.name?.let { put("name", it) }; s.app?.let { put("app", it) }
        put("frames", s.frames); put("fps", s.fps); put("holding", s.holding); put("holdCount", s.holdCount); put("heldMs", s.heldMs)
        put("aimMoves", s.aimMoves); put("reloads", s.reloads); s.lastTrigger?.let { put("lastTrigger", it) }
        s.stoppedBy?.let { put("stoppedBy", it) }; s.error?.let { put("error", it) }; s.startedBy?.let { put("startedBy", it) }
        if (s.startedAt > 0) put("startedAt", s.startedAt)
        val c = config
        if (c != null) { put("configured", true); put("trigger", c.trigger); put("aimEnabled", c.aimEnabled); put("autoStart", c.autoStart); put("configApp", c.app) } else put("configured", false)
    }

    // -------------------------------------------------------------------- lifecycle
    fun start(ctx: Context, startedBy: String = "relay"): Boolean {
        val svc = AutomationAccessibilityService.instance ?: run { status = Status(running = false, error = "accessibility service not enabled"); emit(); return false }
        val cfg = load(ctx) ?: run { status = Status(running = false, error = "no aim config — send aim_config first"); emit(); return false }
        if (status.running) return true
        status = Status(running = true, name = cfg.name, app = cfg.app, startedAt = System.currentTimeMillis(), startedBy = startedBy)
        emit()
        job = scope.launch { loop(svc, cfg) }
        return true
    }

    fun stop(by: String = "relay") {
        val j = job ?: return
        job = null
        status = status.copy(running = false, stoppedBy = by)
        j.cancel()
        emit()
    }

    private fun emit() { runCatching { onStatus?.invoke(status) } }

    // -------------------------------------------------------------------- the loop
    private suspend fun loop(svc: AutomationAccessibilityService, cfg: Config) {
        val frameMs = 1000L / cfg.fps.coerceIn(5, 60)
        val reticleRgb = rgb(cfg.reticleColor); val targetRgb = rgb(cfg.targetColor); val aimRgb = rgb(cfg.aimColor); val reloadRgb = rgb(cfg.reloadColor)
        var posRun = 0; var negRun = 0
        var holding = false; var holdStart = 0L; var holdCount = 0; var heldTotal = 0L
        var frames = 0; var aimMoves = 0; var reloads = 0; var lastReload = 0L
        var lastEmit = 0L; var fpsWindowStart = SystemClock.elapsedRealtime(); var fpsFrames = 0; var fpsNow = 0
        var stoppedBy: String? = null
        val hold = FireHold(svc, cfg.fireX.toFloat(), cfg.fireY.toFloat())
        try {
            while (currentCoroutineContext().isActive) {
                val t0 = SystemClock.elapsedRealtime()
                if (cfg.stopOnAppChange && frames % 15 == 0) {
                    val fg = runCatching { svc.currentPackage() }.getOrNull()
                    if (fg != null && fg != cfg.app && fg != "com.devicerelay.client") { stoppedBy = "app-changed"; break }
                }
                val bmp = svc.captureForEngine()
                if (bmp == null) { if (holding) hold.extend(); delay(frameMs); continue }
                frames++; fpsFrames++
                // ---- analyse
                val reticleRed = if (cfg.trigger == "target") false else count(bmp, reticleRgb, cfg.reticleTol, cfg.reticleBox, 1) >= cfg.reticleMin
                val targetUnder = if (cfg.trigger == "reticle") false else count(bmp, targetRgb, cfg.targetTol, cfg.targetBox, 1) >= cfg.targetMin
                val trig = reticleRed || targetUnder
                val needReload = cfg.reloadEnabled && count(bmp, reloadRgb, cfg.reloadTol, cfg.reloadBox, 2) >= cfg.reloadMin
                // ---- fire state machine with hysteresis
                if (trig) { posRun++; negRun = 0 } else { negRun++; posRun = 0 }
                val overHold = holding && SystemClock.elapsedRealtime() - holdStart > cfg.maxHoldMs
                if (!holding && posRun >= cfg.armFrames && !needReload) {
                    if (hold.press()) { holding = true; holdStart = SystemClock.elapsedRealtime(); holdCount++ }
                } else if (holding && (negRun >= cfg.releaseFrames || needReload || overHold)) {
                    hold.release(); heldTotal += SystemClock.elapsedRealtime() - holdStart; holding = false
                    if (overHold) posRun = 0
                } else if (holding) {
                    hold.extend()
                }
                // ---- reload (only when not holding)
                if (needReload && !holding && SystemClock.elapsedRealtime() - lastReload > 3500) {
                    lastReload = SystemClock.elapsedRealtime(); reloads++
                    withContext(Dispatchers.Main) { runCatching { svc.execute(com.devicerelay.client.net.Action(type = "tap", x = cfg.reloadX.toFloat(), y = cfg.reloadY.toFloat())) } }
                }
                // ---- aim assist: nearest blob of aimColor to the crosshair → proportional camera nudge (only while not already on target)
                if (cfg.aimEnabled && !trig) {
                    val tgt = nearestBlob(bmp, aimRgb, cfg.aimTol, cfg.aimBox, cfg.aimMinSize, cfg.aimMaxSize, cfg.crosshairX, cfg.crosshairY)
                    if (tgt != null) {
                        val ex = tgt.first - cfg.crosshairX; val ey = tgt.second + cfg.aimOffsetY - cfg.crosshairY
                        if (abs(ex) <= cfg.aimRange && abs(ey) <= cfg.aimRange && (abs(ex) > cfg.aimDeadzone || abs(ey) > cfg.aimDeadzone)) {
                            val dx = (ex * cfg.aimGain).coerceIn(-cfg.aimMaxStep.toFloat(), cfg.aimMaxStep.toFloat())
                            val dy = (ey * cfg.aimGain).coerceIn(-cfg.aimMaxStep.toFloat(), cfg.aimMaxStep.toFloat())
                            aimMoves++
                            withContext(Dispatchers.Main) { runCatching { svc.execute(com.devicerelay.client.net.Action(type = "aim", x = cfg.lookX.toFloat(), y = cfg.lookY.toFloat(), dx = dx, dy = dy, duration = 40, finger = 1, steps = 2, release = true)) } }
                        }
                    }
                }
                bmp.recycle()
                // ---- status
                val now = SystemClock.elapsedRealtime()
                if (now - fpsWindowStart >= 1000) { fpsNow = fpsFrames; fpsFrames = 0; fpsWindowStart = now }
                if (now - lastEmit > 700) {
                    lastEmit = now
                    status = status.copy(frames = frames, fps = fpsNow, holding = holding, holdCount = holdCount, heldMs = heldTotal + (if (holding) now - holdStart else 0), aimMoves = aimMoves, reloads = reloads, lastTrigger = if (reticleRed) "reticle" else if (targetUnder) "target" else status.lastTrigger)
                    emit()
                }
                val spent = SystemClock.elapsedRealtime() - t0
                if (spent < frameMs) delay(frameMs - spent)
            }
        } catch (e: CancellationException) {
            // normal stop
        } catch (e: Exception) {
            Log.w(TAG, "aim loop error", e); stoppedBy = "error"; status = status.copy(error = e.message)
        } finally {
            withContext(NonCancellable) { runCatching { hold.release() } }
            if (holding) heldTotal += SystemClock.elapsedRealtime() - holdStart
            status = status.copy(running = false, frames = frames, holding = false, holdCount = holdCount, heldMs = heldTotal, aimMoves = aimMoves, reloads = reloads, stoppedBy = status.stoppedBy ?: stoppedBy ?: "loop-end")
            job = null
            emit()
        }
    }

    // -------------------------------------------------------------------- continuous finger on the fire button
    /**
     * One real touch that never lifts while held: DOWN with willContinue=true, then continuation segments are dispatched
     * before the current one ends so the touch stream never has a gap → the game treats it as one press-and-hold.
     */
    private class FireHold(private val svc: AutomationAccessibilityService, private val x: Float, private val y: Float) {
        private var stroke: GestureDescription.StrokeDescription? = null
        private var px = x
        private var segEnd = 0L
        private val seg = 400L
        suspend fun press(): Boolean {
            val s = GestureDescription.StrokeDescription(Path().apply { moveTo(x, y) }, 0, seg, true)
            val ok = svc.dispatchForEngine(s)
            if (ok) { stroke = s; px = x; segEnd = SystemClock.elapsedRealtime() + seg }
            return ok
        }
        /** re-issue the continuation ≥150 ms before the current segment would end */
        suspend fun extend() {
            val s0 = stroke ?: return
            if (SystemClock.elapsedRealtime() < segEnd - 150) return
            val nx = if (px > x + 2f) x else px + 0.5f  // sub-pixel wiggle keeps MOVE events flowing without leaving the button
            val s = s0.continueStroke(Path().apply { moveTo(px, y); lineTo(nx, y) }, 0, seg, true)
            if (svc.dispatchForEngine(s)) { stroke = s; px = nx; segEnd = SystemClock.elapsedRealtime() + seg }
            else press() // continuation rejected (stroke ended) → re-press immediately so the hold survives
        }
        suspend fun release() {
            val s0 = stroke ?: return
            stroke = null
            svc.dispatchForEngine(s0.continueStroke(Path().apply { moveTo(px, y) }, 0, 20, false))
        }
    }

    // -------------------------------------------------------------------- pixel helpers (no per-frame allocations)
    private fun rgb(hex: String): Int { val h = hex.trim().removePrefix("#"); return h.toLong(16).toInt() and 0xFFFFFF }
    private fun near(c: Int, t: Int, tol: Int): Boolean {
        if (abs(((c shr 16) and 0xFF) - ((t shr 16) and 0xFF)) > tol) return false
        if (abs(((c shr 8) and 0xFF) - ((t shr 8) and 0xFF)) > tol) return false
        return abs((c and 0xFF) - (t and 0xFF)) <= tol
    }
    private val rowBuf = IntArray(2400)
    private fun count(bmp: Bitmap, t: Int, tol: Int, b: Box, step: Int): Int {
        val x0 = b.x.coerceIn(0, bmp.width - 1); val y0 = b.y.coerceIn(0, bmp.height - 1)
        val w = min(b.w, bmp.width - x0).coerceAtMost(rowBuf.size); val h = min(b.h, bmp.height - y0)
        if (w <= 0 || h <= 0) return 0
        var n = 0; var y = y0
        while (y < y0 + h) {
            bmp.getPixels(rowBuf, 0, w, x0, y, w, 1)
            var i = 0
            while (i < w) { if (near(rowBuf[i] and 0xFFFFFF, t, tol)) n++; i += step }
            y += step
        }
        return n * step * step
    }
    /** nearest blob (3-px grid connected components) of colour t inside box to (cx,cy); returns its centre */
    private fun nearestBlob(bmp: Bitmap, t: Int, tol: Int, b: Box, minSize: Int, maxSize: Int, cx: Int, cy: Int): Pair<Int, Int>? {
        val step = 3
        val x0 = b.x.coerceIn(0, bmp.width - 1); val y0 = b.y.coerceIn(0, bmp.height - 1)
        val w = min(b.w, bmp.width - x0).coerceAtMost(rowBuf.size); val h = min(b.h, bmp.height - y0); if (w <= 0 || h <= 0) return null
        val gw = (w + step - 1) / step; val gh = (h + step - 1) / step
        val mask = BooleanArray(gw * gh)
        var gy = 0
        while (gy < gh) {
            bmp.getPixels(rowBuf, 0, w, x0, y0 + gy * step, w, 1)
            var gx = 0
            while (gx < gw) { if (near(rowBuf[gx * step] and 0xFFFFFF, t, tol)) mask[gy * gw + gx] = true; gx++ }
            gy++
        }
        val seen = BooleanArray(gw * gh); val stack = IntArray(gw * gh)
        var best: Pair<Int, Int>? = null; var bestD = Long.MAX_VALUE
        for (i in mask.indices) {
            if (!mask[i] || seen[i]) continue
            var sp = 0; stack[sp++] = i; seen[i] = true
            var n = 0; var sx = 0L; var sy = 0L; var minX = gw; var maxX = -1; var minY = gh; var maxY = -1
            while (sp > 0) {
                val k = stack[--sp]; val kx = k % gw; val ky = k / gw
                n++; sx += kx; sy += ky; if (kx < minX) minX = kx; if (kx > maxX) maxX = kx; if (ky < minY) minY = ky; if (ky > maxY) maxY = ky
                if (kx > 0 && mask[k - 1] && !seen[k - 1]) { seen[k - 1] = true; stack[sp++] = k - 1 }
                if (kx < gw - 1 && mask[k + 1] && !seen[k + 1]) { seen[k + 1] = true; stack[sp++] = k + 1 }
                if (ky > 0 && mask[k - gw] && !seen[k - gw]) { seen[k - gw] = true; stack[sp++] = k - gw }
                if (ky < gh - 1 && mask[k + gw] && !seen[k + gw]) { seen[k + gw] = true; stack[sp++] = k + gw }
            }
            val bw = (maxX - minX + 1) * step; val bh = (maxY - minY + 1) * step
            if (bw < minSize && bh < minSize) continue
            if (maxSize > 0 && (bw > maxSize || bh > maxSize)) continue
            val bx = x0 + (sx / n).toInt() * step + step / 2; val by = y0 + (sy / n).toInt() * step + step / 2
            val d = (bx - cx).toLong() * (bx - cx) + (by - cy).toLong() * (by - cy)
            if (d < bestD) { bestD = d; best = bx to by }
        }
        return best
    }
}
