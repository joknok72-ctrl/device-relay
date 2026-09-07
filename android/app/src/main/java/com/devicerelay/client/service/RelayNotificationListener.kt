package com.devicerelay.client.service

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Optional NotificationListenerService: lets the AI read status-bar notifications
 * (OTP codes, chat messages) without opening the shade. User enables it from the app.
 */
class RelayNotificationListener : NotificationListenerService() {

    override fun onListenerConnected() { instance = this }
    override fun onListenerDisconnected() { if (instance === this) instance = null }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }

    fun dump(limit: Int): JsonElement {
        val pm = packageManager
        val list = runCatching { activeNotifications?.toList() ?: emptyList() }.getOrDefault(emptyList<StatusBarNotification>())
            .filter { !it.isOngoing || it.notification.extras.getCharSequence(Notification.EXTRA_TEXT) != null }
            .sortedByDescending { it.postTime }
            .take(limit)
        return buildJsonObject {
            put("count", list.size)
            put("notifications", buildJsonArray {
                for (sbn in list) {
                    val ex = sbn.notification.extras
                    add(buildJsonObject {
                        put("package", sbn.packageName)
                        runCatching { pm.getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrNull()?.let { put("app", it) }
                        ex.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.let { put("title", it.take(200)) }
                        (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.let { put("text", it.take(1000)) }
                        ex.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.let { put("subText", it.take(200)) }
                        put("time", sbn.postTime)
                        put("ongoing", sbn.isOngoing)
                        put("key", sbn.key)
                    })
                }
            })
        }
    }

    companion object {
        @Volatile var instance: RelayNotificationListener? = null
            private set
        val isEnabled get() = instance != null
    }
}
