package com.devicerelay.client

import android.content.Context
import android.provider.Settings as SysSettings
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore("relay_settings")

data class RelayConfig(
    val serverUrl: String = "",
    val token: String = "",
    val deviceId: String = "",
    val autoConnect: Boolean = false,
) {
    val isComplete get() = serverUrl.isNotBlank() && token.isNotBlank() && deviceId.isNotBlank()

    /** Converts https://host -> wss://host/api/ws/phone/<deviceId> */
    fun wsUrl(): String {
        var base = serverUrl.trim().trimEnd('/')
        base = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            base.startsWith("ws") -> base
            else -> "wss://$base"
        }
        return "$base/api/ws/phone/$deviceId"
    }
}

object SettingsRepo {
    private val KEY_URL = stringPreferencesKey("server_url")
    private val KEY_TOKEN = stringPreferencesKey("token")
    private val KEY_DEVICE = stringPreferencesKey("device_id")
    private val KEY_AUTO = booleanPreferencesKey("auto_connect")

    fun flow(ctx: Context): Flow<RelayConfig> = ctx.dataStore.data.map { p ->
        RelayConfig(
            serverUrl = p[KEY_URL] ?: "",
            token = p[KEY_TOKEN] ?: "",
            deviceId = p[KEY_DEVICE] ?: defaultDeviceId(ctx),
            autoConnect = p[KEY_AUTO] ?: false,
        )
    }

    suspend fun get(ctx: Context): RelayConfig = flow(ctx).first()

    suspend fun save(ctx: Context, cfg: RelayConfig) {
        ctx.dataStore.edit { p ->
            p[KEY_URL] = cfg.serverUrl.trim()
            p[KEY_TOKEN] = cfg.token.trim()
            p[KEY_DEVICE] = cfg.deviceId.trim().replace(Regex("[^a-zA-Z0-9_-]"), "-").take(64)
            p[KEY_AUTO] = cfg.autoConnect
        }
    }

    private fun defaultDeviceId(ctx: Context): String {
        val androidId = SysSettings.Secure.getString(ctx.contentResolver, SysSettings.Secure.ANDROID_ID) ?: "device"
        val model = android.os.Build.MODEL.replace(Regex("[^a-zA-Z0-9]"), "").take(12).lowercase()
        return "$model-${androidId.take(6)}"
    }
}
