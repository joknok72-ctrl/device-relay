package com.devicerelay.client.domino

/**
 * All-Fives (American / "أمريكاني") engine — pure logic, no Android.
 *
 * Rules (from the in-game rule pages + observed play):
 *  - double-six set, 7 tiles each, 1v1; the round opens with a double
 *  - the FIRST double of the round is the spinner: after both its long sides are played its two short
 *    ends (U/D) become open ends too
 *  - a tile must match an open end; after every play, if the sum of all open ends is a multiple of 5 the
 *    player gets sum/5 points ("+2 points" for 10). A double lying at an end counts both halves (2×value).
 *    The exposed spinner counts 2×value; un-played spinner arms count 0.
 *  - no legal move → draw from the boneyard (max 2 per turn); still nothing → pass
 *  - round end: the remaining pips of the loser (÷5, rounded) are added to the winner
 *
 * The chooser scores every legal move: immediate points − expected best opponent reply (opponent's tiles
 * are unknown: uniform over unseen tiles) + blocking chance + hand flexibility + heavy-tile dumping.
 */
object AllFives {
    data class Tile(val a: Int, val b: Int) {
        val isDouble get() = a == b
        val pips get() = a + b
        fun has(v: Int) = a == v || b == v
        fun other(v: Int) = if (a == v) b else a
        fun same(o: Tile) = (a == o.a && b == o.b) || (a == o.b && b == o.a)
        override fun toString() = "$a|$b"
    }

    /** An open end. `counts` = false for spinner arms nobody has played on yet (legal target, 0 in the sum). */
    data class End(val id: String, val value: Int, val isDouble: Boolean, val counts: Boolean = true)

    /**
     * spinner: value of the spinner double (null before any double was played).
     * spinnerSides: how many of the spinner's two long sides carry a tile (0..2). While < 2 the spinner is an
     * exposed end itself (id "S", value = spinner, counts 2×spinner).
     * ends: real line ends (never includes the exposed spinner).
     */
    class Layout(
        var spinner: Int? = null,
        var spinnerSides: Int = 0,
        var spinnerEndId: String = "R",
        val ends: MutableList<End> = ArrayList(),
        var count: Int = 0,
    ) {
        fun copy() = Layout(spinner, spinnerSides, spinnerEndId, ends.toMutableList(), count)
        val spinnerExposed get() = spinner != null && spinnerSides < 2
        fun sum(): Int {
            var s = 0
            for (e in ends) if (e.counts) s += if (e.isDouble) e.value * 2 else e.value
            if (spinnerExposed) s += spinner!! * 2
            return s
        }
        /** all legal targets: (id, value) */
        fun targets(): List<Pair<String, Int>> {
            val out = ArrayList<Pair<String, Int>>()
            if (spinnerExposed) out.add("S" to spinner!!)
            for (e in ends) out.add(e.id to e.value)
            return out
        }
        override fun toString() = "spinner=$spinner sides=$spinnerSides ends=${ends.map { "${it.id}:${it.value}${if (it.isDouble) "d" else ""}${if (!it.counts) "?" else ""}" }} sum=${sum()}"
    }

    data class Move(val tile: Tile, val endId: String, val matchValue: Int) {
        override fun toString() = "$tile→$endId($matchValue)"
    }

    fun legalMoves(layout: Layout, hand: List<Tile>): List<Move> {
        val out = ArrayList<Move>()
        if (layout.count == 0) {
            for (t in hand) if (t.isDouble) out.add(Move(t, "start", t.a))
            if (out.isEmpty()) for (t in hand) out.add(Move(t, "start", t.a))
            return out
        }
        for ((id, v) in layout.targets()) for (t in hand) if (t.has(v)) out.add(Move(t, id, v))
        return out
    }

    /** Apply a move → (new layout, points scored). */
    fun apply(layout: Layout, m: Move): Pair<Layout, Int> {
        val L = layout.copy()
        L.count++
        if (layout.count == 0) {
            if (m.tile.isDouble) { L.spinner = m.tile.a; L.spinnerSides = 0 }
            else { L.ends.add(End("L", m.tile.a, false)); L.ends.add(End("R", m.tile.b, false)) }
            return L to score(L.sum())
        }
        val newVal = m.tile.other(m.matchValue)
        if (m.endId == "S") {
            // playing off the exposed spinner
            L.spinnerSides++
            val id = if (L.spinnerSides == 1 && layout.ends.none { it.id == "L" }) "L" else L.spinnerEndId
            L.ends.add(End(id, newVal, m.tile.isDouble))
            if (L.spinnerSides == 2) { L.ends.add(End("U", L.spinner!!, false, false)); L.ends.add(End("D", L.spinner!!, false, false)) }
            return L to score(L.sum())
        }
        val idx = L.ends.indexOfFirst { it.id == m.endId }
        if (idx < 0) return L to 0
        if (m.tile.isDouble && L.spinner == null) {
            // first double of the round played on a line end: it becomes the spinner with one side already attached
            L.ends.removeAt(idx)
            L.spinner = m.tile.a; L.spinnerSides = 1; L.spinnerEndId = m.endId
        } else {
            L.ends[idx] = End(m.endId, newVal, m.tile.isDouble, true)
        }
        return L to score(L.sum())
    }

    fun score(sum: Int) = if (sum > 0 && sum % 5 == 0) sum / 5 else 0

    val ALL: List<Tile> = (0..6).flatMap { a -> (a..6).map { b -> Tile(a, b) } }
    fun unseen(hand: List<Tile>, table: List<Tile>): List<Tile> = ALL.filter { t -> hand.none { it.same(t) } && table.none { it.same(t) } }

    data class Scored(val move: Move, val value: Double, val immediate: Int, val oppExpected: Double, val note: String)

    /**
     * Rank all legal moves (best first).
     * oppCount = tiles in the opponent's hand, boneyard = tiles left in the pile (used for stuck probability).
     */
    fun choose(layout: Layout, hand: List<Tile>, table: List<Tile>, oppCount: Int, boneyard: Int): List<Scored> {
        val moves = legalMoves(layout, hand)
        if (moves.isEmpty()) return emptyList()
        val un = unseen(hand, table)
        val res = ArrayList<Scored>()
        for (m in moves) {
            val (L2, pts) = apply(layout, m)
            val myRest = hand.filter { it !== m.tile }
            // opponent: for each unseen tile, his best immediate score with it on the new layout
            val perTile = ArrayList<Double>()
            var oppCanPlay = 0
            for (t in un) {
                val ms = legalMoves(L2, listOf(t))
                if (ms.isEmpty()) continue
                oppCanPlay++
                var best = 0
                for (om in ms) { val p = apply(L2, om).second; if (p > best) best = p }
                perTile.add(best.toDouble())
            }
            val pHas = if (un.isEmpty()) 0.0 else minOf(1.0, oppCount.toDouble() / un.size)
            perTile.sortDescending()
            var oppBest = 0.0
            if (perTile.isNotEmpty()) { var pNone = 1.0; for (v in perTile) { oppBest += pNone * pHas * v; pNone *= (1 - pHas) } }
            val pOppStuck = if (un.isEmpty()) 0.0 else Math.pow(1.0 - oppCanPlay.toDouble() / un.size, oppCount.toDouble().coerceAtLeast(1.0))
            // my flexibility afterwards
            val tv = L2.targets().map { it.second }.toSet()
            val flex = myRest.count { t -> tv.any { t.has(it) } }
            val myStuck = if (myRest.isNotEmpty() && flex == 0) -1.5 else 0.0
            val weight = m.tile.pips / 12.0            // dump heavy tiles (end-of-round penalty)
            val doubleBonus = if (m.tile.isDouble) 0.35 else 0.0
            val control = myRest.count { it.has(m.tile.other(m.matchValue)) } * 0.15
            val domino = if (myRest.isEmpty()) 6.0 else 0.0
            val value = pts - oppBest * 0.9 + pOppStuck * 2.5 * (if (boneyard > 0) 0.5 else 1.0) + flex * 0.25 + weight * 0.5 + doubleBonus + control + domino + myStuck
            res.add(Scored(m, value, pts, oppBest, "pts=$pts oppE=${"%.2f".format(oppBest)} stuck=${"%.2f".format(pOppStuck)} flex=$flex"))
        }
        res.sortByDescending { it.value }
        return res
    }
}
