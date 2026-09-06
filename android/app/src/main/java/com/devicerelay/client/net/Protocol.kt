package com.devicerelay.client.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** JSON wire protocol shared with the Cloudflare Worker (see src/types.ts). */
val RelayJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

@Serializable
data class Action(
    val type: String,
    val x: Float? = null,
    val y: Float? = null,
    val x1: Float? = null,
    val y1: Float? = null,
    val x2: Float? = null,
    val y2: Float? = null,
    val duration: Long? = null,
)

@Serializable
data class CommandMessage(
    val kind: String,
    val id: String,
    val ts: Long,
    val action: Action,
)

@Serializable
data class ResultMessage(
    val kind: String = "result",
    val id: String,
    val ok: Boolean,
    val error: String? = null,
    val screenshot: String? = null,
    val durationMs: Long? = null,
)

@Serializable
data class ScreenSize(val w: Int, val h: Int)

@Serializable
data class HelloMessage(
    val kind: String = "hello",
    val model: String,
    val android: String,
    val appVersion: String,
    val screen: ScreenSize,
    val accessibilityEnabled: Boolean,
)

@Serializable
data class PongMessage(@SerialName("kind") val kind: String = "pong")

/** Peek at the "kind" of an incoming message without full decode. */
fun peekKind(raw: String): String? = runCatching {
    RelayJson.parseToJsonElement(raw).jsonObject["kind"]?.jsonPrimitive?.content
}.getOrNull()
