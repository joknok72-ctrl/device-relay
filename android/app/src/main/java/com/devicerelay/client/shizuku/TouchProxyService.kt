package com.devicerelay.client.shizuku

import android.util.Log
import android.view.Surface
import java.io.File
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

    // ---- mapping
    @Volatile private var rotation = 0
    @Volatile private var dispW = 720; @Volatile private var dispH = 1600

    init { runCatching { open() }.onFailure { lastError = it.toString(); Log.w(TAG, "open failed", it) } }

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

    private fun open() {
        val d = discover() ?: run { lastError = "no touchscreen in getevent -p"; return }
        dev = d
        val f = File(d.path)
        input = FileInputStream(f); output = FileOutputStream(f)
        ourSlot = d.slots.max.coerceIn(1, 31)
        ourTrackingBase = (d.tracking.max - 100).coerceAtLeast(1000)
        alive = true
        reader = Thread({ readLoop() }, "touch-reader").apply { isDaemon = true; start() }
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
        val out = output ?: return false
        val bb = ByteBuffer.allocate(evSize * events.size).order(ByteOrder.nativeOrder())
        for (e in events) ev(bb, e[0], e[1], e[2])
        return try { out.write(bb.array()); true } catch (e: Exception) { writeErrors++; lastError = e.toString(); false }
    }
    private fun realFingers(): Int = snapshot.size / 4

    // ------------------------------------------------------------------ ITouchProxy
    override fun describe(): String {
        val d = dev
        return if (d == null) "not open: ${lastError ?: "unknown"}" else
            "${d.path} \"${d.name}\" raw x=${d.x.min}..${d.x.max} y=${d.y.min}..${d.y.max} slots=0..${d.slots.max} ourSlot=$ourSlot 64bit=$is64 rot=$rotation disp=${dispW}x$dispH alive=$alive events=$readEvents err=${lastError ?: "-"}"
    }
    override fun isReady(): Boolean = alive && dev != null
    override fun setMapping(rotation: Int, dispW: Int, dispH: Int) { this.rotation = rotation; this.dispW = dispW; this.dispH = dispH }
    override fun touches(): IntArray = snapshot
    override fun lastEventAgeMs(): Long = if (lastEventAt == 0L) -1 else System.currentTimeMillis() - lastEventAt

    override fun fingerDown(x: Int, y: Int, bindSlot: Int): Boolean = synchronized(writeLock) {
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
        if (!ourDown) return false
        val (rx, ry) = displayToRaw(x, y)
        val ok = write(intArrayOf(EV_ABS, ABS_MT_SLOT, ourSlot), intArrayOf(EV_ABS, ABS_MT_POSITION_X, rx), intArrayOf(EV_ABS, ABS_MT_POSITION_Y, ry), intArrayOf(EV_SYN, SYN_REPORT, 0))
        if (ok) { ourX = x; ourY = y; moves++ }
        ok
    }

    override fun fingerUp() { synchronized(writeLock) { fingerUpLocked() } }
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

    override fun fingerIsDown(): Boolean = ourDown
    override fun counters(): LongArray = longArrayOf(downs, moves, readEvents, writeErrors, reinjects)

    override fun destroy() {
        runCatching { fingerUp() }
        alive = false
        runCatching { input?.close() }; runCatching { output?.close() }
        exitProcess(0)
    }
}
