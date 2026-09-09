package com.devicerelay.client

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class RelayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        com.devicerelay.client.shizuku.ShizukuBridge.init(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply { setShowBadge(false) }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    companion object {
        const val CHANNEL_ID = "relay_connection"
    }
}
