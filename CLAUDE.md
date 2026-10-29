# CLAUDE.md: Stencil log app (บันทึกขึ้นบล็อค) + film positive

Internal web app for Viczo International (screen-printing ink maker, Thailand). Small team, Thai UI.
Owner: Nine. Staff use it on phones and desktop PCs. The former film-positive app is merged in here (page `/film/`).

## Workflow
Everyone who logs in (name + PIN) can do everything. There are no role checks; the `users.role` column is kept but unused.
Main menu (tabs in the app): ใบงาน (jobs) · ฟิล์ม (film history, with a count of screens waiting for film) · คลังลาย (artwork library).

1. **Artwork library** (`artworks` table, one row = one design = one left/right pair from a customer file):
   - Upload a customer's files under a customer, from คลังลาย or inside the new-job form.
   - The browser runs the film core on .ai (PDF-compatible) / .pdf files and makes one artwork per design found in the platen frames, on every page.
   - Each artwork has a picture cut out of the page (preview file), a Customer REF (file stem plus "หน้า n" / "ลาย k"), and `{page, design, box}` locating it in the file.
   - Workers AI names each artwork in the background.
   - The original is uploaded once per content (sha256, reused across artworks).
   - Images and other files become a single artwork with `filmable: false`.
   - Delete removes the row and its unused files, or hides the artwork (`hidden`) when a screen uses it.
2. **New job**:
   - Pick the customer, then upload new files at the top. Newly uploaded artworks are ticked automatically, and each ticked artwork = one screen (บล็อค).
   - Artworks uploaded in this form get a ✕ (tap twice) that removes them from the job and deletes them from the library.
   - Older library artworks of that customer are folded under "เลือกจากลายเก่าในคลัง (n)", which has a search box.
   - **Stencil ID**: every new screen gets `stencilId` = `ST-<Thai YY><MM>-<NNNN>` from the `settings.sseq` counter when the job is saved. The form shows the predicted number (`/api/data` returns `stencilNext`). It appears on rows, the screen page, the film queue and cards, the film label (stencil ID + Customer REF), search and CSV.
   - The screen gets `artworkId`, `originals: [artwork.file]`, `preview`, `design` (artwork name) and `customerRef`, plus the customer's default spec (frame, mesh, emulsion, target µm).
   - **Waiting for the customer's file**: "+ เพิ่มบล็อครอไฟล์จากลูกค้า" adds a screen with no artwork yet. Its name may be empty, and the job can be saved so stencil prep starts in parallel.
     - The row shows a "รอไฟล์จากลูกค้า" box with an upload button. Home rows show the badge `waitingFile(s)`.
     - Later, on the screen page, the "ไฟล์ลายของบล็อคนี้" card uploads the file into the customer's library, or picks an existing library artwork.
       - A file with several designs asks which one belongs to this screen.
       - `attachArt()` sets `artworkId`, `preview`, `originals`, Customer REF and the name if it is empty, then logs it. The AI name fills it in later if needed.
     - From then on the screen gets the viewer/film group and appears in the film queue.
   - **One original per screen**: the screen page's "ไฟล์ต้นฉบับจากลูกค้า" is read-only and shows the artwork's own file (no "+ เพิ่ม", no ✕); film, viewer and combine page all read `artwork.file`.
     - "เปลี่ยนไฟล์ลาย" (`ui.replaceArt`) reopens the same attach card for a revised file: upload into the library (asks which design if several) or pick another library artwork.
     - Replacing sets `artworkId`, `preview`, `originals = [file]`, Customer REF; keeps the name; clears `filmPrep.notArt`; removes `film` (the screen waits for film again) and logs it.
   - **Job page rows** (`jobBlockRow`): picture, Stencil ID + Customer REF, name, then a label/value grid: ไซส์ · เฟรม (+ บล็อคเดิมลูกค้า) · ผ้าสกรีน · กาว · ความหนา · ชดเชยขอบ (`compText`) · ฟิล์ม (`filmState`: รอไฟล์ / ยังไม่ทำฟิล์ม / ทำฟิล์มแล้ว + time), and the block status chip. The home list keeps the compact `blockRow`.
   - Each block row: header (บล็อคที่ n, predicted Stencil ID, buttons), one viewer on the left, and groups on the right: ลาย (name, Customer REF) · สเปคบล็อค (mesh, frame, emulsion, thickness) · ฟิล์ม.
   - **Viewer** (`makeViewer`, shown at once, no toggle; it loads when scrolled into view):
     - The same area of the original with the design's film laid over it. The slider (ต้นฉบับ ↔ ฟิล์ม, remembered per browser) sets the film's opacity.
     - Zoom with +/−/พอดี, the mouse wheel, pinch or double-click; drag to pan; "ขยาย" goes full screen.
     - Inside the picture the wheel always zooms (it never scrolls the page; zooming out stops at "fit"). Outside the picture the wheel scrolls the page.
     - Both layers are re-rendered from the PDFs (pdf.js pages are kept) for the visible area, so zoom stays sharp.
     - The viewer DOM lives in `viewers` (Map by screen id/key) and is re-attached to its `[data-fv]` slot after every render().
   - **Sizes**: `screen.sizes = []` (several or none) are picked as chips in the ลาย group and on the screen page.
     - The list is `master.sizes`, edited in ⚙ (รายการให้เลือก → ไซส์). Default: FREE SIZE, XS–XXL.
     - Shown on home rows, in search and in CSV.
   - **New or the customer's own stencil**: `screen.frameSource = 'new' | 'customer'` (บล็อคใหม่ / บล็อคเดิมลูกค้า).
     - Set with a two-button switch at the top of สเปคบล็อค and on the screen page. Default: new.
     - Shown on home rows when it is the customer's, and included in search and CSV.
   - **Film group**: compensation and the colours to leave out.
     - It sets the compensation (auto = target × factor / manual µm / none) and the colours to leave out.
     - These are saved as `screen.filmPrep = {mode, manualUm, notArt[]}`. Thickness always comes from the screen's `target`.
3. **ฟิล์ม tab** (`filmsView()` in app.js, view `films`, deep link `/#films`):
   - Like the job list: heading + "+ สร้างฟิล์ม" (→ `/film/`), a "n บล็อครอลงแผ่นฟิล์ม" bar, a search box (server-side `q`, all words must match), then saved films newest first in date groups (`dateGroups()`), 50 at a time with "โหลดรายการเก่ากว่านี้".
   - **Film number**: every saved film gets `info.no` = `FM-<Thai YY><MM>-<NNN>` from the `settings.fseq` counter (server, `POST /api/films`). The file name is `<no>_<YYYY-MM-DD>_<HHMM>.pdf` (the browser sends `stamp`; the download uses the name the server returns).
   - Each film card (`filmHistCard`): the header (film number, date/time · designs · sheets; no size, no buttons) opens the view page `/film/?view=<id>`. Rows look like the job list rows: picture, name, then stencil ID · customer · job number (muted), บล็อคใหม่/เดิม · sizes · mesh · thickness · compensation, and the block's live status chip; a row opens its block while the block exists.
   - **Snapshot**: the saved PDF never changes. `info.items[]` also keeps each block as it was (stencilId, design, customer, customerRef, jobNo, sizes, frameSource, mesh, frame, emulsion, thick, compUm, mode, `preview` and `orig` file ids, origName, page) and where it sits on the sheet (`place {si, x, y, w, h, W, H, rot, bbox}`). Cards and the view page read this snapshot, not the live blocks.
     - Files named in a film snapshot (`orig`, `preview`) are never deleted by job delete, artwork delete or `DELETE /api/files/:id`; deleting the film removes them when nothing else uses them.
   - **View page** (`/film/?view=<id>`, `viewFilm()` in public/film/index.html; `GET /api/films/:id/info`): read-only. Left: film number, date · designs · sheets · by, the snapshot rows (tap = show that original), "เปิด PDF" and "ลบฟิล์ม" (tap twice, then back to `/#films`). Right: the same compare panes as when making a film: the saved PDF | the originals kept with the film, linked zoom through `place`. Films saved before snapshots existed show the film only.
   **Combine onto sheet** (`public/film/`, title "สร้างฟิล์ม", back link "← ฟิล์ม" to `/#films`; its own tabs are hidden, history lives in the ฟิล์ม tab):
   - One list, "บล็อคที่รอลงแผ่นฟิล์ม": screens with a filmable artwork, no `film`, and not sent, from every job and customer. **Ticked = on the sheet**; ticking/unticking adds/removes it at once (`Q.sel`, `syncSheet()`). All are ticked when the page opens (or only the `?add=` ids). Buttons เลือกทั้งหมด / ไม่เลือก.
     - Each row: checkbox, picture, name, stencil ID · thickness · compensation, and "แก้" (`/#screen=<id>`). Job screens have no card below; film settings are edited in the job.
   - Each one loads the artwork's original from R2, keeps only that design (nearest `box`), and applies the job's customer, the screen's `target` and its `filmPrep`.
   - **Every film comes from a job**: files cannot be dropped on this page (no drop zone, no shared-file intake, no "เก็บไฟล์ต้นฉบับ" box). New artwork goes into a job first (new job, or ไฟล์ลายของบล็อคนี้ / เปลี่ยนไฟล์ลาย on the screen page); shared files open คลังลาย in the main app.
   - After saving, the linked screens leave the list and the sheet.
   - Old films made from hand-dropped files keep their stored originals (`film/orig/<sha>`, `/api/originals`); the history still lists and downloads them, and shows "ไม่มีใบงาน" for those rows.
   - Saving stores the film first (number, snapshot, placements), then `POST /api/films/:id/link` sets `screen.film = {id, name, at, by, compUm, thick}` and adds a log line.
   - Deleting a film from history removes `film` from its screens again.
   - `/film/?add=<screenId,…>` opens the page with those screens (from the job/screen pages).
4. **Coater**: logs coat rounds (ด้านพิมพ์ / ด้านปาด) and thickness before/after exposure, then sends to QC.
5. **QC/finishing**: at least 2 photos plus the checklist, then pass (→ ready) or rework.

**Home list**:
- Stage filters: ทั้งหมด, รอทำฟิล์ม, ขึ้นบล็อค, รอตรวจ, พร้อมส่ง, ส่งแล้ว.
- Grouping by job date or by customer (remembered per browser).
- The search box matches jobs, blocks, files and people.
- Job cards: header = customer on the left; job number · due date + days left on the right (`dueText`: อีก n วัน / ส่งพรุ่งนี้ / ส่งวันนี้ / เลยกำหนด n วัน, calendar days; orange from 1 day, red when late; nothing extra once the job is sent) in the same plain small text (no received date, no done/total count). Block rows (`blockRow`): 97 px picture; name first, then the stencil ID as plain muted text; บล็อคใหม่ / บล็อคเดิมลูกค้า (orange) · sizes · mesh · thickness (no word สเปค); on the right one column: the film chip first (`chip fl-wait` รอไฟล์จากลูกค้า / `chip fl-need` ยังไม่ทำฟิล์ม, same dot style as status chips, warn colours), then the block status chip.

**Settings** (⚙, everyone): users/PINs, pick lists, customer default specs (`master.customerSpecs`), tolerance, film settings (`settings.key='film'`: sheet size, margins, marks, compensation factor, near-white, specks, thickness list), CSV export.
- One save button for the whole page ("บันทึกการตั้งค่า", sticky at the bottom, `saveSettings()`): it checks everything first (user form, film numbers), then saves pick lists + customer specs (`PUT /master`), film settings (`PUT /film-settings`, 409 on stale base) and the user being added/edited. The user form only has ยกเลิก.
- Unsaved values survive redraws on this page (`formSnapshot`/`formRestore` in `render()`); after a save the page shows what the server holds (`ui.dropEdits`).
- A one-time reset of all test data ran on 2026-10-29 (settings row `reset-2026-10-29` marks it); its code was removed afterwards.

Prepared-film uploads (the old "ไฟล์ที่เตรียมแล้ว ส่งยิงฟิล์ม" section, `screen.prepared`) are removed from the UI: every film is made in the app (`screen.film`). Old `prepared` ids are kept in the data, still searchable and protected from file deletion; the CSV column is now แผ่นฟิล์ม (film name).

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
  - Naming rules (in `AI_PROMPT`): text printed in the design goes into the name; never a colour; never the word "ลาย".
  - `cleanName()` also strips a leading/standalone "ลาย", "สี<colour>" and standalone Thai colour words.
  - English words are kept, because they are usually design text.
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
- Single-colour film: every artwork colour → black; white and near-white knock out. Black is written as DeviceGray `0 g`/`0 G` (white `1 g`), not CMYK K 100%, which PDF.js and ordinary printer drivers show and print as dark grey. Marks, crop marks and labels are gray too.
- Spot colours (Separation/DeviceN) count as ink tints.
- Form XObjects (Illustrator groups, symbols, transparency groups) are spliced into the operator list (`flatten()`: q, Matrix, BBox clip, content, Q; a marker `_grp` for analysis only). Forms with their own resources get prefixed names (`X<n>_`) and `render()` copies those resources into the page (`job.merges`).
- Clipping masks are tracked: an element's box is cut to its clip, so clipped line art counts by its visible part. Clipped or open fills never count as ring frames; a ring frame needs a hole inset evenly by the line width (`isRing`).
- Objects drawn at 0 % opacity (ExtGState `ca`/`CA` 0, or inside a group drawn at 0 %) are invisible and ignored.
- Edge compensation: auto = thickness × factor (default 0.5), or a manual µm value, or none.
- Marks: 3 faint crosses plus a faint label under each design.
  - Job blocks (`job.labelInfo`, set by the film page) get 3 lines: customer · design · ไซส์ … · Customer REF / film number · job number · stencil ID / บล็อค <frame> · ผ้า <mesh> · หนา <µm> · compensation. Before saving, the film number shows as "FM-…".
  - Saving first reserves the number (`POST /api/films/reserve`), draws the sheet again with `st.filmNo`, and stores that PDF with `no` (an abandoned save skips a number).
  - Other files keep the old 2 lines (customer - file / thickness · compensation · date).
- Film size: before `embedPage`, the copied source page drops `/XObject /Pattern /Shading /ColorSpace` resources (the rewritten content never uses them) and `/PieceInfo /Thumb /Metadata /Annots`; Illustrator keeps its whole editing data there (a 59 MB .ai gave a 59 MB film, now 0.7 MB).

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
