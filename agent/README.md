# agent_runner.py — Autonomous AI Agent for Device Relay

Lets any LLM drive a real Android phone through tool calling:

```
capture_screen  →  vision model reasons  →  tap / swipe / ...  →  capture_screen (verify)  →  ...
```

## Install
```bash
pip install -r requirements.txt          # only `requests`
cp .env.example .env && edit .env        # or export the variables
export $(grep -v '^#' .env | xargs)
```

## Commands
| Command | What it does |
|---|---|
| `python agent_runner.py devices` | list phones + online status |
| `python agent_runner.py shot --out screen.png` | save current screen |
| `python agent_runner.py call tap '{"x":540,"y":990}'` | call any tool once |
| `python agent_runner.py goal "Open Settings and enable Dark mode" --max-steps 20` | **AI mode**: the model looks, thinks, acts in a loop until `DONE:` / `FAILED:` |
| `python agent_runner.py scenario scenarios/game_smoke.json --loops 50` | deterministic regression loop (game/UI smoke tests), saves screenshots per loop |
| `python agent_runner.py shell` | interactive REPL (`tap 540 900`, `shot`, `ai: <goal>`) |
| `python agent_runner.py schema` | print the OpenAI `tools` JSON |

Exit code is `0` on DONE / no failures, `1` otherwise — so it plugs into CI.

## Model support
Any **OpenAI-compatible** endpoint with vision + function calling: OpenAI (`gpt-5`, `gpt-4o`, `gpt-4.1`), Azure OpenAI, OpenRouter, Together, Ollama (`llama3.2-vision`, `qwen2.5-vl`), vLLM, LM Studio...
Set `OPENAI_BASE_URL` + `OPENAI_MODEL`.

For **Claude** or **Gemini**, use the MCP server instead (see root README) or fetch `?format=anthropic` / `?format=gemini` and build your own loop with `Relay.call()` — the client class is ~60 lines.

## Scenario format
```json
{
  "name": "login flow",
  "steps": [
    { "tool": "press_home" },
    { "tool": "wait", "arguments": { "ms": 800 } },
    { "tool": "tap", "arguments": { "x": 540, "y": 990 } },
    { "tool": "capture_screen", "save": "after_tap.png" },
    { "tool": "swipe", "arguments": { "x1":540,"y1":1800,"x2":540,"y2":600,"duration":250 }, "repeat": 5, "every_ms": 400 }
  ]
}
```
Coordinates are **original screen pixels** (see `screen.w/h` from `devices`).

## Use as a library
```python
from agent_runner import Relay
r = Relay("https://device-relay.xxx.workers.dev", "TOKEN")
shot = r.capture()                      # {'ok':1,'screen':{'w':1080,'h':2400},'image':{'base64':...,'scale':0.5}}
r.call("tap", {"x": 540, "y": 990})
r.call("swipe", {"x1":540,"y1":1800,"x2":540,"y2":600})
```
