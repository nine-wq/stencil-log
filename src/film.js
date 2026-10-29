// ฟิล์ม positive (เดิมคือแอป film-positive): การตั้งค่าฟิล์ม ประวัติฟิล์ม PDF และไฟล์ต้นฉบับของงานที่ไม่ได้มาจากใบงาน
//   settings.key = 'film'                 -> การตั้งค่าแผ่นฟิล์ม มาร์ค การชดเชยขอบ (ใช้ร่วมกันทุกเครื่อง)
//   ตาราง film_outputs + R2 'film/<id>.pdf' -> ประวัติฟิล์มที่บันทึก, รูปตัวอย่างต่อลาย 'film/<id>/t<n>'
//   R2 'film/orig/<sha256>'               -> ต้นฉบับของไฟล์ที่ลากมาเองในหน้าฟิล์ม (เก็บครั้งเดียวต่อเนื้อหาไฟล์)
// ทุกเส้นทางต้องล็อกอิน (ตรวจใน index.js ก่อนเรียก filmApi)

const MAX_PDF = 60 * 1024 * 1024;
const MAX_THUMB = 300 * 1024;
const MAX_ORIG = 95 * 1024 * 1024;
const NUM_KEYS = ['sheetW', 'sheetH', 'margin', 'gap', 'markArm', 'markGrey', 'markWidthMm', 'labelGrey', 'nearWhite', 'speckMm', 'defaultThick', 'factor'];
const BOOL_KEYS = ['labels', 'cropMarks'];

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

function cleanSettings(input) {
  const out = {};
  for (const k of NUM_KEYS) { const v = Number(input[k]); if (Number.isFinite(v) && v >= 0 && v <= 100000) out[k] = v; }
  for (const k of BOOL_KEYS) if (typeof input[k] === 'boolean') out[k] = input[k];
  if (Array.isArray(input.thicknesses)) out.thicknesses = [...new Set(input.thicknesses.map(Number).filter(v => Number.isFinite(v) && v >= 0 && v <= 100000))].sort((a, b) => a - b).slice(0, 50);
  return out;
}
async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}
function customersFrom(master) {
  if (!master || !Array.isArray(master.customers)) return [];
  const specs = master.customerSpecs || {};
  return master.customers.map(name => {
    const t = Number(specs[name] && specs[name].target);
    return { name, thick: Number.isFinite(t) && t > 0 ? t : null };
  });
}
function safeName(s) {
  const n = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 180);
  return /\.pdf$/i.test(n) ? n : (n || 'film') + '.pdf';
}
const safeOrig = s => String(s || 'original').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 200) || 'original';
function cleanInfo(raw, me) {
  let o = {};
  try { o = JSON.parse(raw || '{}'); } catch { o = {}; }
  const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
  const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const id = v => (/^[\w-]{1,40}$/.test(String(v || '')) ? String(v) : '');
  const nums = (a, n) => (Array.isArray(a) ? a.slice(0, n).map(num) : null);
  // one item per design on the film: a snapshot of the block as it was when the film was made
  const items = Array.isArray(o.items) ? o.items.slice(0, 200).map(it => ({
    file: str(it.file), src: str(it.src), customer: str(it.customer, 100), thick: num(it.thick), compUm: num(it.compUm), mode: str(it.mode, 10),
    screenId: str(it.screenId, 40), jobNo: str(it.jobNo, 40), design: str(it.design, 80), thumb: false,
    stencilId: str(it.stencilId, 30), customerRef: str(it.customerRef, 120), sizes: Array.isArray(it.sizes) ? it.sizes.slice(0, 20).map(x => str(x, 30)) : [],
    frameSource: it.frameSource === 'customer' ? 'customer' : 'new', mesh: str(it.mesh, 40), frame: str(it.frame, 60), emulsion: str(it.emulsion, 60),
    pv: it.pv && id(it.pv.id) && Array.isArray(it.pv.box) ? { id: id(it.pv.id), box: nums(it.pv.box, 4) } : null,   // preview picture + the box it was cut from
    preview: id(it.preview), orig: id(it.orig), origName: str(it.origName, 200), page: num(it.page) || 0,
    place: it.place && typeof it.place === 'object' ? { si: num(it.place.si) || 0, x: num(it.place.x), y: num(it.place.y), w: num(it.place.w), h: num(it.place.h),
      W: num(it.place.W), H: num(it.place.H), rot: !!it.place.rot, bbox: nums(it.place.bbox, 4) } : null
  })) : [];
  return { sheets: num(o.sheets), blocks: num(o.blocks), sheetW: num(o.sheetW), sheetH: num(o.sheetH), date: str(o.date, 20), by: me.name, items, originals: [] };
}
async function nextFilmNo(env) {
  const r = await env.DB.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'fseq' RETURNING value").first();
  const th = new Date(Date.now() + 7 * 3600e3), p2 = n => String(n).padStart(2, '0');
  return `FM-${p2((th.getUTCFullYear() + 543) % 100)}${p2(th.getUTCMonth() + 1)}-${String(Number(r ? r.value : 1) - 1).padStart(3, '0')}`;
}
function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// returns a Response, or null when the path is not a film path
export async function filmApi(req, env, url, p, m, me) {
  if (p === '/film-settings') {
    if (m === 'GET') {
      const [film, master] = await Promise.all([getSetting(env, 'film'), getSetting(env, 'master')]);
      return json({ film: film || null, customers: customersFrom(master), features: { history: !!env.FILES, originals: !!env.FILES } });
    }
    if (m === 'PUT') {
      let body; try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
      const cur = await getSetting(env, 'film');
      if (cur && cur.updated && body.baseUpdated && Number(body.baseUpdated) < cur.updated) return json({ error: 'conflict', film: cur }, 409);
      const film = { ...(cur || {}), ...cleanSettings(body.film || {}), updated: Date.now() };
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('film', JSON.stringify(film)).run();
      return json({ film });
    }
    return json({ error: 'method' }, 405);
  }

  if (p === '/originals' && m === 'POST') {
    if (!env.FILES) return json({ error: 'no_r2' }, 503);
    const film = url.searchParams.get('film') || '';
    const row = /^[a-f0-9]{16}$/.test(film) ? await env.DB.prepare('SELECT info FROM film_outputs WHERE id = ?').bind(film).first() : null;
    if (!row) return json({ error: 'film_not_found' }, 404);
    const sha = String(url.searchParams.get('sha') || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) return json({ error: 'bad_sha' }, 400);
    const size = Number(req.headers.get('content-length') || 0);
    if (!size || !req.body) return json({ error: 'empty' }, 400);
    if (size > MAX_ORIG) return json({ error: 'too_large' }, 413);
    const name = safeOrig(url.searchParams.get('name'));
    const key = `film/orig/${sha}`;
    const have = await env.FILES.head(key);
    if (!have) {
      const type = /\.pdf$/i.test(name) ? 'application/pdf' : /\.ai$/i.test(name) ? 'application/postscript' : 'application/octet-stream';
      await env.FILES.put(key, req.body, { httpMetadata: { contentType: type }, customMetadata: { name } });
    } else if (req.body) { await req.body.cancel(); }
    const info = JSON.parse(row.info || '{}');
    info.originals = (info.originals || []).filter(o => o.name !== name);
    info.originals.push({ name, sha, size });
    await env.DB.prepare('UPDATE film_outputs SET info = ? WHERE id = ?').bind(JSON.stringify(info), film).run();
    return json({ name, sha, size, reused: !!have });
  }
  const om = p.match(/^\/originals\/([a-f0-9]{64})$/);
  if (om && m === 'GET') {
    if (!env.FILES) return json({ error: 'no_r2' }, 503);
    const obj = await env.FILES.get(`film/orig/${om[1]}`);
    if (!obj) return json({ error: 'not_found' }, 404);
    const name = safeOrig(url.searchParams.get('name') || (obj.customMetadata && obj.customMetadata.name) || 'original');
    return new Response(obj.body, { headers: {
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream', 'content-length': String(obj.size),
      'content-disposition': contentDisposition('attachment', name), 'cache-control': 'private, max-age=3600' } });
  }

  if (p !== '/films' && !p.startsWith('/films/')) return null;
  if (!env.FILES) return json({ error: 'no_r2', message: 'ยังไม่ได้เชื่อม R2 (binding FILES)' }, 503);

  // reserve the next film number before the PDF is drawn (it is printed under each design)
  if (p === '/films/reserve' && m === 'POST') return json({ no: await nextFilmNo(env) });

  if (p === '/films' && m === 'POST') {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > MAX_PDF + 2e6) return json({ error: 'too_large' }, 413);
    let form; try { form = await req.formData(); } catch { return json({ error: 'bad_form' }, 400); }
    const file = form.get('file');
    if (!file || typeof file === 'string') return json({ error: 'no_file' }, 400);
    const buf = await file.arrayBuffer();
    if (!buf.byteLength) return json({ error: 'empty' }, 400);
    if (buf.byteLength > MAX_PDF) return json({ error: 'too_large' }, 413);
    if (String.fromCharCode(...new Uint8Array(buf, 0, Math.min(5, buf.byteLength))) !== '%PDF-') return json({ error: 'not_pdf' }, 400);
    const info = cleanInfo(form.get('info'), me);
    const id = fid(), created = Date.now();
    // film number FM-<Thai YY><MM>-<NNN> (reserved by the page, or a new one); the file is named <number>_<date>_<time>.pdf (the browser's local time)
    const th = new Date(created + 7 * 3600e3);
    const given = String(form.get('no') || '');
    info.no = /^FM-\d{4}-\d{3,6}$/.test(given) ? given : await nextFilmNo(env);
    const stamp = String(form.get('stamp') || '');
    const name = safeName(`${info.no}_${/^\d{4}-\d{2}-\d{2}_\d{4,6}$/.test(stamp) ? stamp : th.toISOString().slice(0, 16).replace('T', '_').replace(':', '')}.pdf`);
    await env.FILES.put(`film/${id}.pdf`, buf, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { name } });
    const puts = [];
    for (let n = 0; n < info.items.length; n++) {
      const t = form.get('thumb_' + n);
      if (!t || typeof t === 'string' || !/^image\/(webp|jpeg|png)$/.test(t.type) || t.size > MAX_THUMB) continue;
      info.items[n].thumb = true;
      puts.push(env.FILES.put(`film/${id}/t${n}`, await t.arrayBuffer(), { httpMetadata: { contentType: t.type } }));
    }
    await Promise.all(puts);
    await env.DB.prepare('INSERT INTO film_outputs (id, name, created, size, info) VALUES (?, ?, ?, ?, ?)').bind(id, name, created, buf.byteLength, JSON.stringify(info)).run();
    return json({ id, name, created, size: buf.byteLength, info }, 201);
  }

  if (p === '/films' && m === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const before = Number(url.searchParams.get('before')) || 9e15;
    const from = Number(url.searchParams.get('from')) || 0;
    const to = Number(url.searchParams.get('to')) || 9e15;
    const words = String(url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    let sql = 'SELECT id, name, created, size, info FROM film_outputs WHERE created < ? AND created >= ? AND created < ?';
    const args = [before, from, to];
    // instr() not LIKE: D1 rejects LIKE patterns longer than 50 bytes
    for (const w of words) { sql += " AND instr(lower(name || ' ' || info), ?) > 0"; args.push(w.slice(0, 100)); }
    sql += ' ORDER BY created DESC LIMIT ?'; args.push(limit + 1);
    const r = await env.DB.prepare(sql).bind(...args).all();
    const rows = r.results.slice(0, limit).map(x => ({ id: x.id, name: x.name, created: x.created, size: x.size, info: JSON.parse(x.info || '{}') }));
    return json({ items: rows, more: r.results.length > limit });
  }

  const tm = p.match(/^\/films\/([a-f0-9]{16})\/t(\d{1,3})$/);
  if (tm && m === 'GET') {
    const obj = await env.FILES.get(`film/${tm[1]}/t${tm[2]}`);
    if (!obj) return new Response('not found', { status: 404 });
    return new Response(obj.body, { headers: { 'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/webp', 'cache-control': 'private, max-age=31536000, immutable' } });
  }

  // attach a saved film to the screens it carries: screen.film = {id, name, at, by, compUm, thick}, plus a log line
  const lm = p.match(/^\/films\/([a-f0-9]{16})\/link$/);
  if (lm && m === 'POST') {
    const row = await env.DB.prepare('SELECT id, name FROM film_outputs WHERE id = ?').bind(lm[1]).first();
    if (!row) return json({ error: 'not_found' }, 404);
    let body; try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const list = Array.isArray(body.screens) ? body.screens.slice(0, 200) : [];
    const now = Date.now(), done = [];
    for (const it of list) {
      const sid = String(it.id || '');
      if (!/^[\w-]{1,40}$/.test(sid)) continue;
      // read-modify-write with the screen's own lock (rev); retry a few times if someone saves at the same moment
      for (let k = 0; k < 4; k++) {
        const s = await env.DB.prepare('SELECT data, rev FROM screens WHERE id = ?').bind(sid).first();
        if (!s) break;
        const d = JSON.parse(s.data);
        const comp = Number(it.compUm), thick = Number(it.thick);
        d.film = { id: row.id, name: row.name, at: now, by: me.name, compUm: Number.isFinite(comp) ? comp : null, thick: Number.isFinite(thick) ? thick : null };
        (d.log ||= []).push([now, me.name, `ทำฟิล์มแล้ว (${row.name}${Number.isFinite(comp) ? `, ชดเชยขอบ ${comp} µm` : ''})`]);
        const r = await env.DB.prepare('UPDATE screens SET data = ?, rev = rev + 1, updated = ? WHERE id = ? AND rev = ? RETURNING rev').bind(JSON.stringify(d), now, sid, s.rev).first();
        if (r) { done.push(sid); break; }
      }
    }
    return json({ linked: done });
  }

  // one film's details (for the film page in view mode)
  const im = p.match(/^\/films\/([a-f0-9]{16})\/info$/);
  if (im && m === 'GET') {
    const x = await env.DB.prepare('SELECT id, name, created, size, info FROM film_outputs WHERE id = ?').bind(im[1]).first();
    if (!x) return json({ error: 'not_found' }, 404);
    return json({ id: x.id, name: x.name, created: x.created, size: x.size, info: JSON.parse(x.info || '{}') });
  }

  const mm = p.match(/^\/films\/([a-f0-9]{16})$/);
  if (mm) {
    const id = mm[1];
    const row = await env.DB.prepare('SELECT id, name FROM film_outputs WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not_found' }, 404);
    if (m === 'GET') {
      const obj = await env.FILES.get(`film/${id}.pdf`);
      if (!obj) return json({ error: 'file_missing' }, 404);
      const kind = url.searchParams.get('dl') ? 'attachment' : 'inline';
      return new Response(obj.body, { headers: {
        'content-type': 'application/pdf', 'content-length': String(obj.size),
        'content-disposition': contentDisposition(kind, row.name), 'cache-control': 'private, max-age=3600' } });
    }
    if (m === 'DELETE') {
      const meta = await env.DB.prepare('SELECT info FROM film_outputs WHERE id = ?').bind(id).first();
      let shas = [], refs = [];
      try {
        const inf = JSON.parse((meta && meta.info) || '{}');
        shas = (inf.originals || []).map(o => o.sha).filter(x => /^[a-f0-9]{64}$/.test(x));
        refs = [...new Set((inf.items || []).flatMap(x => [x.orig, x.preview]).filter(x => /^[\w-]{1,40}$/.test(String(x || ''))))];
      } catch {}
      await env.DB.prepare('DELETE FROM film_outputs WHERE id = ?').bind(id).run();
      // screens that pointed at this film go back to "waiting for film"
      try {
        const { results } = await env.DB.prepare('SELECT id, data FROM screens WHERE instr(data, ?) > 0').bind(id).all();
        for (const s of results) {
          const d = JSON.parse(s.data);
          if (!d.film || d.film.id !== id) continue;
          delete d.film; (d.log ||= []).push([Date.now(), me.name, 'ลบฟิล์มออกจากประวัติ']);
          await env.DB.prepare('UPDATE screens SET data = ?, rev = rev + 1, updated = ? WHERE id = ?').bind(JSON.stringify(d), Date.now(), s.id).run();
        }
      } catch (e) { console.log('film unlink', id, String(e && e.message || e)); }
      const keys = [`film/${id}.pdf`];
      try {
        const listed = await env.FILES.list({ prefix: `film/${id}/` });
        listed.objects.forEach(o => keys.push(o.key));
        for (const sha of shas) {
          const other = await env.DB.prepare('SELECT 1 FROM film_outputs WHERE instr(info, ?) > 0 LIMIT 1').bind(sha).first();
          if (!other) keys.push(`film/orig/${sha}`);
        }
        // the block's original and picture kept for this film's snapshot: remove them when nothing else uses them any more
        const gone = [];
        for (const f of refs) {
          const q = `"${f}"`;
          const used = await env.DB.prepare('SELECT 1 FROM screens WHERE instr(data, ?) > 0 LIMIT 1').bind(q).first()
            || await env.DB.prepare('SELECT 1 FROM artworks WHERE instr(data, ?) > 0 LIMIT 1').bind(q).first()
            || await env.DB.prepare('SELECT 1 FROM film_outputs WHERE instr(info, ?) > 0 LIMIT 1').bind(q).first();
          if (!used) { keys.push(f); gone.push(f); }
        }
        await env.FILES.delete(keys);
        if (gone.length) await env.DB.batch(gone.map(f => env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f)));
      } catch (e) { console.log('film delete cleanup', id, String(e && e.message || e)); }
      return json({ ok: true });
    }
    return json({ error: 'method' }, 405);
  }
  return json({ error: 'not_found' }, 404);
}
