/* Device Relay — visual Bot Builder (v2.9). No AI needed: pick a game type, tap things on a screenshot, save.
 * Talks to the same tools API the AI uses: capture_screen, find_objects, get_pixels, game_profile, game_bot(template). */
(() => {
  const $ = (s) => document.querySelector(s)
  const token = location.pathname.split('/').pop()
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Requested-With': 'builder' }
  let device = ''
  let shot = null            // { w, h, scale } of the screenshot vs the real screen
  let typeId = 'color_tap'
  let picking = null         // key of the thing being placed
  let preset = null          // 'freefire' one-tap preset
  const PRESETS = { freefire: { mode: 'assist', match: 'hue', tolerance: 24, assistRange: 360, sensitivity: 0.85, predictMs: 90, fireCount: 5, fireIntervalMs: 65, lockRadius: 240, gateErr: 50, minSize: 6, headOffsetY: 0, name: 'freefire-headshot' } }
  function applyPreset() { const p = PRESETS[preset]; if (!p) return; for (const [k, v] of Object.entries(p)) { const el = document.querySelector(`[data-tune="${k}"]`); if (el) { el.value = v; const tv = $('#tv-' + k); if (tv) tv.textContent = v } } $('#bot-name').value = p.name }
  const marks = {}           // key → { kind, x, y, w, h, hex, tol, ok, count }
  let botStatusTimer = null
  let profileApp = ''

  // ---------------------------------------------------------------- catalogue: what each game type needs (mirrors the server templates)
  const TYPES = {
    color_tap: {
      icon: 'fa-bullseye', title: 'الأبسط: شفت اللون ده → اضرب',
      doc: 'قاعدة واحدة لأي لعبة: حدّد لونًا (مثلًا الأحمر) وكل ما يظهر شيء بهذا اللون البوت يضغط عليه — أو يضغط زرًا معيّنًا (مثل زر الضرب) طول ما اللون ظاهر.',
      things: [
        { key: 'color', kind: 'color', label: 'اللون المستهدف', req: true, hint: 'اضغط على الشيء اللي عايز البوت يتفاعل معاه' },
        { key: 'button', kind: 'control', label: 'زر يضغطه بدل الضغط على اللون نفسه (اختياري)' },
        { key: 'region', kind: 'region', label: 'منطقة المراقبة (اختياري)' },
      ],
      tune: [
        { key: 'match', label: 'طريقة مطابقة اللون', options: ['rgb', 'hue'], labels: { rgb: 'RGB دقيق — للأزرار والألعاب 2D', hue: 'درجة اللون (Hue) — للألعاب 3D والإضاءة المتغيرة' }, def: 'rgb' },
        { key: 'tolerance', label: 'تسامح اللون', min: 8, max: 70, step: 2, def: 32, doc: 'زوّده لو مش بيتكشف، قلّله لو بيضرب حاجات غلط (في Hue: 22 مناسب)' },
        { key: 'minSize', label: 'أصغر حجم (px)', min: 4, max: 100, step: 2, def: 12 },
        { key: 'cooldownMs', label: 'الفاصل بين الضربات (ms)', min: 0, max: 1000, step: 20, def: 120 },
        { key: 'repeat', label: 'ضغطات لكل مرة', min: 1, max: 10, step: 1, def: 1 },
      ],
    },
    shooter: {
      icon: 'fa-crosshairs', title: 'شوتر (Free Fire / PUBG / CoD) — هيدشوت',
      doc: 'الوضع الافتراضي "مساعد": أنت تلعب وتلف الكاميرا عادي، ولما لون الرأس يقرب من التصويب البوت يزقّ التصويب على الراس ويضرب رشقة — ثم يسيبك تكمّل. "زناد": أنت تصوّب وهو يضرب فقط لما الراس تحت التصويب. "كامل": يلعب لوحده (يصوّب، يضرب، يلف الكاميرا، يتقدّم، يعالج).',
      things: [
        { key: 'head', kind: 'color', label: 'لون رأس العدو ★ (الأهم)', req: true, hint: 'اضغط على رأس العدو / علامة الرأس. الأفضل: فعّل "تحديد العدو" بلون صارخ من إعدادات اللعبة واضغط عليه' },
        { key: 'fire', kind: 'control', label: 'زر الضرب', req: true },
        { key: 'look', kind: 'control', label: 'مساحة التصويب (مكان فاضي في النص الأيمن)', req: true },
        { key: 'crosshair', kind: 'control', label: 'نقطة التصويب (الافتراضي: منتصف الشاشة)' },
        { key: 'enemy', kind: 'color', label: 'لون جسم العدو (اختياري — للوضع الكامل)' },
        { key: 'stick', kind: 'control', label: 'عصا الحركة (للوضع الكامل)' },
        { key: 'hp', kind: 'region', label: 'منطقة رقم الصحة (اسحب مستطيل)' },
        { key: 'heal', kind: 'control', label: 'زر العلاج' },
        { key: 'evade', kind: 'control', label: 'زر القرفصة/القفز (الوضع الكامل)' },
        { key: 'playAgain', kind: 'control', label: 'زر PLAY AGAIN (الوضع الكامل)' },
      ],
      tune: [
        { key: 'mode', label: 'الوضع', options: ['assist', 'trigger', 'full'], labels: { assist: 'مساعد — أنا ألعب وهو يزقّ التصويب على الراس ويضرب', trigger: 'زناد — أنا أصوّب وهو يضرب لما الراس تحت التصويب', full: 'كامل — يلعب لوحده' }, def: 'assist' },
        { key: 'assistRange', label: 'مدى المساعدة (px من التصويب)', min: 80, max: 700, step: 20, def: 320, doc: 'أنت تقرّب التصويب من العدو، والبوت يكمّل لو الراس في هذا المدى. أكبر = يتدخل من بعيد.' },
        { key: 'sensitivity', label: 'حساسية التصويب', min: 0.3, max: 2, step: 0.1, def: 0.9, doc: 'تتعلّم لوحدها أثناء اللعب' },
        { key: 'predictMs', label: 'توقّع الحركة (ms)', min: 0, max: 300, step: 20, def: 80, doc: 'يصوّب على مكان الراس بعد هذه المدة (للأعداء اللي بتجري)' },
        { key: 'fireCount', label: 'طلقات في الرشقة', min: 2, max: 15, step: 1, def: 6 },
        { key: 'fireIntervalMs', label: 'الفاصل بين الطلقات (ms)', min: 40, max: 200, step: 10, def: 70 },
        { key: 'match', label: 'طريقة مطابقة اللون', options: ['hue', 'rgb'], labels: { hue: 'درجة اللون (Hue) — يتحمّل الظل والإضاءة ★ للألعاب 3D', rgb: 'RGB دقيق — للأزرار والواجهات' }, def: 'hue' },
        { key: 'tolerance', label: 'تسامح اللون (درجات في Hue / قناة في RGB)', min: 8, max: 70, step: 2, def: 32, doc: 'في وضع Hue: 22 مناسب، 30 لو الإضاءة متغيرة كثير' },
        { key: 'lockRadius', label: 'تثبيت الهدف (px)', min: 0, max: 500, step: 20, def: 220, doc: 'يفضل على نفس العدو بدل ما ينط بين عدوين' },
        { key: 'gateErr', label: 'لا يضرب وهو لسه بيصحّح أكثر من (px)', min: 0, max: 200, step: 10, def: 60, doc: 'يوفّر الذخيرة ويزوّد الدقة. 0 = يضرب دائمًا' },
        { key: 'headOffsetY', label: 'ارفع نقطة الضرب عن مركز اللون (px، سالب = أعلى)', min: -80, max: 40, step: 5, def: 0, doc: 'لو اللون بيغطي الجسم كله: -25 تقريبًا يخلي الضربة على الراس' },
        { key: 'sweepDx', label: 'لفّة الكاميرا لما مافيش عدو (الوضع الكامل)', min: 80, max: 500, step: 20, def: 260 },
        { key: 'minSize', label: 'أصغر حجم عدو (px)', min: 4, max: 60, step: 2, def: 10 },
        { key: 'hpLow', label: 'يعالج لما الصحة أقل من', min: 5, max: 80, step: 5, def: 30 },
      ],
    },
    clicker: {
      icon: 'fa-hand-pointer', title: 'اضغط على كل حاجة بلون معيّن', doc: 'Whack-a-mole، فقّع البالونات، جمع العملات، أي لعبة "شفت اللون → اضغط عليه". يضغط كل الأجسام الظاهرة كل لحظة.',
      things: [
        { key: 'target', kind: 'color', label: 'اللون المستهدف', req: true, hint: 'اضغط على الشيء اللي عايز البوت يضرب عليه' },
        { key: 'region', kind: 'region', label: 'منطقة اللعب (اختياري — لاستبعاد الواجهة)' },
      ],
      tune: [
        { key: 'minSize', label: 'أصغر حجم (px)', min: 6, max: 120, step: 2, def: 18 },
        { key: 'maxSize', label: 'أكبر حجم (px، 0 = أي)', min: 0, max: 600, step: 10, def: 0 },
        { key: 'max', label: 'ضغطات لكل لحظة', min: 1, max: 12, step: 1, def: 6 },
        { key: 'tolerance', label: 'تسامح اللون', min: 10, max: 70, step: 2, def: 30 },
      ],
    },
    runner: {
      icon: 'fa-person-running', title: 'راننر (Subway Surfers …)', doc: 'لون العقبة يظهر في المسار قدّام اللاعب → قفزة/سحب. اختياري: يتجه للعملات.',
      things: [
        { key: 'obstacle', kind: 'color', label: 'لون العقبة', req: true },
        { key: 'lane', kind: 'region', label: 'المسار قدّام اللاعب (اسحب مستطيل)', req: true },
        { key: 'swipeFrom', kind: 'control', label: 'مكان اللاعب (بداية السحب)', req: true },
        { key: 'jump', kind: 'control', label: 'زر القفز (لو موجود بدل السحب)' },
        { key: 'coin', kind: 'color', label: 'لون العملات (اختياري)' },
        { key: 'leftLane', kind: 'region', label: 'المسار الأيسر (للعملات)' },
        { key: 'rightLane', kind: 'region', label: 'المسار الأيمن (للعملات)' },
      ],
      tune: [
        { key: 'reaction', label: 'اتجاه السحب للتفادي', options: ['up', 'down', 'left', 'right'], def: 'up' },
        { key: 'minCount', label: 'حساسية الكشف (بكسلات)', min: 10, max: 200, step: 10, def: 40 },
      ],
    },
    rhythm: {
      icon: 'fa-music', title: 'إيقاع / Piano Tiles', doc: 'لكل مسار: لما لون النوتة يدخل منطقة الضرب → اضغط.',
      things: [
        { key: 'note', kind: 'color', label: 'لون النوتة/البلاطة', req: true },
        { key: 'lane1', kind: 'region', label: 'منطقة الضرب — مسار 1', req: true },
        { key: 'lane2', kind: 'region', label: 'منطقة الضرب — مسار 2' },
        { key: 'lane3', kind: 'region', label: 'منطقة الضرب — مسار 3' },
        { key: 'lane4', kind: 'region', label: 'منطقة الضرب — مسار 4' },
      ],
      tune: [
        { key: 'minCount', label: 'حساسية الكشف', min: 5, max: 150, step: 5, def: 25 },
        { key: 'hold', label: 'مدة الضغط (0 = نقرة)', min: 0, max: 800, step: 50, def: 0 },
      ],
    },
    idle_tapper: {
      icon: 'fa-coins', title: 'Idle / Clicker', doc: 'يضغط باستمرار على مكان، ويلقط أي مكافأة بلون معيّن.',
      things: [
        { key: 'tap', kind: 'control', label: 'مكان الضغط المستمر', req: true },
        { key: 'bonus', kind: 'color', label: 'لون المكافأة/الصندوق (اختياري)' },
      ],
      tune: [
        { key: 'taps', label: 'ضغطات لكل دورة', min: 1, max: 20, step: 1, def: 8 },
        { key: 'intervalMs', label: 'الفاصل (ms)', min: 30, max: 300, step: 10, def: 60 },
      ],
    },
    fishing: {
      icon: 'fa-fish', title: 'صيد / توقيت', doc: 'لما المؤشر يدخل المنطقة المثالية → اضغط.',
      things: [
        { key: 'indicator', kind: 'color', label: 'لون المؤشر المتحرك', req: true },
        { key: 'zone', kind: 'region', label: 'المنطقة المثالية', req: true },
        { key: 'button', kind: 'control', label: 'زر الفعل', req: true },
      ],
      tune: [{ key: 'castAfterMs', label: 'يرمي لو مافيش حركة بعد (ms)', min: 1000, max: 15000, step: 500, def: 4000 }],
    },
    racing: {
      icon: 'fa-car', title: 'سباقات', doc: 'يبعد عن لون الحافة/الحيطة، يضغط البنزين، ونيترو في المستقيم.',
      things: [
        { key: 'edge', kind: 'color', label: 'لون الحافة/الحيطة/الخصم', req: true },
        { key: 'left', kind: 'control', label: 'زر شمال', req: true },
        { key: 'right', kind: 'control', label: 'زر يمين', req: true },
        { key: 'aheadLeft', kind: 'region', label: 'نص الطريق الأيسر قدّام', req: true },
        { key: 'aheadRight', kind: 'region', label: 'نص الطريق الأيمن قدّام', req: true },
        { key: 'gas', kind: 'control', label: 'زر البنزين (اختياري)' },
        { key: 'nitro', kind: 'control', label: 'زر النيترو (اختياري)' },
      ],
      tune: [{ key: 'steerMs', label: 'مدة الضغط على الاتجاه (ms)', min: 60, max: 500, step: 20, def: 180 }],
    },
    puzzle_match: {
      icon: 'fa-puzzle-piece', title: 'Match-3 / تلميح', doc: 'ينتظر لون التلميح (اللمعة) ويضغطه، ولو مافيش يضغط زر التلميح.',
      things: [
        { key: 'hint', kind: 'color', label: 'لون التلميح/اللمعة', req: true },
        { key: 'board', kind: 'region', label: 'منطقة اللوح' },
        { key: 'hintButton', kind: 'control', label: 'زر التلميح' },
      ],
      tune: [{ key: 'swipe', label: 'لو اللعبة تحتاج سحب على التلميح', options: ['', 'up', 'down', 'left', 'right'], def: '' }],
    },
  }
  const COMMON_THINGS = [
    { key: 'close', kind: 'color', label: '❌ لون زر إغلاق الإعلانات/النوافذ (اختياري)', common: true },
  ]

  // ---------------------------------------------------------------- api
  async function api(path, body) {
    const r = await fetch(path, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H })
    return r.json().catch(() => ({ ok: false, error: 'bad json ' + r.status }))
  }
  const tool = (name, args) => api(`/api/devices/${encodeURIComponent(device)}/tools/call`, { name, arguments: args || {} })
  const toast = (msg, cls) => { const el = $('#status'); const d = document.createElement('div'); d.className = cls || ''; d.textContent = msg; el.prepend(d); while (el.children.length > 6) el.lastChild.remove() }

  // ---------------------------------------------------------------- devices
  async function loadDevices() {
    const r = await api('/api/devices')
    const sel = $('#dev'); sel.innerHTML = ''
    for (const d of r.devices || []) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = `${d.label || d.deviceId}${d.online ? ' ●' : ' ○'}`; sel.appendChild(o) }
    const on = (r.devices || []).find((d) => d.online) || (r.devices || [])[0]
    if (on) { device = on.deviceId; sel.value = device }
    $('#dev-state').textContent = on ? (on.online ? 'متصل' : 'غير متصل — افتح التطبيق') : 'لا يوجد جهاز'
    $('#dev-state').className = 'tag ' + (on && on.online ? 'ok' : 'bad')
    const me = await api('/api/me'); if (me.setupUrl) $('#setup-link').href = me.setupUrl; else $('#setup-link').classList.add('hidden')
  }
  $('#dev').onchange = (e) => { device = e.target.value }

  // ---------------------------------------------------------------- type picker
  function renderTypes() {
    const el = $('#types'); el.innerHTML = ''
    // one-tap preset: Free Fire assist headshot
    const ff = document.createElement('div'); ff.className = 'pick' + (typeId === 'shooter' && preset === 'freefire' ? ' on' : '')
    ff.style.borderColor = typeId === 'shooter' && preset === 'freefire' ? '#34d399' : '#f59e0b55'
    ff.innerHTML = '<div class="font-semibold"><i class="fas fa-fire ml-1 text-amber-300"></i>🔥 Free Fire — هيدشوت مساعد (جاهز)</div><div class="text-[11px] text-slate-400 mt-1">إعدادات مضبوطة مسبقًا: مساعد + Hue + تثبيت هدف + توقّع حركة. أنت بس تعلّم لون الراس وزر الضرب ومساحة التصويب.</div>'
    ff.onclick = () => { typeId = 'shooter'; preset = 'freefire'; renderTypes(); renderThings(); renderTune(); applyPreset(); updateSave() }
    el.appendChild(ff)
    for (const [id, t] of Object.entries(TYPES)) {
      const d = document.createElement('div'); d.className = 'pick' + (id === typeId ? ' on' : '')
      d.innerHTML = `<div class="font-semibold"><i class="fas ${t.icon} ml-1 text-emerald-300"></i>${t.title}</div>`
      d.onclick = () => { typeId = id; preset = null; renderTypes(); renderThings(); renderTune(); updateSave() }
      el.appendChild(d)
    }
    $('#type-doc').textContent = TYPES[typeId].doc
    if (!$('#bot-name').value || /-bot$/.test($('#bot-name').value)) $('#bot-name').value = typeId.replace('_', '-') + '-bot'
  }

  // ---------------------------------------------------------------- things list
  function things() { return [...TYPES[typeId].things, ...COMMON_THINGS] }
  function renderThings() {
    const el = $('#things'); el.innerHTML = ''
    for (const t of things()) {
      const m = marks[t.key]
      const d = document.createElement('div'); d.className = 'thing' + (picking === t.key ? ' on' : '')
      const icon = t.kind === 'color' ? (m ? `<span class="sw" style="background:${m.hex}"></span>` : '<span class="sw" style="background:repeating-conic-gradient(#334155 0 25%,#0f172a 0 50%) 0 0/8px 8px"></span>') : t.kind === 'region' ? '<span class="sw" style="border-style:dashed;border-color:#fbbf24"></span>' : '<span class="sw" style="background:#38bdf8"></span>'
      const state = m ? (t.kind === 'color' ? `<span class="${m.ok ? 'ok' : 'warn'} text-xs">${m.hex} · ${m.ok ? m.count + ' جسم ✓' : 'لم يُكتشف — جرّب نقطة أوضح'}</span>` : t.kind === 'region' ? `<span class="text-xs text-slate-400 mono ltr">${m.x},${m.y} ${m.w}×${m.h}</span>` : `<span class="text-xs text-slate-400 mono ltr">${m.x},${m.y}</span>`) : `<span class="text-xs text-slate-500">${t.req ? 'مطلوب' : 'اختياري'}</span>`
      d.innerHTML = `${icon}<div class="flex-1 min-w-0"><div class="text-sm">${t.label}${t.req ? ' <span class="text-rose-300">*</span>' : ''}</div>${state}</div>${m ? '<button class="btn btn-s !py-0.5 !px-2" title="إزالة" data-rm="' + t.key + '"><i class="fas fa-xmark"></i></button>' : ''}`
      d.onclick = (e) => { if (e.target.closest('[data-rm]')) { delete marks[t.key]; drawMarks(); renderThings(); updateSave(); return } picking = t.key; renderThings(); $('#shot-hint').textContent = t.hint || (t.kind === 'region' ? 'اسحب مستطيلًا على الصورة حول: ' + t.label : t.kind === 'color' ? 'اضغط على الشيء نفسه في الصورة: ' + t.label : 'اضغط على مكان: ' + t.label) }
      el.appendChild(d)
    }
  }

  // ---------------------------------------------------------------- screenshot + marks
  $('#shot-btn').onclick = async () => {
    if (!device) return toast('لا يوجد جهاز', 'bad')
    $('#shot-btn').disabled = true; $('#shot-btn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ التصوير…'
    const r = await tool('capture_screen', { maxWidth: 1080, format: 'jpeg', quality: 85 })
    $('#shot-btn').disabled = false; $('#shot-btn').innerHTML = '<i class="fas fa-camera"></i> صوّر الشاشة'
    if (!r.ok || !r.image) return toast('فشل التصوير: ' + (r.error || '?'), 'bad')
    shot = { w: r.image.w, h: r.image.h, scale: r.image.scale || 1, screen: r.screen }
    const im = $('#shot')
    im.onload = () => {
      // robust scale: decoded image width vs the phone's real screen width (server-side size parsing can fail on some encoders)
      const sw = (r.screen && r.screen.w) || (shot.screen && shot.screen.w)
      if (im.naturalWidth && sw) shot.scale = im.naturalWidth / sw
      shot.w = im.naturalWidth; shot.h = im.naturalHeight
      drawMarks()
    }
    im.src = `data:${r.image.mime};base64,${r.image.base64}`
    $('#suggest-btn').disabled = false
    const app = await tool('get_current_app'); if (app.ok && app.data && app.data.package) { profileApp = app.data.package; toast('اللعبة الحالية: ' + (app.data.label || app.data.package), 'ok') }
    drawMarks()
  }
  // v3.2 auto-suggest: dominant saturated colours → verify each as objects → rank by (few, mid-sized, saturated) → user picks with one tap
  $('#suggest-btn').onclick = async () => {
    if (!shot) return
    const target = things().find((t) => t.kind === 'color' && t.req) || things().find((t) => t.kind === 'color'); if (!target) return
    $('#suggest-btn').disabled = true; $('#probe').innerHTML = '<i class="fas fa-spinner fa-spin"></i> نحلّل ألوان الشاشة…'
    const sc = await tool('sample_colors', { maxColors: 10, quant: 24, ignoreGrey: true })
    const cands = (sc.ok && sc.data && sc.data.colors) || []
    const mode = tuneVal('match', 'rgb') === 'hue' ? 'hue' : 'rgb'; const tol = mode === 'hue' ? 22 : 30
    const scored = []
    for (const c of cands.slice(0, 8)) {
      const fo = await tool('find_objects', { color: c.hex, tolerance: tol, minSize: 6, maxResults: 12, match: mode })
      const objs = (fo.ok && fo.data && fo.data.objects) || []
      if (!objs.length) continue
      const v = parseInt(c.hex.slice(1), 16); const r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255; const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b))
      const mid = objs.filter((o) => o.bounds && o.bounds.w >= 8 && o.bounds.w <= 220 && o.bounds.h >= 8 && o.bounds.h <= 260).length
      // good enemy colours: saturated, few objects (1-6), small share of the screen
      const score = sat * 3 + (objs.length >= 1 && objs.length <= 6 ? 2 : 0) + (mid / Math.max(1, objs.length)) * 2 - Math.min(2, (c.share || 0) / 8)
      scored.push({ hex: c.hex, count: objs.length, share: c.share, sat, objects: objs, score, cx: objs[0].cx, cy: objs[0].cy })
    }
    scored.sort((a, b) => b.score - a.score)
    $('#suggest-btn').disabled = false
    if (!scored.length) { $('#probe').innerHTML = '<span class="warn">لم نجد لونًا مميزًا يشكّل أجسامًا — تأكد إن العدو ظاهر في الصورة، أو فعّل تحديد العدو بلون صارخ من إعدادات اللعبة</span>'; return }
    $('#probe').innerHTML = `<div class="text-slate-300 mb-1">اقتراحات لـ <b>${target.label}</b> (اضغط واحدًا):</div><div class="flex flex-wrap gap-2">${scored.slice(0, 5).map((c, i) => `<button class="btn btn-s !py-1" data-sug="${i}"><span class="sw inline-block" style="background:${c.hex}"></span> <span class="mono ltr">${c.hex}</span> <span class="text-xs text-slate-400">${c.count} جسم · ${(c.share || 0).toFixed(1)}%</span>${i === 0 ? ' <span class="text-emerald-300 text-xs">★ الأفضل</span>' : ''}</button>`).join('')}</div>`
    $('#probe').querySelectorAll('[data-sug]').forEach((btn) => btn.onclick = () => {
      const c = scored[Number(btn.dataset.sug)]
      marks[target.key] = { kind: 'color', hex: c.hex, tol, ok: true, count: c.count, x: c.cx, y: c.cy, objects: c.objects }
      picking = null; drawMarks(); renderThings(); updateSave()
      $('#probe').innerHTML = `<span class="sw inline-block align-middle" style="background:${c.hex}"></span> <span class="mono ltr">${c.hex}</span> — <span class="ok">✓ تم اختياره لـ ${target.label} (${c.count} جسم مُحاط على الصورة)</span>`
    })
  }
  $('#clear-btn').onclick = () => { for (const k of Object.keys(marks)) delete marks[k]; drawMarks(); renderThings(); updateSave() }

  // image → real screen px
  function toReal(cx, cy) { const img = $('#shot'); const rx = img.naturalWidth / img.clientWidth, ry = img.naturalHeight / img.clientHeight; const sx = cx * rx, sy = cy * ry; return { x: Math.round(sx / shot.scale), y: Math.round(sy / shot.scale), ix: Math.round(sx), iy: Math.round(sy) } }
  function toImg(x, y) { const img = $('#shot'); const rx = img.clientWidth / img.naturalWidth, ry = img.clientHeight / img.naturalHeight; return { x: x * shot.scale * rx, y: y * shot.scale * ry } }
  function drawMarks() {
    const el = $('#marks'); el.innerHTML = ''
    if (!shot || !$('#shot').naturalWidth) return
    let i = 0
    for (const t of things()) {
      const m = marks[t.key]; if (!m) continue; i++
      if (t.kind === 'region') { const a = toImg(m.x, m.y), b = toImg(m.x + m.w, m.y + m.h); const d = document.createElement('div'); d.className = 'box'; d.style.cssText = `left:${a.x}px;top:${a.y}px;width:${b.x - a.x}px;height:${b.y - a.y}px`; d.title = t.label; el.appendChild(d) }
      else {
        const p = toImg(m.x, m.y); const d = document.createElement('div'); d.className = 'mark'; d.style.cssText = `left:${p.x}px;top:${p.y}px;${t.kind === 'color' ? `background:${m.hex}` : 'background:#38bdf8'}`; d.textContent = i; d.title = t.label; el.appendChild(d)
        // what the bot sees: outline every detected object of this colour
        for (const o of (m.objects || []).slice(0, 12)) { const b = o.bounds || {}; const a = toImg(b.x, b.y), c = toImg(b.x + b.w, b.y + b.h); const q = document.createElement('div'); q.className = 'box'; q.style.cssText = `left:${a.x}px;top:${a.y}px;width:${Math.max(6, c.x - a.x)}px;height:${Math.max(6, c.y - a.y)}px;border-color:${m.hex};background:transparent;border-style:solid`; el.appendChild(q) }
      }
    }
  }
  window.addEventListener('resize', drawMarks)

  // pick / drag
  let dragStart = null
  const img = $('#shot')
  img.addEventListener('pointerdown', (e) => { if (!shot || !picking) return; const r = img.getBoundingClientRect(); dragStart = { x: e.clientX - r.left, y: e.clientY - r.top }; img.setPointerCapture(e.pointerId) })
  img.addEventListener('pointerup', async (e) => {
    if (!shot || !picking || !dragStart) return
    const r = img.getBoundingClientRect(); const end = { x: e.clientX - r.left, y: e.clientY - r.top }
    const t = things().find((x) => x.key === picking); dragStart = (() => { const d = dragStart; dragStart = null; return d })()
    const a = toReal(dragStart.x, dragStart.y), b = toReal(end.x, end.y)
    if (t.kind === 'region') {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y)
      if (w < 8 || h < 8) return toast('اسحب مستطيلًا أكبر للمنطقة', 'warn')
      marks[t.key] = { kind: 'region', x, y, w, h }
    } else if (t.kind === 'control') {
      marks[t.key] = { kind: 'control', x: b.x, y: b.y }
    } else {
      await pickColor(t, b)
    }
    picking = null; drawMarks(); renderThings(); updateSave()
  })

  async function pickColor(t, p) {
    $('#probe').innerHTML = '<i class="fas fa-spinner fa-spin"></i> نقرأ اللون ونتحقق…'
    // 1) exact pixel(s) around the tap from the phone (real px) — average of a 3x3 sample
    const pts = []; for (const dx of [-3, 0, 3]) for (const dy of [-3, 0, 3]) pts.push({ x: p.x + dx, y: p.y + dy })
    const px = await tool('get_pixels', { points: pts })
    let hex = null
    if (px.ok && px.data && px.data.pixels) {
      const vals = px.data.pixels.map((q) => q.hex).filter(Boolean)
      // pick the most common colour of the 9 samples (robust to edges)
      const cnt = {}; for (const v of vals) cnt[v] = (cnt[v] || 0) + 1
      hex = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    }
    if (!hex) { $('#probe').innerHTML = '<span class="bad">تعذّر قراءة اللون من الموبايل — الشاشة اتغيرت؟ صوّر تاني</span>'; return }
    // 2) verify: does this colour form objects on the live screen?
    const mode = tuneVal('match', 'rgb') === 'hue' ? 'hue' : 'rgb'
    const tol = mode === 'hue' ? Math.min(tuneVal('tolerance', 22) === 32 ? 22 : tuneVal('tolerance', 22), 60) : tuneVal('tolerance', 30)
    const fo = await tool('find_objects', { color: hex, tolerance: tol, minSize: tuneVal('minSize', 8), maxResults: 12, match: mode })
    const count = fo.ok && fo.data ? fo.data.count || 0 : 0
    marks[t.key] = { kind: 'color', hex, tol, ok: count > 0, count, x: p.x, y: p.y, objects: (fo.ok && fo.data && fo.data.objects) || [] }
    const grey = isGreyish(hex)
    $('#probe').innerHTML = `<span class="sw inline-block align-middle" style="background:${hex}"></span> <span class="mono ltr">${hex}</span> — ${count ? `<span class="ok">✓ ${count} جسم بهذا اللون على الشاشة الآن</span>` : '<span class="warn">لم يُكتشف كجسم — اضغط على نقطة أوضح/أكبر</span>'}${grey ? ' <span class="warn">⚠ لون رمادي/غامق — سيلتقط أشياء كثيرة؛ اختر لونًا مميزًا (إطار العدو/اسمه/شريط صحته)</span>' : ''}${count > 8 ? ' <span class="warn">⚠ كثير جدًا — قد يكون لون خلفية؛ قلّل التسامح أو اختر لونًا أدق</span>' : ''}`
  }
  function isGreyish(hex) { const v = parseInt(hex.slice(1), 16); const r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255; return Math.max(r, g, b) - Math.min(r, g, b) < 40 }

  // ---------------------------------------------------------------- tune
  function renderTune() {
    const el = $('#tune'); el.innerHTML = ''
    for (const t of TYPES[typeId].tune) {
      const d = document.createElement('label'); d.className = 'block bg-slate-800/60 rounded-lg p-2'
      if (t.options) d.innerHTML = `<div class="text-xs text-slate-400 mb-1">${t.label}</div><select data-tune="${t.key}" class="bg-slate-900 rounded px-2 py-1 w-full">${t.options.map((o) => `<option value="${o}" ${o === t.def ? 'selected' : ''}>${(t.labels && t.labels[o]) || o || '—'}</option>`).join('')}</select>`
      else d.innerHTML = `<div class="text-xs text-slate-400 mb-1 flex justify-between"><span>${t.label}</span><b class="mono" id="tv-${t.key}">${t.def}</b></div><input type="range" data-tune="${t.key}" min="${t.min}" max="${t.max}" step="${t.step}" value="${t.def}" class="w-full accent-emerald-400">${t.doc ? `<div class="text-[11px] text-slate-500 mt-1">${t.doc}</div>` : ''}`
      el.appendChild(d)
    }
    el.querySelectorAll('input[type=range]').forEach((r) => r.oninput = () => { $('#tv-' + r.dataset.tune).textContent = r.value; updateSave() })
    el.querySelectorAll('select').forEach((r) => r.onchange = updateSave)
  }
  function tuneVal(key, def) { const el = document.querySelector(`[data-tune="${key}"]`); if (!el) return def; const v = el.value; return el.tagName === 'SELECT' ? v : Number(v) }

  // ---------------------------------------------------------------- build params → template call
  function missing() { return things().filter((t) => t.req && !marks[t.key]).map((t) => t.label) }
  function buildParams() {
    const p = {}
    for (const t of TYPES[typeId].tune) p[t.key] = tuneVal(t.key, t.def)
    for (const t of things()) { const m = marks[t.key]; if (!m) continue; p[t.key] = '@' + t.key }
    if (typeId === 'shooter' && !p.enemy && p.head) p.enemy = '@head'
    if (marks.close) { p.close = true; p.closeColor = '@close' }
    return p
  }
  function buildProfile() {
    const set = { controls: {}, colors: {}, regions: {} }
    for (const t of things()) { const m = marks[t.key]; if (!m) continue
      if (t.kind === 'control') set.controls[t.key] = { x: m.x, y: m.y, note: t.label }
      else if (t.kind === 'region') set.regions[t.key] = { x: m.x, y: m.y, w: m.w, h: m.h, note: t.label }
      else set.colors[t.key] = { hex: m.hex, tolerance: tuneVal('tolerance', m.tol || 30), note: t.label }
    }
    return set
  }
  function updateSave() {
    const miss = missing()
    $('#save-btn').disabled = miss.length > 0 || !shot
    $('#save-btn').title = miss.length ? 'ناقص: ' + miss.join('، ') : ''
    $('#rules-json').textContent = JSON.stringify({ template: typeId, params: buildParams(), profile: buildProfile() }, null, 1)
  }

  // ---------------------------------------------------------------- save / run / status
  let savedBot = null
  $('#save-btn').onclick = async () => {
    const name = ($('#bot-name').value || typeId + '-bot').toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    $('#save-btn').disabled = true
    toast('نحفظ الأزرار والألوان في بروفايل اللعبة…')
    const prof = await tool('game_profile', { set: buildProfile(), genre: ({ shooter: 'shooter', runner: 'runner', rhythm: 'rhythm', racing: 'racing', puzzle_match: 'puzzle' })[typeId] || 'casual', ...(profileApp ? { app: profileApp } : {}) })
    if (!prof.ok) { toast('فشل حفظ البروفايل: ' + prof.error, 'bad'); $('#save-btn').disabled = false; return }
    toast('نبني البوت من القالب…')
    const r = await tool('game_bot', { action: 'template', template: typeId, name, params: buildParams(), autoStart: $('#auto-start').checked, ...(profileApp ? { app: profileApp } : {}) })
    $('#save-btn').disabled = false
    if (!r.ok) { toast('فشل: ' + r.error, 'bad'); return }
    savedBot = r.bot
    toast(`✓ تم حفظ البوت "${r.bot.name}" (${r.bot.rules} قواعد: ${(r.bot.ruleNames || []).join(', ')}) — موجود الآن في الفقاعة والإشعار على الموبايل`, 'ok')
    if (r.warnings && r.warnings.length) toast('⚠ ' + r.warnings.join(' · '), 'warn')
    $('#run-btn').disabled = false
    $('#rules-json').textContent = JSON.stringify(r, null, 1)
  }
  $('#run-btn').onclick = async () => {
    if (!savedBot) return
    const r = await tool('game_bot', { action: 'run', name: savedBot.name })
    if (!r.ok) return toast('لم يبدأ: ' + r.error + ' — هل اللعبة مفتوحة والتطبيق v2.7+؟', 'bad')
    toast('▶ البوت يعمل الآن على الموبايل… (شاهد العدّادات)', 'ok')
    $('#run-btn').classList.add('hidden'); $('#stop-btn').classList.remove('hidden')
    clearInterval(botStatusTimer); const t0 = Date.now()
    botStatusTimer = setInterval(async () => {
      const s = await tool('game_bot', { action: 'status' }); const st = s.botStatus || {}
      $('#status').firstChild && ($('#status').firstChild.textContent = st.running ? `▶ يعمل: ${st.fired || 0} ضربة · ${st.ticks || 0} فحص${st.lastRule ? ' · آخر قاعدة: ' + st.lastRule : ''}${st.ruleHits ? ' · ' + Object.entries(st.ruleHits).map(([k, v]) => k + ':' + v).join(' ') : ''}${st.learned ? ' · تعلّم: ' + JSON.stringify(st.learned) : ''}` : `■ توقف (${st.stoppedBy || '?'}) — ${st.fired || 0} ضربة في ${st.ticks || 0} فحص`)
      if (!st.running || Date.now() - t0 > 20000) { if (st.running) await tool('game_bot', { action: 'stop' }); clearInterval(botStatusTimer); $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden'); verdict(st) }
    }, 1500)
  }
  $('#stop-btn').onclick = async () => { await tool('game_bot', { action: 'stop' }); clearInterval(botStatusTimer); $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden'); toast('■ تم الإيقاف') }
  function verdict(st) {
    const hits = st.ruleHits || {}; const core = Object.entries(hits).filter(([k]) => !/game-over|close|press-play/.test(k)).reduce((a, [, v]) => a + v, 0)
    if (!core) toast('⚠ البوت اشتغل لكن لم يضرب ولا مرة: غالبًا اللون مش بيتكشف أثناء اللعب. ارفع "تسامح اللون" أو اختر لونًا أوضح (إطار/اسم العدو) وأعد الحفظ.', 'warn')
    else if (core > 200) toast('⚠ بيضرب كثيرًا جدًا — قد يكون اللون منتشر في الخلفية. قلّل التسامح أو كبّر "أصغر حجم".', 'warn')
    else toast(`✓ ممتاز: ${core} ضربة في 20 ثانية. البوت جاهز — افتح اللعبة واضغط الفقاعة ▶.`, 'ok')
  }

  // ---------------------------------------------------------------- boot
  loadDevices().then(async () => {
    renderTypes(); renderThings(); renderTune(); updateSave()
    // ?selftest=1 — automated smoke run (used by the e2e suite with the fake phone): shot → pick colour → pick button → save
    if (new URLSearchParams(location.search).get('selftest') === '1') {
      const log = (...a) => console.log('[selftest]', ...a)
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      try {
        $('#shot-btn').click(); await wait(2500)
        log('shot', !!shot, shot && shot.w + 'x' + shot.h, 'scale', shot && shot.scale)
        const im = $('#shot'); await new Promise((r) => (im.complete && im.naturalWidth ? r() : (im.onload = r)))
        const t = things()[0]; picking = t.key
        const bb = im.getBoundingClientRect()
        const fire = (type, x, y) => im.dispatchEvent(new PointerEvent(type, { clientX: bb.left + x, clientY: bb.top + y, bubbles: true, pointerId: 1 }))
        fire('pointerdown', bb.width / 2, bb.height * 0.62); fire('pointerup', bb.width / 2, bb.height * 0.62)
        await wait(2500)
        log('color', JSON.stringify(marks[t.key]))
        if (typeId === 'color_tap') { picking = 'button'; fire('pointerdown', bb.width * 0.8, bb.height * 0.7); fire('pointerup', bb.width * 0.8, bb.height * 0.7); await wait(300); log('button', JSON.stringify(marks.button)) }
        log('missing', JSON.stringify(missing()), 'saveDisabled', $('#save-btn').disabled)
        if (!$('#save-btn').disabled) { $('#save-btn').click(); await wait(4000); log('saved', JSON.stringify(savedBot)) }
        log('done')
      } catch (e) { log('error', String(e)) }
    }
  })
})()
