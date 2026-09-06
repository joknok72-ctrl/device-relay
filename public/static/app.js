// Device Relay dashboard — vanilla JS, talks to /api/* with Bearer token
(() => {
  const $ = (s) => document.querySelector(s);
  const state = { token: localStorage.getItem('relay_token') || '', devices: [], selected: null, ws: null };

  // ---------- helpers ----------
  const toast = (msg, ok = true) => {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `fixed bottom-4 left-4 px-4 py-2 rounded shadow text-sm border ${ok ? 'bg-emerald-900 border-emerald-700' : 'bg-red-900 border-red-700'}`;
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add('hidden'), 3000);
  };
  const api = async (path, opts = {}) => {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { $('#auth-status').textContent = '❌ التوكن غير صحيح'; throw new Error('unauthorized'); }
    return { res, data };
  };
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '-');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- token ----------
  $('#token-input').value = state.token;
  $('#save-token-btn').onclick = () => {
    state.token = $('#token-input').value.trim();
    localStorage.setItem('relay_token', state.token);
    loadDevices();
  };

  // ---------- devices ----------
  async function loadDevices() {
    if (!state.token) { $('#auth-status').textContent = 'أدخل التوكن أولاً'; return; }
    try {
      const { data } = await api('/devices');
      $('#auth-status').textContent = '✅ متصل';
      state.devices = data.devices || [];
      renderDevices();
      if (!state.selected && state.devices[0]) selectDevice(state.devices[0].deviceId);
      else if (state.selected) renderInfo(state.devices.find((d) => d.deviceId === state.selected));
    } catch (e) { /* toast shown by api */ }
  }
  function renderDevices() {
    const ul = $('#devices-list');
    ul.innerHTML = '';
    $('#devices-empty').classList.toggle('hidden', state.devices.length > 0);
    for (const d of state.devices) {
      const li = document.createElement('li');
      li.className = 'device-item' + (d.deviceId === state.selected ? ' active' : '');
      li.innerHTML = `<span><span class="dot ${d.online ? 'online' : 'offline'}"></span>${esc(d.deviceId)}</span>
        <span class="text-xs text-slate-400">${esc(d.model || '')}</span>`;
      li.onclick = () => selectDevice(d.deviceId);
      ul.appendChild(li);
    }
  }
  function selectDevice(id) {
    state.selected = id;
    $('#selected-device').textContent = id;
    renderDevices();
    renderInfo(state.devices.find((d) => d.deviceId === id));
    renderCurl();
    connectViewer();
  }
  function renderInfo(d) {
    const dl = $('#device-info');
    if (!d) { dl.innerHTML = ''; return; }
    const rows = [
      ['الحالة', d.online ? '<span class="text-emerald-400">● Online</span>' : '<span class="text-slate-500">○ Offline</span>'],
      ['الموديل', esc(d.model || '-')], ['أندرويد', esc(d.android || '-')],
      ['الشاشة', d.screen ? `${d.screen.w}×${d.screen.h}` : '-'],
      ['Accessibility', d.accessibilityEnabled === undefined ? '-' : d.accessibilityEnabled ? '<span class="text-emerald-400">مفعّل</span>' : '<span class="text-red-400">غير مفعّل</span>'],
      ['آخر ظهور', fmtTime(d.lastSeen)],
      ['الأوامر', `${d.commandsSent} (✔ ${d.commandsOk} / ✖ ${d.commandsFailed})`],
      ['نسخة التطبيق', esc(d.appVersion || '-')],
    ];
    dl.innerHTML = rows.map(([k, v]) => `<dt class="text-slate-500">${k}</dt><dd>${v}</dd>`).join('');
  }
  function renderCurl() {
    $('#curl-example').textContent =
`curl -X POST ${location.origin}/api/devices/${state.selected}/command \\
  -H "Authorization: Bearer <TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"action":{"type":"tap","x":540,"y":1200}}'`;
  }

  // ---------- live viewer WS ----------
  function connectViewer() {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/viewer/${state.selected}?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.kind === 'snapshot') { renderInfo(m.info); $('#log-list').innerHTML = ''; (m.logs || []).slice().reverse().forEach(addLog); }
      if (m.kind === 'status') { renderInfo(m.info); const i = state.devices.findIndex((d) => d.deviceId === m.info.deviceId); if (i >= 0) state.devices[i] = m.info; renderDevices(); }
      if (m.kind === 'log') addLog(m.entry);
      if (m.kind === 'screenshot') showScreenshot(m.data);
    };
    ws.onclose = () => setTimeout(() => { if (state.ws === ws) connectViewer(); }, 2000);
  }
  function addLog(e) {
    const ul = $('#log-list');
    let li = document.getElementById('log-' + e.id);
    if (!li) { li = document.createElement('li'); li.id = 'log-' + e.id; ul.prepend(li); }
    const a = { ...e.action }; const type = a.type; delete a.type;
    const args = Object.keys(a).length ? JSON.stringify(a) : '';
    li.className = 'log-' + e.status;
    li.textContent = `${fmtTime(e.ts)} ${e.status.toUpperCase().padEnd(7)} ${type} ${args} ${e.durationMs ? e.durationMs + 'ms' : ''} ${e.error || ''}`;
    while (ul.children.length > 100) ul.lastChild.remove();
  }
  function showScreenshot(b64) {
    $('#screenshot-img').src = 'data:image/png;base64,' + b64;
    $('#screenshot-img').classList.remove('hidden');
    $('#screenshot-empty').classList.add('hidden');
  }

  // ---------- sending ----------
  async function send(body, path = 'command') {
    if (!state.selected) return toast('اختر جهازًا أولاً', false);
    try {
      const { res, data } = await api(`/devices/${state.selected}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      toast(data.ok ? `✔ تم التنفيذ ${data.durationMs ? data.durationMs + 'ms' : ''}` : `✖ ${data.error || 'فشل'}`, data.ok);
      if (data.screenshot) showScreenshot(data.screenshot);
    } catch (e) { toast(e.message, false); }
  }
  document.querySelectorAll('.btn-action').forEach((b) => (b.onclick = () => send({ action: JSON.parse(b.dataset.action) })));
  $('#tap-form').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); send({ action: { type: 'tap', x: +f.get('x'), y: +f.get('y') } }); };
  $('#swipe-form').onsubmit = (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    send({ action: { type: 'swipe', x1: +f.get('x1'), y1: +f.get('y1'), x2: +f.get('x2'), y2: +f.get('y2'), duration: +f.get('duration') } });
  };
  $('#send-json-btn').onclick = () => {
    let j; try { j = JSON.parse($('#json-input').value); } catch { return toast('JSON غير صالح', false); }
    if (Array.isArray(j.steps)) send(j, 'macro'); else send(j.action ? j : { action: j });
  };
  $('#refresh-devices-btn').onclick = loadDevices;

  loadDevices();
  setInterval(loadDevices, 15000);
})();
