// End-to-end UI test: local static server + mocked Apps Script backend + headless Chromium
// NODE_PATH=/opt/npm-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { load, makeSpreadsheet } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const SUR_ORDERS = ['id', 'status', 'type', 'table', 'method', 'total', 'received', 'change', 'items_json', 'createdAt', 'paidAt', 'updatedAt', 'name', 'saleDate', 'voidedAt', 'revision', 'lastOp'];
const SUR_SALES = ['วันที่', 'เวลา', 'บิล', 'ประเภท', 'โต๊ะ', 'รายการ', 'วิธีจ่าย', 'ยอด(บาท)', 'สถานะ', 'รหัสอ้างอิง', 'วันที่รับเงิน', 'เวลารับเงิน'];
const SUR_LINES = ['วันที่', 'เวลา', 'บิล', 'ประเภท', 'โต๊ะ/ชื่อ', 'เมนู', 'ตัวเลือก', 'จำนวน', 'ราคา/หน่วย', 'รวม', 'สถานะ', 'refId', 'วันที่รับเงิน'];
const menu = JSON.parse(process.env.MENU_JSON || fs.readFileSync(path.join(__dirname, 'menu.fixture.json'), 'utf8'));

function backend(branch) {
  const sur = branch === 'surawong';
  const ss = makeSpreadsheet({
    Orders: [sur ? SUR_ORDERS : SUR_ORDERS.slice(0, 13)],
    'รายการขาย': [sur ? SUR_SALES : SUR_SALES.slice(0, 10)],
    LineItems: [sur ? SUR_LINES : SUR_LINES.slice(0, 12)],
    Config: [['key', 'value'], ['menu', JSON.stringify(menu)]],
    Images: [['key', 'dataUrl']],
  });
  const env = load('Branch.' + branch + '.gs', { TEST: ss }, { MODE: 'test', TEST_SHEET_ID: 'TEST', SALT: 's1', CODE_CASHIER: 'SU-CASH', CODE_MANAGER: 'SU-MGR', CODE_VIEWER: 'SU-VIEW' });
  env.ss = ss;
  return env;
}

const B = { surawong: backend('surawong'), ekkamai: backend('ekkamai') };
let offline = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/api\/(\w+)$/);
  if (m && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (offline) { req.socket.destroy(); return; }
      const out = B[m[1]].ctx.doPost({ postData: { contents: body } }).text;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out);
    });
    return;
  }
  const cfg = u.pathname.match(/^\/(surawong|ekkamai)\/config\.js$/);
  if (cfg) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.ECR={branch:'${cfg[1]}',name:'${cfg[1] === 'surawong' ? 'สุรวงศ์' : 'เอกมัย'}',api:'/api/${cfg[1]}',tables:5,openTakeaway:${cfg[1] === 'surawong'}};`);
  }
  let f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (f.endsWith('/')) f += 'index.html';
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' }[path.extname(f)] || 'text/plain';
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8766, r));
  const browser = await chromium.launch();
  for (const w of [390, 830]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('http://localhost:8766/surawong/');
    await page.fill('input[name=code]', 'SU-CASH'); await page.click('button[type=submit]');
    await page.waitForSelector('.tile');
    if (w === 390) {
      for (const t of ['2','3']) { await page.click(`[data-a=new-table][data-v="${t}"]`); await page.click('.mi:has-text("ข้าวมันไก่ (สะโพก")'); await page.click('.opt:has-text("ข้าวมัน")'); await page.click('.modal [data-m=ok]'); await page.click('[data-a=save-order]'); await page.waitForTimeout(400); }
      await page.click('.tile.open'); await page.click('[data-a=go-pay]'); await page.click('[data-a=quick]'); await page.uncheck('[data-a=pay-print]'); await page.click('[data-a=confirm-pay]'); await page.waitForTimeout(800);
    }
    await page.click('[data-a=view][data-v=bills]'); await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.SHOTS + '/bills-' + w + '.png' });
    await page.click('[data-a=view][data-v=summary]'); await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.SHOTS + '/summary-' + w + '.png', fullPage: true });
    await page.click('[data-a=view][data-v=tables]');
    await page.click('[data-a=new-lineman]');
    await page.fill('.modal input[name=no]', 'LM-2468');
    await page.screenshot({ path: process.env.SHOTS + '/lineman-' + w + '.png' });
    await ctx.close();
  }
  await browser.close(); server.close(); console.log('shots ok');
})().catch(e => { console.error(e); process.exit(1); });
