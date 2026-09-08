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
        { key: 'tolerance', label: 'تسامح اللون', min: 10, max: 70, step: 2, def: 32, doc: 'زوّده لو مش بيتكشف، قلّله لو بيضرب حاجات غلط' },
        { key: 'minSize', label: 'أصغر حجم (px)', min: 4, max: 100, step: 2, def: 12 },
        { key: 'cooldownMs', label: 'الفاصل بين الضربات (ms)', min: 0, max: 1000, step: 20, def: 120 },
        { key: 'repeat', label: 'ضغطات لكل مرة', min: 1, max: 10, step: 1, def: 1 },
      ],
    },
    shooter: {
      icon: 'fa-crosshairs', title: 'شوتر (Free Fire / PUBG / CoD)',
      doc: 'يكشف الأعداء كأجسام باللون الذي تحدده، يجرّ الكاميرا حتى يقع التصويب عليهم ويطلق رشقات — ولو مافيش عدو يلف الكاميرا يمين/شمال ويتقدّم. يتوقف على GAME OVER.',
      things: [
        { key: 'enemy', kind: 'color', label: 'لون العدو', req: true, hint: 'اضغط على العدو (الأفضل: إطار/اسم/شريط صحة العدو أو لون التحديد من إعدادات اللعبة)' },
        { key: 'fire', kind: 'control', label: 'زر الضرب', req: true },
        { key: 'look', kind: 'control', label: 'مساحة التصويب (مكان فاضي في النص الأيمن)', req: true },
        { key: 'stick', kind: 'control', label: 'عصا الحركة (مركزها)' },
        { key: 'crosshair', kind: 'control', label: 'مكان التصويب (النقطة) — افتراضي منتصف الشاشة' },
        { key: 'hp', kind: 'region', label: 'منطقة رقم الصحة (اسحب مستطيل)' },
        { key: 'heal', kind: 'control', label: 'زر العلاج' },
        { key: 'head', kind: 'color', label: 'لون رأس العدو (للهيدشوت — اختياري)', hint: 'اضغط على علامة/لون الرأس بالذات' },
        { key: 'evade', kind: 'control', label: 'زر القرفصة/القفز (يتفاداهم — اختياري)' },
        { key: 'playAgain', kind: 'control', label: 'زر PLAY AGAIN (ماتشات متواصلة — اختياري)' },
      ],
      tune: [
        { key: 'sensitivity', label: 'حساسية التصويب', min: 0.3, max: 2, step: 0.1, def: 0.9, doc: 'كاميرا بطيئة → ارفعها، الكاميرا تعدّي الهدف → اخفضها. البوت يعدّلها لوحده أثناء اللعب.' },
        { key: 'fireCount', label: 'طلقات في الرشقة', min: 2, max: 15, step: 1, def: 6 },
        { key: 'fireIntervalMs', label: 'الفاصل بين الطلقات (ms)', min: 40, max: 200, step: 10, def: 70 },
        { key: 'sweepDx', label: 'مقدار لفّة الكاميرا لما مافيش عدو (px)', min: 80, max: 500, step: 20, def: 260 },
        { key: 'tolerance', label: 'تسامح اللون', min: 10, max: 70, step: 2, def: 32, doc: 'زوّده لو العدو مش بيتكشف، قلّله لو بيضرب في حاجات مش أعداء' },
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
    for (const [id, t] of Object.entries(TYPES)) {
      const d = document.createElement('div'); d.className = 'pick' + (id === typeId ? ' on' : '')
      d.innerHTML = `<div class="font-semibold"><i class="fas ${t.icon} ml-1 text-emerald-300"></i>${t.title}</div>`
      d.onclick = () => { typeId = id; renderTypes(); renderThings(); renderTune(); updateSave() }
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
    $('#shot').src = `data:${r.image.mime};base64,${r.image.base64}`
    const app = await tool('get_current_app'); if (app.ok && app.data && app.data.package) { profileApp = app.data.package; toast('اللعبة الحالية: ' + (app.data.label || app.data.package), 'ok') }
    drawMarks()
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
      else { const p = toImg(m.x, m.y); const d = document.createElement('div'); d.className = 'mark'; d.style.cssText = `left:${p.x}px;top:${p.y}px;${t.kind === 'color' ? `background:${m.hex}` : 'background:#38bdf8'}`; d.textContent = i; d.title = t.label; el.appendChild(d) }
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
    const tol = tuneVal('tolerance', 30)
    const fo = await tool('find_objects', { color: hex, tolerance: tol, minSize: tuneVal('minSize', 8), maxResults: 12 })
    const count = fo.ok && fo.data ? fo.data.count || 0 : 0
    marks[t.key] = { kind: 'color', hex, tol, ok: count > 0, count, x: p.x, y: p.y }
    const grey = isGreyish(hex)
    $('#probe').innerHTML = `<span class="sw inline-block align-middle" style="background:${hex}"></span> <span class="mono ltr">${hex}</span> — ${count ? `<span class="ok">✓ ${count} جسم بهذا اللون على الشاشة الآن</span>` : '<span class="warn">لم يُكتشف كجسم — اضغط على نقطة أوضح/أكبر</span>'}${grey ? ' <span class="warn">⚠ لون رمادي/غامق — سيلتقط أشياء كثيرة؛ اختر لونًا مميزًا (إطار العدو/اسمه/شريط صحته)</span>' : ''}${count > 8 ? ' <span class="warn">⚠ كثير جدًا — قد يكون لون خلفية؛ قلّل التسامح أو اختر لونًا أدق</span>' : ''}`
  }
  function isGreyish(hex) { const v = parseInt(hex.slice(1), 16); const r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255; return Math.max(r, g, b) - Math.min(r, g, b) < 40 }

  // ---------------------------------------------------------------- tune
  function renderTune() {
    const el = $('#tune'); el.innerHTML = ''
    for (const t of TYPES[typeId].tune) {
      const d = document.createElement('label'); d.className = 'block bg-slate-800/60 rounded-lg p-2'
      if (t.options) d.innerHTML = `<div class="text-xs text-slate-400 mb-1">${t.label}</div><select data-tune="${t.key}" class="bg-slate-900 rounded px-2 py-1 w-full mono ltr">${t.options.map((o) => `<option ${o === t.def ? 'selected' : ''}>${o}</option>`).join('')}</select>`
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
  loadDevices().then(() => { renderTypes(); renderThings(); renderTune(); updateSave() })
})()
