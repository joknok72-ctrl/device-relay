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
| **السيرفر (Production)** | https://device-relay.cracknew37.workers.dev |
| **مراقبة حية للإنسان** | `https://device-relay.cracknew37.workers.dev/monitor/<TOKEN>` |
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

**السيرفر (Worker) — v1.4**
- 🔐 **توكن لكل جهاز** (`/api/admin/tokens`): توكن محدود بجهاز واحد، خيار `readOnly` (مراقبة فقط)، إلغاء فوري. التوكنات تُخزَّن كـ SHA-256 فقط
- 🚦 **Rate limiting** لكل توكن (120 طلب / 10 ثوانٍ) مع `X-RateLimit-Remaining` و `Retry-After`
- 📥 **طابور أوامر**: أوامر الإدخال (tap/swipe/type…) تُنفَّذ بالتسلسل لكل هاتف؛ أوامر القراءة (screenshot/ui/notifications) تعمل بالتوازي. النتيجة تحمل `queuedMs`
- 📦 أداة **`batch`**: تنفيذ حتى 25 أداة في طلب واحد (`continueOnError` اختياري)
- 📸 `capture_screen` بخيارات `maxWidth` (حتى 2160) / `format=jpeg` / `quality` + `GET /screenshot.jpg`
- 👁️ **صفحة مراقبة حية** `/monitor/<token>` (حالة + سجل حي + آخر لقطة) — للمتابعة فقط، لا تحكم
- 🔔 **Webhook** اختياري (`WEBHOOK_URL` secret) عند online/offline
- 🏷️ تسمية الأجهزة (`label`) + مسح السجل + فصل جهاز من الـ Admin API
- مصادقة `Bearer Token` بمقارنة ثابتة الزمن (constant-time)
- تحقق صارم من صيغة JSON لكل أمر
- `WebSocket Relay` للهاتف + `WebSocket viewer` للوحة التحكم (بث حي للسجل والحالة)
- انتظار نتيجة التنفيذ من الهاتف (timeout 15s) وإرجاعها في نفس الطلب
- تنفيذ Macro (سلسلة أوامر + `wait`)
- سجل آخر 100 أمر لكل جهاز + إحصائيات
- صفحة حالة فقط (لا تحكم يدوي) — التشغيل عبر AI حصريًا

**طبقة الـ AI**
- MCP Server + مواصفات أدوات بـ 4 صيغ + endpoints لكل أداة + لقطة PNG مع معلومات المقياس
- `agent_runner.py`: حلقة AI مستقلة (رؤية → قرار → تنفيذ → تحقق) + سيناريوهات تكرارية + REPL

**التطبيق (Android)**
- شاشة إعدادات: رابط السيرفر، التوكن، Device ID، اتصال تلقائي بعد Reboot
- Foreground Service يحافظ على الاتصال + إشعار دائم مع زر "قطع الاتصال"
- AccessibilityService رسمي ينفذ: إيماءات (`tap`, `double_tap`, `long_press`, `swipe`), أزرار النظام، `screenshot`, `wake`
- **v1.2**: قراءة شجرة الواجهة (`ui_dump`), الضغط على عنصر بالاسم/الـ id (`tap_element`), كتابة نص (`type_text`), فتح تطبيق/رابط (`open_app`, `open_url`), قائمة التطبيقات
- **v1.4**: `drag` (سحب وإفلات), `pinch` (تكبير/تصغير بإصبعين), `scroll_element` (تمرير عنصر محدد عبر Accessibility), `set_clipboard` (+لصق), `get_notifications` (قراءة الإشعارات — يتطلب تفعيل "Notification access" من التطبيق), `get_device_info` (بطارية/شبكة/قفل/تخزين), لقطات بجودة/حجم متغير (PNG/JPEG), بطارية في `hello` كل 60 ثانية
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

### 3) توكنات لكل جهاز (موصى به بدل مشاركة التوكن الرئيسي)
```bash
ADMIN="..." ; URL="https://device-relay.cracknew37.workers.dev"

# توكن كامل لجهاز واحد
curl -X POST $URL/api/admin/tokens -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"deviceId":"my-phone","label":"Claude on laptop"}'
# → {"token":"dr_...","agentUrl":".../agent/dr_...","mcpUrl":".../mcp/dr_...","monitorUrl":".../monitor/dr_..."}

# توكن مراقبة فقط (لا يستطيع اللمس/الكتابة)
curl -X POST $URL/api/admin/tokens -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"deviceId":"my-phone","readOnly":true}'

curl $URL/api/admin/tokens -H "Authorization: Bearer $ADMIN"          # قائمة
curl -X DELETE $URL/api/admin/tokens/<id> -H "Authorization: Bearer $ADMIN"   # إلغاء
```
أعطِ الـ AI رابط `agentUrl` فقط — لا يرى غير هذا الجهاز.

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

## 🧭 AI-only: تحكم من محادثة جديدة برابط واحد
```
https://device-relay.cracknew37.workers.dev/agent/<RELAY_TOKEN>
افتح الرابط ونفّذ ما فيه، ثم: <مهمتك>
```
السيرفر **يشرح نفسه** للـ AI (بيانات الاتصال + phone.sh + 24 أداة + القواعد + حالة الهاتف). التفاصيل: **[docs/NEW_CHAT_PROMPT.md](docs/NEW_CHAT_PROMPT.md)**.
لا توجد لوحة تحكم يدوية — الصفحة الرئيسية صفحة حالة فقط.

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
بعدها النموذج يرى **31 أداة** مباشرة:
- مراقبة: `get_ui_elements` (شجرة الواجهة: نص/id/إحداثيات — الأدق), `capture_screen(maxWidth?, format?, quality?)`, `get_current_app`, `get_device_status`, `get_device_info`, `get_notifications`
- عناصر: `tap_element(text|elementId)`, `type_text(text, submit)`, `set_clipboard(text, paste)`, `wait_for_element`, `find_and_tap`, `scroll_element`
- تطبيقات: `open_app`, `open_url`, `list_apps`
- إيماءات: `tap`, `double_tap`, `long_press`, `swipe`, `drag`, `pinch`, `scroll`
- نظام: `press_back`, `press_home`, `open_recents`, `open_notifications`, `open_quick_settings`, `lock_screen`, `wake_screen`, `wait`
- تركيبية: **`batch(steps[], continueOnError)`** — عدة أدوات في طلب واحد
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
| GET | `/api/me` | هوية التوكن الحالي (admin / device / readOnly) |
| GET | `/api/devices/:id/logs` | آخر 100 أمر |
| GET | `/api/devices/:id/last-screenshot` | آخر لقطة محفوظة (بدون التقاط جديد) |
| POST | `/api/admin/tokens` | إنشاء توكن لجهاز `{deviceId, label?, readOnly?}` (admin) |
| GET / DELETE | `/api/admin/tokens[/:id]` | قائمة / إلغاء توكنات (admin) |
| POST | `/api/admin/devices/:id/label` · `/clear-logs` · `/disconnect` | إدارة جهاز (admin) |
| POST | `/api/devices/:id/command` | أمر واحد `{ "action": {...}, "wait": true }` |
| POST | `/api/devices/:id/macro` | سلسلة `{ "steps": [ ... ], "continueOnError": false }` (حتى 50 خطوة) |
| GET | `/api/tools/schema?format=` | مواصفات الأدوات (عام) |
| POST | `/api/devices/:id/tools/call` | تنفيذ أداة AI بالاسم |
| POST | `/api/devices/:id/tools/:tool` | endpoint لكل أداة |
| GET | `/api/devices/:id/screenshot.png` · `.jpg` | لقطة خام (`?maxWidth=&format=&quality=`) |
| POST | `/mcp` · `/mcp/:token` | MCP Server (JSON-RPC, Streamable HTTP) |
| GET | `/agent/:token` | **Bootstrap ذاتي الوصف للـ AI** (بيانات + أدوات + قواعد + حالة) |
| GET | `/phone.sh` | سكريبت التحكم (يُخدَم من السيرفر) |
| WS | `/api/ws/phone/:id` | يتصل به الهاتف (Header Bearer) |
| GET | `/monitor/:token` | صفحة مراقبة حية للإنسان |
| WS | `/api/ws/viewer/:id?token=` | بث حي لصفحة المراقبة |

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
```jsonc
// v1.4
{"type":"screenshot","maxWidth":1080,"format":"jpeg","quality":70}
{"type":"drag","x1":100,"y1":900,"x2":800,"y2":900,"holdMs":500,"duration":600}
{"type":"pinch","x":540,"y":1200,"scale":2}
{"type":"scroll_element","elementId":"recycler","direction":"forward"}
{"type":"set_clipboard","text":"...","paste":true}
{"type":"get_notifications","limit":20}   {"type":"device_info"}
```
الرد: `{"id":"...","ok":true,"durationMs":42,"queuedMs":310}` أو `{"ok":false,"error":"device offline"}` (HTTP 502). `429` عند تجاوز الحد.

### الأمان (v1.4)
| التوكن | الصلاحية |
|---|---|
| `RELAY_TOKEN` (secret) | Admin: كل الأجهزة + `/api/admin/*` |
| `dr_...` (per-device) | جهاز واحد فقط. مع `readOnly` ⇒ أدوات المراقبة فقط |
- التوكنات تُخزَّن كـ SHA-256 في `DeviceRegistry`؛ لا يمكن استرجاعها بعد الإنشاء.
- Rate limit: 120 طلب/10 ثوانٍ لكل توكن (`X-RateLimit-Remaining`, `Retry-After`).
- Webhook: `wrangler secret put WEBHOOK_URL` ⇒ POST `{event:"online"|"offline", deviceId, info}`.

## بنية المشروع
```
├── src/
│   ├── index.ts         # Hono: auth, REST, WS upgrade, tools, static
│   ├── tools.ts         # كتالوج الأدوات + مولدات OpenAI/Anthropic/Gemini/OpenAPI
│   ├── tool-exec.ts     # تنفيذ الأداة → Action على الهاتف (+ batch, wait_for, find_and_tap)
│   ├── auth.ts          # مصادقة (admin / per-device / readOnly) + rate limit
│   ├── mcp.ts           # MCP Server
│   ├── device-room.ts   # Durable Object: غرفة WebSocket لكل جهاز
│   ├── registry.ts      # Durable Object: قائمة الأجهزة + توكنات (hashed) + labels
│   ├── validate.ts      # تحقق JSON
│   └── types.ts         # البروتوكول المشترك
├── public/              # index.html (حالة) + monitor.html (مراقبة حية)
├── android/             # مشروع Android (Kotlin/Compose)
│   └── app/src/main/java/com/devicerelay/client/
│       ├── service/AutomationAccessibilityService.kt   # تنفيذ الحركات + drag/pinch/clipboard/device_info
│       ├── service/RelayNotificationListener.kt        # قراءة الإشعارات (اختياري)
│       ├── service/RelayConnectionService.kt           # WebSocket + Foreground
│       ├── ui/MainActivity.kt                          # واجهة Compose
│       └── net/Protocol.kt                             # نماذج JSON
├── agent/
│   ├── agent_runner.py  # AI Agent loop / scenario runner / REPL
│   └── scenarios/       # سيناريوهات JSON
├── tests/fake-phone.mjs # محاكي هاتف للاختبار (+ mock_llm.py)
├── tests/e2e.sh         # 49 اختبار end-to-end (tokens/queue/batch/rate-limit/monitor/mcp)
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
tests/e2e.sh             # 49 checks → PASSED 49 FAILED 0
```

## Data Architecture
- **Durable Object `DeviceRoom`** (واحد لكل deviceId): حالة الجهاز + آخر 100 أمر + اتصالات WebSocket (Hibernation).
- **Durable Object `DeviceRegistry`** (singleton): قائمة الأجهزة + توكنات per-device (SHA-256) + labels.
- `DeviceRoom` يحتفظ أيضًا بآخر لقطة في الذاكرة وطابور أوامر الإدخال.
- لا توجد قاعدة بيانات خارجية؛ التخزين داخل Durable Objects (SQLite-backed).

## غير منجز بعد / خطوات مقترحة
- [x] ~~كتابة نص، فتح تطبيق، قراءة عناصر الشاشة~~ (v1.2)
- [x] ~~توكن مختلف لكل جهاز / صلاحيات~~ (v1.4)
- [x] ~~صفحة مراقبة حية للإنسان~~ (v1.4)
- [ ] بث الشاشة المستمر (Screen streaming) بدلاً من لقطات
- [ ] توقيع APK بمفتاح Release حقيقي (حاليًا debug-signed) للنشر في المتاجر
- [ ] جدولة سيناريوهات (Test Scenarios) وحفظها
- [ ] Rate limit موزّع (Durable Object) بدل per-isolate
- [ ] انتهاء صلاحية التوكنات (expiresAt) + تدوير تلقائي

## Deployment
- **Platform**: Cloudflare Workers (Durable Objects + Static Assets)
- **Status**: ✅ Active — https://device-relay.cracknew37.workers.dev
- **CI/CD**: push إلى `main` ⇒ بناء APK + نشر Worker تلقائيًا
- **Secrets**: `RELAY_TOKEN` (مضبوط) · `WEBHOOK_URL` (اختياري)
- **GitHub Actions secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (مضبوطة)
- **Last Updated**: 2026-09-07 (v1.4 — per-device tokens, queue, batch, 31 tools, live monitor, Android 1.4.0)

> ⚠️ **أمان**: التوكنات التي أُرسلت في المحادثة يجب تدويرها (Regenerate) بعد الانتهاء. لا يوجد أي توكن مخزّن داخل الكود.
