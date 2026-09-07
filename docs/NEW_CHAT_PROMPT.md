# تشغيل الـ AI للتحكم في هاتفك من محادثة جديدة — رابط واحد فقط

## الطريقة الأسهل: لوحة الإعداد
افتح (من أي متصفح):
```
https://device-relay.cracknew37.workers.dev/setup/<ADMIN_TOKEN>
```
ستجد فيها **3 خطوات** مع أزرار "نسخ": رابط ربط الموبايل (+QR)، برومبت المحادثة الجديدة، ورابط المراقبة الحية. كما تدير منها التوكنات (إنشاء توكن لكل AI/جهاز، إلغاء، Admin بديل) والأجهزة — بدون أي أوامر تيرمينال.

## في المحادثة الجديدة اكتب فقط (سطرين):
```
https://device-relay.cracknew37.workers.dev/agent/<TOKEN>
افتح الرابط ونفّذ ما فيه، ثم: <مهمتك>
```
مثال:
```
https://device-relay.cracknew37.workers.dev/agent/dr_ab12...
افتح الرابط ونفّذ ما فيه، ثم: افتح واتساب وأرسل "أنا في الطريق" إلى أحمد
```
الـ AI سيفتح الرابط، يجد بيانات الاتصال محقونة، ينزّل `phone.sh` من السيرفر نفسه، يتحقق أن الهاتف Online، ويبدأ: يقرأ الشاشة → يفتح التطبيق → يضغط العناصر بأسمائها → يكتب → يتحقق → يقدّم لك تقريرًا.

> استخدم **توكن جهاز** (`dr_...`) من لوحة الإعداد بدلًا من توكن الـ Admin — لو تسرّب تلغيه بضغطة.

## الشرط الوحيد
المحادثة الجديدة يجب أن تكون في بيئة **فيها تيرمينال** (Genspark AI Developer، Claude Code، Cursor، Codex CLI). في شات عادي بدون أدوات لا يمكن للـ AI تنفيذ أوامر.

## بديل بلا أي كلام: MCP (Claude Desktop / Claude Code / Cursor)
```bash
claude mcp add --transport http phone https://device-relay.cracknew37.workers.dev/mcp/<TOKEN>
```
أو في `mcp.json`:
```json
{ "mcpServers": { "phone": { "url": "https://device-relay.cracknew37.workers.dev/mcp/<TOKEN>" } } }
```
بعدها تكتب طبيعيًا "افتح كروم وابحث عن الطقس" وتظهر 31 أداة كأدوات أصلية.

## بلا محادثة أصلًا: حلقة مستقلة
```bash
python agent/agent_runner.py --bootstrap https://device-relay.cracknew37.workers.dev/agent/<TOKEN> \
  goal "افتح الإعدادات وفعّل الوضع الليلي"
```

## تجهيز الهاتف (مرة واحدة)
1. ثبّت آخر APK: https://github.com/joknok72-ctrl/device-relay/releases/tag/latest
2. من لوحة الإعداد انسخ **رابط ربط الموبايل** وافتحه من الموبايل (أو امسح QR) — التطبيق يفتح ويملأ الإعدادات ويتصل تلقائيًا.
3. فعّل خدمة إمكانية الوصول "Device Relay Automation" و(اختياريًا) "قراءة الإشعارات".
4. استثنِ التطبيق من توفير البطارية.

## لو ضاع توكن الـ Admin
- لو عندك Admin بديل (أنشأته من لوحة الإعداد) استخدمه.
- وإلا من التيرمينال: `openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN` ثم افتح `/setup/<الجديد>`.
