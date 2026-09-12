package com.devicerelay.client.domino

/**
 * Domino All-Fives screen reader for the "Domino" mode of com.big.ludocafe (landscape).
 * Pure Kotlin/JVM — works on an IntArray of ARGB pixels so it can be unit-tested off-device.
 *
 * Reference geometry was measured on a 1600x720 landscape frame; every coordinate is scaled by
 * (w/1600, h/720) so other phones work too.
 *
 * What it reads:
 *  - my hand: each tile's screen centre, pips (top|bottom), kind (cream = playable, grey = unplayable, yellow = selected)
 *  - table: every placed tile with centre, orientation (h/v) and pips (left|right or top|bottom)
 *  - turn: green timer ring around my avatar / the opponent's avatar
 *  - grey-face detection tells us whether the game marks unplayable tiles (it does)
 */
object DominoVision {
    const val REF_W = 1600
    const val REF_H = 720

    data class HandTile(val cx: Int, val cy: Int, val x0: Int, val y0: Int, val x1: Int, val y1: Int, val a: Int, val b: Int, val kind: String, val lifted: Boolean)
    data class TableTile(val cx: Int, val cy: Int, val orient: Char, val a: Int, val b: Int, val x0: Int, val y0: Int, val x1: Int, val y1: Int)
    data class Frame(
        val w: Int, val h: Int,
        val hand: List<HandTile>, val table: List<TableTile>,
        val myRing: Int, val oppRing: Int,
        val handGrey: Int, val yellowTable: Int,
    ) {
        val myTurn get() = myRing >= 8
        val oppTurn get() = oppRing >= 8
    }

    class Px(val pix: IntArray, val w: Int, val h: Int) {
        val sx = w / REF_W.toDouble(); val sy = h / REF_H.toDouble()
        inline fun r(i: Int) = (pix[i] shr 16) and 0xFF
        inline fun g(i: Int) = (pix[i] shr 8) and 0xFF
        inline fun b(i: Int) = pix[i] and 0xFF
        fun idx(x: Int, y: Int) = y * w + x
        fun inb(x: Int, y: Int) = x in 0 until w && y in 0 until h
        fun green(x: Int, y: Int): Boolean { if (!inb(x, y)) return false; val i = idx(x, y); val g = g(i); return g > r(i) + 25 && g > b(i) + 25 }
        fun dark(x: Int, y: Int): Boolean { if (!inb(x, y)) return false; val i = idx(x, y); return r(i) + g(i) + b(i) < 330 }
        /** tile face: cream, grey (unplayable) or yellow (selected / highlighted) */
        fun face(x: Int, y: Int): Boolean {
            if (!inb(x, y)) return false
            val i = idx(x, y); val r = r(i); val g = g(i); val b = b(i)
            val mn = minOf(r, g, b); val mx = maxOf(r, g, b)
            return (mn > 125 && mx - mn < 75) || (r > 200 && g > 150 && b < 140 && r - g < 70)
        }
        fun yellow(x: Int, y: Int): Boolean { if (!inb(x, y)) return false; val i = idx(x, y); return r(i) > 200 && g(i) > 160 && b(i) < 120 }
        fun grey(x: Int, y: Int): Boolean { if (!inb(x, y)) return false; val i = idx(x, y); val r = r(i); val g = g(i); val b = b(i); return maxOf(r, g, b) < 200 && minOf(r, g, b) > 125 && maxOf(r, g, b) - minOf(r, g, b) < 30 }
        fun X(refX: Int) = (refX * sx).toInt()
        fun Y(refY: Int) = (refY * sy).toInt()
    }

    // ------------------------------------------------------------------ helpers
    private fun runs(flags: BooleanArray, start: Int): List<IntArray> {
        val out = ArrayList<IntArray>(); var s = -1
        for (i in flags.indices) {
            if (flags[i] && s < 0) s = start + i
            if (!flags[i] && s >= 0) { out.add(intArrayOf(s, start + i - 1)); s = -1 }
        }
        if (s >= 0) out.add(intArrayOf(s, start + flags.size - 1))
        return out
    }

    /** runs of true values, bridging gaps of up to maxGap false values */
    private fun runsGap(flags: BooleanArray, start: Int, maxGap: Int): List<IntArray> {
        val out = ArrayList<IntArray>(); var s = -1; var last = -1
        for (i in flags.indices) {
            if (flags[i]) { if (s < 0) s = i; last = i }
            else if (s >= 0 && i - last > maxGap) { out.add(intArrayOf(start + s, start + last)); s = -1 }
        }
        if (s >= 0) out.add(intArrayOf(start + s, start + last))
        return out
    }

    private class Blob(var n: Int = 0, var sx: Long = 0, var sy: Long = 0, var x0: Int = Int.MAX_VALUE, var y0: Int = Int.MAX_VALUE, var x1: Int = -1, var y1: Int = -1)

    private fun blobs(p: Px, x0: Int, y0: Int, x1: Int, y1: Int, pred: (Int, Int) -> Boolean): List<Blob> {
        val bw = x1 - x0; val bh = y1 - y0
        if (bw <= 0 || bh <= 0) return emptyList()
        val seen = BooleanArray(bw * bh)
        val out = ArrayList<Blob>()
        val stack = IntArray(bw * bh)
        for (y in y0 until y1) for (x in x0 until x1) {
            val k = (y - y0) * bw + (x - x0)
            if (seen[k] || !pred(x, y)) continue
            val b = Blob(); var top = 0; stack[top++] = k; seen[k] = true
            while (top > 0) {
                val c = stack[--top]; val cx = x0 + c % bw; val cy = y0 + c / bw
                b.n++; b.sx += cx; b.sy += cy
                if (cx < b.x0) b.x0 = cx; if (cx > b.x1) b.x1 = cx; if (cy < b.y0) b.y0 = cy; if (cy > b.y1) b.y1 = cy
                if (cx + 1 < x1) { val j = c + 1; if (!seen[j] && pred(cx + 1, cy)) { seen[j] = true; stack[top++] = j } }
                if (cx - 1 >= x0) { val j = c - 1; if (!seen[j] && pred(cx - 1, cy)) { seen[j] = true; stack[top++] = j } }
                if (cy + 1 < y1) { val j = c + bw; if (!seen[j] && pred(cx, cy + 1)) { seen[j] = true; stack[top++] = j } }
                if (cy - 1 >= y0) { val j = c - bw; if (!seen[j] && pred(cx, cy - 1)) { seen[j] = true; stack[top++] = j } }
            }
            out.add(b)
        }
        return out
    }

    /** count roundish dark blobs (pips) inside a half-tile */
    private fun pips(p: Px, x0: Int, y0: Int, x1: Int, y1: Int, mn: Int, mx: Int): Int {
        var c = 0
        for (b in blobs(p, x0, y0, x1, y1) { x, y -> p.dark(x, y) }) {
            val w = b.x1 - b.x0 + 1; val h = b.y1 - b.y0 + 1
            if (b.n in mn..mx && w <= h * 1.6 && h <= w * 1.6) c++
        }
        return c
    }

    /** Read a tile's two halves. vertical = pips top/bottom. Returns (a,b) = (top,bottom) or (left,right). */
    private fun readTile(p: Px, x0: Int, y0: Int, x1: Int, y1: Int, vertical: Boolean): Pair<Int, Int> {
        if (x1 - x0 < 8 || y1 - y0 < 8) return -1 to -1
        val div: Int
        if (vertical) {
            val L = y1 - y0; var best = -1; var bestY = (y0 + y1) / 2
            for (y in y0 + L / 3 until y1 - L / 3) { var s = 0; for (x in x0 until x1) if (p.dark(x, y)) s++; if (s > best) { best = s; bestY = y } }
            div = bestY
        } else {
            val L = x1 - x0; var best = -1; var bestX = (x0 + x1) / 2
            for (x in x0 + L / 3 until x1 - L / 3) { var s = 0; for (y in y0 until y1) if (p.dark(x, y)) s++; if (s > best) { best = s; bestX = x } }
            div = bestX
        }
        val short = if (vertical) x1 - x0 else y1 - y0
        val pad = maxOf(5, short / 8)
        val mn = (short * short * 0.02).toInt(); val mx = (short * short * 0.16).toInt()
        return if (vertical) pips(p, x0, y0, x1, div - pad, mn, mx) to pips(p, x0, div + pad, x1, y1, mn, mx)
        else pips(p, x0, y0, div - pad, y1, mn, mx) to pips(p, div + pad, y0, x1, y1, mn, mx)
    }

    // ------------------------------------------------------------------ hand
    fun readHand(p: Px): List<HandTile> {
        val xa = p.X(380); val xb = p.X(1330)
        val ya = p.Y(490); val yb = p.Y(650)
        // tile columns = not table-green (pips are dark, face is cream) — solid runs per tile
        val flags = BooleanArray(xb - xa) { i ->
            var c = 0; var y = ya
            while (y < yb) { if (!p.green(xa + i, y)) c++; y += 2 }
            c > (yb - ya) / 2 * 0.85
        }
        val minW = p.X(55); val maxW = p.X(100)
        val out = ArrayList<HandTile>()
        for (r in runsGap(flags, xa, 3)) {
            val a = r[0]; val b = r[1]
            if (b - a < minW || b - a > maxW) continue
            val cx = (a + b) / 2
            val ys0 = p.Y(430); val ys1 = p.Y(700)
            val col = BooleanArray(ys1 - ys0) { i -> p.face(cx, ys0 + i) }
            val best = runsGap(col, ys0, p.Y(40)).maxByOrNull { it[1] - it[0] } ?: continue
            val y0 = best[0]; val y1 = best[1]
            if (y1 - y0 < p.Y(150)) continue
            val sxp = a + p.X(8); val syp = y0 + p.Y(25)
            val kind = when {
                p.grey(sxp, syp) -> "grey"
                p.yellow(sxp, syp) -> "yellow"
                else -> "cream"
            }
            val (ta, tb) = readTile(p, a + p.X(6), y0 + p.Y(10), b - p.X(5), y1 - p.Y(4), true)
            out.add(HandTile(cx, (y0 + y1) / 2, a, y0, b, y1, ta, tb, kind, y0 < p.Y(462)))
        }
        return out
    }

    // ------------------------------------------------------------------ table
    /** table tiles are 122x50 (ref). Each tile has one thin dark divider across its middle: find those. */
    fun readTable(p: Px): List<TableTile> {
        val x0 = p.X(120); val y0 = p.Y(95); val x1 = p.X(1400); val y1 = p.Y(485)
        val TL = p.X(122); val TW = p.Y(50)
        val minLen = (TW * 0.52).toInt(); val maxLen = (TW * 1.05).toInt()
        val gapPx = maxOf(3, p.X(6))
        val beadGap = maxOf(6, p.X(14))
        // face mask (only big blobs count as tiles)
        val fw = x1 - x0; val fh = y1 - y0
        val fm = BooleanArray(fw * fh)
        for (b in blobs(p, x0, y0, x1, y1) { x, y -> p.face(x, y) }) {
            if (b.n < TL * TW / 6) continue
            for (y in b.y0..b.y1) for (x in b.x0..b.x1) if (p.face(x, y)) fm[(y - y0) * fw + (x - x0)] = true
        }
        fun inFace(x: Int, y: Int) = x in x0 until x1 && y in y0 until y1 && fm[(y - y0) * fw + (x - x0)]
        // thin dark pixels: dark with face on both sides at +-gap (vertical thin line => horizontal tile)
        val thinV = BooleanArray(fw * fh); val thinH = BooleanArray(fw * fh)
        for (y in y0 until y1) for (x in x0 until x1) {
            if (!p.dark(x, y)) continue
            if (!inFace(x, y) && !(inFace(x - 2, y) || inFace(x + 2, y) || inFace(x, y - 2) || inFace(x, y + 2))) continue
            val k = (y - y0) * fw + (x - x0)
            if (!p.dark(x - gapPx, y) && !p.dark(x + gapPx, y) && inFace(x - gapPx, y) && inFace(x + gapPx, y)) thinV[k] = true
            if (!p.dark(x, y - gapPx) && !p.dark(x, y + gapPx) && inFace(x, y - gapPx) && inFace(x, y + gapPx)) thinH[k] = true
        }
        // vertical runs of thinV => horizontal tiles (divider is a vertical line)
        class Cand(val orient: Char, var cx: Double, var cy: Double, var n: Int)
        val cands = ArrayList<Cand>()
        val used = BooleanArray(fw * fh)
        for (x in x0 until x1) {
            var y = y0
            while (y < y1) {
                val k = (y - y0) * fw + (x - x0)
                if (!thinV[k] || used[k]) { y++; continue }
                var last = y; var yy = y; var gaps = 0
                while (yy < y1) {
                    val kk = (yy - y0) * fw + (x - x0)
                    if (thinV[kk]) { last = yy; used[kk] = true; gaps = 0 } else { gaps++; if (gaps > beadGap) break }
                    yy++
                }
                val len = last - y + 1
                if (len in minLen..maxLen) cands.add(Cand('h', x.toDouble(), (y + last) / 2.0, 1))
                y = last + 1
            }
        }
        val used2 = BooleanArray(fw * fh)
        for (y in y0 until y1) {
            var x = x0
            while (x < x1) {
                val k = (y - y0) * fw + (x - x0)
                if (!thinH[k] || used2[k]) { x++; continue }
                var last = x; var xx = x; var gaps = 0
                while (xx < x1) {
                    val kk = (y - y0) * fw + (xx - x0)
                    if (thinH[kk]) { last = xx; used2[kk] = true; gaps = 0 } else { gaps++; if (gaps > beadGap) break }
                    xx++
                }
                val len = last - x + 1
                if (len in minLen..maxLen) cands.add(Cand('v', (x + last) / 2.0, y.toDouble(), 1))
                x = last + 1
            }
        }
        // merge candidates within ~12px
        val merged = ArrayList<Cand>()
        val tol = p.X(12)
        for (c in cands) {
            val m = merged.firstOrNull { it.orient == c.orient && Math.abs(it.cx - c.cx) < tol && Math.abs(it.cy - c.cy) < tol }
            if (m == null) merged.add(c) else { m.cx = (m.cx * m.n + c.cx) / (m.n + 1); m.cy = (m.cy * m.n + c.cy) / (m.n + 1); m.n++ }
        }
        val out = ArrayList<TableTile>()
        for (m in merged) {
            if (m.n < 2) continue
            val cx = m.cx.toInt(); val cy = m.cy.toInt()
            if (m.orient == 'h') {
                val bx0 = cx - TL / 2; val by0 = cy - TW / 2; val bx1 = cx + TL / 2; val by1 = cy + TW / 2
                // a real horizontal tile has face on both sides of the divider along its long axis
                if (!inFace(cx - TL / 3, cy) || !inFace(cx + TL / 3, cy)) continue
                val (a, b) = readTile(p, bx0 + p.X(6), by0 + p.Y(6), bx1 - p.X(6), by1 - p.Y(8), false)
                out.add(TableTile(cx, cy, 'h', a, b, bx0, by0, bx1, by1))
            } else {
                val bx0 = cx - TW / 2; val by0 = cy - TL / 2; val bx1 = cx + TW / 2; val by1 = cy + TL / 2
                if (!inFace(cx, cy - TL / 3) || !inFace(cx, cy + TL / 3)) continue
                val (a, b) = readTile(p, bx0 + p.X(6), by0 + p.Y(6), bx1 - p.X(6), by1 - p.Y(8), true)
                out.add(TableTile(cx, cy, 'v', a, b, bx0, by0, bx1, by1))
            }
        }
        // drop duplicates (same centre reported by both orientations — keep the one whose face extent matches)
        return out.distinctBy { "${it.cx / tol},${it.cy / tol}" }
    }

    // ------------------------------------------------------------------ misc
    /** timer arc around an avatar: bright green (full) → yellow → red (almost out). Returns matching samples (of 108). */
    fun ring(p: Px, refCx: Int, refCy: Int): Int {
        var g = 0
        val cx = p.X(refCx); val cy = p.Y(refCy)
        for (k in 0 until 36) for (r in intArrayOf(50, 54, 58)) {
            val x = cx + (p.X(r) * Math.cos(2 * Math.PI * k / 36)).toInt(); val y = cy + (p.Y(r) * Math.sin(2 * Math.PI * k / 36)).toInt()
            if (!p.inb(x, y)) continue
            val i = p.idx(x, y); val rr = p.r(i); val gg = p.g(i); val bb = p.b(i)
            val brightGreen = gg > 195 && rr < 130 && bb < 130
            val yellow = rr > 200 && gg > 140 && bb < 110
            val red = rr > 190 && gg < 110 && bb < 110
            if (brightGreen || yellow || red) g++
        }
        return g
    }

    fun analyze(pix: IntArray, w: Int, h: Int): Frame {
        val p = Px(pix, w, h)
        val hand = readHand(p)
        val table = readTable(p)
        var yellowTable = 0
        run {
            var y = p.Y(100); while (y < p.Y(480)) { var x = p.X(150); while (x < p.X(1400)) { if (p.yellow(x, y)) yellowTable++; x += 4 }; y += 4 }
        }
        return Frame(w, h, hand, table, ring(p, 230, 560), ring(p, 818, 62), hand.count { it.kind == "grey" }, yellowTable * 16)
    }
}
