# Device Relay — Cloud Device Automation & Accessibility Relay

نظام أتمتة سحابي متكامل للتحكم في هاتف أندرويد عن بُعد عبر Cloudflare، بأقل زمن تأخير.

```
[ curl / Dashboard / أي كود ]  ──HTTP + Bearer──►  Cloudflare Worker (Hono)
                                                        │  Durable Object (غرفة لكل جهاز)
                                                        │  WebSocket دائم
                                                        ▼
                                             تطبيق Android (Kotlin)
                                             AccessibilityService → Tap / Swipe / Back / Home ...
```

## URLs

| ماذا | الرابط |
|---|---|
| **السيرفر + لوحة التحكم (Production)** | https://device-relay.cracknew37.workers.dev |
| **GitHub** | https://github.com/joknok72-ctrl/device-relay |
| **تنزيل APK (آخر نسخة)** | https://github.com/joknok72-ctrl/device-relay/releases/tag/latest |
| Health check | `GET /api/health` |

## Stack المختار (ولماذا)

| الجزء | التقنية | السبب |
|---|---|---|
| السيرفر الوسيط | **Cloudflare Workers + Hono + TypeScript** | يعمل على الحافة (Edge) عالميًا، بدون سيرفرات، تكلفة صفر تقريبًا |
| قناة الوقت الفعلي | **Durable Objects + WebSocket Hibernation API** | كائن واحد لكل هاتف يحتفظ بالاتصال المفتوح ويمرر الأوامر فورًا ويرجع النتيجة (request/response correlation) |
| تطبيق الهاتف | **Kotlin + Jetpack Compose + Material 3** | الستاك الرسمي والأحدث من Google لأندرويد |
| تنفيذ الحركات | **AccessibilityService** (`dispatchGesture`, `performGlobalAction`, `takeScreenshot`) | الطريقة الرسمية بدون Root |
| الاتصال بالهاتف | **OkHttp WebSocket + Foreground Service** | اتصال دائم مع إعادة اتصال تلقائي (Exponential Backoff) |
| البناء | **GitHub Actions** | يبني APK تلقائيًا مع كل push وينشره في Releases |

## المميزات المنجزة ✅

**السيرفر (Worker)**
- مصادقة `Bearer Token` بمقارنة ثابتة الزمن (constant-time)
- تحقق صارم من صيغة JSON لكل أمر
- `WebSocket Relay` للهاتف + `WebSocket viewer` للوحة التحكم (بث حي للسجل والحالة)
- انتظار نتيجة التنفيذ من الهاتف (timeout 15s) وإرجاعها في نفس الطلب
- تنفيذ Macro (سلسلة أوامر + `wait`)
- سجل آخر 100 أمر لكل جهاز + إحصائيات
- لوحة تحكم Web (عربي/RTL) بأزرار سريعة + JSON يدوي + عرض لقطة الشاشة

**طبقة الـ AI**
- MCP Server + مواصفات أدوات بـ 4 صيغ + endpoints لكل أداة + لقطة PNG مع معلومات المقياس
- `agent_runner.py`: حلقة AI مستقلة (رؤية → قرار → تنفيذ → تحقق) + سيناريوهات تكرارية + REPL

**التطبيق (Android)**
- شاشة إعدادات: رابط السيرفر، التوكن، Device ID، اتصال تلقائي بعد Reboot
- Foreground Service يحافظ على الاتصال + إشعار دائم مع زر "قطع الاتصال"
- AccessibilityService رسمي ينفذ: إيماءات (`tap`, `double_tap`, `long_press`, `swipe`), أزرار النظام، `screenshot`, `wake`
- **v1.2**: قراءة شجرة الواجهة (`ui_dump`), الضغط على عنصر بالاسم/الـ id (`tap_element`), كتابة نص (`type_text`), فتح تطبيق/رابط (`open_app`, `open_url`), قائمة التطبيقات
- سجل مباشر داخل التطبيق لكل أمر وزمن تنفيذه

## دليل الاستخدام (خطوة بخطوة)

### 1) التوكن
التوكن السري (`RELAY_TOKEN`) مضبوط بالفعل كـ Secret على الـ Worker. لتغييره:
```bash
openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN
```

### 2) تثبيت التطبيق على الهاتف
1. من صفحة **Releases** نزّل `DeviceRelay.apk` وثبّته (اسمح بمصادر غير معروفة).
2. افتح التطبيق وأدخل:
   - **رابط السيرفر**: `https://device-relay.cracknew37.workers.dev`
   - **Bearer Token**: التوكن السري
   - **Device ID**: أي اسم (مثال `my-phone`)
3. اضغط **تفعيل** بجانب "خدمة إمكانية الوصول" ← فعّل **Device Relay Automation**.
4. ارجع للتطبيق واضغط **اتصال**. يجب أن تظهر الحالة "متصل ✔".
5. (اختياري) في إعدادات البطارية اجعل التطبيق "غير مقيّد" حتى لا يقتله النظام.

### 3) التحكم من لوحة التحكم
افتح https://device-relay.cracknew37.workers.dev ، أدخل التوكن، اختر الجهاز، واضغط الأزرار.

### 4) التحكم من الـ API

```bash
TOKEN="..." ; URL="https://device-relay.cracknew37.workers.dev" ; DEV="my-phone"

# لمسة
curl -X POST $URL/api/devices/$DEV/command -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"action":{"type":"tap","x":540,"y":1200}}'

# سحب لأعلى
curl -X POST $URL/api/devices/$DEV/command -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":{"type":"swipe","x1":540,"y1":1600,"x2":540,"y2":400,"duration":300}}'

# Macro
curl -X POST $URL/api/devices/$DEV/macro -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"steps":[{"type":"home"},{"type":"wait","ms":500},{"type":"tap","x":540,"y":1200},{"type":"screenshot"}]}'
```

## 🧭 تريد أن يتحكم AI في هاتفك من محادثة جديدة؟
اقرأ **[docs/NEW_CHAT_PROMPT.md](docs/NEW_CHAT_PROMPT.md)** — فيه برومبت جاهز للنسخ + سكريبت `agent/phone.sh` بأمر واحد.

## 🤖 التحكم بواسطة AI Agent (Tool Calling / MCP)

الهاتف مصمم ليكون "يد" لأي نموذج ذكاء اصطناعي. توجد 3 طرق للربط:

### أ) MCP Server (Claude Desktop / Claude Code / Cursor / OpenAI Agents SDK ...)
```
URL:    https://device-relay.cracknew37.workers.dev/mcp
Header: Authorization: Bearer <RELAY_TOKEN>
```
مثال إعداد Claude Code:
```bash
claude mcp add --transport http device-relay https://device-relay.cracknew37.workers.dev/mcp \
  --header "Authorization: Bearer <RELAY_TOKEN>"
```
مثال `mcp.json` (Cursor وغيره):
```json
{ "mcpServers": { "device-relay": { "url": "https://device-relay.cracknew37.workers.dev/mcp",
  "headers": { "Authorization": "Bearer <RELAY_TOKEN>" } } } }
```
بعدها النموذج يرى **22 أداة** مباشرة:
- مراقبة: `get_ui_elements` (شجرة الواجهة: نص/id/إحداثيات — الأدق), `capture_screen`, `get_current_app`, `get_device_status`
- عناصر: `tap_element(text|elementId)`, `type_text(text, submit)`
- تطبيقات: `open_app`, `open_url`, `list_apps`
- إيماءات: `tap`, `double_tap`, `long_press`, `swipe`, `scroll`
- نظام: `press_back`, `press_home`, `open_recents`, `open_notifications`, `open_quick_settings`, `lock_screen`, `wake_screen`, `wait`
`capture_screen` يرجّع الصورة كـ MCP image content فيراها النموذج مباشرة.

### ب) مواصفات الأدوات بأي صيغة (عامة — بدون أسرار)
| الصيغة | الرابط |
|---|---|
| OpenAI `tools` | `GET /api/tools/schema?format=openai` |
| Anthropic `tools` | `GET /api/tools/schema?format=anthropic` |
| Gemini `function_declarations` | `GET /api/tools/schema?format=gemini` |
| OpenAPI 3.1 (GPT Actions / أي عميل OpenAPI) | `GET /api/tools/schema?format=openapi` |

تنفيذ الأداة:
```bash
# عام
POST /api/devices/:id/tools/call      {"name":"tap","arguments":{"x":540,"y":990}}
# أو endpoint لكل أداة (مطابق للـ OpenAPI)
POST /api/devices/:id/tools/tap       {"x":540,"y":990}
POST /api/devices/:id/tools/swipe     {"x1":540,"y1":1800,"x2":540,"y2":600,"duration":250}
POST /api/devices/:id/tools/capture_screen   → {ok, screen:{w,h}, image:{base64,w,h,scale}}
GET  /api/devices/:id/screenshot.png         → PNG خام + Headers: X-Screen-Width/Height, X-Image-Scale
```
> **الإحداثيات دائمًا بمقياس الشاشة الأصلي** (`screen.w × screen.h`). الصورة مصغّرة بعامل `scale`؛ التحويل: `original = image_px / scale`.

### ج) `agent/agent_runner.py` — عميل مستقل يشغّله الـ AI من التيرمينال
```bash
cd agent && pip install -r requirements.txt
export RELAY_URL=https://device-relay.cracknew37.workers.dev RELAY_TOKEN=... OPENAI_API_KEY=...

python agent_runner.py devices                                   # الأجهزة
python agent_runner.py goal "افتح الإعدادات وفعّل الوضع الليلي"      # AI يقود الهاتف في حلقة حتى DONE
python agent_runner.py scenario scenarios/game_smoke.json --loops 50   # اختبار تكراري للألعاب
python agent_runner.py shell                                     # REPL: tap 540 900 / shot / ai: <goal>
```
يعمل مع أي نموذج OpenAI-compatible يدعم الرؤية + Tools (`gpt-5`, `gpt-4o`, Ollama `qwen2.5-vl` ...). التفاصيل في [`agent/README.md`](agent/README.md).

## مرجع الـ API

كل المسارات تحت `/api/*` تتطلب `Authorization: Bearer <RELAY_TOKEN>` (ما عدا `/api/health`).

| Method | Path | الوصف |
|---|---|---|
| GET | `/api/health` | فحص الحالة (عام) |
| GET | `/api/devices` | كل الأجهزة المسجلة وحالتها |
| GET | `/api/devices/:id` | معلومات جهاز |
| DELETE | `/api/devices/:id` | حذف جهاز من القائمة |
| GET | `/api/devices/:id/logs` | آخر 100 أمر |
| POST | `/api/devices/:id/command` | أمر واحد `{ "action": {...}, "wait": true }` |
| POST | `/api/devices/:id/macro` | سلسلة `{ "steps": [ ... ] }` (حتى 50 خطوة) |
| GET | `/api/tools/schema?format=` | مواصفات الأدوات (عام) |
| POST | `/api/devices/:id/tools/call` | تنفيذ أداة AI بالاسم |
| POST | `/api/devices/:id/tools/:tool` | endpoint لكل أداة |
| GET | `/api/devices/:id/screenshot.png` | لقطة PNG خام |
| POST | `/mcp` | MCP Server (JSON-RPC, Streamable HTTP) |
| WS | `/api/ws/phone/:id` | يتصل به الهاتف (Header Bearer) |
| WS | `/api/ws/viewer/:id?token=` | بث حي للوحة التحكم |

### صيغ الأوامر (`action`)
```jsonc
{"type":"tap","x":540,"y":1200}
{"type":"long_press","x":540,"y":1200,"duration":800}
{"type":"swipe","x1":540,"y1":1600,"x2":540,"y2":400,"duration":300}
{"type":"back"} {"type":"home"} {"type":"recents"} {"type":"notifications"}
{"type":"lock"}          // Android 9+
{"type":"screenshot"}    // Android 11+  → يرجع base64 PNG
{"type":"ping"}
```
الرد: `{"id":"...","ok":true,"durationMs":42}` أو `{"ok":false,"error":"device offline"}` (HTTP 502).

## بنية المشروع
```
├── src/
│   ├── index.ts         # Hono: auth, REST, WS upgrade, tools, static
│   ├── tools.ts         # كتالوج الأدوات + مولدات OpenAI/Anthropic/Gemini/OpenAPI
│   ├── tool-exec.ts     # تنفيذ الأداة → Action على الهاتف
│   ├── mcp.ts           # MCP Server
│   ├── device-room.ts   # Durable Object: غرفة WebSocket لكل جهاز
│   ├── registry.ts      # Durable Object: قائمة الأجهزة
│   ├── validate.ts      # تحقق JSON
│   └── types.ts         # البروتوكول المشترك
├── public/              # لوحة التحكم (index.html + static/)
├── android/             # مشروع Android (Kotlin/Compose)
│   └── app/src/main/java/com/devicerelay/client/
│       ├── service/AutomationAccessibilityService.kt   # تنفيذ الحركات
│       ├── service/RelayConnectionService.kt           # WebSocket + Foreground
│       ├── ui/MainActivity.kt                          # واجهة Compose
│       └── net/Protocol.kt                             # نماذج JSON
├── agent/
│   ├── agent_runner.py  # AI Agent loop / scenario runner / REPL
│   └── scenarios/       # سيناريوهات JSON
├── tests/fake-phone.mjs # محاكي هاتف للاختبار (+ mock_llm.py)
├── .github/workflows/   # بناء APK + نشر Worker
└── wrangler.jsonc
```

## التطوير محليًا
```bash
npm install
echo 'RELAY_TOKEN=dev-secret-token-123' > .dev.vars
npm run build            # typecheck
npx wrangler dev --port 3000
node tests/fake-phone.mjs ws://localhost:3000 dev-secret-token-123 test-phone
```

## Data Architecture
- **Durable Object `DeviceRoom`** (واحد لكل deviceId): حالة الجهاز + آخر 100 أمر + اتصالات WebSocket (Hibernation).
- **Durable Object `DeviceRegistry`** (singleton): قائمة أسماء الأجهزة.
- لا توجد قاعدة بيانات خارجية؛ التخزين داخل Durable Objects (SQLite-backed).

## غير منجز بعد / خطوات مقترحة
- [x] ~~كتابة نص، فتح تطبيق، قراءة عناصر الشاشة~~ (v1.2)
- [ ] `find_text` مع تمرير تلقائي حتى يظهر العنصر
- [ ] بث الشاشة المستمر (Screen streaming) بدلاً من لقطات
- [ ] توقيع APK بمفتاح Release حقيقي (حاليًا debug-signed) للنشر في المتاجر
- [ ] توكن مختلف لكل جهاز / صلاحيات متعددة المستخدمين
- [ ] جدولة سيناريوهات (Test Scenarios) وحفظها

## Deployment
- **Platform**: Cloudflare Workers (Durable Objects + Static Assets)
- **Status**: ✅ Active — https://device-relay.cracknew37.workers.dev
- **CI/CD**: push إلى `main` ⇒ بناء APK + نشر Worker تلقائيًا
- **Last Updated**: 2026-09-06 (v1.2 — UI tree, type_text, open_app, 22 tools)

> ⚠️ **أمان**: التوكنات التي أُرسلت في المحادثة يجب تدويرها (Regenerate) بعد الانتهاء. لا يوجد أي توكن مخزّن داخل الكود.
