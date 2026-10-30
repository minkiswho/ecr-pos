// Backend tests: node tests/backend.test.js
const assert = require('assert');
const { load, makeSpreadsheet } = require('./gas-mock');

const MENU = {
  settings: { shopName: 'x' },
  categories: [{ id: 'c1', name: 'จานหลัก', order: 1 }],
  optionGroups: [
    { id: 'g1', name: 'ข้าว', min: 1, max: 1, options: [{ name: 'ข้าวสวย', price: 0 }, { name: 'ข้าวมัน', price: 0 }] },
    { id: 'g9', name: 'เพิ่ม', min: 0, max: 3, options: [{ name: 'ไข่', price: 10 }] },
  ],
  menuItems: [
    { id: 'm1', name: 'ข้าวมันไก่ (สะโพก&น่อง)', price: 60, catId: 'c1', groups: ['g1', 'g9'], available: true },
    { id: 'm2', name: 'น้ำเปล่า', price: 10, catId: 'c1', groups: [], available: true },
  ],
};
const SUR_ORDERS = ['id', 'status', 'type', 'table', 'method', 'total', 'received', 'change', 'items_json', 'createdAt', 'paidAt', 'updatedAt', 'name', 'saleDate', 'voidedAt', 'revision', 'lastOp'];
const EK_ORDERS = SUR_ORDERS.slice(0, 13);
const SUR_SALES = ['วันที่', 'เวลา', 'บิล', 'ประเภท', 'โต๊ะ', 'รายการ', 'วิธีจ่าย', 'ยอด(บาท)', 'สถานะ', 'รหัสอ้างอิง', 'วันที่รับเงิน', 'เวลารับเงิน'];
const EK_SALES = SUR_SALES.slice(0, 10);
const SUR_LINES = ['วันที่', 'เวลา', 'บิล', 'ประเภท', 'โต๊ะ/ชื่อ', 'เมนู', 'ตัวเลือก', 'จำนวน', 'ราคา/หน่วย', 'รวม', 'สถานะ', 'refId', 'วันที่รับเงิน'];
const EK_LINES = SUR_LINES.slice(0, 12);

function setup(branch) {
  const sur = branch === 'surawong';
  const ss = makeSpreadsheet({
    Orders: [sur ? SUR_ORDERS : EK_ORDERS],
    'รายการขาย': [sur ? SUR_SALES : EK_SALES],
    LineItems: [sur ? SUR_LINES : EK_LINES],
    Config: [['key', 'value'], ['menu', JSON.stringify(MENU)]],
    Images: [['key', 'dataUrl'], ['qr', 'data:image/png;base64,AAA']],
  });
  const env = load('Branch.' + branch + '.gs', { TEST: ss }, {
    MODE: 'test', TEST_SHEET_ID: 'TEST', SALT: 's1', CODE_CASHIER: 'CASH', CODE_MANAGER: 'MGR', CODE_VIEWER: 'VIEW',
    TELEGRAM_TOKEN: 't', TELEGRAM_CHAT: 'c',
  });
  env.ss = ss;
  return env;
}
let n = 0;
function t(name, fn) { fn(); n++; console.log('  ✓ ' + name); }
const line = (id, menuId, qty, sel) => ({ lineId: id, menuId, qty, selected: sel || [] });
const now = () => new Date().toISOString();

for (const branch of ['surawong', 'ekkamai']) {
  console.log(branch);
  const sur = branch === 'surawong';

  t('auth: wrong code rejected, roles resolved', () => {
    const { call } = setup(branch);
    assert.strictEqual(call({ action: 'login', code: 'nope' }).error, 'AUTH');
    assert.strictEqual(call({ action: 'login', code: 'CASH' }).role, 'cashier');
    assert.strictEqual(call({ action: 'login', code: 'VIEW' }).role, 'viewer');
    const v = call({ action: 'saveOrder', code: 'VIEW', opId: 'x', order: {} });
    assert.strictEqual(v.error, 'FORBIDDEN');
  });

  t('save open dine-in → pay later (prices from server)', () => {
    const { call, ss, sent } = setup(branch);
    const r1 = call({ action: 'saveOrder', code: 'CASH', opId: 'op1', baseRevision: 0, order: { id: 'abc123x9zz', type: 'dinein', table: '3', createdAt: now(), items: [line('l1', 'm1', 2, [{ groupId: 'g1', name: 'ข้าวมัน' }]), line('l2', 'm2', 1)] } });
    assert.ok(r1.ok, JSON.stringify(r1));
    assert.strictEqual(r1.order.total, 130);
    assert.strictEqual(r1.order.revision, 1);
    const sales = ss.map['รายการขาย'].data;
    if (sur) {
      assert.strictEqual(sales.length, 2);
      assert.strictEqual(sales[1][8], '⏳ ค้างจ่าย');
      assert.strictEqual(sales[1][6], 'ค้างจ่าย');
      assert.strictEqual(sales[1][4], 'โต๊ะ 3');
      assert.strictEqual(sales[1][5], '2x ข้าวมันไก่ (สะโพก&น่อง) (ข้าวมัน) | 1x น้ำเปล่า');
      assert.strictEqual(ss.map.LineItems.data.length, 3);
    } else {
      assert.strictEqual(sales.length, 1, 'ekkamai: no sales row while open');
      assert.strictEqual(ss.map.LineItems.data.length, 1);
    }
    // retry same op → same result, no duplicate
    const r1b = call({ action: 'saveOrder', code: 'CASH', opId: 'op1', baseRevision: 0, order: { id: 'abc123x9zz', type: 'dinein', table: '3', items: [] } });
    assert.strictEqual(r1b.order.revision, 1);
    // add item
    const r2 = call({ action: 'saveOrder', code: 'CASH', opId: 'op2', baseRevision: 1, order: { id: 'abc123x9zz', type: 'dinein', table: '3', items: [line('l1', 'm1', 2), line('l2', 'm2', 1), line('l3', 'm2', 2)] } });
    assert.strictEqual(r2.order.total, 150);
    // stale revision
    const r3 = call({ action: 'saveOrder', code: 'CASH', opId: 'op3', baseRevision: 1, order: { id: 'abc123x9zz', type: 'dinein', table: '3', items: [line('l1', 'm1', 2)] } });
    assert.strictEqual(r3.error, 'CONFLICT');
    // removing saved line needs manager
    const r4 = call({ action: 'saveOrder', code: 'CASH', opId: 'op4', baseRevision: 2, order: { id: 'abc123x9zz', type: 'dinein', table: '3', items: [line('l1', 'm1', 2), line('l2', 'm2', 1)] } });
    assert.strictEqual(r4.error, 'NEED_MANAGER');
    // table busy
    const r5 = call({ action: 'saveOrder', code: 'CASH', opId: 'op5', baseRevision: 0, order: { id: 'other00001', type: 'dinein', table: '3', items: [line('x1', 'm2', 1)] } });
    assert.strictEqual(r5.error, 'TABLE_BUSY');
    // pay cash
    const p = call({ action: 'pay', code: 'CASH', opId: 'op6', baseRevision: 2, method: 'cash', received: 200, paidAt: now(), order: { id: 'abc123x9zz', type: 'dinein', table: '3', items: [line('l1', 'm1', 2), line('l2', 'm2', 1), line('l3', 'm2', 2)] } });
    assert.ok(p.ok, JSON.stringify(p));
    assert.strictEqual(p.order.status, 'paid');
    assert.strictEqual(p.order.change, 50);
    const s2 = ss.map['รายการขาย'].data;
    assert.strictEqual(s2.length, 2, 'one sales row');
    assert.strictEqual(s2[1][8], '✅ ขาย');
    assert.strictEqual(s2[1][6], 'เงินสด');
    assert.strictEqual(s2[1][7], 150);
    if (!sur) { assert.strictEqual(s2[1][4], 3); assert.strictEqual(s2[1][5], '2x ข้าวมันไก่ (สะโพก&น่อง)(ข้าวมัน) | 1x น้ำเปล่า | 2x น้ำเปล่า'); }
    else assert.ok(s2[1][10]);
    const L = ss.map.LineItems.data;
    assert.strictEqual(L.length, 4);
    assert.ok(L.slice(1).every(r => r[10] === '✅ ขาย'));
    assert.strictEqual(L[1][11], 'abc123x9zz_l1');
    assert.ok(sent.some(x => x.includes('รับชำระออเดอร์ #X9ZZ')));
    // pay again → already paid
    const p2 = call({ action: 'pay', code: 'CASH', opId: 'op7', baseRevision: 3, method: 'qr', order: { id: 'abc123x9zz', type: 'dinein', table: '3', items: [] } });
    assert.strictEqual(p2.error, 'ALREADY_PAID');
    // void needs manager pin
    assert.strictEqual(call({ action: 'void', code: 'CASH', opId: 'v1', id: 'abc123x9zz' }).error, 'NEED_MANAGER');
    const v = call({ action: 'void', code: 'MGR', opId: 'v1', id: 'abc123x9zz', reason: 'test' });
    assert.strictEqual(v.order.status, 'void');
    assert.strictEqual(ss.map['รายการขาย'].data[1][8], '❌ ยกเลิก');
    assert.ok(ss.map.LineItems.data.slice(1).every(r => r[10] === '❌ ยกเลิก'));
    // orders sheet layout untouched
    assert.strictEqual(ss.map.Orders.data[0].length, sur ? 17 : 13);
    assert.strictEqual(ss.map.Orders.data[1].length, sur ? 17 : 13);
  });

  t('takeaway direct pay gets TW name, qr', () => {
    const { call, ss } = setup(branch);
    const p = call({ action: 'pay', code: 'CASH', opId: 'tw1', baseRevision: 0, method: 'qr', order: { id: 'tw0000abcd', type: 'takeaway', createdAt: now(), items: [line('a', 'm2', 3)] } });
    assert.ok(p.ok, JSON.stringify(p));
    assert.ok(/^TW\d{4}-001$/.test(p.order.name));
    const row = ss.map['รายการขาย'].data[1];
    assert.ok(row[3].startsWith('Take Away TW'));
    assert.strictEqual(row[4], sur ? p.order.name : '-');
    assert.strictEqual(row[7], 30);
  });

  t('manager pin flow + price override + void of open bill', () => {
    const { call, ss } = setup(branch);
    assert.ok(call({ action: 'admin', code: 'MGR', cmd: 'setManagerPin', pin: '2468' }).ok);
    assert.strictEqual(call({ action: 'checkPin', code: 'CASH', managerPin: '1111' }).error, 'BAD_PIN');
    assert.ok(call({ action: 'checkPin', code: 'CASH', managerPin: '2468' }).ok);
    const r = call({ action: 'saveOrder', code: 'CASH', opId: 'o1', baseRevision: 0, managerPin: '2468', order: { id: 'pp00000001', type: 'dinein', table: '1', items: [Object.assign(line('a', 'm1', 1), { priceOverride: 50 })] } });
    assert.strictEqual(r.order.total, 50);
    const noPin = call({ action: 'saveOrder', code: 'CASH', opId: 'o2', baseRevision: 0, order: { id: 'pp00000002', type: 'dinein', table: '2', items: [Object.assign(line('a', 'm1', 1), { priceOverride: 40 })] } });
    assert.strictEqual(noPin.error, 'NEED_MANAGER');
    const v = call({ action: 'void', code: 'CASH', opId: 'v', id: 'pp00000001', managerPin: '2468' });
    assert.strictEqual(v.order.status, 'void');
    const sales = ss.map['รายการขาย'].data;
    if (sur) assert.strictEqual(sales[1][8], '❌ ยกเลิก'); else assert.strictEqual(sales.length, 1);
  });

  t('getAll returns open + recent; summary math', () => {
    const { call } = setup(branch);
    call({ action: 'saveOrder', code: 'CASH', opId: 'a', baseRevision: 0, order: { id: 'sum0000001', type: 'dinein', table: '1', items: [line('a', 'm1', 1)] } });
    call({ action: 'pay', code: 'CASH', opId: 'b', baseRevision: 0, method: 'cash', received: 10, order: { id: 'sum0000002', type: 'dinein', table: '2', items: [line('a', 'm2', 1)] } });
    call({ action: 'pay', code: 'CASH', opId: 'c', baseRevision: 0, method: 'qr', order: { id: 'sum0000003', type: 'takeaway', items: [line('a', 'm2', 2)] } });
    const g = call({ action: 'getAll', code: 'VIEW' });
    assert.strictEqual(g.orders.length, 3);
    assert.strictEqual(g.menu.menuItems.length, 2);
    const s = call({ action: 'summary', code: 'VIEW' }).summary;
    assert.strictEqual(s.food, 90);
    assert.strictEqual(s.openToday, 60);
    assert.strictEqual(s.cash, 10);
    assert.strictEqual(s.qr, 20);
    assert.strictEqual(s.bills, 3);
    assert.strictEqual(s.take, 1);
    assert.ok(s.text.includes('📊 สรุปยอดขายสิ้นวัน'));
  });

  t('bill code that looks numeric is stored as text', () => {
    const { call, ss } = setup(branch);
    call({ action: 'pay', code: 'CASH', opId: 'n1', baseRevision: 0, method: 'qr', order: { id: 'abcdefg1E12', type: 'dinein', table: '1', items: [line('a', 'm2', 1)] } });
    assert.strictEqual(ss.map['รายการขาย'].fmts['2:3'], '@');
  });

  t('legacy open order (no POS_Meta) uses sheet revision and can be paid', () => {
    const { call, ss } = setup(branch);
    const items = JSON.stringify([{ lineId: 'old1', menuId: 'm1', name: 'ข้าวมันไก่ (สะโพก&น่อง)', base: 55, qty: 1, selected: [], note: '', unit: 55, total: 55 }]);
    const row = ['legacy0001', 'open', 'dinein', 5, '', 55, 0, 0, items, '2026-10-29T03:00:00.000Z', '', '2026-10-29T03:00:00.000Z', ''];
    if (sur) row.push('2026-10-29', '', 4, 'x');
    ss.map.Orders.data.push(row);
    if (sur) ss.map['รายการขาย'].data.push(['2026-10-29', '10:00', '0001', 'Dine In', 'โต๊ะ 5', '1x x', 'ค้างจ่าย', 55, '⏳ ค้างจ่าย', 'legacy0001']);
    const g = call({ action: 'getAll', code: 'CASH' });
    const o = g.orders.find(x => x.id === 'legacy0001');
    assert.strictEqual(o.revision, sur ? 4 : 0);
    const p = call({ action: 'pay', code: 'CASH', opId: 'lp', baseRevision: o.revision, method: 'cash', received: 55, order: o });
    assert.ok(p.ok, JSON.stringify(p));
    assert.strictEqual(p.order.total, 55, 'snapshot price kept');
    const sales = ss.map['รายการขาย'].data;
    assert.strictEqual(sales.length, 2, 'updated in place, not appended');
    assert.strictEqual(sales[1][8], '✅ ขาย');
    if (sur) assert.strictEqual(sales[1][0], '2026-10-29', 'stays on creation date');
  });
}
console.log('\n' + n + ' tests passed');
