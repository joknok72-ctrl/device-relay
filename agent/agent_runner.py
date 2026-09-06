#!/usr/bin/env python3
"""
agent_runner.py — Autonomous AI agent that controls a real Android phone through the
Device Relay Cloudflare Worker.

Loop:  capture_screen → vision LLM decides → tool calls (tap/swipe/...) → execute on phone → repeat

Modes
-----
  goal      : free-form natural-language goal, AI drives until it says DONE (or max steps)
  scenario  : deterministic JSON script (tap/swipe/wait/assert) repeated N times — great for game smoke tests
  shell     : interactive REPL: type "tap 540 900", "shot", "swipe ...", or a goal prefixed by "ai: ..."

Only dependency: `pip install requests`  (optional: pillow for image overlays)

Environment / flags
-------------------
  RELAY_URL      https://device-relay.xxx.workers.dev
  RELAY_TOKEN    bearer token configured on the Worker
  RELAY_DEVICE   device id (defaults to first online device)
  OPENAI_API_KEY / OPENAI_BASE_URL   any OpenAI-compatible vision model endpoint
  OPENAI_MODEL   default gpt-5 (use gpt-4o, gpt-4.1, qwen-vl, llava... anything with vision + tools)

Examples
--------
  python agent_runner.py devices
  python agent_runner.py shot --out screen.png
  python agent_runner.py goal "Open Settings and turn on Dark mode" --max-steps 15
  python agent_runner.py scenario scenarios/game_smoke.json --loops 10
  python agent_runner.py shell
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests

# ----------------------------------------------------------------------------- utils
C = {"g": "\033[92m", "r": "\033[91m", "y": "\033[93m", "b": "\033[94m", "d": "\033[90m", "x": "\033[0m"}


def log(msg: str, color: str = "x") -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"{C['d']}{ts}{C['x']} {C[color]}{msg}{C['x']}", flush=True)


# ----------------------------------------------------------------------------- relay client
@dataclass
class Relay:
    url: str
    token: str
    device: str | None = None
    timeout: int = 40
    session: requests.Session = field(default_factory=requests.Session)

    def __post_init__(self) -> None:
        self.url = self.url.rstrip("/")
        self.session.headers.update({"Authorization": f"Bearer {self.token}"})
        if not self.device:
            self.device = self.pick_device()

    # -- low level
    def _get(self, path: str, **kw: Any) -> requests.Response:
        r = self.session.get(f"{self.url}{path}", timeout=self.timeout, **kw)
        if r.status_code == 401:
            sys.exit("❌ unauthorized: check RELAY_TOKEN")
        return r

    def _post(self, path: str, body: Any = None) -> dict[str, Any]:
        r = self.session.post(f"{self.url}{path}", json=body if body is not None else {}, timeout=self.timeout)
        if r.status_code == 401:
            sys.exit("❌ unauthorized: check RELAY_TOKEN")
        try:
            return r.json()
        except ValueError:
            return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}

    # -- devices
    def devices(self) -> list[dict[str, Any]]:
        return self._get("/api/devices").json().get("devices", [])

    def pick_device(self) -> str | None:
        devs = self.devices()
        online = [d for d in devs if d.get("online")]
        chosen = (online or devs or [None])[0]
        return chosen["deviceId"] if chosen else None

    def status(self) -> dict[str, Any]:
        return self._get(f"/api/devices/{self.device}").json()

    # -- tools
    def tools_schema(self, fmt: str = "openai") -> Any:
        return self._get(f"/api/tools/schema?format={fmt}").json()

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """Execute any tool by name. Returns the normalized ToolResult."""
        return self._post(f"/api/devices/{self.device}/tools/call", {"name": name, "arguments": arguments or {}})

    def capture(self) -> dict[str, Any]:
        """Returns {ok, screen:{w,h}, image:{base64,w,h,scale}}"""
        return self.call("capture_screen")

    def save_screenshot(self, path: str) -> dict[str, Any]:
        res = self.capture()
        if res.get("ok") and res.get("image"):
            Path(path).write_bytes(base64.b64decode(res["image"]["base64"]))
        return res


# ----------------------------------------------------------------------------- AI agent (OpenAI-compatible)
SYSTEM_PROMPT = """You are an autonomous QA/automation agent operating a REAL Android phone through tools.

Perception (prefer in this order):
  - get_ui_elements: exact text, ids and center coordinates (cx,cy) of every visible element. Fast, precise, cheap. Use it FIRST.
  - capture_screen: a PNG when visuals matter (games, images, canvas/WebView apps, or when the UI tree is empty).
Action (prefer in this order):
  - open_app(name) to launch apps instead of hunting icons on the launcher.
  - tap_element(text=...) / tap_element(elementId=...) for buttons, links, list rows, tabs.
  - type_text(text, submit) after focusing an input (tap_element on the field or its hint).
  - tap(x,y) / swipe / scroll / double_tap / long_press only when there is no element to target (games, canvases).
  - press_back / press_home / open_notifications / wait.

Rules:
1. Observe before acting. After every action that changes the screen, re-observe (get_ui_elements or capture_screen).
2. Coordinates MUST be in ORIGINAL screen pixels (screen.w x screen.h). Screenshots are downscaled by `scale`:
   original = image_px / scale. Elements from get_ui_elements are already in original pixels.
3. If an action did nothing, re-observe before repeating; try another element/point or wait(800-1500) for loading.
4. Handle interruptions (permission dialogs, popups, cookie banners) sensibly, then continue toward the goal.
5. Be efficient: 1-3 tool calls per turn, then verify.
6. When the goal is fully achieved, reply with text starting "DONE:" + what you observed as evidence.
   If impossible or stuck after several attempts, reply starting "FAILED:" + why.
Never invent screen content. Never claim success without observed confirmation."""


class AIAgent:
    def __init__(self, relay: Relay, model: str, api_key: str, base_url: str | None, verbose: bool = True) -> None:
        self.relay = relay
        self.model = model
        self.verbose = verbose
        self.base = (base_url or "https://api.openai.com/v1").rstrip("/")
        self.http = requests.Session()
        self.http.headers.update({"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        self.tools = relay.tools_schema("openai")
        self.messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        self.shots_dir = Path("shots")
        self.shots_dir.mkdir(exist_ok=True)
        self.step = 0

    # -- LLM call
    def _chat(self) -> dict[str, Any]:
        payload = {"model": self.model, "messages": self.messages, "tools": self.tools, "tool_choice": "auto"}
        r = self.http.post(f"{self.base}/chat/completions", json=payload, timeout=180)
        if r.status_code != 200:
            raise RuntimeError(f"LLM HTTP {r.status_code}: {r.text[:400]}")
        return r.json()["choices"][0]["message"]

    # -- execute tool and format result for the model
    def _run_tool(self, call: dict[str, Any]) -> dict[str, Any]:
        name = call["function"]["name"]
        try:
            args = json.loads(call["function"].get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        t0 = time.time()
        res = self.relay.call(name, args)
        dt = int((time.time() - t0) * 1000)
        image = res.pop("image", None)
        status = "✔" if res.get("ok") else "✖"
        brief = {k: v for k, v in res.items() if k not in ("status", "data")}
        if isinstance(res.get("data"), dict) and "elements" in res["data"]:
            brief["elements"] = res["data"].get("count")
        elif "data" in res:
            brief["data"] = res["data"]
        log(f"  {status} {name}({json.dumps(args, ensure_ascii=False)}) → {json.dumps(brief, ensure_ascii=False)[:300]} [{dt}ms]", "g" if res.get("ok") else "r")

        # tool message (text) ...
        tool_msg = {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(res)}
        # ... plus the screenshot as a user image message (OpenAI tool results can't carry images)
        img_msg = None
        if image:
            self.step += 1
            p = self.shots_dir / f"step_{self.step:03d}.png"
            p.write_bytes(base64.b64decode(image["base64"]))
            img_msg = {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"[screenshot from capture_screen] image {image['w']}x{image['h']} px, scale={image['scale']}, real screen {res.get('screen', {}).get('w')}x{res.get('screen', {}).get('h')} px. Saved as {p}."},
                    {"type": "image_url", "image_url": {"url": f"data:{image['mime']};base64,{image['base64']}", "detail": "high"}},
                ],
            }
        return {"tool": tool_msg, "image": img_msg}

    # -- main loop
    def run(self, goal: str, max_steps: int = 20) -> str:
        log(f"🎯 GOAL: {goal}", "b")
        log(f"📱 device={self.relay.device} model={self.model}", "d")
        st = self.relay.status()
        if not st.get("online"):
            log("❌ device is offline — open the Device Relay app and press Connect", "r")
            return "FAILED: device offline"
        if st.get("accessibilityEnabled") is False:
            log("⚠ accessibility service is NOT enabled on the phone; taps will fail", "y")
        self.messages.append({"role": "user", "content": f"GOAL: {goal}\n\nStart by calling capture_screen."})

        for turn in range(1, max_steps + 1):
            msg = self._chat()
            self.messages.append(msg)
            text = (msg.get("content") or "").strip()
            calls = msg.get("tool_calls") or []

            if text and self.verbose:
                log(f"🧠 {text[:500]}", "y")
            if not calls:
                if text.upper().startswith("DONE"):
                    log("✅ goal achieved", "g")
                    return text
                if text.upper().startswith("FAILED"):
                    log("❌ agent gave up", "r")
                    return text
                # model talked without acting — nudge
                self.messages.append({"role": "user", "content": "Continue. Call a tool (capture_screen if unsure) or reply DONE:/FAILED:."})
                continue

            pending_images: list[dict[str, Any]] = []
            for call in calls:
                out = self._run_tool(call)
                self.messages.append(out["tool"])
                if out["image"]:
                    pending_images.append(out["image"])
            # all tool messages must directly follow the assistant message; images after
            self.messages.extend(pending_images)
            self._trim_history()

        log(f"⏹ max steps ({max_steps}) reached", "y")
        return "MAX_STEPS"

    def _trim_history(self, keep_images: int = 3) -> None:
        """Keep only the last N screenshots in context to save tokens; replace older with text."""
        seen = 0
        for m in reversed(self.messages):
            if m.get("role") == "user" and isinstance(m.get("content"), list):
                seen += 1
                if seen > keep_images:
                    m["content"] = [c for c in m["content"] if c.get("type") == "text"] + [{"type": "text", "text": "(older screenshot removed)"}]


# ----------------------------------------------------------------------------- scenario runner (deterministic)
def run_scenario(relay: Relay, path: str, loops: int = 1, stop_on_fail: bool = True) -> int:
    """
    Scenario JSON:
    {
      "name": "game smoke",
      "steps": [
        {"tool": "press_home"},
        {"tool": "wait", "arguments": {"ms": 800}},
        {"tool": "tap", "arguments": {"x": 540, "y": 990}},
        {"tool": "capture_screen", "save": "after_play.png"},
        {"tool": "swipe", "arguments": {"x1":540,"y1":1800,"x2":540,"y2":600,"duration":250}, "repeat": 5, "every_ms": 400}
      ]
    }
    """
    sc = json.loads(Path(path).read_text())
    steps = sc.get("steps", [])
    failures = 0
    log(f"▶ scenario '{sc.get('name', path)}' × {loops} loops, {len(steps)} steps, device={relay.device}", "b")
    out_dir = Path("scenario_out")
    out_dir.mkdir(exist_ok=True)

    for loop in range(1, loops + 1):
        log(f"— loop {loop}/{loops}", "d")
        t_loop = time.time()
        for i, st in enumerate(steps, 1):
            tool = st["tool"]
            args = st.get("arguments", {})
            for rep in range(int(st.get("repeat", 1))):
                t0 = time.time()
                res = relay.call(tool, args)
                dt = int((time.time() - t0) * 1000)
                ok = res.get("ok", False)
                if not ok:
                    failures += 1
                log(f"  [{i:02d}] {'✔' if ok else '✖'} {tool} {json.dumps(args) if args else ''} {res.get('error', '')} [{dt}ms]", "g" if ok else "r")
                if tool == "capture_screen" and res.get("image") and st.get("save"):
                    p = out_dir / f"loop{loop:03d}_{st['save']}"
                    p.write_bytes(base64.b64decode(res["image"]["base64"]))
                if not ok and stop_on_fail:
                    log("stopping (stop_on_fail)", "r")
                    return failures
                if st.get("every_ms") and rep < int(st.get("repeat", 1)) - 1:
                    time.sleep(st["every_ms"] / 1000)
        log(f"  loop done in {time.time() - t_loop:.1f}s", "d")
    log(f"■ finished: {failures} failures", "g" if failures == 0 else "r")
    return failures


# ----------------------------------------------------------------------------- interactive shell
def shell(relay: Relay, agent_factory) -> None:
    print("Device Relay shell. Commands:\n"
          "  shot | ui | ui <filter> | tap X Y | dtap X Y | tapel <text> | tapid <id> | type <text> | type! <text> (submit)\n"
          "  swipe X1 Y1 X2 Y2 [ms] | scroll down|up|left|right | long X Y [ms] | open <app> | url <url> | apps | app\n"
          "  back | home | recents | notif | qs | lock | wake | wait MS | status | devices | use ID | ai: <goal> | quit")
    while True:
        try:
            line = input(f"{C['b']}{relay.device}>{C['x']} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        if line in ("q", "quit", "exit"):
            return
        if line.startswith("ai:"):
            agent_factory().run(line[3:].strip())
            continue
        parts = line.split()
        cmd, a = parts[0], parts[1:]
        try:
            if cmd == "shot":
                res = relay.save_screenshot("screen.png")
                print(json.dumps({k: v for k, v in res.items() if k != "image"}), "→ screen.png")
            elif cmd == "ui":
                res = relay.call("get_ui_elements")
                d = res.get("data") or {}
                flt = " ".join(a).lower()
                print(f"app: {d.get('label')} ({d.get('package')})  elements: {d.get('count')}")
                for e in d.get("elements", []):
                    label = e.get("text") or e.get("desc") or e.get("hint") or ""
                    if flt and flt not in json.dumps(e, ensure_ascii=False).lower():
                        continue
                    flags = "".join(f for f, k in (("C", "clickable"), ("E", "editable"), ("S", "scrollable")) if e.get(k))
                    print(f"  [{e['i']:3}] ({e['cx']:4},{e['cy']:4}) {flags:3} {e.get('cls',''):14} {e.get('id','') :24} {label[:50]!r}")
            elif cmd == "dtap":
                print(relay.call("double_tap", {"x": int(a[0]), "y": int(a[1])}))
            elif cmd == "tapel":
                print(relay.call("tap_element", {"text": " ".join(a)}))
            elif cmd == "tapid":
                print(relay.call("tap_element", {"elementId": a[0]}))
            elif cmd in ("type", "type!"):
                print(relay.call("type_text", {"text": line.split(" ", 1)[1] if " " in line else "", "submit": cmd == "type!"}))
            elif cmd == "scroll":
                print(relay.call("scroll", {"direction": a[0] if a else "down"}))
            elif cmd == "open":
                print(relay.call("open_app", {"text": " ".join(a)}))
            elif cmd == "url":
                print(relay.call("open_url", {"url": a[0]}))
            elif cmd == "apps":
                for x in (relay.call("list_apps").get("data") or []):
                    print(f"  {x['label']:30} {x['package']}")
            elif cmd == "app":
                print(relay.call("get_current_app"))
            elif cmd in ("qs", "wake"):
                print(relay.call({"qs": "open_quick_settings", "wake": "wake_screen"}[cmd]))
            elif cmd == "tap":
                print(relay.call("tap", {"x": int(a[0]), "y": int(a[1])}))
            elif cmd == "long":
                print(relay.call("long_press", {"x": int(a[0]), "y": int(a[1]), "duration": int(a[2]) if len(a) > 2 else 800}))
            elif cmd == "swipe":
                print(relay.call("swipe", {"x1": int(a[0]), "y1": int(a[1]), "x2": int(a[2]), "y2": int(a[3]), "duration": int(a[4]) if len(a) > 4 else 300}))
            elif cmd in ("back", "home", "recents", "notif", "lock"):
                name = {"back": "press_back", "home": "press_home", "recents": "open_recents", "notif": "open_notifications", "lock": "lock_screen"}[cmd]
                print(relay.call(name))
            elif cmd == "wait":
                print(relay.call("wait", {"ms": int(a[0])}))
            elif cmd == "status":
                print(json.dumps(relay.status(), indent=1))
            elif cmd == "devices":
                for d in relay.devices():
                    print(f"  {'●' if d['online'] else '○'} {d['deviceId']}  {d.get('model', '')}  {d.get('screen', '')}")
            elif cmd == "use":
                relay.device = a[0]
            else:
                print("unknown command")
        except (IndexError, ValueError) as e:
            print("bad arguments:", e)


# ----------------------------------------------------------------------------- CLI
def main() -> None:
    ap = argparse.ArgumentParser(description="Autonomous AI agent for Device Relay")
    ap.add_argument("--url", default=os.getenv("RELAY_URL", ""), help="Worker URL")
    ap.add_argument("--token", default=os.getenv("RELAY_TOKEN", ""), help="Relay bearer token")
    ap.add_argument("--device", default=os.getenv("RELAY_DEVICE"), help="device id (default: first online)")
    ap.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-5"), help="vision+tools model")
    ap.add_argument("--api-key", default=os.getenv("OPENAI_API_KEY", ""), help="LLM API key")
    ap.add_argument("--base-url", default=os.getenv("OPENAI_BASE_URL"), help="LLM base URL (OpenAI-compatible)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices", help="list phones")
    p = sub.add_parser("shot", help="save a screenshot"); p.add_argument("--out", default="screen.png")
    sub.add_parser("ui", help="dump visible UI elements (text, id, coordinates)")
    p = sub.add_parser("call", help="call one tool"); p.add_argument("name"); p.add_argument("json_args", nargs="?", default="{}")
    p = sub.add_parser("goal", help="AI drives the phone toward a goal"); p.add_argument("text"); p.add_argument("--max-steps", type=int, default=20)
    p = sub.add_parser("scenario", help="run deterministic JSON scenario"); p.add_argument("file"); p.add_argument("--loops", type=int, default=1); p.add_argument("--continue-on-fail", action="store_true")
    sub.add_parser("shell", help="interactive REPL")
    sub.add_parser("schema", help="print OpenAI tools schema")

    args = ap.parse_args()
    if not args.url or not args.token:
        sys.exit("set RELAY_URL and RELAY_TOKEN (env or --url/--token)")

    relay = Relay(args.url, args.token, args.device)
    if args.cmd not in ("devices", "schema") and not relay.device:
        sys.exit("❌ no phone registered. Open the Device Relay app and press Connect.")

    def make_agent() -> AIAgent:
        if not args.api_key:
            sys.exit("set OPENAI_API_KEY (or --api-key) to use AI mode")
        return AIAgent(relay, args.model, args.api_key, args.base_url)

    if args.cmd == "devices":
        for d in relay.devices():
            print(f"{'●' if d['online'] else '○'} {d['deviceId']:24} {d.get('model', ''):28} {str(d.get('screen', '')):22} a11y={d.get('accessibilityEnabled')}")
    elif args.cmd == "schema":
        print(json.dumps(relay.tools_schema("openai"), indent=2))
    elif args.cmd == "shot":
        res = relay.save_screenshot(args.out)
        print(json.dumps({k: v for k, v in res.items() if k != "image"}), "→", args.out if res.get("ok") else "")
    elif args.cmd == "ui":
        print(json.dumps(relay.call("get_ui_elements").get("data"), indent=1, ensure_ascii=False))
    elif args.cmd == "call":
        print(json.dumps({k: (v if k != "image" else "<image>") for k, v in relay.call(args.name, json.loads(args.json_args)).items()}))
    elif args.cmd == "goal":
        result = make_agent().run(args.text, args.max_steps)
        print("\nRESULT:", result)
        sys.exit(0 if result.upper().startswith("DONE") else 1)
    elif args.cmd == "scenario":
        sys.exit(1 if run_scenario(relay, args.file, args.loops, not args.continue_on_fail) else 0)
    elif args.cmd == "shell":
        shell(relay, make_agent)


if __name__ == "__main__":
    main()
