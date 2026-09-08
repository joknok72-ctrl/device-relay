package com.devicerelay.client.net

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
    // v1.5 games / precision
    val points: List<SeqPoint>? = null,  // tap_sequence / multi_tap / swipe_path / pixel
    val count: Int? = null,              // repeat_tap
    val intervalMs: Long? = null,        // repeat_tap
    val grid: Int? = null,               // screenshot: grid spacing in px (0 = none)
    val region: Region? = null,          // screenshot / find_color: crop
    val color: String? = null,           // find_color: #rrggbb
    val tolerance: Int? = null,          // find_color
    // v1.6 reflexes
    val appear: Boolean? = null,         // watch_color / wait_pixel
    val timeoutMs: Long? = null,         // watch_color / wait_pixel
    val minCount: Int? = null,           // watch_color
    val threshold: Float? = null,        // screen_diff (int-ish) / find_image (0..1)
    val cell: Int? = null,               // screen_diff
    val image: String? = null,           // find_image: base64 template
    val maxResults: Int? = null,         // find_image
    // v1.7
    val lang: String? = null,            // read_text: latin|ar|zh|ja|ko|hi
    val colors: List<String>? = null,    // find_colors
    val enabled: Boolean? = null,        // stream
    val fps: Float? = null,              // stream
    // v1.9
    val minSize: Int? = null,            // find_objects: ignore blobs smaller than this (px)
    val tapOffsetX: Int? = null,         // auto_react
    val tapOffsetY: Int? = null,         // auto_react
    val tapX: Int? = null,               // auto_react: fixed tap point
    val tapY: Int? = null,               // auto_react
    val maxTriggers: Int? = null,        // auto_react
    val cooldownMs: Long? = null,        // auto_react
    // v2.0
    val lanes: List<ReactLane>? = null,  // auto_react: extra triggers
    val stopColor: String? = null,       // auto_react: stop when present
    val stopRegion: Region? = null,
    val stopMinCount: Int? = null,
    // v2.1
    val maxColors: Int? = null,          // sample_colors
    val quant: Int? = null,              // sample_colors
    val ignoreGrey: Boolean? = null,     // sample_colors
    val samples: Int? = null,            // track_object
    val predictMs: Long? = null,         // track_object
    // v2.5 multi-touch
    val finger: Int? = null,             // finger slot 0-3 (-1 = all for finger_up)
    val angle: Double? = null,           // joystick: degrees (0=right, 90=down, 270=up)
    val distance: Float? = null,         // joystick: push distance px
    val release: Boolean? = null,        // joystick/aim: lift finger at the end (default true)
    val dx: Float? = null,               // aim
    val dy: Float? = null,               // aim
    val steps: Int? = null,              // aim: intermediate points
    @SerialName("combo") val steps2: List<ComboStep>? = null, // combo steps
    // v2.6 bots
    val bots: JsonArray? = null,         // bot_sync: raw bot definitions (interpreted by BotEngine)
    val botId: String? = null,           // bot_start
)

@Serializable
data class BotStatusMessage(
    val kind: String = "bot_status",
    val botId: String? = null, val name: String? = null, val running: Boolean,
    val ticks: Int? = null, val fired: Int? = null, val lastRule: String? = null,
    val startedAt: Long? = null, val stoppedBy: String? = null, val error: String? = null,
    val ruleHits: Map<String, Int>? = null, val avgTickMs: Int? = null,
    val ts: Long,
)

@Serializable
data class ComboStep(
    val op: String,
    val finger: Int? = null,
    val x: Float? = null, val y: Float? = null,
    val dx: Float? = null, val dy: Float? = null,
    val angle: Double? = null, val distance: Float? = null,
    val duration: Long? = null, val delayMs: Long? = null,
    val count: Int? = null, val intervalMs: Long? = null, val holdMs: Long? = null,
    val release: Boolean? = null,
)

@Serializable
data class ReactSwipe(val dx: Int, val dy: Int, val durationMs: Long? = null)

@Serializable
data class ReactLane(
    val color: String,
    val tolerance: Int? = null,
    val region: Region? = null,
    val minCount: Int? = null,
    val tapX: Int? = null,
    val tapY: Int? = null,
    val tapOffsetX: Int? = null,
    val tapOffsetY: Int? = null,
    val swipe: ReactSwipe? = null,
    val cooldownMs: Long? = null,
    val name: String? = null,
)

@Serializable
data class FrameMessage(val kind: String = "frame", val data: String, val mime: String, val ts: Long)

@Serializable
data class SeqPoint(val x: Float, val y: Float, val delayMs: Long? = null, val durationMs: Long? = null)

@Serializable
data class Region(val x: Int, val y: Int, val w: Int, val h: Int)

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
