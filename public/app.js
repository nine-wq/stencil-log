(function () {
'use strict';
// ทุกคนทำได้ทุกขั้นตอน (ยังไม่แยกสิทธิ์ตามฝ่าย)
const STATUS = { ordered: 'รอขึ้นบล็อค', coating: 'กำลังขึ้นกาว', qc: 'รอตรวจ', rework: 'ตีกลับแก้ไข', ready: 'พร้อมส่ง', sent: 'ส่งแล้ว' };
const QC_CHECKS = [['pinhole', 'ไม่มีรูเข็ม / ฟองอากาศ'], ['detail', 'ลายคมชัด ครบทุกเส้น'], ['edge', 'ปิดเทปขอบเรียบร้อย'], ['label', 'ติดป้ายชื่อลูกค้า / ลาย ที่เฟรม']];
// ตัวกรองหน้าแรก
const FILTERS = [
  ['all', 'ทั้งหมด', s => s.status !== 'sent'],
  ['film', 'รอทำฟิล์ม', s => needsFilm(s)],
  ['coat', 'ขึ้นบล็อค', s => ['ordered', 'coating', 'rework'].includes(s.status)],
  ['qc', 'รอตรวจ', s => s.status === 'qc'],
  ['ready', 'พร้อมส่ง', s => s.status === 'ready'],
  ['sent', 'ส่งแล้ว', s => s.status === 'sent']
];
const TOKEN_KEY = 'stencil-token';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const fmtT = t => { const d = new Date(t); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtD = t => { if (!t) return '-'; const d = new Date(t); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${pad2((d.getFullYear() + 543) % 100)}`; };
const fmtGap = ms => { const m = Math.round(ms / 60000); return m < 60 ? `+${m} นาที` : `+${Math.floor(m / 60)} ชม. ${m % 60} น.`; };
const dueTs = j => j.due ? new Date(j.due + 'T17:00').getTime() : Infinity;

let token = null; try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
const db = { master: null, jobs: [], artworks: [], users: [], files: {}, features: {} };
const ui = { lib: { cust: '', busy: [] }, groupBy: 'date', filmSet: null, user: null, pickUser: null, pin: '', pinErr: '', tab: null, view: 'list', jobId: null, screenId: null, backTo: 'list', draft: null, arm: null, admin: null, editUser: null, busy: false, uploads: [], aiBusy: {}, prevBusy: {} };
const MAX_FILE = 95 * 1024 * 1024;
let pending = 0;

/* ---------- API ---------- */
async function api(method, path, body, raw) {
  const h = {};
  if (token) h.Authorization = 'Bearer ' + token;
  let b;
  if (raw) { b = body; h['Content-Type'] = 'image/jpeg'; }
  else if (body !== undefined) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch('/api' + path, { method, headers: h, body: b }); }
  catch (e) { const x = new Error('ต่ออินเทอร์เน็ตไม่ได้'); x.status = 0; throw x; }
  let d = null; try { d = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== '/login') { signOutLocal(); throw Object.assign(new Error('กรุณาเข้าสู่ระบบใหม่'), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error((d && d.error) || ('HTTP ' + r.status)), { status: r.status, data: d });
  return d;
}
function signOutLocal() { token = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} ui.user = null; loadUsers(); }
async function loadUsers() { try { db.users = await api('GET', '/users'); } catch (e) { db.users = []; } render(); }
async function loadData(quiet) {
  try {
    const d = await api('GET', '/data');
    db.master = d.master; db.jobs = d.jobs; db.artworks = d.artworks || []; ui.user = d.me;
    Object.assign(db.files, d.files || {}); db.features = d.features || {};
    if (!quiet || !isEditing()) render();
  } catch (e) { if (!quiet && e.status !== 401) toast('โหลดข้อมูลไม่สำเร็จ: ' + e.message); }
}
const isEditing = () => { const a = document.activeElement; return pending > 0 || Object.keys(timers).length > 0 || ui.view === 'newjob' || ui.editUser || ui.lib.busy.length > 0 || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)); };
const photoSrc = id => `/api/photos/${id}?t=${encodeURIComponent(token)}`;
const fileUrl = (id, inline) => `/api/files/${id}?t=${encodeURIComponent(token)}${inline ? '&inline=1' : ''}`;
const fmtSize = n => n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const stem = n => String(n).replace(/\.[^.]+$/, '').trim();
const extOf = n => (String(n).match(/\.([^.]+)$/) || [, ''])[1].toUpperCase();

/* ---------- files ---------- */
// อัปโหลดไฟล์ไป R2 พร้อมแสดงความคืบหน้า
function uploadFile(file, kind, name) {
  name = name || file.name || 'file';
  const up = { id: Math.random().toString(36).slice(2), name, pct: 0, kind };
  if (file.size > MAX_FILE) return Promise.reject(new Error(`${name} ใหญ่เกิน 95 MB`));
  if (kind !== 'preview') { ui.uploads.push(up); renderUploads(); }
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/files?kind=${kind}&name=${encodeURIComponent(name)}`);
    x.setRequestHeader('Authorization', 'Bearer ' + token);
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.upload.onprogress = e => { if (e.lengthComputable) { up.pct = e.loaded / e.total; renderUploads(); } };
    const done = () => { ui.uploads = ui.uploads.filter(u => u !== up); renderUploads(); };
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch (e) {}
      done();
      if (x.status >= 200 && x.status < 300 && d) { db.files[d.id] = d; res(d); }
      else rej(new Error((d && d.error) || ('HTTP ' + x.status)));
    };
    x.onerror = () => { done(); rej(new Error('ต่ออินเทอร์เน็ตไม่ได้')); };
    x.send(file);
  });
}
function renderUploads() {
  const box = document.getElementById('uploads'); if (!box) return;
  box.innerHTML = ui.uploads.map(u => `<div class="upl"><span class="upl-n">${esc(u.name)}</span><span class="bar"><i style="width:${Math.round(u.pct * 100)}%"></i></span><span class="num small">${Math.round(u.pct * 100)}%</span></div>`).join('');
}
// โหลด pdf.js เมื่อจำเป็น เพื่อทำรูปตัวอย่างจาก PDF / AI (ที่บันทึกแบบ PDF compatible)
let pdfjsP = null;
function loadPdfJs() {
  if (!pdfjsP) pdfjsP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/film/vendor/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/film/vendor/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsP = null; rej(new Error('โหลดตัวอ่าน PDF ไม่ได้')); };
    document.head.appendChild(s);
  });
  return pdfjsP;
}
async function pdfPreview(file, max) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const v0 = page.getViewport({ scale: 1 }), k = max / Math.max(v0.width, v0.height), v = page.getViewport({ scale: k });
  const c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: v }).promise;
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
}
// สร้างรูปตัวอย่างจากไฟล์ลูกค้า ถ้าทำได้ (รูปภาพ, PDF, AI)
async function previewFromFile(file) {
  const ext = extOf(file.name || '');
  try {
    if (/^image\/(jpeg|png|webp|gif|bmp|svg)/.test(file.type) || ['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'BMP', 'SVG'].includes(ext)) return await shrink(file, 768, true);
    if (file.type === 'application/pdf' || ext === 'PDF' || ext === 'AI') return await pdfPreview(file, 768);
  } catch (e) {}
  return null;
}
// เป้าหมายของรูปตัวอย่าง: แถวในฟอร์มใบงานใหม่ ("d:<index>") หรือบล็อคที่เปิดอยู่ ("s")
function targetObj(t) {
  if (t === 's') { const { s } = find(ui.jobId, ui.screenId); return s; }
  if (t && t.startsWith('d:') && ui.draft) return ui.draft.screens[+t.slice(2)];
  return null;
}
function persistTarget(t) { if (t === 's') { const o = targetObj(t); if (o) saveScreen(o); } }
async function setPreview(t, imgFile) {
  const o = targetObj(t); if (!o || !imgFile) return;
  ui.prevBusy[t] = true; render();
  try {
    const blob = await shrink(imgFile, 768, true);
    if (!blob) throw new Error('อ่านรูปไม่ได้');
    const f = await uploadFile(blob, 'preview', 'preview.jpg');
    o.preview = f.id; persistTarget(t);
    delete ui.prevBusy[t]; render();
    if (db.features.ai && !String(o.design || '').trim()) await aiName(t);
  } catch (e) { delete ui.prevBusy[t]; render(); toast('ใส่รูปตัวอย่างไม่สำเร็จ: ' + e.message); }
}
async function aiName(t) {
  const o = targetObj(t); if (!o || !o.preview) return toast('ใส่รูปตัวอย่างก่อน แล้วค่อยให้ AI ตั้งชื่อ');
  ui.aiBusy[t] = true; render();
  try {
    const r = await api('POST', '/ai/name', { fileId: o.preview });
    o.design = r.name; persistTarget(t); toast('AI ตั้งชื่อ: ' + r.name);
  } catch (e) { toast(e.message); }
  delete ui.aiBusy[t]; render();
}
// แปะไฟล์ลูกค้าหลายไฟล์ลงใบงานใหม่: ไฟล์ละ 1 ลาย, Customer ID มาจากชื่อไฟล์
async function addCustomerFiles(files, rowIndex) {
  for (const file of files) {
    let f;
    try { f = await uploadFile(file, 'original'); } catch (e) { toast('อัปโหลดไม่สำเร็จ: ' + e.message); continue; }
    if (!ui.draft) return;
    let i = rowIndex;
    if (i == null) {
      const s0 = ui.draft.screens[0];
      if (ui.draft.screens.length === 1 && !s0.originals.length && !s0.design && !s0.customerRef) i = 0;
      else { ui.draft.screens.push({ ...blankScreen(), ...pickSpec(ui.draft.screens[ui.draft.screens.length - 1]) }); i = ui.draft.screens.length - 1; }
    }
    const row = ui.draft.screens[i];
    row.originals.push(f.id);
    if (!row.customerRef) row.customerRef = stem(file.name);
    render();
    if (!row.preview) { const blob = await previewFromFile(file); if (blob) await setPreview('d:' + i, new File([blob], 'preview.jpg', { type: 'image/jpeg' })); }
  }
}
const pickSpec = s => s ? { mesh: s.mesh, frame: s.frame, emulsion: s.emulsion, target: s.target } : {};
function fileChip(id, canDel, kind) {
  const f = db.files[id] || { name: '(ไฟล์)', id };
  return `<div class="fchip"><span class="ext">${esc(extOf(f.name) || 'FILE')}</span>
    <a class="fname" href="${fileUrl(id)}" download="${esc(f.name)}">${esc(f.name)}</a>
    <span class="muted small">${fmtSize(f.size)}${f.by ? ` · ${esc(f.by)}` : ''}${f.t ? ` · ${fmtT(f.t)}` : ''}</span>
    ${canDel ? `<button class="x2" data-a="delfile" data-v="${id}" data-k="${kind}" aria-label="ลบไฟล์">✕</button>` : ''}</div>`;
}
function previewZone(t, o, canEdit) {
  const busy = ui.prevBusy[t];
  const img = o.preview ? `<img src="${fileUrl(o.preview, true)}" alt="รูปตัวอย่างลาย" data-a="zoomfile" data-v="${o.preview}">` : '';
  if (!canEdit) return `<div class="pz ro">${img || '<span class="muted small">ไม่มีรูป</span>'}</div>`;
  return `<div class="pz" tabindex="0" data-zone="${t}" title="คลิกที่นี่แล้วกด Ctrl+V เพื่อวางรูป">
    ${busy ? '<span class="muted small">กำลังใส่รูป…</span>' : img || '<span class="pz-hint">วางรูป<br>Ctrl+V<br>หรือลากมาวาง</span>'}
    <label class="pz-btn" for="pv-${t}">${o.preview ? 'เปลี่ยน' : 'เลือกรูป'}</label>
    <input id="pv-${t}" type="file" accept="image/*" hidden data-pv="${t}"></div>`;
}
function nameField(t, o, id, attr) {
  return `<div class="field"><label for="${id}">ชื่อลาย (Artwork ID)</label>
    <div class="aiwrap"><input id="${id}" ${attr} value="${esc(o.design)}" placeholder="พิมพ์เอง หรือกด AI">
    <button class="btn sm" data-a="ainame" data-v="${t}" ${ui.aiBusy[t] || !o.preview ? 'disabled' : ''} title="ให้ AI ตั้งชื่อจากรูปตัวอย่าง">${ui.aiBusy[t] ? 'กำลังคิด…' : '✨ AI'}</button></div></div>`;
}

/* save one screen; saves for the same screen run in order */
const queues = {}, timers = {};
function saveScreen(s) {
  clearTimeout(timers[s.id]); delete timers[s.id];
  pending++;
  const q = (queues[s.id] || Promise.resolve()).then(async () => {
    const { photos, id, jobId, rev, ...data } = s;
    try { const r = await api('PUT', '/screens/' + s.id, { rev: s.rev, data }); s.rev = r.rev; return true; }
    catch (e) {
      if (e.status === 409) { toast('มีคนแก้บล็อคนี้พร้อมกัน ระบบโหลดข้อมูลล่าสุดแล้ว กรุณาตรวจและทำซ้ำ'); await loadData(); }
      else if (e.status !== 401) toast('บันทึกไม่สำเร็จ: ' + e.message);
      return false;
    } finally { pending--; }
  });
  queues[s.id] = q; return q;
}
function saveScreenLater(s) { clearTimeout(timers[s.id]); timers[s.id] = setTimeout(() => saveScreen(s), 800); }

/* ---------- helpers ---------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 3200); }
const allScreens = () => db.jobs.flatMap(j => j.screens.map(s => ({ j, s })));
const find = (jid, sid) => { const j = db.jobs.find(x => x.id === jid); return { j, s: j && sid ? j.screens.find(x => x.id === sid) : null }; };
const tol = () => (db.master && db.master.tolerance) || 10;
const defTarget = () => (db.master && db.master.defaultTarget) || 400;
function dueCls(j) { const h = (dueTs(j) - Date.now()) / 3600e3; return h < 0 ? 'due-late' : h < 24 ? 'due-soon' : ''; }
function dueText(j) { const h = (dueTs(j) - Date.now()) / 3600e3; if (h < 0) return 'เลยกำหนด ' + fmtD(dueTs(j)); if (h < 24) return 'ส่งภายในวันนี้/พรุ่งนี้'; return 'กำหนดส่ง ' + fmtD(dueTs(j)); }
const chip = st => `<span class="chip st-${st}">${STATUS[st]}</span>`;
function delta(v, target) {
  if (v === '' || v == null || !target) return '';
  const d = v - target, a = Math.abs(d), T = tol();
  const cls = a <= T ? 'delta-ok' : a <= T * 2 ? 'delta-warn' : 'delta-bad';
  const word = a <= T ? 'ตามสเปค' : d > 0 ? 'หนาเกิน' : 'บางกว่าสเปค';
  return `<span class="${cls}">${d > 0 ? '+' : ''}${d} µm · ${word}</span>`;
}
const logEv = (s, msg) => s.log.push([Date.now(), ui.user.name, msg]);

/* ---------- render ---------- */
function render() {
  const app = $('#app');
  if (!ui.user) { app.innerHTML = loginView(); return; }
  if (!db.master) { app.innerHTML = '<div class="loading">กำลังโหลดข้อมูล…</div>'; return; }
  if (!ui.tab || !FILTERS.some(f => f[0] === ui.tab)) ui.tab = 'all';
  const y = window.scrollY;
  // จำช่องที่กำลังพิมพ์ไว้ เพื่อไม่ให้หลุดโฟกัสเมื่อหน้าจอวาดใหม่
  const ae = document.activeElement, fid = ae && ae.id, sel = ae && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  const zone = ae && ae.dataset && ae.dataset.zone;
  setTimeout(() => {
    if (fid) { const el = document.getElementById(fid); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
    else if (zone) { const el = document.querySelector(`[data-zone="${zone}"]`); if (el) el.focus({ preventScroll: true }); }
    renderUploads();
  });
  app.innerHTML = `
  <header class="top"><div class="wrap">
    <div class="brand"><div class="mark" aria-hidden="true"></div><h1>บันทึกขึ้นบล็อค</h1></div>
    <button class="icon-btn" data-a="refresh" title="โหลดข้อมูลล่าสุด" aria-label="โหลดข้อมูลล่าสุด">⟳</button>
    <button class="icon-btn" data-a="settings" title="ตั้งค่า" aria-label="ตั้งค่า" aria-current="${ui.view === 'settings'}">⚙</button>
    <div class="who"><span class="av artwork" style="width:30px;height:30px">${esc(ui.user.name[0])}</span>
      <span class="who-n"><b>${esc(ui.user.name)}</b></span>
      <button class="btn sm ghost" data-a="logout">ออก</button></div>
  </div>
  <nav class="wrap tabs mainnav" aria-label="เมนูหลัก">
    <button data-a="nav" data-v="list" aria-current="${!['library', 'settings'].includes(ui.view)}">ใบงาน</button>
    <button data-a="nav" data-v="library" aria-current="${ui.view === 'library'}">คลังลาย</button>
    <a href="/film/" class="navlink">ทำฟิล์ม${(() => { const n = allScreens().filter(x => needsFilm(x.s)).length; return n ? ` <span class="count">${n}</span>` : ''; })()}</a>
  </nav></header>
  <main class="wrap">${body()}</main>`;
  window.scrollTo(0, y);
}
function body() {
  if (ui.view === 'newjob') return newJobView();
  if (ui.view === 'job') return jobView();
  if (ui.view === 'screen') return screenView();
  if (ui.view === 'settings') return settingsView();
  if (ui.view === 'library') return libraryView();
  return homeView();
}

function loginView() {
  if (ui.pickUser) {
    const u = db.users.find(x => x.id === ui.pickUser);
    if (!u) { ui.pickUser = null; return loginView(); }
    return `<div class="login wrap"><button class="btn ghost back" data-a="pickback">← เลือกชื่อใหม่</button>
      <div class="pin"><span class="av artwork" style="width:56px;height:56px;font-size:1.4rem">${esc(u.name[0])}</span>
      <div style="text-align:center"><h2>${esc(u.name)}</h2></div>
      <div class="dots ${ui.pinErr ? 'shake' : ''}">${[0, 1, 2, 3].map(i => `<i class="${i < ui.pin.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="err">${esc(ui.pinErr)}</div>
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-a="pin" data-v="${n}" ${ui.busy ? 'disabled' : ''}>${n}</button>`).join('')}<span></span><button data-a="pin" data-v="0" ${ui.busy ? 'disabled' : ''}>0</button><button data-a="pindel" aria-label="ลบ">⌫</button></div>
      </div></div>`;
  }
  return `<div class="login wrap">
    <div class="brand" style="flex:none"><div class="mark"></div><h1 style="font-size:1.5rem">บันทึกขึ้นบล็อค</h1></div>
    <div class="muted">แตะชื่อของคุณ แล้วใส่ PIN 4 หลัก</div>
    ${db.users.length ? `<div class="dept"><div class="people">
      ${db.users.map(u => `<button class="person" data-a="pick" data-v="${u.id}"><span class="av artwork">${esc(u.name[0])}</span><b>${esc(u.name)}</b></button>`).join('')}
    </div></div>` : '<div class="empty">โหลดรายชื่อไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่<br><button class="btn" data-a="reloadusers" style="margin-top:10px">ลองใหม่</button></div>'}
  </div>`;
}

/* --- หน้าแรก: ใบงานทั้งหมด กรองตามขั้นตอน --- */
function homeView() {
  return `<div class="spread"><h2>ใบงาน</h2><button class="btn primary" data-a="newjob">+ สร้างใบงาน</button></div>
  <div class="search"><input id="q" type="search" data-search="1" value="${esc(ui.q || '')}" placeholder="ค้นหา ลูกค้า เลขใบงาน ชื่อลาย Customer ID เบอร์ผ้า ชื่อคน…" autocomplete="off" enterkeyhint="search">
    <button class="btn sm ghost" data-a="clearq" aria-label="ล้างคำค้น" ${ui.q ? '' : 'hidden'}>✕</button></div>
  <div id="homeres">${homeResults()}</div>`;
}
function homeResults() {
  const f = FILTERS.find(x => x[0] === ui.tab) || FILTERS[0];
  const q = searchTerms(ui.q);
  // ตอนค้นหาด้วยตัวกรอง "ทั้งหมด" ให้ค้นรวมงานที่ส่งแล้วด้วย
  const test = q.length && f[0] === 'all' ? () => true : f[2];
  const order = { rework: 0, coating: 1, ordered: 2, qc: 3, ready: 4, sent: 5 };
  const byCust = ui.groupBy === 'customer';
  const hits = db.jobs.map(j => {
    let ss = j.screens.filter(test);
    if (q.length) { const jt = jobText(j); ss = ss.filter(s => matches(jt + ' ' + screenText(s), q)); }
    return { j, ss: ss.sort((a, b) => order[a.status] - order[b.status]), t: jobTs(j) };
  }).filter(x => x.ss.length).sort((a, b) => b.t - a.t || (b.j.createdAt || 0) - (a.j.createdAt || 0));
  const count = t => q.length ? hits.reduce((n, x) => n + x.j.screens.filter(t).filter(s => x.ss.includes(s) || matches(jobText(x.j) + ' ' + screenText(s), q)).length, 0) : allScreens().filter(x => t(x.s)).length;
  // จัดกลุ่มตามวันที่รับงาน (กลุ่มแรกที่เข้าเงื่อนไข)
  let groups;
  if (byCust) {   // จัดกลุ่มตามลูกค้า: ลูกค้าที่มีงานล่าสุดขึ้นก่อน
    const m = new Map();
    for (const x of hits) { const k = x.j.customer || '-'; if (!m.has(k)) m.set(k, { title: k, xs: [] }); m.get(k).xs.push(x); }
    groups = [...m.values()];
  } else {
    groups = dateGroups().map(g => ({ ...g, xs: [] }));
    for (const x of hits) (groups.find(g => x.t >= g.from) || groups[groups.length - 1]).xs.push(x);
  }
  const sec = g => g.xs.length ? `<div class="sec-h"><h3>${esc(g.title)}</h3><span class="muted small num">${g.xs.length} ใบงาน</span></div>
    <div class="list">${g.xs.map(({ j, ss }) => jobCard(j, ss)).join('')}</div>` : '';
  return `<div class="groupby small"><span class="muted">จัดกลุ่มตาม</span>
    <button class="btn sm ${byCust ? 'ghost' : ''}" data-a="groupby" data-v="date" aria-pressed="${!byCust}">วันที่รับงาน</button>
    <button class="btn sm ${byCust ? '' : 'ghost'}" data-a="groupby" data-v="customer" aria-pressed="${byCust}">ลูกค้า</button></div>
  <div class="filters" role="tablist">${FILTERS.map(([k, label, t]) => { const n = count(t); return `<button role="tab" data-a="tab" data-v="${k}" aria-selected="${k === f[0]}">${label}${k !== 'sent' || q.length ? ` <span class="count">${n}</span>` : ''}</button>`; }).join('')}</div>
  ${q.length ? `<div class="muted small">พบ <span class="num">${hits.reduce((n, x) => n + x.ss.length, 0)}</span> บล็อค ใน <span class="num">${hits.length}</span> ใบงาน${f[0] === 'all' ? ' (รวมงานที่ส่งแล้ว)' : ''}</div>` : ''}
  ${hits.length ? groups.map(sec).join('') : `<div class="empty">${q.length ? `ไม่พบงานที่ตรงกับ "${esc(ui.q)}"` : `ไม่มีงานในขั้นตอน "${f[1]}"`}</div>`}`;
}
// ช่วงเวลา: ล่าสุด (3 วัน) → สัปดาห์นี้ (เริ่มวันจันทร์) → เดือนนี้ → 3 เดือนที่ผ่านมา → ปีนี้ → ก่อนหน้านี้
function dateGroups() {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const day = 864e5, t0 = d0.getTime();
  const week = t0 - ((d0.getDay() + 6) % 7) * day;
  const month = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime();
  const m3 = new Date(d0.getFullYear(), d0.getMonth() - 3, d0.getDate()).getTime();
  const year = new Date(d0.getFullYear(), 0, 1).getTime();
  return [
    { title: 'ล่าสุด', from: t0 - (RECENT_DAYS - 1) * day },
    { title: 'สัปดาห์นี้', from: week },
    { title: 'เดือนนี้', from: month },
    { title: '3 เดือนที่ผ่านมา', from: m3 },
    { title: 'ปีนี้', from: year },
    { title: 'ก่อนหน้านี้', from: -Infinity }
  ];
}
/* ---- ค้นหา: หลายคำคั่นด้วยเว้นวรรค ต้องเจอครบทุกคำ ไม่สนตัวพิมพ์เล็กใหญ่ ---- */
const norm = x => String(x ?? '').toLowerCase().normalize('NFC');
const searchTerms = q => norm(q).split(/\s+/).filter(Boolean);
const matches = (text, terms) => terms.every(t => text.includes(t) || text.replace(/[\s_\-.]/g, '').includes(t.replace(/[\s_\-.]/g, '')));
function jobText(j) {
  const d = jobDate(j);
  return norm([j.no, j.customer, j.note, j.createdBy, d, d && fmtD(jobTs(j)), j.due, j.due && fmtD(dueTs(j))].join(' '));
}
function screenText(s) {
  const files = [...(s.originals || []), ...(s.prepared || [])].map(id => (db.files[id] || {}).name);
  const people = [...(s.coats || []).map(c => c.by), ...(s.log || []).map(l => l[1]), s.qc && s.qc.by];
  return norm([s.design, s.customerRef, s.mesh, s.frame, s.emulsion, s.target && s.target + 'µm', STATUS[s.status], s.coatNote, s.qc && s.qc.note, ...files, ...people].join(' '));
}
const RECENT_DAYS = 3;
const localDate = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// วันที่รับงาน: ใช้ช่อง "วันที่รับงาน" ถ้ามี ไม่งั้นใช้วันที่บันทึกเข้าระบบ
const jobDate = j => j.date || (j.createdAt ? localDate(j.createdAt) : '');
const jobTs = j => { const d = jobDate(j); return d ? new Date(d + 'T00:00').getTime() : 0; };
function jobCard(j, ss) {
  const n = j.screens.length, done = j.screens.filter(s => s.status === 'ready' || s.status === 'sent').length;
  return `<div class="jobcard">
    <button class="jobhead" data-a="openjob" data-v="${j.id}">
      <span class="t">${esc(j.customer)} <span class="jobno">${esc(j.no)}</span></span>
      <span class="small"><span class="muted">รับงาน ${fmtD(jobTs(j))}</span> · <span class="${dueCls(j)}">${dueText(j)}</span> · <span class="num">${done}/${n}</span> บล็อค</span>
    </button>
    ${ss.map(s => blockRow(j, s)).join('')}
  </div>`;
}
function blockRow(j, s) {
  const prep = (s.prepared || []).length;
  const th = s.thAfter !== '' ? ` · หลังถ่าย <span class="num">${s.thAfter}</span>` : '';
  return `<button class="brow" data-a="openscreen" data-j="${j.id}" data-v="${s.id}">
    ${s.preview ? `<img class="thumb" src="${fileUrl(s.preview, true)}" alt="" loading="lazy">` : '<span class="thumb none" aria-hidden="true"></span>'}
    <span class="bt"><b>${esc(s.design || '(ยังไม่ตั้งชื่อ)')}</b>
      <span class="muted small"><span class="num">${esc(s.mesh)}</span> · สเปค <span class="num">${esc(s.target)} µm</span>${s.coats.length ? ` · กาว ${s.coats.length} รอบ` : ''}${th}</span>
      ${needsFilm(s) ? '<span class="fstate">ยังไม่ทำฟิล์ม</span>' : !s.film && !s.artworkId && db.features.files && !prep && ['ordered', 'coating'].includes(s.status) ? '<span class="fstate">ยังไม่มีไฟล์เตรียม</span>' : ''}</span>
    ${chip(s.status)}
  </button>`;
}
function blankScreen() {
  const m = db.master, cs = custSpec(ui.draft && ui.draft.customer) || {};
  return { key: Math.random().toString(36).slice(2), design: '', customerRef: '', originals: [], preview: null,
    mesh: cs.mesh || m.mesh[1] || m.mesh[0] || '', frame: cs.frame || m.frames[1] || m.frames[0] || '', emulsion: cs.emulsion || m.emulsions[0] || '', target: cs.target || defTarget() };
}
// สเปคประจำของลูกค้า (ขนาดเฟรม เบอร์ผ้า กาว ความหนา) เก็บใน master.customerSpecs
const custSpec = name => { const k = String(name || '').trim(); return (k && db.master && (db.master.customerSpecs || {})[k]) || null; };
const specText = c => [c.frame, c.mesh, c.emulsion, c.target && c.target + ' µm'].filter(Boolean).join(' · ');
const sameSpec = (a, b) => ['mesh', 'frame', 'emulsion'].every(k => !b[k] || (a[k] || '') === b[k]) && (!b.target || Number(a.target) === Number(b.target));
const opt = (arr, v) => (arr.includes(v) || !v ? arr : [v, ...arr]).map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
function newJobView() {
  const d = ui.draft, m = db.master, cust = d.customer.trim();
  const arts = custArts(cust), picked = new Set(d.screens.map(x => x.artworkId).filter(Boolean));
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <h2>สร้างใบงานใหม่</h2>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div class="grid2">
      <div class="field"><label for="f-cust">ลูกค้า</label><input id="f-cust" list="custs" value="${esc(d.customer)}" data-d="customer" placeholder="พิมพ์หรือเลือก" autocomplete="off"><datalist id="custs">${allCustomers().map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label for="f-date">วันที่รับงาน</label><input id="f-date" type="date" value="${esc(d.date)}" data-d="date"></div>
      <div class="field"><label for="f-due">กำหนดส่ง</label><input id="f-due" type="date" value="${esc(d.due)}" data-d="due"></div>
    </div>
    ${(() => { const cs = custSpec(d.customer), isNew = cust && !cs;
      // สเปคประจำแก้ได้ที่ ⚙ ตั้งค่า เท่านั้น
      return cs ? `<div class="spechint"><span class="label">สเปคประจำลูกค้า</span><span>${esc(specText(cs))}</span><span class="muted small">ใส่ให้ทุกบล็อคอัตโนมัติ เปลี่ยนเฉพาะงานนี้ได้ที่แต่ละบล็อค · แก้สเปคประจำได้ที่ ⚙ ตั้งค่า</span></div>` : ''; })()}
    <div class="field"><label for="f-note">รายละเอียด / ข้อควรระวัง</label><textarea id="f-note" data-d="note" placeholder="เช่น ชนิดหมึก งานเส้นเล็ก">${esc(d.note)}</textarea></div>
  </div>
  ${cust ? `<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="spread"><div><h3>เลือกลายของ ${esc(cust)}</h3><div class="muted small">แตะลายที่จะสั่งในใบงานนี้ · 1 ลาย = 1 บล็อค · ลายใหม่ที่อัปโหลดจะเก็บเข้าคลังลายของลูกค้าด้วย</div></div><span class="muted small"><span class="num">${picked.size}</span> ลายที่เลือก</span></div>
    ${artGrid(arts, picked, 'pickart')}
    ${db.features.files ? uploadZone('nj') : ''}
  </div>` : '<div class="card muted small">ใส่ชื่อลูกค้าก่อน แล้วเลือกลายจากคลังของลูกค้า หรืออัปโหลดไฟล์ลายใหม่</div>'}
  <h3>บล็อคที่ต้องขึ้น (${d.screens.length} ลาย)</h3>
  ${d.screens.length ? d.screens.map((s, i) => draftRow(s, i)).join('') : '<div class="empty">ยังไม่ได้เลือกลาย</div>'}
  <button class="btn" data-a="addscreen">+ เพิ่มบล็อคที่ไม่มีไฟล์ลาย</button>
  <div class="row" style="justify-content:flex-end"><span class="err" id="jerr"></span><button class="btn primary" data-a="savejob" ${ui.busy ? 'disabled' : ''}>บันทึกและส่งให้ฝ่ายขึ้นบล็อค</button></div>`;
}
function draftRow(s, i) {
  const d = ui.draft, m = db.master, a = s.artworkId ? artOf(s.artworkId) : null;
  return `<div class="screenrow">
    <div class="spread"><b>บล็อคที่ ${i + 1}${custSpec(d.customer) && !sameSpec(s, custSpec(d.customer)) ? ' <span class="fstate">ต่างจากสเปคประจำ</span>' : ''}</b><span class="row"><button class="btn sm" data-a="dupscreen" data-v="${i}" title="ลายเดียวกันแต่ต่างสี/ต่างบล็อค">ทำซ้ำ</button><button class="btn sm bad" data-a="delscreen" data-v="${i}">ลบ</button></span></div>
    <div class="idrow">
      ${a ? `<div class="pz ro">${a.preview ? `<img src="${fileUrl(a.preview, true)}" alt="รูปตัวอย่างลาย" data-a="zoomfile" data-v="${a.preview}">` : '<span class="muted small">ไม่มีรูป</span>'}</div>` : db.features.files ? previewZone('d:' + i, s, true) : '<span></span>'}
      <div class="idfields">
        ${a ? `<div><span class="label">Customer ID</span><div>${esc(s.customerRef || '-')}</div></div>`
          : `<div class="field"><label for="s-c-${s.key}">Customer ID</label><input id="s-c-${s.key}" value="${esc(s.customerRef)}" data-s="${i}" data-k="customerRef"></div>`}
        ${!a && db.features.ai && db.features.files ? nameField('d:' + i, s, `s-d-${s.key}`, `data-s="${i}" data-k="design"`) : `<div class="field"><label for="s-d-${s.key}">ชื่อลาย</label><input id="s-d-${s.key}" value="${esc(s.design)}" data-s="${i}" data-k="design" placeholder="${a && !a.name ? 'AI กำลังตั้งชื่อ…' : 'เช่น โลโก้หน้าอก (ขาว)'}"></div>`}
        ${a && !a.filmable ? '<span class="fstate">ไฟล์นี้ทำฟิล์มในแอปไม่ได้</span>' : ''}
      </div>
    </div>
    <div class="grid2">
      <div class="field"><label for="s-m-${s.key}">เบอร์ผ้าสกรีน</label><select id="s-m-${s.key}" data-s="${i}" data-k="mesh">${opt(m.mesh, s.mesh)}</select></div>
      <div class="field"><label for="s-f-${s.key}">ขนาดเฟรม</label><select id="s-f-${s.key}" data-s="${i}" data-k="frame">${opt(m.frames, s.frame)}</select></div>
      <div class="field"><label for="s-e-${s.key}">ชนิดกาว</label><select id="s-e-${s.key}" data-s="${i}" data-k="emulsion">${opt(m.emulsions, s.emulsion)}</select></div>
      <div class="field"><label for="s-t-${s.key}">ความหนาที่ลูกค้าต้องการ</label><div class="unit"><input id="s-t-${s.key}" type="number" inputmode="numeric" value="${esc(s.target)}" data-s="${i}" data-k="target" placeholder="เช่น 120"><span>µm</span></div></div>
    </div></div>`;
}

/* --- คลังลาย: ลายของลูกค้าแต่ละราย (1 ลาย = คู่ซ้าย-ขวา 1 ชุดจากไฟล์ลูกค้า) --- */
const artOf = id => db.artworks.find(a => a.id === id);
const custArts = c => c ? db.artworks.filter(a => a.customer === c && !a.hidden) : [];
function allCustomers() {
  const set = new Set((db.master && db.master.customers) || []);
  db.artworks.forEach(a => { if (!a.hidden) set.add(a.customer); });
  return [...set];
}
function needsFilm(s) {
  if (!s.artworkId || s.film || s.status === 'sent') return false;
  const a = artOf(s.artworkId); return !!(a && a.filmable);
}
const screensUsing = id => allScreens().filter(x => x.s.artworkId === id);
function artGrid(arts, picked, action) {
  if (!arts.length) return '<div class="muted small">ยังไม่มีลายในคลังของลูกค้านี้ อัปโหลดไฟล์ลายด้านล่าง</div>';
  return `<div class="artgrid">${arts.map(a => { const on = picked ? picked.has(a.id) : ui.lib.edit === a.id;
    return `<button class="arttile ${on ? 'on' : ''}" data-a="${action}" data-v="${a.id}" aria-pressed="${on}">
      ${a.preview ? `<img src="${fileUrl(a.preview, true)}" alt="" loading="lazy">` : '<span class="noimg" aria-hidden="true"></span>'}
      <b>${esc(a.name || (ui.aiBusy['a:' + a.id] ? 'AI กำลังตั้งชื่อ…' : '(ยังไม่ตั้งชื่อ)'))}</b>
      <span class="muted small">${esc(a.customerRef || '')}</span>
      ${a.filmable ? '' : '<span class="fstate">ทำฟิล์มในแอปไม่ได้</span>'}${picked && on ? '<span class="tick" aria-hidden="true">✓</span>' : ''}</button>`; }).join('')}</div>`;
}
function uploadZone(id) {
  return `<label class="drop" for="${id}-files" data-drop="lib">+ อัปโหลดไฟล์ลายใหม่ หรือลากไฟล์มาวางที่นี่<br><span class="small muted">AI (PDF-compatible), PDF, JPG, PNG · ไฟล์ที่มีหลายลายจะแยกเป็นลายละ 1 ชิ้นให้เอง</span></label>
    <input id="${id}-files" type="file" multiple hidden data-libfiles="1">
    <div id="uploads"></div><div id="libbusy">${libBusyHtml()}</div>`;
}
const libBusyHtml = () => ui.lib.busy.map(b => `<div class="upl"><span class="upl-n">${esc(b.name)}</span><span class="small muted" style="grid-column:span 2">${esc(b.msg)}</span></div>`).join('');
function renderLibBusy() { const el = document.getElementById('libbusy'); if (el) el.innerHTML = libBusyHtml(); }
function libraryView() {
  const c = ui.lib.cust, counts = new Map();
  db.artworks.forEach(a => { if (!a.hidden) counts.set(a.customer, (counts.get(a.customer) || 0) + 1); });
  const custs = allCustomers().sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b, 'th'));
  const arts = custArts(c), ed = ui.lib.edit && artOf(ui.lib.edit);
  return `<div class="spread"><h2>คลังลาย</h2><span class="muted small"><span class="num">${db.artworks.filter(a => !a.hidden).length}</span> ลาย</span></div>
  <div class="muted small">เก็บไฟล์ลายของลูกค้าไว้ที่นี่ครั้งเดียว แล้วเลือกใช้ตอนสร้างใบงาน แอปแยกลายจากกรอบแป้นในไฟล์ให้เอง และให้ AI ตั้งชื่อ</div>
  <div class="field"><label for="lib-cust">ลูกค้า</label><input id="lib-cust" list="custs2" value="${esc(c)}" data-libcust="1" placeholder="พิมพ์ชื่อลูกค้า หรือเลือกด้านล่าง" autocomplete="off"><datalist id="custs2">${custs.map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>
  <div class="filters wrapchips">${custs.map(x => `<button data-a="libcust" data-v="${esc(x)}" aria-selected="${x === c}">${esc(x)} <span class="count">${counts.get(x) || 0}</span></button>`).join('')}</div>
  ${ui.lib.pending ? `<div class="card spechint" style="gap:8px">
      <span class="label">ไฟล์ที่แชร์มา ${ui.lib.pending.length} ไฟล์</span>
      <span class="small">${ui.lib.pending.map(f => esc(f.name)).join(', ')}</span>
      <span class="row"><button class="btn sm primary" data-a="sharedadd" ${c ? '' : 'disabled'}>${c ? 'เพิ่มเข้าคลังของ ' + esc(c) : 'เลือกลูกค้าก่อน'}</button><button class="btn sm ghost" data-a="shareddrop">ทิ้ง</button></span></div>` : ''}
  ${c ? `<div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="spread"><h3>ลายของ ${esc(c)} (${arts.length})</h3>${arts.length ? '<span class="muted small">แตะลายเพื่อแก้ชื่อหรือลบ</span>' : ''}</div>
      ${ed && ed.customer === c ? artEditor(ed) : ''}
      ${artGrid(arts, null, 'editart')}
      ${db.features.files ? uploadZone('lib') : '<div class="banner">ยังไม่ได้เชื่อมที่เก็บไฟล์ R2</div>'}
    </div>` : '<div class="empty">เลือกหรือพิมพ์ชื่อลูกค้าเพื่อดูและเพิ่มลาย</div>'}`;
}
function artEditor(a) {
  const used = screensUsing(a.id);
  return `<div class="artedit">
    <div class="pz ro">${a.preview ? `<img src="${fileUrl(a.preview, true)}" alt="รูปตัวอย่างลาย" data-a="zoomfile" data-v="${a.preview}">` : '<span class="muted small">ไม่มีรูป</span>'}</div>
    <div class="idfields">
      <div class="field"><label for="ae-name">ชื่อลาย (Artwork ID)</label><div class="aiwrap"><input id="ae-name" data-art="name" value="${esc(a.name)}">
        <button class="btn sm" data-a="artai" data-v="${a.id}" ${ui.aiBusy['a:' + a.id] || !a.preview || !db.features.ai ? 'disabled' : ''}>${ui.aiBusy['a:' + a.id] ? 'กำลังคิด…' : '✨ AI'}</button></div></div>
      <div class="field"><label for="ae-ref">Customer ID</label><input id="ae-ref" data-art="customerRef" value="${esc(a.customerRef)}"></div>
      <div class="small">${a.w ? `แป้นคู่ ${a.w.toFixed(0)} × ${a.h.toFixed(0)} mm · ` : ''}${a.filmable ? 'ทำฟิล์มได้' : 'ทำฟิล์มในแอปไม่ได้ (ไม่ใช่ไฟล์ PDF/AI แบบ PDF-compatible)'}</div>
      ${a.file ? `<div class="flist">${fileChip(a.file, false)}</div>` : ''}
      <div class="muted small">${used.length ? `ใช้ใน ${used.length} บล็อค: ${[...new Set(used.map(x => x.j.no))].map(esc).join(', ')}` : 'ยังไม่มีใบงานใช้ลายนี้'}</div>
      <div class="row"><button class="btn sm" data-a="editart" data-v="${a.id}">ปิด</button>
        <button class="btn sm bad" data-a="artdel" data-v="${a.id}">${ui.arm === 'artdel:' + a.id ? (used.length ? 'กดอีกครั้ง: ซ่อนจากคลัง (ใบงานเดิมยังใช้ได้)' : 'กดอีกครั้งเพื่อลบ') : 'ลบลาย'}</button></div>
    </div></div>`;
}
const MM_PT = 72 / 25.4;
// film tools (pdf-lib + the film core) and pdf.js, served with the film page
let filmToolsP = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('โหลด ' + src + ' ไม่ได้')); document.head.appendChild(s); }); }
function loadFilmTools() {
  if (!filmToolsP) filmToolsP = (async () => {
    if (!window.PDFLib) await loadScript('/film/vendor/pdf-lib.min.js');
    await loadPdfJs();
    if (!window.FilmCore) await loadScript('/film/js/film-core.js');
    return window.FilmCore;
  })().catch(e => { filmToolsP = null; throw e; });
  return filmToolsP;
}
let filmSetP = null;
function filmSet() {
  if (!filmSetP) filmSetP = api('GET', '/film-settings').then(d => ({ nearWhite: 5, speckMm: 0.2, ...((d && d.film) || {}) })).catch(() => ({ nearWhite: 5, speckMm: 0.2 }));
  return filmSetP;
}
async function sha256hex(u8) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', u8)); return [...h].map(x => x.toString(16).padStart(2, '0')).join(''); }
// picture of one design (or the whole page) cut out of the page
async function cropPreview(pg, box, max = 640) {
  let c, g;
  if (box) {
    const pad = Math.max(box[2] - box[0], box[3] - box[1]) * 0.04, b = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
    const vp = pg.getViewport({ scale: max / Math.max(b[2] - b[0], b[3] - b[1]) });
    const p1 = vp.convertToViewportPoint(b[0], b[1]), p2 = vp.convertToViewportPoint(b[2], b[3]);
    const x = Math.min(p1[0], p2[0]), y = Math.min(p1[1], p2[1]);
    c = document.createElement('canvas'); c.width = Math.max(1, Math.round(Math.abs(p2[0] - p1[0]))); c.height = Math.max(1, Math.round(Math.abs(p2[1] - p1[1])));
    g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp, transform: [1, 0, 0, 1, -x, -y] }).promise;
  } else {
    const v0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: max / Math.max(v0.width, v0.height) });
    c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp }).promise;
  }
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
}
// customer files -> artwork library: the original is stored once, every design gets its own picture and name
async function addArtworkFiles(customer, files) {
  customer = String(customer || '').trim();
  if (!customer) { toast('ใส่ชื่อลูกค้าก่อน แล้วค่อยอัปโหลดไฟล์ลาย'); return []; }
  const made = [];
  for (const file of files) {
    const job = { name: file.name, msg: 'กำลังอ่านไฟล์…' }; ui.lib.busy.push(job); renderLibBusy();
    const say = m => { job.msg = m; renderLibBusy(); };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()), sha = await sha256hex(bytes);
      if (db.artworks.some(a => a.sha === sha && a.customer === customer && !a.hidden)) { toast('ไฟล์นี้อยู่ในคลังของ ' + customer + ' แล้ว: ' + file.name); continue; }
      const ext = extOf(file.name), base = stem(file.name), items = [];
      if (ext === 'AI' || ext === 'PDF' || file.type === 'application/pdf') {
        say('กำลังหาลายในไฟล์…');
        const C = await loadFilmTools(), fst = await filmSet();
        let n = 0; try { n = await C.pageCount(bytes); } catch (e) { n = 0; }
        let doc = null; try { doc = await window.pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false, verbosity: 0 }).promise; } catch (e) {}
        const pages = Math.max(n, doc ? doc.numPages : 0);
        if (!n) toast(file.name + ': ไม่ได้บันทึกแบบ PDF-compatible จึงแยกลายและทำฟิล์มไม่ได้ (เก็บไฟล์ไว้ในคลังได้)');
        for (let p = 0; p < pages; p++) {
          let designs = [];
          if (n) { try { designs = C.describe(await C.analyze(bytes, base, p), fst).designs; } catch (e) {} }
          const pg = doc ? await doc.getPage(p + 1) : null;
          const tag = k => [pages > 1 ? `หน้า ${p + 1}` : '', designs.length > 1 ? `ลาย ${k + 1}` : ''].filter(Boolean).join(' ');
          if (designs.length) designs.forEach((ds, k) => {
            const box = ds.boxes.reduce((u, f) => [Math.min(u[0], f[0]), Math.min(u[1], f[1]), Math.max(u[2], f[2]), Math.max(u[3], f[3])]);
            items.push({ page: p, design: ds.index, box, w: (box[2] - box[0]) / MM_PT, h: (box[3] - box[1]) / MM_PT, filmable: true, customerRef: tag(k) ? `${base} · ${tag(k)}` : base, pg });
          });
          else items.push({ page: p, design: null, box: null, filmable: false, customerRef: pages > 1 ? `${base} · หน้า ${p + 1}` : base, pg });
        }
        if (!items.length) items.push({ page: 0, filmable: false, customerRef: base });
        say(`พบ ${items.filter(x => x.filmable).length || items.length} ลาย · กำลังทำรูปตัวอย่าง…`);
        for (const it of items) { if (it.pg) { try { it.blob = await cropPreview(it.pg, it.box); } catch (e) {} } delete it.pg; }
        if (doc) doc.destroy();
      } else {
        const blob = /^image\//.test(file.type) || ['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'BMP'].includes(ext) ? await shrink(file, 768, true) : null;
        items.push({ page: 0, filmable: false, customerRef: base, blob });
      }
      say('กำลังอัปโหลด…');
      const same = db.artworks.find(a => a.sha === sha && a.file);
      const orig = same ? { id: same.file } : await uploadFile(file, 'original');
      for (const it of items) { if (it.blob) { try { it.preview = (await uploadFile(it.blob, 'preview', 'preview.jpg')).id; } catch (e) {} } delete it.blob; }
      const r = await api('POST', '/artworks', { customer, items: items.map(it => ({ ...it, name: '', file: orig.id, fileName: file.name, sha })) });
      db.artworks.unshift(...r.items); made.push(...r.items);
      if (!db.master.customers.includes(customer)) db.master.customers.push(customer);
    } catch (e) { toast('เพิ่มลายไม่สำเร็จ: ' + file.name + ' (' + e.message + ')'); }
    finally { ui.lib.busy = ui.lib.busy.filter(b => b !== job); }
    render();
  }
  // AI names, one at a time, without blocking
  (async () => { for (const a of made) if (a.preview && !a.name && db.features.ai) await aiNameArt(a.id, true); })();
  return made;
}
async function aiNameArt(id, quiet) {
  const a = artOf(id); if (!a || !a.preview) return;
  ui.aiBusy['a:' + id] = true; render();
  try {
    const r = await api('POST', '/ai/name', { fileId: a.preview });
    a.name = r.name; await api('PATCH', '/artworks/' + id, { name: r.name });
    if (ui.draft) ui.draft.screens.forEach(s => { if (s.artworkId === id && !String(s.design || '').trim()) s.design = r.name; });
    if (!quiet) toast('AI ตั้งชื่อ: ' + r.name);
  } catch (e) { if (!quiet) toast(e.message); }
  delete ui.aiBusy['a:' + id]; render();
}
function screenFromArt(a) { return { ...blankScreen(), artworkId: a.id, design: a.name || '', customerRef: a.customerRef || '', originals: a.file ? [a.file] : [], preview: a.preview || null }; }
function filmCard(s) {
  const a = s.artworkId ? artOf(s.artworkId) : null, f = s.film;
  if (!f && !(a && a.filmable)) return '';
  const t = encodeURIComponent(token);
  return `<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="spread"><h3>ฟิล์ม</h3>${f ? '<span class="fstate ok">ทำฟิล์มแล้ว</span>' : '<span class="fstate">ยังไม่ทำฟิล์ม</span>'}</div>
    ${f ? `<div class="small">${fmtT(f.at)} โดย ${esc(f.by)}${f.thick ? ` · ความหนาบล็อค <span class="num">${f.thick} µm</span>` : ''}${f.compUm != null ? ` · ชดเชยขอบ <span class="num">${f.compUm} µm</span>` : ''}<br><span class="muted">${esc(f.name)}</span></div>` : '<div class="muted small">ลายนี้ยังไม่ได้ลงแผ่นฟิล์ม</div>'}
    <div class="row">${f ? `<a class="btn sm" href="/api/films/${f.id}?dl=1&t=${t}">ดาวน์โหลดแผ่นฟิล์ม</a><a class="btn sm ghost" href="/api/films/${f.id}?t=${t}" target="_blank" rel="noopener">เปิดดู</a>` : ''}
      ${a && a.filmable ? `<a class="btn sm ${f ? 'ghost' : 'primary'}" href="/film/?add=${s.id}">${f ? 'ทำฟิล์มใหม่' : 'ทำฟิล์ม'}</a>` : ''}</div>
  </div>`;
}
const FILM_DEF = { sheetW: 21, sheetH: 31, margin: 10, gap: 15, markArm: 5, markGrey: 25, labelGrey: 25, markWidthMm: 0.15, nearWhite: 5, speckMm: 0.2, factor: 0.5, defaultThick: 400, labels: true, cropMarks: false, thicknesses: [100, 200, 300, 400, 500, 600, 800] };
const FILM_FIELDS = [['sheetW', 'ขนาดแผ่นฟิล์ม กว้าง', 'นิ้ว'], ['sheetH', 'ยาว', 'นิ้ว'], ['margin', 'ขอบแผ่น', 'mm'], ['gap', 'ช่องห่างระหว่างงาน', 'mm'],
  ['factor', 'ชดเชยขอบอัตโนมัติ = ความหนา ×', ''], ['defaultThick', 'ความหนาเมื่อไม่ระบุลูกค้า', 'µm'], ['markArm', 'ขนาดกากบาท (ครึ่งแขน)', 'mm'], ['markWidthMm', 'ความหนาเส้นกากบาท', 'mm'],
  ['markGrey', 'ความเข้มมาร์ค', '% K'], ['labelGrey', 'ความเข้มชื่องาน', '% K'], ['nearWhite', 'สีที่อ่อนกว่านี้ถือเป็นสีขาว', '% หมึกรวม'], ['speckMm', 'ชิ้นเล็กกว่านี้ถือเป็นเศษ ตัดทิ้ง', 'mm']];
function filmSettingsCard() {
  if (!ui.filmSet) { api('GET', '/film-settings').then(d => { ui.filmSet = { ...FILM_DEF, ...((d && d.film) || {}) }; render(); }).catch(e => toast(e.message)); return '<div class="card muted small">กำลังโหลดการตั้งค่าฟิล์ม…</div>'; }
  const f = ui.filmSet;
  return `<div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div><h3>ฟิล์ม positive</h3><div class="muted small">ใช้กับหน้า "ทำฟิล์ม" ทุกเครื่อง · ความหนาบล็อคของแต่ละงานมาจากใบงาน (หรือสเปคประจำลูกค้าด้านบน)</div></div>
    <div class="grid2">${FILM_FIELDS.map(([k, l, u]) => `<div class="field"><label for="fs-${k}">${l}</label><div class="unit"><input id="fs-${k}" type="number" step="any" min="0" data-fs="${k}" value="${esc(f[k])}">${u ? `<span>${u}</span>` : ''}</div></div>`).join('')}
      <div class="field"><label for="fs-thicknesses">ความหนาที่มีให้เลือกในหน้าฟิล์ม (µm คั่นด้วยจุลภาค)</label><input id="fs-thicknesses" data-fs="thicknesses" value="${esc((f.thicknesses || []).join(', '))}"></div></div>
    <label class="check"><input type="checkbox" id="fs-labels" ${f.labels ? 'checked' : ''}><span>พิมพ์ข้อความใต้ลาย (ลูกค้า ชื่อไฟล์ ความหนา การชดเชย วันที่)</span></label>
    <label class="check"><input type="checkbox" id="fs-cropMarks" ${f.cropMarks ? 'checked' : ''}><span>เส้นตัด (crop mark)</span></label>
    <div class="row" style="justify-content:flex-end"><span class="err" id="fserr"></span><button class="btn primary" data-a="fsave">บันทึกการตั้งค่าฟิล์ม</button></div>
  </div>`;
}

function jobView() {
  const { j } = find(ui.jobId); if (!j) { ui.view = 'list'; return body(); }
  const canDel = true;
  const waitFilm = j.screens.filter(needsFilm);
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <div class="spread"><div><div class="jobno">${esc(j.no)}</div><h2>${esc(j.customer)}</h2></div><span class="${dueCls(j)}">${dueText(j)}</span></div>
  ${canDel ? `<div class="grid2">
    <div class="field"><label for="j-date">วันที่รับงาน</label><input id="j-date" type="date" value="${esc(jobDate(j))}" data-jf="date" data-v="${j.id}"></div>
    <div class="field"><label for="j-due">กำหนดส่ง</label><input id="j-due" type="date" value="${esc(j.due || '')}" data-jf="due" data-v="${j.id}"></div>
  </div>` : `<div class="muted small">รับงาน ${fmtD(jobTs(j))}</div>`}
  ${j.note ? `<div class="card">${esc(j.note)}</div>` : ''}
  <div class="muted small">สั่งโดย ${esc(j.createdBy)} · ${fmtT(j.createdAt)}${j.sentAt ? ` · ส่งลูกค้า ${fmtT(j.sentAt)}` : ''}</div>
  ${waitFilm.length ? `<div class="card spread"><span><b>ยังไม่ทำฟิล์ม ${waitFilm.length} บล็อค</b><br><span class="muted small">เปิดหน้าทำฟิล์มพร้อมบล็อคเหล่านี้ เรียงลงแผ่นได้ร่วมกับงานอื่น</span></span>
    <a class="btn primary" href="/film/?add=${waitFilm.map(s => s.id).join(',')}">ทำฟิล์ม</a></div>` : ''}
  <div class="jobcard">${j.screens.map(s => blockRow(j, s)).join('')}</div>
  <div class="row" style="justify-content:space-between">
    ${canDel ? `<button class="btn bad" data-a="deljob" data-v="${j.id}">${ui.arm === 'deljob' ? 'กดอีกครั้งเพื่อลบใบงานนี้' : 'ลบใบงาน'}</button>` : '<span></span>'}
    ${j.screens.every(s => s.status === 'ready') ? `<button class="btn ok" data-a="sendjob" data-v="${j.id}">บันทึกว่าส่งลูกค้าแล้ว</button>` : ''}
  </div>`;
}

/* --- screen detail --- */
function screenView() {
  const { j, s } = find(ui.jobId, ui.screenId); if (!s) { ui.view = 'list'; return body(); }
  const T = tol();
  const canCoat = ['ordered', 'coating', 'rework'].includes(s.status);
  const canQC = s.status === 'qc';
  const nextSide = s.coats.length && s.coats[s.coats.length - 1].side === 'ด้านพิมพ์' ? 'ด้านปาด' : 'ด้านพิมพ์';
  let h = `<button class="btn ghost back" data-a="back">← กลับ</button>
  <div class="spread"><div><div class="jobno">${esc(j.no)} · ${esc(j.customer)}</div><h2>${esc(s.design || '(ยังไม่ตั้งชื่อ)')}</h2>${s.customerRef ? `<div class="jobno">Customer ID: ${esc(s.customerRef)}</div>` : ''}</div>${chip(s.status)}</div>
  <div class="spec">
    <div><div class="label">ผ้าสกรีน</div><div class="v num">${esc(s.mesh)}</div></div>
    <div><div class="label">เฟรม</div><div class="v">${esc(s.frame)}</div></div>
    <div><div class="label">กาว</div><div class="v">${esc(s.emulsion)}</div></div>
    <div><div class="label">สเปคความหนา</div><div class="v num">${esc(s.target)} ±${T} µm</div></div>
    <div><div class="label">กำหนดส่ง</div><div class="v ${dueCls(j)}">${fmtD(dueTs(j))}</div></div>
  </div>
  ${j.note ? `<div class="card small"><span class="label">หมายเหตุจากอาร์ทเวิร์ค</span><br>${esc(j.note)}</div>` : ''}
  ${s.status === 'rework' && s.qc.note ? `<div class="card" style="border-color:var(--bad)"><span class="label" style="color:var(--bad)">เหตุผลที่ตีกลับ</span><br>${esc(s.qc.note)} <span class="muted small">— ${esc(s.qc.by)} ${fmtT(s.qc.at)}</span></div>` : ''}`;

  if (db.features.files) {
    const art = true;
    s.originals = s.originals || []; s.prepared = s.prepared || [];
    h += `<div class="card" style="display:flex;flex-direction:column;gap:14px">
      <h3>ไฟล์งาน</h3>
      <div class="idrow">
        ${previewZone('s', s, art)}
        <div class="idfields">
          ${art ? `<div class="field"><label for="e-cref">Customer ID</label><input id="e-cref" data-f="customerRef" value="${esc(s.customerRef || '')}"></div>
            ${db.features.ai ? nameField('s', s, 'e-name', 'data-f="design"') : `<div class="field"><label for="e-name">ชื่อลาย</label><input id="e-name" data-f="design" value="${esc(s.design)}"></div>`}`
          : `<div><span class="label">Customer ID</span><div>${esc(s.customerRef || '-')}</div></div><div><span class="label">ชื่อลาย</span><div>${esc(s.design || '-')}</div></div>`}
        </div>
      </div>
      <div class="fsec"><div class="spread"><span class="label">ไฟล์ต้นฉบับจากลูกค้า (${s.originals.length})</span>
        ${art ? `<label class="btn sm" for="af-orig">+ เพิ่ม</label><input id="af-orig" type="file" multiple hidden data-addfile="originals">` : ''}</div>
        <div class="flist">${s.originals.map(id => fileChip(id, art, 's:originals')).join('') || '<span class="muted small">ยังไม่มีไฟล์</span>'}</div></div>
      <div class="fsec"><div class="spread"><span class="label">ไฟล์ที่เตรียมแล้ว ส่งยิงฟิล์ม (${s.prepared.length})</span>
        ${art ? `<label class="btn sm primary" for="af-prep">+ อัปโหลด</label><input id="af-prep" type="file" multiple hidden data-addfile="prepared">` : ''}</div>
        <div class="flist">${s.prepared.map(id => fileChip(id, art, 's:prepared')).join('') || '<span class="muted small">ยังไม่มีไฟล์ที่เตรียม</span>'}</div></div>
      <div id="uploads"></div>
    </div>`;
  }

  h += filmCard(s);
  h += `<div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div class="spread"><h3>รอบขึ้นกาว</h3><span class="muted small num">${s.coats.length} รอบ</span></div>
    <div class="coats">${s.coats.map((c, i) => `<div class="coat"><span class="n">${i + 1}</span>
      <span><b>${esc(c.side)}</b> <span class="muted small">โดย ${esc(c.by)}</span><br><span class="num small">${fmtT(c.t)}</span>${i ? ` <span class="gap">${fmtGap(c.t - s.coats[i - 1].t)}</span>` : ''}</span>
      ${canCoat && i === s.coats.length - 1 ? `<button class="btn sm ghost" data-a="undocoat">ลบ</button>` : '<span></span>'}</div>`).join('') || '<div class="muted small">ยังไม่ได้ขึ้นกาว</div>'}</div>
    ${canCoat ? `<div class="addcoat">
      <button class="btn ${nextSide === 'ด้านพิมพ์' ? 'primary' : ''}" data-a="coat" data-v="ด้านพิมพ์">+ ด้านพิมพ์</button>
      <button class="btn ${nextSide === 'ด้านปาด' ? 'primary' : ''}" data-a="coat" data-v="ด้านปาด">+ ด้านปาด</button></div>
      <div class="muted small">กดตอนเริ่มปาดแต่ละรอบ ระบบบันทึกเวลาให้อัตโนมัติ</div>` : ''}
    <div class="thick">
      ${thickField('thBefore', 'ความหนาก่อนถ่ายบล็อค', s, canCoat)}
      ${thickField('thAfter', 'ความหนาหลังถ่ายบล็อค / ล้างแล้ว', s, canCoat)}
    </div>
    <div class="field"><label for="c-note">หมายเหตุการขึ้นบล็อค</label>${canCoat ? `<textarea id="c-note" data-f="coatNote" placeholder="สภาพห้อง เวลาถ่าย ปัญหาที่พบ">${esc(s.coatNote)}</textarea>` : `<div>${esc(s.coatNote) || '<span class="muted">-</span>'}</div>`}</div>
    ${canCoat ? `<div class="row" style="justify-content:flex-end"><span class="err" id="cerr"></span><button class="btn primary" data-a="toqc">เสร็จแล้ว ส่งตรวจ</button></div>` : ''}
  </div>`;

  if (['qc', 'ready', 'sent', 'rework'].includes(s.status) || s.photos.length) {
    const ro = !canQC;
    h += `<div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="spread"><h3>ตรวจงานก่อนส่ง</h3><span class="muted small">${s.photos.length} รูป</span></div>
      <div class="photos">${s.photos.map((p, i) => `<div class="ph"><img src="${photoSrc(p.id)}" alt="รูปที่ ${i + 1}" loading="lazy" data-a="zoom" data-v="${p.id}"><span class="cap">${esc(p.by)} ${fmtT(p.t)}</span>${ro ? '' : `<button class="x" data-a="delph" data-v="${p.id}" aria-label="ลบรูป">✕</button>`}</div>`).join('')}
        ${ro ? '' : `<label class="addph" for="phin">${ui.busy ? 'กำลังอัปโหลด…' : '+ ถ่าย/เลือกรูป<br><span class="small">หลายมุม</span>'}</label>`}</div>
      ${ro ? '' : `<input id="phin" type="file" accept="image/*" multiple hidden>`}
      <div class="checks">${QC_CHECKS.map(([k, t]) => `<label class="check"><input type="checkbox" data-chk="${k}" ${s.qc.checks[k] ? 'checked' : ''} ${ro ? 'disabled' : ''}><span>${t}</span></label>`).join('')}
        <div class="check" style="cursor:default"><span style="width:20px;text-align:center">${s.thAfter !== '' && Math.abs(s.thAfter - s.target) <= T ? '✓' : '!'}</span><span>ความหนาหลังถ่าย ${s.thAfter === '' ? '<span class="muted">ยังไม่มีค่า</span>' : `<span class="num">${s.thAfter} µm</span> ${delta(+s.thAfter, +s.target)}`}</span></div></div>
      <div class="field"><label for="q-note">หมายเหตุการตรวจ</label>${ro ? `<div>${esc(s.qc.note) || '<span class="muted">-</span>'}${s.qc.by ? ` <span class="muted small">— ${esc(s.qc.by)} ${fmtT(s.qc.at)}</span>` : ''}</div>` : `<textarea id="q-note" data-q="note" placeholder="ถ้าตีกลับ ระบุสิ่งที่ต้องแก้">${esc(s.qc.note)}</textarea>`}</div>
      ${canQC ? `<div class="row" style="justify-content:flex-end"><span class="err" id="qerr"></span><button class="btn bad" data-a="rework">ตีกลับแก้ไข</button><button class="btn ok" data-a="pass">ผ่าน พร้อมส่ง</button></div>` : ''}
    </div>`;
  }
  if (s.log.length) h += `<div class="timeline"><span class="label">ประวัติ</span>${s.log.map(l => `<span><span class="num">${fmtT(l[0])}</span> · ${esc(l[1])} · ${esc(l[2])}</span>`).join('')}</div>`;
  return h;
}
function thickField(k, label, s, edit) {
  const v = s[k];
  return `<div class="field"><label for="th-${k}">${label}</label>
    ${edit ? `<div class="unit"><input id="th-${k}" type="number" inputmode="numeric" data-f="${k}" value="${esc(v)}" placeholder="วัดจริง"><span>µm</span></div>` : `<div class="v num" style="font-weight:600">${v === '' ? '-' : v + ' µm'}</div>`}
    <div class="meter" id="m-${k}">${v !== '' ? delta(+v, +s.target) : ''}</div></div>`;
}

/* --- settings (admin) --- */
function settingsView() {
  if (!ui.admin) { api('GET', '/admin/users').then(u => { ui.admin = u; render(); }).catch(e => toast(e.message)); return '<div class="loading">กำลังโหลด…</div>'; }
  const m = db.master;
  const eu = ui.editUser;
  const form = (u) => `<div class="uform">
      <div class="grid2">
        <div class="field"><label for="u-name">ชื่อที่แสดง</label><input id="u-name" data-u="name" value="${esc(u.name)}"></div>
        <div class="field"><label for="u-pin">${u.id ? 'PIN ใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'PIN 4 หลัก'}</label><input id="u-pin" data-u="pin" inputmode="numeric" maxlength="4" value="${esc(u.pin || '')}" autocomplete="off"></div>
        ${u.id ? `<label class="check" style="align-self:end"><input type="checkbox" data-u="active" ${u.active ? 'checked' : ''}><span>ใช้งานอยู่</span></label>` : ''}
      </div>
      <div class="row" style="justify-content:flex-end"><span class="err" id="uerr"></span><button class="btn ghost" data-a="ucancel">ยกเลิก</button><button class="btn primary" data-a="usave">บันทึก</button></div></div>`;
  const fx = db.features || {};
  const stat = (on, name, what) => `<div class="urow"><span class="fstate ${on ? 'ok' : ''}">${on ? 'เชื่อมแล้ว' : 'ยังไม่เชื่อม'}</span><span><b>${name}</b><br><span class="muted small">${what}</span></span><span></span></div>`;
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <h2>ตั้งค่า</h2>
  <div class="card">
    <h3>สถานะระบบ</h3>
    ${stat(true, 'ฐานข้อมูล D1', 'ใบงาน รอบขึ้นกาว รูปตรวจงาน')}
    ${stat(fx.files, 'ที่เก็บไฟล์ R2', 'ไฟล์ลูกค้า ไฟล์ที่เตรียม รูปตัวอย่างลาย')}
    ${stat(fx.ai, 'Workers AI', 'ตั้งชื่อลายจากรูป')}
    ${!fx.files || !fx.ai ? '<div class="banner" style="margin-top:8px">ถ้ายังไม่เชื่อม: ตรวจว่าไฟล์ wrangler.jsonc มีส่วน "r2_buckets" และ "ai" แล้ว deploy ใหม่ (ดู README หัวข้อ "แก้ปัญหา")</div>' : ''}
  </div>
  <div class="card">
    <div class="spread"><h3>พนักงานและ PIN</h3>${eu ? '' : '<button class="btn sm primary" data-a="uadd">+ เพิ่มพนักงาน</button>'}</div>
    ${eu && !eu.id ? form(eu) : ''}
    ${ui.admin.map(u => eu && eu.id === u.id ? form(eu) : `<div class="urow ${u.active ? '' : 'off'}"><span class="av artwork">${esc(u.name[0])}</span>
      <span><b>${esc(u.name)}</b>${u.active ? '' : '<br><span class="muted small">ปิดใช้งาน</span>'}</span>
      <button class="btn sm" data-a="uedit" data-v="${u.id}">แก้ไข</button></div>`).join('')}
  </div>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <h3>รายการให้เลือก</h3><div class="muted small">พิมพ์บรรทัดละ 1 รายการ</div>
    <div class="grid2">
      ${[['mesh', 'เบอร์ผ้าสกรีน'], ['frames', 'ขนาดเฟรม'], ['emulsions', 'ชนิดกาว'], ['customers', 'ลูกค้า']].map(([k, l]) => `<div class="field"><label for="ms-${k}">${l}</label><textarea id="ms-${k}" data-m="${k}" rows="6">${esc(m[k].join('\n'))}</textarea></div>`).join('')}
      <div class="field"><label for="ms-def">ความหนาเริ่มต้นของบล็อคใหม่</label><div class="unit"><input id="ms-def" type="number" data-m="defaultTarget" value="${esc(defTarget())}"><span>µm</span></div></div>
      <div class="field"><label for="ms-tol">ค่าความหนาที่ยอมรับได้ (±)</label><div class="unit"><input id="ms-tol" type="number" data-m="tolerance" value="${esc(tol())}"><span>µm</span></div></div>
    </div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-a="msave">บันทึกรายการ</button></div>
  </div>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div><h3>สเปคประจำลูกค้า</h3><div class="muted small">ใส่ให้อัตโนมัติเมื่อสร้างใบงานของลูกค้านั้น ระบบจำให้เองจากใบงานแรกของลูกค้าใหม่ แก้ที่นี่ได้</div></div>
    ${m.customers.length ? m.customers.map((c, i) => { const cs = (m.customerSpecs || {})[c] || {}, sel = (arr, v, k) => `<select data-cs="${i}" data-k="${k}" aria-label="${k}"><option value="">-</option>${(v && !arr.includes(v) ? [v, ...arr] : arr).map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
      return `<div class="csrow"><b>${esc(c)}</b><div class="csgrid">${sel(m.frames, cs.frame, 'frame')}${sel(m.mesh, cs.mesh, 'mesh')}${sel(m.emulsions, cs.emulsion, 'emulsion')}<div class="unit"><input type="number" data-cs="${i}" data-k="target" value="${esc(cs.target || '')}" placeholder="ความหนา" aria-label="ความหนา"><span>µm</span></div></div></div>`; }).join('') : '<div class="muted small">ยังไม่มีลูกค้า</div>'}
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-a="msave">บันทึกสเปคประจำ</button></div>
  </div>
  ${filmSettingsCard()}
  <div class="card spread"><div><h3>สำรองข้อมูล</h3><div class="muted small">ไฟล์ CSV เปิดด้วย Excel ได้ ทุกบล็อคทุกใบงาน</div></div>
    <a class="btn" href="/api/export.csv?t=${encodeURIComponent(token)}">ดาวน์โหลด CSV</a></div>`;
}

/* ---------- actions ---------- */
function go(view, o = {}) { Object.assign(ui, { view, arm: null }, o); render(); window.scrollTo(0, 0); }
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  const a = el.dataset.a, v = el.dataset.v;
  if (a !== 'deljob' && a !== 'delfile') ui.arm = null;
  const cur = () => find(ui.jobId, ui.screenId);
  switch (a) {
    case 'pick': ui.pickUser = v; ui.pin = ''; ui.pinErr = ''; render(); break;
    case 'pickback': ui.pickUser = null; render(); break;
    case 'reloadusers': loadUsers(); break;
    case 'pin':
      if (ui.pin.length < 4) { ui.pin += v; ui.pinErr = ''; }
      render();
      if (ui.pin.length === 4) {
        ui.busy = true; render();
        try {
          const r = await api('POST', '/login', { userId: ui.pickUser, pin: ui.pin });
          token = r.token; try { localStorage.setItem(TOKEN_KEY, token); } catch (x) {}
          ui.user = r.user; ui.pickUser = null; ui.tab = null; ui.view = 'list';
          await loadData();
          takeShared();
        } catch (x) {
          ui.pinErr = x.message === 'locked' ? 'ใส่ผิดหลายครั้ง ระบบล็อก 5 นาที' : x.message === 'wrong_pin' ? `PIN ไม่ถูกต้อง (เหลือ ${x.data.left} ครั้ง)` : x.message;
        }
        ui.pin = ''; ui.busy = false; render();
      }
      break;
    case 'pindel': ui.pin = ui.pin.slice(0, -1); render(); break;
    case 'logout': try { await api('POST', '/logout'); } catch (x) {} signOutLocal(); break;
    case 'refresh': await loadData(); toast('อัปเดตแล้ว'); break;
    case 'tab': go('list', { tab: v }); break;
    case 'clearq': ui.q = ''; render(); setTimeout(() => { const el = $('#q'); if (el) el.focus(); }); break;
    case 'settings': ui.admin = null; ui.editUser = null; ui.filmSet = null; go('settings'); break;
    case 'nav': go(v === 'library' ? 'library' : 'list'); break;
    case 'groupby': ui.groupBy = v; try { localStorage.setItem('stencil-groupby', v); } catch (x) {} updateResults(); break;
    case 'libcust': ui.lib.cust = v; ui.lib.edit = null; render(); break;
    case 'sharedadd': { const fs = ui.lib.pending || []; ui.lib.pending = null; render(); await addArtworkFiles(ui.lib.cust, fs); break; }
    case 'shareddrop': ui.lib.pending = null; render(); break;
    case 'editart': ui.lib.edit = ui.lib.edit === v ? null : v; render(); break;
    case 'artai': aiNameArt(v); break;
    case 'artdel': {
      if (ui.arm !== 'artdel:' + v) { ui.arm = 'artdel:' + v; render(); break; }
      ui.arm = null;
      try { const r = await api('DELETE', '/artworks/' + v); const a = artOf(v);
        if (r.hidden && a) a.hidden = true; else db.artworks = db.artworks.filter(x => x.id !== v);
        ui.lib.edit = null; toast(r.hidden ? 'ซ่อนลายจากคลังแล้ว (ใบงานเดิมยังเปิดได้)' : 'ลบลายแล้ว'); render(); } catch (x) { toast(x.message); }
      break;
    }
    case 'pickart': {
      const d = ui.draft, a = artOf(v); if (!a) break;
      const has = d.screens.some(x => x.artworkId === v);
      if (has) d.screens = d.screens.filter(x => x.artworkId !== v);
      else d.screens.push(screenFromArt(a));
      render(); break;
    }
    case 'fsave': {
      const f = { ...ui.filmSet }, er = $('#fserr');
      for (const [k] of FILM_FIELDS) { const n = parseFloat($('#fs-' + k).value); if (!isFinite(n) || n < 0) return er.textContent = 'ช่องที่ต้องเป็นตัวเลขยังไม่ถูกต้อง'; f[k] = n; }
      f.thicknesses = [...new Set($('#fs-thicknesses').value.split(/[,\s]+/).filter(Boolean).map(Number).filter(x => isFinite(x) && x >= 0))].sort((a, b) => a - b);
      f.labels = $('#fs-labels').checked; f.cropMarks = $('#fs-cropMarks').checked;
      try {
        const r = await api('PUT', '/film-settings', { film: f, baseUpdated: ui.filmSet.updated || 0 });
        ui.filmSet = { ...FILM_DEF, ...r.film }; filmSetP = null; toast('บันทึกการตั้งค่าฟิล์มแล้ว'); render();
      } catch (x) {
        if (x.status === 409) { ui.filmSet = { ...FILM_DEF, ...x.data.film }; render(); toast('มีคนบันทึกการตั้งค่าฟิล์มก่อนหน้า แสดงค่าล่าสุดแล้ว ตรวจแล้วกดบันทึกอีกครั้ง'); }
        else toast(x.message);
      }
      break;
    }
    case 'back': go(ui.view === 'screen' && ui.backTo === 'job' ? 'job' : 'list'); break;
    case 'newjob':
      ui.draft = { customer: '', specApplied: '', date: localDate(), due: localDate(Date.now() + 3 * 864e5), note: '', screens: [] };
      go('newjob'); break;
    case 'addscreen': ui.draft.screens.push(blankScreen()); render(); break;
    case 'dupscreen': { const src = ui.draft.screens[v]; ui.draft.screens.splice(+v + 1, 0, { ...src, originals: [...(src.originals || [])], key: Math.random().toString(36).slice(2) }); render(); break; }
    case 'delscreen': ui.draft.screens.splice(+v, 1); render(); break;
    case 'savejob': {
      const d = ui.draft, er = $('#jerr');
      if (!d.customer.trim()) return er.textContent = 'กรุณาใส่ชื่อลูกค้า';
      if (!d.screens.length) return er.textContent = 'เลือกลายอย่างน้อย 1 ลาย';
      if (ui.lib.busy.length) return er.textContent = 'รอให้เพิ่มไฟล์ลายเสร็จก่อน';
      if (ui.uploads.length || Object.keys(ui.prevBusy).length || Object.keys(ui.aiBusy).length) return er.textContent = 'รอให้อัปโหลดไฟล์ / AI ทำงานเสร็จก่อน';
      d.screens.forEach(s => { const a = s.artworkId && artOf(s.artworkId); if (a && !String(s.design || '').trim()) s.design = a.name || a.customerRef || ''; });
      if (d.screens.some(s => !String(s.design || '').trim() || !s.target)) return er.textContent = 'ใส่ชื่อลายและสเปคความหนาให้ครบทุกบล็อค';
      ui.busy = true; render();
      try {
        const r = await api('POST', '/jobs', { customer: d.customer.trim(), date: d.date, due: d.due, note: d.note.trim(), screens: d.screens.map(({ key, ...s }) => s) });
        ui.busy = false; await loadData(); toast(`สร้าง ${r.no} แล้ว`); go('job', { jobId: r.id });
      } catch (x) { ui.busy = false; render(); toast('สร้างใบงานไม่สำเร็จ: ' + x.message); }
      break;
    }
    case 'deljob':
      if (ui.arm !== 'deljob') { ui.arm = 'deljob'; render(); break; }
      try { await api('DELETE', '/jobs/' + v); await loadData(); toast('ลบใบงานแล้ว'); go('list'); } catch (x) { toast(x.message); }
      break;
    case 'openjob': go('job', { jobId: v }); break;
    case 'openscreen': { const back = ui.view === 'job' ? 'job' : 'list'; go('screen', { jobId: el.dataset.j, screenId: v, backTo: back }); break; }
    case 'coat': {
      const { s } = cur(); s.coats.push({ t: Date.now(), side: v, by: ui.user.name });
      if (s.status === 'ordered' || s.status === 'rework') { logEv(s, s.status === 'rework' ? 'เริ่มแก้งานตีกลับ' : 'เริ่มขึ้นกาว'); s.status = 'coating'; }
      render(); if (await saveScreen(s)) toast(`บันทึกรอบที่ ${s.coats.length} แล้ว`); break;
    }
    case 'undocoat': { const { s } = cur(); s.coats.pop(); render(); saveScreen(s); break; }
    case 'toqc': {
      const { s } = cur();
      if (!s.coats.length) return $('#cerr').textContent = 'ยังไม่มีรอบขึ้นกาว';
      if (s.thAfter === '') return $('#cerr').textContent = 'ใส่ความหนาหลังถ่ายบล็อคก่อนส่งตรวจ';
      s.status = 'qc'; logEv(s, 'ส่งตรวจ');
      if (await saveScreen(s)) { toast('ส่งให้ฝ่ายตรวจแล้ว'); go('list'); }
      break;
    }
    case 'delph': {
      const { s } = cur();
      try { await api('DELETE', '/photos/' + v); s.photos = s.photos.filter(p => p.id !== v); render(); } catch (x) { toast(x.message); }
      break;
    }
    case 'zoom': $('#lbimg').src = photoSrc(v); $('#lb').hidden = false; break;
    case 'zoomfile': $('#lbimg').src = fileUrl(v, true); $('#lb').hidden = false; break;
    case 'ainame': aiName(v); break;
    case 'delfile': {
      // data-k = "d:<row>:originals" (ฟอร์มใหม่) หรือ "s:<originals|prepared>" (บล็อคที่เปิดอยู่)
      const parts = el.dataset.k.split(':'), list = parts.pop(), o = targetObj(parts.join(':'));
      if (!o) break;
      if (ui.arm !== 'delfile:' + v) { ui.arm = 'delfile:' + v; el.textContent = 'ลบ?'; el.classList.add('armed'); break; }
      ui.arm = null;
      o[list] = (o[list] || []).filter(x => x !== v);
      const shared = (ui.draft ? ui.draft.screens : []).concat(allScreens().map(x => x.s)).some(x => (x.originals || []).includes(v) || (x.prepared || []).includes(v))
        || db.artworks.some(a => a.file === v || a.preview === v);
      if (!shared) api('DELETE', '/files/' + v).catch(() => {});
      persistTarget(parts.join(':')); render(); break;
    }
    case 'pass': {
      const { s } = cur();
      if (s.photos.length < 2) return $('#qerr').textContent = 'ถ่ายรูปอย่างน้อย 2 มุมก่อนผ่าน';
      if (QC_CHECKS.some(([k]) => !s.qc.checks[k])) return $('#qerr').textContent = 'ติ๊กรายการตรวจให้ครบ';
      Object.assign(s.qc, { by: ui.user.name, at: Date.now() }); s.status = 'ready'; logEv(s, 'ผ่านตรวจ พร้อมส่ง');
      if (await saveScreen(s)) { toast('พร้อมส่งแล้ว'); go('list'); }
      break;
    }
    case 'rework': {
      const { s } = cur();
      if (!s.qc.note.trim()) return $('#qerr').textContent = 'ระบุเหตุผลที่ตีกลับในหมายเหตุ';
      Object.assign(s.qc, { by: ui.user.name, at: Date.now() }); s.status = 'rework'; logEv(s, 'ตีกลับแก้ไข');
      if (await saveScreen(s)) { toast('ตีกลับให้ฝ่ายขึ้นบล็อคแล้ว'); go('list'); }
      break;
    }
    case 'sendjob': {
      const { j } = find(v);
      j.screens.forEach(s => { s.status = 'sent'; logEv(s, 'ส่งลูกค้าแล้ว'); });
      const ok = await Promise.all(j.screens.map(saveScreen));
      try { await api('PATCH', '/jobs/' + j.id, { sentAt: Date.now() }); } catch (x) {}
      if (ok.every(Boolean)) toast('บันทึกการส่งแล้ว');
      await loadData(); break;
    }
    case 'uadd': ui.editUser = { name: '', role: 'artwork', pin: '', active: true }; render(); break;
    case 'uedit': { const u = ui.admin.find(x => x.id === v); ui.editUser = { ...u, active: !!u.active, pin: '' }; render(); break; }
    case 'ucancel': ui.editUser = null; render(); break;
    case 'usave': {
      const u = ui.editUser, er = $('#uerr');
      if (!u.name.trim()) return er.textContent = 'ใส่ชื่อ';
      if ((u.pin || !u.id) && !/^\d{4}$/.test(u.pin)) return er.textContent = 'PIN ต้องเป็นตัวเลข 4 หลัก';
      try {
        await api('POST', '/admin/users', { ...u, name: u.name.trim() });
        ui.editUser = null; ui.admin = await api('GET', '/admin/users'); render(); toast('บันทึกแล้ว');
      } catch (x) { er.textContent = x.message; }
      break;
    }
    case 'msave': {
      const m = { ...db.master };
      for (const k of ['mesh', 'frames', 'emulsions', 'customers']) m[k] = $('#ms-' + k).value.split('\n').map(x => x.trim()).filter(Boolean);
      m.tolerance = Number($('#ms-tol').value) || 10;
      m.defaultTarget = Number($('#ms-def').value) || 400;
      // สเปคประจำลูกค้า: อ่านจากตาราง แล้วเก็บเฉพาะลูกค้าที่ยังอยู่ในรายการ
      const specs = {};
      db.master.customers.forEach((c, i) => {
        const g = k => { const el = document.querySelector(`[data-cs="${i}"][data-k="${k}"]`); return el ? el.value.trim() : ''; };
        const sp = { frame: g('frame'), mesh: g('mesh'), emulsion: g('emulsion'), target: Number(g('target')) || '' };
        if (m.customers.includes(c) && (sp.frame || sp.mesh || sp.emulsion || sp.target)) specs[c] = sp;
      });
      m.customerSpecs = specs;
      try { await api('PUT', '/master', m); db.master = m; toast('บันทึกรายการแล้ว'); render(); } catch (x) { toast(x.message); }
      break;
    }
  }
});
$('#lb').addEventListener('click', () => $('#lb').hidden = true);

function updateResults() { const el = $('#q'), r = $('#homeres'); if (el) ui.q = el.value; if (r) r.innerHTML = homeResults(); }
// คีย์บอร์ดมือถือบางรุ่นส่งคำทีละช่วง: เช็กค่าซ้ำเมื่อพิมพ์จบคำหรือปล่อยปุ่ม
for (const ev of ['compositionupdate', 'compositionend', 'keyup']) document.addEventListener(ev, e => { if (e.target && e.target.id === 'q') { clearTimeout(ui.qTimer); ui.qTimer = setTimeout(updateResults, 120); } });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.search) {
    ui.q = t.value;
    const x = t.parentNode.querySelector('[data-a="clearq"]'); if (x) x.hidden = !ui.q;
    // อัปเดตเฉพาะผลค้นหา (ไม่วาดช่องพิมพ์ใหม่) จึงทำได้แม้คีย์บอร์ดยังขีดเส้นใต้คำที่กำลังพิมพ์อยู่
    clearTimeout(ui.qTimer); ui.qTimer = setTimeout(updateResults, 120);
    return;
  }
  if (t.dataset.d) {
    const k = t.dataset.d, d = ui.draft; d[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'customer') {
      // ลายที่เลือกไว้ของลูกค้าอื่นออกจากใบงาน
      const nm = t.value.trim(), before = d.screens.length;
      d.screens = d.screens.filter(x => !x.artworkId || (artOf(x.artworkId) || {}).customer === nm);
      if (allCustomers().includes(nm) || before !== d.screens.length) { if (d.libFor !== nm) { d.libFor = nm; render(); } }
      else if (d.libFor) { d.libFor = ''; render(); }
      // เลือกลูกค้าที่มีสเปคประจำ: ใส่สเปคให้ทุกบล็อคทันที
      const name = t.value.trim(), cs = custSpec(name);
      if (cs && d.specApplied !== name) { d.screens.forEach(s => Object.assign(s, { mesh: cs.mesh || s.mesh, frame: cs.frame || s.frame, emulsion: cs.emulsion || s.emulsion, target: cs.target || s.target })); d.specApplied = name; render(); }
      else if (!cs && name && d.specApplied) { d.specApplied = ''; render(); }
      else if (!name && d.specApplied) { d.specApplied = ''; render(); }
    }
    return;
  }
  if (t.dataset.s) { ui.draft.screens[+t.dataset.s][t.dataset.k] = t.value; return; }
  if (t.dataset.u && ui.editUser) { ui.editUser[t.dataset.u] = t.type === 'checkbox' ? t.checked : t.value; return; }
  if (ui.view !== 'screen') return;
  const { s } = find(ui.jobId, ui.screenId); if (!s) return;
  if (t.dataset.f) {
    const k = t.dataset.f, isNum = k === 'thBefore' || k === 'thAfter';
    s[k] = !isNum ? t.value : (t.value === '' ? '' : +t.value);
    if (isNum) { const m = $('#m-' + k); if (m) m.innerHTML = s[k] !== '' ? delta(s[k], +s.target) : ''; }
    saveScreenLater(s); return;
  }
  if (t.dataset.q) { s.qc.note = t.value; saveScreenLater(s); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.u && ui.editUser) { ui.editUser[t.dataset.u] = t.type === 'checkbox' ? t.checked : t.value; return; }
  if (t.dataset.s) { ui.draft.screens[+t.dataset.s][t.dataset.k] = t.value; if (t.tagName === 'SELECT') render(); return; }
  if (t.dataset.d === 'customer') { render(); return; }
  if (t.dataset.libcust) { ui.lib.cust = t.value.trim(); ui.lib.edit = null; render(); return; }
  if (t.dataset.art && ui.lib.edit) {
    const a = artOf(ui.lib.edit), k = t.dataset.art; if (!a) return;
    const old = a[k]; a[k] = t.value.trim();
    try { await api('PATCH', '/artworks/' + a.id, { [k]: a[k] }); toast('บันทึกแล้ว'); } catch (x) { a[k] = old; toast('บันทึกไม่สำเร็จ: ' + x.message); }
    render(); return;
  }
  if (t.dataset.libfiles && t.files.length) {
    const fs = [...t.files]; t.value = '';
    const cust = ui.view === 'newjob' ? ui.draft.customer.trim() : ui.lib.cust;
    const made = await addArtworkFiles(cust, fs);
    if (ui.view === 'newjob' && ui.draft) { made.filter(a => !ui.draft.screens.some(x => x.artworkId === a.id)).forEach(a => ui.draft.screens.push(screenFromArt(a))); render(); }
    return;
  }
  if (t.dataset.jf) {
    const { j } = find(t.dataset.v); if (!j || !t.value) return;
    const k = t.dataset.jf, old = j[k]; j[k] = t.value;
    try { await api('PATCH', '/jobs/' + j.id, { [k]: t.value }); toast('บันทึกแล้ว'); render(); }
    catch (x) { j[k] = old; toast('บันทึกไม่สำเร็จ: ' + x.message); render(); }
    return;
  }
  if (t.dataset.chk) { const { s } = find(ui.jobId, ui.screenId); s.qc.checks[t.dataset.chk] = t.checked ? 1 : 0; saveScreen(s); return; }
  if (t.dataset.rowfile != null && t.files.length) { const fs = [...t.files]; t.value = ''; addCustomerFiles(fs, +t.dataset.rowfile); return; }
  if (t.dataset.pv && t.files.length) { const f = t.files[0]; t.value = ''; setPreview(t.dataset.pv, f); return; }
  if (t.dataset.addfile && t.files.length) {
    const fs = [...t.files], list = t.dataset.addfile; t.value = '';
    const { s } = find(ui.jobId, ui.screenId); if (!s) return;
    for (const file of fs) {
      try {
        const f = await uploadFile(file, list === 'prepared' ? 'prepared' : 'original');
        (s[list] = s[list] || []).push(f.id);
        if (list === 'prepared') logEv(s, 'อัปโหลดไฟล์ที่เตรียม: ' + f.name);
        if (list === 'originals' && !s.customerRef) s.customerRef = stem(file.name);
        await saveScreen(s); render();
        if (list === 'originals' && !s.preview) { const blob = await previewFromFile(file); if (blob) await setPreview('s', new File([blob], 'preview.jpg', { type: 'image/jpeg' })); }
      } catch (x) { toast('อัปโหลดไม่สำเร็จ: ' + x.message); }
    }
    toast('อัปโหลดเสร็จแล้ว');
    return;
  }
  if (t.id === 'phin' && t.files.length) {
    const { s } = find(ui.jobId, ui.screenId), files = [...t.files];
    ui.busy = true; render();
    let n = 0;
    for (const f of files) {
      try {
        const blob = await shrink(f); if (!blob) continue;
        const p = await api('POST', `/screens/${s.id}/photos`, blob, true);
        s.photos.push(p); n++;
      } catch (x) { toast('อัปโหลดรูปไม่สำเร็จ: ' + x.message); }
    }
    ui.busy = false; render(); if (n) toast(`เพิ่ม ${n} รูปแล้ว`);
  }
});
// วางรูปจากคลิปบอร์ด (Ctrl+V) ลงช่องรูปตัวอย่าง
document.addEventListener('paste', e => {
  const item = [...((e.clipboardData && e.clipboardData.items) || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item || !ui.user) return;
  const ae = document.activeElement, z = ae && ae.closest && ae.closest('[data-zone]');
  let t = z ? z.dataset.zone : null;
  if (!t && ui.view === 'newjob' && ui.draft && ui.draft.screens.length === 1) t = 'd:0';
  if (!t && ui.view === 'screen' && document.querySelector('[data-zone="s"]')) t = 's';
  if (!t) { if (ui.view === 'newjob') toast('คลิกที่ช่องรูปของลายที่ต้องการก่อน แล้วกด Ctrl+V'); return; }
  e.preventDefault(); setPreview(t, item.getAsFile());
});
// ลากไฟล์มาวาง: ช่องไฟล์ลูกค้า หรือช่องรูปตัวอย่าง
document.addEventListener('dragover', e => { if (e.target.closest && e.target.closest('[data-zone],[data-drop]')) { e.preventDefault(); e.target.closest('[data-zone],[data-drop]').classList.add('over'); } });
document.addEventListener('dragleave', e => { const z = e.target.closest && e.target.closest('[data-zone],[data-drop]'); if (z) z.classList.remove('over'); });
document.addEventListener('drop', e => {
  const z = e.target.closest && e.target.closest('[data-zone],[data-drop]'); if (!z) return;
  e.preventDefault(); z.classList.remove('over');
  const fs = [...e.dataTransfer.files]; if (!fs.length) return;
  if (z.dataset.drop === 'lib') {
    const cust = ui.view === 'newjob' ? ui.draft.customer.trim() : ui.lib.cust;
    addArtworkFiles(cust, fs).then(made => { if (ui.view === 'newjob' && ui.draft) { made.filter(a => !ui.draft.screens.some(x => x.artworkId === a.id)).forEach(a => ui.draft.screens.push(screenFromArt(a))); render(); } });
  }
  else if (fs[0].type.startsWith('image/')) setPreview(z.dataset.zone, fs[0]);
  else previewFromFile(fs[0]).then(b => b ? setPreview(z.dataset.zone, new File([b], 'preview.jpg', { type: 'image/jpeg' })) : toast('ไฟล์นี้ทำรูปตัวอย่างไม่ได้ ลองวางภาพหน้าจอแทน'));
});

// ย่อรูปก่อนอัปโหลด: ด้านยาวสุด 1280px (หรือที่กำหนด), JPEG 70%
function shrink(file, max = 1280, whiteBg) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width || 768, h = img.naturalHeight || img.height || 768;
      const k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      const g = c.getContext('2d');
      if (whiteBg) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); c.toBlob(b => res(b), 'image/jpeg', 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}

// อัปเดตข้อมูลจากคนอื่นทุก 30 วินาที และเมื่อกลับมาเปิดแอป
setInterval(() => { if (ui.user && !document.hidden && !isEditing()) loadData(true); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.user && !isEditing()) loadData(true); });
window.addEventListener('beforeunload', e => { if (pending > 0 || Object.keys(timers).length) { e.preventDefault(); e.returnValue = ''; } });

// ไฟล์ที่แชร์มาจากแอปอื่น (LINE, อีเมล, ไฟล์): service worker เก็บไว้ใน cache แล้วเปิด /?share=…
async function takeShared() {
  const q = new URLSearchParams(location.search); if (!q.has('share')) return;
  history.replaceState(null, '', location.pathname);
  if (!window.caches) return;
  try {
    const cache = await caches.open('film-share'), files = [];
    for (const k of await cache.keys()) {
      const r = await cache.match(k); if (!r) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      let name = decodeURIComponent(r.headers.get('x-name') || '') || 'shared';
      if (!/\.[a-z0-9]{2,4}$/i.test(name)) {   // some apps share without a usable extension: look at the bytes
        const head = String.fromCharCode.apply(null, buf.subarray(0, 1024));
        if (head.indexOf('%PDF') >= 0) name += '.pdf'; else if (buf[0] === 0xff && buf[1] === 0xd8) name += '.jpg'; else if (head.slice(1, 4) === 'PNG') name += '.png';
      }
      files.push(new File([buf], name, { type: r.headers.get('content-type') || '' })); await cache.delete(k);
    }
    if (files.length) { ui.lib.pending = files; go('library'); toast(`รับไฟล์ที่แชร์มา ${files.length} ไฟล์ เลือกลูกค้าแล้วกดเพิ่มเข้าคลัง`); }
    else if (q.get('share') === 'none') toast('ไม่ได้รับไฟล์จากการแชร์ ลองแชร์อีกครั้ง');
  } catch (e) { toast('รับไฟล์ที่แชร์มาไม่สำเร็จ: ' + e.message); }
}

// เริ่มต้น
try { ui.groupBy = localStorage.getItem('stencil-groupby') === 'customer' ? 'customer' : 'date'; } catch (e) {}
if (token) loadData().then(() => { if (!ui.user) loadUsers(); else takeShared(); }); else loadUsers();
})();
