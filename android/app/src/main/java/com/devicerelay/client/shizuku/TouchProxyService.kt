package com.devicerelay.client.shizuku

import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.InputEvent
import android.view.MotionEvent
import android.view.Surface
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.system.exitProcess

/**
 * v3.4 — runs as the *shell* uid inside a Shizuku user service.
 *
 * Why: an AccessibilityService gesture is an "injected" touch, and Android cancels injected touches the moment a real
 * finger moves (and vice-versa). Here we open the kernel touchscreen node (/dev/input/eventN, shell is in the `input`
 * group) and
 *   • READ the raw multitouch stream → we know, sub-millisecond, where the user's real fingers are (fire button held?)
 *   • WRITE our own MT slot into the same node (like `sendevent`) → to Android it is simply a 2nd finger of the same
 *     touchscreen — no injection, nothing to cancel. The game sees: user's finger on FIRE + our finger dragging the camera.
 *
 * Protocol: Linux MT type B. We use the highest slot the device exposes and tracking ids near the top of the range so we
 * never collide with the driver's small incrementing ids.
 */
class TouchProxyService : ITouchProxy.Stub() {
    companion object {
        private const val TAG = "TouchProxy"
        private const val EV_SYN = 0; private const val EV_KEY = 1; private const val EV_ABS = 3
        private const val SYN_REPORT = 0
        private const val BTN_TOUCH = 0x14a
        private const val ABS_MT_SLOT = 0x2f; private const val ABS_MT_POSITION_X = 0x35; private const val ABS_MT_POSITION_Y = 0x36
        private const val ABS_MT_TRACKING_ID = 0x39
    }

    private class Range(val min: Int, val max: Int) { val span get() = max - min + 1 }
    private class Dev(val path: String, val name: String, val x: Range, val y: Range, val slots: Range, val tracking: Range, val direct: Boolean)

    private val is64 = android.os.Process.is64Bit()
    private val evSize = if (is64) 24 else 16
    private var dev: Dev? = null
    private var input: FileInputStream? = null
    private var output: FileOutputStream? = null
    private var rwFd: FileDescriptor? = null           // single O_RDWR descriptor (preferred)
    private var shWriter: java.io.OutputStream? = null // fallback: persistent `sh` with the device on fd 3
    private var writeMode = "none"
    private var diag = ""
    private var reader: Thread? = null
    @Volatile private var alive = false
    private var lastError: String? = null

    // ---- real finger state (reader thread writes, binder threads read the committed snapshot)
    private val slotTracking = IntArray(32) { -1 }
    private val slotX = IntArray(32); private val slotY = IntArray(32); private val slotDown = LongArray(32)
    private var curSlot = 0
    @Volatile private var snapshot: IntArray = IntArray(0)
    @Volatile private var lastEventAt = 0L
    private var readEvents = 0L

    // ---- our finger
    private var ourSlot = 9
    private var ourTrackingBase = 60000
    private var ourTrackingN = 0
    @Volatile private var ourDown = false
    private var ourX = 0; private var ourY = 0          // display px
    @Volatile private var boundSlot = -1
    private var downs = 0L; private var moves = 0L; private var writeErrors = 0L; private var reinjects = 0L
    private val writeLock = Any()

    // ---- v3.4.1 system-level injection (fallback when the kernel node is not writable — SELinux on many OEM ROMs)
    private var injMethod: java.lang.reflect.Method? = null
    private var injTarget: Any? = null
    private val injLock = Any()
    private var injDownTime = 0L
    @Volatile private var fireHeld = false          // our injected finger is on the fire button
    @Volatile private var aimDown = false           // our injected aim pointer is down (inject mode)
    private var aimX = 0f; private var aimY = 0f
    private var fireRealSlot = -1
    private var realCountAtInject = 0
    @Volatile private var fireEnabled = false
    @Volatile private var fireBtnX = 0; @Volatile private var fireBtnY = 0; @Volatile private var fireBtnR = 70
    @Volatile private var firingNow = false
    private var injDowns = 0L; private var injErrors = 0L

    private fun initInjector() {
        runCatching {
            val im = runCatching { Class.forName("android.hardware.input.InputManager") }.getOrNull()
            val target: Any?; val cls: Class<*>
            val g = runCatching { Class.forName("android.hardware.input.InputManagerGlobal") }.getOrNull()
            if (g != null) { target = g.getMethod("getInstance").invoke(null); cls = g }
            else { target = im!!.getMethod("getInstance").invoke(null); cls = im }
            injMethod = cls.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType)
            injTarget = target
        }.onFailure { lastError = "injector: $it"; Log.w(TAG, "injector init failed", it) }
    }
    private fun inject(ev: MotionEvent): Boolean {
        val m = injMethod ?: return false
        return try { (m.invoke(injTarget, ev, 0) as? Boolean) ?: true } catch (e: Exception) { injErrors++; lastError = "inject: ${e.cause ?: e}"; false } finally { ev.recycle() }
    }
    private fun props(n: Int): Array<MotionEvent.PointerProperties> = Array(n) { i -> MotionEvent.PointerProperties().apply { id = i; toolType = MotionEvent.TOOL_TYPE_FINGER } }
    private fun coords(vararg xy: Float): Array<MotionEvent.PointerCoords> = Array(xy.size / 2) { i -> MotionEvent.PointerCoords().apply { x = xy[i * 2]; y = xy[i * 2 + 1]; pressure = 1f; size = 0.05f } }
    private fun motion(action: Int, n: Int, vararg xy: Float): MotionEvent {
        val now = SystemClock.uptimeMillis()
        if (action == MotionEvent.ACTION_DOWN) injDownTime = now
        return MotionEvent.obtain(injDownTime, now, action, n, props(n), coords(*xy), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
    }
    /** pointer 0 = fire (always first while held), pointer 1 = aim */
    private fun injFireDown(): Boolean = synchronized(injLock) {
        if (fireHeld) return true
        val ok = inject(motion(MotionEvent.ACTION_DOWN, 1, fireBtnX.toFloat(), fireBtnY.toFloat()))
        if (ok) { fireHeld = true; injDowns++ }
        ok
    }
    private fun injAimDown(x: Float, y: Float): Boolean = synchronized(injLock) {
        if (!fireHeld) return false
        if (aimDown) return true
        val ok = inject(motion(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, fireBtnX.toFloat(), fireBtnY.toFloat(), x, y))
        if (ok) { aimDown = true; aimX = x; aimY = y }
        ok
    }
    private fun injAimMove(x: Float, y: Float): Boolean = synchronized(injLock) {
        if (!fireHeld || !aimDown) return false
        val ok = inject(motion(MotionEvent.ACTION_MOVE, 2, fireBtnX.toFloat(), fireBtnY.toFloat(), x, y))
        if (ok) { aimX = x; aimY = y }
        ok
    }
    private fun injAimUp() = synchronized(injLock) {
        if (!aimDown) return
        aimDown = false
        if (fireHeld) inject(motion(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, fireBtnX.toFloat(), fireBtnY.toFloat(), aimX, aimY))
    }
    private fun injAllUp() = synchronized(injLock) {
        if (aimDown) injAimUp()
        if (fireHeld) { fireHeld = false; inject(motion(MotionEvent.ACTION_UP, 1, fireBtnX.toFloat(), fireBtnY.toFloat())) }
    }
    /** a real pointer came/went while we hold → Android cancelled our stream: re-take the button (and the aim pointer) */
    private fun injReinject() = synchronized(injLock) {
        val hadAim = aimDown; val ax = aimX; val ay = aimY
        injAllUp(); reinjects++
        if (injFireDown() && hadAim) injAimDown(ax, ay)
    }

    // ---- mapping
    @Volatile private var rotation = 0
    @Volatile private var dispW = 720; @Volatile private var dispH = 1600

    init { initInjector(); runCatching { open() }.onFailure { lastError = it.toString(); Log.w(TAG, "open failed", it) } }

    // ------------------------------------------------------------------ discovery (getevent -p is available to shell)
    private fun discover(): Dev? {
        val p = ProcessBuilder("getevent", "-p").redirectErrorStream(true).start()
        val text = p.inputStream.bufferedReader().readText(); p.waitFor()
        val devs = ArrayList<Dev>()
        var path = ""; var name = ""; var direct = false
        val abs = HashMap<Int, Range>()
        fun flush() {
            if (path.isNotEmpty() && abs.containsKey(ABS_MT_POSITION_X) && abs.containsKey(ABS_MT_POSITION_Y))
                devs.add(Dev(path, name, abs[ABS_MT_POSITION_X]!!, abs[ABS_MT_POSITION_Y]!!, abs[ABS_MT_SLOT] ?: Range(0, 9), abs[ABS_MT_TRACKING_ID] ?: Range(0, 65535), direct))
            path = ""; name = ""; direct = false; abs.clear()
        }
        val absRe = Regex("""^\s*([0-9a-f]{4})\s*:\s*value\s+-?\d+,\s*min\s+(-?\d+),\s*max\s+(-?\d+)""")
        for (line in text.lines()) {
            val add = Regex("""^add device \d+:\s*(/dev/input/event\d+)""").find(line)
            if (add != null) { flush(); path = add.groupValues[1]; continue }
            if (line.trim().startsWith("name:")) { name = line.substringAfter("name:").trim().trim('"'); continue }
            if (line.contains("INPUT_PROP_DIRECT")) { direct = true; continue }
            absRe.find(line)?.let { m -> abs[m.groupValues[1].toInt(16)] = Range(m.groupValues[2].toInt(), m.groupValues[3].toInt()) }
        }
        flush()
        return devs.firstOrNull { it.direct } ?: devs.firstOrNull()
    }

    private fun sh(cmd: String): String = runCatching {
        val p = ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start()
        val t = p.inputStream.bufferedReader().readText(); p.waitFor(); t.trim()
    }.getOrElse { "ERR $it" }
    /** who are we, what is the node, does the stock sendevent binary manage to write? */
    private fun collectDiag(path: String): String =
        "id=[" + sh("id") + "] node=[" + sh("ls -lZ $path") + "] ctx=[" + sh("cat /proc/self/attr/current") + "] sendevent=[" + sh("sendevent $path 0 0 0 && echo OK") + "]"

    private fun open() {
        val d = discover() ?: run { lastError = "no touchscreen in getevent -p"; return }
        dev = d
        val f = File(d.path)
        diag = collectDiag(d.path)
        // 1) one O_RDWR fd (no O_CREAT/O_TRUNC that Java's FileOutputStream adds)
        runCatching { Os.open(d.path, OsConstants.O_RDWR or OsConstants.O_CLOEXEC, 0) }.onSuccess { fd ->
            rwFd = fd; input = FileInputStream(fd); output = FileOutputStream(fd); writeMode = "rdwr"
        }.onFailure { e1 ->
            lastError = "O_RDWR: $e1"
            // 2) read-only stream + write through a persistent shell (`exec 3>>dev`, O_WRONLY|O_APPEND)
            input = runCatching { FileInputStream(f) }.getOrElse { throw IllegalStateException("read open failed: $it (rdwr: $e1)") }
            val sh = runCatching { ProcessBuilder("sh").redirectErrorStream(true).start() }.getOrNull()
            if (sh != null) {
                shWriter = sh.outputStream
                shWriter!!.write("exec 3>>${d.path} || echo OPENFAIL\n".toByteArray()); shWriter!!.flush()
                Thread.sleep(150)
                val avail = sh.inputStream.available()
                if (avail > 0) { val b = ByteArray(avail); sh.inputStream.read(b); val out = String(b); if (out.contains("OPENFAIL") || out.contains("denied")) { lastError = "$lastError; sh: ${out.trim()}"; shWriter = null } }
                if (shWriter != null) writeMode = "sh-append"
            }
            if (shWriter == null) writeMode = "read-only"
        }
        ourSlot = d.slots.max.coerceIn(1, 31)
        ourTrackingBase = (d.tracking.max - 100).coerceAtLeast(1000)
        alive = true
        reader = Thread({ readLoop() }, "touch-reader").apply { isDaemon = true; start() }
        if (writeMode == "read-only") lastError = "can read but cannot write ${d.path}: ${lastError ?: ""}"
        Log.i(TAG, "opened ${d.path} (${d.name}) x=${d.x.min}..${d.x.max} y=${d.y.min}..${d.y.max} slots=${d.slots.max} ourSlot=$ourSlot 64bit=$is64")
    }

    // ------------------------------------------------------------------ reader
    private fun readLoop() {
        val buf = ByteArray(evSize * 64)
        val bb = ByteBuffer.wrap(buf).order(ByteOrder.nativeOrder())
        val ins = input ?: return
        while (alive) {
            val n = try { ins.read(buf) } catch (e: Exception) { lastError = e.toString(); break }
            if (n <= 0) continue
            var off = 0
            while (off + evSize <= n) {
                bb.position(off)
                if (is64) { bb.long; bb.long } else { bb.int; bb.int }
                val type = bb.short.toInt() and 0xFFFF; val code = bb.short.toInt() and 0xFFFF; val value = bb.int
                off += evSize
                readEvents++
                when (type) {
                    EV_ABS -> when (code) {
                        ABS_MT_SLOT -> curSlot = value.coerceIn(0, 31)
                        ABS_MT_TRACKING_ID -> if (curSlot != ourSlot) { if (value >= 0 && slotTracking[curSlot] < 0) slotDown[curSlot] = System.currentTimeMillis(); slotTracking[curSlot] = value }
                        ABS_MT_POSITION_X -> if (curSlot != ourSlot) slotX[curSlot] = value
                        ABS_MT_POSITION_Y -> if (curSlot != ourSlot) slotY[curSlot] = value
                    }
                    EV_SYN -> if (code == SYN_REPORT) commit()
                }
            }
        }
        alive = false
    }

    private fun commit() {
        lastEventAt = System.currentTimeMillis()
        var n = 0
        for (s in 0 until 32) if (s != ourSlot && slotTracking[s] >= 0) n++
        val out = IntArray(n * 4); var i = 0
        val now = System.currentTimeMillis()
        for (s in 0 until 32) if (s != ourSlot && slotTracking[s] >= 0) {
            val (dx, dy) = rawToDisplay(slotX[s], slotY[s])
            out[i++] = s; out[i++] = dx; out[i++] = dy; out[i++] = (now - slotDown[s]).toInt()
        }
        snapshot = out
        val b = boundSlot
        if (b >= 0 && ourDown && slotTracking[b] < 0) { fingerUp() }   // the real finger we were bound to lifted → lift ours at once
        // ---- fire button tracking / take-over
        if (fireEnabled) {
            var slot = -1
            if (fireRealSlot >= 0 && slotTracking[fireRealSlot] >= 0) slot = fireRealSlot   // keep following the same finger while it is down
            else {
                var i = 0
                while (i + 3 < out.size) { val dx = out[i + 1] - fireBtnX; val dy = out[i + 2] - fireBtnY; if (dx * dx + dy * dy <= fireBtnR * fireBtnR) { slot = out[i]; break }; i += 4 }
            }
            firingNow = slot >= 0
            if (injectMode()) {
                if (slot >= 0 && !fireHeld) { fireRealSlot = slot; realCountAtInject = n; injFireDown() }
                else if (slot < 0 && fireHeld) { fireRealSlot = -1; injAllUp() }
                else if (fireHeld && n != realCountAtInject) { realCountAtInject = n; injReinject() }
            } else fireRealSlot = slot
        } else if (fireHeld) injAllUp()
    }

    // ------------------------------------------------------------------ mapping raw <-> display (current rotation)
    private val natW get() = if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) dispH else dispW
    private val natH get() = if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) dispW else dispH

    private fun rawToDisplay(rx: Int, ry: Int): Pair<Int, Int> {
        val d = dev ?: return 0 to 0
        val nx = ((rx - d.x.min).toLong() * natW / d.x.span).toInt().coerceIn(0, natW - 1)
        val ny = ((ry - d.y.min).toLong() * natH / d.y.span).toInt().coerceIn(0, natH - 1)
        return when (rotation) {
            Surface.ROTATION_90 -> ny to (natW - 1 - nx)
            Surface.ROTATION_180 -> (natW - 1 - nx) to (natH - 1 - ny)
            Surface.ROTATION_270 -> (natH - 1 - ny) to nx
            else -> nx to ny
        }
    }
    private fun displayToRaw(x: Int, y: Int): Pair<Int, Int> {
        val d = dev ?: return 0 to 0
        val (nx, ny) = when (rotation) {
            Surface.ROTATION_90 -> (natW - 1 - y) to x
            Surface.ROTATION_180 -> (natW - 1 - x) to (natH - 1 - y)
            Surface.ROTATION_270 -> y to (natH - 1 - x)
            else -> x to y
        }
        val rx = d.x.min + (nx.coerceIn(0, natW - 1).toLong() * d.x.span / natW).toInt()
        val ry = d.y.min + (ny.coerceIn(0, natH - 1).toLong() * d.y.span / natH).toInt()
        return rx.coerceIn(d.x.min, d.x.max) to ry.coerceIn(d.y.min, d.y.max)
    }

    // ------------------------------------------------------------------ writer
    private fun ev(bb: ByteBuffer, type: Int, code: Int, value: Int) {
        if (is64) { bb.putLong(0); bb.putLong(0) } else { bb.putInt(0); bb.putInt(0) }
        bb.putShort(type.toShort()); bb.putShort(code.toShort()); bb.putInt(value)
    }
    private fun write(vararg events: IntArray): Boolean {
        val bb = ByteBuffer.allocate(evSize * events.size).order(ByteOrder.nativeOrder())
        for (e in events) ev(bb, e[0], e[1], e[2])
        val bytes = bb.array()
        val out = output
        if (out != null) return try { out.write(bytes); true } catch (e: Exception) { writeErrors++; lastError = e.toString(); false }
        val w = shWriter ?: return false
        // printf with octal escapes into fd 3 — a shell builtin, no fork per event
        val sb = StringBuilder("printf '")
        for (b in bytes) { sb.append('\\'); sb.append(Integer.toOctalString(b.toInt() and 0xFF).padStart(3, '0')) }
        sb.append("' >&3\n")
        return try { w.write(sb.toString().toByteArray()); w.flush(); true } catch (e: Exception) { writeErrors++; lastError = e.toString(); false }
    }
    private fun realFingers(): Int = snapshot.size / 4

    // ------------------------------------------------------------------ ITouchProxy
    override fun describe(): String {
        val d = dev
        return if (d == null) "not open: ${lastError ?: "unknown"} $diag" else
            "${d.path} \"${d.name}\" raw x=${d.x.min}..${d.x.max} y=${d.y.min}..${d.y.max} slots=0..${d.slots.max} ourSlot=$ourSlot 64bit=$is64 rot=$rotation disp=${dispW}x$dispH alive=$alive write=$writeMode inject=${injMethod != null} fireHeld=$fireHeld injDowns=$injDowns injErr=$injErrors events=$readEvents err=${lastError ?: "-"} $diag"
    }
    override fun isReady(): Boolean = alive && dev != null && (injectMode() || (writeMode != "read-only" && writeMode != "none"))
    override fun setMapping(rotation: Int, dispW: Int, dispH: Int) { this.rotation = rotation; this.dispW = dispW; this.dispH = dispH }
    override fun touches(): IntArray = snapshot
    override fun lastEventAgeMs(): Long = if (lastEventAt == 0L) -1 else System.currentTimeMillis() - lastEventAt

    override fun setFireButton(x: Int, y: Int, radius: Int, enabled: Boolean) { fireBtnX = x; fireBtnY = y; fireBtnR = radius.coerceAtLeast(5); fireEnabled = enabled; if (!enabled) { firingNow = false; fireRealSlot = -1; injAllUp() } }
    override fun firing(): Boolean = fireEnabled && (if (injectMode()) fireHeld else firingNow)
    override fun injectMode(): Boolean = (writeMode == "read-only" || writeMode == "none") && injMethod != null

    override fun fingerDown(x: Int, y: Int, bindSlot: Int): Boolean = synchronized(writeLock) {
        if (injectMode()) return injAimDown(x.toFloat(), y.toFloat())
        if (!isReady) return false
        if (ourDown) { fingerUpLocked() ; reinjects++ }
        val (rx, ry) = displayToRaw(x, y)
        val id = ourTrackingBase + (ourTrackingN++ % 90)
        val evs = ArrayList<IntArray>()
        evs += intArrayOf(EV_ABS, ABS_MT_SLOT, ourSlot)
        evs += intArrayOf(EV_ABS, ABS_MT_TRACKING_ID, id)
        evs += intArrayOf(EV_ABS, ABS_MT_POSITION_X, rx)
        evs += intArrayOf(EV_ABS, ABS_MT_POSITION_Y, ry)
        if (realFingers() == 0) evs += intArrayOf(EV_KEY, BTN_TOUCH, 1)
        evs += intArrayOf(EV_SYN, SYN_REPORT, 0)
        val ok = write(*evs.toTypedArray())
        if (ok) { ourDown = true; ourX = x; ourY = y; boundSlot = bindSlot; downs++ }
        ok
    }

    override fun fingerMove(x: Int, y: Int): Boolean = synchronized(writeLock) {
        if (injectMode()) return injAimMove(x.toFloat(), y.toFloat())
        if (!ourDown) return false
        val (rx, ry) = displayToRaw(x, y)
        val ok = write(intArrayOf(EV_ABS, ABS_MT_SLOT, ourSlot), intArrayOf(EV_ABS, ABS_MT_POSITION_X, rx), intArrayOf(EV_ABS, ABS_MT_POSITION_Y, ry), intArrayOf(EV_SYN, SYN_REPORT, 0))
        if (ok) { ourX = x; ourY = y; moves++ }
        ok
    }

    override fun fingerUp() { if (injectMode()) { injAimUp(); return }; synchronized(writeLock) { fingerUpLocked() } }
    private fun fingerUpLocked() {
        if (!ourDown) return
        ourDown = false; boundSlot = -1
        val evs = ArrayList<IntArray>()
        evs += intArrayOf(EV_ABS, ABS_MT_SLOT, ourSlot)
        evs += intArrayOf(EV_ABS, ABS_MT_TRACKING_ID, -1)
        if (realFingers() == 0) evs += intArrayOf(EV_KEY, BTN_TOUCH, 0)
        evs += intArrayOf(EV_SYN, SYN_REPORT, 0)
        write(*evs.toTypedArray())
    }

    override fun fingerIsDown(): Boolean = if (injectMode()) aimDown else ourDown
    override fun counters(): LongArray = longArrayOf(downs, moves, readEvents, writeErrors, reinjects, injDowns, injErrors)

    override fun destroy() {
        runCatching { injAllUp() }; runCatching { fingerUp() }
        alive = false
        runCatching { input?.close() }; runCatching { output?.close() }; runCatching { rwFd?.let { Os.close(it) } }; runCatching { shWriter?.write("exit\n".toByteArray()); shWriter?.flush(); shWriter?.close() }
        exitProcess(0)
    }
}
