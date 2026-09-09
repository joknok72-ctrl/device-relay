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
        // ---- v3.4 HeadLock (mode = "headlock"): the USER fires; while a real finger is on the fire button we lock the
        //      crosshair onto the HEAD of the nearest enemy using a 2nd finger written straight into the touchscreen (Shizuku).
        val mode: String = "auto",                        // auto (v3.3 trigger/hold) | headlock
        val fireRadius: Int = 70,                         // a real finger within this radius of (fireX,fireY) = user is firing
        val headColor: String = "#e6a68a", val headTol: Int = 30, val headMinSize: Int = 6, val headMaxSize: Int = 140,
        val headBox: Box = Box(330, 60, 1000, 440),
        val excludeBox: Box = Box(655, 290, 95, 100),      // own character's head (3rd person) — never lock on it
        val headTopOffset: Int = 5,                       // px below the topmost skin pixel = centre of the head
        val headTopRows: Int = 6,                         // rows under the top used for the x-centre of the head
        val bodyColor: String = "", val bodyTol: Int = 28, // optional: enemy cloth colour to prefer blobs sitting on a body
        val lockRange: Int = 420,                         // max distance from the crosshair to acquire a target
        val headGain: Float = 1.45f, val headMaxStep: Int = 160, val headDeadzone: Int = 1,
        val headLead: Float = 0.6f,                       // velocity feed-forward (fraction of last frame's target motion)
        val lookTravel: Int = 260,                        // re-centre the drag finger after this many px from lookX/lookY
        val stickyMs: Int = 350,                          // keep the last lock this long when the head is briefly hidden
    )

    data class Status(
        val running: Boolean, val name: String? = null, val app: String? = null, val startedAt: Long = 0,
        val frames: Int = 0, val fps: Int = 0, val holding: Boolean = false, val holdCount: Int = 0, val heldMs: Long = 0,
        val aimMoves: Int = 0, val reloads: Int = 0, val lastTrigger: String? = null, val stoppedBy: String? = null,
        val error: String? = null, val startedBy: String? = null,
        // v3.4 headlock
        val mode: String = "auto", val firing: Boolean = false, val locked: Boolean = false, val lockErrPx: Int = -1,
        val nudges: Int = 0, val locks: Int = 0, val shizuku: String? = null, val headX: Int = -1, val headY: Int = -1,
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
        if (c != null) { put("configured", true); put("trigger", c.trigger); put("aimEnabled", c.aimEnabled); put("autoStart", c.autoStart); put("configApp", c.app); put("mode", c.mode) } else put("configured", false)
        put("firing", s.firing); put("locked", s.locked); put("lockErrPx", s.lockErrPx); put("nudges", s.nudges); put("locks", s.locks)
        if (s.headX >= 0) { put("headX", s.headX); put("headY", s.headY) }
        put("shizuku", com.devicerelay.client.shizuku.ShizukuBridge.state())
        com.devicerelay.client.shizuku.ShizukuBridge.proxy?.let { p -> runCatching { put("touchProxy", p.describe()) } }
    }

    // -------------------------------------------------------------------- lifecycle
    fun start(ctx: Context, startedBy: String = "relay"): Boolean {
        val svc = AutomationAccessibilityService.instance ?: run { status = Status(running = false, error = "accessibility service not enabled"); emit(); return false }
        val cfg = load(ctx) ?: run { status = Status(running = false, error = "no aim config — send aim_config first"); emit(); return false }
        if (status.running) return true
        if (cfg.mode == "headlock") {
            val bridge = com.devicerelay.client.shizuku.ShizukuBridge
            if (!bridge.ready) { bridge.bind(); status = Status(running = false, mode = "headlock", shizuku = bridge.state(), error = "headlock needs Shizuku (" + bridge.state() + ") — open Device Relay → Shizuku → allow"); emit(); return false }
        }
        status = Status(running = true, name = cfg.name, app = cfg.app, startedAt = System.currentTimeMillis(), startedBy = startedBy, mode = cfg.mode, shizuku = com.devicerelay.client.shizuku.ShizukuBridge.state())
        emit()
        job = scope.launch { if (cfg.mode == "headlock") headlockLoop(svc, cfg) else loop(svc, cfg) }
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

    // -------------------------------------------------------------------- v3.4 HeadLock loop
    /**
     * The user plays. We only act while one of the user's REAL fingers sits on the fire button (read from the kernel
     * touch stream via the Shizuku proxy): find the nearest enemy skin blob, refine its topmost rows at full resolution
     * to a sub-pixel head centre, and drag the camera with OUR finger (a genuine 2nd touch slot of the same touchscreen,
     * so nothing gets cancelled) until the crosshair error is within headDeadzone px. Closed loop every frame, plus
     * velocity feed-forward so a moving head stays under the crosshair. No auto-fire, no reload, nothing else.
     */
    private suspend fun headlockLoop(svc: AutomationAccessibilityService, cfg: Config) {
        val bridge = com.devicerelay.client.shizuku.ShizukuBridge
        val frameMs = 1000L / cfg.fps.coerceIn(5, 60)
        val headRgb = rgb(cfg.headColor); val bodyRgb = if (cfg.bodyColor.isNotBlank()) rgb(cfg.bodyColor) else -1
        var frames = 0; var nudges = 0; var locks = 0
        var lastEmit = 0L; var fpsWindowStart = SystemClock.elapsedRealtime(); var fpsFrames = 0; var fpsNow = 0
        var stoppedBy: String? = null
        var firing = false; var fireSlot = -1
        var lockedUntil = 0L; var lastHead: Pair<Float, Float>? = null; var prevHead: Pair<Float, Float>? = null; var prevHeadAt = 0L
        var lockErr = -1; var wasLocked = false
        var dragX = cfg.lookX.toFloat(); var dragY = cfg.lookY.toFloat(); var dragDown = false
        var mappingSet = false
        suspend fun lift() { if (dragDown) { runCatching { bridge.proxy?.fingerUp() }; dragDown = false; dragX = cfg.lookX.toFloat(); dragY = cfg.lookY.toFloat() } }
        // mapping FIRST (fire detection needs display coords): one capture gives the bitmap size in the current rotation
        var lastRot = svc.displayRotation()
        suspend fun setMapping() { val b = svc.captureForEngine(); if (b != null) { runCatching { bridge.proxy?.setMapping(lastRot, b.width, b.height) }; b.recycle() } else runCatching { bridge.proxy?.setMapping(lastRot, if (lastRot == 1 || lastRot == 3) 1600 else 720, if (lastRot == 1 || lastRot == 3) 720 else 1600) } }
        setMapping(); mappingSet = true
        runCatching { bridge.proxy?.setFireButton(cfg.fireX, cfg.fireY, cfg.fireRadius, true) }
        val injectMode = runCatching { bridge.proxy?.injectMode() }.getOrNull() ?: false
        val desc = runCatching { bridge.proxy?.describe() }.getOrNull() ?: ""
        val shz = bridge.state() + (if (!injectMode) "+kernel" else if (desc.contains("grabbed=true")) "+grab" else "+takeover")
        Log.i(TAG, "headlock start: $shz :: $desc")
        status = status.copy(shizuku = shz); emit()
        try {
            while (currentCoroutineContext().isActive) {
                val t0 = SystemClock.elapsedRealtime()
                val proxy = bridge.proxy
                if (proxy == null || !runCatching { proxy.isReady }.getOrDefault(false)) { status = status.copy(error = "touch proxy lost", shizuku = bridge.state()); stoppedBy = "shizuku-lost"; break }
                if (cfg.stopOnAppChange && frames % 15 == 0) {
                    val fg = runCatching { svc.currentPackage() }.getOrNull()
                    if (fg != null && fg != cfg.app && fg != "com.devicerelay.client") { stoppedBy = "app-changed"; break }
                }
                // ---- 1. is the user firing? (real finger on the fire button — tracked by the proxy from the kernel stream;
                //         in inject mode the proxy has already taken the button over with its own finger)
                val nowFiring = runCatching { proxy.firing() }.getOrDefault(false)
                val slot = if (nowFiring) 0 else -1
                if (nowFiring && !firing) { fireSlot = slot; prevHead = null; lastHead = null }
                if (!nowFiring && firing) { lift(); lockErr = -1; wasLocked = false }
                firing = nowFiring
                if (!firing) {
                    // idle: cheap — no capture; fast poll of the touch stream; re-map if the display rotated
                    frames++
                    if (frames % 80 == 0) { val r = svc.displayRotation(); if (r != lastRot) { lastRot = r; setMapping() } }
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastEmit > 900) { lastEmit = now; status = status.copy(frames = frames, fps = 0, firing = false, locked = false, lockErrPx = -1, nudges = nudges, locks = locks, shizuku = shz, headX = -1, headY = -1); emit() }
                    delay(12); continue
                }
                // ---- 2. capture + find the head
                val bmp = svc.captureForEngine()
                if (bmp == null) { delay(frameMs); continue }
                frames++; fpsFrames++
                val head = findHead(bmp, headRgb, cfg.headTol, bodyRgb, cfg.bodyTol, cfg.headBox, cfg.excludeBox, cfg.headMinSize, cfg.headMaxSize, cfg.crosshairX, cfg.crosshairY, cfg.lockRange, cfg.headTopOffset, cfg.headTopRows, lastHead)
                bmp.recycle()
                val now = SystemClock.elapsedRealtime()
                var target: Pair<Float, Float>? = null
                if (head != null) {
                    // velocity feed-forward: where will the head be by the time the drag lands (~1 frame)?
                    val ph = prevHead
                    target = if (ph != null && now - prevHeadAt in 1..120) {
                        val vx = (head.first - ph.first) / (now - prevHeadAt) * frameMs; val vy = (head.second - ph.second) / (now - prevHeadAt) * frameMs
                        (head.first + vx * cfg.headLead) to (head.second + vy * cfg.headLead)
                    } else head
                    prevHead = head; prevHeadAt = now; lastHead = head; lockedUntil = now + cfg.stickyMs
                    if (!wasLocked) { locks++; wasLocked = true }
                } else if (now < lockedUntil && lastHead != null) {
                    target = null // briefly hidden: hold the drag finger still, keep the lock alive
                } else { wasLocked = false; lastHead = null; prevHead = null }
                // ---- 3. converge the crosshair onto the head (closed loop, deadzone in px)
                if (target != null) {
                    val ex = target.first - cfg.crosshairX; val ey = target.second - cfg.crosshairY
                    lockErr = kotlin.math.sqrt(ex * ex + ey * ey).toInt()
                    if (abs(ex) > cfg.headDeadzone || abs(ey) > cfg.headDeadzone) {
                        var sx = (ex * cfg.headGain).coerceIn(-cfg.headMaxStep.toFloat(), cfg.headMaxStep.toFloat())
                        var sy = (ey * cfg.headGain).coerceIn(-cfg.headMaxStep.toFloat(), cfg.headMaxStep.toFloat())
                        // sub-pixel steps still matter: never round a needed 0.6 px correction down to nothing
                        if (abs(sx) < 1f && abs(ex) > cfg.headDeadzone) sx = if (ex > 0) 1f else -1f
                        if (abs(sy) < 1f && abs(ey) > cfg.headDeadzone) sy = if (ey > 0) 1f else -1f
                        if (!dragDown || abs(dragX + sx - cfg.lookX) > cfg.lookTravel || abs(dragY + sy - cfg.lookY) > cfg.lookTravel) {
                            lift()
                            dragDown = runCatching { proxy.fingerDown(cfg.lookX, cfg.lookY, fireSlot) }.getOrDefault(false)
                            dragX = cfg.lookX.toFloat(); dragY = cfg.lookY.toFloat()
                        }
                        if (dragDown) {
                            dragX += sx; dragY += sy
                            if (runCatching { proxy.fingerMove(Math.round(dragX), Math.round(dragY)) }.getOrDefault(false)) nudges++
                            else dragDown = false
                        }
                    }
                } else if (head == null && now >= lockedUntil) { lift(); lockErr = -1 }
                // ---- status
                if (now - fpsWindowStart >= 1000) { fpsNow = fpsFrames; fpsFrames = 0; fpsWindowStart = now }
                if (now - lastEmit > 500) {
                    lastEmit = now
                    status = status.copy(frames = frames, fps = fpsNow, firing = true, locked = wasLocked, lockErrPx = lockErr, nudges = nudges, locks = locks, shizuku = shz, aimMoves = nudges, headX = lastHead?.first?.toInt() ?: -1, headY = lastHead?.second?.toInt() ?: -1)
                    emit()
                }
                val spent = SystemClock.elapsedRealtime() - t0
                if (spent < frameMs) delay(frameMs - spent)
            }
        } catch (e: CancellationException) {
            // normal stop
        } catch (e: Exception) {
            Log.w(TAG, "headlock loop error", e); stoppedBy = "error"; status = status.copy(error = e.message)
        } finally {
            withContext(NonCancellable) { runCatching { bridge.proxy?.fingerUp() }; runCatching { bridge.proxy?.setFireButton(cfg.fireX, cfg.fireY, cfg.fireRadius, false) } }
            status = status.copy(running = false, frames = frames, firing = false, locked = false, nudges = nudges, locks = locks, aimMoves = nudges, stoppedBy = status.stoppedBy ?: stoppedBy ?: "loop-end")
            job = null
            emit()
        }
    }

    /**
     * Precise head finder: nearest skin blob to the crosshair (3-px grid CC), preferring the blob nearest the previous
     * head (tracking continuity) and, when bodyColor is set, blobs with cloth colour right below them. Then a
     * FULL-RESOLUTION pass over the blob's bounding box finds the topmost skin row and the mean x of the first
     * `topRows` rows → head centre with sub-pixel x. Returns display px (floats).
     */
    private fun findHead(bmp: Bitmap, skin: Int, tol: Int, body: Int, bodyTol: Int, b: Box, ex: Box, minSize: Int, maxSize: Int, cx: Int, cy: Int, range: Int, topOffset: Int, topRows: Int, prev: Pair<Float, Float>?): Pair<Float, Float>? {
        val step = 3
        val x0 = b.x.coerceIn(0, bmp.width - 1); val y0 = b.y.coerceIn(0, bmp.height - 1)
        val w = min(b.w, bmp.width - x0).coerceAtMost(rowBuf.size); val h = min(b.h, bmp.height - y0); if (w <= 0 || h <= 0) return null
        val gw = (w + step - 1) / step; val gh = (h + step - 1) / step
        val mask = BooleanArray(gw * gh)
        var gy = 0
        while (gy < gh) {
            bmp.getPixels(rowBuf, 0, w, x0, y0 + gy * step, w, 1)
            var gx = 0
            while (gx < gw) { if (near(rowBuf[gx * step] and 0xFFFFFF, skin, tol)) mask[gy * gw + gx] = true; gx++ }
            gy++
        }
        val seen = BooleanArray(gw * gh); val stack = IntArray(gw * gh)
        var bestScore = Double.MAX_VALUE; var bMinX = 0; var bMaxX = 0; var bMinY = 0; var bMaxY = 0; var found = false
        for (i in mask.indices) {
            if (!mask[i] || seen[i]) continue
            var sp = 0; stack[sp++] = i; seen[i] = true
            var n = 0; var minX = gw; var maxX = -1; var minY = gh; var maxY = -1
            while (sp > 0) {
                val k = stack[--sp]; val kx = k % gw; val ky = k / gw
                n++; if (kx < minX) minX = kx; if (kx > maxX) maxX = kx; if (ky < minY) minY = ky; if (ky > maxY) maxY = ky
                if (kx > 0 && mask[k - 1] && !seen[k - 1]) { seen[k - 1] = true; stack[sp++] = k - 1 }
                if (kx < gw - 1 && mask[k + 1] && !seen[k + 1]) { seen[k + 1] = true; stack[sp++] = k + 1 }
                if (ky > 0 && mask[k - gw] && !seen[k - gw]) { seen[k - gw] = true; stack[sp++] = k - gw }
                if (ky < gh - 1 && mask[k + gw] && !seen[k + gw]) { seen[k + gw] = true; stack[sp++] = k + gw }
            }
            val bw = (maxX - minX + 1) * step; val bh = (maxY - minY + 1) * step
            if (bw < minSize && bh < minSize) continue
            if (maxSize > 0 && (bw > maxSize || bh > maxSize)) continue
            val px = x0 + (minX + maxX + 1) * step / 2f; val py = y0 + minY * step.toFloat()
            if (ex.w > 0 && px >= ex.x && px < ex.x + ex.w && py >= ex.y && py < ex.y + ex.h) continue   // own character
            val dCross = Math.hypot((px - cx).toDouble(), (py - cy).toDouble())
            if (dCross > range) continue
            var score = dCross
            if (prev != null) score = min(score, Math.hypot((px - prev.first).toDouble(), (py - prev.second).toDouble()) * 0.5) // continuity wins
            if (body >= 0) { // cloth just below the blob → this skin is a head on a body, not a hand/prop
                val by = (y0 + (maxY + 1) * step + 4).coerceAtMost(bmp.height - 1); val bx = (x0 + (minX + maxX + 1) * step / 2).coerceIn(0, bmp.width - 1)
                var hits = 0
                for (dy in 0 until 12 step 3) { val yy = (by + dy).coerceAtMost(bmp.height - 1); if (near(bmp.getPixel(bx, yy) and 0xFFFFFF, body, bodyTol)) hits++ }
                if (hits > 0) score *= 0.6 else score *= 1.3
            }
            if (score < bestScore) { bestScore = score; bMinX = minX; bMaxX = maxX; bMinY = minY; bMaxY = maxY; found = true }
        }
        if (!found) return null
        // ---- full-resolution refinement over the winning blob's bbox (padded by one grid cell)
        val rx0 = (x0 + (bMinX - 1) * step).coerceAtLeast(0); val rx1 = (x0 + (bMaxX + 2) * step).coerceAtMost(bmp.width)
        val ry0 = (y0 + (bMinY - 1) * step).coerceAtLeast(0); val ry1 = (y0 + (bMaxY + 2) * step).coerceAtMost(bmp.height)
        val rw = rx1 - rx0; if (rw <= 0 || rw > rowBuf.size) return null
        var topY = -1; var sumX = 0.0; var cnt = 0; var rowsUsed = 0
        var y = ry0
        while (y < ry1) {
            bmp.getPixels(rowBuf, 0, rw, rx0, y, rw, 1)
            var rowHits = 0; var rowSum = 0.0
            for (x in 0 until rw) if (near(rowBuf[x] and 0xFFFFFF, skin, tol)) { rowHits++; rowSum += rx0 + x }
            if (rowHits >= 2) {
                if (topY < 0) topY = y
                if (rowsUsed < topRows) { sumX += rowSum; cnt += rowHits; rowsUsed++ }
                else break
            } else if (topY >= 0 && rowsUsed >= 2) break
            y++
        }
        if (topY < 0 || cnt == 0) return null
        return (sumX / cnt).toFloat() to (topY + topOffset).toFloat()
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
