package com.devicerelay.client.service

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * v2.8 — floating "bot bubble" drawn over the game by the AccessibilityService (TYPE_ACCESSIBILITY_OVERLAY:
 * no SYSTEM_ALERT_WINDOW permission needed). One tap = start the current bot / stop the running one,
 * drag to move, long-press = hide until the app is reopened. Shows live counters while running.
 * Touches on the bubble are consumed by the overlay, so the game never sees them.
 */
class BotOverlay(private val svc: AccessibilityService) {
    private val wm = svc.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val main = Handler(Looper.getMainLooper())
    private var root: LinearLayout? = null
    private var label: TextView? = null
    private var sub: TextView? = null
    private var lp: WindowManager.LayoutParams? = null
    var onTap: (() -> Unit)? = null
    var onLongPress: (() -> Unit)? = null
    @Volatile var visible = false; private set

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, svc.resources.displayMetrics).toInt()

    fun show(text: String, subText: String, running: Boolean) {
        main.post {
            if (root == null) create()
            label?.text = text
            sub?.text = subText
            sub?.visibility = if (subText.isEmpty()) View.GONE else View.VISIBLE
            (root?.background as? GradientDrawable)?.setColor(if (running) 0xE6E11D48.toInt() else 0xE6059669.toInt())
            if (!visible) runCatching { wm.addView(root, lp) }.onSuccess { visible = true }
        }
    }

    fun hide() {
        main.post { if (visible) { runCatching { wm.removeView(root) }; visible = false } }
    }

    private fun create() {
        val ctx = svc
        val bg = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(0xE6059669.toInt()); setStroke(dp(1.5f), 0x66FFFFFF) }
        val l = TextView(ctx).apply { setTextColor(Color.WHITE); textSize = 13f; typeface = android.graphics.Typeface.DEFAULT_BOLD; maxLines = 1 }
        val s = TextView(ctx).apply { setTextColor(0xDDFFFFFF.toInt()); textSize = 10f; maxLines = 1 }
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; background = bg
            setPadding(dp(14f), dp(8f), dp(14f), dp(8f)); gravity = Gravity.CENTER
            addView(l); addView(s)
            elevation = dp(6f).toFloat()
        }
        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.START; x = dp(12f); y = dp(160f) }
        // drag / tap / long-press
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var downT = 0L; var moved = false
        col.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; startX = p.x; startY = p.y; downT = System.currentTimeMillis(); moved = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (Math.abs(dx) > dp(6f) || Math.abs(dy) > dp(6f)) moved = true
                    if (moved) { p.x = (startX + dx).toInt(); p.y = (startY + dy).toInt(); runCatching { wm.updateViewLayout(v, p) } }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) { if (System.currentTimeMillis() - downT > 600) onLongPress?.invoke() else onTap?.invoke() }
                    v.performClick(); true
                }
                else -> true
            }
        }
        root = col; label = l; sub = s; lp = p
    }
}
