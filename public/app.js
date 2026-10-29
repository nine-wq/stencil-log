(function () {
'use strict';
// ทุกคนทำได้ทุกขั้นตอน (ยังไม่แยกสิทธิ์ตามฝ่าย)
const STATUS = { ordered: 'รอขึ้นบล็อค', coating: 'กำลังขึ้นกาว', qc: 'รอตรวจ', rework: 'ตีกลับแก้ไข', ready: 'ตรวจสอบและจัดส่งแล้ว', sent: 'ตรวจสอบและจัดส่งแล้ว' };   // ready = old data from before the merge
const QC_CHECKS = [['detail', 'รายละเอียดลายครบถ้วน'], ['clean', 'ไม่มีตำหนิ ตามด รอยฝุ่น'], ['tape', 'เทปติดเรียบร้อย']];
// required QC photos (screen.photoKind[photoId] = kind); any other photo is "อื่น ๆ"
const QC_PHOTOS = [['front', 'ด้านหน้าบล็อค', 'ถ่ายพร้อมที่วัดความหนา วางกลางบล็อค'], ['label', 'ด้านข้างติดลาเบล', 'ให้เห็นลาเบลชัด']];
const photoKindOf = (s, p) => (s.photoKind || {})[p.id] || 'other';
// ตัวกรองหน้าแรก
const FILTERS = [
  ['all', 'ทั้งหมด', () => true],
  ['film', 'รอทำฟิล์ม', s => needsFilm(s)],
  ['coat', 'ขึ้นบล็อค', s => ['ordered', 'coating', 'rework'].includes(s.status)],
  ['qc', 'รอตรวจ', s => s.status === 'qc'],
  ['done', 'ตรวจสอบและจัดส่งแล้ว', s => isDone(s)]
];
// "ตรวจสอบและจัดส่งแล้ว": QC passed = done (old 'ready' blocks count as done too)
function isDone(s) { return s.status === 'sent' || s.status === 'ready'; }
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
    db.master = d.master; db.jobs = d.jobs; db.artworks = d.artworks || []; db.stencilNext = d.stencilNext || 1; ui.user = d.me;
    keepRecentPhotos();
    Object.assign(db.files, d.files || {}); db.features = d.features || {};
    if (!quiet || !isEditing()) render();
  } catch (e) { if (!quiet && e.status !== 401) toast('โหลดข้อมูลไม่สำเร็จ: ' + e.message); }
}
const isEditing = () => { const a = document.activeElement; return pending > 0 || (ui.phPending || []).length > 0 || Object.keys(timers).length > 0 || ui.view === 'newjob' || ui.editUser || ui.lib.busy.length > 0 || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)); };
// photos just taken on this device are shown from the local copy (no download after uploading)
const localPhotos = new Map();
// photos uploaded in the last 2 minutes: re-attached when a data load that started before them arrives late
const recentPhotos = [];
function keepRecentPhotos() {
  const now = Date.now();
  for (let i = recentPhotos.length - 1; i >= 0; i--) if (now - recentPhotos[i].at > 120000) recentPhotos.splice(i, 1);
  for (const r of recentPhotos) {
    const s = db.jobs.flatMap(j => j.screens).find(x => x.id === r.sid); if (!s) continue;
    if (!s.photos.some(x => x.id === r.p.id)) s.photos.push(r.p);
    if (r.kind !== 'other' && !(s.photoKind || {})[r.p.id]) s.photoKind = { ...(s.photoKind || {}), [r.p.id]: r.kind };
  }
}
const photoSrc = id => localPhotos.get(id) || `/api/photos/${id}?t=${encodeURIComponent(token)}`;
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
// แปะไฟล์ลูกค้าหลายไฟล์ลงใบงานใหม่: ไฟล์ละ 1 ลาย, Customer REF มาจากชื่อไฟล์
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
// no app-wide default thickness: a new block takes its customer's default spec, otherwise it is left empty to fill in
const defTarget = () => '';
// days left to the due date, counted in calendar days (0 = due today, negative = late); null = no due date or already sent
function dueDays(j) {
  if (!j.due || j.sentAt || (j.screens || []).every(isDone)) return null;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  return Math.round((new Date(j.due + 'T00:00').getTime() - t0.getTime()) / 864e5);
}
function dueCls(j) { const d = dueDays(j); return d == null ? '' : d < 0 ? 'due-late' : d <= 1 ? 'due-soon' : ''; }
function dueText(j) {
  if (!j.due) return 'ไม่ระบุกำหนดส่ง';
  const d = dueDays(j), when = 'กำหนดส่ง ' + fmtD(dueTs(j));
  if (d == null) return when;
  return when + ' · ' + (d < 0 ? `เลยกำหนด ${-d} วัน` : d === 0 ? 'ส่งวันนี้' : d === 1 ? 'ส่งพรุ่งนี้' : `อีก ${d} วัน`);
}
const chip = st => `<span class="chip st-${st}">${STATUS[st]}</span>`;
// short chips for the job list rows (full wording in the tooltip)
const STATUS_SHORT = { ordered: 'รอขึ้น', coating: 'กำลังขึ้น', qc: 'รอตรวจ', rework: 'ตีกลับ', ready: 'เสร็จแล้ว', sent: 'เสร็จแล้ว' };
const chipShort = st => `<span class="chip st-${st}" title="${STATUS[st]}">${STATUS_SHORT[st] || STATUS[st]}</span>`;
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
  const app = $('#app'); slotInfo.clear();
  if (!ui.user) { app.innerHTML = loginView(); return; }
  if (!db.master) { app.innerHTML = '<div class="loading">กำลังโหลดข้อมูล…</div>'; return; }
  if (!ui.tab || !FILTERS.some(f => f[0] === ui.tab)) ui.tab = 'all';
  const y = window.scrollY;
  // จำช่องที่กำลังพิมพ์ไว้ เพื่อไม่ให้หลุดโฟกัสเมื่อหน้าจอวาดใหม่
  const ae = document.activeElement, fid = ae && ae.id, sel = ae && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  const zone = ae && ae.dataset && ae.dataset.zone;
  // settings: keep what was typed but not saved yet when the page redraws (e.g. "+ เพิ่มพนักงาน")
  const keep = ui.view === 'settings' && ui.lastView === 'settings' && !ui.dropEdits ? formSnapshot() : null;
  ui.dropEdits = false; ui.lastView = ui.view;
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
  </header>
  <main class="wrap">${body()}</main>`;
  if (keep) formRestore(keep);
  mountViewers();
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
  return `<div class="toprow"><div class="search"><input id="q" type="search" data-search="1" value="${esc(ui.q || '')}" placeholder="ค้นหา ลูกค้า เลขใบงาน ชื่อลาย Customer REF เบอร์ผ้า ชื่อคน…" autocomplete="off" enterkeyhint="search">
    <button class="btn sm ghost" data-a="clearq" aria-label="ล้างคำค้น" ${ui.q ? '' : 'hidden'}>✕</button></div>
    <button class="btn primary" data-a="newjob">+ สร้างใบงาน</button></div>
  <div id="homeres">${homeResults()}</div>`;
}
const HOME_PAGE = 20;
// blocks inside a job: stencil ID ascending (blocks without one keep their order, last)
const bySid = (a, b) => (a.stencilId ? 0 : 1) - (b.stencilId ? 0 : 1) || String(a.stencilId || '').localeCompare(String(b.stencilId || '')) || (a.idx || 0) - (b.idx || 0);
function homeResults() {
  const f = FILTERS.find(x => x[0] === ui.tab) || FILTERS[0];
  const q = searchTerms(ui.q);
  const test = f[2];
  const order = { rework: 0, coating: 1, ordered: 2, qc: 3, ready: 4, sent: 5 };
  const byCust = false;   // newest job date first, grouped by date
  const hits = db.jobs.map(j => {
    let ss = j.screens.filter(test);
    if (q.length) { const jt = jobText(j); ss = ss.filter(s => matches(jt + ' ' + screenText(s), q)); }
    return { j, ss: ss.sort(bySid), t: jobTs(j) };
  }).filter(x => x.ss.length).sort((a, b) => b.t - a.t || (b.j.createdAt || 0) - (a.j.createdAt || 0));
  const count = t => q.length ? hits.reduce((n, x) => n + x.j.screens.filter(t).filter(s => x.ss.includes(s) || matches(jobText(x.j) + ' ' + screenText(s), q)).length, 0) : allScreens().filter(x => t(x.s)).length;
  // แสดงทีละ HOME_PAGE ใบงาน (ล่าสุดก่อน) กด "แสดงเพิ่ม" เพื่อดูเก่ากว่านี้; เปลี่ยนตัวกรองหรือคำค้นแล้วเริ่มนับใหม่
  const limit = ui.homeLimit || HOME_PAGE, shown = hits.slice(0, limit), more = hits.length - shown.length;
  // จัดกลุ่มตามวันที่รับงาน (กลุ่มแรกที่เข้าเงื่อนไข)
  let groups;
  if (byCust) {   // จัดกลุ่มตามลูกค้า: ลูกค้าที่มีงานล่าสุดขึ้นก่อน
    const m = new Map();
    for (const x of hits) { const k = x.j.customer || '-'; if (!m.has(k)) m.set(k, { title: k, xs: [] }); m.get(k).xs.push(x); }
    groups = [...m.values()];
  } else {
    groups = dateGroups().map(g => ({ ...g, xs: [] }));
    for (const x of shown) (groups.find(g => x.t >= g.from) || groups[groups.length - 1]).xs.push(x);
  }
  const sec = g => g.xs.length ? `<div class="sec-h"><h3>${esc(g.title)}</h3><span class="muted small num">${g.xs.length} ใบงาน</span></div>
    <div class="list">${g.xs.map(({ j, ss }) => jobCard(j, ss)).join('')}</div>` : '';
  const waitN = allScreens().filter(x => needsFilm(x.s)).length;
  return `<div class="filters" role="tablist">${FILTERS.map(([k, label, t]) => { const n = count(t); return `<button role="tab" data-a="tab" data-v="${k}" aria-selected="${k === f[0]}">${label} <span class="count">${n}</span></button>`; }).join('')}</div>
  ${['all', 'coat'].includes(f[0]) && allScreens().some(x => ['ordered', 'coating', 'rework'].includes(x.s.status)) ? '<div class="swipehint small muted">ปัดแถวไปทางขวาเพื่อบันทึก "ขึ้นกาว" · แตะแถวเพื่อเปิดบล็อค</div>' : ''}
  ${f[0] === 'film' && waitN ? `<a class="filmwait" href="/film/"><span><b class="num">${waitN}</b> บล็อครอลงแผ่นฟิล์ม · รวมหลายใบงานลงแผ่นเดียวได้</span><span>สร้างฟิล์ม →</span></a>` : ''}
  ${q.length ? `<div class="muted small">พบ <span class="num">${hits.reduce((n, x) => n + x.ss.length, 0)}</span> บล็อค ใน <span class="num">${hits.length}</span> ใบงาน</div>` : ''}
  ${hits.length ? groups.map(sec).join('') + (more > 0 ? `<button class="btn ghost morejobs" data-a="morejobs">แสดงใบงานเก่ากว่านี้ (อีก <span class="num">${more}</span> ใบงาน)</button>` : '') : `<div class="empty">${q.length ? `ไม่พบงานที่ตรงกับ "${esc(ui.q)}"` : `ไม่มีงานในขั้นตอน "${f[1]}"`}</div>`}`;
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
  return norm([s.stencilId, frameSrcText(s), s.design, s.customerRef, ...(s.sizes || []), s.mesh, s.frame, s.emulsion, s.target && s.target + 'µm', STATUS[s.status], s.coatNote, s.qc && s.qc.note, ...files, ...people].join(' '));
}
const RECENT_DAYS = 3;
const localDate = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// วันที่รับงาน: ใช้ช่อง "วันที่รับงาน" ถ้ามี ไม่งั้นใช้วันที่บันทึกเข้าระบบ
const jobDate = j => j.date || (j.createdAt ? localDate(j.createdAt) : '');
const jobTs = j => { const d = jobDate(j); return d ? new Date(d + 'T00:00').getTime() : 0; };
function jobCard(j, ss) {
  return `<div class="jobcard">
    <button class="jobhead" data-a="openjob" data-v="${j.id}">
      <span class="t">${esc(j.customer)}</span>
      <span class="small">${esc(j.no)} · <span class="${dueCls(j)}">${dueText(j)}</span></span>
    </button>
    ${ss.map(s => blockRow(j, s)).join('')}
  </div>`;
}
// one block in the job page: everything needed to make the stencil, at a glance
function compText(s) {
  const p = prepOf(s);
  if (p.mode === 'none') return 'ไม่ชดเชย';
  if (p.mode === 'manual') return `${esc(p.manualUm)} µm <span class="muted">(ระบุเอง)</span>`;
  return `${Math.round((+s.target || 0) * filmFactor())} µm <span class="muted">(อัตโนมัติ)</span>`;
}
function filmState(s) {
  if (waitingFile(s)) return '<span class="fstate wait">รอไฟล์จากลูกค้า</span>';
  if (s.film) return `<span class="fstate ok">ทำฟิล์มแล้ว</span> <span class="muted small">${fmtT(s.film.at)}</span>`;
  if (needsFilm(s)) return '<span class="fstate">ยังไม่ทำฟิล์ม</span>';
  const a = s.artworkId && artOf(s.artworkId);
  return a && !a.filmable ? '<span class="muted small">ไฟล์ลายทำฟิล์มอัตโนมัติไม่ได้</span>' : '<span class="muted small">-</span>';
}
function jobBlockRow(j, s) {
  const kv = (k, v) => `<span class="kv"><span class="k">${k}</span><span class="v">${v}</span></span>`;
  return `<button class="brow jb" data-a="openscreen" data-j="${j.id}" data-v="${s.id}">
    ${s.preview ? `<img class="thumb" src="${fileUrl(s.preview, true)}" alt="" loading="lazy">` : '<span class="thumb none" aria-hidden="true"></span>'}
    <span class="bt">
      <span class="jbid">${s.stencilId ? `<span class="sid sm">${esc(s.stencilId)}</span>` : ''}${s.customerRef ? `<span class="cref">${esc(s.customerRef)}</span>` : ''}</span>
      <b>${esc(s.design || '(ยังไม่ตั้งชื่อ)')}</b>
      <span class="kvs">
        ${kv('ไซส์', (s.sizes || []).length ? esc(s.sizes.join(', ')) : '<span class="muted">ไม่ระบุ</span>')}
        ${kv('เฟรม', `${esc(s.frame || '-')}${s.frameSource === 'customer' ? ' <span class="fsrc">บล็อคเดิมลูกค้า</span>' : ''}`)}
        ${kv('ผ้าสกรีน', `<span class="num">${esc(s.mesh || '-')}</span>`)}
        ${kv('กาว', esc(s.emulsion || '-'))}
        ${kv('ความหนา', `<span class="num">${esc(s.target || '-')} µm</span>`)}
        ${kv('ชดเชยขอบ', compText(s))}
        ${kv('ฟิล์ม', filmState(s))}
      </span>
    </span>
    ${chip(s.status)}
  </button>`;
}
function blockRow(j, s) {
  const canCoat = ['ordered', 'coating', 'rework'].includes(s.status);
  const row = `<div class="brow" role="button" tabindex="0" data-a="openscreen" data-j="${j.id}" data-v="${s.id}">
    ${s.preview ? `<img class="thumb" src="${fileUrl(s.preview, true)}" alt="" loading="lazy">` : '<span class="thumb none" aria-hidden="true"></span>'}
    <span class="bt"><b>${esc(s.design || '(ยังไม่ตั้งชื่อ)')}</b>${s.stencilId ? `<span class="sidtxt">${esc(s.stencilId)}</span>` : ''}
      <span class="muted small bl">${s.frameSource === 'customer' ? '<span class="fsrc">เดิม</span>' : '<span class="fnew">ใหม่</span>'} · <span class="num">${esc(s.mesh)}</span> · <span class="num">${esc(s.target)} µm</span>${(s.sizes || []).length ? ` · ${esc(s.sizes.join(', '))}` : ''}</span></span>
    <span class="bstate">${waitingFile(s) ? '<span class="chip fl-wait" title="รอไฟล์จากลูกค้า">รอไฟล์</span>' : needsFilm(s) ? '<span class="chip fl-need" title="ยังไม่ทำฟิล์ม">รอฟิล์ม</span>' : ''}${chipShort(s.status)}
      ${canCoat && s.coats.length ? `<span class="rounds num" title="ขึ้นกาวแล้ว ${s.coats.length} รอบ">× ${s.coats.length}</span>` : ''}
      ${canCoat ? `<button class="btn sm primary coatbtn" data-a="quickcoat" data-j="${j.id}" data-v="${s.id}" title="บันทึกรอบขึ้นกาวของบล็อคนี้ (เหมือนกด + ขึ้นกาว ในหน้าบล็อค)">+ ขึ้นกาว</button>` : ''}</span>
  </div>`;
  // rows that can take a coat round: swipe right on a touch screen (the strip behind shows what will happen)
  return canCoat ? `<div class="swipe" data-j="${j.id}" data-v="${s.id}"><div class="swipebg" aria-hidden="true">+ ขึ้นกาว รอบที่ ${s.coats.length + 1}</div>${row}</div>` : row;
}
// ไซส์ที่ลูกค้าระบุ: เลือกได้หลายไซส์ หรือไม่ระบุ (รายการแก้ได้ที่ ⚙ ตั้งค่า)
const DEFAULT_SIZES = ['FREE SIZE', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];
const sizeList = () => (db.master && Array.isArray(db.master.sizes) && db.master.sizes.length ? db.master.sizes : DEFAULT_SIZES);
function sizeChips(t, s, edit) {
  const sel = s.sizes || [], list = [...sizeList(), ...sel.filter(x => !sizeList().includes(x))];
  if (!edit) return sel.length ? sel.map(x => `<span class="szchip on">${esc(x)}</span>`).join('') : '<span class="muted small">ไม่ระบุไซส์</span>';
  return `<div class="szchips" role="group" aria-label="ไซส์">${list.map(x => { const on = sel.includes(x);
    return `<button type="button" class="szchip ${on ? 'on' : ''}" data-a="size" data-v="${t}" data-k="${esc(x)}" aria-pressed="${on}">${esc(x)}</button>`; }).join('')}
    <span class="muted small">${sel.length ? `${sel.length} ไซส์` : 'ไม่ระบุไซส์'}</span></div>`;
}
// บล็อคใหม่ หรือ บล็อคเดิมของลูกค้า (ลูกค้าส่งเฟรมมาให้ขึ้นกาวใหม่)
const FRAME_SRC = [['new', 'บล็อคใหม่'], ['customer', 'บล็อคเดิมลูกค้า']];
const frameSrcText = s => s.frameSource === 'customer' ? 'บล็อคเดิมลูกค้า' : 'บล็อคใหม่';
function frameSrcPicker(t, s) {
  const cur = s.frameSource === 'customer' ? 'customer' : 'new';
  return `<div class="seg fsrcpick" role="radiogroup" aria-label="บล็อคใหม่หรือบล็อคเดิมลูกค้า">${FRAME_SRC.map(([v, l]) =>
    `<button type="button" role="radio" aria-checked="${cur === v}" class="fs-${v}${cur === v ? ' on' : ''}" data-a="framesrc" data-v="${t}" data-k="${v}">${l}</button>`).join('')}</div>`;
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
  ${cust ? (() => {
    // ส่วนใหญ่เป็นลายใหม่: อัปโหลดก่อน แสดงเฉพาะลายที่เพิ่งอัปโหลด/เลือกไว้ ลายเก่าในคลังพับไว้ เปิดดูเมื่อต้องการ
    const fresh = d.newArts || [], shown = arts.filter(a => picked.has(a.id) || fresh.includes(a.id));
    const old = arts.filter(a => !shown.includes(a)), q = searchTerms(d.oldQ || '');
    const oldHit = q.length ? old.filter(a => matches(norm([a.name, a.customerRef, a.fileName].join(' ')), q)) : old;
    return `<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="spread"><div><h3>ลายของงานนี้</h3><div class="muted small">อัปโหลดไฟล์ลายของ ${esc(cust)} · 1 ลาย = 1 บล็อค · ลายที่อัปโหลดเก็บเข้าคลังลายของลูกค้าด้วย</div></div><span class="muted small"><span class="num">${picked.size}</span> ลายที่เลือก</span></div>
    ${db.features.files ? uploadZone('nj') : ''}
    ${shown.length ? artGrid(shown, picked, 'pickart', fresh) : ''}
    ${old.length ? `<button class="btn sm ghost oldtoggle" data-a="toggleold" aria-expanded="${!!d.showOld}">${d.showOld ? '▾ ซ่อนลายเก่าในคลัง' : `▸ เลือกจากลายเก่าในคลัง (${old.length} ลาย)`}</button>
      ${d.showOld ? `<div class="search"><input id="oldq" type="search" data-oldq="1" value="${esc(d.oldQ || '')}" placeholder="ค้นหาลายเก่า: ชื่อลาย Customer REF ชื่อไฟล์" autocomplete="off"></div>
        <div id="oldgrid">${oldHit.length ? artGrid(oldHit, picked, 'pickart') : '<div class="muted small">ไม่พบลายที่ตรงกับคำค้น</div>'}</div>` : ''}` : ''}
  </div>`; })() : '<div class="card muted small">ใส่ชื่อลูกค้าก่อน แล้วอัปโหลดไฟล์ลาย หรือเลือกจากลายเก่าในคลังของลูกค้า</div>'}
  <h3>บล็อคที่ต้องขึ้น (${d.screens.length} ลาย)</h3>
  ${d.screens.length ? d.screens.map((s, i) => draftRow(s, i)).join('') : '<div class="empty">ยังไม่ได้เลือกลาย</div>'}
  <button class="btn" data-a="addscreen" title="ลูกค้าแจ้งว่าจะมีลายนี้ แต่ยังไม่ส่งไฟล์: เปิดบล็อคไว้ก่อน แล้วเพิ่มไฟล์ทีหลังที่หน้าบล็อค">+ เพิ่มบล็อครอไฟล์จากลูกค้า</button>
  <div class="row" style="justify-content:flex-end"><span class="err" id="jerr"></span><button class="btn primary" data-a="savejob" ${ui.busy ? 'disabled' : ''}>บันทึกและส่งให้ฝ่ายขึ้นบล็อค</button></div>`;
}
/* --- บล็อครอไฟล์จากลูกค้า: ลูกค้าแจ้งว่าจะมีลายนี้ แต่ยังไม่ส่งไฟล์ เปิดใบงานไปก่อน แล้วเพิ่มไฟล์ทีหลัง --- */
const waitingFile = s => !s.artworkId && !(s.originals || []).length && s.status !== 'sent';
function waitFileBox(t, s) {
  return `<div class="waitfile">
    <b>รอไฟล์จากลูกค้า</b>
    <span class="muted small">บันทึกใบงานไปก่อนได้ เมื่อได้ไฟล์ค่อยเพิ่มที่หน้าบล็อคนี้ หรืออัปโหลดตอนนี้ถ้าได้ไฟล์แล้ว</span>
    ${db.features.files ? `<label class="btn sm primary" for="wf-${esc(pkOf(t, s))}">+ อัปโหลดไฟล์ลาย</label><input id="wf-${esc(pkOf(t, s))}" type="file" hidden data-attachfile="${t}">` : ''}
  </div>`;
}
// the screen page while the customer's file has not come yet: upload it, or pick an artwork already in the library
function attachCard(j, s) {
  const replace = !!s.artworkId;   // the customer sent a revised file for a screen that already has its artwork
  const choice = (ui.attachChoice && ui.attachChoice.sid === s.id) ? ui.attachChoice.ids.map(artOf).filter(Boolean) : null;
  const lib = custArts(j.customer).filter(a => a.id !== s.artworkId), q = searchTerms(ui.attachQ || ''), hits = q.length ? lib.filter(a => matches(norm([a.name, a.customerRef, a.fileName].join(' ')), q)) : lib;
  return `<div class="card attach" id="attachcard" style="display:flex;flex-direction:column;gap:12px">
    <div class="spread"><h3>${replace ? 'เปลี่ยนไฟล์ลาย' : 'ไฟล์ลายของบล็อคนี้'}</h3>${replace ? '<button class="btn sm ghost" data-a="replacecancel">ยกเลิก</button>' : '<span class="fstate wait">รอไฟล์จากลูกค้า</span>'}</div>
    ${choice ? `<div class="spechint"><span class="label">ไฟล์นี้มี ${choice.length} ลาย</span><span class="small">แตะลายที่เป็นของบล็อคนี้ ลายอื่นเก็บไว้ในคลังลายของ ${esc(j.customer)}</span></div>
      ${artGrid(choice, new Set(), 'attachart')}`
    : `<div class="muted small">${replace ? `อัปโหลดไฟล์ที่ลูกค้าแก้มา ไฟล์จะเข้าคลังลายของ ${esc(j.customer)} แล้วบล็อคนี้จะใช้ลายใหม่แทน (รูป ไฟล์ Customer REF)${s.film ? ' และต้องลงแผ่นฟิล์มใหม่' : ''} · ชื่อลายเดิมยังอยู่` : `เมื่อลูกค้าส่งไฟล์มา อัปโหลดที่นี่ ไฟล์จะเข้าคลังลายของ ${esc(j.customer)} และบล็อคนี้จะได้รูป ชื่อลาย และพร้อมทำฟิล์ม`}</div>
      <label class="drop" for="af-attach" data-drop="attach">+ อัปโหลดไฟล์ลาย หรือลากไฟล์มาวางที่นี่<br><span class="small muted">AI (PDF-compatible), PDF, JPG, PNG</span></label>
      <input id="af-attach" type="file" hidden data-attachfile="s">
      <div id="libbusy">${libBusyHtml()}</div>
      ${lib.length ? `<button class="btn sm ghost oldtoggle" data-a="toggleattach" aria-expanded="${!!ui.attachOpen}">${ui.attachOpen ? '▾ ซ่อนลายในคลัง' : `▸ หรือเลือกจากลายในคลังของ ${esc(j.customer)} (${lib.length} ลาย)`}</button>
        ${ui.attachOpen ? `<div class="search"><input id="attq" type="search" data-attq="1" value="${esc(ui.attachQ || '')}" placeholder="ค้นหา: ชื่อลาย Customer REF ชื่อไฟล์" autocomplete="off"></div>
          <div id="attgrid">${hits.length ? artGrid(hits, new Set(), 'attachart') : '<div class="muted small">ไม่พบลายที่ตรงกับคำค้น</div>'}</div>` : ''}` : ''}`}
  </div>`;
}
// give a screen its artwork: picture, file, Customer REF, and the name when it has none yet
function attachArt(t, a) {
  const o = targetObj(t); if (!o || !a) return;
  const replace = t === 's' && o.artworkId && o.artworkId !== a.id;
  o.artworkId = a.id; o.preview = a.preview || (replace ? null : o.preview) || null;
  o.originals = a.file ? [a.file] : (replace ? [] : o.originals || []);   // one screen = one artwork = its one original file
  if (replace || !String(o.customerRef || '').trim()) o.customerRef = a.customerRef || '';
  if (!String(o.design || '').trim() && a.name) o.design = a.name;
  if (replace) {
    if (o.filmPrep) o.filmPrep = { ...o.filmPrep, notArt: [] };   // colours belonged to the old file
    if (o.film) { delete o.film; logEv(o, 'ต้องลงแผ่นฟิล์มใหม่ (เปลี่ยนไฟล์ลาย)'); }
  }
  if (t === 's') { logEv(o, (replace ? 'เปลี่ยนไฟล์ลายเป็น: ' : 'เพิ่มไฟล์ลาย: ') + (a.fileName || a.customerRef || '')); saveScreen(o); ui.attachChoice = null; ui.attachOpen = false; ui.replaceArt = null; }
}
async function attachFiles(t, files) {
  const o = targetObj(t); if (!o) return;
  const cust = t === 's' ? (find(ui.jobId).j || {}).customer : ui.draft.customer.trim();
  const made = await addArtworkFiles(cust, files);
  const usable = made.filter(a => a.filmable).length ? made.filter(a => a.filmable) : made;
  if (!usable.length) return;
  if (t === 's') {
    if (usable.length === 1) { const had = !!o.artworkId; attachArt('s', usable[0]); toast(had ? 'เปลี่ยนไฟล์ลายแล้ว' : 'เพิ่มไฟล์ลายให้บล็อคนี้แล้ว'); }
    else ui.attachChoice = { sid: o.id, ids: usable.map(a => a.id) };   // ask which design belongs to this screen
  } else {
    // new-job form: the first design goes to this row, any more designs become new rows
    attachArt(t, usable[0]);
    const d = ui.draft; d.newArts = [...(d.newArts || []), ...made.map(a => a.id)];
    usable.slice(1).forEach(a => { if (!d.screens.some(x => x.artworkId === a.id)) d.screens.push(screenFromArt(a)); });
  }
  render();
}

// เลขบล็อค: ตัวอย่างเลขที่จะได้ (เลขจริงออกให้ตอนบันทึกใบงาน)
function stencilPreview(i) {
  const d = new Date(), yymm = `${pad2((d.getFullYear() + 543) % 100)}${pad2(d.getMonth() + 1)}`;
  return `ST-${yymm}-${String((db.stencilNext || 1) + i).padStart(4, '0')}`;
}
function draftRow(s, i) {
  const d = ui.draft, m = db.master, a = s.artworkId ? artOf(s.artworkId) : null, cust = d.customer.trim();
  const diff = custSpec(d.customer) && !sameSpec(s, custSpec(d.customer));
  return `<div class="screenrow sr">
    <div class="srhead">
      <b>บล็อคที่ ${i + 1}</b>
      <span class="sid pending" title="เลขบล็อค (Stencil ID) ออกให้อัตโนมัติตอนบันทึกใบงาน">${stencilPreview(i)}</span>
      ${diff ? '<span class="fstate">ต่างจากสเปคประจำ</span>' : ''}
      <span class="srsp"></span>
      <button class="btn sm" data-a="dupscreen" data-v="${i}" title="ลายเดียวกันแต่ต่างสี/ต่างบล็อค">ทำซ้ำ</button><button class="btn sm bad" data-a="delscreen" data-v="${i}">ลบ</button>
    </div>
    <div class="srbody">
      ${a && a.filmable ? viewerSlot(pkOf('d:' + i, s), s, a, cust)
        : a ? `<div class="pz ro">${a.preview ? `<img src="${fileUrl(a.preview, true)}" alt="รูปตัวอย่างลาย" data-a="zoomfile" data-v="${a.preview}">` : '<span class="muted small">ไม่มีรูป</span>'}</div>`
        : waitFileBox('d:' + i, s)}
      <div class="srfields">
        <fieldset class="grp"><legend>ลาย</legend>
          <div class="stack">
            <div class="field"><label for="s-d-${s.key}">ชื่อลาย</label><input id="s-d-${s.key}" value="${esc(s.design)}" data-s="${i}" data-k="design" placeholder="${a ? (a.name ? '' : 'AI กำลังตั้งชื่อ…') : 'ไม่ใส่ก็ได้ AI จะตั้งให้เมื่อได้ไฟล์'}"></div>
            ${a ? `<div class="field"><span class="flabel">Customer REF</span><div class="ro-v" title="${esc(s.customerRef || '')}">${esc(s.customerRef || '-')}</div></div>`
              : `<div class="field"><label for="s-c-${s.key}">Customer REF</label><input id="s-c-${s.key}" value="${esc(s.customerRef)}" data-s="${i}" data-k="customerRef"></div>`}
          </div>
          <div class="field"><span class="flabel">ไซส์ <span class="muted small">(เลือกได้หลายไซส์ หรือไม่ต้องเลือก)</span></span>${sizeChips('d:' + i, s, true)}</div>
          ${a && !a.filmable ? '<span class="fstate">ไฟล์นี้ทำฟิล์มในแอปไม่ได้</span>' : ''}
        </fieldset>
        <fieldset class="grp"><legend>สเปคบล็อค</legend>
          ${frameSrcPicker('d:' + i, s)}
          <div class="grid4">
            <div class="field"><label for="s-m-${s.key}">เบอร์ผ้าสกรีน</label><select id="s-m-${s.key}" data-s="${i}" data-k="mesh">${opt(m.mesh, s.mesh)}</select></div>
            <div class="field"><label for="s-f-${s.key}">ขนาดเฟรม</label><select id="s-f-${s.key}" data-s="${i}" data-k="frame">${opt(m.frames, s.frame)}</select></div>
            <div class="field"><label for="s-e-${s.key}">ชนิดกาว</label><select id="s-e-${s.key}" data-s="${i}" data-k="emulsion">${opt(m.emulsions, s.emulsion)}</select></div>
            <div class="field"><label for="s-t-${s.key}">ความหนาที่ต้องการ</label><div class="unit"><input id="s-t-${s.key}" type="number" inputmode="numeric" value="${esc(s.target)}" data-s="${i}" data-k="target" placeholder="เช่น 120"><span>µm</span></div></div>
          </div>
        </fieldset>
        ${a && a.filmable ? filmGroup('d:' + i, s, a, cust) : ''}
      </div>
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
// removable: ids that get a ✕ (artworks just uploaded in the new-job form)
function artGrid(arts, picked, action, removable) {
  if (!arts.length) return '<div class="muted small">ยังไม่มีลายในคลังของลูกค้านี้ อัปโหลดไฟล์ลายด้านล่าง</div>';
  return `<div class="artgrid">${arts.map(a => { const on = picked ? picked.has(a.id) : ui.lib.edit === a.id;
    const rm = removable && removable.includes(a.id)
      ? `<button class="artrm ${ui.arm === 'rmart:' + a.id ? 'armed' : ''}" data-a="rmart" data-v="${a.id}" title="เอาลายนี้ออก (ลบออกจากคลังด้วย)" aria-label="เอาลายนี้ออก">${ui.arm === 'rmart:' + a.id ? 'ลบ?' : '✕'}</button>` : '';
    return `<div class="artcell">${rm}<button class="arttile ${on ? 'on' : ''}" data-a="${action}" data-v="${a.id}" aria-pressed="${on}">
      ${a.preview ? `<img src="${fileUrl(a.preview, true)}" alt="" loading="lazy">` : '<span class="noimg" aria-hidden="true"></span>'}
      <b>${esc(a.name || (ui.aiBusy['a:' + a.id] ? 'AI กำลังตั้งชื่อ…' : '(ยังไม่ตั้งชื่อ)'))}</b>
      <span class="muted small" title="${esc(a.customerRef || '')}">${esc(a.customerRef || '')}</span>
      ${a.filmable ? '' : '<span class="fstate">ทำฟิล์มในแอปไม่ได้</span>'}${picked && on ? '<span class="tick" aria-hidden="true">✓</span>' : ''}</button></div>`; }).join('')}</div>`;
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
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <div class="spread"><h2>คลังลาย</h2><span class="muted small"><span class="num">${db.artworks.filter(a => !a.hidden).length}</span> ลาย</span></div>
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
      <div class="field"><label for="ae-ref">Customer REF</label><input id="ae-ref" data-art="customerRef" value="${esc(a.customerRef)}"></div>
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
    allScreens().forEach(({ s }) => { if (s.artworkId === id && !String(s.design || '').trim()) { s.design = r.name; saveScreen(s); } });
    if (!quiet) toast('AI ตั้งชื่อ: ' + r.name);
  } catch (e) { if (!quiet) toast(e.message); }
  delete ui.aiBusy['a:' + id]; render();
}
function screenFromArt(a) { return { ...blankScreen(), artworkId: a.id, design: a.name || '', customerRef: a.customerRef || '', originals: a.file ? [a.file] : [], preview: a.preview || null }; }
/* --- ฟิล์มของแต่ละบล็อค: การชดเชยขอบ สีที่ไม่ใช่ลาย -> screen.filmPrep --- */
// filmPrep = { mode: 'auto'|'manual'|'none', manualUm, notArt: [colour keys] }; ความหนามาจากสเปคของบล็อค (target)
const prepOf = s => ({ mode: 'auto', manualUm: 200, notArt: [], ...(s.filmPrep || {}) });
const pkOf = (t, s) => s.id || s.key || t;
const filmFactor = () => { const f = ui.filmSet || filmSetCache || FILM_DEF; return f.factor != null ? f.factor : 0.5; };
function filmGroup(t, s, a, customer) {
  const pk = pkOf(t, s), p = prepOf(s), pv = previewNow(s, a, customer);
  const auto = Math.round((+s.target || 0) * filmFactor());
  const cols = pv && pv.colours;
  return `<fieldset class="grp"><legend>ฟิล์ม</legend>
    <div class="grid2">
      <div class="field"><label for="fp-m-${pk}">ชดเชยขอบ</label><select id="fp-m-${pk}" data-fp="${t}" data-k="mode">${[['auto', `อัตโนมัติ (ความหนา × ${filmFactor()})`], ['manual', 'ระบุค่าเอง'], ['none', 'ไม่ชดเชย']].map(([v, l]) => `<option value="${v}" ${p.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="fp-u-${pk}">ค่าชดเชย (ต่อด้าน)</label><div class="unit"><input id="fp-u-${pk}" type="number" min="0" max="2000" step="10" data-fp="${t}" data-k="manualUm" value="${p.mode === 'manual' ? esc(p.manualUm) : p.mode === 'none' ? 0 : auto}" ${p.mode === 'manual' ? '' : 'disabled'}><span>µm</span></div></div>
    </div>
    <div><span class="label">สีในลาย</span> <span class="muted small">ทุกสีเป็นสีดำในฟิล์ม แตะสีที่ไม่ใช่ลายเพื่อตัดออก</span>
      <div class="fpcols">${cols ? cols.map(c => { const on = !p.notArt.includes(c.key);
        return `<button class="fpcol ${on ? '' : 'off'}" data-a="fpcol" data-v="${t}" data-k="${esc(c.key)}" aria-pressed="${on}"><i style="background:${esc(c.css)}"></i>${esc(c.label)}</button>`; }).join('')
        : `<span class="muted small">${pv && pv.err ? esc(pv.err) : 'กำลังอ่านสีจากไฟล์…'}</span>`}</div></div>
    ${pv && pv.notes ? `<div class="muted small">${esc(pv.notes)}</div>` : ''}
  </fieldset>`;
}

/* --- preview data: the design's film (black, with compensation, labels off) and the same area of the original --- */
const fpCache = new Map(), fileBytes = new Map(), jobCache = new Map(), origDocs = new Map();
let filmSetCache = null, fpBusy = Promise.resolve();
const fpKey = (s, a, customer) => JSON.stringify([a.id, +s.target || 0, prepOf(s), customer]);
const previewNow = (s, a, customer) => { const e = fpCache.get(fpKey(s, a, customer)); return e && e.data; };
async function artBytes(a) {
  if (!fileBytes.has(a.file)) {
    const r = await fetch('/api/files/' + a.file, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('เปิดไฟล์ต้นฉบับไม่ได้ (' + r.status + ')');
    fileBytes.set(a.file, new Uint8Array(await r.arrayBuffer()));
  }
  return fileBytes.get(a.file);
}
function pickDesign(C, job, a, st) {
  const ds = C.describe(job, st).designs; if (!ds.length) return null;
  let pick = ds.find(d => d.index === a.design) || ds[0];
  if (a.box) { const cx = (a.box[0] + a.box[2]) / 2, cy = (a.box[1] + a.box[3]) / 2; let best = Infinity;
    ds.forEach(d => { const b = d.boxes.reduce((u, f) => [Math.min(u[0], f[0]), Math.min(u[1], f[1]), Math.max(u[2], f[2]), Math.max(u[3], f[3])]);
      const dd = Math.hypot((b[0] + b[2]) / 2 - cx, (b[1] + b[3]) / 2 - cy); if (dd < best) { best = dd; pick = d; } }); }
  return pick;
}
// one preview at a time; the result stays in the cache (pdf.js pages are kept so zooming re-renders sharp vectors)
function getPreview(s, a, customer) {
  const key = fpKey(s, a, customer);
  if (fpCache.has(key)) return fpCache.get(key).p;
  const entry = { data: null };
  entry.p = fpBusy = fpBusy.then(async () => {
    const out = {};
    try {
      const C = await loadFilmTools(), f = filmSetCache || (filmSetCache = { ...FILM_DEF, ...(await filmSet()) });
      const st = { ...f, autoFactor: f.factor, labels: false, cropMarks: false, dateText: '' };
      const bytes = await artBytes(a), jk = a.file + ':' + (a.page || 0);
      if (!jobCache.has(jk)) jobCache.set(jk, await C.analyze(bytes, a.customerRef || 'artwork', a.page || 0));
      const job = jobCache.get(jk), p = prepOf(s);
      job.notArt = new Set(p.notArt); job.excluded = new Set();
      const pick = pickDesign(C, job, a, st); if (!pick) throw new Error('ไม่พบลายในไฟล์');
      C.describe(job, st).designs.forEach(d => { if (d.index !== pick.index) job.excluded.add(d.index); });
      const set = { customer, thick: +s.target || 0, thickSet: true, mode: p.mode, manualUm: +p.manualUm || 0 };
      job.dset = { [pick.index]: set };
      out.comp = C.compensation(set, st);
      job.notArt = new Set(); const all = C.describe(job, st); job.notArt = new Set(p.notArt);
      const d2 = C.describe(job, st);
      const seen = new Map(); all.colours.forEach(c => { if (!seen.has(c.label)) seen.set(c.label, c); });
      out.colours = [...seen.values()].filter(c => c.art || p.notArt.includes(c.key)).map(c => ({ key: c.key, label: c.label, css: c.css }));
      const notes = [];
      if (d2.guides) notes.push(`ตัดเส้นกรอบ/เส้นร่าง ${d2.guides} เส้น`);
      if (d2.specks) notes.push(`ตัดเศษเล็ก ${d2.specks} ชิ้น`);
      if (d2.nearWhite) notes.push(`สีเกือบขาว ${d2.nearWhite} ชิ้นถือเป็นสีขาว`);
      out.notes = notes.join(' · ');
      const res = await C.render(C.blocksFor(job, st), st), it = res.plan.sheets[0] && res.plan.sheets[0][0];
      if (!it) throw new Error('ลายใหญ่เกินแผ่นฟิล์ม');
      const lib = window.pdfjsLib, doc = await lib.getDocument({ data: res.bytes, isEvalSupported: false, verbosity: 0 }).promise;
      out.film = { page: await doc.getPage(1), box: [it.x, it.y, it.x + it.W, it.y + it.H] };
      // the original, same area (not for a block turned sideways on the sheet)
      if (!it.rot) {
        try {
          if (!origDocs.has(a.file)) origDocs.set(a.file, lib.getDocument({ data: bytes.slice(0), isEvalSupported: false, verbosity: 0 }).promise);
          const od = await origDocs.get(a.file);
          out.orig = { page: await od.getPage((a.page || 0) + 1), box: it.b.bbox };
        } catch (e) {}
      }
    } catch (e) { out.err = 'ทำตัวอย่างฟิล์มไม่ได้: ' + e.message; }
    entry.data = out;
    return out;
  });
  fpCache.set(key, entry);
  entry.p.then(() => { if (!isTyping()) render(); else setTimeout(() => render(), 600); });
  return entry.p;
}
const isTyping = () => { const el = document.activeElement; return el && el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox'; };
// how strongly the film shows over the original (0 = only the original, 100 = only the film), remembered per browser
function fpOpacity() { if (ui.fpOp == null) { let v = NaN; try { const r = localStorage.getItem('stencil-fpop'); if (r !== null && r !== '') v = +r; } catch (e) {} ui.fpOp = isFinite(v) && v >= 0 && v <= 100 ? v : 70; } return ui.fpOp; }
function prepTarget(t) { return targetObj(t); }
function setPrep(t, patch) {
  const s = prepTarget(t); if (!s) return;
  s.filmPrep = { ...prepOf(s), ...patch };
  if (t === 's') saveScreen(s);
  render();
}

/* --- ตัวดูลาย: ส่วนของต้นฉบับเฉพาะลายนี้ + ฟิล์มวางทับ (ปรับความชัด) ซูม/เลื่อนได้ วาดใหม่จากเวกเตอร์ให้คมทุกระดับ --- */
// the viewer's DOM stays alive between renders (render() rebuilds the page as HTML text): a slot is filled after each render
const viewers = new Map(), slotInfo = new Map();
function viewerSlot(pk, s, a, customer) { slotInfo.set(String(pk), { s, a, customer }); return `<div class="fvslot" data-fv="${esc(pk)}"></div>`; }
function mountViewers() {
  document.querySelectorAll('[data-fv]').forEach(slot => {
    const pk = slot.dataset.fv, info = slotInfo.get(pk); if (!info) return;
    let v = viewers.get(pk); if (!v) { v = makeViewer(); viewers.set(pk, v); }
    slot.appendChild(v.el); v.show(info);
  });
}
const dprV = () => Math.min(3, window.devicePixelRatio || 1);
function makeViewer() {
  const el = document.createElement('div'); el.className = 'fv';
  el.innerHTML = `<div class="fvarea"><img class="fvph" alt=""><canvas class="fvo"></canvas><canvas class="fvf"></canvas><span class="fvmsg"></span></div>
    <div class="fvbar"><button type="button" data-z="out" aria-label="ซูมออก">−</button><span class="fvpct num">100%</span><button type="button" data-z="in" aria-label="ซูมเข้า">+</button><button type="button" data-z="fit" title="พอดีกรอบ">พอดี</button>
      <span class="fvsp"></span><button type="button" data-z="full" title="ขยายเต็มจอ (Esc เพื่อออก)">ขยาย</button></div>
    <label class="fvslide small"><span>ต้นฉบับ</span><input type="range" min="0" max="100" step="1" aria-label="ความชัดของฟิล์มที่วางทับต้นฉบับ"><span>ฟิล์ม</span></label>`;
  const area = el.querySelector('.fvarea'), ph = el.querySelector('.fvph'), co = el.querySelector('.fvo'), cf = el.querySelector('.fvf'), msg = el.querySelector('.fvmsg');
  const slide = el.querySelector('input[type=range]'), pct = el.querySelector('.fvpct');
  const v = { el, key: null, data: null, scale: 1, tx: 0, ty: 0, fitScale: 1, drawn: null, gen: 0, tasks: [], timer: 0, w: 0, h: 0, pointers: new Map(), drag: null, pinch: null, zoomed: false };
  const boxW = () => { const b = v.data.film.box; return b[2] - b[0]; }, boxH = () => { const b = v.data.film.box; return b[3] - b[1]; };
  function size() {
    const w = area.clientWidth || 280;
    let h = 260;
    if (v.data && v.data.film && !el.classList.contains('full')) h = Math.max(180, Math.min(440, Math.round(w * boxH() / boxW())));
    if (!el.classList.contains('full')) area.style.height = h + 'px';
    v.w = area.clientWidth; v.h = area.clientHeight;
  }
  function fit() {
    if (!v.data || !v.data.film) return;
    size(); v.fitScale = Math.min(v.w / boxW(), v.h / boxH()) * 0.97;
    v.scale = v.fitScale; v.tx = (v.w - boxW() * v.scale) / 2; v.ty = (v.h - boxH() * v.scale) / 2; v.zoomed = false; changed(true);
  }
  function zoomAt(scale, cx, cy) {
    if (!v.data || !v.data.film) return;
    if (cx == null) { cx = v.w / 2; cy = v.h / 2; }
    scale = Math.max(v.fitScale * 0.5, Math.min(scale, v.fitScale * 40));
    v.tx = cx - (cx - v.tx) * scale / v.scale; v.ty = cy - (cy - v.ty) * scale / v.scale; v.scale = scale; v.zoomed = true; changed();
  }
  function changed(now) {
    pct.textContent = Math.round(v.scale / v.fitScale * 100) + '%';
    area.style.touchAction = v.scale > v.fitScale * 1.01 ? 'none' : 'pan-y';
    const r = v.drawn;   // quick: move the last sharp drawing with CSS until the new one is ready
    if (r) { const f = v.scale / r.scale, tf = `translate(${v.tx - r.tx * f}px,${v.ty - r.ty * f}px) scale(${f})`; co.style.transform = cf.style.transform = tf; }
    clearTimeout(v.timer); v.timer = setTimeout(draw, now ? 0 : 130);
  }
  async function layer(L, g, k) {
    const vp = L.page.getViewport({ scale: v.scale * k }), p0 = vp.convertToViewportPoint(L.box[0], L.box[3]);
    const t = L.page.render({ canvasContext: g, viewport: vp, transform: [1, 0, 0, 1, v.tx * k - p0[0], v.ty * k - p0[1]], background: 'rgba(0,0,0,0)' });
    v.tasks.push(t); await t.promise;
  }
  async function draw() {
    if (!v.data || !v.data.film || !el.isConnected) return;
    const gen = ++v.gen; v.tasks.forEach(t => { try { t.cancel(); } catch (e) {} }); v.tasks = [];
    size(); const k = dprV(), W = Math.max(1, Math.round(v.w * k)), H = Math.max(1, Math.round(v.h * k));
    const want = { scale: v.scale, tx: v.tx, ty: v.ty };
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); return [c, g]; };
    const [fo, go] = mk(), [ff, gf] = mk();
    try {
      if (v.data.orig) await layer(v.data.orig, go, k);
      await layer(v.data.film, gf, k);
    } catch (e) { if (!(e && e.name === 'RenderingCancelledException')) console.warn('viewer draw', e); return; }   // cancelled by a newer move
    if (gen !== v.gen) return;
    for (const [c, src] of [[co, fo], [cf, ff]]) { c.width = W; c.height = H; c.style.width = v.w + 'px'; c.style.height = v.h + 'px'; c.style.transform = ''; c.getContext('2d').drawImage(src, 0, 0); }
    v.drawn = want; ph.hidden = true; msg.hidden = true;
  }
  function opacity() { const o = fpOpacity(); slide.value = o; cf.style.opacity = v.data && v.data.orig ? o / 100 : 1; }
  v.show = (info) => {
    const { s, a, customer } = info, key = fpKey(s, a, customer);
    if (key === v.key) { opacity(); return; }
    v.key = key; const keepView = v.data && v.zoomed ? { scale: v.scale, tx: v.tx, ty: v.ty } : null;
    const cached = previewNow(s, a, customer);
    if (!v.data) { ph.src = a.preview ? fileUrl(a.preview, true) : ''; ph.hidden = !a.preview; }
    msg.hidden = false; msg.textContent = 'กำลังทำตัวอย่างฟิล์ม…';
    const use = (d) => {
      if (v.key !== key) return;
      if (d.err) { msg.hidden = false; msg.textContent = d.err; return; }
      v.data = d; el.querySelector('.fvslide').hidden = !d.orig; opacity();
      if (keepView) { size(); v.fitScale = Math.min(v.w / boxW(), v.h / boxH()) * 0.97; Object.assign(v, keepView, { zoomed: true }); changed(true); } else fit();
    };
    if (cached) use(cached);
    else if (!v.io) {   // start when it scrolls into view
      v.io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { v.io.disconnect(); v.io = null; const k2 = v.key; getPreview(s, a, customer).then(d => { if (v.key === k2) use(d); }); } });
      v.io.observe(el);
    } else { v.io.disconnect(); v.io = null; v.show(info); }
  };
  slide.addEventListener('input', () => {
    ui.fpOp = +slide.value; try { localStorage.setItem('stencil-fpop', slide.value); } catch (e) {}
    viewers.forEach(o => { const r = o.el.querySelector('input[type=range]'); if (r !== slide) r.value = slide.value; o.el.querySelector('.fvf').style.opacity = ui.fpOp / 100; });
  });
  el.querySelector('.fvbar').addEventListener('click', e => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    const z = b.dataset.z;
    if (z === 'in') zoomAt(v.scale * 1.6); else if (z === 'out') zoomAt(v.scale / 1.6); else if (z === 'fit') fit();
    else if (z === 'full') { const on = !el.classList.contains('full');
      if (b.dataset.nohist) delete b.dataset.nohist;   // closed by the back button: history already moved
      else if (on) openOverlay(); else if (history.state && history.state.overlay) { history.back(); return; } el.classList.toggle('full', on); document.body.style.overflow = on ? 'hidden' : ''; b.textContent = on ? 'ย่อกลับ' : 'ขยาย'; area.style.height = on ? '' : area.style.height; requestAnimationFrame(fit); }
  });
  // inside the picture the mouse wheel always zooms (at the pointer); outside it scrolls the page as usual
  area.addEventListener('wheel', e => {
    if (!v.data || !v.data.film) return;
    e.preventDefault();
    const r = area.getBoundingClientRect(), dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    const next = v.scale * Math.exp(-dy * (e.ctrlKey || e.metaKey ? 0.01 : 0.002));
    if (next <= v.fitScale) { if (v.zoomed) fit(); return; }   // zooming out stops at "fit"
    zoomAt(next, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  area.addEventListener('dblclick', e => { const r = area.getBoundingClientRect(); zoomAt(v.scale * 2.5, e.clientX - r.left, e.clientY - r.top); });
  area.addEventListener('pointerdown', e => {
    if (!v.data || e.button > 0) return;
    v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (v.pointers.size === 2) { const [p, q] = [...v.pointers.values()]; v.pinch = { d: Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)), scale: v.scale }; v.drag = null; area.setPointerCapture(e.pointerId); }
    else if (v.scale > v.fitScale * 1.01 || e.pointerType === 'mouse') { v.drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty }; area.setPointerCapture(e.pointerId); area.classList.add('grab'); }
  });
  area.addEventListener('pointermove', e => {
    if (!v.pointers.has(e.pointerId)) return;
    v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = area.getBoundingClientRect();
    if (v.pointers.size === 2 && v.pinch) { const [p, q] = [...v.pointers.values()]; zoomAt(v.pinch.scale * Math.hypot(p.x - q.x, p.y - q.y) / v.pinch.d, (p.x + q.x) / 2 - r.left, (p.y + q.y) / 2 - r.top); }
    else if (v.drag) { v.tx = v.drag.tx + e.clientX - v.drag.x; v.ty = v.drag.ty + e.clientY - v.drag.y; v.zoomed = true; changed(); }
  });
  const end = e => { v.pointers.delete(e.pointerId); if (v.pointers.size < 2) v.pinch = null; if (!v.pointers.size) { v.drag = null; area.classList.remove('grab'); } };
  area.addEventListener('pointerup', end); area.addEventListener('pointercancel', end);
  new ResizeObserver(() => { if (!v.data || !v.data.film) return; const ow = v.w; size(); if (!v.zoomed) fit(); else { v.tx += (v.w - ow) / 2; changed(true); } }).observe(area);
  return v;
}
// swipe right on a job-list row = "+ ขึ้นกาว" (touch / pen only; vertical scrolling stays with the browser via touch-action: pan-y)
(function swipeToCoat() {
  let g = null;
  const COMMIT = r => Math.min(140, r.width * 0.35);
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const w = e.target.closest('.swipe'); if (!w || e.target.closest('button')) return;
    g = { w, row: w.querySelector('.brow'), x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId, r: w.getBoundingClientRect() };
  });
  document.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.on) { if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; } if (dx < 12) return; g.on = true; g.w.classList.add('swiping'); }
    g.dx = Math.max(0, Math.min(dx, g.r.width * 0.8));
    g.row.style.transform = `translateX(${g.dx}px)`;
    g.w.classList.toggle('armed', g.dx >= COMMIT(g.r));
  });
  const end = async e => {
    if (!g || (e && e.pointerId !== g.id)) return;
    const { w, row, on, dx, r } = g; g = null;
    if (!on) return;
    const go = e && e.type === 'pointerup' && dx >= COMMIT(r);
    row.style.transition = 'transform .18s ease'; row.style.transform = 'translateX(0)';
    setTimeout(() => { row.style.transition = ''; w.classList.remove('swiping', 'armed'); }, 200);
    w.dataset.swiped = String(Date.now());   // the click that follows a swipe must not open the block
    if (!go) return;
    if (navigator.vibrate) try { navigator.vibrate(15); } catch (x) {}
    const { s } = find(w.dataset.j, w.dataset.v); if (!s) return;
    const last = s.coats[s.coats.length - 1];
    if (last && Date.now() - last.t < 3000) return;   // same guard as the button
    await addCoat(s, true);
  };
  document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  document.addEventListener('click', e => { const w = e.target.closest && e.target.closest('.swipe'); if (w && Date.now() - Number(w.dataset.swiped || 0) < 400) { e.stopPropagation(); e.preventDefault(); } }, true);
})();
// rows that act as buttons (they hold their own buttons, so they cannot be <button>s)
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][data-a]')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; const f = document.querySelector('.fv.full'); if (f) f.querySelector('[data-z="full"]').click(); });

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
    <span class="err" id="fserr"></span>
  </div>`;
}

function jobView() {
  const { j } = find(ui.jobId); if (!j) { ui.view = 'list'; return body(); }
  const waitFilm = j.screens.filter(needsFilm), cs = custSpec(j.customer);
  // laid out like the new-job form: the job card (customer, dates, spec, note), then the blocks
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <div class="spread"><h2>ใบงาน <span class="jobno h">${esc(j.no)}</span></h2><span class="${dueCls(j)}">${dueText(j)}</span></div>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div class="grid2">
      <div class="field"><label for="j-cust">ลูกค้า</label><input id="j-cust" value="${esc(j.customer)}" readonly title="เปลี่ยนลูกค้าไม่ได้หลังบันทึกใบงาน"></div>
      <div class="field"><label for="j-date">วันที่รับงาน</label><input id="j-date" type="date" value="${esc(jobDate(j))}" data-jf="date" data-v="${j.id}"></div>
      <div class="field"><label for="j-due">กำหนดส่ง</label><input id="j-due" type="date" value="${esc(j.due || '')}" data-jf="due" data-v="${j.id}"></div>
    </div>
    ${cs ? `<div class="spechint"><span class="label">สเปคประจำลูกค้า</span><span>${esc(specText(cs))}</span><span class="muted small">ค่าที่ใช้จริงของแต่ละบล็อคอยู่ในรายการด้านล่าง · แก้สเปคประจำได้ที่ ⚙ ตั้งค่า</span></div>` : ''}
    <div class="field"><label for="j-note">รายละเอียด / ข้อควรระวัง</label><textarea id="j-note" data-jf="note" data-v="${j.id}" placeholder="เช่น ชนิดหมึก งานเส้นเล็ก">${esc(j.note || '')}</textarea></div>
    <span class="muted small">สั่งโดย ${esc(j.createdBy)} · ${fmtT(j.createdAt)}${j.sentAt ? ` · ส่งลูกค้า ${fmtT(j.sentAt)}` : ''}</span>
  </div>
  <div class="spread"><h3>บล็อคที่ต้องขึ้น (${j.screens.length} ลาย)</h3>
    <button class="btn sm" data-a="labels" data-v="${j.id}" title="ลาเบล 20 × 2.2 cm เรียงต่อกันบนกระดาษสติกเกอร์ A4">พิมพ์ลาเบลติดบล็อค (${j.screens.length})</button></div>
  ${waitFilm.length ? `<div class="card spread"><span><b>ยังไม่ทำฟิล์ม ${waitFilm.length} บล็อค</b><br><span class="muted small">เปิดหน้าทำฟิล์มพร้อมบล็อคเหล่านี้ เรียงลงแผ่นได้ร่วมกับงานอื่น</span></span>
    <a class="btn primary" href="/film/?add=${waitFilm.map(s => s.id).join(',')}">ทำฟิล์ม</a></div>` : ''}
  <div class="jobcard">${j.screens.slice().sort(bySid).map(s => jobBlockRow(j, s)).join('')}</div>
  <div class="row"><button class="btn bad" data-a="deljob" data-v="${j.id}">${ui.arm === 'deljob' ? 'กดอีกครั้งเพื่อลบใบงานนี้' : 'ลบใบงาน'}</button></div>`;
}

/* --- screen detail --- */
function screenView() {
  const { j, s } = find(ui.jobId, ui.screenId); if (!s) { ui.view = 'list'; return body(); }
  const T = tol();
  const canCoat = ['ordered', 'coating', 'rework'].includes(s.status);
  const canQC = s.status === 'qc';
  const nextSide = s.coats.length && s.coats[s.coats.length - 1].side === 'ด้านพิมพ์' ? 'ด้านปาด' : 'ด้านพิมพ์';
  const m = db.master, a = s.artworkId ? artOf(s.artworkId) : null, edit = canCoat;
  const filmTag = waitingFile(s) ? '<span class="chip fl-wait">รอไฟล์จากลูกค้า</span>' : needsFilm(s) ? '<span class="chip fl-need">ยังไม่ทำฟิล์ม</span>' : s.film ? '<span class="chip fl-ok">ทำฟิล์มแล้ว</span>' : '';
  let h = `<button class="btn ghost back" data-a="back">← กลับ</button>
  <div class="spread shead"><div><h2>${esc(s.design || '(ยังไม่ตั้งชื่อ)')}</h2>
    <div class="small muted">${s.stencilId ? `<span class="sidtxt">${esc(s.stencilId)}</span> · ` : ''}${esc(j.no)} · ${esc(j.customer)} · <span class="${dueCls(j)}">${dueText(j)}</span></div></div>
    <span class="bstate">${filmTag}${chip(s.status)}<button class="btn sm ghost" data-a="labels" data-v="${j.id}" data-s="${s.id}">พิมพ์ลาเบล</button></span></div>
  ${j.note ? `<div class="card small"><span class="label">หมายเหตุจากอาร์ทเวิร์ค</span><br>${esc(j.note)}</div>` : ''}
  ${s.status === 'rework' && s.qc.note ? `<div class="card" style="border-color:var(--bad)"><span class="label" style="color:var(--bad)">เหตุผลที่ตีกลับ</span><br>${esc(s.qc.note)} <span class="muted small">— ${esc(s.qc.by)} ${fmtT(s.qc.at)}</span></div>` : ''}`;

  if ((!s.artworkId || ui.replaceArt === s.id) && db.features.files) h += attachCard(j, s);
  // one card, laid out like a row of the new-job form: picture/viewer | ลาย · สเปคบล็อค · ฟิล์ม
  s.originals = s.originals || [];
  const fileIds = a && a.file ? [a.file] : s.originals;   // read-only: the artwork's own file
  const sel = (k, list, label) => `<div class="field"><label for="e-${k}">${label}</label>${edit ? `<select id="e-${k}" data-f="${k}">${opt(list, s[k])}</select>` : `<div class="ro-v">${esc(s[k] || '-')}</div>`}</div>`;
  const f = s.film, t = encodeURIComponent(token);
  h += `<div class="card sr scard"><div class="srbody">
    ${a && a.filmable ? viewerSlot(pkOf('s', s), s, a, j.customer) : previewZone('s', s, true)}
    <div class="srfields">
      <fieldset class="grp"><legend>ลาย</legend>
        <div class="stack">
          ${db.features.ai ? nameField('s', s, 'e-name', 'data-f="design"') : `<div class="field"><label for="e-name">ชื่อลาย</label><input id="e-name" data-f="design" value="${esc(s.design)}"></div>`}
          <div class="field"><label for="e-cref">Customer REF</label><input id="e-cref" data-f="customerRef" value="${esc(s.customerRef || '')}"></div>
        </div>
        <div class="field"><span class="flabel">ไซส์</span>${sizeChips('s', s, true)}</div>
        ${db.features.files ? `<div class="field"><span class="flabel">ไฟล์ต้นฉบับจากลูกค้า</span>
          <div class="fileline"><div class="flist">${fileIds.map(id => fileChip(id, false)).join('') || '<span class="muted small">ยังไม่มีไฟล์</span>'}</div>
          ${s.artworkId && ui.replaceArt !== s.id ? '<button class="btn sm" data-a="replaceart">เปลี่ยนไฟล์ลาย</button>' : ''}</div></div>` : ''}
        ${a && !a.filmable ? '<span class="fstate">ไฟล์นี้ทำฟิล์มในแอปไม่ได้</span>' : ''}
      </fieldset>
      <fieldset class="grp"><legend>สเปคบล็อค</legend>
        ${frameSrcPicker('s', s)}
        <div class="grid4">
          ${sel('mesh', m.mesh, 'เบอร์ผ้าสกรีน')}${sel('frame', m.frames, 'ขนาดเฟรม')}${sel('emulsion', m.emulsions, 'ชนิดกาว')}
          <div class="field"><label for="e-target">ความหนาที่ต้องการ</label>${edit ? `<div class="unit"><input id="e-target" type="number" inputmode="numeric" data-f="target" value="${esc(s.target)}"><span>µm</span></div>` : `<div class="ro-v num">${esc(s.target)} µm</div>`}<span class="muted small">±${T} µm</span></div>
        </div>
      </fieldset>
      ${a && a.filmable ? filmGroup('s', s, a, j.customer) : ''}
      ${f || (a && a.filmable) ? `<div class="filmline small">${f ? `<span><span class="fstate ok">ทำฟิล์มแล้ว</span> <b>${esc(f.name.replace(/\.pdf$/i, ''))}</b> · ${fmtT(f.at)} โดย ${esc(f.by)}${f.compUm != null ? ` · ชดเชย <span class="num">${f.compUm} µm</span>` : ''}</span>
          <span class="row"><a class="btn sm" href="/api/films/${f.id}?dl=1&t=${t}" download="${esc(f.name || 'film.pdf')}">ดาวน์โหลด</a><a class="btn sm ghost" href="/film/?view=${f.id}">ดูฟิล์ม</a>${a && a.filmable ? `<a class="btn sm ghost" href="/film/?add=${s.id}">ลงแผ่นใหม่</a>` : ''}</span>`
        : '<span class="muted">ยังไม่ได้ลงแผ่นฟิล์ม · รอรวมลงแผ่นที่เมนู ฟิล์ม → + สร้างฟิล์ม</span>'}</div>` : ''}
    </div></div>
    <div id="uploads"></div>
  </div>`;

  // การขึ้นบล็อค: coat rounds (time only, no side), thickness before exposure, notes
  h += `<div class="card" style="display:flex;flex-direction:column;gap:12px">
    <h3>การขึ้นบล็อค</h3>
    <div class="spread"><span class="label">การขึ้นกาว</span><span class="muted small num">${s.coats.length} รอบ</span></div>
    <div class="coats">${s.coats.map((c, i) => `<div class="coat"><span class="n">${i + 1}</span>
      <span><b>ขึ้นกาว</b> <span class="muted small">โดย ${esc(c.by)}</span><br><span class="num small">${fmtT(c.t)}</span>${i ? ` <span class="gap">${fmtGap(c.t - s.coats[i - 1].t)}</span>` : ''}</span>
      ${canCoat && i === s.coats.length - 1 ? `<button class="btn sm ghost" data-a="undocoat">ลบ</button>` : '<span></span>'}</div>`).join('') || '<div class="muted small">ยังไม่ได้ขึ้นกาว</div>'}</div>
    ${canCoat ? `<div class="addcoat"><button class="btn primary" data-a="coat">+ ขึ้นกาว</button></div>
      <div class="muted small">กดตอนเริ่มปาดกาวแต่ละรอบ ระบบบันทึกวันและเวลาให้อัตโนมัติ</div>` : ''}
    <div class="thick">${thickField('thBefore', 'ความหนาก่อนถ่ายบล็อค', s, canCoat)}</div>
    <div class="field"><label for="c-note">หมายเหตุการขึ้นบล็อค</label>${canCoat ? `<textarea id="c-note" data-f="coatNote" placeholder="สภาพห้อง เวลาถ่าย ปัญหาที่พบ">${esc(s.coatNote)}</textarea>` : `<div>${esc(s.coatNote) || '<span class="muted">-</span>'}</div>`}</div>
    ${canCoat ? (() => { const miss = qcMissing(s);
      return `<div class="row" style="justify-content:flex-end"><span class="err" id="cerr">${miss.length ? 'ยังส่งตรวจไม่ได้: ' + miss.join(' · ') : ''}</span><button class="btn primary" data-a="toqc" ${miss.length ? 'disabled' : ''}>เสร็จแล้ว ส่งตรวจ</button></div>`; })() : ''}
  </div>`;

  if (['qc', 'ready', 'sent', 'rework'].includes(s.status) || s.photos.length) {
    const ro = !canQC;
    const ph = (p, i) => `<div class="ph"><img src="${photoSrc(p.id)}" alt="รูปที่ ${i + 1}" loading="lazy" data-a="zoom" data-v="${p.id}"><span class="cap">${esc(p.by)} ${fmtT(p.t)}</span>${ro ? '' : `<button class="x" data-a="delph" data-v="${p.id}" aria-label="ลบรูป">✕</button>`}</div>`;
    const add = (k, label, sub) => ro ? '' : `<label class="addph" for="phin-${k}">+ ${label}${sub ? `<br><span class="small">${sub}</span>` : ''}</label><input id="phin-${k}" type="file" accept="image/*" ${k === 'other' ? 'multiple' : 'capture="environment"'} hidden data-phk="${k}">`;
    const others = s.photos.filter(p => photoKindOf(s, p) === 'other');
    const pend = k => (ui.phPending || []).filter(x => x.sid === s.id && x.kind === k).map(x => `<div class="ph pending"><img src="${x.url}" alt=""><span class="cap">กำลังอัปโหลด…</span></div>`).join('');
    h += `<div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="spread"><h3>ตรวจงานก่อนส่ง</h3><span class="muted small">${s.photos.length} รูป</span></div>
      <div class="thick">${thickField('thAfter', 'ความหนาจริง (วัดตอนตรวจ)', s, canQC)}</div>
      <div class="qcphotos">${QC_PHOTOS.map(([k, label, sub]) => { const p = s.photos.find(x => photoKindOf(s, x) === k);
        return `<div class="qcslot"><span class="label">${label} <span class="req">*</span></span>${p ? ph(p, 0) : pend(k) || add(k, label, sub) || '<span class="muted small">ไม่มีรูป</span>'}</div>`; }).join('')}</div>
      <div><span class="label">รูปอื่น ๆ</span><div class="photos">${others.map(ph).join('')}${pend('other')}${add('other', 'เพิ่มรูป', 'เลือกได้หลายรูป')}</div></div>
      <div class="checks">${QC_CHECKS.map(([k, t]) => `<label class="check"><input type="checkbox" data-chk="${k}" ${s.qc.checks[k] ? 'checked' : ''} ${ro ? 'disabled' : ''}><span>${t}</span></label>`).join('')}</div>
      <div class="field"><label for="q-note">หมายเหตุการตรวจ</label>${ro ? `<div>${esc(s.qc.note) || '<span class="muted">-</span>'}${s.qc.by ? ` <span class="muted small">— ${esc(s.qc.by)} ${fmtT(s.qc.at)}</span>` : ''}</div>` : `<textarea id="q-note" data-q="note" placeholder="ถ้าตีกลับ ระบุสิ่งที่ต้องแก้">${esc(s.qc.note)}</textarea>`}</div>
      ${canQC ? `<div class="row" style="justify-content:flex-end"><span class="err" id="qerr"></span><button class="btn bad" data-a="rework">ตีกลับแก้ไข</button><button class="btn ok" data-a="pass">ผ่าน ตรวจสอบและจัดส่ง</button></div>` : ''}
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
      <div class="row" style="justify-content:flex-end"><span class="err" id="uerr"></span><button class="btn ghost" data-a="ucancel">ยกเลิก</button></div></div>`;
  const fx = db.features || {};
  const stat = (on, name, what) => `<div class="urow"><span class="fstate ${on ? 'ok' : ''}">${on ? 'เชื่อมแล้ว' : 'ยังไม่เชื่อม'}</span><span><b>${name}</b><br><span class="muted small">${what}</span></span><span></span></div>`;
  return `<button class="btn ghost back" data-a="back">← กลับ</button>
  <h2>ตั้งค่า</h2>
  <div class="card">
    <div class="spread"><h3>สถานะระบบ</h3><span class="muted small">เวอร์ชัน <b>${esc(window.APP_VERSION || '-')}</b></span></div>
    ${stat(true, 'ฐานข้อมูล D1', 'ใบงาน รอบขึ้นกาว รูปตรวจงาน')}
    ${stat(fx.files, 'ที่เก็บไฟล์ R2', 'ไฟล์ลูกค้า แผ่นฟิล์ม รูปตัวอย่างลาย')}
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
      ${[['mesh', 'เบอร์ผ้าสกรีน'], ['frames', 'ขนาดเฟรม'], ['emulsions', 'ชนิดกาว'], ['sizes', 'ไซส์'], ['customers', 'ลูกค้า']].map(([k, l]) => `<div class="field"><label for="ms-${k}">${l}</label><textarea id="ms-${k}" data-m="${k}" rows="6">${esc((k === 'sizes' ? sizeList() : m[k]).join('\n'))}</textarea></div>`).join('')}
      <div class="field"><label for="ms-tol">ค่าความหนาที่ยอมรับได้ (±)</label><div class="unit"><input id="ms-tol" type="number" data-m="tolerance" value="${esc(tol())}"><span>µm</span></div></div>
    </div>
  </div>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <div><h3>สเปคประจำลูกค้า</h3><div class="muted small">ใส่ให้อัตโนมัติเมื่อสร้างใบงานของลูกค้านั้น ระบบจำให้เองจากใบงานแรกของลูกค้าใหม่ แก้ที่นี่ได้</div></div>
    ${m.customers.length ? m.customers.map((c, i) => { const cs = (m.customerSpecs || {})[c] || {}, sel = (arr, v, k) => `<select data-cs="${i}" data-k="${k}" aria-label="${k}"><option value="">-</option>${(v && !arr.includes(v) ? [v, ...arr] : arr).map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
      return `<div class="csrow"><b>${esc(c)}</b><div class="csgrid">${sel(m.frames, cs.frame, 'frame')}${sel(m.mesh, cs.mesh, 'mesh')}${sel(m.emulsions, cs.emulsion, 'emulsion')}<div class="unit"><input type="number" data-cs="${i}" data-k="target" value="${esc(cs.target || '')}" placeholder="ความหนา" aria-label="ความหนา"><span>µm</span></div></div></div>`; }).join('') : '<div class="muted small">ยังไม่มีลูกค้า</div>'}
  </div>
  ${filmSettingsCard()}
  <div class="card spread"><div><h3>สำรองข้อมูล</h3><div class="muted small">ไฟล์ CSV เปิดด้วย Excel ได้ ทุกบล็อคทุกใบงาน</div></div>
    <a class="btn" href="/api/export.csv?t=${encodeURIComponent(token)}">ดาวน์โหลด CSV</a></div>
  <div class="savebar"><span class="err" id="serr"></span><button class="btn primary" data-a="settingssave" ${ui.busy ? 'disabled' : ''}>บันทึกการตั้งค่า</button></div>`;
}

const formKey = el => el.id ? '#' + el.id : el.dataset.cs != null ? `cs:${el.dataset.cs}:${el.dataset.k}` : null;
function formSnapshot() {
  const m = new Map(), main = document.querySelector('main'); if (!main) return m;
  main.querySelectorAll('input, textarea, select').forEach(el => { const k = formKey(el); if (k && el.dataset.u == null) m.set(k, el.type === 'checkbox' ? el.checked : el.value); });
  return m;
}
function formRestore(m) {
  document.querySelectorAll('main input, main textarea, main select').forEach(el => { const k = formKey(el); if (!k || !m.has(k)) return; if (el.type === 'checkbox') el.checked = m.get(k); else el.value = m.get(k); });
}
/* ---------- settings: one save for every card (users form, pick lists, customer specs, film) ---------- */
function readSettings() {
  const errs = [];
  // user being added/edited
  const u = ui.editUser;
  if (u) {
    if (!u.name.trim()) errs.push('พนักงาน: ใส่ชื่อ');
    else if ((u.pin || !u.id) && !/^\d{4}$/.test(u.pin)) errs.push('พนักงาน: PIN ต้องเป็นตัวเลข 4 หลัก');
  }
  // pick lists + customer specs
  const m = { ...db.master };
  for (const k of ['mesh', 'frames', 'emulsions', 'sizes', 'customers']) m[k] = $('#ms-' + k).value.split('\n').map(x => x.trim()).filter(Boolean);
  m.tolerance = Number($('#ms-tol').value) || 10;
  delete m.defaultTarget;
  const specs = {};   // only customers still on the list
  db.master.customers.forEach((c, i) => {
    const g = k => { const el = document.querySelector(`[data-cs="${i}"][data-k="${k}"]`); return el ? el.value.trim() : ''; };
    const sp = { frame: g('frame'), mesh: g('mesh'), emulsion: g('emulsion'), target: Number(g('target')) || '' };
    if (m.customers.includes(c) && (sp.frame || sp.mesh || sp.emulsion || sp.target)) specs[c] = sp;
  });
  m.customerSpecs = specs;
  // film
  let f = null;
  if (ui.filmSet && $('#fs-thicknesses')) {
    f = { ...ui.filmSet };
    for (const [k] of FILM_FIELDS) { const n = parseFloat($('#fs-' + k).value); if (!isFinite(n) || n < 0) { errs.push('ฟิล์ม: ช่องที่ต้องเป็นตัวเลขยังไม่ถูกต้อง'); break; } f[k] = n; }
    f.thicknesses = [...new Set($('#fs-thicknesses').value.split(/[,\s]+/).filter(Boolean).map(Number).filter(x => isFinite(x) && x >= 0))].sort((a, b) => a - b);
    f.labels = $('#fs-labels').checked; f.cropMarks = $('#fs-cropMarks').checked;
  }
  return { errs, u, m, f };
}
async function saveSettings() {
  const er = $('#serr'); er.textContent = '';
  const { errs, u, m, f } = readSettings();
  if (errs.length) { er.textContent = errs.join(' · '); return; }
  ui.busy = true; $('[data-a="settingssave"]').disabled = true;
  const fails = [];
  try { await api('PUT', '/master', m); db.master = m; } catch (x) { fails.push('รายการ/สเปคประจำ: ' + x.message); }
  if (f) {
    try { const r = await api('PUT', '/film-settings', { film: f, baseUpdated: ui.filmSet.updated || 0 }); ui.filmSet = { ...FILM_DEF, ...r.film }; filmSetP = null; }
    catch (x) {
      if (x.status === 409) { ui.filmSet = { ...FILM_DEF, ...x.data.film }; fails.push('ฟิล์ม: มีคนบันทึกก่อนหน้า แสดงค่าล่าสุดแล้ว ตรวจแล้วกดบันทึกอีกครั้ง'); }
      else fails.push('ฟิล์ม: ' + x.message);
    }
  }
  if (u) {
    try { await api('POST', '/admin/users', { ...u, name: u.name.trim() }); ui.editUser = null; ui.admin = await api('GET', '/admin/users'); }
    catch (x) { fails.push('พนักงาน: ' + x.message); }
  }
  ui.busy = false; ui.dropEdits = true; render();   // show what the server now holds
  if (fails.length) { const e2 = $('#serr'); if (e2) e2.textContent = fails.join(' · '); toast('บันทึกไม่ครบ'); } else toast('บันทึกการตั้งค่าแล้ว');
}

// what still stops a block from going to QC: the customer's file and at least one coat round
function qcMissing(s) {
  const m = [];
  if (waitingFile(s)) m.push('ยังไม่มีไฟล์ลายจากลูกค้า');
  if (!s.coats.length) m.push('ยังไม่ได้ขึ้นกาว');
  return m;
}
// one coat round: time + person; the first round moves the block from รอขึ้นบล็อค (or ตีกลับ) to กำลังขึ้นกาว
async function addCoat(s, named) {
  s.coats.push({ t: Date.now(), side: '', by: ui.user.name });
  if (s.status === 'ordered' || s.status === 'rework') { logEv(s, s.status === 'rework' ? 'เริ่มแก้งานตีกลับ' : 'เริ่มขึ้นกาว'); s.status = 'coating'; }
  render();
  if (await saveScreen(s)) toast(`ขึ้นกาวรอบที่ ${s.coats.length} แล้ว${named ? ' · ' + (s.design || s.stencilId || '') : ''}`);
}
/* ---------- stencil labels: 200 × 22 mm, stacked with no gap on A4 sticker paper (13 per sheet), cut along the lines ---------- */
function printLabels(j, screens) {
  const abs = u => location.origin + u;
  const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const one = s => {
    const date = s.coats && s.coats.length ? s.coats[0].t : Date.now();   // the day the stencil was coated (or today)
    const cell = (k, v, cls = '') => `<div class="c ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    return `<div class="lb">
      <div class="pic">${s.preview ? `<img src="${abs(fileUrl(s.preview, true))}" alt="">` : ''}</div>
      ${cell('Code', esc(s.stencilId || '-'), 'mono')}${cell('Date', ymd(date), 'mono')}
      ${cell('Design', `${esc(s.design || '-')}${(s.sizes || []).length ? ` <small>· ${esc(s.sizes.join(', '))}</small>` : ''}`, 'wide')}
      ${cell('Job', esc(j.no), 'mono')}
      ${cell('Mesh', esc(s.mesh || '-'), 'mono')}${cell('Thickness', `${esc(s.target || '-')} µm`, 'mono')}
      ${cell('Customer', `${esc(j.customer)}${s.customerRef ? ` <small>· ${esc(s.customerRef)}</small>` : ''}`, 'wide')}
      <div class="c last"><span class="k">Frame</span><span class="v">${esc(s.frame || '-')}${s.frameSource === 'customer' ? ' <small>(ลูกค้า)</small>' : ''}</span><span class="by">prepared by VICZO INTERNATIONAL co.,ltd.</span></div>
    </div>`;
  };
  const per = 13, sheets = [];
  for (let i = 0; i < screens.length; i += per) sheets.push(screens.slice(i, i + per));
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ลาเบล ${esc(j.no)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600&family=IBM+Plex+Mono:wght@500;600&display=swap">
<style>
@page { size: A4 portrait; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: "IBM Plex Sans Thai", sans-serif; color: #000; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.sheet { width: 210mm; height: 297mm; padding: 5.5mm 5mm; break-after: page; page-break-after: always }
.sheet:last-child { break-after: auto; page-break-after: auto }
.lb { width: 200mm; height: 22mm; display: grid; grid-template-columns: 30mm 34mm 34mm 68mm 34mm; grid-template-rows: 1fr 1fr;
  border: .3mm solid #000; margin-top: -.3mm; overflow: hidden }
.lb:first-child { margin-top: 0 }
.pic { grid-row: span 2; border-right: .3mm solid #000; display: grid; place-items: center; padding: .8mm; overflow: hidden }
.pic img { max-width: 100%; max-height: 20mm; object-fit: contain; display: block }
.c { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 1.2mm; padding: 0 1.4mm; border-right: .2mm solid #000; border-bottom: .2mm solid #000; min-width: 0; overflow: hidden }
.c:nth-child(n+6) { border-bottom: 0 }
.c .k { font-size: 6pt; color: #333 }
.c .v { font-size: 9pt; font-weight: 600; line-height: 1.15; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word }
.c .v small { font-size: 7pt; font-weight: 400 }
.c.mono .v { font-family: "IBM Plex Mono", monospace; font-size: 9pt }
.c.last { border-right: 0; grid-template-rows: auto auto; align-content: center; row-gap: 0 }
.c.last .by { grid-column: 1 / -1; font-size: 5pt; color: #333; line-height: 1.1 }
.lb > .c:nth-child(5) { border-right: 0 }
.tip { font: 12px sans-serif; color: #555; padding: 8px 12px; background: #f3f3f3 } @media print { .tip { display: none } }
</style></head><body>
<div class="tip">ลาเบล ${screens.length} ชิ้น · พิมพ์ที่ขนาด A4 · Scale 100% (ไม่ใช่ Fit to page) · ไม่มีขอบกระดาษ</div>
${sheets.map(sh => `<div class="sheet">${sh.map(one).join('')}</div>`).join('')}
<script>
  Promise.all([document.fonts ? document.fonts.ready : 0, ...[...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))])
    .then(() => setTimeout(() => window.print(), 200));
<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('เบราว์เซอร์บล็อกหน้าต่างใหม่ อนุญาตป๊อปอัปให้เว็บนี้แล้วกดอีกครั้ง'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

/* ---------- actions ---------- */
/* ---------- navigation + browser history: Android's back button / swipe-back steps back like "← กลับ" ---------- */
// every page change (list → job → block …) is a history entry; filters and search stay in the same entry
const navState = () => ({ app: 1, view: ui.view, jobId: ui.jobId, screenId: ui.screenId, backTo: ui.backTo, tab: ui.tab });
function go(view, o = {}) {
  const changes = view !== ui.view || ('jobId' in o && o.jobId !== ui.jobId) || ('screenId' in o && o.screenId !== ui.screenId);
  if (changes) try { history.replaceState({ ...(history.state || navState()), y: window.scrollY }, ''); } catch (e) {}   // come back to the same scroll spot
  Object.assign(ui, { view, arm: null }, o); render(); window.scrollTo(0, 0);
  try { if (changes) history.pushState(navState(), ''); else history.replaceState({ ...navState(), y: 0 }, ''); } catch (e) {}
}
// overlays (photo, full-screen viewer) also take a history entry, so back closes them first
function openOverlay() { try { history.pushState({ ...navState(), overlay: 1 }, ''); } catch (e) {} }
function closeOverlays() {
  let closed = false;
  if (!$('#lb').hidden) { $('#lb').hidden = true; closed = true; }
  const f = document.querySelector('.fv.full'); if (f) { f.querySelector('[data-z="full"]').dataset.nohist = '1'; f.querySelector('[data-z="full"]').click(); closed = true; }
  return closed;
}
window.addEventListener('popstate', e => {
  const st = e.state;
  if (closeOverlays() && st && st.app) return;   // the back press closed a photo / full-screen view
  if (!st || !st.app || !ui.user) return;
  ui.attachChoice = null; ui.attachOpen = false; ui.replaceArt = null;
  Object.assign(ui, { view: st.view || 'list', jobId: st.jobId || null, screenId: st.screenId || null, backTo: st.backTo || 'list', tab: st.tab || ui.tab, arm: null });
  render(); window.scrollTo(0, st.y || 0); requestAnimationFrame(() => window.scrollTo(0, st.y || 0));
});
try { history.scrollRestoration = 'manual'; if (!history.state || !history.state.app) history.replaceState(navState(), ''); } catch (e) {}   // the app restores the scroll spot itself
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  const a = el.dataset.a, v = el.dataset.v;
  if (a !== 'deljob' && a !== 'delfile' && a !== 'rmart' && a !== 'artdel') ui.arm = null;
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
    case 'tab': go('list', { tab: v, homeLimit: HOME_PAGE }); break;
    case 'morejobs': ui.homeLimit = (ui.homeLimit || HOME_PAGE) + HOME_PAGE; updateResults(); break;
    case 'clearq': ui.q = ''; render(); setTimeout(() => { const el = $('#q'); if (el) el.focus(); }); break;
    case 'settings': ui.admin = null; ui.editUser = null; ui.filmSet = null; go('settings'); break;
    case 'nav': go(v === 'library' ? 'library' : 'list'); break;
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
    case 'rmart': {   // ลายที่เพิ่งอัปโหลดผิด: เอาออกจากใบงานและลบออกจากคลัง (ยังไม่มีใบงานไหนใช้)
      if (ui.arm !== 'rmart:' + v) { ui.arm = 'rmart:' + v; render(); break; }
      ui.arm = null;
      try {
        const r = await api('DELETE', '/artworks/' + v);
        const a = artOf(v); if (r.hidden && a) a.hidden = true; else db.artworks = db.artworks.filter(x => x.id !== v);
        const d = ui.draft;
        if (d) { d.screens = d.screens.filter(x => x.artworkId !== v); d.newArts = (d.newArts || []).filter(x => x !== v); }
        toast('เอาลายออกแล้ว'); render();
      } catch (x) { toast('เอาลายออกไม่สำเร็จ: ' + x.message); }
      break;
    }
    case 'fpcol': { const s = targetObj(v); if (!s) break; const k = el.dataset.k, p = prepOf(s);
      setPrep(v, { notArt: p.notArt.includes(k) ? p.notArt.filter(x => x !== k) : [...p.notArt, k] }); break; }
    case 'framesrc': { const o = targetObj(v); if (!o || (o.frameSource || 'new') === el.dataset.k) break;
      o.frameSource = el.dataset.k;
      if (v === 's') { logEv(o, 'เปลี่ยนเป็น' + frameSrcText(o)); saveScreen(o); }
      render(); break; }
    case 'size': { const o = targetObj(v); if (!o) break; const k = el.dataset.k, cur = o.sizes || [];
      o.sizes = cur.includes(k) ? cur.filter(x => x !== k) : sizeList().filter(x => x === k || cur.includes(x)).concat(cur.filter(x => !sizeList().includes(x)));
      if (v === 's') { logEv(o, 'แก้ไซส์: ' + (o.sizes.join(', ') || 'ไม่ระบุ')); saveScreen(o); }
      render(); break; }
    case 'attachart': { const had = !!(cur().s || {}).artworkId; attachArt('s', artOf(v)); toast(had ? 'เปลี่ยนไฟล์ลายแล้ว' : 'เพิ่มไฟล์ลายให้บล็อคนี้แล้ว'); render(); break; }
    case 'toggleattach': ui.attachOpen = !ui.attachOpen; render(); break;
    case 'replaceart': ui.replaceArt = ui.screenId; ui.attachChoice = null; ui.attachOpen = false; ui.attachQ = ''; render(); setTimeout(() => { const c = $('#attachcard'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); break;
    case 'replacecancel': ui.replaceArt = null; ui.attachChoice = null; render(); break;
    case 'toggleold': ui.draft.showOld = !ui.draft.showOld; render(); break;
    case 'pickart': {
      const d = ui.draft, a = artOf(v); if (!a) break;
      const has = d.screens.some(x => x.artworkId === v);
      if (has) d.screens = d.screens.filter(x => x.artworkId !== v);
      else d.screens.push(screenFromArt(a));
      render(); break;
    }
    case 'back': if (history.length > 1 && history.state && history.state.app && history.state.view === ui.view && ui.view !== 'list') history.back(); else go(ui.view === 'screen' && ui.backTo === 'job' ? 'job' : 'list'); break;
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
      if (d.screens.some(s => !s.target)) return er.textContent = 'ใส่ความหนาที่ต้องการให้ครบทุกบล็อค';
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
    case 'openscreen': { ui.attachChoice = null; ui.attachOpen = false; ui.attachQ = ''; ui.replaceArt = null; const back = ui.view === 'job' ? 'job' : 'list'; go('screen', { jobId: el.dataset.j, screenId: v, backTo: back }); break; }
    case 'coat': { const { s } = cur(); await addCoat(s); break; }
    case 'labels': { const { j } = find(v); if (j) printLabels(j, el.dataset.s ? j.screens.filter(x => x.id === el.dataset.s) : j.screens); break; }
    case 'quickcoat': {   // the same as "+ ขึ้นกาว" on the block page, straight from the job list
      const { s } = find(el.dataset.j, v); if (!s) break;
      const last = s.coats[s.coats.length - 1];
      if (last && Date.now() - last.t < 3000) break;   // ignore a double tap
      await addCoat(s, true); break;
    }
    case 'undocoat': { const { s } = cur(); s.coats.pop(); if (!s.coats.length && s.status === 'coating') s.status = 'ordered'; render(); saveScreen(s); break; }
    case 'toqc': {
      const { s } = cur();
      const miss = qcMissing(s); if (miss.length) return $('#cerr').textContent = 'ยังส่งตรวจไม่ได้: ' + miss.join(' · ');
      s.status = 'qc'; logEv(s, 'ส่งตรวจ');
      if (await saveScreen(s)) { toast('ส่งให้ฝ่ายตรวจแล้ว'); go('list'); }
      break;
    }
    case 'delph': {
      const { s } = cur();
      try { await api('DELETE', '/photos/' + v); s.photos = s.photos.filter(p => p.id !== v); if (s.photoKind && s.photoKind[v]) { delete s.photoKind[v]; saveScreen(s); } render(); } catch (x) { toast(x.message); }
      break;
    }
    case 'zoom': $('#lbimg').src = photoSrc(v); $('#lb').hidden = false; openOverlay(); break;
    case 'zoomfile': $('#lbimg').src = fileUrl(v, true); $('#lb').hidden = false; openOverlay(); break;
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
      if (waitingFile(s)) return $('#qerr').textContent = 'บล็อคนี้ยังไม่มีไฟล์ลายจากลูกค้า เพิ่มไฟล์ลายก่อน';
      if (s.thAfter === '' || s.thAfter == null) return $('#qerr').textContent = 'ใส่ความหนาจริงที่วัดได้ก่อน';
      const miss = QC_PHOTOS.filter(([k]) => !s.photos.some(p => photoKindOf(s, p) === k)).map(x => x[1]);
      if (miss.length) return $('#qerr').textContent = 'ยังไม่มีรูป: ' + miss.join(', ');
      if (QC_CHECKS.some(([k]) => !s.qc.checks[k])) return $('#qerr').textContent = 'ติ๊กรายการตรวจให้ครบ';
      Object.assign(s.qc, { by: ui.user.name, at: Date.now() }); s.status = 'sent'; logEv(s, 'ตรวจสอบและจัดส่งแล้ว');
      if (await saveScreen(s)) { toast('ตรวจสอบและจัดส่งแล้ว'); go('list'); }
      break;
    }
    case 'rework': {
      const { s } = cur();
      if (!s.qc.note.trim()) return $('#qerr').textContent = 'ระบุเหตุผลที่ตีกลับในหมายเหตุ';
      Object.assign(s.qc, { by: ui.user.name, at: Date.now() }); s.status = 'rework'; logEv(s, 'ตีกลับแก้ไข');
      if (await saveScreen(s)) { toast('ตีกลับให้ฝ่ายขึ้นบล็อคแล้ว'); go('list'); }
      break;
    }
    case 'uadd': ui.editUser = { name: '', role: 'artwork', pin: '', active: true }; render(); break;
    case 'uedit': { const u = ui.admin.find(x => x.id === v); ui.editUser = { ...u, active: !!u.active, pin: '' }; render(); break; }
    case 'ucancel': ui.editUser = null; render(); break;
    case 'settingssave': await saveSettings(); break;
  }
});
$('#lb').addEventListener('click', () => { if (history.state && history.state.overlay) history.back(); else $('#lb').hidden = true; });

function updateResults() { const el = $('#q'), r = $('#homeres'); if (el) ui.q = el.value; if (r) r.innerHTML = homeResults(); }
// คีย์บอร์ดมือถือบางรุ่นส่งคำทีละช่วง: เช็กค่าซ้ำเมื่อพิมพ์จบคำหรือปล่อยปุ่ม
for (const ev of ['compositionupdate', 'compositionend', 'keyup']) document.addEventListener(ev, e => { if (e.target && e.target.id === 'q') { clearTimeout(ui.qTimer); ui.qTimer = setTimeout(updateResults, 120); } });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.search) {
    ui.q = t.value; ui.homeLimit = HOME_PAGE;
    const x = t.parentNode.querySelector('[data-a="clearq"]'); if (x) x.hidden = !ui.q;
    // อัปเดตเฉพาะผลค้นหา (ไม่วาดช่องพิมพ์ใหม่) จึงทำได้แม้คีย์บอร์ดยังขีดเส้นใต้คำที่กำลังพิมพ์อยู่
    clearTimeout(ui.qTimer); ui.qTimer = setTimeout(updateResults, 120);
    return;
  }
  if (t.dataset.attq) {
    ui.attachQ = t.value; const box = document.getElementById('attgrid'); if (!box) return;
    const { j, s } = find(ui.jobId, ui.screenId), q = searchTerms(t.value), lib = custArts(j.customer).filter(a => !s || a.id !== s.artworkId);
    const hits = q.length ? lib.filter(a => matches(norm([a.name, a.customerRef, a.fileName].join(' ')), q)) : lib;
    box.innerHTML = hits.length ? artGrid(hits, new Set(), 'attachart') : '<div class="muted small">ไม่พบลายที่ตรงกับคำค้น</div>';
    return;
  }
  if (t.dataset.oldq) {   // ค้นหาลายเก่า: วาดเฉพาะผลค้นหา ช่องพิมพ์ไม่หลุด
    ui.draft.oldQ = t.value; const box = document.getElementById('oldgrid'); if (!box) return;
    const d = ui.draft, picked = new Set(d.screens.map(x => x.artworkId).filter(Boolean)), fresh = d.newArts || [], q = searchTerms(t.value);
    const old = custArts(d.customer.trim()).filter(a => !picked.has(a.id) && !fresh.includes(a.id));
    const hit = q.length ? old.filter(a => matches(norm([a.name, a.customerRef, a.fileName].join(' ')), q)) : old;
    box.innerHTML = hit.length ? artGrid(hit, picked, 'pickart') : '<div class="muted small">ไม่พบลายที่ตรงกับคำค้น</div>';
    return;
  }
  if (t.dataset.d) {
    const k = t.dataset.d, d = ui.draft; d[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'customer') {
      // ลายที่เลือกไว้ของลูกค้าอื่นออกจากใบงาน
      const nm = t.value.trim(), before = d.screens.length;
      d.screens = d.screens.filter(x => !x.artworkId || (artOf(x.artworkId) || {}).customer === nm);
      // วาดใหม่เมื่อเป็นลูกค้าที่รู้จัก (แสดงคลังของเขา) หรือเมื่อช่องว่าง/ไม่ว่างเปลี่ยน (แสดงช่องอัปโหลด)
      const key = allCustomers().includes(nm) ? nm : nm ? '#typed' : '';
      if (d.libFor !== key || before !== d.screens.length) { d.libFor = key; d.showOld = false; render(); }
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
  if (t.dataset.s) { ui.draft.screens[+t.dataset.s][t.dataset.k] = t.value; if (t.tagName === 'SELECT' || t.dataset.k === 'target') render(); return; }
  if (t.dataset.d === 'customer') { render(); return; }
  if (t.dataset.f && ['mesh', 'frame', 'emulsion', 'target'].includes(t.dataset.f) && ui.view === 'screen') { const { s } = find(ui.jobId, ui.screenId); if (s) { s[t.dataset.f] = t.dataset.f === 'target' ? +t.value || '' : t.value; logEv(s, 'แก้สเปค: ' + t.dataset.f + ' = ' + t.value); saveScreen(s); render(); } return; }
  if (t.dataset.fp) {
    const k = t.dataset.k, s = targetObj(t.dataset.fp); if (!s) return;
    if (k === 'mode') { const p = prepOf(s); const patch = { mode: t.value };
      if (t.value === 'manual' && p.mode !== 'manual') patch.manualUm = Math.round((+s.target || 0) * ((filmSetCache || FILM_DEF).factor ?? 0.5));
      setPrep(t.dataset.fp, patch); }
    else if (k === 'manualUm') { const v = +t.value; if (isFinite(v) && v >= 0) setPrep(t.dataset.fp, { manualUm: v }); }
    return;
  }
  if (t.dataset.libcust) { ui.lib.cust = t.value.trim(); ui.lib.edit = null; render(); return; }
  if (t.dataset.art && ui.lib.edit) {
    const a = artOf(ui.lib.edit), k = t.dataset.art; if (!a) return;
    const old = a[k]; a[k] = t.value.trim();
    try { await api('PATCH', '/artworks/' + a.id, { [k]: a[k] }); toast('บันทึกแล้ว'); } catch (x) { a[k] = old; toast('บันทึกไม่สำเร็จ: ' + x.message); }
    render(); return;
  }
  if (t.dataset.attachfile && t.files.length) { const fs = [...t.files]; t.value = ''; attachFiles(t.dataset.attachfile, fs); return; }
  if (t.dataset.libfiles && t.files.length) {
    const fs = [...t.files]; t.value = '';
    const cust = ui.view === 'newjob' ? ui.draft.customer.trim() : ui.lib.cust;
    const made = await addArtworkFiles(cust, fs);
    if (ui.view === 'newjob' && ui.draft) { ui.draft.newArts = [...(ui.draft.newArts || []), ...made.map(a => a.id)]; made.filter(a => !ui.draft.screens.some(x => x.artworkId === a.id)).forEach(a => ui.draft.screens.push(screenFromArt(a))); render(); }
    return;
  }
  if (t.dataset.jf) {
    const { j } = find(t.dataset.v), k = t.dataset.jf; if (!j || (!t.value && k !== 'note')) return;   // the note may be emptied
    const old = j[k]; j[k] = t.value;
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
        const f = await uploadFile(file, 'original');
        (s[list] = s[list] || []).push(f.id);
        if (list === 'originals' && !s.customerRef) s.customerRef = stem(file.name);
        await saveScreen(s); render();
        if (list === 'originals' && !s.preview) { const blob = await previewFromFile(file); if (blob) await setPreview('s', new File([blob], 'preview.jpg', { type: 'image/jpeg' })); }
      } catch (x) { toast('อัปโหลดไม่สำเร็จ: ' + x.message); }
    }
    toast('อัปโหลดเสร็จแล้ว');
    return;
  }
  if (t.dataset.phk && t.files.length) {
    const { s } = find(ui.jobId, ui.screenId), files = [...t.files], kind = t.dataset.phk; t.value = '';
    // show each photo at once (local copy, "กำลังอัปโหลด…"), shrink and upload up to 3 at a time
    const jobs = files.map(f => ({ key: Math.random().toString(36).slice(2), sid: s.id, kind, url: URL.createObjectURL(f), f }));
    ui.phPending = [...(ui.phPending || []), ...jobs]; render();
    let n = 0, next = 0;
    const work = async () => {
      while (next < jobs.length) {
        const jb = jobs[next++];
        try {
          const blob = await shrink(jb.f); if (!blob) throw new Error('อ่านรูปไม่ได้');
          const p = await api('POST', `/screens/${s.id}/photos`, blob, true);
          localPhotos.set(p.id, URL.createObjectURL(blob)); recentPhotos.push({ sid: s.id, p, kind, at: Date.now() });
          // the block on screen may be a fresh copy by now (data reloaded): attach the photo to that one
          const cur = find(ui.jobId, s.id).s || s;
          if (!cur.photos.some(x => x.id === p.id)) cur.photos.push(p);
          if (kind !== 'other') cur.photoKind = { ...(cur.photoKind || {}), [p.id]: kind };
          n++;
        } catch (x) { toast('อัปโหลดรูปไม่สำเร็จ: ' + x.message); }
        ui.phPending = (ui.phPending || []).filter(x => x !== jb); URL.revokeObjectURL(jb.url);
        if (ui.view === 'screen') render();
      }
    };
    await Promise.all([work(), work(), work()]);
    if (n && kind !== 'other') { const cur = find(ui.jobId, s.id).s; if (cur) saveScreen(cur); }   // the photo's kind; no need to wait for it
    if (n) toast(`เพิ่ม ${n} รูปแล้ว`);
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
  if (z.dataset.drop === 'attach') { attachFiles('s', fs.slice(0, 1)); return; }
  if (z.dataset.drop === 'lib') {
    const cust = ui.view === 'newjob' ? ui.draft.customer.trim() : ui.lib.cust;
    addArtworkFiles(cust, fs).then(made => { if (ui.view === 'newjob' && ui.draft) { ui.draft.newArts = [...(ui.draft.newArts || []), ...made.map(a => a.id)]; made.filter(a => !ui.draft.screens.some(x => x.artworkId === a.id)).forEach(a => ui.draft.screens.push(screenFromArt(a))); render(); } });
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
// ลิงก์ตรงไปที่บล็อค: /#screen=<id> (จากหน้ารวมแผ่นฟิล์ม)
function openFromHash() {
  if (location.hash === '#films' && ui.user) { history.replaceState(null, '', location.pathname + location.search); return; }   // old link: the job list
  const m = location.hash.match(/^#screen=([\w-]+)$/); if (!m || !ui.user) return;
  history.replaceState(null, '', location.pathname + location.search);
  const x = allScreens().find(y => y.s.id === m[1]); if (!x) return;
  go('screen', { jobId: x.j.id, screenId: x.s.id, backTo: 'job' });
}
if (token) loadData().then(() => { if (!ui.user) loadUsers(); else { takeShared(); openFromHash(); } }); else loadUsers();
})();
