/**
 * ECR POS R1 — backend (Google Apps Script)
 * โค้ดชุดเดียวใช้ทั้ง 2 สาขา; ค่าที่ต่างกันอยู่ใน BRANCH ด้านบนของไฟล์
 * Built by Rocky (Claude) — 2026-10-30
 */
var TZ = 'Asia/Bangkok';
var VERSION = 'R1.1';
var CTX = {};

var ST = { SALE: '✅ ขาย', OPEN: '⏳ ค้างจ่าย', VOID: '❌ ยกเลิก' };
var META_HEAD = ['id', 'revision', 'lastOp', 'voidedAt', 'voidReason', 'updatedAt'];
var OPS_HEAD = ['opId', 'action', 'orderId', 'result', 'createdAt'];
var NOTIFY_HEAD = ['id', 'text', 'status', 'attempts', 'lastError', 'createdAt'];

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */
function doGet(e) {
  var c = cfg_();
  return json_({ ok: true, app: 'ECR POS', version: VERSION, branch: c.branch, mode: c.mode, time: new Date().toISOString() });
}

function doPost(e) {
  CTX = {};
  var out;
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route_(p);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: err.code || 'ERROR', message: err.message || String(err) };
    if (err.data) out.data = err.data;
  }
  out.serverTime = new Date().toISOString();
  out.version = VERSION;
  return json_(out);
}

function route_(p) {
  var a = p.action;
  if (a === 'ping') return { branch: cfg_().branch };
  var role = auth_(p.code);
  CTX.role = role;
  switch (a) {
    case 'login': return login_(role);
    case 'getAll': return getAll_(p);
    case 'getImages': return { images: getImages_(p.keys) };
    case 'summary': return { summary: summary_(p.date || today_()) };
  }
  if (role === 'viewer') throw err_('FORBIDDEN', 'บัญชีนี้ดูข้อมูลได้อย่างเดียว');
  switch (a) {
    case 'saveOrder': return locked_(function () { return saveOrder_(p); });
    case 'pay': return locked_(function () { return pay_(p); });
    case 'void': return locked_(function () { return void_(p); });
    case 'sendSummary': return locked_(function () { return sendSummary_(p.date || today_(), true); });
    case 'saveConfig': return locked_(function () { return saveConfig_(p); });
    case 'saveImage': return locked_(function () { return saveImage_(p); });
    case 'admin': return locked_(function () { return admin_(p); });
    case 'checkPin': requireApproval_(p); return { approved: true };
  }
  throw err_('BAD_ACTION', 'ไม่รู้จักคำสั่ง ' + a);
}

/* ------------------------------------------------------------------ */
/* Config / auth                                                       */
/* ------------------------------------------------------------------ */
function P_() { return PropertiesService.getScriptProperties(); }
function prop_(k, d) { var v = P_().getProperty(k); return v == null || v === '' ? d : v; }

function cfg_() {
  var mode = prop_('MODE', 'test');
  var sheetId = mode === 'live' ? BRANCH.liveSheetId : prop_('TEST_SHEET_ID', BRANCH.testSheetId || '');
  return {
    branch: BRANCH.key, name: BRANCH.name, label: BRANCH.label, reportMode: BRANCH.reportMode,
    optionOpen: BRANCH.optionOpen, salesTable: BRANCH.salesTable, voidStatus: BRANCH.voidStatus || ST.VOID,
    mode: mode, sheetId: sheetId
  };
}

function auth_(code) {
  code = String(code || '').trim();
  if (!code) throw err_('AUTH', 'ต้องใส่รหัสเครื่อง');
  var map = { cashier: prop_('CODE_CASHIER'), manager: prop_('CODE_MANAGER'), viewer: prop_('CODE_VIEWER') };
  for (var r in map) if (map[r] && map[r] === code) return r;
  throw err_('AUTH', 'รหัสไม่ถูกต้อง หรือไม่ใช่รหัสของสาขา' + BRANCH.name);
}

function hash_(s) {
  var salt = prop_('SALT', 'ecr');
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + s, Utilities.Charset.UTF_8);
  return b.map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join('');
}

function approved_(p) {
  if (CTX.role === 'manager') return true;
  var pin = String(p.managerPin || '');
  if (!pin) return false;
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('pinfail') || 0);
  if (fails >= 5) throw err_('PIN_LOCKED', 'ใส่ PIN ผิดหลายครั้ง รอ 5 นาที');
  var h = prop_('MANAGER_PIN_HASH');
  if (!h) throw err_('NO_PIN', 'ยังไม่ได้ตั้ง PIN ผู้จัดการ');
  if (hash_(pin) === h) { cache.remove('pinfail'); return true; }
  cache.put('pinfail', String(fails + 1), 300);
  throw err_('BAD_PIN', 'PIN ผู้จัดการไม่ถูกต้อง');
}
function requireApproval_(p) { if (!approved_(p)) throw err_('NEED_MANAGER', 'ต้องให้ผู้จัดการอนุมัติ'); }

function login_(role) {
  var c = cfg_();
  return {
    role: role, branch: c.branch, branchName: c.name, label: c.label, mode: c.mode,
    salt: prop_('SALT', 'ecr'), lockHash: prop_('LOCK_PIN_HASH', ''), hasManagerPin: !!prop_('MANAGER_PIN_HASH')
  };
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */
function ss_() {
  if (!CTX.ss) {
    var id = cfg_().sheetId;
    if (!id) throw err_('NO_SHEET', 'ยังไม่ได้ตั้งค่า Sheet ของโหมดนี้');
    CTX.ss = SpreadsheetApp.openById(id);
  }
  return CTX.ss;
}
function sheet_(name, head) {
  var s = ss_().getSheetByName(name);
  if (!s) {
    if (!head) throw err_('NO_SHEET', 'ไม่พบชีท ' + name);
    s = ss_().insertSheet(name);
    s.getRange(1, 1, 1, head.length).setValues([head]);
  }
  return s;
}
function table_(name, head) {
  var s = sheet_(name, head);
  var lr = s.getLastRow(), lc = s.getLastColumn();
  var vals = lr ? s.getRange(1, 1, lr, Math.max(lc, 1)).getValues() : [head || []];
  var idx = {};
  vals[0].forEach(function (h, i) { idx[String(h)] = i; });
  return { s: s, head: vals[0], idx: idx, rows: vals.slice(1) };
}
function col_(s, c) {
  var lr = s.getLastRow();
  if (lr < 2) return [];
  return s.getRange(2, c, lr - 1, 1).getValues().map(function (r) { return r[0]; });
}
function locked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw err_('BUSY', 'ระบบกำลังบันทึกรายการอื่น ลองใหม่อีกครั้ง');
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function err_(code, msg, data) { var e = new Error(msg); e.code = code; if (data) e.data = data; return e; }
function iso_(v) { if (v instanceof Date) return v.toISOString(); return v == null ? '' : String(v); }
function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function fmt_(d, f) { return Utilities.formatDate(d instanceof Date ? d : new Date(d), TZ, f); }
function today_() { return fmt_(new Date(), 'yyyy-MM-dd'); }
function dayOf_(iso) { return iso ? fmt_(new Date(iso), 'yyyy-MM-dd') : ''; }
function code_(id) { return String(id).slice(-4).toUpperCase(); }
function clampTime_(iso) {
  var now = Date.now();
  var t = iso ? new Date(iso).getTime() : NaN;
  if (!isFinite(t) || t > now + 5 * 60000 || t < now - 3 * 86400000) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */
function loadOrders_() {
  if (CTX.orders) return CTX.orders;
  var t = table_('Orders');
  var meta = loadMeta_();
  var list = [], byId = {};
  t.rows.forEach(function (r, i) {
    var id = String(r[t.idx.id] || '');
    if (!id) return;
    var o = rowToOrder_(t, r, meta.map[id]);
    o._row = i + 2;
    list.push(o); byId[id] = o;
  });
  CTX.orders = { t: t, list: list, byId: byId, meta: meta };
  return CTX.orders;
}

function rowToOrder_(t, r, m) {
  var x = t.idx, items = [];
  try { items = JSON.parse(r[x.items_json] || '[]'); } catch (e) { items = []; }
  var rev = m ? num_(m.revision) : (x.revision != null ? num_(r[x.revision]) : 0);
  return {
    id: String(r[x.id]), status: String(r[x.status] || ''), type: String(r[x.type] || 'dinein'),
    table: String(r[x.table] == null ? '' : r[x.table]), method: String(r[x.method] || ''),
    total: num_(r[x.total]), received: num_(r[x.received]), change: num_(r[x.change]),
    items: items, createdAt: iso_(r[x.createdAt]), paidAt: iso_(r[x.paidAt]), updatedAt: iso_(r[x.updatedAt]),
    name: String(r[x.name] == null ? '' : r[x.name]), revision: rev,
    voidedAt: m ? iso_(m.voidedAt) : (x.voidedAt != null ? iso_(r[x.voidedAt]) : '')
  };
}

function writeOrder_(o, opId) {
  var O = loadOrders_(), t = O.t;
  var row = t.head.map(function (h) {
    switch (String(h)) {
      case 'id': return o.id;
      case 'status': return o.status;
      case 'type': return o.type;
      case 'table': return o.type === 'dinein' ? o.table : '';
      case 'method': return o.method || '';
      case 'total': return o.total;
      case 'received': return o.received || 0;
      case 'change': return o.change || 0;
      case 'items_json': return JSON.stringify(o.items);
      case 'createdAt': return o.createdAt;
      case 'paidAt': return o.paidAt || '';
      case 'updatedAt': return o.updatedAt;
      case 'name': return o.name || '';
      case 'saleDate': return dayOf_(o.createdAt);
      case 'voidedAt': return o.voidedAt || '';
      case 'revision': return o.revision;
      case 'lastOp': return opId || '';
      default: return '';
    }
  });
  if (o._row) {
    t.s.getRange(o._row, 1, 1, row.length).setValues([row]);
  } else {
    t.s.appendRow(row);
    o._row = t.s.getLastRow();
    O.list.push(o); O.byId[o.id] = o;
  }
  writeMeta_(o, opId);
}

function loadMeta_() {
  var t = table_('POS_Meta', META_HEAD);
  var map = {}, rowOf = {};
  t.rows.forEach(function (r, i) {
    var id = String(r[0]);
    if (id) { map[id] = { revision: r[1], lastOp: r[2], voidedAt: r[3], voidReason: r[4] }; rowOf[id] = i + 2; }
  });
  return { t: t, map: map, rowOf: rowOf };
}
function writeMeta_(o, opId) {
  var M = loadOrders_().meta;
  var row = [o.id, o.revision, opId || '', o.voidedAt || '', o.voidReason || '', o.updatedAt];
  if (M.rowOf[o.id]) M.t.s.getRange(M.rowOf[o.id], 1, 1, row.length).setValues([row]);
  else { M.t.s.appendRow(row); M.rowOf[o.id] = M.t.s.getLastRow(); }
  M.map[o.id] = { revision: o.revision, lastOp: opId, voidedAt: o.voidedAt };
}

function publicOrder_(o) {
  var c = {};
  for (var k in o) if (k.charAt(0) !== '_') c[k] = o[k];
  return c;
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */
function findOp_(opId) {
  if (!opId) throw err_('BAD_REQUEST', 'missing opId');
  var s = sheet_('POS_Ops', OPS_HEAD);
  var ids = col_(s, 1);
  var i = ids.lastIndexOf(opId);
  if (i < 0) return null;
  var res = s.getRange(i + 2, 4).getValue();
  try { return JSON.parse(res); } catch (e) { return null; }
}
function saveOp_(opId, action, orderId, result) {
  sheet_('POS_Ops', OPS_HEAD).appendRow([opId, action, orderId, JSON.stringify(result), new Date().toISOString()]);
}

/* ------------------------------------------------------------------ */
/* Menu / pricing                                                      */
/* ------------------------------------------------------------------ */
function loadMenu_() {
  if (CTX.menu) return CTX.menu;
  var t = table_('Config', ['key', 'value']);
  var menu = null;
  t.rows.forEach(function (r, i) {
    if (String(r[0]) === 'menu') { try { menu = JSON.parse(r[1]); } catch (e) { } CTX.menuRow = i + 2; }
  });
  if (!menu) menu = { settings: {}, categories: [], optionGroups: [], menuItems: [] };
  CTX.menu = menu;
  return menu;
}

function priceItems_(items, prev, p) {
  var menu = loadMenu_();
  var mi = {}, gi = {};
  (menu.menuItems || []).forEach(function (m) { mi[m.id] = m; });
  (menu.optionGroups || []).forEach(function (g) { gi[g.id] = g; });
  var prevLines = {};
  (prev ? prev.items : []).forEach(function (l) { prevLines[l.lineId] = l; });
  var needApproval = false, seen = {};
  var out = (items || []).map(function (l) {
    var qty = Math.round(num_(l.qty));
    if (qty <= 0 || qty > 999) throw err_('BAD_ITEM', 'จำนวนไม่ถูกต้อง: ' + l.name);
    if (!l.lineId) throw err_('BAD_ITEM', 'missing lineId');
    if (seen[l.lineId]) throw err_('BAD_ITEM', 'lineId ซ้ำ');
    seen[l.lineId] = 1;
    var old = prevLines[l.lineId], line;
    if (old) {
      line = JSON.parse(JSON.stringify(old));
      if (qty < num_(old.qty)) needApproval = true;
      line.qty = qty;
      line.note = String(l.note || '');
    } else {
      var m = mi[l.menuId];
      if (!m) throw err_('BAD_ITEM', 'ไม่พบเมนู ' + (l.name || l.menuId) + ' (เมนูอาจถูกแก้ไข ให้โหลดเมนูใหม่)');
      var sel = (l.selected || []).map(function (s) {
        var g = gi[s.groupId];
        var opt = g && (g.options || []).filter(function (x) { return x.name === s.name; })[0];
        if (!opt) throw err_('BAD_ITEM', 'ไม่พบตัวเลือก ' + s.name + ' ของ ' + m.name);
        return { groupId: g.id, groupName: g.name, name: opt.name, price: num_(opt.price) };
      });
      var unit = num_(m.price) + sel.reduce(function (a, s) { return a + s.price; }, 0);
      line = { lineId: String(l.lineId), menuId: m.id, name: m.name, base: num_(m.price), qty: qty, selected: sel, note: String(l.note || ''), unit: unit, total: 0 };
    }
    if (l.priceOverride != null && l.priceOverride !== '' && num_(l.priceOverride) !== num_(line.unit)) {
      line.unit = num_(l.priceOverride);
      line.priceOverride = true;
      needApproval = true;
    }
    line.total = line.unit * line.qty;
    return line;
  });
  for (var id in prevLines) if (!seen[id]) needApproval = true;
  if (needApproval) requireApproval_(p);
  return out;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */
function getAll_(p) {
  var O = loadOrders_();
  var from = p.from || fmt_(new Date(Date.now() - 2 * 86400000), 'yyyy-MM-dd');
  var to = p.to || '9999-12-31';
  var orders = O.list.filter(function (o) {
    if (o.status === 'open') return true;
    var c = dayOf_(o.createdAt), d = dayOf_(o.paidAt);
    return (c >= from && c <= to) || (d >= from && d <= to);
  }).map(publicOrder_);
  var menu = loadMenu_();
  return { orders: orders, menu: menu, role: CTX.role, from: from, to: to, branch: cfg_().branch, mode: cfg_().mode, imagesVer: prop_('IMAGES_VER', '1') };
}

function saveOrder_(p) {
  var done = findOp_(p.opId);
  if (done) return done;
  var o = applyOrder_(p, false);
  writeOrder_(o, p.opId);
  if (cfg_().reportMode === 'created') writeDerived_(o);
  var res = { order: publicOrder_(o) };
  saveOp_(p.opId, 'saveOrder', o.id, res);
  return res;
}

function pay_(p) {
  var done = findOp_(p.opId);
  if (done) return done;
  var o = applyOrder_(p, true);
  var method = p.method === 'qr' ? 'qr' : 'cash';
  var received = method === 'qr' ? o.total : num_(p.received);
  if (method === 'cash' && received < o.total) throw err_('BAD_PAY', 'รับเงินน้อยกว่ายอด');
  o.status = 'paid';
  o.method = method;
  o.received = received;
  o.change = received - o.total;
  o.paidAt = clampTime_(p.paidAt);
  writeOrder_(o, p.opId);
  writeDerived_(o);
  notify_('paid:' + o.id, paidText_(o));
  var res = { order: publicOrder_(o) };
  saveOp_(p.opId, 'pay', o.id, res);
  return res;
}

/** create or update an open order from p.order; used by save and pay */
function applyOrder_(p, paying) {
  var inp = p.order || {};
  if (!inp.id) throw err_('BAD_REQUEST', 'missing order id');
  var O = loadOrders_();
  var cur = O.byId[String(inp.id)];
  var now = new Date().toISOString();
  if (cur) {
    if (cur.status === 'paid') throw err_('ALREADY_PAID', 'บิลนี้ชำระแล้ว', { order: publicOrder_(cur) });
    if (cur.status === 'void') throw err_('VOIDED', 'บิลนี้ถูกยกเลิกแล้ว', { order: publicOrder_(cur) });
    if (num_(p.baseRevision) !== num_(cur.revision)) throw err_('CONFLICT', 'บิลนี้ถูกแก้จากเครื่องอื่น ให้โหลดใหม่', { order: publicOrder_(cur) });
  }
  var type = inp.type === 'takeaway' ? 'takeaway' : 'dinein';
  var table = type === 'dinein' ? String(inp.table || '').trim() : '';
  if (type === 'dinein' && !table) throw err_('BAD_REQUEST', 'ต้องระบุโต๊ะ');
  if (type === 'dinein' && !paying) {
    var busy = O.list.filter(function (x) { return x.status === 'open' && x.type === 'dinein' && x.table === table && x.id !== String(inp.id); })[0];
    if (busy) throw err_('TABLE_BUSY', 'โต๊ะ ' + table + ' มีบิลค้างอยู่แล้ว (#' + code_(busy.id) + ')', { order: publicOrder_(busy) });
  }
  var items = priceItems_(inp.items, cur, p);
  if (!items.length) throw err_('BAD_REQUEST', 'ยังไม่มีรายการอาหาร');
  var o = cur || { id: String(inp.id), status: 'open', createdAt: clampTime_(inp.createdAt), revision: 0, paidAt: '', method: '' };
  o.type = type;
  o.table = table;
  o.items = items;
  o.total = items.reduce(function (a, l) { return a + l.total; }, 0);
  o.name = type === 'takeaway' ? (cur && cur.name) || String(inp.name || '') || takeawayName_(o) : '';
  o.updatedAt = now;
  o.revision = num_(o.revision) + 1;
  return o;
}

function takeawayName_(o) {
  var d = dayOf_(o.createdAt);
  var n = loadOrders_().list.filter(function (x) { return x.type === 'takeaway' && dayOf_(x.createdAt) === d; }).length;
  return 'TW' + fmt_(new Date(o.createdAt), 'MMdd') + '-' + ('00' + (n + 1)).slice(-3);
}

function void_(p) {
  var done = findOp_(p.opId);
  if (done) return done;
  requireApproval_(p);
  var o = loadOrders_().byId[String(p.id)];
  if (!o) throw err_('NOT_FOUND', 'ไม่พบบิล');
  if (o.status === 'void') return { order: publicOrder_(o) };
  var wasPaid = o.status === 'paid';
  o.status = 'void';
  o.voidedAt = new Date().toISOString();
  o.voidReason = String(p.reason || '');
  o.updatedAt = o.voidedAt;
  o.revision = num_(o.revision) + 1;
  writeOrder_(o, p.opId);
  if (cfg_().reportMode === 'created' || wasPaid) writeDerived_(o);
  notify_('void:' + o.id, voidText_(o));
  var res = { order: publicOrder_(o) };
  saveOp_(p.opId, 'void', o.id, res);
  return res;
}

function saveConfig_(p) {
  requireApproval_(p);
  var m = p.menu;
  if (!m || !Array.isArray(m.menuItems) || !Array.isArray(m.categories) || !Array.isArray(m.optionGroups)) throw err_('BAD_REQUEST', 'รูปแบบเมนูไม่ถูกต้อง');
  m.menuItems.forEach(function (x) {
    if (!x.id || !x.name) throw err_('BAD_REQUEST', 'เมนูต้องมี id และชื่อ');
    x.price = num_(x.price);
  });
  loadMenu_();
  var s = sheet_('Config', ['key', 'value']);
  var text = JSON.stringify(m);
  if (CTX.menuRow) s.getRange(CTX.menuRow, 2).setValue(text);
  else s.appendRow(['menu', text]);
  CTX.menu = m;
  return { menu: m };
}

function getImages_(keys) {
  var t = table_('Images', ['key', 'dataUrl']);
  var want = keys && keys.length ? keys : null, out = {};
  t.rows.forEach(function (r) {
    var k = String(r[0]);
    if (k && (!want || want.indexOf(k) >= 0)) out[k] = String(r[1] || '');
  });
  return out;
}
function saveImage_(p) {
  requireApproval_(p);
  var key = String(p.key || ''), data = String(p.dataUrl || '');
  if (!key) throw err_('BAD_REQUEST', 'missing key');
  if (data.length > 49000) throw err_('TOO_BIG', 'รูปใหญ่เกินไป');
  var t = table_('Images', ['key', 'dataUrl']);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][0]) === key) { t.s.getRange(i + 2, 2).setValue(data); P_().setProperty('IMAGES_VER', String(Date.now())); return { key: key }; }
  }
  t.s.appendRow([key, data]);
  P_().setProperty('IMAGES_VER', String(Date.now()));
  return { key: key };
}

function admin_(p) {
  var cmd = p.cmd, P = P_();
  if (cmd === 'status') {
    return {
      mode: cfg_().mode, sheetId: cfg_().sheetId, telegram: !!prop_('TELEGRAM_TOKEN') && !!prop_('TELEGRAM_CHAT'),
      managerPin: !!prop_('MANAGER_PIN_HASH'), lockPin: !!prop_('LOCK_PIN_HASH'), summaryAuto: prop_('SUMMARY_AUTO', '0') === '1',
      triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
      pendingNotify: pendingCount_()
    };
  }
  if (CTX.role !== 'manager') requireApproval_(p);
  switch (cmd) {
    case 'setManagerPin':
      if (!/^\d{4,8}$/.test(String(p.pin))) throw err_('BAD_REQUEST', 'PIN ต้องเป็นตัวเลข 4-8 หลัก');
      P.setProperty('MANAGER_PIN_HASH', hash_(String(p.pin))); return { done: true };
    case 'setLockPin':
      if (!/^\d{4,8}$/.test(String(p.pin))) throw err_('BAD_REQUEST', 'PIN ต้องเป็นตัวเลข 4-8 หลัก');
      P.setProperty('LOCK_PIN_HASH', hash_(String(p.pin))); return { done: true, lockHash: prop_('LOCK_PIN_HASH') };
    case 'setTelegram':
      if (p.token) P.setProperty('TELEGRAM_TOKEN', String(p.token).trim());
      if (p.chat) P.setProperty('TELEGRAM_CHAT', String(p.chat).trim());
      return { done: true };
    case 'testTelegram':
      var r = tgSend_('✅ ทดสอบการแจ้งเตือนจาก ' + cfg_().label + ' (ระบบใหม่ R1)');
      return { sent: r.ok, error: r.error || '' };
    case 'setSummaryAuto':
      P.setProperty('SUMMARY_AUTO', p.on ? '1' : '0'); installTriggers(); return { done: true };
    case 'setMode':
      if (p.mode !== 'live' && p.mode !== 'test') throw err_('BAD_REQUEST', 'mode');
      P.setProperty('MODE', p.mode); CTX.ss = null; setupSheets_(); return { mode: p.mode };
    case 'installTriggers':
      installTriggers(); return { done: true };
    case 'retryNotify':
      flushNotify_(); return { pending: pendingCount_() };
  }
  throw err_('BAD_ACTION', 'admin ' + cmd);
}

/* ------------------------------------------------------------------ */
/* Derived rows: รายการขาย + LineItems                                 */
/* ------------------------------------------------------------------ */
function statusText_(o) {
  if (o.status === 'paid') return ST.SALE;
  if (o.status === 'void') return cfg_().voidStatus;
  return ST.OPEN;
}
function methodText_(o) {
  if (o.method === 'qr') return 'QR';
  if (o.method === 'cash') return 'เงินสด';
  return 'ค้างจ่าย';
}
function itemsText_(o) {
  var open = cfg_().optionOpen;
  return o.items.map(function (l) {
    var opts = (l.selected || []).map(function (s) { return s.name; });
    return l.qty + 'x ' + l.name + (opts.length ? open + opts.join('/') + ')' : '');
  }).join(' | ');
}
function baseTime_(o) { return cfg_().reportMode === 'paid' && o.paidAt ? o.paidAt : o.createdAt; }

function salesRow_(o) {
  var c = cfg_(), t = new Date(baseTime_(o));
  var table = o.type === 'dinein'
    ? (c.salesTable === 'number' ? (isFinite(Number(o.table)) && o.table !== '' ? Number(o.table) : o.table) : 'โต๊ะ ' + o.table)
    : (c.salesTable === 'number' ? '-' : (o.name || '-'));
  var row = [fmt_(t, 'yyyy-MM-dd'), fmt_(t, 'H:mm'), code_(o.id), o.type === 'dinein' ? 'Dine In' : 'Take Away' + (o.name ? ' ' + o.name : ''),
    table, itemsText_(o), methodText_(o), o.total, statusText_(o), o.id];
  if (c.reportMode === 'created') {
    row.push(o.status === 'paid' ? fmt_(o.paidAt, 'yyyy-MM-dd') : '', o.status === 'paid' ? fmt_(o.paidAt, 'H:mm') : '');
  }
  return row;
}
function lineRows_(o) {
  var c = cfg_(), t = new Date(baseTime_(o));
  var who = o.type === 'dinein' ? 'โต๊ะ ' + o.table : (o.name || 'Take Away');
  return o.items.map(function (l) {
    var row = [fmt_(t, 'yyyy-MM-dd'), fmt_(t, 'H:mm'), code_(o.id), o.type === 'dinein' ? 'Dine In' : 'Take Away', who,
      l.name, (l.selected || []).map(function (s) { return s.name; }).join('/'), l.qty, l.unit, l.total, statusText_(o), o.id + '_' + l.lineId];
    if (c.reportMode === 'created') row.push(o.status === 'paid' ? fmt_(o.paidAt, 'yyyy-MM-dd') : '');
    return row;
  });
}

function writeDerived_(o) {
  // รายการขาย
  var s = sheet_('รายการขาย');
  var refs = col_(s, 10).map(String);
  var row = salesRow_(o);
  var i = refs.lastIndexOf(o.id);
  var r = i >= 0 ? i + 2 : s.getLastRow() + 1;
  s.getRange(r, 1, 1, row.length).setValues([row]);
  textCell_(s, r, 3, row[2]);
  // LineItems
  var L = sheet_('LineItems');
  var lrefs = col_(L, 12).map(String);
  var rows = lineRows_(o), keep = {};
  var appendAt = L.getLastRow() + 1;
  rows.forEach(function (lr) {
    keep[lr[11]] = 1;
    var j = lrefs.lastIndexOf(lr[11]);
    var rr = j >= 0 ? j + 2 : appendAt++;
    L.getRange(rr, 1, 1, lr.length).setValues([lr]);
    textCell_(L, rr, 3, lr[2]);
  });
  var del = [];
  lrefs.forEach(function (ref, j) { if (ref.indexOf(o.id + '_') === 0 && !keep[ref]) del.push(j + 2); });
  del.sort(function (a, b) { return b - a; }).forEach(function (rr) { L.deleteRow(rr); });
}
function textCell_(s, r, c, v) {
  if (/^\d+$/.test(v) || /^\d*E\d+$/i.test(v)) { var g = s.getRange(r, c); g.setNumberFormat('@'); g.setValue(v); }
}

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */
function paidText_(o) {
  var lines = o.items.map(function (l) {
    var opts = (l.selected || []).map(function (s) { return s.name; });
    return '• ' + l.qty + 'x ' + l.name + (opts.length ? ' (' + opts.join('/') + ')' : '') + (l.note ? ' [' + l.note + ']' : '');
  });
  var where = o.type === 'dinein' ? '🍽️ โต๊ะ ' + o.table : '🛍️ Take Away' + (o.name ? ' ' + o.name : '');
  var pay = o.method === 'qr' ? '📱 QR' : '💵 เงินสด (ทอน ' + o.change + ')';
  return '🧾 รับชำระออเดอร์ #' + code_(o.id) + '\n' + cfg_().label + '\n' + where + '\n' + lines.join('\n') +
    '\n\n💰 รวม ' + o.total + ' บาท\n' + pay + '\n🗓️ วันสั่ง ' + dayOf_(o.createdAt) + '\n🕒 รับเงิน ' + fmt_(o.paidAt, 'yyyy-MM-dd HH:mm');
}
function voidText_(o) {
  return '❌ ยกเลิกบิล #' + code_(o.id) + '\n' + cfg_().label + '\nวันสั่ง ' + dayOf_(o.createdAt) + '\nยอด ' + o.total + ' บาท' + (o.voidReason ? '\nเหตุผล: ' + o.voidReason : '');
}

function tgSend_(text) {
  var token = prop_('TELEGRAM_TOKEN'), chat = prop_('TELEGRAM_CHAT');
  if (!token || !chat) return { ok: false, error: 'NO_TELEGRAM' };
  try {
    var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', payload: { chat_id: chat, text: text, disable_web_page_preview: 'true' }, muteHttpExceptions: true
    });
    var j = JSON.parse(r.getContentText() || '{}');
    return j.ok ? { ok: true } : { ok: false, error: String(j.description || r.getResponseCode()) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function notify_(id, text) {
  var s = sheet_('POS_Notify', NOTIFY_HEAD);
  var ids = col_(s, 1).map(String);
  if (ids.indexOf(id) >= 0) return;
  var hasTg = !!prop_('TELEGRAM_TOKEN') && !!prop_('TELEGRAM_CHAT');
  s.appendRow([id, text, hasTg ? 'pending' : 'off', 0, hasTg ? '' : 'NO_TELEGRAM', new Date().toISOString()]);
  if (hasTg) flushNotify_(s.getLastRow());
}
function flushNotify_(onlyRow) {
  var s = sheet_('POS_Notify', NOTIFY_HEAD);
  var lr = s.getLastRow();
  if (lr < 2) return;
  var start = onlyRow || 2, n = onlyRow ? 1 : lr - 1;
  var vals = s.getRange(start, 1, n, 6).getValues();
  vals.forEach(function (v, i) {
    if (v[2] !== 'pending' || num_(v[3]) >= 10) return;
    var r = tgSend_(String(v[1]));
    s.getRange(start + i, 3, 1, 3).setValues([[r.ok ? 'sent' : 'pending', num_(v[3]) + 1, r.ok ? '' : r.error]]);
  });
}
function pendingCount_() {
  var s = sheet_('POS_Notify', NOTIFY_HEAD);
  return col_(s, 3).filter(function (x) { return x === 'pending'; }).length;
}

/* ------------------------------------------------------------------ */
/* Daily summary                                                       */
/* ------------------------------------------------------------------ */
function summary_(date) {
  var list = loadOrders_().list;
  var s = { date: date, food: 0, bills: 0, dine: 0, take: 0, openToday: 0, openTodayCount: 0, cash: 0, qr: 0, received: 0, fromPrev: 0, openAll: 0, openAllCount: 0, voids: 0, top: [] };
  var qty = {};
  list.forEach(function (o) {
    var c = dayOf_(o.createdAt), d = dayOf_(o.paidAt);
    if (o.status === 'open') { s.openAll += o.total; s.openAllCount++; }
    if (c === date) {
      if (o.status === 'void') { s.voids++; return; }
      s.food += o.total; s.bills++;
      if (o.type === 'takeaway') s.take++; else s.dine++;
      if (o.status === 'open') { s.openToday += o.total; s.openTodayCount++; }
      o.items.forEach(function (l) { qty[l.name] = (qty[l.name] || 0) + num_(l.qty); });
    }
    if (o.status === 'paid' && d === date) {
      if (o.method === 'qr') s.qr += o.total; else s.cash += o.total;
      s.received += o.total;
      if (c < date) s.fromPrev += o.total;
    }
  });
  s.top = Object.keys(qty).map(function (k) { return { name: k, qty: qty[k] }; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, 5);
  s.text = summaryText_(s);
  return s;
}
function summaryText_(s) {
  var top = s.top.length ? s.top.map(function (t, i) { return (i + 1) + '. ' + t.name + ' (' + t.qty + ')'; }).join('\n') : 'ยังไม่มีรายการ';
  return '📊 สรุปยอดขายสิ้นวัน ' + s.date + '\n' + cfg_().label + '\n\n' +
    '💰 ยอดอาหาร: ' + s.food + ' บาท\n🧾 จำนวนบิล: ' + s.bills + ' (🍽️ ' + s.dine + ' / 🛍️ ' + s.take + ')\n' +
    '⏳ ค้างจ่ายของวันนี้: ' + s.openToday + '\n\n💵 เงินสดรับวันนี้: ' + s.cash + '\n📱 QR รับวันนี้: ' + s.qr + '\n' +
    '💳 รับเงินจริงรวม: ' + s.received + '\n↩️ ในนี้เป็นบิลวันก่อน: ' + s.fromPrev + '\n⏳ ค้างจ่ายสะสม: ' + s.openAll +
    (s.voids ? '\n❌ ยกเลิก: ' + s.voids + ' บิล' : '') + '\n\n🏆 ขายดี:\n' + top;
}
function sendSummary_(date, manual) {
  var s = summary_(date);
  var id = (manual ? 'manual:' + date + ':' + Date.now() : 'daily:' + date);
  notify_(id, s.text);
  return { summary: s };
}

/* ------------------------------------------------------------------ */
/* Triggers / setup (run from the editor)                              */
/* ------------------------------------------------------------------ */
function tick() {
  CTX = {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    flushNotify_();
    if (prop_('SUMMARY_AUTO', '0') !== '1') return;
    var now = new Date(), d = fmt_(now, 'yyyy-MM-dd'), hm = fmt_(now, 'HHmm');
    if (hm >= '2030' && prop_('LAST_SUMMARY', '') !== d) {
      sendSummary_(d, false);
      P_().setProperty('LAST_SUMMARY', d);
    }
  } finally { lock.releaseLock(); }
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
}

function setupSheets_() {
  sheet_('POS_Meta', META_HEAD);
  sheet_('POS_Ops', OPS_HEAD);
  sheet_('POS_Notify', NOTIFY_HEAD);
}

/** รันครั้งแรกจาก editor: สร้างรหัสเครื่อง + ชีทระบบ แล้วดูรหัสใน Execution log */
function setup() {
  CTX = {};
  var P = P_();
  if (!prop_('SALT')) P.setProperty('SALT', Utilities.getUuid().slice(0, 8));
  if (!prop_('MODE')) P.setProperty('MODE', 'test');
  ['CODE_CASHIER', 'CODE_MANAGER', 'CODE_VIEWER'].forEach(function (k) {
    if (!prop_(k)) P.setProperty(k, BRANCH.key.slice(0, 2).toUpperCase() + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase());
  });
  setupSheets_();
  installTriggers();
  Logger.log('สาขา: %s | โหมด: %s | Sheet: %s', BRANCH.name, cfg_().mode, cfg_().sheetId);
  Logger.log('รหัสแคชเชียร์: %s', prop_('CODE_CASHIER'));
  Logger.log('รหัสผู้จัดการ: %s', prop_('CODE_MANAGER'));
  Logger.log('รหัสดูอย่างเดียว: %s', prop_('CODE_VIEWER'));
}

/** ทดสอบระบบจริงบนชีททดสอบ (รันจาก editor เท่านั้น; ใช้ได้เฉพาะโหมด test) */
function selfTest() {
  if (cfg_().mode !== 'test') throw new Error('selfTest ใช้ได้เฉพาะโหมดทดสอบ');
  var code = prop_('CODE_CASHIER'), mgr = prop_('CODE_MANAGER');
  function call(b) { CTX = {}; var r = JSON.parse(doPost({ postData: { contents: JSON.stringify(b) } }).getContent()); Logger.log('%s → %s', b.action, JSON.stringify(r).slice(0, 300)); return r; }
  var menu = loadMenu_(), m = menu.menuItems.filter(function (x) { return !(x.groups || []).length; })[0];
  var id = 'zz' + Date.now().toString(36) + 'tst';
  var a = call({ action: 'saveOrder', code: code, opId: id + 'a', baseRevision: 0, order: { id: id, type: 'dinein', table: '99', items: [{ lineId: 'l1', menuId: m.id, qty: 2, selected: [] }] } });
  if (!a.ok) throw new Error('save failed');
  var b = call({ action: 'pay', code: code, opId: id + 'b', baseRevision: a.order.revision, method: 'cash', received: 1000, order: { id: id, type: 'dinein', table: '99', items: [{ lineId: 'l1', menuId: m.id, qty: 2, selected: [] }] } });
  if (!b.ok || b.order.status !== 'paid') throw new Error('pay failed');
  var c = call({ action: 'void', code: mgr, opId: id + 'c', id: id, reason: 'selfTest' });
  if (!c.ok || c.order.status !== 'void') throw new Error('void failed');
  var g = call({ action: 'getAll', code: code });
  Logger.log('SELFTEST OK — orders loaded: %s, menu items: %s', g.orders.length, g.menu.menuItems.length);
}
