# كيف تخلّي الـ AI (أنا) يتحكم في هاتفك من محادثة جديدة تمامًا

المحادثة الجديدة **لا تعرف أي شيء** عن هذا المشروع. كل ما تحتاجه هو أن تعطيني 3 معلومات (الرابط + التوكن + اسم الجهاز) وطريقة الاستخدام — وكلها موجودة في البرومبت الجاهز بالأسفل.

---

## الخطوات (مرة واحدة على الهاتف)

1. ثبّت آخر APK من: https://github.com/joknok72-ctrl/device-relay/releases/tag/latest
2. افتح التطبيق: **رابط السيرفر** `https://device-relay.cracknew37.workers.dev` + **التوكن** + **Device ID** (مثلاً `my-phone`).
3. **تفعيل** خدمة إمكانية الوصول ← فعّل "Device Relay Automation".
4. اضغط **اتصال** — لازم يظهر "متصل ✔". (فعّل أيضًا "اتصال تلقائي" واستثنِ التطبيق من توفير البطارية.)
5. تأكد من لوحة التحكم https://device-relay.cracknew37.workers.dev أن الجهاز **● Online**.

---

## في كل محادثة جديدة معي — انسخ هذا البرومبت والصقه (بعد تعديل التوكن)

```text
أنت وكيل أتمتة يتحكم في هاتف أندرويد حقيقي خاص بي عبر HTTP API بسيط (Device Relay).
استخدم أداة الـ Bash/التيرمينال عندك مع curl لتنفيذ الأوامر. لا تسألني عن التفاصيل — كل شيء موجود هنا.

الإعدادات:
  RELAY_URL=https://device-relay.cracknew37.workers.dev
  RELAY_TOKEN=<<ضع التوكن هنا>>
  RELAY_DEVICE=my-phone      # أو اتركه فارغًا ليختار أول جهاز متصل

أسهل طريقة — سكريبت جاهز (نزّله أولًا):
  curl -sL https://raw.githubusercontent.com/joknok72-ctrl/device-relay/main/agent/phone.sh -o phone.sh && chmod +x phone.sh
  export RELAY_URL=... RELAY_TOKEN=... RELAY_DEVICE=...
  ./phone.sh devices                  # تأكد أن الجهاز ● online
  ./phone.sh ui                       # اقرأ عناصر الشاشة (نص + id + إحداثيات cx,cy بالبكسل الأصلي)
  ./phone.sh shot screen.png          # لقطة شاشة (افتحها بأداة قراءة الصور عندك)
  ./phone.sh open "Chrome"            # فتح تطبيق بالاسم
  ./phone.sh tapel "Sign in"          # ضغط عنصر بنصّه
  ./phone.sh tap 540 990              # ضغط بإحداثيات
  ./phone.sh type "hello" submit      # كتابة نص في الحقل المركّز + Enter
  ./phone.sh swipe 540 1800 540 600   # سحب
  ./phone.sh scroll down              # تمرير
  ./phone.sh back | home | notif | wait 1000 | app | apps | url https://...
  ./phone.sh call <tool> '<json>'     # أي أداة من القائمة الكاملة: GET $RELAY_URL/api/tools/schema?format=openai

أو بدون سكريبت (curl مباشر):
  curl -s -H "Authorization: Bearer $RELAY_TOKEN" $RELAY_URL/api/devices
  curl -s -H "Authorization: Bearer $RELAY_TOKEN" -H "Content-Type: application/json" \
       -d '{"name":"tap_element","arguments":{"text":"Settings"}}' \
       $RELAY_URL/api/devices/$RELAY_DEVICE/tools/call
  curl -s -H "Authorization: Bearer $RELAY_TOKEN" -o screen.png $RELAY_URL/api/devices/$RELAY_DEVICE/screenshot.png

قواعد العمل:
1. راقب قبل أن تتصرف: ابدأ بـ `ui` (أدق وأسرع)، واستخدم `shot` عندما تهم الصورة (ألعاب/صور/WebView).
2. بعد كل فعل يغيّر الشاشة، أعد المراقبة وتحقق من النتيجة قبل الخطوة التالية.
3. الإحداثيات بالبكسل الأصلي للشاشة (screen.w × screen.h). الصورة مصغّرة بعامل scale (في header X-Image-Scale): original = image_px / scale.
4. فضّل open_app و tap_element و type_text على الضغط بالإحداثيات.
5. تعامل مع النوافذ المنبثقة/الأذونات بعقلانية ثم أكمل الهدف.
6. لا تختلق محتوى الشاشة، ولا تعلن النجاح دون تحقق ملحوظ.
7. أخبرني بالخطوات التي نفذتها وبالنتيجة النهائية بإيجاز.

مهمتك الآن: <<اكتب ما تريده، مثلاً: افتح واتساب وأرسل "أنا في الطريق" إلى أحمد>>
```

> **ملاحظة**: لو المحادثة الجديدة معي في بيئة **بدون** تيرمينال (Chat عادي بدون sandbox) لن أستطيع تنفيذ أوامر. استخدم وقتها بيئة فيها أدوات (Genspark AI Developer / Claude Code / Cursor) — أو اربط الـ MCP Server (الطريقة ب بالأسفل).

---

## الطريقة (ب): ربط MCP — أفضل تجربة مع Claude Desktop / Claude Code / Cursor

بدلًا من curl، اجعل الأدوات تظهر لي مباشرة كـ Tools:

**Claude Code**
```bash
claude mcp add --transport http device-relay https://device-relay.cracknew37.workers.dev/mcp \
  --header "Authorization: Bearer <RELAY_TOKEN>"
```

**Claude Desktop / Cursor / أي عميل MCP** — أضف في `mcp.json`:
```json
{
  "mcpServers": {
    "device-relay": {
      "url": "https://device-relay.cracknew37.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <RELAY_TOKEN>" }
    }
  }
}
```
بعدها اكتب طبيعيًا: *"افتح Chrome وابحث عن الطقس في القاهرة"* — وسأستخدم `open_app` ← `get_ui_elements` ← `tap_element` ← `type_text` ← `capture_screen` تلقائيًا.

---

## الطريقة (ج): تشغيل حلقة مستقلة بدون أي محادثة

```bash
git clone https://github.com/joknok72-ctrl/device-relay && cd device-relay/agent
pip install -r requirements.txt
export RELAY_URL=https://device-relay.cracknew37.workers.dev RELAY_TOKEN=... OPENAI_API_KEY=sk-...
python agent_runner.py goal "افتح الإعدادات وفعّل الوضع الليلي" --max-steps 20
python agent_runner.py scenario scenarios/game_smoke.json --loops 50
```

---

## الأدوات المتاحة (22)

| الفئة | الأدوات |
|---|---|
| مراقبة | `get_ui_elements`, `capture_screen`, `get_current_app`, `get_device_status` |
| عناصر | `tap_element(text/elementId/index)`, `type_text(text, clear, submit)` |
| تطبيقات | `open_app(name/package)`, `open_url(url)`, `list_apps` |
| إيماءات | `tap`, `double_tap`, `long_press`, `swipe`, `scroll(direction, amount)` |
| نظام | `press_back`, `press_home`, `open_recents`, `open_notifications`, `open_quick_settings`, `lock_screen`, `wake_screen`, `wait(ms)` |

## أمان
- التوكن يعطي تحكمًا كاملًا في الهاتف — لا تنشره. لتغييره: `openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN` ثم حدّثه في التطبيق.
- اقطع الاتصال من إشعار التطبيق في أي وقت.
