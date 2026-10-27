// โครงสร้างฐานข้อมูล: Worker รันชุดนี้เองอัตโนมัติหลัง deploy ทุกครั้ง (รันซ้ำได้ปลอดภัย)
// เพิ่มตาราง/คอลัมน์ใหม่: ต่อท้ายรายการนี้ด้วยคำสั่งที่รันซ้ำได้ (CREATE ... IF NOT EXISTS, INSERT OR IGNORE)
// ผู้ดูแลเริ่มต้น: PIN 9999 = sha256("admin:9999")
export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users ( id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0 )",
  "CREATE TABLE IF NOT EXISTS sessions ( token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL )",
  "CREATE TABLE IF NOT EXISTS jobs ( id TEXT PRIMARY KEY, no TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL )",
  "CREATE TABLE IF NOT EXISTS screens ( id TEXT PRIMARY KEY, job_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS screens_job ON screens(job_id)",
  "CREATE TABLE IF NOT EXISTS photos ( id TEXT PRIMARY KEY, screen_id TEXT NOT NULL, by_name TEXT, t INTEGER NOT NULL, img BLOB NOT NULL )",
  "CREATE INDEX IF NOT EXISTS photos_screen ON photos(screen_id)",
  "CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL )",
  "INSERT OR IGNORE INTO settings (key, value) VALUES ('seq', '1'), ('master', '{\"customers\":[],\"mesh\":[\"32T\",\"43T\",\"55T\",\"77T\",\"90T\",\"120T\",\"140T\"],\"frames\":[\"40×50 ซม.\",\"50×60 ซม.\",\"60×80 ซม.\",\"70×90 ซม.\"],\"emulsions\":[\"Dual-cure ทั่วไป\",\"Dual-cure หนา\",\"SBQ บาง\",\"Capillary film\"],\"tolerance\":10}')",
  "INSERT OR IGNORE INTO users (id, name, role, pin_hash) VALUES ('admin', 'ผู้ดูแล', 'admin', '77df4be80359a6bf4ebce9d7839be8f2e5314c0866580fbcae01a5f90ea984a6')",
  "CREATE TABLE IF NOT EXISTS files ( id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, type TEXT, size INTEGER, by_name TEXT, t INTEGER NOT NULL )",
  // ฟิล์ม positive (ย้ายมาจากแอป film-positive ตารางเดิมใช้ต่อได้เลย)
  "CREATE TABLE IF NOT EXISTS film_outputs ( id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, size INTEGER NOT NULL, info TEXT NOT NULL )",
  "CREATE INDEX IF NOT EXISTS film_outputs_created ON film_outputs(created)",
  // คลังลายของลูกค้า: 1 แถว = 1 ลาย (คู่ซ้าย-ขวา) จากไฟล์ลูกค้า; data = ชื่อลาย, Customer REF, ไฟล์ต้นฉบับ, หน้า, ตำแหน่งลาย, รูปตัวอย่าง
  "CREATE TABLE IF NOT EXISTS artworks ( id TEXT PRIMARY KEY, customer TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS artworks_customer ON artworks(customer)",
  // เลขบล็อค (Stencil ID) ST-ปปดด-NNNN: ตัวนับต่อเนื่อง ออกให้ทุกบล็อคใหม่ตอนบันทึกใบงาน
  "INSERT OR IGNORE INTO settings (key, value) VALUES ('sseq', '1')"
];
