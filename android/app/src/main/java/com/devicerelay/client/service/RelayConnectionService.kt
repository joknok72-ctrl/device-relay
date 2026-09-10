package com.devicerelay.client.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.devicerelay.client.R
import com.devicerelay.client.RelayApp
import com.devicerelay.client.SettingsRepo
import com.devicerelay.client.net.CommandMessage
import com.devicerelay.client.net.HelloMessage
import com.devicerelay.client.net.PongMessage
import com.devicerelay.client.net.RelayJson
import com.devicerelay.client.net.ResultMessage
import com.devicerelay.client.net.ScreenSize
import com.devicerelay.client.net.peekKind
import com.devicerelay.client.ui.MainActivity
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class ConnState { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

data class LogLine(val ts: Long, val text: String, val ok: Boolean = true)

data class RelayUiState(
    val state: ConnState = ConnState.DISCONNECTED,
    val message: String = "",
    val commandsHandled: Int = 0,
    val lastLatencyMs: Long? = null,
    val logs: List<LogLine> = emptyList(),
)

/**
 * Foreground service holding one persistent WebSocket to the Cloudflare relay.
 * Receives {kind:"command"} messages, executes via AutomationAccessibilityService,
 * replies with {kind:"result"}. Reconnects with exponential backoff.
 */
class RelayConnectionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var connectJob: Job? = null
    private var helloJob: Job? = null
    private var streamJob: Job? = null

    /** Live preview: push small JPEG frames to the relay (viewers only) at fps until disabled. */
    private fun setStream(ws: WebSocket, enabled: Boolean, fps: Float?, maxWidth: Int?, quality: Int?) {
        streamJob?.cancel(); streamJob = null
        if (!enabled) return
        val periodMs = (1000f / (fps ?: 2f).coerceIn(0.2f, 4f)).toLong()
        val w = (maxWidth ?: 360).coerceIn(120, 720); val q = (quality ?: 55).coerceIn(10, 90)
        streamJob = scope.launch {
            var fails = 0
            while (true) {
                val t0 = SystemClock.elapsedRealtime()
                val svc = AutomationAccessibilityService.instance
                val frame = svc?.let { runCatching { withContext(Dispatchers.Main) { it.previewFrame(w, q) } }.getOrNull() }
                if (frame != null) {
                    fails = 0
                    val b64 = android.util.Base64.encodeToString(frame.first, android.util.Base64.NO_WRAP)
                    if (!ws.send(RelayJson.encodeToString(com.devicerelay.client.net.FrameMessage.serializer(), com.devicerelay.client.net.FrameMessage(data = b64, mime = frame.second, ts = System.currentTimeMillis())))) break
                } else if (++fails > 10) break
                val wait = periodMs - (SystemClock.elapsedRealtime() - t0)
                delay(if (wait > 50) wait else 50)
            }
        }
    }
    private var socket: WebSocket? = null
    private var stopping = false
    private var backoffMs = 1_000L

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        installForegroundHook()
        startAsForeground("جارٍ الاتصال…")
    }

    // ------------------------------------------------------------ foreground app tracking (profiles / sessions on the relay)
    private fun installForegroundHook() {
        val svc = AutomationAccessibilityService.instance ?: run { scope.launch { delay(3000); installForegroundHook() }; return }
        svc.onForegroundApp = { _ -> refreshNotification() }
    }
    private var lastStatusText = ""
    private fun refreshNotification() { updateNotification(lastStatusText) }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopSelfClean(); return START_NOT_STICKY }
            else -> { stopping = false; connectLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopping = true
        socket?.close(1000, "service destroyed")
        scope.cancel()
        _ui.update { it.copy(state = ConnState.DISCONNECTED, message = "الخدمة متوقفة") }
        super.onDestroy()
    }

    // ------------------------------------------------------------ connection
    private fun connectLoop() {
        if (connectJob?.isActive == true) return
        connectJob = scope.launch {
            while (!stopping) {
                val cfg = SettingsRepo.get(this@RelayConnectionService)
                if (!cfg.isComplete) {
                    setState(ConnState.ERROR, "الإعدادات غير مكتملة")
                    stopSelfClean(); return@launch
                }
                setState(ConnState.CONNECTING, "الاتصال بـ ${cfg.serverUrl}")
                val closed = openSocketAndAwaitClose(cfg.wsUrl(), cfg.token)
                if (stopping) break
                setState(ConnState.ERROR, "انقطع الاتصال ($closed) — إعادة المحاولة خلال ${backoffMs / 1000}s")
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
            }
        }
    }

    /** Opens the WS and suspends until it closes. Returns close reason. */
    private suspend fun openSocketAndAwaitClose(url: String, token: String): String {
        val done = kotlinx.coroutines.CompletableDeferred<String>()
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").build()

        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                backoffMs = 1_000L
                setState(ConnState.CONNECTED, "متصل ✔")
                updateNotification("متصل بالسيرفر")
                ws.send(RelayJson.encodeToString(HelloMessage.serializer(), buildHello()))
                helloJob?.cancel()
                helloJob = scope.launch {
                    while (true) { delay(60_000); runCatching { ws.send(RelayJson.encodeToString(HelloMessage.serializer(), buildHello())) } }
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                when (peekKind(text)) {
                    "command" -> scope.launch { handleCommand(ws, text) }
                    "ping" -> ws.send(RelayJson.encodeToString(PongMessage.serializer(), PongMessage()))
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
            override fun onClosed(ws: WebSocket, code: Int, reason: String) { helloJob?.cancel(); streamJob?.cancel(); done.complete("$code $reason") }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                val msg = response?.let { "HTTP ${it.code}" } ?: (t.message ?: t.javaClass.simpleName)
                Log.w(TAG, "ws failure: $msg", t)
                helloJob?.cancel(); streamJob?.cancel()
                done.complete(msg)
            }
        })
        return done.await()
    }

    // ------------------------------------------------------------ commands
    private suspend fun handleCommand(ws: WebSocket, raw: String) {
        val cmd = runCatching { RelayJson.decodeFromString(CommandMessage.serializer(), raw) }.getOrElse {
            Log.w(TAG, "bad command json", it); return
        }
        val t0 = SystemClock.elapsedRealtime()
        val svc = AutomationAccessibilityService.instance
        val result: ResultMessage = if (cmd.action.type == "ping") {
            ResultMessage(id = cmd.id, ok = true, durationMs = 0)
        } else if (cmd.action.type == "stream") {
            if (AutomationAccessibilityService.instance == null && cmd.action.enabled == true) ResultMessage(id = cmd.id, ok = false, error = "accessibility service not enabled")
            else { setStream(ws, cmd.action.enabled == true, cmd.action.fps, cmd.action.maxWidth, cmd.action.quality); ResultMessage(id = cmd.id, ok = true, durationMs = 0, data = kotlinx.serialization.json.buildJsonObject { put("streaming", kotlinx.serialization.json.JsonPrimitive(cmd.action.enabled == true)) }) }
        } else if (cmd.action.type == "set_device_id") {
            // v4.1.6 admin rename: persist the new id, ack, then reconnect under it (memory was already copied by the relay)
            val newId = cmd.action.text?.trim()?.replace(Regex("[^a-zA-Z0-9_-]"), "-")?.take(64)
            if (newId.isNullOrBlank() || newId.length < 3) ResultMessage(id = cmd.id, ok = false, error = "invalid device id")
            else {
                val cfg = SettingsRepo.get(this)
                SettingsRepo.save(this, cfg.copy(deviceId = newId))
                scope.launch { delay(600); backoffMs = 1_000L; ws.close(1000, "device id changed to $newId") }
                ResultMessage(id = cmd.id, ok = true, durationMs = 0, data = kotlinx.serialization.json.buildJsonObject { put("deviceId", kotlinx.serialization.json.JsonPrimitive(newId)); put("reconnecting", kotlinx.serialization.json.JsonPrimitive(true)) })
            }
        } else if (svc == null) {
            ResultMessage(id = cmd.id, ok = false, error = "accessibility service not enabled")
        } else {
            val budget = execBudgetMs(cmd.action)
            val outcome = withTimeoutOrNull(budget) { withContext(Dispatchers.Main) { svc.execute(cmd.action) } }
            val dur = SystemClock.elapsedRealtime() - t0
            when (outcome) {
                is AutomationAccessibilityService.Outcome.Ok ->
                    ResultMessage(id = cmd.id, ok = true, screenshot = outcome.screenshotBase64, screenshotMime = outcome.mime, durationMs = dur, data = outcome.data)
                is AutomationAccessibilityService.Outcome.Fail ->
                    ResultMessage(id = cmd.id, ok = false, error = outcome.error, durationMs = dur)
                null -> ResultMessage(id = cmd.id, ok = false, error = "execution timeout", durationMs = dur)
            }
        }
        ws.send(RelayJson.encodeToString(ResultMessage.serializer(), result))
        val summary = buildString {
            append(cmd.action.type)
            cmd.action.x?.let { append(" (${it.toInt()},${cmd.action.y?.toInt()})") }
            cmd.action.text?.let { append(" \"${it.take(30)}\"") }
            cmd.action.x1?.let { append(" (${it.toInt()},${cmd.action.y1?.toInt()})→(${cmd.action.x2?.toInt()},${cmd.action.y2?.toInt()})") }
            if (!result.ok) append(" ✖ ${result.error}") else append(" ✔ ${result.durationMs}ms")
        }
        _ui.update {
            it.copy(
                commandsHandled = it.commandsHandled + 1,
                lastLatencyMs = result.durationMs,
                logs = (listOf(LogLine(System.currentTimeMillis(), summary, result.ok)) + it.logs).take(50),
            )
        }
    }

    /** Long on-device sequences (tap_sequence/repeat_tap/swipe_path) need more than the default 12s. */
    private fun execBudgetMs(a: com.devicerelay.client.net.Action): Long {
        val base = 12_000L
        return when (a.type) {
            "tap_sequence" -> base + (a.points?.sumOf { (it.delayMs ?: 0L) + (it.durationMs ?: 60L) } ?: 0L)
            "repeat_tap" -> base + (a.count ?: 5) * ((a.intervalMs ?: 100L) + 60L)
            "swipe_path" -> base + (a.duration ?: 500L)
            "long_press" -> base + (a.duration ?: 800L)
            "drag" -> base + (a.duration ?: 600L) + (a.holdMs ?: 500L)
            "watch_color", "wait_pixel" -> base + (a.timeoutMs ?: 5000L)
            "read_text" -> 25_000L
            "auto_react" -> base + (a.timeoutMs ?: 10_000L)
            "track_object" -> base + (a.samples ?: 5) * (a.intervalMs ?: 120L)
            "joystick" -> base + (a.duration ?: 500L)
            "fire_burst" -> base + (a.holdMs ?: 0L) + (a.count ?: 5) * (a.intervalMs ?: 90L)
            "combo" -> base + (a.steps2?.sumOf { (it.delayMs ?: 0L) + (it.duration ?: 0L) + (it.holdMs ?: 0L) + (it.count ?: 0) * (it.intervalMs ?: 90L) } ?: 0L)
            // v4.1 on-device engines
            "react_script" -> base + (a.timeoutMs ?: 15_000L)
            "play_frame" -> base + ((a.frame?.ocr?.size ?: 0) * 1500L)
            else -> base
        }
    }

    private fun buildHello(): HelloMessage {
        val dm = resources.displayMetrics
        return HelloMessage(
            model = "${Build.MANUFACTURER} ${Build.MODEL}",
            android = Build.VERSION.RELEASE,
            appVersion = runCatching { packageManager.getPackageInfo(packageName, 0).versionName ?: "?" }.getOrDefault("?"),
            screen = ScreenSize(dm.widthPixels, dm.heightPixels),
            accessibilityEnabled = AutomationAccessibilityService.isEnabled,
            battery = batteryPercent(),
            charging = getSystemService(android.os.BatteryManager::class.java)?.isCharging == true,
        )
    }

    private fun batteryPercent(): Int? {
        val bm = getSystemService(android.os.BatteryManager::class.java) ?: return null
        val p = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (p in 0..100) p else null
    }

    // ------------------------------------------------------------ misc
    private fun setState(s: ConnState, msg: String) {
        _ui.update { it.copy(state = s, message = msg, logs = (listOf(LogLine(System.currentTimeMillis(), msg, s != ConnState.ERROR)) + it.logs).take(50)) }
    }

    private fun stopSelfClean() {
        stopping = true
        socket?.close(1000, "user stop")
        connectJob?.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RelayConnectionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        lastStatusText = text
        val b = NotificationCompat.Builder(this, RelayApp.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
        b.addAction(0, "قطع الاتصال", stop)
        return b.build()
    }

    private fun startAsForeground(text: String) {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun updateNotification(text: String) {
        getSystemService(android.app.NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
    }

    companion object {
        private const val TAG = "RelayConnection"
        private const val NOTIF_ID = 1001
        const val ACTION_STOP = "com.devicerelay.client.STOP"

        private val _ui = MutableStateFlow(RelayUiState())
        val ui: StateFlow<RelayUiState> = _ui.asStateFlow()

        fun start(ctx: Context) {
            val i = Intent(ctx, RelayConnectionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, RelayConnectionService::class.java).setAction(ACTION_STOP))
        }
    }
}
