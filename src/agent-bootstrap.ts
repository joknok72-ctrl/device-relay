import type { DeviceInfo } from './types'
import { TOOLS } from './tools'

/**
 * Self-describing bootstrap document for AI agents.
 * A human only has to paste ONE url into a new chat:  <origin>/agent/<token>
 * The agent fetches it and gets everything: credentials, commands, tools, rules, live device status.
 */
export function agentBootstrap(origin: string, token: string, devices: DeviceInfo[]): string {
  const online = devices.filter((d) => d.online)
  const target = online[0] ?? devices[0]
  const deviceLine = devices.length === 0
    ? 'NO PHONE REGISTERED YET. Tell the user: open the Device Relay app on the phone and press Connect, then retry.'
    : devices.map((d) => `  ${d.online ? '● ONLINE ' : '○ offline'}  id=${d.deviceId}  ${d.model ?? ''}  screen=${d.screen ? `${d.screen.w}x${d.screen.h}` : '?'}  a11y=${d.accessibilityEnabled ?? '?'}`).join('\n')

  const toolLines = TOOLS.map((t) => {
    const params = Object.entries(t.parameters.properties).map(([k, v]) => `${k}${t.parameters.required.includes(k) ? '' : '?'}:${v.type}`).join(', ')
    return `  ${t.name}(${params})\n      ${t.description.split('. ')[0]}.`
  }).join('\n')

  return `# DEVICE RELAY — AI AGENT BOOTSTRAP
You (the AI) are the ONLY operator of a real Android phone. The human will not touch it.
Everything you need is below. Do not ask the human for URLs, tokens or ids.

## 1. Credentials (already filled in)
export RELAY_URL="${origin}"
export RELAY_TOKEN="${token}"
export RELAY_DEVICE="${target?.deviceId ?? ''}"

## 2. Live device status (at the time of this request)
${deviceLine}
Re-check any time:  curl -s -H "Authorization: Bearer $RELAY_TOKEN" $RELAY_URL/api/devices

## 3. Fastest way: the phone.sh helper (bash + curl + python3, no install)
curl -sS "$RELAY_URL/phone.sh" -o phone.sh && chmod +x phone.sh
./phone.sh devices                 # phones + online state
./phone.sh ui                      # visible UI elements: text, id, center (cx,cy) in ORIGINAL pixels  <-- observe with this first
./phone.sh ui "search"             # filter elements
./phone.sh shot screen.png         # PNG screenshot (downscaled; header X-Image-Scale). Open it with your image viewer tool.
./phone.sh open "Chrome"           # launch app by name or package
./phone.sh tapel "Sign in"         # tap element by text / content-description
./phone.sh tapid btn_login         # tap element by view id
./phone.sh type "hello" submit     # type into focused field (+ Enter). Focus a field first with tapel.
./phone.sh waitfor "Inbox" 8000    # wait until an element with that text appears (ms timeout)
./phone.sh find "Privacy"          # scroll down until text appears, then tap it
./phone.sh tap 540 990 | dtap X Y | long X Y [ms] | swipe X1 Y1 X2 Y2 [ms] | scroll down|up|left|right
./phone.sh back | home | recents | notif | qs | lock | wake | wait 1000 | app | apps | url https://...
./phone.sh call <tool> '<json args>'   # any tool below

## 4. Raw HTTP (if you prefer curl / another language)
Auth header on every call:  Authorization: Bearer $RELAY_TOKEN
POST $RELAY_URL/api/devices/$RELAY_DEVICE/tools/call   body {"name":"<tool>","arguments":{...}}
POST $RELAY_URL/api/devices/$RELAY_DEVICE/tools/<tool>  body {...args}
GET  $RELAY_URL/api/devices/$RELAY_DEVICE/screenshot.png
GET  $RELAY_URL/api/tools/schema?format=openai|anthropic|gemini|openapi
MCP (Streamable HTTP, token in URL, no header needed):  ${origin}/mcp/${token}

## 5. Tools
${toolLines}

## 6. Operating rules
1. Observe before acting: "ui" first (exact, cheap). Use "shot" when visuals matter (games, images, WebView) or when ui is empty.
2. After every action that changes the screen, observe again and verify before the next step.
3. Coordinates are ORIGINAL screen pixels (screen.w x screen.h). Elements from "ui" are already original. Screenshot px / scale = original.
4. Prefer open_app, tapel/tapid, type over raw coordinates. Use waitfor after actions that load content.
5. Handle popups / permission dialogs / keyboards sensibly, then continue toward the goal.
6. If the phone is offline or a11y=false, tell the human exactly what to enable on the phone; do not loop.
7. Never invent screen content; never claim success without an observed confirmation. Report steps + final result briefly.
`
}
