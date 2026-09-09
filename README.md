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
| **لوحة الإعداد (المالك)** | `https://device-relay.cracknew37.workers.dev/setup/<ADMIN_TOKEN>` — ابدأ من هنا |
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

**🕹️ v4.1 — AI-direct play: `play` + `react_script` + `play_frame` (الـ AI هو اللاعب، بدون بوتات)**
- **`play`** = ACT + WAIT + SEE في نداء واحد: خطوات combo (joystick/aim/fire/tap/down/move/up) أو أداة واحدة → انتظار `waitMs` → **إطار لعب**: صورة JPEG مضغوطة + كل الأجسام لكل لون (`objects{name:{count,objects[{cx,cy,area,w,h,top}]}}`) + أرقام OCR لكل منطقة (`ocr{score:{value,text}}`) + بكسلات محددة + `changedPct` + سطر `summary` مقروء بدون الصورة (`@enemy×3 nearest(540,1500) · score=1250 · changed 7.5%`).
- **Profile-aware**: مع `game_profile` محفوظ، `play {}` وحدها تكشف تلقائيًا كل ألوان البروفايل وتقرأ كل المناطق الرقمية (score/hp/ammo/coins/time/kills…) — وعي كامل بالموقف كل tick.
- **`react_script`** — محرك ردود فعل على الجهاز نفسه (~50ms، 20-30 fps) لمدة تصل 60s بينما الـ AI يفكر: قواعد `{when:[conditions], then:[combo steps], cooldownMs, priority, maxFires, exclusive}`؛ شروط `color_present/absent` (مع `minSize/maxSize` = وضع أجسام)، `pixel_is/not`، `text_present/absent` (OCR)، `always`، `forMs`؛ خطوات إضافية **`tap_found`** (المس الجسم المكتشف) و **`aim_found`** (اسحب الكاميرا حتى يقف الـ crosshair على الجسم: `x,y` crosshair، `lookX/lookY` منطقة النظر، `sensitivity`، `maxStep`، `dy` للرأس)؛ `stopRules` لإيقاف مبكر (GAME OVER). يرجع `triggers/frames/fires/log/stoppedBy` ويرفع كل الأصابع في النهاية.
- **`play_frame`** — إدراك فقط (نفس الإطار بدون فعل)، مسموح للتوكن read-only.
- كل الإحداثيات/الألوان/المناطق تقبل `@names` من البروفايل (`at:"@crosshair"`, `lookX:"@look"`, `color:"@enemy"`).
- Bootstrap 7a محدَّث: الحلقة `play {} → قرار → play {act} أو react_script → play {}`؛ playbook الشوتر بمرحلتين (Find & engage / Reactive).
- `phone.sh play ['steps'] [waitMs] ['{objects,ocr}']` (يحفظ `play.jpg`)، `phone.sh frame`, `phone.sh rules '<rules>' [ms] ['<stopRules>']`.
- Android **4.1.0**: تنفيذ `react_script` و `play_frame` على الجهاز (capture واحد → أجسام + OCR + بكسلات + diff).
- 81 أداة، اختبارات: suite جديد `tests/e2e-v41.sh` (81 فحص) — الإجمالي **713/713** ✅.

**السيرفر (Worker) — v1.4**
- 🔐 **توكن لكل جهاز** (`/api/admin/tokens`): توكن محدود بجهاز واحد، خيار `readOnly` (مراقبة فقط)، إلغاء فوري. التوكنات تُخزَّن كـ SHA-256 فقط
- 🚦 **Rate limiting** لكل توكن (120 طلب / 10 ثوانٍ) مع `X-RateLimit-Remaining` و `Retry-After`
- 📥 **طابور أوامر**: أوامر الإدخال (tap/swipe/type…) تُنفَّذ بالتسلسل لكل هاتف؛ أوامر القراءة (screenshot/ui/notifications) تعمل بالتوازي. النتيجة تحمل `queuedMs`
- 📦 أداة **`batch`**: تنفيذ حتى 25 أداة في طلب واحد (`continueOnError` اختياري)
- 📸 `capture_screen` بخيارات `maxWidth` (حتى 2160) / `format=jpeg` / `quality` + `GET /screenshot.jpg`
- 🧭 **لوحة الإعداد** `/setup/<admin>`: 3 خطوات بأزرار نسخ (ربط الموبايل +QR، برومبت المحادثة، المراقبة) + إدارة التوكنات والأجهزة من المتصفح
- 🔗 **ربط الموبايل برابط واحد** `/pair?...` → `devicerelay://pair` يملأ إعدادات التطبيق ويتصل تلقائيًا
- 🔑 **توكنات Admin بديلة** تُنشأ من اللوحة (تدوير بدون wrangler)؛ `/api/me` يرجّع كل روابط التوكن
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

**🎮 محرك لمس متعدد + ألعاب الشوتر + playbooks لكل نوع لعبة (v2.5)**
- **أصابع دائمة (حتى 4)**: `finger op=down/move/up` — إصبع يفضل مضغوطًا ويتحرك بينما أصابع أخرى تضغط (عبر `StrokeDescription.continueStroke` في Android)
- **`joystick`**: عصا حركة افتراضية — مركز + اتجاه/زاوية + مسافة + مدة؛ `release=false` يخلي الشخصية تجري والاستدعاء التالي يغيّر الاتجاه بدون توقف
- **`aim`**: سحب الكاميرا/التصويب (dx/dy) بإصبع مستقل بنقاط وسيطة سلسة — يعمل أثناء الحركة
- **`fire_burst`**: زرار النار: رشّة (count/interval) أو ضغط مستمر (holdMs) — الإيقاع على الموبايل
- **`combo`**: سكربت لمس متعدد موقوت يُنفّذ كاملًا على الموبايل (down/move/up/tap/wait/joystick/aim/fire) — "تحرّك + صوّب + اضرب + ارفع الأصابع" في طلب واحد؛ أي فشل يرفع كل الأصابع
- **@names في كل ده**: `joystick at:"@stick"` · `aim at:"@look"` · `fire_burst at:"@fire"` · حتى داخل خطوات `combo`
- **نوع اللعبة (`game_profile genre=`)** + **8 playbooks** في الـ bootstrap: shooter (Free Fire/PUBG/CoD/Brawl Stars) · runner · puzzle · rhythm · strategy/rpg · racing · fighting · casual — كل واحد بـ: الأزرار اللي يحفظها، كيف يتحرك/يصوّب/يضرب، حلقة الاشتباك، البقاء، الأمان. QUICK START يحيل للـ playbook المناسب للعبة المفتوحة؛ التبديل بين الألعاب = تبديل بروفايل تلقائيًا
- `phone.sh`: `stick @stick up 800 200 hold` · `aim @look 60 -10` · `fire @fire 6 80` · `fireh @fire 1500` · `fingers` · `fdown/fmove/fup` · `combo '<json>'`

**🏆 تسليم بين الجلسات + وعي باللعبة + تحقق ذاتي (v2.4)**
- **`session_report`**: في نهاية كل جلسة الـ AI يكتب تسليمًا: النتيجة (win/loss/progress/stuck)، النقاط، المستوى، ملخص، ما تعلّمه، **نصيحة للمرة القادمة**، العوائق — يُربط بالجلسة والبروفايل؛ **أفضل نتيجة** تُتابع تلقائيًا؛ المحادثة القادمة تشوف آخر تقرير وـ NEXT TIME في QUICK START (قاعدة إلزامية في الـ bootstrap)
- **`observe` واعي باللعبة**: لو فيه بروفايل، نفس الاستدعاء يرجّع `game.objects` (كل @color → عدد وأكبر الأجسام بمواقعها) و`game.values` (@score/@coins/@hp... → أرقام) — **نظرة واحدة = حالة اللعبة كاملة**
- **`game_profile verify=true`**: يفحص كل لون/منطقة/زرار في البروفايل ضد الشاشة الحية ويرجّع `stale[]` — الـ AI يعرف بنفسه إن اللعبة اتحدّثت وإيه اللي محتاج إعادة تعلّم
- `/setup`: أفضل نتيجة + عدد التقارير + ملخص ونصيحة كل جلسة داخل كل لعبة؛ `/monitor` يستقبل حدث `report`
- `phone.sh`: `report "summary" [outcome] [score] ["next time"]` · `verify`

**🎯 بروفايل اللعبة + @names + QUICK START (v2.3) — محادثة جديدة تلعب فورًا**
- **`game_profile`**: قاعدة معرفة مُهيكلة لكل لعبة: أزرار بأسماء (`@jump`=(950,2100) ~120ms)، ألوان (`@enemy`=#ff2020)، مناطق (`@score`={0,0,500x200})، إعدادات — تُحفظ مرة وتبقى
- **@names في أي أداة**: `tap at:"@jump"` · `tap at:"@jump+20,-10"` · `find_objects color:"@enemy"` · `read_number region:"@score"` · `auto_react color:"@note" region:"@hitline" tapX:"@lane1" stopColor:"@gameover"` · حتى داخل `points:[{at:"@a"}]` و`fallback:{at:"@x"}` — الـ AI ما بيكتب أرقامًا تاني؛ الاسم المجهول يرجّع قائمة الموجود
- **QUICK START (قسم 0 في الـ bootstrap)**: المحادثة الجديدة تشوف فورًا "الموبايل الآن في Space Runner — أنت تعرف هذه اللعبة: @jump @fire @enemy..." + ملاحظاتها + ماكروهاتها + أول أمر مقترح — بدون إعادة اكتشاف (قاعدة 0: ممنوع إعادة sample_colors/calibrate لأزرار معروفة)
- **سجل اللعب (5g)**: جلسات لكل لعبة (متى، كم دقيقة، كم أمر، كم فشل) — تلقائيًا من التطبيق المفتوح؛ `game_profile history=true`
- لوحة `/setup`: البروفايل (@names ملوّنة) وجلسات اللعب داخل كل لعبة مع حذف منفصل؛ التصدير/الاستيراد يشمل البروفايلات
- `phone.sh`: `tap @jump` · `tap @jump+20,-10` · `long @jump` · `rep @jump 5` · `objects @enemy` · `color @enemy` · `profile [set|unset|label|delete]` · `sessions`

**🧠 إدارة ذاكرة الـ AI لكل لعبة (v2.2)**
- قسم **"ذاكرة الـ AI"** في لوحة `/setup`: كل ما تعلّمه الـ AI مجمّع **لكل لعبة/تطبيق** (اسم اللعبة + package + آخر لعب): 📝 ملاحظات · ⏯️ ماكروهات · 🖼️ شاشات مسمّاة · ⏺ تسجيل جارٍ
- مسح بضغطة: **لعبة واحدة بكاملها** (لما اللعبة تتحدّث وملاحظاتها تبقى قديمة) · ملاحظة واحدة · ماكرو واحد · شاشة واحدة · أو كل الذاكرة. لا يمسّ الأجهزة أو التوكنات
- **تصدير / استيراد** JSON (نسخة احتياطية قبل المسح أو نقل لجهاز آخر)
- الماكروهات بقت موسومة باللعبة مثل الملاحظات؛ الريلاي يتذكر التطبيقات التي فتحها الـ AI (حتى بدون ملاحظات)
- للـ AI: `recall forget="app"` يمسح ملاحظات اللعبة الحالية لما المستخدم يقول "اللعبة اتحدّثت"؛ قسم 5e في الـ bootstrap يشرح النظافة؛ `./phone.sh memory | memory wipe <pkg> | memory export`
- API: `GET/DELETE /api/admin/devices/:id/memory` (`?kind=all|notes|macros|screens|recording|apps&app=&index=&name=`), `?format=export`, `POST .../memory/import`

**🔬 اكتشاف + حركة + أرقام + معايرة (v2.1)**
- 🎨 **`sample_colors`**: الألوان المسيطرة غير الرمادية على الشاشة (hex + نسبة + مركز) — الـ AI ما بيخمّنش قيم hex تاني؛ أول خطوة في أي لعبة جديدة
- 🎯 **`track_object`**: يعيّن مركز جسم N مرات ويحسب السرعة (px/s) والاتجاه و**الموقع المتوقع** بعد `predictMs` (least squares) — اضغط حيث سيكون العدو، لا حيث هو؛ يعمل كشرط في `game_loop` مع `$cx/$cy` = النقطة المتوقعة
- 🔢 **`read_number`**: قيمة رقمية من OCR (نقاط/عملات/مؤقّت/HP) — يفهم `1,250` · `12.5K` · `03:45` · `87%` · أرقام عربية؛ `label="score"` يختار السطر الصحيح
- ⏳ **`watch_value`**: انتظر حتى يتغير/يزيد/ينقص/يتجاوز الرقم حدًا — "هل حركتي سجّلت نقاط؟"، "المؤقّت وصل صفر؟"، "HP تحت 30؟" — بدل لقطات في حلقة
- 📏 **`calibrate`**: اضغط وقس `reactedMs` عبر screen_hash — يتحقق أن الزرار يستجيب فعلًا وكم يستغرق قبل الاعتماد عليه
- الـ `/monitor` يرسم مسار `track_object` ومواقع ألوان `sample_colors`

**🎓 تعلّم بالممارسة + ردود فعل متعددة المسارات + مراقبة مرئية (v2.0)**
- ⏺️ **`record_macro`**: `start=true name="open-level"` ثم الـ AI ينفّذ الخطوات عادي (tap, smart_tap, type_text, open_app...) ثم `start=false` → ماكرو جاهز للتكرار بـ `run_macro`. الفواصل الزمنية الحقيقية تُحفظ كـ `wait`؛ أدوات الملاحظة والاستدعاءات الداخلية لا تُسجّل
- 🎹 **`auto_react` متعدد المسارات**: حتى 6 `lanes` مستقلة في حلقة واحدة على الموبايل (لعبة إيقاع: مسار لكل عمود، كل مسار بلونه ومنطقته وزرّه وcooldown خاص)؛ المسار ممكن يعمل **swipe** بدل tap ("اقفز لما تشوف عائقًا أحمر")؛ `stopColor` يوقف الحلقة فور ظهور لون GAME OVER
- 👁️ **مراقبة بصرية في `/monitor`**: canvas فوق اللقطة يرسم ضغطات الـ AI (دوائر تتلاشى)، السوايبات، المسارات، صناديق الأجسام/الألوان المكتشفة، سطور OCR مع نصها، شارة `screenName` وشارة REC — تشوف بالضبط ما يراه الـ AI وما يفعله

**⚡ ردود فعل v2 + كشف أجسام + ذاكرة شاشات (v1.9)**
- 🧱 **`find_objects`**: كل جسم منفصل بنفس اللون (connected blobs) مع مركزه ومساحته وحدوده مرتبًا بالحجم — بدل مركز واحد متوسط من `find_color` بيقع غالبًا في فراغ بين الأعداء
- ⚡ **`auto_react`** (على الموبايل): الهاتف يراقب لونًا ويضغط لحظة ظهوره مرارًا بدون أي round-trip شبكة (~80ms بدل ~800ms) — whack-a-mole، ألعاب الإيقاع (منطقة رفيعة عند خط الضرب)، "اضغط لما يخضر"، التقاط الأشياء المتساقطة
- 🧠 **`label_screen` / `identify_screen`**: الـ AI يسمّي كل شاشة مرة واحدة (main-menu, playing, game-over, shop, ad) — بصمة إدراكية + كلمات OCR موسومة بالتطبيق؛ بعدها `observe` يرجّع `screenName` ويعرف "أنا فين" بثقة 0-1؛ تستخدم كشرط في `do_until`/`game_loop`
- قسم 5d في الـ bootstrap يعرض الشاشات المسمّاة للجلسات القادمة

**🧠 ذكاء مركّب (v1.8) — أقل استدعاءات، قرارات أذكى (Worker فقط، بدون تحديث التطبيق)**
- 👁️ **`observe`**: لقطة + OCR + التطبيق الحالي + بحث ألوان + ما الذي تغيّر — كلها **بالتوازي في طلب واحد** (تكلفة لقطة واحدة تقريبًا). هي الـ "look" الافتراضية للـ AI في الألعاب
- 🎯 **`smart_tap`**: اضغط "أي شيء" بالاسم: عنصر Accessibility → نص OCR → إحداثية بديلة، ويتحقق أن الشاشة تغيّرت بعد الضغط (`via`, `changed`)
- 🔁 **`do_until`**: كرّر فعلًا حتى تتحقق ملاحظة (اضغط Skip حتى يظهر PLAY، ارجع للخلف حتى يظهر لون...) — يفحص الشرط قبل كل محاولة
- 🧹 **`dismiss_popups`**: يغلق الإعلانات/الأذونات/طلبات التقييم/cookie banners (عربي + إنجليزي) عبر UI + OCR مع ترتيب ذكي للمرشحين
- 🕰️ **`recent_actions`**: سجل الـ AI نفسه (حتى من الجلسة السابقة) — لا يكرر محاولة فاشلة
- 🏷️ **ملاحظات موسومة باللعبة**: `remember` يوسم الملاحظة تلقائيًا بـ package التطبيق المفتوح؛ `recall app=current`؛ الـ bootstrap يعرضها مجمّعة لكل لعبة
- 📋 قاعدة بداية الجلسة في الـ bootstrap: `recall` + `history` + `look` ثم تصرّف

**🎮 Game Mode (v1.5 → v1.7) — للألعاب والتطبيقات بدون UI tree**
- 📐 **لقطات بشبكة إحداثيات** (`grid`) + **قص منطقة** بدقة كاملة (`region`) — الـ AI يقرأ الإحداثية الدقيقة من الصورة
- ⚡ **إدخال دقيق على الموبايل** (بدون jitter شبكة): `tap_sequence`, `repeat_tap` (auto-clicker بإيقاع ثابت), `swipe_path` (جويستيك/مسار), `multi_tap` (multi-touch)
- 👁️ **إدراك رخيص**: `get_pixels`, `find_color` (مركز + bbox), `screen_diff` (المناطق التي تغيّرت), `find_image` (template matching على الموبايل)
- 🪝 **ردود فعل (Reflexes)** — الموبايل ينتظر ويرد بدل الـ polling: `watch_color` (انتظر ظهور/اختفاء لون), `wait_pixel`, `wait_for_screen` (change|stable), `tap_color` (ابحث + اضغط في طلب واحد)
- 🔁 **`act_and_see`**: فعل + انتظار + لقطة في round-trip واحد · **`game_loop`**: السيرفر يشغّل حلقة إدراك→فعل كاملة (حتى 60 جولة) في طلب واحد مع حقن `$cx/$cy`
- 🧠 **ذاكرة عبر المحادثات**: `remember`/`recall` (ملاحظات لكل جهاز) + `save_macro`/`run_macro` (سلاسل قابلة للتكرار) — تظهر تلقائيًا في bootstrap المحادثة الجديدة
- 🔤 **OCR على الموبايل (v1.7)** بـ ML Kit (لاتيني/عربي/صيني/ياباني/كوري/ديفاناغاري): `read_text` (نص + إحداثيات كل سطر), `tap_text` (ابحث عن كلمة واضغطها), `wait_for_text` (انتظر ظهور نص مثل "PLAY" أو "Continue") — يقرأ النقاط/العدادات/الأزرار في الألعاب بدون UI tree
- 🎨 **`find_colors` (v1.7)**: عدة ألوان في مسح واحد · 📊 **`session_stats`**: عدد الأوامر/متوسط الزمن/الأخطاء للجلسة
- 📺 **بث حي (v1.7)**: `live_preview` يرسل إطارات JPEG مستمرة إلى صفحة `/monitor` — تشاهد الـ AI وهو يلعب لحظيًا
- 📖 **GAME PLAYBOOK** داخل bootstrap: متى يستخدم كل أداة + دليل قرار + دليل OCR
- Timeouts ديناميكية لكل أمر (سلاسل طويلة لا تنقطع، OCR حتى 25 ثانية)

**🎮 v4.0 — الرجوع للأصل: الـ AI هو اللاعب (بدون بوتات)**
- بعد تجربة v2.6→v3.4 (بوتات قواعد على الهاتف، AimEngine، HeadLock عبر Shizuku) قرّر المستخدم الرجوع للنموذج الأصلي: **الـ AI يتحكم ويلعب مباشرة** من أي محادثة. تمت إزالة كل ما يخص البوتات بالكامل: أدوات `game_bot`/`aim_engine`، قوالب البوتات، صفحة صانع البوتات `/builder`، تخزين `bots/aims` في الـ Durable Object، أوامر `bot_*`/`aim_*` في البروتوكول، ومن التطبيق: `BotEngine`، `AimEngine`، `BotOverlay` (الفقاعة)، أزرار الصوت، أزرار الإشعار ▶/■، Shizuku/`TouchProxyService`/AIDL. الإصدار Android **4.0.0** خفيف: اتصال + إمكانية الوصول + الأدوات فقط.
- **تطوير اللعب المباشر** — قسم جديد في الـ bootstrap **7a. HOW TO PLAY LIVE, FAST**: الاختناق هو عدد الرحلات لا التفكير؛ لا `capture_screen` منفردة أبدًا (كل فعل عبر `act_and_see`/`observe` في رحلة واحدة)، تفويض ردود الفعل للهاتف (`auto_react` ~80ms، `game_loop`، `do_until`، `wait_pixel`/`watch_color`/`wait_for_text` بلا polling)، `combo` واحد لكل اشتباك (حركة+تصويب+ضرب بأصابع منفصلة)، توقّع الحركة بـ `track_object`، معايرة مرة واحدة وحفظ في `game_profile`، وللشوترز: `auto_react` على لون الشعيرة الحمراء داخل `@reticle` = ضرب لحظة تأكيد اللعبة للهدف بلا طلقات كاذبة.
- 81 أداة. `phone.sh` بدون أوامر `bot`/`aim set`. الاختبارات: 12 suite (حُذفت suites البوتات v26–v33).

**طبقة الـ AI**
- MCP Server + مواصفات أدوات بـ 4 صيغ + endpoints لكل أداة + لقطة PNG مع معلومات المقياس
- `agent_runner.py`: حلقة AI مستقلة (رؤية → قرار → تنفيذ → تحقق) + سيناريوهات تكرارية + REPL

**التطبيق (Android)**
- شاشة إعدادات: رابط السيرفر، التوكن، Device ID، اتصال تلقائي بعد Reboot
- Foreground Service يحافظ على الاتصال + إشعار دائم مع زر "قطع الاتصال"
- AccessibilityService رسمي ينفذ: إيماءات (`tap`, `double_tap`, `long_press`, `swipe`), أزرار النظام، `screenshot`, `wake`
- **v1.2**: قراءة شجرة الواجهة (`ui_dump`), الضغط على عنصر بالاسم/الـ id (`tap_element`), كتابة نص (`type_text`), فتح تطبيق/رابط (`open_app`, `open_url`), قائمة التطبيقات
- **v1.4**: `drag` (سحب وإفلات), `pinch` (تكبير/تصغير بإصبعين), `scroll_element` (تمرير عنصر محدد عبر Accessibility), `set_clipboard` (+لصق), `get_notifications` (قراءة الإشعارات — يتطلب تفعيل "Notification access" من التطبيق), `get_device_info` (بطارية/شبكة/قفل/تخزين), لقطات بجودة/حجم متغير (PNG/JPEG), بطارية في `hello` كل 60 ثانية
- **v4.0**: إزالة BotEngine/AimEngine/BotOverlay/Shizuku — التطبيق يعود لدوره الأصلي: تنفيذ أدوات الـ AI بدقة
- **v2.5**: محرك لمس متعدد — أصابع دائمة بـ `continueStroke` (`finger_down/move/up`)، `joystick` (يبقي العصا حية بمقاطع متواصلة)، `aim`، `fire_burst`، `combo`
- **v2.1**: `sample_colors` (تكميم ألوان + تجاهل الرمادي)، `track_object` (عيّنات + انحدار خطي للسرعة)
- **v2.0**: `auto_react` بمسارات متعددة (cooldown لكل مسار)، ردود فعل swipe، `stopColor`
- **v1.9**: `find_objects` (connected-component labelling على شبكة مخفّضة)، `auto_react` (حلقة مراقبة→ضغط محلية حتى 40 ثانية / 200 ضغطة بـ cooldown)
- **v1.5–v1.7**: كل أدوات Game Mode تُنفَّذ على الجهاز (توقيت دقيق بدون شبكة)، ML Kit OCR محلي (بدون إنترنت)، بث إطارات JPEG (`stream`) يتوقف تلقائيًا عند غياب المشاهدين
- سجل مباشر داخل التطبيق لكل أمر وزمن تنفيذه

## دليل الاستخدام (خطوة بخطوة)

### 1) افتح لوحة الإعداد
```
https://device-relay.cracknew37.workers.dev/setup/<ADMIN_TOKEN>
```
كل شيء من هنا: ربط الموبايل، برومبت المحادثة الجديدة، المراقبة، التوكنات. التوكن الرئيسي (`RELAY_TOKEN`) Secret على الـ Worker؛ لتغييره: `openssl rand -hex 24 | npx wrangler secret put RELAY_TOKEN` — أو أنشئ Admin بديل من اللوحة.

### 2) ربط الهاتف
1. من **Releases** ثبّت `DeviceRelay.apk`.
2. من لوحة الإعداد انسخ **رابط ربط الموبايل** (أو امسح QR) وافتحه على الهاتف → التطبيق يفتح ويملأ الإعدادات ويتصل.
3. فعّل **خدمة إمكانية الوصول** و(اختياريًا) **قراءة الإشعارات** من داخل التطبيق.
4. (اختياري) اجعل التطبيق "غير مقيّد" في إعدادات البطارية.

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
بعدها النموذج يرى **79 أداة** مباشرة:
- مراقبة: `get_ui_elements` (شجرة الواجهة: نص/id/إحداثيات — الأدق), `capture_screen(maxWidth?, format?, quality?)`, `get_current_app`, `get_device_status`, `get_device_info`, `get_notifications`
- عناصر: `tap_element(text|elementId)`, `type_text(text, submit)`, `set_clipboard(text, paste)`, `wait_for_element`, `find_and_tap`, `scroll_element`
- تطبيقات: `open_app`, `open_url`, `list_apps`
- إيماءات: `tap`, `double_tap`, `long_press`, `swipe`, `drag`, `pinch`, `scroll`
- نظام: `press_back`, `press_home`, `open_recents`, `open_notifications`, `open_quick_settings`, `lock_screen`, `wake_screen`, `wait`
- تركيبية: **`batch(steps[], continueOnError)`** — عدة أدوات في طلب واحد
- 🎮 ألعاب/دقة: `act_and_see`, `tap_sequence`, `multi_tap`, `swipe_path`, `repeat_tap`, `get_pixels`, `find_color`, `tap_color`, `find_image`, `screen_diff`, `watch_color`, `wait_pixel`, `wait_for_screen`, `game_loop`
- 🧠 ذاكرة: `remember`, `recall`, `save_macro`, `run_macro`, `list_macros`
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
| GET/POST/DELETE | `/api/devices/:id/notes` | ذاكرة الجهاز (ملاحظات الـ AI) |
| GET | `/setup/:adminToken` | لوحة الإعداد للمالك |
| GET | `/pair?server=&token=&device=` | صفحة ربط الهاتف (deep link) |
| GET | `/api/admin/overview` | أجهزة + توكنات + حالة (admin) |
| POST | `/api/admin/tokens` | إنشاء توكن `{deviceId, label?, readOnly?}` أو `{admin:true, label?}` (admin) |
| GET / DELETE | `/api/admin/tokens[/:id]` | قائمة / إلغاء توكنات (admin) |
| POST | `/api/admin/devices/:id/label` · `/clear-logs` · `/disconnect` | إدارة جهاز (admin) |
| POST | `/api/devices/:id/command` | أمر واحد `{ "action": {...}, "wait": true }` |
| POST | `/api/devices/:id/macro` | سلسلة `{ "steps": [ ... ], "continueOnError": false }` (حتى 50 خطوة) |
| GET | `/api/tools/schema?format=` | مواصفات الأدوات (عام) |
| POST | `/api/devices/:id/tools/call` | تنفيذ أداة AI بالاسم |
| POST | `/api/devices/:id/tools/:tool` | endpoint لكل أداة |
| GET | `/api/devices/:id/screenshot.png` · `.jpg` | لقطة خام (`?maxWidth=&format=&quality=&grid=100&region=x,y,w,h`) |
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
// v1.5 / v1.6 (games)
{"type":"screenshot","maxWidth":1080,"grid":100,"region":{"x":0,"y":1400,"w":1080,"h":600}}
{"type":"tap_sequence","points":[{"x":540,"y":900,"delayMs":0},{"x":540,"y":1200,"delayMs":120,"durationMs":60}]}
{"type":"repeat_tap","x":950,"y":2100,"count":20,"intervalMs":80}
{"type":"swipe_path","points":[{"x":200,"y":1800},{"x":500,"y":1500},{"x":800,"y":1800}],"duration":600}
{"type":"multi_tap","points":[{"x":200,"y":2100},{"x":900,"y":2100}],"duration":80}
{"type":"pixel","points":[{"x":120,"y":180}]}   {"type":"find_color","color":"#ff2020","tolerance":30}
{"type":"watch_color","color":"#00e676","appear":true,"timeoutMs":8000}   {"type":"wait_pixel","x":980,"y":2150,"color":"#ffffff"}
{"type":"screen_diff"}   {"type":"find_image","image":"<base64>","threshold":0.85}
// v1.7 (OCR + multi-color + stream)
{"type":"read_text","lang":"latin","region":{"x":0,"y":0,"w":1080,"h":300}}
{"type":"find_colors","colors":["#ff2020","#00e676"],"tolerance":30}
{"type":"stream","enabled":true,"fps":2,"maxWidth":480,"quality":50}
// v1.9 (objects + phone-side reflex)
{"type":"find_objects","color":"#ff2020","tolerance":24,"minSize":12,"maxResults":10}
{"type":"auto_react","color":"#00e676","region":{"x":0,"y":1900,"w":1080,"h":60},"maxTriggers":30,"timeoutMs":15000,"cooldownMs":200}
// v2.0 (multi-lane rhythm game + jump-on-red + stop on game over)
{"type":"auto_react","color":"#00e676","region":{"x":0,"y":1900,"w":270,"h":60},"tapX":135,"tapY":2200,
  "lanes":[{"color":"#00e676","region":{"x":270,"y":1900,"w":270,"h":60},"tapX":405,"tapY":2200},
           {"color":"#ff1744","region":{"x":400,"y":1200,"w":280,"h":400},"swipe":{"dx":0,"dy":-600}}],
  "stopColor":"#212121","stopRegion":{"x":0,"y":0,"w":1080,"h":300},"maxTriggers":120,"timeoutMs":40000}
// v2.5 shooter (fingers stay down across calls)
{"type":"joystick","x":250,"y":1900,"angle":270,"distance":200,"duration":2000,"finger":0,"release":false}
{"type":"aim","x":800,"y":1200,"dx":60,"dy":-10,"duration":120,"finger":1,"steps":4,"release":true}
{"type":"fire_burst","x":950,"y":1700,"count":6,"intervalMs":80,"holdMs":0}
{"type":"combo","combo":[{"op":"joystick","x":250,"y":1900,"angle":315,"duration":400,"release":false},{"op":"aim","x":800,"y":1200,"dx":60},{"op":"fire","x":950,"y":1700,"count":5},{"op":"up","finger":-1}]}
// v2.1
{"type":"sample_colors","maxColors":8,"quant":32}
{"type":"track_object","color":"#ff2020","samples":5,"intervalMs":120,"predictMs":300}
```
> `phone.sh` يغلّف كل ذلك: `see tap X Y` · `seq` · `rep` · `path` · `mtap` · `px` · `color` · `tapcolor` · `watch` · `waitpx` · `diff` · `findimg` · `loop` · `remember/recall` · `macros/macro/savemacro` · `ocr/taptext/waittext` · `colors` · `stats` · `live` · **v1.8:** `look [grid] [colors]` · `press "Skip" [x y]` · `popups` · `until <action> <observation>` · `history` · **v1.9:** `objects '#rrggbb'` · `react '#rrggbb' [region] [n] [ms]` · `label "name"` · `which` · `screens` · **v2.0:** `rec start <name>` / `rec stop` / `rec status` / `rec cancel` · `react2 '<json>'` · **v2.1:** `palette` · `track '#rrggbb'` · `num [region] [label]` · `watchnum <cond> [value]` · `calib X Y`.
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
├── tests/e2e-v15.sh     # 40 اختبار: أدوات الألعاب (sequence/pixels/find_color/act_and_see/memory)
├── tests/e2e-v16.sh     # 44 اختبار: reflexes / game_loop / macros
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
tests/e2e.sh && tests/e2e-v15.sh && tests/e2e-v16.sh && tests/e2e-v17.sh && tests/e2e-v18.sh && tests/e2e-v19.sh && tests/e2e-v20.sh && tests/e2e-v21.sh && tests/e2e-v22.sh && tests/e2e-v23.sh && tests/e2e-v24.sh && tests/e2e-v25.sh   # ~800 checks green  (or: tests/run-all.sh)
```

## Data Architecture
- **Durable Object `DeviceRoom`** (واحد لكل deviceId): حالة الجهاز + آخر 100 أمر + اتصالات WebSocket (Hibernation).
- **Durable Object `DeviceRegistry`** (singleton): قائمة الأجهزة + توكنات per-device (SHA-256) + labels.
- `DeviceRoom` يحتفظ أيضًا بآخر لقطة في الذاكرة وطابور أوامر الإدخال، و**notes** (حتى 40) و**macros** (حتى 30) دائمة لكل جهاز.
- لا توجد قاعدة بيانات خارجية؛ التخزين داخل Durable Objects (SQLite-backed).

## استكشاف الأخطاء: `403 error code: 1010` من الـ AI
هذا ليس خطأ توكن: Cloudflare (Browser Integrity Check على مستوى الحافة) يرفض الطلبات التي يكون `User-Agent` فيها `Python-urllib/*` أو `libwww-perl/*` قبل أن تصل للسيرفر. صفحة `/agent` تُفتح (المتصفح/curl) لكن `POST /api/.../tools/call` من بيئة تنفيذ الـ AI (urllib) يرجع 403 بصفحة HTML فيها "error code: 1010".
- الحل من جهة العميل: أرسل `User-Agent` مخصّصًا (مثلًا `device-relay-agent/1.0`) — `phone.sh` و`agent_runner.py` يفعلان ذلك تلقائيًا من v2.7، والـ bootstrap يشرحها للـ AI في القسم 1.
- الحل الدائم من جهة السيرفر (يدوي، مرة واحدة): Cloudflare Dashboard → **Security → Settings → Browser Integrity Check → Off** (أو قاعدة WAF: `http.host eq "device-relay.<acct>.workers.dev" → Skip`). الـ Worker لا يستطيع تعطيلها من الكود.
- للتمييز: 403 بجسم JSON `{"error":...}` = من السيرفر (توكن/نطاق)؛ 403 HTML مع 1010 = حجب الـ UA.

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
- **Last Updated**: 2026-09-09 (v4.1 — AI-direct play upgrade: `play` (act+wait+see), `react_script` on-device reflex engine with tap_found/aim_found, `play_frame`; profile-aware defaults; 81 tools; Android 4.1.0; new Cloudflare account secrets applied)

> ⚠️ **أمان**: التوكنات التي أُرسلت في المحادثة يجب تدويرها (Regenerate) بعد الانتهاء. لا يوجد أي توكن مخزّن داخل الكود.
