"""Mock OpenAI-compatible /chat/completions that behaves like a vision agent (for CI / offline tests)."""
import json, base64
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        msgs = body["messages"]
        tools = [t["function"]["name"] for t in body.get("tools", [])]
        n_images = sum(1 for m in msgs if m["role"] == "user" and isinstance(m.get("content"), list) and any(c.get("type") == "image_url" for c in m["content"]))
        n_taps = sum(1 for m in msgs if m["role"] == "assistant" for c in (m.get("tool_calls") or []) if c["function"]["name"] == "tap")
        assert "capture_screen" in tools and "tap" in tools, "tools schema missing"
        # verify image payload is a valid PNG data URL
        for m in msgs:
            if m["role"] == "user" and isinstance(m.get("content"), list):
                for c in m["content"]:
                    if c.get("type") == "image_url":
                        url = c["image_url"]["url"]; assert url.startswith("data:image/png;base64,")
                        assert base64.b64decode(url.split(",",1)[1])[:4] == b"\x89PNG"
        if n_images == 0:
            out = {"content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "capture_screen", "arguments": "{}"}}]}
        elif n_taps == 0:
            # PLAY button center in 540x1200 image = (270,495); scale 0.5 -> original (540,990)
            out = {"content": "I see SPACE RUNNER menu with PLAY/SETTINGS/SHOP. Tapping PLAY at original coords.", "tool_calls": [
                {"id": "c2", "type": "function", "function": {"name": "tap", "arguments": json.dumps({"x": 540, "y": 990})}},
                {"id": "c3", "type": "function", "function": {"name": "wait", "arguments": json.dumps({"ms": 300})}},
                {"id": "c4", "type": "function", "function": {"name": "capture_screen", "arguments": "{}"}}]}
        else:
            out = {"content": "DONE: Tapped PLAY. Buttons seen: PLAY, SETTINGS, SHOP; cookie banner [No]/[Yes]; high score 4210.", "tool_calls": None}
        resp = {"choices": [{"message": {"role": "assistant", **out}}]}
        data = json.dumps(resp).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8123), H).serve_forever()
