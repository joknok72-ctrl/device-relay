package com.devicerelay.client.net

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** JSON wire protocol shared with the Cloudflare Worker (see src/types.ts). */
@OptIn(ExperimentalSerializationApi::class)
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
    // extended actions
    val text: String? = null,        // type_text, tap_element (text/desc match), open_app (package or label)
    val elementId: String? = null,   // tap_element by view id
    val url: String? = null,         // open_url
    val clear: Boolean? = null,      // type_text: clear field first
    val submit: Boolean? = null,     // type_text: press IME action after typing
    val index: Int? = null,          // tap_element: nth match
    // v1.4
    val maxWidth: Int? = null,       // screenshot: max output width (default 540)
    val quality: Int? = null,        // screenshot: compression quality (default 80)
    val format: String? = null,      // screenshot: png | jpeg
    val scale: Float? = null,        // pinch: zoom factor
    val holdMs: Long? = null,        // drag: hold before moving
    val paste: Boolean? = null,      // set_clipboard: paste after copy
    val limit: Int? = null,          // get_notifications
    val direction: String? = null,   // scroll_element: forward | backward
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
    val screenshotMime: String? = null,
    val durationMs: Long? = null,
    /** Arbitrary structured payload (ui elements, app list, ...) */
    val data: JsonElement? = null,
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
    val battery: Int? = null,
    val charging: Boolean? = null,
)

@Serializable
data class PongMessage(@SerialName("kind") val kind: String = "pong")

/** Peek at the "kind" of an incoming message without full decode. */
fun peekKind(raw: String): String? = runCatching {
    RelayJson.parseToJsonElement(raw).jsonObject["kind"]?.jsonPrimitive?.content
}.getOrNull()
