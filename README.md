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

**التطبيق (Android)**
- شاشة إعدادات: رابط السيرفر، التوكن، Device ID، اتصال تلقائي بعد Reboot
- Foreground Service يحافظ على الاتصال + إشعار دائم مع زر "قطع الاتصال"
- AccessibilityService رسمي ينفذ: `tap`, `long_press`, `swipe`, `back`, `home`, `recents`, `notifications`, `lock`, `screenshot`, `ping`
- لا يقرأ محتوى الشاشة (`canRetrieveWindowContent=false`) — ينفذ حركات فقط
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
│   ├── index.ts         # Hono: auth, REST, WS upgrade, static
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
├── tests/fake-phone.mjs # محاكي هاتف للاختبار
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
- [ ] أوامر إضافية: كتابة نص (`type`), فتح تطبيق بالـ package name, قراءة نص من الشاشة (تحتاج `canRetrieveWindowContent`)
- [ ] بث الشاشة المستمر (Screen streaming) بدلاً من لقطات
- [ ] توقيع APK بمفتاح Release حقيقي (حاليًا debug-signed) للنشر في المتاجر
- [ ] توكن مختلف لكل جهاز / صلاحيات متعددة المستخدمين
- [ ] جدولة سيناريوهات (Test Scenarios) وحفظها

## Deployment
- **Platform**: Cloudflare Workers (Durable Objects + Static Assets)
- **Status**: ✅ Active — https://device-relay.cracknew37.workers.dev
- **CI/CD**: push إلى `main` ⇒ بناء APK + نشر Worker تلقائيًا
- **Last Updated**: 2026-09-06

> ⚠️ **أمان**: التوكنات التي أُرسلت في المحادثة يجب تدويرها (Regenerate) بعد الانتهاء. لا يوجد أي توكن مخزّن داخل الكود.
