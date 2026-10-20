(function () {
'use strict';
const ROLES = { artwork: 'ฝ่ายอาร์ทเวิร์ค', coater: 'ฝ่ายขึ้นบล็อค', qc: 'ฝ่ายเก็บงาน/ตรวจ', admin: 'ผู้ดูแล' };
const STATUS = { ordered: 'รอขึ้นบล็อค', coating: 'กำลังขึ้นกาว', qc: 'รอตรวจ', rework: 'ตีกลับแก้ไข', ready: 'พร้อมส่ง', sent: 'ส่งแล้ว' };
const QC_CHECKS = [['pinhole', 'ไม่มีรูเข็ม / ฟองอากาศ'], ['detail', 'ลายคมชัด ครบทุกเส้น'], ['edge', 'ปิดเทปขอบเรียบร้อย'], ['label', 'ติดป้ายชื่อลูกค้า / ลาย ที่เฟรม']];
// ตัวกรองหน้าแรก (แทนแท็บเดิม): แต่ละฝ่ายเปิดมาเจอตัวกรองของตัวเอง
const FILTERS = [
  ['all', 'ทั้งหมด', s => s.status !== 'sent'],
  ['coat', 'ขึ้นบล็อค', s => ['ordered', 'coating', 'rework'].includes(s.status)],
  ['qc', 'รอตรวจ', s => s.status === 'qc'],
  ['ready', 'พร้อมส่ง', s => s.status === 'ready'],
  ['sent', 'ส่งแล้ว', s => s.status === 'sent']
];
const DEFAULT_FILTER = { artwork: 'all', coater: 'coat', qc: 'qc', admin: 'all' };
const TOKEN_KEY = 'stencil-token';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const fmtT = t => { const d = new Date(t); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtD = t => { if (!t) return '-'; const d = new Date(t); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${pad2((d.getFullYear() + 543) % 100)}`; };
const fmtGap = ms => { const m = Math.round(ms / 60000); return m < 60 ? `+${m} นาที` : `+${Math.floor(m / 60)} ชม. ${m % 60} น.`; };
const dueTs = j => j.due ? new Date(j.due + 'T17:00').getTime() : Infinity;

let token = null; try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
const db = { master: null, jobs: [], users: [], files: {}, features: {} };
const ui = { user: null, pickUser: null, pin: '', pinErr: '', tab: null, view: 'list', jobId: null, screenId: null, backTo: 'list', draft: null, arm: null, admin: null, editUser: null, busy: false, uploads: [], aiBusy: {}, prevBusy: {} };
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
    db.master = d.master; db.jobs = d.jobs; ui.user = d.me;
    Object.assign(db.files, d.files || {}); db.features = d.features || {};
    if (!quiet || !isEditing()) render();
  } catch (e) { if (!quiet && e.status !== 401) toast('โหลดข้อมูลไม่สำเร็จ: ' + e.message); }
}
const isEditing = () => { const a = document.activeElement; return pending > 0 || Object.keys(timers).length > 0 || ui.view === 'newjob' || ui.editUser || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)); };
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
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
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
  if (!ui.tab || !FILTERS.some(f => f[0] === ui.tab)) ui.tab = DEFAULT_FILTER[ui.user.role] || 'all';
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
    ${ui.user.role === 'admin' ? `<button class="icon-btn" data-a="settings" title="ตั้งค่า" aria-label="ตั้งค่า" aria-current="${ui.view === 'settings'}">⚙</button>` : ''}
    <div class="who"><span class="av ${ui.user.role}" style="width:30px;height:30px">${esc(ui.user.name[0])}</span>
      <span class="who-n"><b>${esc(ui.user.name)}</b><br><span class="muted small">${ROLES[ui.user.role]}</span></span>
      <button class="btn sm ghost" data-a="logout">ออก</button></div>
  </div></header>
  <main class="wrap">${body()}</main>`;
  window.scrollTo(0, y);
}
function body() {
  if (ui.view === 'newjob') return newJobView();
  if (ui.view === 'job') return jobView();
  if (ui.view === 'screen') return screenView();
  if (ui.view === 'settings') return settingsView();
  return homeView();
}

function loginView() {
  if (ui.pickUser) {
    const u = db.users.find(x => x.id === ui.pickUser);
    if (!u) { ui.pickUser = null; return loginView(); }
    return `<div class="login wrap"><button class="btn ghost back" data-a="pickback">← เลือกชื่อใหม่</button>
      <div class="pin"><span class="av ${u.role}" style="width:56px;height:56px;font-size:1.4rem">${esc(u.name[0])}</span>
      <div style="text-align:center"><h2>${esc(u.name)}</h2><div class="muted">${ROLES[u.role]}</div></div>
      <div class="dots ${ui.pinErr ? 'shake' : ''}">${[0, 1, 2, 3].map(i => `<i class="${i < ui.pin.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="err">${esc(ui.pinErr)}</div>
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-a="pin" data-v="${n}" ${ui.busy ? 'disabled' : ''}>${n}</button>`).join('')}<span></span><button data-a="pin" data-v="0" ${ui.busy ? 'disabled' : ''}>0</button><button data-a="pindel" aria-label="ลบ">⌫</button></div>
      </div></div>`;
  }
  const groups = ['artwork', 'coater', 'qc', 'admin'];
  return `<div class="login wrap">
    <div class="brand" style="flex:none"><div class="mark"></div><h1 style="font-size:1.5rem">บันทึกขึ้นบล็อค</h1></div>
    <div class="muted">แตะชื่อของคุณ แล้วใส่ PIN 4 หลัก</div>
    ${db.users.length ? groups.filter(g => db.users.some(u => u.role === g)).map(g => `<div class="dept"><div class="label">${ROLES[g]}</div><div class="people">
      ${db.users.filter(u => u.role === g).map(u => `<button class="person" data-a="pick" data-v="${u.id}"><span class="av ${g}">${esc(u.name[0])}</span><b>${esc(u.name)}</b></button>`).join('')}
    </div></div>`).join('') : '<div class="empty">โหลดรายชื่อไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่<br><button class="btn" data-a="reloadusers" style="margin-top:10px">ลองใหม่</button></div>'}
  </div>`;
}

/* --- หน้าแรก: ใบงานทั้งหมด กรองตามขั้นตอน --- */
function homeView() {
  const f = FILTERS.find(x => x[0] === ui.tab) || FILTERS[0], test = f[2];
  const canNew = ['artwork', 'admin'].includes(ui.user.role);
  const count = t => allScreens().filter(x => t(x.s)).length;
  const order = { rework: 0, coating: 1, ordered: 2, qc: 3, ready: 4, sent: 5 };
  const jobs = db.jobs.map(j => ({ j, ss: j.screens.filter(test).sort((a, b) => order[a.status] - order[b.status]) }))
    .filter(x => x.ss.length)
    .sort((a, b) => (a.ss.some(s => s.status === 'rework') ? 0 : 1) - (b.ss.some(s => s.status === 'rework') ? 0 : 1) || dueTs(a.j) - dueTs(b.j));
  if (ui.tab === 'sent') jobs.reverse();
  return `<div class="spread"><h2>ใบงาน</h2>${canNew ? '<button class="btn primary" data-a="newjob">+ สร้างใบงาน</button>' : ''}</div>
  <div class="filters" role="tablist">${FILTERS.map(([k, label, t]) => { const n = count(t); return `<button role="tab" data-a="tab" data-v="${k}" aria-selected="${k === f[0]}">${label}${k !== 'sent' ? ` <span class="count">${n}</span>` : ''}</button>`; }).join('')}</div>
  <div class="list">${jobs.map(({ j, ss }) => jobCard(j, ss)).join('') || `<div class="empty">ไม่มีงานในขั้นตอน "${f[1]}"</div>`}</div>`;
}
function jobCard(j, ss) {
  const n = j.screens.length, done = j.screens.filter(s => s.status === 'ready' || s.status === 'sent').length;
  return `<div class="jobcard">
    <button class="jobhead" data-a="openjob" data-v="${j.id}">
      <span class="t">${esc(j.customer)} <span class="jobno">${esc(j.no)}</span></span>
      <span class="small"><span class="${dueCls(j)}">${dueText(j)}</span> · <span class="num">${done}/${n}</span> บล็อค</span>
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
      ${db.features.files && !prep && ['ordered', 'coating'].includes(s.status) ? '<span class="fstate">ยังไม่มีไฟล์เตรียม</span>' : ''}</span>
    ${chip(s.status)}
  </button>`;
}
function blankScreen() { const m = db.master; return { key: Math.random().toString(36).slice(2), design: '', customerRef: '', originals: [], preview: null, mesh: m.mesh[1] || m.mesh[0] || '', frame: m.frames[1] || m.frames[0] || '', emulsion: m.emulsions[0] || '', target: defTarget() }; }
const opt = (arr, v) => (arr.includes(v) || !v ? arr : [v, ...arr]).map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
function newJobView() {
  const d = ui.draft, m = db.master;
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <h2>สร้างใบงานใหม่</h2>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div class="grid2">
      <div class="field"><label for="f-cust">ลูกค้า</label><input id="f-cust" list="custs" value="${esc(d.customer)}" data-d="customer" placeholder="พิมพ์หรือเลือก" autocomplete="off"><datalist id="custs">${m.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label for="f-due">กำหนดส่ง</label><input id="f-due" type="date" value="${esc(d.due)}" data-d="due"></div>
    </div>
    <div class="field"><label for="f-note">รายละเอียด / ข้อควรระวัง</label><textarea id="f-note" data-d="note" placeholder="เช่น ชนิดหมึก งานเส้นเล็ก ไฟล์ฟิล์มอยู่ที่ไหน">${esc(d.note)}</textarea></div>
  </div>
  ${db.features.files ? `<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div><h3>ไฟล์จากลูกค้า</h3><div class="muted small">อัปโหลดได้หลายไฟล์พร้อมกัน ระบบสร้างลายให้ไฟล์ละ 1 แถว และใช้ชื่อไฟล์เป็น Customer ID</div></div>
    <label class="drop" for="origin" data-drop="orig">+ เลือกไฟล์ลูกค้า หรือลากไฟล์มาวางที่นี่<br><span class="small muted">AI, PDF, PSD, CDR, JPG, PNG … ไม่เกิน 95 MB ต่อไฟล์</span></label>
    <input id="origin" type="file" multiple hidden>
    <div id="uploads"></div>
  </div>` : `<div class="banner">แอปยังไม่ได้เชื่อมที่เก็บไฟล์ R2 จึงยังแนบไฟล์ลูกค้าและรูปตัวอย่างไม่ได้ ผู้ดูแลดูวิธีแก้ได้ใน README หัวข้อ "แก้ปัญหา" ระหว่างนี้สร้างใบงานโดยพิมพ์ข้อมูลเองได้ตามปกติ</div>`}
  <h3>บล็อคที่ต้องขึ้น (${d.screens.length} ลาย)</h3>
  ${d.screens.map((s, i) => `<div class="screenrow">
    <div class="spread"><b>บล็อคที่ ${i + 1}</b><span class="row"><button class="btn sm" data-a="dupscreen" data-v="${i}" title="ลายเดียวกันแต่ต่างสี/ต่างบล็อค">ทำซ้ำ</button>${d.screens.length > 1 ? `<button class="btn sm bad" data-a="delscreen" data-v="${i}">ลบ</button>` : ''}</span></div>
    <div class="${db.features.files ? 'idrow' : 'idfields'}">
      ${db.features.files ? previewZone('d:' + i, s, true) : ''}
      <div class="idfields">
        <div class="field"><label for="s-c-${s.key}">Customer ID (ชื่อไฟล์ลูกค้า)</label><input id="s-c-${s.key}" value="${esc(s.customerRef)}" data-s="${i}" data-k="customerRef" placeholder="ได้จากชื่อไฟล์อัตโนมัติ"></div>
        ${db.features.ai && db.features.files ? nameField('d:' + i, s, `s-d-${s.key}`, `data-s="${i}" data-k="design"`) : `<div class="field"><label for="s-d-${s.key}">ชื่อลาย / สี</label><input id="s-d-${s.key}" value="${esc(s.design)}" data-s="${i}" data-k="design" placeholder="เช่น โลโก้หน้าอก (ขาว)"></div>`}
      </div>
    </div>
    ${db.features.files ? `<div class="flist">${s.originals.map(id => fileChip(id, true, 'd:' + i + ':originals')).join('')}
      <label class="btn sm ghost" for="rf-${s.key}">+ แนบไฟล์ลูกค้าให้ลายนี้</label><input id="rf-${s.key}" type="file" multiple hidden data-rowfile="${i}"></div>` : ''}
    <div class="grid2">
      <div class="field"><label for="s-m-${s.key}">เบอร์ผ้าสกรีน</label><select id="s-m-${s.key}" data-s="${i}" data-k="mesh">${opt(m.mesh, s.mesh)}</select></div>
      <div class="field"><label for="s-f-${s.key}">ขนาดเฟรม</label><select id="s-f-${s.key}" data-s="${i}" data-k="frame">${opt(m.frames, s.frame)}</select></div>
      <div class="field"><label for="s-e-${s.key}">ชนิดกาว</label><select id="s-e-${s.key}" data-s="${i}" data-k="emulsion">${opt(m.emulsions, s.emulsion)}</select></div>
      <div class="field"><label for="s-t-${s.key}">ความหนาที่ลูกค้าต้องการ</label><div class="unit"><input id="s-t-${s.key}" type="number" inputmode="numeric" value="${esc(s.target)}" data-s="${i}" data-k="target" placeholder="เช่น 120"><span>µm</span></div></div>
    </div></div>`).join('')}
  <button class="btn" data-a="addscreen">+ เพิ่มบล็อค</button>
  <div class="row" style="justify-content:flex-end"><span class="err" id="jerr"></span><button class="btn primary" data-a="savejob" ${ui.busy ? 'disabled' : ''}>บันทึกและส่งให้ฝ่ายขึ้นบล็อค</button></div>`;
}
function jobView() {
  const { j } = find(ui.jobId); if (!j) { ui.view = 'list'; return body(); }
  const canDel = ['artwork', 'admin'].includes(ui.user.role);
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <div class="spread"><div><div class="jobno">${esc(j.no)}</div><h2>${esc(j.customer)}</h2></div><span class="${dueCls(j)}">${dueText(j)}</span></div>
  ${j.note ? `<div class="card">${esc(j.note)}</div>` : ''}
  <div class="muted small">สั่งโดย ${esc(j.createdBy)} · ${fmtT(j.createdAt)}${j.sentAt ? ` · ส่งลูกค้า ${fmtT(j.sentAt)}` : ''}</div>
  <div class="jobcard">${j.screens.map(s => blockRow(j, s)).join('')}</div>
  <div class="row" style="justify-content:space-between">
    ${canDel ? `<button class="btn bad" data-a="deljob" data-v="${j.id}">${ui.arm === 'deljob' ? 'กดอีกครั้งเพื่อลบใบงานนี้' : 'ลบใบงาน'}</button>` : '<span></span>'}
    ${j.screens.every(s => s.status === 'ready') ? `<button class="btn ok" data-a="sendjob" data-v="${j.id}">บันทึกว่าส่งลูกค้าแล้ว</button>` : ''}
  </div>`;
}

/* --- screen detail --- */
function screenView() {
  const { j, s } = find(ui.jobId, ui.screenId); if (!s) { ui.view = 'list'; return body(); }
  const role = ui.user.role, T = tol();
  const canCoat = (role === 'coater' || role === 'admin') && ['ordered', 'coating', 'rework'].includes(s.status);
  const canQC = (role === 'qc' || role === 'admin') && s.status === 'qc';
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
    const art = role === 'artwork' || role === 'admin';
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
        <div class="field"><label for="u-role">ฝ่าย</label><select id="u-role" data-u="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
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
    ${ui.admin.map(u => eu && eu.id === u.id ? form(eu) : `<div class="urow ${u.active ? '' : 'off'}"><span class="av ${u.role}">${esc(u.name[0])}</span>
      <span><b>${esc(u.name)}</b><br><span class="muted small">${ROLES[u.role]}${u.active ? '' : ' · ปิดใช้งาน'}</span></span>
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
    case 'settings': ui.admin = null; ui.editUser = null; go('settings'); break;
    case 'back': go(ui.view === 'screen' && ui.backTo === 'job' ? 'job' : 'list'); break;
    case 'newjob':
      ui.draft = { customer: '', due: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), note: '', screens: [blankScreen()] };
      go('newjob'); break;
    case 'addscreen': ui.draft.screens.push(blankScreen()); render(); break;
    case 'dupscreen': { const src = ui.draft.screens[v]; ui.draft.screens.splice(+v + 1, 0, { ...src, originals: [...src.originals], key: Math.random().toString(36).slice(2) }); render(); break; }
    case 'delscreen': ui.draft.screens.splice(+v, 1); render(); break;
    case 'savejob': {
      const d = ui.draft, er = $('#jerr');
      if (!d.customer.trim()) return er.textContent = 'กรุณาใส่ชื่อลูกค้า';
      if (ui.uploads.length || Object.keys(ui.prevBusy).length || Object.keys(ui.aiBusy).length) return er.textContent = 'รอให้อัปโหลดไฟล์ / AI ทำงานเสร็จก่อน';
      if (d.screens.some(s => !s.design.trim() || !s.target)) return er.textContent = 'ใส่ชื่อลายและสเปคความหนาให้ครบทุกบล็อค';
      ui.busy = true; render();
      try {
        const r = await api('POST', '/jobs', { customer: d.customer.trim(), due: d.due, note: d.note.trim(), screens: d.screens.map(({ key, ...s }) => s) });
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
      const shared = (ui.draft ? ui.draft.screens : []).concat(allScreens().map(x => x.s)).some(x => (x.originals || []).includes(v) || (x.prepared || []).includes(v));
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
    case 'uadd': ui.editUser = { name: '', role: 'coater', pin: '', active: true }; render(); break;
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
      try { await api('PUT', '/master', m); db.master = m; toast('บันทึกรายการแล้ว'); render(); } catch (x) { toast(x.message); }
      break;
    }
  }
});
$('#lb').addEventListener('click', () => $('#lb').hidden = true);

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.d) { ui.draft[t.dataset.d] = t.value; return; }
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
  if (t.dataset.s) { ui.draft.screens[+t.dataset.s][t.dataset.k] = t.value; return; }
  if (t.dataset.chk) { const { s } = find(ui.jobId, ui.screenId); s.qc.checks[t.dataset.chk] = t.checked ? 1 : 0; saveScreen(s); return; }
  if (t.id === 'origin' && t.files.length) { const fs = [...t.files]; t.value = ''; addCustomerFiles(fs); return; }
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
  if (z.dataset.drop === 'orig') addCustomerFiles(fs);
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

// เริ่มต้น
if (token) loadData().then(() => { if (!ui.user) loadUsers(); }); else loadUsers();
})();
