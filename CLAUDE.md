# CLAUDE.md: Stencil log app (บันทึกขึ้นบล็อค) + film positive

Internal web app for Viczo International (screen-printing ink maker, Thailand). Small team, Thai UI.
Owner: Nine. Staff use it on phones and desktop PCs. The former film-positive app is merged in here (page `/film/`).

## Workflow
Everyone who logs in (name + PIN) can do everything. There are no role checks; the `users.role` column is kept but unused.
Main menu: ใบงาน (jobs) · คลังลาย (artwork library) · ทำฟิล์ม (film page, with a count of screens waiting for film).

1. **Artwork library** (`artworks` table, one row = one design = one left/right pair from a customer file):
   - Upload a customer's files under a customer, from คลังลาย or inside the new-job form.
   - The browser runs the film core on .ai (PDF-compatible) / .pdf files and makes one artwork per design found in the platen frames, on every page.
   - Each artwork has a picture cut out of the page (preview file), a Customer ID (file stem plus "หน้า n" / "ลาย k"), and `{page, design, box}` locating it in the file.
   - Workers AI names each artwork in the background.
   - The original is uploaded once per content (sha256, reused across artworks).
   - Images and other files become a single artwork with `filmable: false`.
   - Delete removes the row and its unused files, or hides the artwork (`hidden`) when a screen uses it.
2. **New job**:
   - Pick the customer, then upload new files at the top. Newly uploaded artworks are ticked automatically, and each ticked artwork = one screen (บล็อค).
   - Older library artworks of that customer are folded under "เลือกจากลายเก่าในคลัง (n)", which has a search box.
   - The screen gets `artworkId`, `originals: [artwork.file]`, `preview`, `design` (artwork name) and `customerRef`, plus the customer's default spec (frame, mesh, emulsion, target µm).
   - "+ เพิ่มบล็อคที่ไม่มีไฟล์ลาย" adds a manual screen without an artwork; it can't be filmed.
3. **Film** (`public/film/`, built from the film app):
   - "บล็อครอทำฟิล์ม" lists screens with a filmable artwork, no `film`, and not sent.
   - Adding a screen loads the artwork's original from R2, keeps only that design (nearest `box`), and sets the job's customer and the screen's `target` as stencil thickness.
   - Files can also be dropped by hand for work without a job.
   - Saving always stores the history copy, then `POST /api/films/:id/link` sets `screen.film = {id, name, at, by, compUm, thick}` and adds a log line.
   - Deleting a film from history removes `film` from its screens again.
   - `/film/?add=<screenId,…>` opens the page with those screens (from the job/screen pages).
4. **Coater**: logs coat rounds (ด้านพิมพ์ / ด้านปาด) and thickness before/after exposure, then sends to QC.
5. **QC/finishing**: at least 2 photos plus the checklist, then pass (→ ready) or rework.

**Home list**:
- Stage filters: ทั้งหมด, รอทำฟิล์ม, ขึ้นบล็อค, รอตรวจ, พร้อมส่ง, ส่งแล้ว.
- Grouping by job date or by customer (remembered per browser).
- The search box matches jobs, blocks, files and people.

**Settings** (⚙, everyone): users/PINs, pick lists, customer default specs (`master.customerSpecs`), tolerance, film settings (`settings.key='film'`: sheet size, margins, marks, compensation factor, near-white, specks, thickness list), CSV export.

Screen status flow: `ordered → coating → qc → ready → sent`, with `qc → rework → coating`. Film is a separate flag (`screen.film`), not a status.

## Stack
- Cloudflare Worker `src/index.js` serves `/api/*`. Film routes are in `src/film.js` (`/api/film-settings`, `/api/films*`, `/api/originals*`), and all routes need login.
- Static assets in `public/` (vanilla JS, no build step):
  - `public/film/index.html` + `public/film/js/film-core.js` + `public/film/vendor/` (pdf-lib 1.17.1, JSZip 3.10.1, PDF.js 3.11.174).
  - `public/app.js` lazy-loads these for the library.
- D1 (`DB`): tables users, sessions, jobs, screens, photos (QC photos as BLOB), files (metadata), settings, artworks, film_outputs.
  - Job and screen details are JSON in a `data` column; screens use optimistic locking (`rev`, 409 on conflict).
- R2 (`FILES`, bucket `stencil-files`):
  - files under random IDs (originals, prepared, previews)
  - films under `film/<id>.pdf` with thumbnails at `film/<id>/t<n>`
  - originals of hand-dropped film files at `film/orig/<sha256>`
- Deleting a job removes only files that no other screen or artwork uses. `DELETE /api/files/:id` keeps files that an artwork uses.
- Workers AI (`AI`): `/api/ai/name` tries llama-4-scout → mistral-small-3.1 → gemma-3-12b in order.
- Auth: pick a name + 4-digit PIN; sha256(`<userId>:<pin>`); bearer-token sessions, 60 days; lockout after 5 failures.
  - The film page reads the same token (`localStorage['stencil-token']`).
  - `<img>`/download links pass `?t=<token>`.
- PWA:
  - `manifest.webmanifest` + `sw.js`: network-first app shell, offline start, never caches `/api/`.
  - Share target: POST `/share-target` → the service worker stores the files in cache `film-share` → `/?share=…` → the library asks which customer they belong to.
  - Bump `SHELL` in sw.js when the cached asset list changes.

## Film core rules (public/film/js/film-core.js; edit it and public/film/index.html directly, there is no build step)
- Designs are found from platen frames (dashed/solid rectangles, closed sock outlines, outlined rings). Same-size frames side by side = one design (left + right).
- Artwork = printable elements inside a frame. Guides are decided by role, not by line weight.
- Single-colour film: every artwork colour → black; white and near-white knock out.
- Spot colours (Separation/DeviceN) count as ink tints.
- Edge compensation: auto = thickness × factor (default 0.5), or a manual µm value, or none.
- Marks: 3 faint crosses plus a 2-line faint label.

## Rules
- **Schema changes** go in `src/schema.js` and must be idempotent (`CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`).
  - The Worker applies the schema on cold start, so there is no manual migration step.
  - Never drop or rename existing columns or tables. For a new field, prefer adding it to the screen/job JSON `data`, with a default in the frontend.
- D1 rejects LIKE/GLOB patterns longer than 50 bytes; use `instr()` for substring matches.
- **Deploy** = push to `main`; Cloudflare Workers Builds runs `npx wrangler deploy`. Do not commit secrets.
- Keep everything free-tier: Workers 100k req/day, CPU 10 ms (no image or PDF processing server-side; it happens in the browser), D1 5 GB, R2 10 GB, AI 10k neurons/day.
- UI text in Thai. Must work at 400 px phone width and in dark mode (CSS tokens in `public/style.css`; the film page uses the same blue accent).
- Before pushing:
  - `node --check public/app.js`
  - `node --check public/sw.js`
  - `node --check public/film/js/film-core.js`
  - `node --check --input-type=module < src/index.js`
  - ideally `npx wrangler dev` (without the `ai` binding) and click through the changed flow
