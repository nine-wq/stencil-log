// New version notice: an installed app keeps its page open for days, so after a deploy the phone can still show
// the old version. When the app comes back to the screen it checks whether the page or its code changed on the
// server, and shows a bar "มีเวอร์ชันใหม่ แตะเพื่ออัปเดต" (no automatic reload: unsaved work stays until the user taps).
// The app version shown in ⚙ ตั้งค่า. Bump it with every change that is pushed, and tell Nine the new number.
window.APP_VERSION = '1.2';
(function () {
  const files = location.pathname.startsWith('/film') ? ['/film/', '/film/js/film-core.js'] : ['/', '/app.js', '/style.css'];
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return h; };
  const print = async () => (await Promise.all(files.map(async (f) => {
    const h = await fetch(f, { method: 'HEAD', cache: 'no-store' });   // the ETag is enough when the server sends one
    const tag = h.ok && h.headers.get('etag'); if (tag) return tag;
    const r = await fetch(f, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return hash(await r.text());
  }))).join(':');
  let base = null, last = 0, shown = false;
  async function check(force) {
    if (shown || !navigator.onLine || (!force && Date.now() - last < 30000)) return;
    if (base !== null) last = Date.now();   // the first call only records the version as loaded
    try {
      const now = await print();
      if (base === null) { base = now; return; }
      if (now !== base) show();
    } catch (e) {}
  }
  function show() {
    shown = true;
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'มีเวอร์ชันใหม่ แตะเพื่ออัปเดต';
    b.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9999;' +
      'font:600 15px system-ui,sans-serif;color:#fff;background:#3b5bdb;border:0;border-radius:999px;padding:11px 18px;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer;max-width:calc(100vw - 32px)');
    b.addEventListener('click', () => location.reload());
    document.body.appendChild(b);
  }
  // the page as loaded = the base; then check when the app comes back to the screen
  window.addEventListener('load', () => setTimeout(() => check(true), 1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(true); });   // back to a page kept in memory
})();
