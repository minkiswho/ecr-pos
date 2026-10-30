# ECR POS (R1)

POS ข้าวมันไก่เอกมัย — 2 สาขา (สุรวงศ์ / เอกมัย) ใช้โค้ดชุดเดียว แยกเว็บ แยกรหัส แยก backend

- `surawong/`, `ekkamai/` — หน้าเว็บของแต่ละสาขา (`config.js` = URL ของ Apps Script สาขานั้น)
- `app/` — โค้ดหน้าเว็บที่ใช้ร่วมกัน (POS, sync, เครื่องพิมพ์ BLE)
- `apps-script/` — backend: `Code.gs` ใช้ร่วมกัน + `Branch.<สาขา>.gs` (ตั้งชื่อในโปรเจกต์ว่า Branch.gs)
- `tests/` — `node tests/backend.test.js`

ข้อมูลลง Google Sheet เดิมของแต่ละสาขา (Orders / รายการขาย / LineItems / Config / Images) และแจ้ง Telegram เดิม
ชีทระบบที่เพิ่ม: POS_Meta, POS_Ops, POS_Notify
