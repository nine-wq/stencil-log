# บันทึกขึ้นบล็อค (Viczo)

เว็บแอปรับงานขึ้นบล็อคสกรีน: คลังลายของลูกค้า, ใบงาน, ทำฟิล์ม positive, ขึ้นบล็อค, เก็บงาน/ตรวจ
รันบน Cloudflare (Workers + D1 + R2 + Workers AI) แบบฟรี

## การ deploy
**อัตโนมัติ**: ทุกครั้งที่มีโค้ดใหม่เข้า branch `main` บน GitHub, Cloudflare Workers Builds จะ deploy ให้เองภายในประมาณ 1–2 นาที
ไม่ต้องรันคำสั่งใด ๆ และไม่ต้องรัน init ฐานข้อมูล เพราะ Worker สร้าง/อัปเกรดตารางเองครั้งแรกที่ทำงาน (ดู `src/schema.js`)

ดูสถานะการ deploy ได้ที่ Cloudflare Dashboard → Workers & Pages → stencil-log → **Deployments**
ถ้าเวอร์ชันใหม่มีปัญหา กด **Rollback** กลับเวอร์ชันก่อนหน้าได้ในหน้าเดียวกัน

## ตั้งค่าครั้งแรก (ทำครั้งเดียว)
1. **R2**: Dashboard → R2 Object Storage → เปิดใช้งาน → **Create bucket** ชื่อ `stencil-files`
2. **เชื่อม GitHub กับ Cloudflare**: Dashboard → Workers & Pages → stencil-log → Settings → **Builds** → Connect → เลือก repo `stencil-log`, branch `main`
   - Build command: เว้นว่าง
   - Deploy command: `npx wrangler deploy`
3. `wrangler.jsonc` ต้องมี `database_id` ของฐานข้อมูล `stencil-db` (ดูได้ที่ Dashboard → D1 → stencil-db)

## ใช้งาน
- ผู้ดูแลเริ่มต้น: **ผู้ดูแล / PIN 9999** เปลี่ยน PIN ทันทีในแท็บ "ตั้งค่า"
- แท็บ "ตั้งค่า" → "สถานะระบบ" บอกว่า R2 และ AI เชื่อมแล้วหรือยัง
- สำรองข้อมูล: แท็บ "ตั้งค่า" → ดาวน์โหลด CSV

## รันบนเครื่องเพื่อทดสอบ (ไม่จำเป็น)
```
npm install
npx wrangler dev
```

## โครงสร้างไฟล์
| ไฟล์ | หน้าที่ |
|---|---|
| `public/index.html`, `public/app.js`, `public/style.css` | หน้าจอแอป: ใบงาน คลังลาย ตั้งค่า |
| `public/film/` | หน้าทำฟิล์ม positive (รวมมาจากแอป film-positive) |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | ติดตั้งเป็นแอปบนมือถือ และรับไฟล์จากปุ่มแชร์ |
| `src/film.js` | API ฟิล์ม: การตั้งค่าฟิล์ม ประวัติฟิล์ม ผูกฟิล์มกับบล็อค |
| `src/index.js` | API: ล็อกอิน, ใบงาน, ไฟล์ (R2), รูป QC, AI ตั้งชื่อลาย, CSV |
| `src/schema.js` | โครงสร้างฐานข้อมูล (รันเองอัตโนมัติ) |
| `wrangler.jsonc` | การตั้งค่า Cloudflare |
| `CLAUDE.md` | บันทึกสำหรับ Claude เวลาพัฒนาต่อ |
