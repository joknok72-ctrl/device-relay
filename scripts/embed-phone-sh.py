#!/usr/bin/env python3
"""Embed agent/phone.sh into src/phone-sh.ts so the Worker can serve it at /phone.sh"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "agent" / "phone.sh").read_text()
(root / "src" / "phone-sh.ts").write_text("// AUTO-GENERATED from agent/phone.sh by scripts/embed-phone-sh.py — do not edit by hand\nexport const PHONE_SH = " + json.dumps(src) + "\n")
print("embedded", len(src), "bytes")
