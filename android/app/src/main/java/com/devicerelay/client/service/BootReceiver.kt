package com.devicerelay.client.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.devicerelay.client.SettingsRepo
import kotlinx.coroutines.runBlocking

/** Re-connects after reboot when the user enabled auto-connect. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val cfg = runBlocking { SettingsRepo.get(context) }
        if (cfg.autoConnect && cfg.isComplete) RelayConnectionService.start(context)
    }
}
