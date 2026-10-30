# CLAUDE.md: Stencil log app (บันทึกขึ้นบล็อค) + film positive

Internal web app for Viczo International (screen-printing ink maker, Thailand). Small team, Thai UI.
Owner: Nine. Staff use it on phones and desktop PCs. The former film-positive app is merged in here (page `/film/`).

## Workflow
Everyone who logs in (name + PIN) can do everything. There are no role checks; the `users.role` column is kept but unused.
One page, no tabs: the job list. The top bar has ติดตั้งแอป (only while the browser offers `beforeinstallprompt`; an icon on phones), ⟳, ⚙ and the user. The film page header has ← ใบงาน + title on the left and the user (avatar + name) on the right, no install button. Films are made from the job list (the รอทำฟิล์ม filter shows a "สร้างฟิล์ม →" bar to `/film/`) or from a job/block, and opened from their blocks (ดูฟิล์ม). The artwork library page (`libraryView`) has no menu entry any more: it only opens for files shared from other apps (`/?share=`), with ← กลับ; artworks are otherwise added inside the new-job form and on the screen page.

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
   - **After saving** (`showNewJob`): back to the home list with no filter (ทั้งหมด, search cleared, first 20 jobs, more if needed to reach it); the new job's card scrolls into view and blinks (`.jobcard.flash`, ~3 s). The new-job form's history entry is replaced, so Back does not reopen it.
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
   - **Screen page** (`screenView`): header = name, then stencil ID · job number · customer · due date + days left, with the film chip and status chip on the right; status steps (`statusSteps`: รอขึ้นบล็อค → กำลังขึ้นกาว → รอตรวจ → เสร็จแล้ว; ตีกลับ shows red on the coating step); a fixed bottom bar with the next action (`nextStep`: + ขึ้นกาว รอบแรก / + ขึ้นกาว รอบที่ n + ส่งตรวจ (disabled with the reason above it) / ไปตรวจงาน ↓ which scrolls to `#qccard`; none when done; the toast sits above it); job note / rework reason; the attach card when waiting or changing the file; then ONE card laid out like a new-job row: viewer (or picture) | groups ลาย (name + AI, Customer REF, sizes, original file + เปลี่ยนไฟล์ลาย) · สเปคบล็อค (new/customer switch, mesh, frame, emulsion, thickness ±tolerance; editable while ordered/coating/rework, each change logged) · ฟิล์ม (`filmGroup`) and a film line (FM name, time, by, compensation, ดาวน์โหลด / ดูฟิล์ม / ลงแผ่นใหม่). Coat rounds, QC and history follow.
   - **Job page** (`jobView`) is laid out like the new-job form: title "ใบงาน <JB-…>" + due text, one card with ลูกค้า (read-only) · วันที่รับงาน · กำหนดส่ง, รายละเอียด / ข้อควรระวัง (editable, `data-jf=note`, may be emptied) and สั่งโดย; then "บล็อคที่ต้องขึ้น (n ลาย)" with the label button, the ทำฟิล์ม bar and the rows; ลบใบงาน last.
   - **Job page rows** (`jobBlockRow`, `.brow.jr`): same family as the home rows: picture, name (bold), muted "ST · Customer REF" line, then two lines of short label + value pairs (บล็อคใหม่/บล็อคเดิมลูกค้า + frame · ผ้า · กาว / หนา · ชดเชย (`compText`) · ไซส์); on the right the film chip (รอไฟล์จากลูกค้า / ยังไม่ทำฟิล์ม / ทำฟิล์มแล้ว, time in the tooltip), the status chip (full wording) and × n coat rounds. On phones the chips go under the text. The home list keeps the compact `blockRow`.
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
     - Set with a two-button switch at the top of สเปคบล็อค and on the screen page. Default: new. The switch is full width and coloured like the list (บล็อคใหม่ teal `--new`, บล็อคเดิมลูกค้า orange `--warn`).
     - Shown on home rows when it is the customer's, and included in search and CSV.
   - **Film group**: compensation and the colours to leave out.
     - It sets the compensation (auto = target × factor / manual µm / none) and the colours to leave out.
     - These are saved as `screen.filmPrep = {mode, manualUm, notArt[]}`. Thickness always comes from the screen's `target`.
3. **Films** (no tab; there is no film-history list any more):
   - **Film number**: every saved film gets `info.no` = `FM-<Thai YY><MM>-<NNN>` from the `settings.fseq` counter. The file name is `<no>_<YYYY-MM-DD>_<HHMM>.pdf`.
   - **Snapshot**: the saved PDF never changes. `info.items[]` also keeps each block as it was (stencilId, design, customer, customerRef, jobNo, sizes, frameSource, mesh, frame, emulsion, thick, compUm, mode, `preview` and `orig` file ids, origName, page) and where it sits on the sheet (`place {si, x, y, w, h, W, H, rot, bbox}`).
     - Files named in a film snapshot (`orig`, `preview`) are never deleted by job delete, artwork delete or `DELETE /api/files/:id`; deleting the film removes them when nothing else uses them.
   - **View page** (`/film/?view=<id>`, `viewFilm()`; `GET /api/films/:id/info`; opened from the screen page's film line): read-only. Left: film number, date · designs · sheets · by, the snapshot rows (tap = zoom to that design), "ดูเต็มจอ" (full screen inside the app; a history entry, so back closes it), "ดาวน์โหลด PDF" (blob download, stays in the app) and "ลบฟิล์ม" (tap twice, then back to `/`). Never link a PDF with target=_blank / plain navigation: in the installed app on Android it leaves the app and closing the PDF closes the app. Right: the saved PDF over the originals kept with the film (see Film preview).
   - **Film preview** (create and view pages, one pane): each design's original page is drawn under its spot on the sheet through its placement (`toFilm`, affine from 3 bbox corners, clipped to the design's bbox), the film on top at the slider's opacity (ต้นฉบับ ↔ ฟิล์ม, shared with the block viewer: `localStorage['stencil-fpop']`, default 70). `#focusSel` lists every design on the sheets (ทั้งแผ่น = fit); picking one zooms to it (`fitRect`). Every design on screen gets its original: from its preview picture (the artwork's cut-out = `box` + 4 %, stored as `pv {id, box}` in the queue record and the film snapshot) while it is shown smaller than ~700 device px, and from the real PDF page once bigger, for the nearest `MAX_PDF` files (4 with `navigator.deviceMemory` ≥ 8, else 2; `origDocs` LRU of MAX_PDF + 1). Films saved before `pv` existed fall back to PDF only. In view mode PDFs are fetched on demand. At 100 % film no original is loaded.
   **Combine onto sheet** (`public/film/`, title "สร้างฟิล์ม", back link "← ใบงาน" to `/`; its own tabs are hidden):
   - One list, "บล็อคที่รอลงแผ่นฟิล์ม": screens with a filmable artwork, no `film`, and not sent, from every job and customer. **Ticked = on the sheet**; ticking/unticking adds/removes it at once (`Q.sel`, `syncSheet()`). All are ticked when the page opens (or only the `?add=` ids). Buttons เลือกทั้งหมด / ไม่เลือก.
     - Each row: checkbox, picture, name, stencil ID · thickness · compensation, and "แก้" (`/#screen=<id>`). Job screens have no card below; film settings are edited in the job.
   - Each one loads the artwork's original from R2, keeps only that design (nearest `box`), and applies the job's customer, the screen's `target` and its `filmPrep`.
   - **Every film comes from a job**: files cannot be dropped on this page (no drop zone, no shared-file intake, no "เก็บไฟล์ต้นฉบับ" box). New artwork goes into a job first (new job, or ไฟล์ลายของบล็อคนี้ / เปลี่ยนไฟล์ลาย on the screen page); shared files open คลังลาย in the main app.
   - After saving, the linked screens leave the list and the sheet.
   - Old films made from hand-dropped files keep their stored originals (`film/orig/<sha>`, `/api/originals`); the history still lists and downloads them, and shows "ไม่มีใบงาน" for those rows.
   - Saving stores the film first (number, snapshot, placements), then `POST /api/films/:id/link` sets `screen.film = {id, name, at, by, compUm, thick}` and adds a log line.
   - Deleting a film from history removes `film` from its screens again.
   - `/film/?add=<screenId,…>` opens the page with those screens (from the job/screen pages).
   - **Stencil labels** (`printLabels(job, screens)`): "พิมพ์ลาเบลติดบล็อค (n)" on the job page (all blocks) and "พิมพ์ลาเบล" on the screen page (one). Opens a print window at once ("กำลังเตรียมลาเบล…"), gets the pictures, then fills it. Pictures are kept in R2 as `lab/<sha256>.png` (`/api/labelpic/<sha>` HEAD/GET/PUT; the hash covers file, page, design, box, target, filmPrep and film settings, so any change makes a new one): a stored picture loads at once; a missing one is made from the original (download + analyse + film: slow, seconds per block on a phone) and stored. They are made ahead when the browser already has the film: after saving a new job (`labelsAhead`, uploaded originals stay in `fileBytes`) and whenever a block viewer draws its film (`labelFromFilm`). Labels: labels 200 × 22 mm, stacked edge to edge, 13 per A4 sticker sheet (page margin 0, 5.5/5 mm padding), print at 100 %. Each label: picture (`labelPic`: the design as on the film — black, compensation applied — rendered with `marks: false` and no text, cropped to the ink, turned sideways when taller than wide; the preview picture when the artwork cannot be filmed) | row 1: SID (2 columns) · Customer · Delivery Date (job due date, DD/MM/YYYY); row 2: Mesh · Thickness · Customer Ref · "prepared by VICZO"; values 15 pt bold, long text shrinks to fit.
4. **การขึ้นบล็อค** (screen page card): การขึ้นกาว = one "+ ขึ้นกาว" button per round, logged with date/time and person (no side; `coat.side` is ''). The first round moves the block from รอขึ้นบล็อค to กำลังขึ้นกาว (undoing the last round goes back). Then thickness before exposure (`thBefore`), notes, and "เสร็จแล้ว ส่งตรวจ": disabled, with the reason shown, until the block has its customer's file (not `waitingFile`) and at least one coat round (`qcMissing`). QC "ผ่าน" also refuses a block with no file.
5. **ตรวจงานก่อนส่ง**: the real thickness measured here (`thAfter`, shown against the target), required photos `QC_PHOTOS` (front of the stencil with the thickness gauge in the middle; the side with the label) plus any number of other photos (kind kept in `screen.photoKind[photoId]`, no schema change); uploads show at once from the local file with "กำลังอัปโหลด…" (`ui.phPending`), shrink to 1280 px JPEG and upload 3 at a time, and the uploaded copy is shown from memory (`localPhotos`) instead of being downloaded again; background data reloads are skipped while uploads run (`isEditing`), a finished photo is attached to the block currently in `db`, and photos from the last 2 minutes are re-attached when a reload that started earlier lands later (`recentPhotos`, `keepRecentPhotos()`) — returning from the camera app fires `visibilitychange`, which used to wipe the new photo for a while; the two required slots sit side by side, and the checklist `QC_CHECKS` (รายละเอียดลายครบถ้วน · ไม่มีตำหนิ ตามด รอยฝุ่น · เทปติดเรียบร้อย). Pass needs all of them → ตรวจสอบและจัดส่งแล้ว; rework needs a note.

**Edit locks** (screen page):
- Film made (`s.film`): thickness, compensation, colours left out and เปลี่ยนไฟล์ลาย are locked (🔒, `filmGroup(..., locked)`), with a `.lockbar` "ทำฟิล์มแล้ว …" and "ปลดล็อคเพื่อแก้ไข" (tap twice): it removes `film` from the screen (the film itself stays), logs "ปลดล็อคเพื่อแก้ไข · ฟิล์ม … ไม่ใช้แล้ว ต้องทำฟิล์มใหม่", and the block waits for a new film. Name, Customer REF, sizes, mesh, frame and emulsion stay editable as before.
- Finished (`isDone`): everything read-only (name, Customer REF, sizes, the new/customer switch, film group); no unlock.
- The new/customer stencil switch follows the spec rule (editable only while ordered/coating/rework).
- Deleting a job (`deljob`): a job with no work done = tap twice; a job with work done (`jobStarted`: coat rounds, film, photos, or status past ordered) shows `.delbox` with what was done and needs the job number typed (`#delconf`, case-insensitive).

**Date boxes** (`dateInput`): every type=date box shows DD/MM/YYYY text over the native input (the browser would show its own language order, e.g. 10/30/2026); tapping opens the calendar (`showPicker`).

**Offline / text size** (`public/update.js`, both pages): an orange bar at the top while the device has no signal (`online`/`offline` events). ⚙ ขนาดตัวหนังสือ ปกติ / ใหญ่ is per device (`localStorage['stencil-big']`, `html.big` = 18 px rem base, set by an inline script in the page head before the first paint).

**Navigation / back button**: every page change in `go()` (list → job → block, settings, new job) pushes a browser history entry (`navState`: view, jobId, screenId, backTo, tab); filter/search changes replace the current entry. Android's back button / swipe-back and the in-app "← กลับ" (`history.back()` when there is an app entry) go through `popstate`, which restores the view and the saved scroll spot (`y`, `history.scrollRestoration = 'manual'`). Photo lightbox and the full-screen viewer push an overlay entry, so back closes them first.

**Home list** (the only page):
- Search box and "+ สร้างใบงาน" on one row (`.toprow`), no page title.
- Stage filters: ทั้งหมด (every block, done ones included; inside a job done blocks sort last), รอทำฟิล์ม (with the สร้างฟิล์ม bar), ขึ้นบล็อค, รอตรวจ, ตรวจสอบและจัดส่งแล้ว (`isDone`: status sent, or old `ready`). Every filter shows its count.
- Always grouped by job date, newest first (no group-by switch).
- Shows 20 jobs at a time (`HOME_PAGE`, `ui.homeLimit`); "แสดงใบงานเก่ากว่านี้ (อีก n ใบงาน)" adds 20 more. Changing the filter or the search starts again at 20. Counts on the filters are always for everything. (`/api/data` still sends every job; if that grows too big, the next step is to send only recent/unfinished jobs and fetch older ones on search.)
- The search box matches jobs, blocks, files and people.
- Job cards: header = customer on the left; job number · due date + days left on the right (`dueText`: อีก n วัน / ส่งพรุ่งนี้ / ส่งวันนี้ / เลยกำหนด n วัน, calendar days; orange from 1 day, red when late; nothing extra once every block is done) in the same plain small text. Block rows (`blockRow`), sorted by stencil ID inside a job (`bySid`, also on the job page): 97 px picture; name; stencil ID (plain muted); one line ใหม่ (teal `--new`) / เดิม (orange) · mesh · target µm · sizes; (no rounds/measured line); under the status chip of a รอขึ้น / กำลังขึ้น / ตีกลับ block with rounds: "× n" (coat rounds); on the right one column: the film chip first (`chip fl-wait` / `chip fl-need`), then the block status chip (short labels in list rows: `STATUS_SHORT` รอขึ้น / กำลังขึ้น / รอตรวจ / ตีกลับ / เสร็จแล้ว, film chips รอไฟล์ / รอฟิล์ม, full wording in the tooltip; on phones the picture is 68 px), and under it a "+ ขึ้นกาว" button while the block is รอขึ้นบล็อค / กำลังขึ้นกาว / ตีกลับ (`quickcoat` → `addCoat()`, the same as "+ ขึ้นกาว" on the block page; a second tap within 3 s is ignored). The row is a `div[role=button]` (it holds a button), Enter/Space open it.
  - **Swipe right = ขึ้นกาว** on touch screens (`swipeToCoat`): rows that can take a coat round are wrapped in `.swipe` with a strip behind ("+ ขึ้นกาว รอบที่ n", green once past the commit point = 35 % of the row, max 140 px). Pointer events, touch/pen only, `touch-action: pan-y` keeps vertical scrolling; a vertical start cancels; the click right after a swipe is swallowed; same 3 s double guard; short vibration. On touch screens (`hover:none, pointer:coarse`) the button is hidden and a one-line hint shows under the ทั้งหมด / ขึ้นบล็อค filters; with a mouse the button stays.

**Staff seeded by the schema**: ผู้ดูแล (`admin`), and once on 2026-10-30 นุก (`u-nook`) and เล่ (`u-le`) with PIN 1234 (settings row `seed-users-2026-10-30`; skipped if the name already exists).

**Settings** (⚙, everyone): users/PINs (add with "+ เพิ่มพนักงาน", saved by the page's one save button), pick lists, customer default specs (`master.customerSpecs`), tolerance (no app-wide default thickness: a new block takes its customer's spec `target`, otherwise the field is empty and must be filled before saving the job), film settings (`settings.key='film'`: sheet size, margins, marks, compensation factor, near-white, specks, thickness list), CSV export.
- One save button for the whole page ("บันทึกการตั้งค่า", sticky at the bottom, `saveSettings()`): it checks everything first (user form, film numbers), then saves pick lists + customer specs (`PUT /master`), film settings (`PUT /film-settings`, 409 on stale base) and the user being added/edited. The user form only has ยกเลิก.
- Unsaved values survive redraws on this page (`formSnapshot`/`formRestore` in `render()`); after a save the page shows what the server holds (`ui.dropEdits`).
- One-time resets of all data (jobs, screens, photos, files, artworks, films, every R2 object; users, sessions and settings kept; job/stencil/film counters back to 1): 2026-10-29 and 2026-10-30 (settings rows `reset-2026-10-29` / `reset-2026-10-30` mark them; the code was removed after each ran).

Prepared-film uploads (the old "ไฟล์ที่เตรียมแล้ว ส่งยิงฟิล์ม" section, `screen.prepared`) are removed from the UI: every film is made in the app (`screen.film`). Old `prepared` ids are kept in the data, still searchable and protected from file deletion; the CSV column is now แผ่นฟิล์ม (film name).

Screen status flow: `ordered → coating → qc → sent`, with `qc → rework → coating`. Passing QC finishes the block: status `sent`, shown as "ตรวจสอบและจัดส่งแล้ว" (there is no separate send step; old `ready` blocks show the same label). Film is a separate flag (`screen.film`), not a status.

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
  - stencil-label pictures at `lab/<sha256>.png` (tiny; not cleaned up when a job is deleted)
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
  - **Icon**: one picture everywhere: a white stencil frame with its mesh on the app blue (#3141B0). `favicon.svg` is the source; `icons/icon-192.png`, `icon-512.png` and `maskable-512.png` (mesh shrunk into the safe zone, square) are rendered from it; the top-bar `.mark` shows `favicon.svg`.
  - **Version**: `window.APP_VERSION` at the top of `public/update.js`, shown in ⚙ (สถานะระบบ). Bump it (1.0 → 1.1 …) with every pushed change and tell Nine the number in the reply.
  - `public/update.js` (both pages): records the server's version (ETag of the page and its code) at load; when the app comes back to the screen (≥30 s apart) and it changed, shows "มีเวอร์ชันใหม่ แตะเพื่ออัปเดต" (tap = reload; never automatic, unsaved work stays).

## Film core rules (public/film/js/film-core.js; edit it and public/film/index.html directly, there is no build step)
- Designs are found from platen frames (dashed/solid rectangles, closed sock outlines, outlined rings). Same-size frames side by side = one design (left + right).
- Artwork = printable elements inside a frame. Guides are decided by role, not by line weight.
- Single-colour film: every artwork colour → black; white and near-white knock out. Black is written as DeviceGray `0 g`/`0 G` (white `1 g`), not CMYK K 100%, which PDF.js and ordinary printer drivers show and print as dark grey. Marks, crop marks and labels are gray too.
- Spot colours (Separation/DeviceN) count as ink tints.
- Form XObjects (Illustrator groups, symbols, transparency groups) are spliced into the operator list (`flatten()`: q, Matrix, BBox clip, content, Q; a marker `_grp` for analysis only). Forms with their own resources get prefixed names (`X<n>_`) and `render()` copies those resources into the page (`job.merges`).
- Clipping masks are tracked: an element's box is cut to its clip, so clipped line art counts by its visible part. Clipped or open fills never count as ring frames; a ring frame needs a hole inset evenly by the line width (`isRing`).
- Objects drawn at 0 % opacity (ExtGState `ca`/`CA` 0, or inside a group drawn at 0 %) are invisible and ignored.
- Edge compensation: auto = thickness × factor (default 0.5), or a manual µm value, or none.
- Marks: 3 faint crosses plus a faint label under each design (`st.marks === false` leaves the crosses out: label pictures).
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
