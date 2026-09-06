# تشغيل الـ AI للتحكم في هاتفك من محادثة جديدة — رابط واحد فقط

لا لوحة تحكم، لا برومبت طويل. أنت تعطي الـ AI **رابطًا واحدًا**، والسيرفر نفسه يشرح له كل شيء (التوكن، الأوامر، الأدوات، حالة الهاتف، القواعد).

## رابطك (احتفظ به سرًا — يعطي تحكمًا كاملًا في الهاتف)
```
https://device-relay.cracknew37.workers.dev/agent/<RELAY_TOKEN>
```

## في المحادثة الجديدة اكتب فقط:
```
https://device-relay.cracknew37.workers.dev/agent/<RELAY_TOKEN>
افتح الرابط ونفّذ ما فيه، ثم: <مهمتك>
```
مثال:
```
https://device-relay.cracknew37.workers.dev/agent/abc123...
افتح الرابط ونفّذ ما فيه، ثم: افتح واتساب وأرسل "أنا في الطريق" إلى أحمد
```

هذا كل شيء. الـ AI سيفتح الرابط، يجد بيانات الاتصال محقونة، ينزّل `phone.sh` من السيرفر نفسه، يتحقق أن الهاتف Online، ويبدأ: يقرأ الشاشة → يفتح التطبيق → يضغط العناصر بأسمائها → يكتب → يتحقق → يقدّم لك تقريرًا.

## الشرط الوحيد
المحادثة الجديدة يجب أن تكون في بيئة **فيها تيرمينال** (Genspark AI Developer مثل هذه، أو Claude Code / Cursor / Codex CLI). في شات عادي بدون أدوات لا يمكن للـ AI تنفيذ أوامر.

## بديل بلا أي كلام: MCP (Claude Desktop / Claude Code / Cursor)
```bash
claude mcp add --transport http phone https://device-relay.cracknew37.workers.dev/mcp/<RELAY_TOKEN>
```
أو في `mcp.json`:
```json
{ "mcpServers": { "phone": { "url": "https://device-relay.cracknew37.workers.dev/mcp/<RELAY_TOKEN>" } } }
```
بعدها تكتب طبيعيًا "افتح كروم وابحث عن الطقس" وتظهر لي 24 أداة كأدوات أصلية.

## بلا محادثة أصلًا: حلقة مستقلة
```bash
python agent/agent_runner.py --bootstrap https://device-relay.cracknew37.workers.dev/agent/<RELAY_TOKEN> \
  goal "افتح الإعدادات وفعّل الوضع الليلي"
```

## تجهيز الهاتف (مرة واحدة)
1. ثبّت آخر APK: https://github.com/joknok72-ctrl/device-relay/releases/tag/latest
2. رابط السيرفر `https://device-relay.cracknew37.workers.dev` + التوكن + Device ID.
3. فعّل خدمة إمكانية الوصول "Device Relay Automation" → اضغط **اتصال** → "متصل ✔".
4. فعّل "اتصال تلقائي" واستثنِ التطبيق من توفير البطارية.

## تدوير التوكن (لو تسرّب)
```bash
openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN
```
ثم حدّثه في التطبيق على الهاتف. الرابط القديم يتوقف فورًا.
