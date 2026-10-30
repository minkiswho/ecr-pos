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
let slowGetAll = 0;
const reqLog = [];
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') reqLog.push(Date.now() % 100000 + ':OPTIONS');
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/api\/(\w+)$/);
  if (m && req.method === 'POST') {
    reqLog.push(Date.now() % 100000 + ':arrive');
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (offline) { req.socket.destroy(); return; }
      try { reqLog.push(Date.now() % 100000 + ':' + JSON.parse(body).action); } catch (e) {}
      const out = B[m[1]].ctx.doPost({ postData: { contents: body } }).text; // snapshot taken now
      const act = (body.match(/"action":"(\w+)"/) || [])[1];
      const send = () => { reqLog.push(Date.now() % 100000 + ':done-' + act); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out); };
      if (slowGetAll && /"action":"getAll"/.test(body)) setTimeout(send, slowGetAll); else send();
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
  await new Promise(r => server.listen(8765, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => window.addEventListener('unhandledrejection', e => console.error('UNHANDLED ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason))));
  page.on('console', m => { if (m.type() === 'error' && !/fonts|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = n => page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', n + '.png') });
  const step = async (name, fn) => { await fn(); console.log('  ✓ ' + name); };
  const S = B.surawong.ss.map;

  await page.goto('http://localhost:8765/surawong/');
  await step('wrong code rejected', async () => {
    await page.fill('input[name=code]', 'EK-NOPE');
    await page.click('button[type=submit]');
    await page.waitForSelector('.toast.show');
    assert.ok((await page.textContent('.toast')).includes('รหัส'));
  });
  await step('cashier login → tables', async () => {
    await page.fill('input[name=code]', 'su-cash');
    await page.click('button[type=submit]');
    await page.waitForSelector('.tile');
    await page.waitForSelector('.pill.ok');
    await shot('01-tables');
  });
  await step('open table 2, add items with options, save', async () => {
    await page.click('[data-a=new-table][data-v="2"]');
    await page.click('.mi:has-text("ข้าวมันไก่ (สะโพก&น่อง)")');
    await page.waitForSelector('.modal');
    await page.click('.opt:has-text("ข้าวมัน")');
    await page.click('.modal [data-q="1"]');
    await shot('02-options');
    await page.click('.modal [data-m=ok]');
    await page.click('.mi:has-text("น้ำเปล่า")');
    await shot('03-order');
    assert.ok((await page.textContent('.total')).includes('130'));
    await page.click('[data-a=save-order]');
    await page.waitForSelector('.tile.open');
    await page.waitForFunction(() => document.querySelector('.pill') && !/กำลังส่ง/.test(document.querySelector('.pill').textContent));
    await page.waitForTimeout(300);
    const sales = S['รายการขาย'].data;
    assert.strictEqual(sales.length, 2, 'sales row written');
    assert.strictEqual(sales[1][8], '⏳ ค้างจ่าย');
    assert.strictEqual(sales[1][5], '2x ข้าวมันไก่ (สะโพก&น่อง) (ข้าวมัน) | 1x น้ำเปล่า');
    await shot('04-saved');
  });
  await step('reopen table, add more, pay cash 500', async () => {
    await page.click('.tile.open');
    await page.click('.mi:has-text("โค้ก")');
    await page.click('[data-a=go-pay]');
    await page.waitForSelector('#recv');
    await page.fill('#recv', '500');
    assert.ok((await page.textContent('#chg')).includes('355'));
    await page.uncheck('[data-a=pay-print]');
    await shot('05-pay');
    await page.click('[data-a=confirm-pay]');
    await page.waitForSelector('.tile');
    await page.waitForTimeout(800);
    const sales = S['รายการขาย'].data;
    assert.strictEqual(sales.length, 2);
    assert.strictEqual(sales[1][8], '✅ ขาย');
    assert.strictEqual(sales[1][7], 145);
    assert.strictEqual(S.LineItems.data.length, 4);
    assert.ok(S.Orders.data[1][1] === 'paid');
  });
  await step('removing saved line requires manager', async () => {
    await page.click('[data-a=new-table][data-v="3"]');
    await page.click('.mi:has-text("น้ำเปล่า")');
    await page.click('[data-a=save-order]');
    await page.waitForTimeout(600);
    await page.click('.tile.open');
    await page.click('.mi:has-text("โค้ก")');
    await page.click('[data-a=qty][data-v="-1"] >> nth=0');
    await page.click('[data-a=save-order]');
    await page.waitForSelector('.modal:has-text("ผู้จัดการ")');
    await page.click('.modal [data-m=no]');
    await page.click('[data-a=back-order]');
    await page.click('.modal [data-m=yes]');
  });
  await step('bills tab + summary tab', async () => {
    await page.click('[data-a=view][data-v=bills]');
    await page.waitForSelector('.bill');
    assert.strictEqual(await page.locator('.bill').count(), 2);
    await shot('06-bills');
    await page.click('[data-a=view][data-v=summary]');
    const txt = await page.textContent('.hero');
    assert.ok(txt.includes('145'), txt);
    await shot('07-summary');
  });
  await step('offline: pay queues, then syncs when back', async () => {
    await page.click('[data-a=view][data-v=tables]');
    offline = true;
    await page.click('[data-a=new-take]');
    await page.click('.mi:has-text("น้ำเปล่า")');
    await page.click('[data-a=go-pay]');
    await page.click('[data-a=pay-method][data-v=qr]');
    await page.uncheck('[data-a=pay-print]');
    await page.click('[data-a=confirm-pay]');
    await page.waitForSelector('.pill.bad');
    await shot('08-offline');
    const before = S['รายการขาย'].data.length;
    offline = false;
    await page.click('[data-a=sync-detail]');
    await page.waitForSelector('.pill.ok', { timeout: 15000 });
    assert.strictEqual(S['รายการขาย'].data.length, before + 1);
  });
  if (!process.env.SKIPRACE) await step('race: slow sync response arriving after a save does not revert the order', async () => {
    await page.click('[data-a=view][data-v=tables]');
    await page.click('[data-a=new-table][data-v="4"]');
    await page.click('.mi:has-text("น้ำเปล่า")');
    await page.click('[data-a=save-order]');
    await page.waitForFunction(() => !/กำลังส่ง|รอส่ง/.test(document.querySelector('.pill').textContent));
    await page.waitForTimeout(500);
    slowGetAll = 2500;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // unlock/return → pull starts
    await page.waitForTimeout(200);
    await page.click('.tile.open:has-text("โต๊ะ 4")');
    await page.click('.mi:has-text("โค้ก")');
    await page.click('[data-a=save-order]'); // saved + acked while getAll is still in flight
    await page.waitForTimeout(3500); // stale getAll lands
    slowGetAll = 0;
    const tile = await page.textContent('.tile.open:has-text("โต๊ะ 4")');
    assert.ok(tile.includes('25'), 'tile reverted to stale total: ' + tile);
    await page.click('.tile.open:has-text("โต๊ะ 4")');
    await page.click('[data-a=go-pay]');
    await page.click('[data-a=quick]');
    await page.uncheck('[data-a=pay-print]');
    await page.click('[data-a=confirm-pay]');
    await page.waitForFunction(() => !/กำลังส่ง|รอส่ง/.test(document.querySelector('.pill').textContent), null, { timeout: 20000 }).catch(() => {});
    const o = S.Orders.data.find(r => r[3] === '4' || r[3] === 4);
    await shot('race-after-pay'); const rv = await page.evaluate(() => [localStorage.getItem('ecr_surawong_review'), localStorage.getItem('ecr_surawong_outbox'), document.querySelector('.pill').textContent, JSON.stringify(window.__ecrSync())]); assert.strictEqual(o[1], 'paid', 'payment not applied: ' + JSON.stringify(o.slice(0, 6)) + ' review=' + rv + ' log=' + reqLog.slice(-12).join(',') + ' errors=' + JSON.stringify(errors));
  });
  await step('manager sets lock PIN; reload locks; PIN unlocks', async () => {
    await page.click('[data-a=view][data-v=settings]');
    await page.click('[data-a=logout]');
    await page.click('.modal [data-m=yes]');
    await page.fill('input[name=code]', 'SU-MGR');
    await page.click('button[type=submit]');
    await page.waitForSelector('.tile');
    await page.click('[data-a=view][data-v=settings]');
    await page.click('[data-a=set-lock-pin]');
    await page.fill('.modal input[name=v]', '1357');
    await page.click('.modal [data-m=ok]');
    await page.waitForSelector('.toast.show:has-text("ตั้ง PIN")');
    await shot('09-settings');
    await page.reload();
    await page.waitForSelector('.pad');
    for (const k of ['1', '3', '5', '7', 'OK']) await page.click(`[data-a=pin][data-v="${k}"]`);
    await page.waitForSelector('.tabs');
  });
  await step('after reload while logged in, new orders still sync', async () => {
    await page.reload();
    await page.waitForSelector('.pad');
    for (const k of ['1', '3', '5', '7', 'OK']) await page.click(`[data-a=pin][data-v="${k}"]`);
    await page.waitForSelector('.tile');
    await page.waitForTimeout(1500);
    const before = S.Orders.data.length;
    await page.click('[data-a=new-table][data-v="5"]');
    await page.click('.mi:has-text("น้ำเปล่า")');
    await page.click('[data-a=save-order]');
    await page.waitForFunction(() => !/กำลังส่ง|รอส่ง/.test(document.querySelector('.pill').textContent), null, { timeout: 10000 });
    assert.strictEqual(S.Orders.data.length, before + 1, 'order stuck on device after reload');
  });
  await step('viewer is read-only', async () => {
    const p2 = await ctx.newPage();
    await p2.goto('http://localhost:8765/ekkamai/');
    await p2.fill('input[name=code]', 'SU-VIEW'); // ekkamai backend uses same test codes
    await p2.click('button[type=submit]');
    await p2.waitForSelector('.tile');
    assert.ok(await p2.locator('[data-a=new-take]').count() === 0);
    await p2.close();
  });
  await step('ekkamai: open table does not write sales; pay does (paid-date mode)', async () => {
    const p3 = await ctx.newPage();
    await p3.goto('http://localhost:8765/ekkamai/');
    await p3.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ecr_ekkamai_')).forEach(k => localStorage.removeItem(k)));
    await p3.reload();
    await p3.fill('input[name=code]', 'SU-CASH');
    await p3.click('button[type=submit]');
    await p3.waitForSelector('.tile');
    await p3.click('[data-a=new-table][data-v="1"]');
    await p3.click('.mi:has-text("น้ำเปล่า")');
    await p3.click('[data-a=save-order]');
    await p3.waitForTimeout(800);
    const E = B.ekkamai.ss.map;
    assert.strictEqual(E['รายการขาย'].data.length, 1);
    await p3.click('.tile.open');
    await p3.click('[data-a=go-pay]');
    await p3.click('[data-a=quick]');
    await p3.uncheck('[data-a=pay-print]');
    await p3.click('[data-a=confirm-pay]');
    await p3.waitForTimeout(800);
    assert.strictEqual(E['รายการขาย'].data.length, 2);
    assert.strictEqual(E['รายการขาย'].data[1][4], 1);
    // ekkamai takeaway: pay only (no save button)
    await p3.click('[data-a=new-take]');
    assert.strictEqual(await p3.locator('[data-a=save-order]').count(), 0);
    await p3.close();
  });
  assert.deepStrictEqual(errors, []);
  console.log('\nE2E passed');
  await browser.close();
  server.close();
})().catch(async e => { console.error('FAIL', e); process.exit(1); });
