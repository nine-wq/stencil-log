// Cloudflare Worker: API ของแอปบันทึกขึ้นบล็อค
// หน้าเว็บ (public/) ถูกเสิร์ฟอัตโนมัติ ส่วน /api/* มาที่โค้ดนี้
import { SCHEMA } from './schema.js';
import { filmApi } from './film.js';

const SESSION_DAYS = 60;
const MAX_FAILS = 5;
const LOCK_MIN = 5;
// ทุกคนที่ล็อกอินทำได้ทุกอย่าง (ยังเก็บคอลัมน์ role ไว้ในตาราง users แต่ไม่ใช้ตรวจสิทธิ์)
const ROLES = ['artwork', 'coater', 'qc', 'admin'];
const FILE_KINDS = ['original', 'prepared', 'preview'];
const AI_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it'
];
const AI_PROMPT = 'นี่คือภาพตัวอย่างลายสกรีน (เช่น ถุงเท้า เสื้อ) ตั้งชื่อเรียกลายนี้เป็นภาษาไทยสั้น ๆ 2–5 คำ ให้คนในโรงงานจำได้ทันทีว่าเป็นลายอะไร '
  + 'กติกา: (1) ถ้าในลายมีข้อความ ตัวหนังสือ หรือชื่อแบรนด์ ต้องใส่ข้อความนั้นในชื่อตามที่เห็น '
  + '(2) ห้ามใส่สีใด ๆ ในชื่อ เช่น แดง ดำ ขาว ชมพู สีแดง red เพราะงานพิมพ์ได้หลายสี '
  + '(3) ห้ามขึ้นต้นหรือใส่คำว่า "ลาย" '
  + 'ตัวอย่างชื่อที่ดี: "โลโก้ SKIMS" "แมวเล่นบอล" "จุดกลม BELLE" "อัศวิน PALLY" "ดาวพระจันทร์ Club Melani" '
  + 'ตอบเฉพาะชื่อบรรทัดเดียว ไม่ต้องอธิบาย';
// colour words are never part of a design name (the same design is printed in many colours)
const COLOUR_WORDS = ['สีแดง', 'สีดำ', 'สีขาว', 'สีชมพู', 'สีฟ้า', 'สีน้ำเงิน', 'สีเขียว', 'สีเหลือง', 'สีส้ม', 'สีม่วง', 'สีเทา', 'สีน้ำตาล', 'สีทอง', 'สีเงิน', 'สีครีม', 'สีกรม', 'สีบานเย็น',
  'แดง', 'ดำ', 'ขาว', 'ชมพู', 'ฟ้า', 'น้ำเงิน', 'เขียว', 'เหลือง', 'ส้ม', 'ม่วง', 'เทา', 'น้ำตาล', 'ทอง', 'กรม', 'บานเย็น', 'หลากสี', 'สีสัน',
  'red', 'black', 'white', 'pink', 'blue', 'green', 'yellow', 'orange', 'purple', 'grey', 'gray', 'brown', 'gold', 'silver', 'navy'];

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function cleanName(t) {
  const line = String(t).split('\n').map(x => x.trim()).find(Boolean) || '';
  let n = line.replace(/^(ชื่อลาย|ชื่อ|name)\s*[:：]\s*/i, '').replace(/^["'“”‘’「『]+|["'“”‘’」』.。]+$/g, '').trim();
  n = n.replace(/^ลาย\s*/, '').replace(/\s+ลาย(?=\s|$)/g, ' ');   // no "ลาย" (design) in the name
  // colours out, without breaking other words ("ท้องฟ้า", "Redbull" stay):
  // "สี<colour>" anywhere, and a colour word only when it is a whole word on its own
  for (const w of COLOUR_WORDS) if (w.startsWith('สี')) n = n.split(w).join(' ');
  // English colour words are left alone here: in a design they are usually printed text (e.g. "RED HEART"); the prompt keeps colours out
  const bare = new Set(COLOUR_WORDS.filter(w => !/^[a-z]+$/.test(w)));
  n = n.split(/\s+/).filter(tok => !bare.has(tok) && tok !== 'สี').join(' ');
  n = n.replace(/\s+/g, ' ').replace(/^[\s,·-]+|[\s,·-]+$/g, '').trim();
  return n.slice(0, 50);
}
function fileIdsOf(d) {
  return [...(d.originals || []), ...(d.prepared || []), ...(d.preview ? [d.preview] : [])];
}
const artFileIds = a => [a.file, a.preview].filter(Boolean);

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (status, error, extra = {}) => json({ error, ...extra }, status);
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function currentUser(req, env, url) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('t');
  if (!token) return null;
  const since = Date.now() - SESSION_DAYS * 864e5;
  return env.DB.prepare(
    `SELECT u.id, u.name, u.role, s.token FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.created > ? AND u.active = 1`
  ).bind(token, since).first();
}

// การตรวจฟิล์มของบล็อค (ทำตอนสร้างใบงาน): วิธีชดเชยขอบ ค่าที่ระบุเอง และสีที่ตัดออกจากลาย
function cleanPrep(p) {
  if (!p || typeof p !== 'object') return null;
  const mode = ['auto', 'manual', 'none'].includes(p.mode) ? p.mode : 'auto';
  const um = Number(p.manualUm);
  const notArt = Array.isArray(p.notArt) ? p.notArt.filter(k => typeof k === 'string').map(k => k.slice(0, 80)).slice(0, 50) : [];
  return { mode, manualUm: Number.isFinite(um) && um >= 0 && um <= 5000 ? um : 200, notArt };
}

// ลาย 1 ชิ้นในคลัง (ค่าที่รับจากหน้าเว็บ ตัดให้อยู่ในขอบเขต)
function cleanArt(it, me, now) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const box = Array.isArray(it.box) && it.box.length === 4 && it.box.every(v => Number.isFinite(Number(v))) ? it.box.map(Number) : null;
  return {
    name: str(it.name, 80).trim(), customerRef: str(it.customerRef, 120).trim(),
    file: /^[\w-]{1,40}$/.test(it.file || '') ? it.file : null, fileName: str(it.fileName, 200), sha: /^[a-f0-9]{64}$/.test(it.sha || '') ? it.sha : '',
    page: num(it.page) || 0, design: num(it.design), box, w: num(it.w), h: num(it.h), filmable: !!it.filmable,
    preview: /^[\w-]{1,40}$/.test(it.preview || '') ? it.preview : null, by: me.name, t: now
  };
}

async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? JSON.parse(r.value) : null;
}

// สร้าง/อัปเกรดตารางเองครั้งแรกที่ Worker เริ่มทำงาน ไม่ต้องรันคำสั่ง init
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // a share that arrives before the service worker is running: just open the app
    if (url.pathname === '/share-target') return Response.redirect(new URL('/?share=none', url).toString(), 303);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      await ensureSchema(env);
      return await api(req, env, url);
    } catch (e) {
      return err(500, 'server', { detail: String(e && e.message || e) });
    }
  }
};

async function api(req, env, url) {
  const p = url.pathname.slice(4); // ตัด "/api"
  const m = req.method;

  // ---------- ไม่ต้องล็อกอิน ----------
  if (m === 'GET' && p === '/users') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all();
    return json(results);
  }

  if (m === 'POST' && p === '/login') {
    const { userId, pin } = await req.json();
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(userId).first();
    if (!u) return err(404, 'ไม่พบผู้ใช้');
    const now = Date.now();
    if (u.locked_until > now) return err(429, 'locked', { until: u.locked_until });
    if (await sha256(`${u.id}:${pin}`) !== u.pin_hash) {
      const fails = u.fails + 1;
      if (fails >= MAX_FAILS) {
        await env.DB.prepare('UPDATE users SET fails = 0, locked_until = ? WHERE id = ?').bind(now + LOCK_MIN * 60e3, u.id).run();
        return err(429, 'locked', { until: now + LOCK_MIN * 60e3 });
      }
      await env.DB.prepare('UPDATE users SET fails = ? WHERE id = ?').bind(fails, u.id).run();
      return err(401, 'wrong_pin', { left: MAX_FAILS - fails });
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?').bind(u.id),
      env.DB.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').bind(token, u.id, now),
      env.DB.prepare('DELETE FROM sessions WHERE created < ?').bind(now - SESSION_DAYS * 864e5)
    ]);
    return json({ token, user: { id: u.id, name: u.name, role: u.role } });
  }

  // ---------- ต้องล็อกอิน ----------
  const me = await currentUser(req, env, url);
  if (!me) return err(401, 'กรุณาเข้าสู่ระบบใหม่');

  if (m === 'GET' && p === '/me') return json({ id: me.id, name: me.name, role: me.role });

  if (m === 'POST' && p === '/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(me.token).run();
    return json({ ok: true });
  }

  if (m === 'GET' && p === '/data') {
    const [master, jobsR, screensR, photosR, filesR, artR, sseq] = await Promise.all([
      getSetting(env, 'master'),
      env.DB.prepare('SELECT id, no, data, created FROM jobs ORDER BY created DESC').all(),
      env.DB.prepare('SELECT id, job_id, idx, data, rev FROM screens ORDER BY job_id, idx').all(),
      env.DB.prepare('SELECT id, screen_id, by_name, t FROM photos ORDER BY t').all(),
      env.DB.prepare('SELECT id, kind, name, type, size, by_name, t FROM files').all(),
      env.DB.prepare('SELECT id, customer, data, created FROM artworks ORDER BY created DESC').all(),
      getSetting(env, 'sseq')
    ]);
    const files = {};
    for (const f of filesR.results) files[f.id] = { id: f.id, kind: f.kind, name: f.name, type: f.type, size: f.size, by: f.by_name, t: f.t };
    const photos = {};
    for (const ph of photosR.results) (photos[ph.screen_id] ||= []).push({ id: ph.id, by: ph.by_name, t: ph.t });
    const screens = {};
    for (const s of screensR.results)
      (screens[s.job_id] ||= []).push({ ...JSON.parse(s.data), id: s.id, jobId: s.job_id, rev: s.rev, photos: photos[s.id] || [] });
    const jobs = jobsR.results.map(j => ({ ...JSON.parse(j.data), id: j.id, no: j.no, screens: screens[j.id] || [] }));
    const artworks = artR.results.map(a => ({ ...JSON.parse(a.data), id: a.id, customer: a.customer, created: a.created }));
    const used = new Set([...jobs.flatMap(j => j.screens.flatMap(fileIdsOf)), ...artworks.flatMap(artFileIds)]);
    const fileMap = Object.fromEntries(Object.entries(files).filter(([k]) => used.has(k)));
    return json({ master, jobs, artworks, stencilNext: Number(sseq) || 1, files: fileMap, features: { files: !!env.FILES, ai: !!env.AI }, me: { id: me.id, name: me.name, role: me.role } });
  }

  if (m === 'POST' && p === '/jobs') {
    const b = await req.json();
    if (!b.customer || !Array.isArray(b.screens) || !b.screens.length) return err(400, 'ข้อมูลใบงานไม่ครบ');
    const seqRow = await env.DB.prepare(
      "UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq' RETURNING value").first();
    const n = Number(seqRow.value) - 1;
    const d = new Date(Date.now() + 7 * 3600e3); // เวลาไทย
    const no = `JB-${String((d.getUTCFullYear() + 543) % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(n).padStart(3, '0')}`;
    // เลขบล็อคให้ทุกบล็อคในใบงานนี้ (จองช่วงเลขครั้งเดียว)
    const ss = await env.DB.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + ? WHERE key = 'sseq' RETURNING value").bind(b.screens.length).first();
    const sFirst = Number(ss.value) - b.screens.length;
    const yymm = `${String((d.getUTCFullYear() + 543) % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const id = uid(), now = Date.now();
    const jobData = { customer: String(b.customer).trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : new Date(now + 7 * 3600e3).toISOString().slice(0, 10), due: b.due, note: b.note || '', createdBy: me.name, createdAt: now };
    const stmts = [env.DB.prepare('INSERT INTO jobs (id, no, data, created) VALUES (?, ?, ?, ?)').bind(id, no, JSON.stringify(jobData), now)];
    b.screens.forEach((s, i) => {
      const sd = {
        stencilId: `ST-${yymm}-${String(sFirst + i).padStart(4, '0')}`,
        frameSource: s.frameSource === 'customer' ? 'customer' : 'new',
        design: s.design, customerRef: s.customerRef || '', sizes: Array.isArray(s.sizes) ? s.sizes.filter(x => typeof x === 'string').map(x => x.slice(0, 30)).slice(0, 30) : [], filmPrep: cleanPrep(s.filmPrep), artworkId: typeof s.artworkId === 'string' ? s.artworkId.slice(0, 40) : null,
        originals: Array.isArray(s.originals) ? s.originals : [], prepared: [], preview: s.preview || null,
        mesh: s.mesh, frame: s.frame, emulsion: s.emulsion, target: Number(s.target) || 0,
        status: 'ordered', coats: [], thBefore: '', thAfter: '', coatNote: '', qc: { checks: {}, note: '' },
        log: [[now, me.name, 'สั่งงาน']]
      };
      stmts.push(env.DB.prepare('INSERT INTO screens (id, job_id, idx, data, rev, updated) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(uid(), id, i, JSON.stringify(sd), now));
    });
    // เพิ่มชื่อลูกค้าใหม่เข้ารายการอัตโนมัติ
    const master = await getSetting(env, 'master');
    let dirty = false;
    if (!master.customers.includes(jobData.customer)) { master.customers.push(jobData.customer); dirty = true; }
    // จำสเปคประจำของลูกค้าจากบล็อคแรก เมื่อผู้ใช้ติ๊ก (ลูกค้าใหม่ติ๊กไว้ให้เป็นค่าเริ่มต้น)
    master.customerSpecs ||= {};
    const s0 = b.screens[0];
    if (s0 && b.saveSpec) {
      master.customerSpecs[jobData.customer] = { frame: s0.frame || '', mesh: s0.mesh || '', emulsion: s0.emulsion || '', target: Number(s0.target) || '' };
      dirty = true;
    }
    if (dirty) stmts.push(env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'master'").bind(JSON.stringify(master)));
    await env.DB.batch(stmts);
    return json({ id, no });
  }

  let mm;
  if ((mm = p.match(/^\/jobs\/([\w-]+)$/))) {
    const id = mm[1];
    if (m === 'DELETE') {
      const { results: sc } = await env.DB.prepare('SELECT data FROM screens WHERE job_id = ?').bind(id).all();
      // ลบเฉพาะไฟล์ที่ไม่มีใบงานอื่นหรือคลังลายใช้อยู่ (ไฟล์ลายในคลังใช้ซ้ำได้หลายใบงาน)
      const { results: others } = await env.DB.prepare('SELECT data FROM screens WHERE job_id != ?').bind(id).all();
      const { results: arts } = await env.DB.prepare('SELECT data FROM artworks').all();
      const keep = new Set([...others.flatMap(s => fileIdsOf(JSON.parse(s.data))), ...arts.flatMap(a => artFileIds(JSON.parse(a.data)))]);
      const fids = [...new Set(sc.flatMap(s => fileIdsOf(JSON.parse(s.data))))].filter(f => !keep.has(f));
      if (fids.length) {
        if (env.FILES) await env.FILES.delete(fids);
        await env.DB.batch(fids.map(f => env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f)));
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM photos WHERE screen_id IN (SELECT id FROM screens WHERE job_id = ?)').bind(id),
        env.DB.prepare('DELETE FROM screens WHERE job_id = ?').bind(id),
        env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id)
      ]);
      return json({ ok: true });
    }
    if (m === 'PATCH') { // แก้ข้อมูลหัวใบงาน หรือบันทึกวันส่ง
      const b = await req.json();
      const row = await env.DB.prepare('SELECT data FROM jobs WHERE id = ?').bind(id).first();
      if (!row) return err(404, 'ไม่พบใบงาน');
      const d = { ...JSON.parse(row.data) };
      for (const k of ['customer', 'date', 'due', 'note', 'sentAt']) if (k in b) d[k] = b[k];
      await env.DB.prepare('UPDATE jobs SET data = ? WHERE id = ?').bind(JSON.stringify(d), id).run();
      return json({ ok: true });
    }
  }

  if ((mm = p.match(/^\/screens\/([\w-]+)$/)) && m === 'PUT') {
    const { rev, data } = await req.json();
    const { id: _a, jobId: _b, rev: _c, photos: _d, ...clean } = data || {};
    const r = await env.DB.prepare('UPDATE screens SET data = ?, rev = rev + 1, updated = ? WHERE id = ? AND rev = ? RETURNING rev')
      .bind(JSON.stringify(clean), Date.now(), mm[1], rev).first();
    if (!r) return err(409, 'conflict');
    return json({ rev: r.rev });
  }

  if ((mm = p.match(/^\/screens\/([\w-]+)\/photos$/)) && m === 'POST') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 1.8e6) return err(413, 'รูปใหญ่เกินไป');
    const id = uid(), t = Date.now();
    await env.DB.prepare('INSERT INTO photos (id, screen_id, by_name, t, img) VALUES (?, ?, ?, ?, ?)')
      .bind(id, mm[1], me.name, t, buf).run();
    return json({ id, by: me.name, t });
  }

  if ((mm = p.match(/^\/photos\/([\w-]+)$/))) {
    if (m === 'GET') {
      const r = await env.DB.prepare('SELECT img FROM photos WHERE id = ?').bind(mm[1]).first();
      if (!r) return err(404, 'ไม่พบรูป');
      return new Response(new Uint8Array(r.img), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    if (m === 'DELETE') {
      await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(mm[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- คลังลายของลูกค้า ----------
  if (m === 'POST' && p === '/artworks') {
    const b = await req.json();
    const customer = String(b.customer || '').trim().slice(0, 100);
    if (!customer || !Array.isArray(b.items) || !b.items.length) return err(400, 'ข้อมูลลายไม่ครบ');
    const now = Date.now(), out = [], stmts = [];
    for (const it of b.items.slice(0, 100)) {
      const d = cleanArt(it, me, now);
      if (!d.file) continue;
      const id = uid();
      stmts.push(env.DB.prepare('INSERT INTO artworks (id, customer, data, created) VALUES (?, ?, ?, ?)').bind(id, customer, JSON.stringify(d), now));
      out.push({ ...d, id, customer, created: now });
    }
    if (!stmts.length) return err(400, 'ไม่มีลายที่บันทึกได้');
    // ลูกค้าใหม่: เพิ่มเข้ารายชื่อ
    const master = await getSetting(env, 'master');
    if (!master.customers.includes(customer)) { master.customers.push(customer); stmts.push(env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'master'").bind(JSON.stringify(master))); }
    await env.DB.batch(stmts);
    return json({ items: out });
  }
  if ((mm = p.match(/^\/artworks\/([\w-]+)$/))) {
    const row = await env.DB.prepare('SELECT customer, data FROM artworks WHERE id = ?').bind(mm[1]).first();
    if (!row) return err(404, 'ไม่พบลาย');
    const d = JSON.parse(row.data);
    if (m === 'PATCH') {
      const b = await req.json();
      if ('name' in b) d.name = String(b.name || '').trim().slice(0, 80);
      if ('customerRef' in b) d.customerRef = String(b.customerRef || '').trim().slice(0, 120);
      if ('hidden' in b) d.hidden = !!b.hidden;
      if ('preview' in b && typeof b.preview === 'string') d.preview = b.preview.slice(0, 40);
      let customer = row.customer;
      if ('customer' in b && String(b.customer || '').trim()) customer = String(b.customer).trim().slice(0, 100);
      await env.DB.prepare('UPDATE artworks SET customer = ?, data = ? WHERE id = ?').bind(customer, JSON.stringify(d), mm[1]).run();
      return json({ ...d, id: mm[1], customer });
    }
    if (m === 'DELETE') {
      // ลายที่ใบงานใช้อยู่: ซ่อนจากคลังแทนการลบ (ใบงานเดิมยังเปิดไฟล์ได้)
      const used = await env.DB.prepare('SELECT 1 FROM screens WHERE instr(data, ?) > 0 LIMIT 1').bind(`"artworkId":"${mm[1]}"`).first();
      if (used) {
        d.hidden = true;
        await env.DB.prepare('UPDATE artworks SET data = ? WHERE id = ?').bind(JSON.stringify(d), mm[1]).run();
        return json({ ok: true, hidden: true });
      }
      await env.DB.prepare('DELETE FROM artworks WHERE id = ?').bind(mm[1]).run();
      // ไฟล์ที่ไม่มีลายอื่นหรือใบงานไหนใช้แล้ว ลบทิ้ง
      const gone = [];
      for (const f of artFileIds(d)) {
        const other = await env.DB.prepare('SELECT 1 FROM artworks WHERE instr(data, ?) > 0 LIMIT 1').bind(`"${f}"`).first()
          || await env.DB.prepare('SELECT 1 FROM screens WHERE instr(data, ?) > 0 LIMIT 1').bind(`"${f}"`).first();
        if (!other) gone.push(f);
      }
      if (gone.length) {
        if (env.FILES) await env.FILES.delete(gone);
        await env.DB.batch(gone.map(f => env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f)));
      }
      return json({ ok: true });
    }
  }

  // ---------- ฟิล์ม positive ----------
  { const r = await filmApi(req, env, url, p, m, me); if (r) return r; }

  // ---------- ไฟล์งาน (R2) ----------
  if (m === 'POST' && p === '/files') {
    if (!env.FILES) return err(500, 'ยังไม่ได้เปิดใช้ R2 สำหรับเก็บไฟล์ (ดูขั้นตอนใน README)');
    const kind = url.searchParams.get('kind');
    if (!FILE_KINDS.includes(kind)) return err(400, 'ชนิดไฟล์ไม่ถูกต้อง');
    const name = (url.searchParams.get('name') || 'file').slice(0, 200);
    const type = req.headers.get('content-type') || 'application/octet-stream';
    const id = uid() + uid().slice(0, 4), t = Date.now();
    const obj = await env.FILES.put(id, req.body, { httpMetadata: { contentType: type } });
    await env.DB.prepare('INSERT INTO files (id, kind, name, type, size, by_name, t) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, kind, name, type, obj.size, me.name, t).run();
    return json({ id, kind, name, type, size: obj.size, by: me.name, t });
  }

  if ((mm = p.match(/^\/files\/([\w-]+)$/))) {
    const id = mm[1];
    if (m === 'GET') {
      if (!env.FILES) return err(500, 'ยังไม่ได้เปิดใช้ R2');
      const [obj, meta] = await Promise.all([env.FILES.get(id), env.DB.prepare('SELECT name FROM files WHERE id = ?').bind(id).first()]);
      if (!obj) return err(404, 'ไม่พบไฟล์');
      const disp = url.searchParams.get('inline') ? 'inline' : 'attachment';
      return new Response(obj.body, { headers: {
        'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'content-disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(meta?.name || id)}`,
        'cache-control': 'private, max-age=31536000, immutable'
      } });
    }
    if (m === 'DELETE') {
      // ไฟล์ที่ลายในคลังใช้อยู่ไม่ลบ (เอาออกจากบล็อคได้ แต่ไฟล์ยังอยู่ในคลังลาย)
      const inLib = await env.DB.prepare('SELECT 1 FROM artworks WHERE instr(data, ?) > 0 LIMIT 1').bind(`"${id}"`).first();
      if (inLib) return json({ ok: true, kept: true });
      if (env.FILES) await env.FILES.delete(id);
      await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  // ---------- AI ตั้งชื่อลายจากรูปตัวอย่าง ----------
  if (m === 'POST' && p === '/ai/name') {
    if (!env.AI) return err(500, 'ยังไม่ได้เปิดใช้ Workers AI');
    if (!env.FILES) return err(500, 'ยังไม่ได้เปิดใช้ R2');
    const { fileId } = await req.json();
    const obj = await env.FILES.get(fileId);
    if (!obj) return err(404, 'ไม่พบรูป');
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length > 3e6) return err(413, 'รูปใหญ่เกินไปสำหรับ AI');
    const dataUrl = `data:${obj.httpMetadata?.contentType || 'image/jpeg'};base64,${toBase64(bytes)}`;
    let lastErr = 'no response';
    for (const model of AI_MODELS) {
      try {
        const r = await env.AI.run(model, {
          messages: [{ role: 'user', content: [{ type: 'text', text: AI_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
          max_tokens: 40, temperature: 0.2
        });
        const name = cleanName(r?.response ?? r?.choices?.[0]?.message?.content ?? '');
        if (name) return json({ name, model });
        lastErr = `${model}: empty`;
      } catch (e) { lastErr = `${model}: ${e && e.message || e}`; }
    }
    return err(502, 'AI ตั้งชื่อไม่สำเร็จ ลองใหม่หรือพิมพ์ชื่อเอง', { detail: lastErr });
  }

  if (m === 'GET' && p === '/export.csv') {
    const [jobsR, screensR, filesR] = await Promise.all([
      env.DB.prepare('SELECT id, no, data FROM jobs').all(),
      env.DB.prepare('SELECT job_id, data FROM screens ORDER BY job_id, idx').all(),
      env.DB.prepare('SELECT id, name, by_name FROM files').all()
    ]);
    const jobs = Object.fromEntries(jobsR.results.map(j => [j.id, { no: j.no, ...JSON.parse(j.data) }]));
    const fname = Object.fromEntries(filesR.results.map(f => [f.id, `${f.name} (${f.by_name})`]));
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['เลขใบงาน', 'ลูกค้า', 'สั่งโดย', 'วันที่รับงาน', 'บันทึกเข้าระบบ', 'กำหนดส่ง', 'Stencil ID', 'Customer REF', 'ไซส์', 'บล็อค', 'ไฟล์ต้นฉบับ', 'แผ่นฟิล์ม', 'ลาย', 'ผ้า', 'เฟรม', 'กาว', 'สเปค µm', 'จำนวนรอบกาว', 'รอบกาว (เวลา/ด้าน/คน)', 'ก่อนถ่าย µm', 'หลังถ่าย µm', 'สถานะ', 'หมายเหตุขึ้นบล็อค', 'หมายเหตุตรวจ', 'ผู้ตรวจ']];
    const th = t => new Date(t + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
    for (const s of screensR.results) {
      const j = jobs[s.job_id] || {}, d = JSON.parse(s.data);
      rows.push([j.no, j.customer, j.createdBy, j.date || (j.createdAt ? th(j.createdAt).slice(0, 10) : ''), j.createdAt ? th(j.createdAt) : '', j.due, d.stencilId || '', d.customerRef, (d.sizes || []).join(' '), d.frameSource === 'customer' ? 'บล็อคเดิมลูกค้า' : 'บล็อคใหม่',
        (d.originals || []).map(f => fname[f] || f).join(' | '), d.film ? d.film.name : '', d.design, d.mesh, d.frame, d.emulsion, d.target,
        d.coats.length, d.coats.map(c => `${th(c.t)} ${c.side} ${c.by}`).join(' | '), d.thBefore, d.thAfter, d.status, d.coatNote, d.qc?.note, d.qc?.by]);
    }
    const csv = '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="stencil-log-${Date.now()}.csv"` } });
  }

  // ---------- ผู้ดูแล ----------
  if (p.startsWith('/admin/') || p === '/master') {
    if (m === 'PUT' && p === '/master') {
      const b = await req.json();
      await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'master'").bind(JSON.stringify(b)).run();
      return json({ ok: true });
    }
    if (m === 'GET' && p === '/admin/users') {
      const { results } = await env.DB.prepare('SELECT id, name, role, active FROM users ORDER BY active DESC, name').all();
      return json(results);
    }
    if (m === 'POST' && p === '/admin/users') {
      const b = await req.json();
      if (!b.name) return err(400, 'ข้อมูลไม่ครบ');
      if (!ROLES.includes(b.role)) b.role = 'artwork';
      if (b.pin && !/^\d{4}$/.test(b.pin)) return err(400, 'PIN ต้องเป็นตัวเลข 4 หลัก');
      if (b.id) {
        if (b.id === me.id && !b.active) return err(400, 'ปิดการใช้งานชื่อของตัวเองไม่ได้');
        await env.DB.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').bind(b.name, b.role, b.active ? 1 : 0, b.id).run();
        if (b.pin) await env.DB.prepare('UPDATE users SET pin_hash = ?, fails = 0, locked_until = 0 WHERE id = ?').bind(await sha256(`${b.id}:${b.pin}`), b.id).run();
        if (!b.active) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(b.id).run();
        return json({ ok: true });
      }
      if (!b.pin) return err(400, 'ต้องตั้ง PIN ให้ผู้ใช้ใหม่');
      const id = uid();
      await env.DB.prepare('INSERT INTO users (id, name, role, pin_hash, active) VALUES (?, ?, ?, ?, 1)')
        .bind(id, b.name, b.role, await sha256(`${id}:${b.pin}`)).run();
      return json({ id });
    }
  }

  return err(404, 'not_found');
}
