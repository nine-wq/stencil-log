# CLAUDE.md: Stencil log app (บันทึกขึ้นบล็อค)

Internal web app for Viczo International (screen-printing ink maker, Thailand). Small team, Thai UI.
Owner: Nine. Staff use it on phones and desktop PCs.

## Workflow (3 departments)
1. **Artwork** (`artwork`): creates a job (customer, due date, notes) with one or more screens (บล็อค).
   Uploads the customer's original files (one file → one screen row; filename stem → Customer ID).
   Preview image per screen (auto from JPG/PNG/PDF/AI, or Ctrl+V paste) → Workers AI suggests a short Thai design name (Artwork ID).
   Another person uploads the prepared files sent out for film output.
2. **Coater** (`coater`): logs coat rounds via + buttons (ด้านพิมพ์ / ด้านปาด, auto timestamp),
   emulsion thickness before and after exposure (µm, checked against spec ± tolerance), then sends to QC.
3. **QC/finishing** (`qc`): uploads ≥2 photos, ticks checklist, passes (→ ready) or sends back with a reason (→ rework).
One home list of jobs with stage filters (ทั้งหมด, ขึ้นบล็อค, รอตรวจ, พร้อมส่ง, ส่งแล้ว); each role opens on its own filter. Jobs sorted by job date (`date`, editable "วันที่รับงาน", falls back to createdAt), newest first, grouped: ล่าสุด (3 days) → สัปดาห์นี้ (from Monday) → เดือนนี้ → 3 เดือนที่ผ่านมา → ปีนี้ → ก่อนหน้านี้. Search box matches job, block, file and people fields (all words must match; with ทั้งหมด it also searches sent jobs). All jobs are returned by /api/data (no age cutoff). `admin` also gets Settings via the ⚙ header button (users/PINs, pick lists, tolerance, system status, CSV export).

Screen status flow: `ordered → coating → qc → ready → sent`, with `qc → rework → coating`.

## Stack
- Cloudflare Worker `src/index.js` serves `/api/*`; static assets in `public/` (vanilla JS, no build step).
- D1 (`DB`): tables users, sessions, jobs, screens, photos (QC photos as BLOB), files (metadata), settings.
  Job and screen details are JSON in a `data` column; screens use optimistic locking (`rev`, 409 on conflict).
- R2 (`FILES`, bucket `stencil-files`): customer originals, prepared files, preview images.
- Workers AI (`AI`): `/api/ai/name` tries llama-4-scout → mistral-small-3.1 → gemma-3-12b in order.
- Auth: pick name + 4-digit PIN; sha256(`<userId>:<pin>`); bearer token sessions, 60 days; lockout after 5 failures.

## Rules
- **Schema changes** go in `src/schema.js` and must be idempotent (`CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`).
  The Worker applies the schema on cold start, so there is no manual migration step. Never drop or rename existing columns or tables. For a new field, prefer adding it to the screen/job JSON `data`, with a default in the frontend.
- **Deploy** = push to `main`; Cloudflare Workers Builds runs `npx wrangler deploy`. Do not commit secrets.
- Keep everything free-tier: Workers 100k req/day, CPU 10 ms (no image processing server-side; resize in the browser), D1 5 GB, R2 10 GB, AI 10k neurons/day.
- UI text in Thai. Must work at 400 px phone width and in dark mode (CSS tokens in `public/style.css`).
- Before pushing: run `node --check public/app.js` and `node --check --input-type=module < src/index.js`; ideally `npx wrangler dev` and click through the changed flow.
