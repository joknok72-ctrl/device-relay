package com.devicerelay.client.domino

/**
 * On-device Domino All-Fives bot (com.big.ludocafe, "أمريكاني" 1v1, 10-second turns).
 *
 * The AccessibilityService supplies primitives (capture / drag / tap); everything else lives here so it can be
 * unit-tested on the JVM with recorded frames.
 *
 * Tick (~250-400 ms):
 *   1. capture → DominoVision.analyze
 *   2. my turn (timer arc on my avatar) + stable frame (two identical reads) → decide
 *   3. rebuild the layout from the table (spinner = the crosswise double on the main row that has arms), map the
 *      geometric open ends to logical ends, rank moves with AllFives.choose, drag the tile onto the target end
 *   4. verify (hand shrank / table grew) → log; otherwise retry with the next candidate
 *   5. no playable tile (all grey) → tap the boneyard; the game passes by itself when the pile is empty
 */
class DominoBot(private val io: IO) {
    interface IO {
        suspend fun capture(): Triple<IntArray, Int, Int>?
        suspend fun drag(x1: Float, y1: Float, x2: Float, y2: Float, holdMs: Long, moveMs: Long): String?  // null = ok
        suspend fun tap(x: Float, y: Float): String?
        suspend fun sleep(ms: Long)
        fun now(): Long
        fun log(msg: String)
    }

    class Stats { var ticks = 0; var moves = 0; var fails = 0; var passes = 0; var lastMove = ""; var lastError = ""; var lastState = ""; var startedAt = 0L }
    val stats = Stats()
    @Volatile var running = false
    private val logLines = ArrayDeque<String>()
    private fun say(m: String) { io.log(m); synchronized(logLines) { logLines.addLast("${(io.now() - stats.startedAt) / 1000}s $m"); while (logLines.size > 80) logLines.removeFirst() } }

    // ------------------------------------------------------------------ geometry → logic
    /** A geometric open end: exposed pip value + where to drop the next tile. */
    data class GeoEnd(val id: String, val value: Int, val isDouble: Boolean, val tile: DominoVision.TableTile, val dropX: Int, val dropY: Int)

    /**
     * Rebuild the layout from table tiles. The game draws the main line horizontally (row ≈ y300 ref); the spinner is
     * a vertical double on that row with arms above/below; other doubles on the row are drawn crosswise too.
     */
    fun buildLayout(f: DominoVision.Frame): Pair<AllFives.Layout, List<GeoEnd>> {
        val L = AllFives.Layout()
        val ends = ArrayList<GeoEnd>()
        val tiles = f.table.filter { it.a in 0..6 && it.b in 0..6 }
        if (tiles.isEmpty()) return L to ends
        val sx = f.w / DominoVision.REF_W.toDouble(); val sy = f.h / DominoVision.REF_H.toDouble()
        val TL = (122 * sx).toInt(); val TW = (50 * sy).toInt()
        val gap = (6 * sx).toInt()
        val rowY = tiles.groupBy { it.cy / TW }.maxByOrNull { it.value.size }!!.value.map { it.cy }.average().toInt()
        val row = tiles.filter { Math.abs(it.cy - rowY) < TW }.sortedBy { it.cx }
        val offRow = tiles.filter { Math.abs(it.cy - rowY) >= TW }
        // spinner: vertical double on the row that has tiles above/below, else the first vertical double on the row
        // spinner = the crosswise double that has arms; before arms exist, the crosswise double with tiles on BOTH sides
        // (a double dropped at a line end is drawn crosswise too but is not the spinner); tie → closest to the centre
        val doubles = row.filter { it.orient == 'v' && it.a == it.b }
        val centreX = f.w / 2
        val spinnerTile = doubles.firstOrNull { d -> offRow.any { o -> Math.abs(o.cx - d.cx) < TW } }
            ?: doubles.maxWithOrNull(compareBy<DominoVision.TableTile> { d -> minOf(row.count { it.cx < d.cx - TW }, row.count { it.cx > d.cx + TW }) }.thenBy { -Math.abs(it.cx - centreX) })
        L.count = tiles.size
        if (spinnerTile != null) {
            L.spinner = spinnerTile.a
            val leftOf = row.filter { it.cx < spinnerTile.cx - TW }
            val rightOf = row.filter { it.cx > spinnerTile.cx + TW }
            L.spinnerSides = (if (leftOf.isNotEmpty()) 1 else 0) + (if (rightOf.isNotEmpty()) 1 else 0)
            if (leftOf.isNotEmpty()) { val e = lineEnd(leftOf.first(), 'L', TL, TW, gap); L.ends.add(AllFives.End("L", e.value, e.isDouble)); ends.add(e) }
            if (rightOf.isNotEmpty()) { val e = lineEnd(rightOf.last(), 'R', TL, TW, gap); L.ends.add(AllFives.End("R", e.value, e.isDouble)); ends.add(e) }
            if (L.spinnerSides < 2) {
                // exposed spinner: drop on the free side(s)
                if (leftOf.isEmpty()) ends.add(GeoEnd("S", spinnerTile.a, true, spinnerTile, spinnerTile.cx - TW / 2 - gap - TL / 2, spinnerTile.cy))
                if (rightOf.isEmpty()) ends.add(GeoEnd("S", spinnerTile.a, true, spinnerTile, spinnerTile.cx + TW / 2 + gap + TL / 2, spinnerTile.cy))
                if (leftOf.isEmpty()) L.spinnerEndId = "L" else L.spinnerEndId = "R"
            } else {
                val up = offRow.filter { Math.abs(it.cx - spinnerTile.cx) < TL && it.cy < spinnerTile.cy }.sortedBy { it.cy }
                val down = offRow.filter { Math.abs(it.cx - spinnerTile.cx) < TL && it.cy > spinnerTile.cy }.sortedBy { it.cy }
                if (up.isNotEmpty()) { val e = armEnd(up.first(), 'U', TL, TW, gap); L.ends.add(AllFives.End("U", e.value, e.isDouble)); ends.add(e) }
                else { L.ends.add(AllFives.End("U", spinnerTile.a, false, false)); ends.add(GeoEnd("U", spinnerTile.a, false, spinnerTile, spinnerTile.cx, spinnerTile.cy - TL / 2 - gap - TL / 2)) }
                if (down.isNotEmpty()) { val e = armEnd(down.last(), 'D', TL, TW, gap); L.ends.add(AllFives.End("D", e.value, e.isDouble)); ends.add(e) }
                else { L.ends.add(AllFives.End("D", spinnerTile.a, false, false)); ends.add(GeoEnd("D", spinnerTile.a, false, spinnerTile, spinnerTile.cx, spinnerTile.cy + TL / 2 + gap + TL / 2)) }
            }
        } else {
            val el = lineEnd(row.first(), 'L', TL, TW, gap); val er = lineEnd(row.last(), 'R', TL, TW, gap)
            L.ends.add(AllFives.End("L", el.value, el.isDouble)); ends.add(el)
            L.ends.add(AllFives.End("R", er.value, er.isDouble)); ends.add(er)
        }
        return L to ends
    }

    /** end tile on the main row: exposed half = outer half; a crosswise double exposes its value */
    private fun lineEnd(t: DominoVision.TableTile, side: Char, TL: Int, TW: Int, gap: Int): GeoEnd {
        if (t.orient == 'v' || t.a == t.b) {
            val dx = if (side == 'L') -(TW / 2 + gap + TL / 2) else (TW / 2 + gap + TL / 2)
            return GeoEnd(side.toString(), t.a, true, t, t.cx + dx, t.cy)
        }
        val v = if (side == 'L') t.a else t.b
        val dx = if (side == 'L') -(TL + gap) else (TL + gap)
        return GeoEnd(side.toString(), v, false, t, t.cx + dx, t.cy)
    }

    private fun armEnd(t: DominoVision.TableTile, side: Char, TL: Int, TW: Int, gap: Int): GeoEnd {
        if (t.orient == 'h' || t.a == t.b) {
            val dy = if (side == 'U') -(TW / 2 + gap + TL / 2) else (TW / 2 + gap + TL / 2)
            return GeoEnd(side.toString(), t.a, true, t, t.cx, t.cy + dy)
        }
        val v = if (side == 'U') t.a else t.b
        val dy = if (side == 'U') -(TL + gap) else (TL + gap)
        return GeoEnd(side.toString(), v, false, t, t.cx, t.cy + dy)
    }

    // ------------------------------------------------------------------ decision
    data class Plan(val move: AllFives.Move, val hand: DominoVision.HandTile, val end: GeoEnd, val why: String, val rank: Int, val total: Int)

    /** Ranked plans (best first). skip = plans already tried this turn. */
    fun plans(f: DominoVision.Frame, oppCount: Int, boneyard: Int): List<Plan> {
        val (L, geo) = buildLayout(f)
        val hand = f.hand.filter { it.a in 0..6 && it.b in 0..6 }
        val handTiles = hand.map { AllFives.Tile(it.a, it.b) }
        val tableTiles = f.table.filter { it.a in 0..6 && it.b in 0..6 }.map { AllFives.Tile(it.a, it.b) }
        val ranked = AllFives.choose(L, handTiles, tableTiles, oppCount, boneyard)
        val out = ArrayList<Plan>()
        val sx = f.w / DominoVision.REF_W.toDouble(); val sy = f.h / DominoVision.REF_H.toDouble()
        ranked.forEachIndexed { i, s ->
            val m = s.move
            val h = hand.firstOrNull { (it.a == m.tile.a && it.b == m.tile.b) || (it.a == m.tile.b && it.b == m.tile.a) } ?: return@forEachIndexed
            if (L.count == 0) {
                val cx = (800 * sx).toInt(); val cy = (300 * sy).toInt()
                out.add(Plan(m, h, GeoEnd("start", m.tile.a, m.tile.isDouble, DominoVision.TableTile(cx, cy, 'v', m.tile.a, m.tile.b, 0, 0, 0, 0), cx, cy), s.note, i, ranked.size))
                return@forEachIndexed
            }
            val end = geo.firstOrNull { it.id == m.endId && it.value == m.matchValue } ?: geo.firstOrNull { it.value == m.matchValue } ?: return@forEachIndexed
            out.add(Plan(m, h, end, s.note, i, ranked.size))
        }
        return out
    }

    // ------------------------------------------------------------------ loop
    private var lastSig = ""
    private var stable = 0
    private fun sig(f: DominoVision.Frame) = f.hand.joinToString(",") { "${it.a}${it.b}${it.kind[0]}" } + "|" + f.table.size

    suspend fun run(maxMs: Long, startDelayMs: Long) {
        running = true
        stats.startedAt = io.now()
        say("armed — starting in ${startDelayMs} ms (switch to the game now)")
        io.sleep(startDelayMs)
        val t0 = io.now()
        var lastMoveAt = 0L
        var triedThisTurn = 0
        var turnSig = ""
        try {
            while (running && io.now() - t0 < maxMs) {
                stats.ticks++
                val cap = io.capture()
                if (cap == null) { stats.fails++; stats.lastError = "capture failed"; io.sleep(300); continue }
                val (pix, w, h) = cap
                val f = DominoVision.analyze(pix, w, h)
                val s = sig(f)
                if (s == lastSig) stable++ else { stable = 0; lastSig = s }
                stats.lastState = "hand=${f.hand.map { "${it.a}|${it.b}" }} table=${f.table.size} my=${f.myRing} opp=${f.oppRing} grey=${f.handGrey}"
                if (f.hand.isEmpty()) { io.sleep(400); continue }                 // not in a round (menu / result screen)
                if (!f.myTurn) { triedThisTurn = 0; io.sleep(if (f.oppTurn) 300 else 250); continue }
                if (stable < 1) { io.sleep(100); continue }                        // need 2 identical reads
                if (io.now() - lastMoveAt < 1200) { io.sleep(150); continue }      // let the animation settle
                if (s != turnSig) { turnSig = s; triedThisTurn = 0 }
                val playable = f.hand.filter { it.kind != "grey" }
                if (playable.isEmpty()) {
                    val sx = w / DominoVision.REF_W.toFloat(); val sy = h / DominoVision.REF_H.toFloat()
                    say("no playable tile → draw from boneyard")
                    io.tap(1460 * sx, 352 * sy); stats.passes++; lastMoveAt = io.now(); io.sleep(900); continue
                }
                val ps = plans(f, oppCount = 7, boneyard = 14)
                if (ps.isEmpty()) { say("no legal move found (vision?) ${stats.lastState}"); stats.fails++; stats.lastError = "no plan"; io.sleep(350); continue }
                val plan = ps[minOf(triedThisTurn, ps.size - 1)]
                triedThisTurn++
                say("play ${plan.move} #${plan.rank + 1}/${plan.total} [${plan.why}] drag (${plan.hand.cx},${plan.hand.cy})→(${plan.end.dropX},${plan.end.dropY})")
                val err = io.drag(plan.hand.cx.toFloat(), plan.hand.cy.toFloat(), plan.end.dropX.toFloat(), plan.end.dropY.toFloat(), 150, 450)
                lastMoveAt = io.now()
                if (err != null) { say("drag failed: $err"); stats.fails++; stats.lastError = err; io.sleep(250); continue }
                io.sleep(650)
                val after = io.capture() ?: continue
                val f2 = DominoVision.analyze(after.first, after.second, after.third)
                if (f2.hand.size < f.hand.size || f2.table.size > f.table.size || !f2.myTurn) {
                    stats.moves++; stats.lastMove = plan.move.toString(); triedThisTurn = 0
                    say("✓ placed ${plan.move} (hand ${f.hand.size}→${f2.hand.size})")
                } else {
                    stats.fails++; stats.lastError = "tile did not land"
                    say("✗ ${plan.move} did not land — trying next candidate")
                    lastMoveAt = 0
                }
            }
        } finally { running = false; say("stopped: ticks=${stats.ticks} moves=${stats.moves} fails=${stats.fails}") }
    }

    /** plain snapshot; the service turns it into JSON */
    fun status(): Map<String, Any> = mapOf(
        "running" to running, "ticks" to stats.ticks, "moves" to stats.moves, "fails" to stats.fails, "passes" to stats.passes,
        "lastMove" to stats.lastMove, "lastError" to stats.lastError, "lastState" to stats.lastState,
        "log" to synchronized(logLines) { logLines.toList() },
    )
}
