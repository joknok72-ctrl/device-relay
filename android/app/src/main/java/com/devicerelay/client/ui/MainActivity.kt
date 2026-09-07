package com.devicerelay.client.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Accessibility
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.devicerelay.client.RelayConfig
import com.devicerelay.client.SettingsRepo
import com.devicerelay.client.service.AutomationAccessibilityService
import com.devicerelay.client.service.RelayNotificationListener
import androidx.compose.material.icons.filled.Notifications
import com.devicerelay.client.service.ConnState
import com.devicerelay.client.service.RelayConnectionService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

private val Bg = Color(0xFF0F172A)
private val CardBg = Color(0xFF1E293B)
private val Green = Color(0xFF34D399)
private val Red = Color(0xFFF87171)
private val Amber = Color(0xFFFBBF24)
private val Muted = Color(0xFF94A3B8)

class MainActivity : ComponentActivity() {
    /** Pairing payload from devicerelay://pair?server=&token=&device= (or https .../pair?...) */
    private val pairing = androidx.compose.runtime.mutableStateOf<RelayConfig?>(null)

    private fun handlePairIntent(intent: Intent?) {
        val u = intent?.data ?: return
        val isPair = (u.scheme == "devicerelay" && u.host == "pair") || u.path?.endsWith("/pair") == true
        if (!isPair) return
        val server = u.getQueryParameter("server") ?: return
        val token = u.getQueryParameter("token") ?: return
        val device = u.getQueryParameter("device") ?: ""
        pairing.value = RelayConfig(serverUrl = server, token = token, deviceId = device, autoConnect = true)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handlePairIntent(intent) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handlePairIntent(intent)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Green, background = Bg, surface = CardBg, onPrimary = Bg,
                ),
            ) {
                Surface(Modifier.fillMaxSize(), color = Bg) { RelayScreen(pairing.value) { pairing.value = null } }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RelayScreen(pairing: RelayConfig? = null, onPairingConsumed: () -> Unit = {}) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val ui by RelayConnectionService.ui.collectAsStateWithLifecycle()

    var cfg by remember { mutableStateOf(RelayConfig()) }
    var loaded by remember { mutableStateOf(false) }
    var showToken by remember { mutableStateOf(false) }
    var a11yEnabled by remember { mutableStateOf(AutomationAccessibilityService.isEnabled) }
    var notifAccess by remember { mutableStateOf(RelayNotificationListener.isEnabled) }
    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    LaunchedEffect(Unit) {
        cfg = SettingsRepo.get(ctx); loaded = true
    }
    // Deep-link pairing: fill settings, save, and connect immediately
    LaunchedEffect(pairing) {
        val p = pairing ?: return@LaunchedEffect
        val current = SettingsRepo.get(ctx)
        cfg = p.copy(deviceId = p.deviceId.ifBlank { current.deviceId })
        SettingsRepo.save(ctx, cfg)
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        RelayConnectionService.start(ctx)
        onPairingConsumed()
    }
    // Refresh accessibility status whenever the app returns to foreground
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            a11yEnabled = AutomationAccessibilityService.isEnabled
            notifAccess = RelayNotificationListener.isEnabled
        }
    }

    fun connect() {
        scope.launch {
            SettingsRepo.save(ctx, cfg)
            if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            RelayConnectionService.start(ctx)
        }
    }

    Scaffold(
        containerColor = Bg,
        topBar = {
            TopAppBar(
                title = { Text("Device Relay", fontWeight = FontWeight.Bold) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg, titleContentColor = Color.White),
            )
        },
    ) { pad ->
        LazyColumn(
            Modifier.fillMaxSize().padding(pad).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // ---- Status card
            item {
                Card(colors = CardDefaults.cardColors(containerColor = CardBg)) {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val (color, label) = when (ui.state) {
                                ConnState.CONNECTED -> Green to "متصل"
                                ConnState.CONNECTING -> Amber to "جارٍ الاتصال"
                                ConnState.ERROR -> Red to "خطأ"
                                ConnState.DISCONNECTED -> Muted to "غير متصل"
                            }
                            Spacer(Modifier.size(12.dp).background(color, CircleShape))
                            Spacer(Modifier.width(10.dp))
                            Text(label, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
                            Spacer(Modifier.weight(1f))
                            Icon(if (ui.state == ConnState.CONNECTED) Icons.Default.Cloud else Icons.Default.CloudOff, null, tint = color)
                        }
                        if (ui.message.isNotBlank()) Text(ui.message, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
                        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Stat("الأوامر", ui.commandsHandled.toString())
                            Stat("آخر زمن تنفيذ", ui.lastLatencyMs?.let { "${it}ms" } ?: "-")
                            Stat("Device ID", cfg.deviceId.ifBlank { "-" })
                        }
                    }
                }
            }

            // ---- Accessibility card
            item {
                Card(colors = CardDefaults.cardColors(containerColor = if (a11yEnabled) CardBg else Color(0xFF3B1D1D))) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Accessibility, null, tint = if (a11yEnabled) Green else Red)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("خدمة إمكانية الوصول", color = Color.White, fontWeight = FontWeight.SemiBold)
                            Text(
                                if (a11yEnabled) "مفعّلة — التطبيق قادر على تنفيذ اللمسات" else "غير مفعّلة — مطلوبة لتنفيذ Tap/Swipe",
                                color = Muted, fontSize = 12.sp,
                            )
                        }
                        if (!a11yEnabled) OutlinedButton(onClick = {
                            ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }) { Text("تفعيل") }
                    }
                }
            }

            // ---- Notification access card (optional)
            item {
                Card(colors = CardDefaults.cardColors(containerColor = CardBg)) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Notifications, null, tint = if (notifAccess) Green else Muted)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("قراءة الإشعارات (اختياري)", color = Color.White, fontWeight = FontWeight.SemiBold)
                            Text(
                                if (notifAccess) "مفعّلة — الـ AI يستطيع قراءة أكواد OTP والرسائل" else "غير مفعّلة — مطلوبة لأداة get_notifications فقط",
                                color = Muted, fontSize = 12.sp,
                            )
                        }
                        if (!notifAccess) OutlinedButton(onClick = {
                            ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }) { Text("تفعيل") }
                    }
                }
            }

            // ---- Settings card
            item {
                Card(colors = CardDefaults.cardColors(containerColor = CardBg)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("إعدادات السيرفر", color = Color.White, fontWeight = FontWeight.SemiBold)
                        OutlinedTextField(
                            value = cfg.serverUrl, onValueChange = { cfg = cfg.copy(serverUrl = it) },
                            label = { Text("رابط السيرفر") }, placeholder = { Text("https://device-relay.xxx.workers.dev") },
                            singleLine = true, modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        )
                        OutlinedTextField(
                            value = cfg.token, onValueChange = { cfg = cfg.copy(token = it) },
                            label = { Text("Bearer Token") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                            visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                            trailingIcon = {
                                IconButton(onClick = { showToken = !showToken }) {
                                    Icon(if (showToken) Icons.Default.VisibilityOff else Icons.Default.Visibility, null)
                                }
                            },
                        )
                        OutlinedTextField(
                            value = cfg.deviceId, onValueChange = { cfg = cfg.copy(deviceId = it) },
                            label = { Text("Device ID (حروف/أرقام/-/_)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(checked = cfg.autoConnect, onCheckedChange = { cfg = cfg.copy(autoConnect = it) })
                            Spacer(Modifier.width(8.dp))
                            Text("اتصال تلقائي بعد إعادة التشغيل", color = Muted, fontSize = 13.sp)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = { connect() },
                                enabled = loaded && cfg.isComplete && ui.state != ConnState.CONNECTED,
                                modifier = Modifier.weight(1f),
                                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Bg),
                            ) { Text("اتصال", fontWeight = FontWeight.Bold) }
                            OutlinedButton(
                                onClick = { RelayConnectionService.stop(ctx) },
                                enabled = ui.state != ConnState.DISCONNECTED,
                                modifier = Modifier.weight(1f),
                            ) { Text("قطع") }
                        }
                    }
                }
            }

            // ---- Logs
            item { Text("السجل", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp)) }
            if (ui.logs.isEmpty()) item { Text("لا يوجد نشاط بعد", color = Muted, fontSize = 13.sp) }
            items(ui.logs) { line ->
                val time = remember(line.ts) { SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(line.ts)) }
                Row {
                    Text(time, color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    Spacer(Modifier.width(8.dp))
                    Text(line.text, color = if (line.ok) Color(0xFFE2E8F0) else Red, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    Column {
        Text(label, color = Muted, fontSize = 11.sp)
        Text(value, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    }
}
