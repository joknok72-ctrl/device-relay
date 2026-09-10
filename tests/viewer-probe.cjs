// Probe: connect as a monitor viewer, enable live_preview, count frames for N seconds.
// Usage: node tests/viewer-probe.cjs <RELAY_URL> <TOKEN> <deviceId> [seconds]
const WebSocket = require("ws");
const [url, token, dev, secs = "8"] = process.argv.slice(2);
const wsUrl = url.replace(/^http/, "ws") + `/api/ws/viewer/${dev}?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(wsUrl, { headers: { "User-Agent": "dr-agent" } });
let frames = 0, bytes = 0, first = 0, last = 0;
ws.on("open", async () => {
  console.log("viewer OPEN");
  const r = await fetch(`${url}/api/devices/${dev}/tools/live_preview`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "dr-agent" }, body: JSON.stringify({ enabled: true, fps: 2, maxWidth: 360 }) });
  console.log("live_preview:", await r.text());
});
ws.on("message", m => { const j = JSON.parse(m); if (j.kind === "frame") { frames++; bytes += j.data.length; if (!first) first = Date.now(); last = Date.now(); if (frames <= 3) console.log("FRAME", j.data.length, "bytes"); } else console.log("MSG", j.kind); });
ws.on("error", e => console.log("ERR", e.message));
setTimeout(async () => {
  console.log(`frames=${frames} in ${secs}s  avg=${frames ? (bytes / frames | 0) : 0}B  fps≈${frames > 1 ? ((frames - 1) / ((last - first) / 1000)).toFixed(2) : 0}`);
  await fetch(`${url}/api/devices/${dev}/tools/live_preview`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "dr-agent" }, body: JSON.stringify({ enabled: false }) });
  ws.close(); process.exit(frames > 0 ? 0 : 1);
}, Number(secs) * 1000);
