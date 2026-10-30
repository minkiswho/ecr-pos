/* ECR POS R1 — frontend (Rocky). One app, branch config from window.ECR */
(function () {
  'use strict';
  var CFG = window.ECR;
  var VERSION = 'R1.5';
  var KEY = 'ecr_' + CFG.branch + '_';
  var POLL_MS = 15000, IDLE_LOCK_MS = 5 * 60000;

  /* ---------------- storage ---------------- */
  function load(k, d) { try { var v = localStorage.getItem(KEY + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch (e) { toast('บันทึกในเครื่องไม่สำเร็จ (พื้นที่เต็ม?)', 'err'); return false; } }
  function drop(k) { try { localStorage.removeItem(KEY + k); } catch (e) { } }

  var S = {
    auth: load('auth', null),
    menu: load('menu', null),
    orders: load('orders', {}),
    outbox: load('outbox', []),
    review: load('review', []),
    images: load('images', {}),
    prefs: load('prefs', { paper: 80, autoPrint: true }),
    cur: load('draft', null),
    view: 'tables', cat: 'all', locked: false, lockFails: 0, lockUntil: 0,
    lastSync: 0, sync: 'idle', syncErr: '', billsDate: '', summaryDate: '', remoteBills: null,
    mgrSession: false, adminStatus: null, menuDraft: null, pay: null, busy: false
  };

  /* ---------------- utils ---------------- */
  var $app = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function opid() { return (crypto.randomUUID ? crypto.randomUUID() : uid() + uid()); }
  function money(n) { return Number(n || 0).toLocaleString('th-TH'); }
  function code(id) { return String(id || '').slice(-4).toUpperCase(); }
  var dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  var tfmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });
  function day(iso) { return iso ? dfmt.format(new Date(iso)) : ''; }
  function hm(iso) { return iso ? tfmt.format(new Date(iso)) : ''; }
  function today() { return day(new Date().toISOString()); }
  function mins(iso) { return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); }
  function ago(iso) { const m = mins(iso); return m < 60 ? m + ' นาที' : m < 1440 ? Math.floor(m / 60) + ' ชม.' : Math.floor(m / 1440) + ' วัน'; }
  function role() { return S.auth && S.auth.role; }
  function canWrite() { return role() === 'cashier' || role() === 'manager'; }
  function isMgr() { return role() === 'manager' || S.mgrSession; }
  async function sha(s) {
    var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function persistOrders() {
    var keep = {}, cutoff = Date.now() - 4 * 86400000;
    Object.keys(S.orders).forEach(function (id) {
      var o = S.orders[id];
      if (o.status === 'open' || pendingFor(id) || new Date(o.updatedAt || o.createdAt).getTime() > cutoff) keep[id] = o;
    });
    S.orders = keep;
    save('orders', keep);
  }
  function pendingFor(id) { return S.outbox.some(function (o) { return o.orderId === id; }); }

  /* ---------------- toast / modal ---------------- */
  var toastTimer;
  function toast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.className = 'toast show ' + (kind || '');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, kind === 'err' ? 4500 : 2200);
  }
  var modalResolve = null;
  function modal(html, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      closeModal(null);
      var m = document.createElement('div');
      m.className = 'modal-bg';
      m.innerHTML = '<div class="modal ' + (opts.cls || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
      document.body.appendChild(m);
      modalResolve = resolve;
      m.addEventListener('click', function (e) {
        if (e.target === m && !opts.sticky) closeModal(null);
        var b = e.target.closest('[data-m]');
        if (b) {
          var v = b.getAttribute('data-m');
          if (opts.onAction) { var r = opts.onAction(v, m); if (r === false) return; }
          closeModal(v, m);
        }
      });
      if (opts.onOpen) opts.onOpen(m);
      var f = m.querySelector('[autofocus]'); if (f) setTimeout(function () { f.focus(); }, 50);
    });
  }
  function closeModal(v, m) {
    var bg = m || document.querySelector('.modal-bg');
    var data = null;
    if (bg && v != null) { data = {}; bg.querySelectorAll('[name]').forEach(function (i) { data[i.name] = i.type === 'checkbox' ? i.checked : i.value; }); }
    if (bg) bg.remove();
    if (modalResolve) { var r = modalResolve; modalResolve = null; r(v == null ? null : { act: v, data: data }); }
  }
  async function confirmBox(title, body, okLabel, danger) {
    var r = await modal('<h3>' + esc(title) + '</h3>' + (body ? '<p class="muted">' + body + '</p>' : '') +
      '<div class="row gap"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn grow ' + (danger ? 'danger' : 'primary') + '" data-m="yes">' + esc(okLabel || 'ตกลง') + '</button></div>');
    return r && r.act === 'yes';
  }
  async function askText(title, label, value, type) {
    var r = await modal('<h3>' + esc(title) + '</h3><label class="fld"><span>' + esc(label) + '</span><input name="v" ' + (type ? 'inputmode="' + type + '"' : '') + ' value="' + esc(value || '') + '" autofocus></label>' +
      '<div class="row gap"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">ตกลง</button></div>');
    return r && r.act === 'ok' ? String(r.data.v || '').trim() : null;
  }

  /** ask manager PIN, verify online; returns pin (or '' when logged in as manager) or null */
  async function managerPin(reason) {
    if (role() === 'manager') return '';
    var r = await modal('<h3>ต้องให้ผู้จัดการอนุมัติ</h3><p class="muted">' + esc(reason) + '</p><label class="fld"><span>PIN ผู้จัดการ</span><input name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus></label>' +
      '<div class="row gap"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">อนุมัติ</button></div>');
    if (!r || r.act !== 'ok' || !r.data.pin) return null;
    try { await rpc('checkPin', { managerPin: r.data.pin }); return r.data.pin; }
    catch (e) {
      if (e.code === 'NO_PIN') await modal('<h3>ยังไม่ได้ตั้ง PIN ผู้จัดการ</h3><p class="muted">ตั้งครั้งแรกได้ดังนี้: ตั้งค่า → ออกจากระบบ → เข้าด้วย<b>รหัสผู้จัดการ</b> → ตั้งค่า → ตั้ง PIN ผู้จัดการ แล้วค่อยเข้าด้วยรหัสแคชเชียร์ตามเดิม</p><button class="btn primary" data-m="ok">เข้าใจแล้ว</button>');
      else toast(e.message, 'err');
      return null;
    }
  }

  /* ---------------- API ---------------- */
  async function rpc(action, payload, codeOverride) {
    var body = Object.assign({ action: action, code: codeOverride || (S.auth && S.auth.code) }, payload || {});
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 45000);
    var res;
    try {
      res = await fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
      var ne = new Error(e.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ' : 'เชื่อมต่อไม่ได้ (ออฟไลน์?)'); ne.code = 'NETWORK'; throw ne;
    } finally { clearTimeout(t); }
    var j;
    try { j = await res.json(); } catch (e) { var pe = new Error('ระบบกลางตอบกลับผิดรูปแบบ (' + res.status + ')'); pe.code = 'NETWORK'; throw pe; }
    if (!j.ok) { var er = new Error(j.message || j.error); er.code = j.error; er.data = j.data; throw er; }
    return j;
  }
  var TRANSIENT = { NETWORK: 1, BUSY: 1, ERROR: 1 };

  /* ---------------- sync engine ---------------- */
  var flushing = null, backoff = 0, nextTry = 0;
  function queue(action, orderId, payload) {
    S.outbox.push({ opId: opid(), action: action, orderId: orderId, payload: payload, at: new Date().toISOString(), tries: 0, err: '' });
    save('outbox', S.outbox);
    persistOrders();
    renderStatus();
    flush();
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async function () {
      while (S.outbox.length && navigator.onLine !== false) {
        if (Date.now() < nextTry) break;
        var op = S.outbox[0];
        var o = S.orders[op.orderId];
        var body = Object.assign({ opId: op.opId }, op.payload, { baseRevision: o ? (o.revision || 0) : 0 });
        S.sync = 'syncing'; renderStatus();
        try {
          var r = await rpc(op.action, body);
          S.outbox.shift();
          applyAck(r.order, op.orderId);
          backoff = 0; S.syncErr = '';
        } catch (e) {
          op.tries++; op.err = e.message;
          if (e.code === 'AUTH') { S.sync = 'error'; S.syncErr = e.message; save('outbox', S.outbox); renderStatus(); break; }
          if (TRANSIENT[e.code]) {
            backoff = Math.min(backoff ? backoff * 2 : 3000, 60000); nextTry = Date.now() + backoff;
            S.sync = 'error'; S.syncErr = e.message; save('outbox', S.outbox); renderStatus();
            setTimeout(flush, backoff + 100);
            break;
          }
          // business rejection: park for review, keep server truth
          S.outbox.shift();
          S.review.push({ op: op, error: e.code, message: e.message, at: new Date().toISOString() });
          save('review', S.review);
          if (e.data && e.data.order && e.data.order.id === op.orderId) S.orders[op.orderId] = e.data.order;
          toast('ส่งไม่สำเร็จ: ' + e.message, 'err');
        }
        save('outbox', S.outbox);
        persistOrders();
      }
      if (!S.outbox.length && S.sync !== 'error') S.sync = 'idle';
      flushing = null;
      renderStatus();
      if (S.view !== 'order' && S.view !== 'pay') render();
    })();
    return flushing;
  }
  function applyAck(server, id) {
    if (!server) return;
    var more = S.outbox.some(function (o) { return o.orderId === id; });
    var local = S.orders[id];
    if (more && local) {
      local.revision = server.revision; local.createdAt = server.createdAt; local.name = server.name;
    } else S.orders[id] = server;
  }
  async function pull() {
    if (!S.auth || S.locked) return;
    if (S.outbox.length) await flush();
    if (S.outbox.length) return;
    try {
      var r = await rpc('getAll', {});
      var next = {};
      r.orders.forEach(function (o) { next[o.id] = o; });
      Object.keys(S.orders).forEach(function (id) { if (!next[id] && pendingFor(id)) next[id] = S.orders[id]; });
      S.orders = next;
      if (r.menu) { S.menu = r.menu; save('menu', r.menu); }
      if (r.imagesVer && r.imagesVer !== load('imagesVer', '')) { await loadImages(true); save('imagesVer', r.imagesVer); }
      if (r.mode && S.auth.mode !== r.mode) { S.auth.mode = r.mode; save('auth', S.auth); }
      persistOrders();
      S.lastSync = Date.now(); S.sync = 'idle'; S.syncErr = '';
    } catch (e) {
      S.sync = 'error'; S.syncErr = e.message;
      if (e.code === 'AUTH') toast('รหัสเครื่องใช้ไม่ได้แล้ว กรุณาเข้าสู่ระบบใหม่', 'err');
    }
    renderStatus();
    if (S.view !== 'order' && S.view !== 'pay' && !document.querySelector('.modal-bg')) render();
  }
  async function loadImages(force) {
    if (!force && Object.keys(S.images).length) return;
    try { var r = await rpc('getImages', {}); S.images = r.images || {}; save('images', S.images); if (S.view !== 'order' && S.view !== 'pay') render(); } catch (e) { }
  }

  /* ---------------- app lock ---------------- */
  var lastAct = Date.now();
  function lockNow() { if (S.auth && S.auth.lockHash) { S.locked = true; render(); } }
  ['pointerdown', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { lastAct = Date.now(); }, true); });
  setInterval(function () { if (!S.locked && S.auth && S.auth.lockHash && Date.now() - lastAct > IDLE_LOCK_MS && !document.querySelector('.modal-bg')) lockNow(); }, 15000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { if (S.view !== 'pay') lockNow(); }
    else { pull(); if (window.ECRPrinter) ECRPrinter.reconnect().then(renderStatus); }
  });
  window.addEventListener('online', function () { nextTry = 0; flush(); pull(); });

  /* ---------------- auto update: reload when a new version is published ---------------- */
  var updWanted = false;
  async function checkUpdate() {
    try {
      var r = await fetch('../version.json?x=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      var j = await r.json();
      if (j && j.v && j.v !== VERSION) { updWanted = j.v; tryReload(); }
    } catch (e) { /* offline: try later */ }
  }
  function tryReload() {
    if (!updWanted || S.outbox.length || document.querySelector('.modal-bg')) return;
    if (S.auth && ['tables', 'bills', 'summary', 'settings'].indexOf(S.view) < 0) return; // never mid-order / pay / menu edit
    var key = 'ecr_reload_' + updWanted, last = 0;
    try { last = Number(localStorage.getItem(key) || 0); } catch (e) {}
    if (Date.now() - last < 15 * 60000) return; // one attempt per version per 15 min (avoids loops if a stale copy is cached)
    try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
    location.reload();
  }
  setTimeout(checkUpdate, 5000);
  setInterval(checkUpdate, 120000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkUpdate(); });

  /* ---------------- pricing (local mirror of server rules) ---------------- */
  function menuItem(id) { return (S.menu && S.menu.menuItems || []).filter(function (m) { return m.id === id; })[0]; }
  function group(id) { return (S.menu && S.menu.optionGroups || []).filter(function (g) { return g.id === id; })[0]; }
  function lineUnit(l) {
    if (l.priceOverride != null && l.priceOverride !== '') return Number(l.priceOverride);
    if (l.saved) return Number(l.unit);
    var m = menuItem(l.menuId);
    var base = m ? Number(m.price) : Number(l.base || 0);
    return base + (l.selected || []).reduce(function (a, s) { return a + Number(s.price || 0); }, 0);
  }
  function curTotal(c) { return (c || S.cur).items.reduce(function (a, l) { return a + lineUnit(l) * l.qty; }, 0); }
  function optText(l) { return (l.selected || []).map(function (s) { return s.name; }).join('/'); }

  /* ---------------- order editing ---------------- */
  function startOrder(o, extra) {
    if (o) {
      S.cur = {
        id: o.id, type: o.type, table: o.table, name: o.name, createdAt: o.createdAt, isNew: false, dirty: false,
        items: o.items.map(function (l) { return Object.assign({}, l, { saved: true, savedQty: l.qty }); })
      };
    } else {
      S.cur = Object.assign({ id: uid(), type: 'dinein', table: '', name: '', createdAt: new Date().toISOString(), isNew: true, dirty: false, items: [] }, extra || {});
    }
    save('draft', S.cur);
    S.cat = 'all'; S.view = 'order'; render();
  }
  function touchCur() { S.cur.dirty = true; save('draft', S.cur); }
  async function leaveOrder() {
    if (S.cur && S.cur.dirty && S.cur.items.length && S.cur.type !== 'lineman') {
      if (!await confirmBox('ยังไม่ได้บันทึก', 'รายการที่เพิ่ม/แก้ จะหายไป', 'ทิ้งการแก้ไข', true)) return;
    }
    S.cur = null; drop('draft'); S.view = 'tables'; render();
  }
  function needsApproval(c) {
    return c.items.some(function (l) { return l.saved && l.qty < l.savedQty; }) ||
      (!c.isNew && S.orders[c.id] && S.orders[c.id].items.some(function (sl) { return !c.items.some(function (l) { return l.lineId === sl.lineId; }); })) ||
      c.items.some(function (l) { return l.priceOverride != null && l.priceOverride !== '' && Number(l.priceOverride) !== Number(l.saved ? l.unit : lineUnit(Object.assign({}, l, { priceOverride: null }))); });
  }
  function orderPayload(c) {
    return {
      id: c.id, type: c.type, table: c.table, name: c.name, createdAt: c.createdAt,
      items: c.items.map(function (l) {
        var x = { lineId: l.lineId, menuId: l.menuId, name: l.name, qty: l.qty, selected: l.selected || [], note: l.note || '' };
        if (l.priceOverride != null && l.priceOverride !== '') x.priceOverride = Number(l.priceOverride);
        return x;
      })
    };
  }
  function localOrder(c, status) {
    var prev = S.orders[c.id] || {};
    var items = c.items.map(function (l) {
      var u = lineUnit(l);
      return { lineId: l.lineId, menuId: l.menuId, name: l.name, base: l.base, qty: l.qty, selected: l.selected || [], note: l.note || '', unit: u, total: u * l.qty };
    });
    return Object.assign({}, prev, {
      id: c.id, type: c.type, table: c.table, name: c.name || prev.name || '', items: items, createdAt: prev.createdAt || c.createdAt,
      total: items.reduce(function (a, l) { return a + l.total; }, 0), status: status, updatedAt: new Date().toISOString(), revision: prev.revision || 0
    });
  }
  async function saveCur() {
    var c = S.cur;
    if (!c.items.length) return toast('ยังไม่มีรายการอาหาร', 'err');
    if (c.type === 'dinein' && !c.table) return toast('ยังไม่ได้เลือกโต๊ะ', 'err');
    if (c.type === 'dinein') {
      var busy = Object.values(S.orders).filter(function (o) { return o.status === 'open' && o.type === 'dinein' && o.table === c.table && o.id !== c.id; })[0];
      if (busy) return toast('โต๊ะ ' + c.table + ' มีบิลค้างอยู่แล้ว (#' + code(busy.id) + ')', 'err');
    }
    var payload = { order: orderPayload(c) };
    if (needsApproval(c)) { var pin = await managerPin('ลด/ลบรายการที่บันทึกแล้ว หรือแก้ราคา'); if (pin == null) return; payload.managerPin = pin; }
    S.orders[c.id] = localOrder(c, 'open');
    queue('saveOrder', c.id, payload);
    toast('บันทึกลงโต๊ะแล้ว');
    S.cur = null; drop('draft'); S.view = 'tables'; render();
  }
  async function goPay() {
    var c = S.cur;
    if (!c.items.length) return toast('ยังไม่มีรายการอาหาร', 'err');
    if (c.type === 'dinein' && !c.table) return toast('ยังไม่ได้เลือกโต๊ะ', 'err');
    var pin;
    if (needsApproval(c)) { pin = await managerPin('ลด/ลบรายการที่บันทึกแล้ว หรือแก้ราคา'); if (pin == null) return; }
    S.pay = { method: 'cash', received: '', pin: pin, print: S.prefs.autoPrint };
    S.view = 'pay'; render();
  }
  async function confirmPay() {
    var c = S.cur, total = curTotal(c), p = S.pay;
    var received = p.method === 'qr' ? total : Number(p.received || 0);
    if (p.method === 'cash' && received < total) return toast('รับเงินน้อยกว่ายอด', 'err');
    var o = localOrder(c, 'paid');
    o.method = p.method; o.received = received; o.change = received - total; o.paidAt = new Date().toISOString();
    S.orders[c.id] = o;
    var payload = { order: orderPayload(c), method: p.method, received: received, paidAt: o.paidAt };
    if (p.pin) payload.managerPin = p.pin;
    queue('pay', c.id, payload);
    S.cur = null; drop('draft'); S.pay = null; S.view = 'tables'; render();
    toast('รับเงินแล้ว ฿' + money(total) + (o.change ? ' · ทอน ฿' + money(o.change) : ''));
    if (p.print) printOrder(o, 'receipt');
  }
  async function voidOrder(o) {
    var reason = await askText('ยกเลิกบิล #' + code(o.id), 'เหตุผล (ไม่บังคับ)', '');
    if (reason == null) return;
    var pin = await managerPin('ยกเลิกบิล #' + code(o.id) + ' ยอด ฿' + money(o.total));
    if (pin == null) return;
    S.orders[o.id] = Object.assign({}, o, { status: 'void', voidedAt: new Date().toISOString() });
    queue('void', o.id, { id: o.id, managerPin: pin, reason: reason });
    toast('ยกเลิกบิลแล้ว');
    render();
  }

  /* ---------------- printing ---------------- */
  function receiptDoc(o, kind) {
    var st = (S.menu && S.menu.settings) || {};
    var doc = [];
    if (S.images.logo && kind !== 'label') {
      var img = new Image(); img.src = S.images.logo;
      if (img.complete && img.width) doc.push({ t: 'img', img: img, w: 200 });
    }
    if (kind === 'label') doc.push({ t: 'text', s: 'LINE MAN', size: 44, bold: true, align: 'center' });
    doc.push({ t: 'text', s: 'ข้าวมันไก่เอกมัย', size: 32, bold: true, align: 'center' });
    doc.push({ t: 'text', s: 'สาขา' + CFG.name, size: 24, align: 'center' });
    if (kind === 'invoice') doc.push({ t: 'text', s: 'ใบแจ้งยอด (ยังไม่ชำระ)', size: 26, bold: true, align: 'center' });
    doc.push({ t: 'hr' });
    var where = o.type === 'dinein' ? 'โต๊ะ ' + o.table : (kind === 'label' ? 'LINE MAN' : 'Take Away ' + (o.name || ''));
    doc.push({ t: 'text', s: (kind === 'label' ? '' : 'บิล #' + code(o.id) + '  ') + where, size: 26, bold: true });
    var when = o.paidAt || o.createdAt || new Date().toISOString();
    doc.push({ t: 'text', s: day(when) + ' ' + hm(when), size: 22 });
    doc.push({ t: 'hr' });
    o.items.forEach(function (l) {
      doc.push({ t: 'text', s: l.qty + 'x ' + l.name, size: 26, bold: kind === 'label', right: kind === 'label' ? '' : money(l.total) });
      var ot = optText(l); if (ot) doc.push({ t: 'text', s: '   ' + ot, size: 22 });
      if (l.note) doc.push({ t: 'text', s: '   * ' + l.note, size: 22 });
    });
    if (kind !== 'label') {
      doc.push({ t: 'hr' });
      doc.push({ t: 'text', s: 'รวม', size: 30, bold: true, right: '฿' + money(o.total) });
      if (kind === 'receipt') {
        doc.push({ t: 'text', s: o.method === 'qr' ? 'ชำระ QR' : 'เงินสด', size: 24, right: money(o.received) });
        if (o.method !== 'qr') doc.push({ t: 'text', s: 'เงินทอน', size: 24, right: money(o.change) });
      }
      doc.push({ t: 'gap', h: 10 });
      doc.push({ t: 'text', s: st.receiptFooter || 'ขอบคุณที่ใช้บริการค่ะ', size: 24, align: 'center' });
    }
    return doc;
  }
  async function printLabel(no) {
    if (!window.ECRPrinter) return;
    var now = new Date().toISOString();
    var doc = [
      { t: 'text', s: 'LINE MAN', size: 40, bold: true, align: 'center' },
      { t: 'hr' },
      { t: 'text', s: no, size: 64, bold: true, align: 'center' },
      { t: 'hr' },
      { t: 'text', s: 'ข้าวมันไก่เอกมัย · สาขา' + CFG.name, size: 24, align: 'center' },
      { t: 'text', s: day(now) + ' ' + hm(now), size: 22, align: 'center' }
    ];
    try { await ECRPrinter.printCanvas(ECRPrinter.render(doc, Number(S.prefs.paper) || 80)); toast('พิมพ์ฉลาก ' + no + ' แล้ว'); }
    catch (e) { toast('พิมพ์ไม่สำเร็จ: ' + e.message, 'err'); }
    renderStatus();
  }
  async function printOrder(o, kind) {
    if (!window.ECRPrinter) return;
    try {
      var canvas = ECRPrinter.render(receiptDoc(o, kind), Number(S.prefs.paper) || 80);
      await ECRPrinter.printCanvas(canvas);
      toast('พิมพ์แล้ว');
    } catch (e) { toast('พิมพ์ไม่สำเร็จ: ' + e.message, 'err'); }
    renderStatus();
  }

  /* ---------------- rendering ---------------- */
  function statusHtml() {
    var n = S.outbox.length, rv = S.review.length, cls, txt;
    if (S.sync === 'error') { cls = 'bad'; txt = (navigator.onLine === false ? 'ออฟไลน์' : 'เชื่อมต่อไม่ได้') + (n ? ' · รอส่ง ' + n : ''); }
    else if (n || S.sync === 'syncing') { cls = 'warn'; txt = 'กำลังส่ง ' + n + ' รายการ'; }
    else if (S.lastSync && Date.now() - S.lastSync < 90000) { cls = 'ok'; txt = 'ซิงก์แล้ว ' + hm(new Date(S.lastSync).toISOString()); }
    else { cls = 'warn'; txt = 'กำลังเชื่อมต่อ…'; }
    var pr = window.ECRPrinter ? ECRPrinter.status() : { connected: false };
    return '<button class="pill ' + cls + '" data-a="sync-detail"><span class="dot"></span>' + esc(txt) + '</button>' +
      (rv ? '<button class="pill bad" data-a="review">ต้องตรวจ ' + rv + '</button>' : '') +
      (S.auth && S.auth.mode === 'test' ? '<span class="pill test">โหมดทดสอบ</span>' : '') +
      '<span class="pill ' + (pr.connected ? 'ok' : 'off') + '" title="เครื่องพิมพ์"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg>' + (pr.connected ? '' : ' ไม่ต่อ') + '</span>';
  }
  function renderStatus() { var el = document.getElementById('status'); if (el) el.innerHTML = statusHtml(); }

  function header(title, back, right) {
    return '<header class="top">' + (back ? '<button class="icon" data-a="' + back + '" aria-label="กลับ"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg></button>' :
      '<div class="brand"><b>ecr</b><i></i><span>' + esc(CFG.name) + '</span></div>') +
      (title ? '<div class="ttl">' + title + '</div>' : '') + '<div class="sp"></div>' + (right || '') + '</header>' +
      '<div class="status" id="status">' + statusHtml() + '</div>';
  }
  function nav() {
    var tabs = [['tables', 'โต๊ะ'], ['bills', 'บิล'], ['summary', 'สรุป'], ['settings', 'ตั้งค่า']];
    return '<nav class="tabs">' + tabs.map(function (t) { return '<button class="' + (S.view === t[0] ? 'on' : '') + '" data-a="view" data-v="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</nav>';
  }

  function render() {
    if (!S.auth) return renderLogin();
    if (S.locked) return renderLock();
    var fn = { tables: renderTables, order: renderOrder, pay: renderPay, bills: renderBills, summary: renderSummary, settings: renderSettings, menuedit: renderMenuEdit }[S.view] || renderTables;
    if ((S.view === 'order' || S.view === 'pay') && !S.cur) S.view = 'tables', fn = renderTables;
    $app.innerHTML = fn();
  }

  function renderLogin() {
    $app.innerHTML = '<div class="login">' +
      '<div class="logo"><div class="mark"><b>ecr</b><i></i></div><span>' + esc(CFG.branch) + '</span></div>' +
      '<h1>ECR POS · ' + esc(CFG.name) + '</h1><p class="muted">ข้าวมันไก่เอกมัย</p>' +
      '<form class="card" data-f="login"><label class="fld"><span>รหัสเครื่อง</span><input name="code" autocomplete="off" autocapitalize="characters" required placeholder="เช่น ' + esc(CFG.branch.slice(0, 2).toUpperCase()) + '-XXXXXXXX"></label>' +
      '<button class="btn primary big" type="submit">เข้าสู่ระบบ</button></form>' +
      '<p class="note">ลิงก์นี้ใช้กับสาขา' + esc(CFG.name) + 'เท่านั้น รหัสของอีกสาขาจะเข้าไม่ได้</p>' +
      '<p class="ver">' + VERSION + '</p></div>';
  }
  function renderLock() {
    var cool = S.lockUntil > Date.now();
    $app.innerHTML = '<div class="login lock"><div class="logo"><div class="mark"><b>ecr</b><i></i></div><span>' + esc(CFG.branch) + '</span></div>' +
      '<h2>ปลดล็อกแอป</h2><p class="muted">' + (cool ? 'ใส่ผิดหลายครั้ง รอสักครู่' : 'ใส่ PIN ล็อกแอปของสาขา') + '</p>' +
      '<div class="pinview" id="pinview"></div><div class="pad">' +
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, 'OK'].map(function (k) { return '<button data-a="pin" data-v="' + k + '"' + (cool ? ' disabled' : '') + '>' + k + '</button>'; }).join('') +
      '</div></div>';
    pinBuf = ''; drawPin();
  }
  var pinBuf = '';
  function drawPin() { var el = document.getElementById('pinview'); if (el) el.innerHTML = pinBuf.split('').map(function () { return '<i></i>'; }).join('') || '<span class="muted">••••</span>'; }

  function tableList() {
    var st = (S.menu && S.menu.settings) || {};
    var count = Number(st.tableCount || CFG.tables || 5);
    var open = Object.values(S.orders).filter(function (o) { return o.status === 'open'; });
    var maxT = open.reduce(function (m, o) { return o.type === 'dinein' && isFinite(Number(o.table)) ? Math.max(m, Number(o.table)) : m; }, 0);
    var nums = [];
    for (var i = 1; i <= Math.max(count, maxT); i++) nums.push(String(i));
    open.forEach(function (o) { if (o.type === 'dinein' && nums.indexOf(o.table) < 0) nums.push(o.table); });
    return { nums: nums, open: open };
  }
  function renderTables() {
    var tl = tableList(), w = canWrite();
    var byTable = {};
    tl.open.forEach(function (o) { if (o.type === 'dinein') byTable[o.table] = o; });
    var takeOpen = tl.open.filter(function (o) { return o.type === 'takeaway'; });
    var openSum = tl.open.reduce(function (a, o) { return a + o.total; }, 0);
    var t = today(), paidToday = Object.values(S.orders).filter(function (o) { return o.status === 'paid' && day(o.paidAt) === t; });
    var rec = paidToday.reduce(function (a, o) { return a + o.total; }, 0);
    var tiles = tl.nums.map(function (n) {
      var o = byTable[n];
      if (o) return '<button class="tile open" data-a="open-order" data-id="' + o.id + '"><b>โต๊ะ ' + esc(n) + '</b><span><em>฿' + money(o.total) + '</em><small>ค้างจ่าย · ' + ago(o.createdAt) + (pendingFor(o.id) ? ' · รอส่ง' : '') + '</small></span></button>';
      return '<button class="tile" data-a="new-table" data-v="' + esc(n) + '"' + (w ? '' : ' disabled') + '><b>โต๊ะ ' + esc(n) + '</b><small>ว่าง</small></button>';
    }).join('');
    var takeTiles = takeOpen.map(function (o) {
      return '<button class="tile open" data-a="open-order" data-id="' + o.id + '"><b>' + esc(o.name || 'Take Away') + '</b><span><em>฿' + money(o.total) + '</em><small>Take Away · ' + ago(o.createdAt) + '</small></span></button>';
    }).join('');
    return header('', '', '') +
      '<main class="pad-b">' +
      '<section class="grid3">' + tiles + (w ? '<button class="tile add" data-a="add-table">+ เพิ่มโต๊ะ</button>' : '') + '</section>' +
      (takeTiles ? '<h4 class="sec">Take Away ค้างจ่าย</h4><section class="grid3">' + takeTiles + '</section>' : '') +
      (w ? '<section class="grid2 mt"><button class="btn primary big" data-a="new-take">Take Away</button><button class="btn outline big" data-a="new-lineman"><span>LINE MAN</span><small>พิมพ์ฉลากเท่านั้น</small></button></section>' : '<p class="note">บัญชีนี้ดูข้อมูลอย่างเดียว</p>') +
      '</main>' +
      '<footer class="sumbar"><div><small>รับเงินวันนี้</small><b>฿' + money(rec) + '</b></div><div><small>บิลชำระ</small><b>' + paidToday.length + '</b></div><div><small>ค้างจ่าย</small><b class="pink">฿' + money(openSum) + '</b></div></footer>' + nav();
  }

  function renderOrder() {
    var c = S.cur, menu = S.menu || { categories: [], menuItems: [] };
    var title = c.type === 'dinein' ? 'โต๊ะ ' + esc(c.table) : c.type === 'lineman' ? 'LINE MAN (ฉลาก)' : 'Take Away' + (c.name ? ' ' + esc(c.name) : '');
    var sub = c.isNew ? 'บิลใหม่' : 'บิล #' + code(c.id) + ' · เปิด ' + hm(c.createdAt);
    var cats = [{ id: 'all', name: 'ทั้งหมด' }].concat((menu.categories || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }));
    var items = (menu.menuItems || []).filter(function (m) { return m.available !== false && (S.cat === 'all' || m.catId === S.cat); });
    var w = canWrite();
    var right = !c.isNew && c.type !== 'lineman' ? '<button class="icon" data-a="order-more" aria-label="เพิ่มเติม"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>' : '';
    var total = curTotal(c);
    var lines = c.items.map(function (l, i) {
      var ot = optText(l);
      return '<div class="line"><button class="lname" data-a="line-edit" data-i="' + i + '"><span>' + esc(l.name) + (l.saved ? ' <em class="tag">บันทึกแล้ว</em>' : '') + '</span>' +
        (ot ? '<small>' + esc(ot) + '</small>' : '') + (l.note ? '<small>* ' + esc(l.note) + '</small>' : '') +
        (l.priceOverride != null && l.priceOverride !== '' ? '<small class="pink">ราคาพิเศษ ฿' + money(l.priceOverride) + '</small>' : '') + '</button>' +
        (w ? '<div class="qty"><button data-a="qty" data-i="' + i + '" data-v="-1" aria-label="ลด">−</button><b>' + l.qty + '</b><button data-a="qty" data-i="' + i + '" data-v="1" aria-label="เพิ่ม">+</button></div>' : '<b>' + l.qty + '</b>') +
        '<span class="amt">฿' + money(lineUnit(l) * l.qty) + '</span></div>';
    }).join('');
    var btns;
    if (!w) btns = '';
    else if (c.type === 'lineman') btns = '<button class="btn primary big grow" data-a="print-label">พิมพ์ฉลาก</button>';
    else if (c.type === 'takeaway' && !CFG.openTakeaway) btns = '<button class="btn primary big grow" data-a="go-pay">ชำระเงิน</button>';
    else btns = '<button class="btn outline big grow" data-a="save-order">บันทึก' + (c.type === 'dinein' ? 'ลงโต๊ะ' : '') + '</button><button class="btn primary big grow" data-a="go-pay">ชำระเงิน</button>';
    return header('<b>' + title + '</b><small>' + sub + '</small>', 'back-order', right) +
      '<div class="order">' +
      '<nav class="chips">' + cats.map(function (x) { return '<button class="' + (S.cat === x.id ? 'on' : '') + '" data-a="cat" data-v="' + esc(x.id) + '">' + esc(x.name) + '</button>'; }).join('') + '</nav>' +
      '<section class="menu">' + (items.length ? items.map(function (m) {
        var img = S.images[m.id];
        return '<button class="mi" data-a="add-item" data-id="' + esc(m.id) + '"' + (w ? '' : ' disabled') + '>' + (img ? '<img src="' + img + '" alt="">' : '') + '<span>' + esc(m.name) + '</span><b>฿' + money(m.price) + '</b></button>';
      }).join('') : '<p class="muted">ยังไม่มีเมนู — โหลดเมนูไม่สำเร็จหรือยังไม่ได้ตั้งค่า</p>') + '</section>' +
      '<section class="cart"><div class="cart-h"><b>รายการในบิล</b><small>' + c.items.length + ' รายการ</small></div>' +
      '<div class="lines">' + (lines || '<p class="muted center">แตะเมนูเพื่อเพิ่ม</p>') + '</div>' +
      '<div class="total"><span>รวม</span><b>฿' + money(total) + '</b></div><div class="row gap">' + btns + '</div></section></div>';
  }

  function renderPay() {
    var c = S.cur, p = S.pay, total = curTotal(c);
    var received = p.method === 'qr' ? total : Number(p.received || 0);
    var change = received - total;
    var quick = [total];
    [20, 50, 100, 500, 1000].forEach(function (b) { var v = Math.ceil(total / b) * b; if (v > total && quick.indexOf(v) < 0) quick.push(v); });
    quick = [quick[0]].concat(quick.slice(1).sort(function (a, b) { return a - b; })).slice(0, 4);
    var where = c.type === 'dinein' ? 'โต๊ะ ' + esc(c.table) : 'Take Away';
    return header('<b>รับชำระ · ' + where + '</b><small>' + (c.isNew ? 'บิลใหม่' : 'บิล #' + code(c.id)) + ' · ' + c.items.length + ' รายการ</small>', 'back-pay', '') +
      '<main class="pay"><div class="due"><small>ยอดที่ต้องชำระ</small><b>฿' + money(total) + '</b></div>' +
      '<div class="grid2"><button class="seg ' + (p.method === 'cash' ? 'on' : '') + '" data-a="pay-method" data-v="cash">เงินสด</button><button class="seg ' + (p.method === 'qr' ? 'on' : '') + '" data-a="pay-method" data-v="qr">QR พร้อมเพย์</button></div>' +
      (p.method === 'cash' ? '<div class="card"><label class="fld"><span>รับเงินมา</span><input id="recv" inputmode="numeric" value="' + esc(p.received) + '" placeholder="0" autocomplete="off"></label>' +
        '<div class="grid4">' + quick.map(function (v, i) { return '<button class="qbtn" data-a="quick" data-v="' + v + '">' + (i === 0 ? 'พอดี' : money(v)) + '</button>'; }).join('') + '</div>' +
        '<div class="change"><span>เงินทอน</span><b class="' + (change < 0 ? 'pink' : '') + '" id="chg">' + (p.received === '' ? '–' : '฿' + money(change)) + '</b></div></div>'
        : '<div class="card center">' + (S.images.qr ? '<img class="qr" src="' + S.images.qr + '" alt="QR รับเงิน">' : '<p class="muted">ยังไม่มีรูป QR (ตั้งค่าได้ในหน้าตั้งค่า)</p>') + '<p class="muted">ให้ลูกค้าสแกนแล้วตรวจยอดเข้าก่อนกดยืนยัน</p></div>') +
      '<label class="chk"><input type="checkbox" data-a="pay-print"' + (p.print ? ' checked' : '') + '> พิมพ์ใบเสร็จ</label>' +
      '<button class="btn primary big wide" data-a="confirm-pay">ยืนยันรับเงิน ฿' + money(total) + '</button></main>';
  }

  function billsFor(date) {
    var src = S.remoteBills && S.remoteBills.date === date ? S.remoteBills.orders : Object.values(S.orders);
    return src.filter(function (o) { return day(o.createdAt) === date || day(o.paidAt) === date; })
      .sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
  }
  function billRow(o) {
    var st = o.status === 'paid' ? '<span class="chip ok">' + (o.method === 'qr' ? 'QR' : 'เงินสด') + '</span>' : o.status === 'void' ? '<span class="chip off">ยกเลิก</span>' : '<span class="chip pink">ค้างจ่าย</span>';
    return '<button class="bill" data-a="bill" data-id="' + o.id + '"><b>#' + code(o.id) + '</b><span class="bi">' + (o.type === 'dinein' ? 'โต๊ะ ' + esc(o.table) : esc(o.name || 'Take Away')) +
      '<small>สั่ง ' + day(o.createdAt).slice(5) + ' ' + hm(o.createdAt) + (o.paidAt ? ' · จ่าย ' + day(o.paidAt).slice(5) + ' ' + hm(o.paidAt) : '') + (pendingFor(o.id) ? ' · รอส่ง' : '') + '</small></span>' + st + '<em>฿' + money(o.total) + '</em></button>';
  }
  function renderBills() {
    var d = S.billsDate || today();
    var list = billsFor(d);
    var older = Object.values(S.orders).filter(function (o) { return o.status === 'open' && day(o.createdAt) < d; });
    return header('', '', '') + '<main class="pad-b"><div class="daterow"><label class="fld"><span>วันที่</span><input type="date" data-a="bills-date" value="' + d + '"></label>' +
      '<button class="btn ghost" data-a="bills-reload">โหลด</button></div>' +
      (S.remoteBills && S.remoteBills.loading ? '<p class="muted">กำลังโหลด…</p>' : '') +
      '<div class="list">' + (list.length ? list.map(billRow).join('') : '<p class="muted center">ไม่มีบิลในวันนี้</p>') + '</div>' +
      (older.length ? '<h4 class="sec">ค้างจ่ายจากวันก่อน</h4><div class="list">' + older.map(billRow).join('') + '</div>' : '') +
      '</main>' + nav();
  }

  function localSummary(date) {
    var s = { food: 0, bills: 0, dine: 0, take: 0, openToday: 0, cash: 0, qr: 0, received: 0, fromPrev: 0, openAll: 0, voids: 0, top: [] }, qty = {};
    Object.values(S.orders).forEach(function (o) {
      var c = day(o.createdAt), p = day(o.paidAt);
      if (o.status === 'open') s.openAll += o.total;
      if (c === date) {
        if (o.status === 'void') { s.voids++; return; }
        s.food += o.total; s.bills++; if (o.type === 'takeaway') s.take++; else s.dine++;
        if (o.status === 'open') s.openToday += o.total;
        o.items.forEach(function (l) { qty[l.name] = (qty[l.name] || 0) + l.qty; });
      }
      if (o.status === 'paid' && p === date) { if (o.method === 'qr') s.qr += o.total; else s.cash += o.total; s.received += o.total; if (c < date) s.fromPrev += o.total; }
    });
    s.top = Object.keys(qty).map(function (k) { return { name: k, qty: qty[k] }; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, 5);
    return s;
  }
  function renderSummary() {
    var d = S.summaryDate || today();
    var s = (S.remoteSummary && S.remoteSummary.date === d) ? S.remoteSummary : (d >= day(new Date(Date.now() - 86400000).toISOString()) ? localSummary(d) : null);
    var body = s ? '<div class="hero"><small>รับเงินวันนี้ (ตามวันชำระ)</small><b>฿' + money(s.received) + '</b><small>เงินสด ฿' + money(s.cash) + ' · QR ฿' + money(s.qr) + '</small></div>' +
      '<div class="grid2">' +
      kpi('ยอดอาหาร (ตามวันสั่ง)', '฿' + money(s.food)) + kpi('จำนวนบิล', s.bills + ' (โต๊ะ ' + s.dine + ' / TA ' + s.take + ')') +
      kpi('ค้างจ่ายของวันนี้', '฿' + money(s.openToday), 'pink') + kpi('ค้างจ่ายสะสม', '฿' + money(s.openAll), 'pink') +
      kpi('รับจากบิลวันก่อน', '฿' + money(s.fromPrev)) + kpi('ยกเลิก', s.voids + ' บิล') + '</div>' +
      '<h4 class="sec">ขายดี</h4><ol class="topl">' + (s.top.length ? s.top.map(function (t) { return '<li><span>' + esc(t.name) + '</span><b>' + t.qty + '</b></li>'; }).join('') : '<li class="muted">ยังไม่มีรายการ</li>') + '</ol>'
      : '<p class="muted">กด "โหลด" เพื่อดึงสรุปของวันนี้จากระบบกลาง</p>';
    return header('', '', '') + '<main class="pad-b"><div class="daterow"><label class="fld"><span>วันที่</span><input type="date" data-a="sum-date" value="' + d + '"></label><button class="btn ghost" data-a="sum-reload">โหลด</button></div>' + body +
      (canWrite() ? '<button class="btn outline wide mt" data-a="send-summary">ส่งสรุปวันนี้เข้า Telegram</button><p class="note">ระบบส่งสรุปอัตโนมัติ 20:30 (เมื่อเปิดใช้งาน)</p>' : '') + '</main>' + nav();
  }
  function kpi(label, val, cls) { return '<div class="kpi"><small>' + esc(label) + '</small><b class="' + (cls || '') + '">' + val + '</b></div>'; }

  function renderSettings() {
    var pr = window.ECRPrinter ? ECRPrinter.status() : { connected: false, name: '' };
    var a = S.auth, st = S.adminStatus;
    var roleTh = { cashier: 'แคชเชียร์', manager: 'ผู้จัดการ', viewer: 'ดูอย่างเดียว' }[a.role];
    var html = header('', '', '') + '<main class="pad-b settings">' +
      '<div class="card"><h4>เครื่องนี้</h4><p>สาขา' + esc(CFG.name) + ' · ' + roleTh + ' · ' + VERSION + ' · ' + (a.mode === 'live' ? 'ใช้งานจริง' : '<b class="pink">โหมดทดสอบ</b>') + '</p>' +
      '<p class="muted">รอส่ง ' + S.outbox.length + ' · ต้องตรวจ ' + S.review.length + (S.syncErr ? ' · ' + esc(S.syncErr) : '') + '</p>' +
      '<div class="row gap wrap"><button class="btn ghost" data-a="sync-now">ซิงก์ตอนนี้</button><button class="btn ghost" data-a="reload-images">โหลดรูปใหม่</button><button class="btn ghost" data-a="review">รายการต้องตรวจ</button>' +
      (a.lockHash ? '<button class="btn ghost" data-a="lock">ล็อกแอป</button>' : '') + '<button class="btn ghost danger-t" data-a="logout">ออกจากระบบ</button></div></div>' +
      '<div class="card"><h4>เครื่องพิมพ์ (Bluetooth)</h4><p>' + (pr.connected ? 'เชื่อมต่อแล้ว: ' + esc(pr.name) : 'ยังไม่เชื่อมต่อ' + (pr.name ? ' (ล่าสุด: ' + esc(pr.name) + ')' : '')) + '</p>' +
      '<div class="row gap wrap"><button class="btn primary" data-a="printer-connect">' + (pr.connected ? 'เปลี่ยนเครื่องพิมพ์' : 'เชื่อมต่อเครื่องพิมพ์') + '</button>' +
      (pr.connected ? '<button class="btn ghost" data-a="printer-test">พิมพ์ทดสอบ</button><button class="btn ghost" data-a="printer-off">ตัดการเชื่อมต่อ</button>' : '') + '</div>' +
      '<div class="row gap wrap mt"><label class="chk"><input type="radio" name="paper" data-a="paper" value="58"' + (S.prefs.paper == 58 ? ' checked' : '') + '> 58 มม.</label><label class="chk"><input type="radio" name="paper" data-a="paper" value="80"' + (S.prefs.paper != 58 ? ' checked' : '') + '> 80 มม.</label>' +
      '<label class="chk"><input type="checkbox" data-a="autoprint"' + (S.prefs.autoPrint ? ' checked' : '') + '> พิมพ์ใบเสร็จอัตโนมัติ</label></div></div>';
    if (canWrite()) {
      html += '<div class="card"><h4>ผู้จัดการ</h4>' + (isMgr() ? '' : '<p class="muted">ต้องใส่ PIN ผู้จัดการเพื่อแก้เมนู/QR/รหัส</p><button class="btn primary" data-a="mgr-unlock">ปลดล็อกส่วนผู้จัดการ</button>');
      if (isMgr()) {
        html += '<div class="row gap wrap"><button class="btn ghost" data-a="menu-edit">แก้เมนู/ราคา</button><button class="btn ghost" data-a="qr-upload">เปลี่ยนรูป QR</button><button class="btn ghost" data-a="logo-upload">โลโก้ใบเสร็จ</button>' +
          '<button class="btn ghost" data-a="table-count">จำนวนโต๊ะ</button><button class="btn ghost" data-a="set-mgr-pin">ตั้ง PIN ผู้จัดการ</button><button class="btn ghost" data-a="set-lock-pin">ตั้ง PIN ล็อกแอป</button></div>' +
          '<h4 class="mt">Telegram และการเปิดใช้งาน</h4>' +
          (st ? '<p class="muted">Telegram: ' + (st.telegram ? 'ตั้งแล้ว' : 'ยังไม่ตั้ง') + ' · สรุปอัตโนมัติ 20:30: ' + (st.summaryAuto ? 'เปิด' : 'ปิด') + ' · รอส่งแจ้งเตือน ' + st.pendingNotify + ' · โหมด: ' + (st.mode === 'live' ? 'ใช้งานจริง' : 'ทดสอบ') + '</p>' : '<button class="btn ghost" data-a="admin-status">ดูสถานะระบบ</button>') +
          '<div class="row gap wrap"><button class="btn ghost" data-a="tg-set">ตั้งค่า Telegram</button><button class="btn ghost" data-a="tg-test">ทดสอบส่ง</button>' +
          '<button class="btn ghost" data-a="sum-auto">' + (st && st.summaryAuto ? 'ปิด' : 'เปิด') + 'สรุปอัตโนมัติ 20:30</button>' +
          '<button class="btn ' + (st && st.mode === 'live' ? 'ghost' : 'danger') + '" data-a="mode">' + (st && st.mode === 'live' ? 'กลับไปโหมดทดสอบ' : 'เปิดใช้งานจริง (ชีทจริง)') + '</button></div>';
      }
      html += '</div>';
    }
    return html + '<p class="ver center">ECR POS ' + VERSION + ' · built by Rocky</p></main>' + nav();
  }

  /* ---------------- menu editor ---------------- */
  function renderMenuEdit() {
    var m = S.menuDraft;
    var cats = m.categories.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var html = header('<b>แก้เมนู</b><small>' + m.menuItems.length + ' รายการ</small>', 'menu-cancel', '<button class="btn primary sm" data-a="menu-save">บันทึก</button>') + '<main class="pad-b">';
    cats.forEach(function (c) {
      html += '<div class="row center-v mt"><h4 class="grow">' + esc(c.name) + '</h4><button class="btn ghost sm" data-a="cat-edit" data-id="' + esc(c.id) + '">แก้หมวด</button></div><div class="list">';
      m.menuItems.filter(function (x) { return x.catId === c.id; }).forEach(function (x) {
        html += '<button class="bill" data-a="item-edit" data-id="' + esc(x.id) + '"><span class="bi">' + esc(x.name) + '<small>' + (x.groups || []).map(function (g) { var gg = m.optionGroups.filter(function (y) { return y.id === g; })[0]; return gg ? esc(gg.name) : ''; }).join(', ') + '</small></span>' +
          (x.available === false ? '<span class="chip off">ปิดขาย</span>' : '') + '<em>฿' + money(x.price) + '</em></button>';
      });
      html += '</div>';
    });
    var orphan = m.menuItems.filter(function (x) { return !cats.some(function (c) { return c.id === x.catId; }); });
    if (orphan.length) html += '<h4 class="mt">ไม่มีหมวด</h4><div class="list">' + orphan.map(function (x) { return '<button class="bill" data-a="item-edit" data-id="' + esc(x.id) + '"><span class="bi">' + esc(x.name) + '</span><em>฿' + money(x.price) + '</em></button>'; }).join('') + '</div>';
    html += '<div class="row gap wrap mt"><button class="btn outline" data-a="item-new">+ เมนูใหม่</button><button class="btn ghost" data-a="cat-new">+ หมวดใหม่</button></div>' +
      '<h4 class="mt">กลุ่มตัวเลือก</h4><div class="list">' + m.optionGroups.map(function (g) { return '<button class="bill" data-a="grp-edit" data-id="' + esc(g.id) + '"><span class="bi">' + esc(g.name) + '<small>' + g.options.map(function (o) { return esc(o.name) + (o.price ? ' +' + o.price : ''); }).join(', ') + '</small></span><em>เลือก ' + g.min + '-' + g.max + '</em></button>'; }).join('') + '</div>' +
      '<button class="btn ghost mt" data-a="grp-new">+ กลุ่มตัวเลือกใหม่</button></main>';
    return html;
  }
  async function editItem(id) {
    var m = S.menuDraft, isNew = !id;
    var x = isNew ? { id: 'm' + uid(), name: '', price: 0, catId: (m.categories[0] || {}).id, groups: [], available: true } : m.menuItems.filter(function (y) { return y.id === id; })[0];
    var img = S.images[x.id];
    var r = await modal('<h3>' + (isNew ? 'เมนูใหม่' : 'แก้เมนู') + '</h3>' +
      '<div class="imgrow">' + (img ? '<img src="' + img + '" alt="">' : '<span class="noimg">ไม่มีรูป</span>') +
      '<button class="btn ghost sm" data-m="img">' + (img ? 'เปลี่ยนรูป' : 'เพิ่มรูป') + '</button>' + (img ? '<button class="btn ghost sm danger-t" data-m="imgdel">ลบรูป</button>' : '') + '</div>' +
      '<label class="fld"><span>ชื่อเมนู</span><input name="name" value="' + esc(x.name) + '"></label>' +
      '<label class="fld"><span>ราคา (บาท)</span><input name="price" inputmode="numeric" value="' + esc(x.price) + '"></label>' +
      '<label class="fld"><span>หมวด</span><select name="catId">' + m.categories.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === x.catId ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></label>' +
      '<div class="fld"><span>กลุ่มตัวเลือก</span>' + m.optionGroups.map(function (g) { return '<label class="chk"><input type="checkbox" name="g_' + esc(g.id) + '"' + ((x.groups || []).indexOf(g.id) >= 0 ? ' checked' : '') + '> ' + esc(g.name) + '</label>'; }).join('') + '</div>' +
      '<label class="chk"><input type="checkbox" name="available"' + (x.available !== false ? ' checked' : '') + '> เปิดขาย</label>' +
      '<div class="row gap mt">' + (isNew ? '' : '<button class="btn ghost danger-t" data-m="del">ลบเมนู</button>') + '<button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">ตกลง</button></div>', { cls: 'tall' });
    if (!r || r.act === 'no') return;
    if (r.act === 'img' || r.act === 'imgdel') {
      var url = '';
      if (r.act === 'img') { url = await pickImage(480, 0.8); if (!url) { toast('ยกเลิก หรือรูปใหญ่เกินไป', 'err'); return editItem(id); } }
      try { await rpc('saveImage', { key: x.id, dataUrl: url, managerPin: S.mgrPin || '' }); if (url) S.images[x.id] = url; else delete S.images[x.id]; save('images', S.images); toast(url ? 'บันทึกรูปแล้ว' : 'ลบรูปแล้ว'); }
      catch (err) { toast(err.message, 'err'); }
      if (isNew) { x.name = r.data.name.trim() || x.name; x.price = Number(r.data.price) || 0; x.catId = r.data.catId; m.menuItems.push(x); render(); return editItem(x.id); }
      return editItem(id);
    }
    if (r.act === 'del') { if (await confirmBox('ลบเมนู ' + x.name + '?', 'บิลเก่ายังเก็บชื่อเดิมไว้', 'ลบ', true)) m.menuItems = m.menuItems.filter(function (y) { return y.id !== x.id; }); render(); return; }
    var d = r.data;
    if (!d.name.trim()) return toast('ต้องใส่ชื่อเมนู', 'err');
    x.name = d.name.trim(); x.price = Number(d.price) || 0; x.catId = d.catId; x.available = !!d.available;
    x.groups = m.optionGroups.filter(function (g) { return d['g_' + g.id]; }).map(function (g) { return g.id; });
    if (isNew) m.menuItems.push(x);
    render();
  }
  async function editCat(id) {
    var m = S.menuDraft, c = id ? m.categories.filter(function (y) { return y.id === id; })[0] : null;
    var name = await askText(c ? 'แก้หมวด' : 'หมวดใหม่', 'ชื่อหมวด', c ? c.name : '');
    if (!name) return;
    if (c) c.name = name; else m.categories.push({ id: 'c' + uid(), name: name, order: m.categories.length + 1 });
    render();
  }
  async function editGroup(id) {
    var m = S.menuDraft, isNew = !id;
    var g = isNew ? { id: 'g' + uid(), name: '', min: 0, max: 1, options: [] } : m.optionGroups.filter(function (y) { return y.id === id; })[0];
    var optsText = g.options.map(function (o) { return o.name + (o.price ? '=' + o.price : ''); }).join('\n');
    var r = await modal('<h3>' + (isNew ? 'กลุ่มตัวเลือกใหม่' : 'แก้กลุ่มตัวเลือก') + '</h3>' +
      '<label class="fld"><span>ชื่อกลุ่ม</span><input name="name" value="' + esc(g.name) + '"></label>' +
      '<div class="grid2"><label class="fld"><span>เลือกขั้นต่ำ</span><input name="min" inputmode="numeric" value="' + g.min + '"></label><label class="fld"><span>เลือกได้สูงสุด</span><input name="max" inputmode="numeric" value="' + g.max + '"></label></div>' +
      '<label class="fld"><span>ตัวเลือก (บรรทัดละ 1 · เพิ่มราคาใส่ =ราคา เช่น ไข่ดาว=10)</span><textarea name="opts" rows="5">' + esc(optsText) + '</textarea></label>' +
      '<div class="row gap mt"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">ตกลง</button></div>', { cls: 'tall' });
    if (!r || r.act !== 'ok') return;
    g.name = r.data.name.trim() || g.name; g.min = Number(r.data.min) || 0; g.max = Math.max(Number(r.data.max) || 1, g.min || 1);
    g.options = r.data.opts.split('\n').map(function (s) { s = s.trim(); if (!s) return null; var p = s.split('='); return { name: p[0].trim(), price: Number(p[1] || 0) || 0 }; }).filter(Boolean);
    if (isNew) m.optionGroups.push(g);
    render();
  }

  /* ---------------- option picker ---------------- */
  async function pickOptions(m) {
    var groups = (m.groups || []).map(group).filter(Boolean);
    var html = '<h3>' + esc(m.name) + '</h3><p class="muted">฿' + money(m.price) + '</p>' + groups.map(function (g) {
      var multi = Number(g.max) > 1;
      return '<div class="optg" data-g="' + esc(g.id) + '" data-min="' + g.min + '" data-max="' + g.max + '"><b>' + esc(g.name) + '</b><small>' + (Number(g.min) > 0 ? 'ต้องเลือก ' : 'เลือกได้ ') + (multi ? 'สูงสุด ' + g.max : '1') + '</small><div class="opts">' +
        g.options.map(function (o, i) { return '<label class="opt"><input type="' + (multi ? 'checkbox' : 'radio') + '" name="o_' + esc(g.id) + (multi ? '_' + i : '') + '" value="' + esc(o.name) + '"' + (!multi && Number(g.min) > 0 && i === 0 ? ' checked' : '') + '><span>' + esc(o.name) + (o.price ? ' +' + o.price : '') + '</span></label>'; }).join('') + '</div></div>';
    }).join('') + '<label class="fld"><span>หมายเหตุ</span><input name="note" placeholder="เช่น ไม่เอาแตง"></label>' +
      '<div class="row gap center-v mt"><span>จำนวน</span><div class="qty"><button type="button" data-q="-1">−</button><b id="oq">1</b><button type="button" data-q="1">+</button></div><input type="hidden" name="qty" value="1"></div>' +
      '<div class="row gap mt"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">เพิ่มลงบิล</button></div>';
    var r = await modal(html, {
      cls: 'tall',
      onOpen: function (bg) {
        bg.addEventListener('click', function (e) {
          var q = e.target.closest('[data-q]'); if (!q) return;
          var inp = bg.querySelector('[name=qty]'); var v = Math.max(1, Number(inp.value) + Number(q.getAttribute('data-q')));
          inp.value = v; bg.querySelector('#oq').textContent = v;
        });
      },
      onAction: function (act, bg) {
        if (act !== 'ok') return true;
        var bad = null;
        bg.querySelectorAll('.optg').forEach(function (el) {
          var n = el.querySelectorAll('input:checked').length;
          if (n < Number(el.dataset.min) || n > Number(el.dataset.max)) bad = el.querySelector('b').textContent;
        });
        if (bad) { toast('เลือก ' + bad + ' ให้ครบ', 'err'); return false; }
        var sel = [];
        bg.querySelectorAll('.optg').forEach(function (el) {
          var g = group(el.dataset.g);
          el.querySelectorAll('input:checked').forEach(function (i) {
            var o = g.options.filter(function (x) { return x.name === i.value; })[0];
            sel.push({ groupId: g.id, groupName: g.name, name: o.name, price: Number(o.price || 0) });
          });
        });
        bg._sel = sel;
        S._lastSel = sel;
        return true;
      }
    });
    if (!r || r.act !== 'ok') return null;
    return { selected: S._lastSel || [], note: r.data.note || '', qty: Math.max(1, Number(r.data.qty) || 1) };
  }
  async function addItem(id) {
    var m = menuItem(id); if (!m) return;
    var sel = [], note = '', qty = 1;
    if ((m.groups || []).length) { var r = await pickOptions(m); if (!r) return; sel = r.selected; note = r.note; qty = r.qty; }
    var key = JSON.stringify([m.id, sel.map(function (s) { return s.name; }), note]);
    var same = S.cur.items.filter(function (l) { return !l.saved && l.priceOverride == null && JSON.stringify([l.menuId, (l.selected || []).map(function (s) { return s.name; }), l.note || '']) === key; })[0];
    if (same) same.qty += qty;
    else S.cur.items.push({ lineId: uid(), menuId: m.id, name: m.name, base: Number(m.price), qty: qty, selected: sel, note: note });
    touchCur(); render();
  }
  async function editLine(i) {
    var l = S.cur.items[i]; if (!l || !canWrite()) return;
    var r = await modal('<h3>' + esc(l.name) + '</h3>' + (optText(l) ? '<p class="muted">' + esc(optText(l)) + '</p>' : '') +
      '<label class="fld"><span>หมายเหตุ</span><input name="note" value="' + esc(l.note || '') + '"></label>' +
      '<label class="fld"><span>ราคาต่อหน่วย (แก้ราคาต้องให้ผู้จัดการอนุมัติ)</span><input name="price" inputmode="numeric" value="' + esc(lineUnit(l)) + '"></label>' +
      '<div class="row gap mt"><button class="btn ghost danger-t" data-m="del">ลบรายการ</button><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">ตกลง</button></div>');
    if (!r || r.act === 'no') return;
    if (r.act === 'del') { S.cur.items.splice(i, 1); touchCur(); render(); return; }
    l.note = r.data.note;
    var pr = Number(r.data.price);
    var normal = l.saved ? Number(l.unit) : lineUnit(Object.assign({}, l, { priceOverride: null }));
    l.priceOverride = isFinite(pr) && pr !== normal ? pr : null;
    touchCur(); render();
  }

  /* ---------------- events ---------------- */
  document.addEventListener('submit', async function (e) {
    var f = e.target.closest('[data-f]'); if (!f) return;
    e.preventDefault();
    if (f.dataset.f === 'login') {
      var c = f.code.value.trim().toUpperCase();
      var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'กำลังตรวจรหัส…';
      try {
        var r = await rpc('login', {}, c);
        if (r.branch !== CFG.branch) throw new Error('รหัสนี้เป็นของสาขาอื่น');
        S.auth = { code: c, role: r.role, lockHash: r.lockHash, salt: r.salt, mode: r.mode, at: new Date().toISOString() };
        save('auth', S.auth);
        S.view = 'tables'; render(); pull(); loadImages(true);
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'recv' && S.pay) {
      S.pay.received = e.target.value.replace(/[^\d.]/g, '');
      var ch = Number(S.pay.received || 0) - curTotal(S.cur), el = document.getElementById('chg');
      if (el) { el.textContent = S.pay.received === '' ? '–' : '฿' + money(ch); el.className = ch < 0 ? 'pink' : ''; }
    }
  });
  document.addEventListener('change', function (e) {
    var a = e.target.getAttribute('data-a');
    if (a === 'bills-date') { S.billsDate = e.target.value; S.remoteBills = null; render(); if (S.billsDate < day(new Date(Date.now() - 2 * 86400000).toISOString())) loadBills(); }
    if (a === 'sum-date') { S.summaryDate = e.target.value; S.remoteSummary = null; render(); }
    if (a === 'paper') { S.prefs.paper = Number(e.target.value); save('prefs', S.prefs); }
    if (a === 'autoprint') { S.prefs.autoPrint = e.target.checked; save('prefs', S.prefs); }
    if (a === 'pay-print' && S.pay) S.pay.print = e.target.checked;
  });
  async function loadBills() {
    var d = S.billsDate || today();
    S.remoteBills = { date: d, loading: true, orders: [] }; render();
    try { var r = await rpc('getAll', { from: d, to: d }); S.remoteBills = { date: d, orders: r.orders }; }
    catch (e) { S.remoteBills = null; toast(e.message, 'err'); }
    render();
  }
  async function pickImage(maxW, quality) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = function () {
        var f = inp.files[0]; if (!f) return resolve(null);
        var img = new Image();
        img.onload = function () {
          var w = Math.min(maxW, img.width), h = Math.round(img.height * w / img.width);
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
          var q = quality, url = c.toDataURL('image/jpeg', q);
          while (url.length > 48000 && q > 0.3) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
          resolve(url.length > 48000 ? null : url);
        };
        img.src = URL.createObjectURL(f);
      };
      inp.click();
    });
  }
  async function adminCall(cmd, extra) {
    var pin = role() === 'manager' ? '' : S.mgrPin;
    try { var r = await rpc('admin', Object.assign({ cmd: cmd, managerPin: pin }, extra || {})); return r; }
    catch (e) { toast(e.message, 'err'); return null; }
  }

  document.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-a]'); if (!b || b.closest('.modal-bg')) return;
    var a = b.getAttribute('data-a'), v = b.getAttribute('data-v'), id = b.getAttribute('data-id');
    if (b.tagName === 'INPUT') return;
    switch (a) {
      case 'view': S.view = v; S.remoteSummary = null; render(); tryReload(); if (v === 'settings' && isMgr() && !S.adminStatus) refreshAdmin(); break;
      case 'pin': return pinKey(v);
      case 'new-table': startOrder(null, { type: 'dinein', table: v }); break;
      case 'add-table': {
        var n = await askText('เปิดโต๊ะ', 'เลขโต๊ะ', String(tableList().nums.length + 1), 'numeric');
        if (!n) return;
        var exist = Object.values(S.orders).filter(function (o) { return o.status === 'open' && o.type === 'dinein' && o.table === n; })[0];
        if (exist) startOrder(exist); else startOrder(null, { type: 'dinein', table: n });
        break;
      }
      case 'new-take': startOrder(null, { type: 'takeaway' }); break;
      case 'new-lineman': {
        var lm = await modal('<h3>พิมพ์ฉลาก LINE MAN</h3><p class="muted">ไม่บันทึกยอดขาย</p><label class="fld"><span>เลขออเดอร์ LINE MAN</span><input name="no" autocomplete="off" autocapitalize="characters" autofocus></label>' +
          '<div class="row gap"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">พิมพ์ฉลาก</button></div>', {
          onOpen: function (bg) { bg.querySelector('[name=no]').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); bg.querySelector('[data-m=ok]').click(); } }); }
        });
        if (!lm || lm.act !== 'ok') break;
        var no = String(lm.data.no || '').trim();
        if (!no) { toast('ใส่เลขออเดอร์ก่อน', 'err'); break; }
        printLabel(no);
        break;
      }
      case 'open-order': if (S.orders[id]) startOrder(S.orders[id]); break;
      case 'back-order': leaveOrder(); break;
      case 'back-pay': S.view = 'order'; render(); break;
      case 'cat': S.cat = v; render(); break;
      case 'add-item': addItem(id); break;
      case 'qty': {
        var l = S.cur.items[Number(b.dataset.i)];
        l.qty += Number(v);
        if (l.qty <= 0) { if (l.saved || await confirmBox('ลบ ' + l.name + '?', '', 'ลบ', true)) S.cur.items.splice(Number(b.dataset.i), 1); else l.qty = 1; }
        touchCur(); render(); break;
      }
      case 'line-edit': editLine(Number(b.dataset.i)); break;
      case 'save-order': saveCur(); break;
      case 'go-pay': goPay(); break;
      case 'print-label': printOrder(localOrder(S.cur, 'open'), 'label'); break;
      case 'order-more': {
        var o = S.orders[S.cur.id];
        var r = await modal('<h3>บิล #' + code(S.cur.id) + '</h3><div class="col gap">' +
          '<button class="btn ghost" data-m="invoice">พิมพ์ใบแจ้งยอด</button>' +
          (S.cur.type === 'dinein' ? '<button class="btn ghost" data-m="move">ย้ายโต๊ะ</button>' : '') +
          '<button class="btn danger" data-m="void">ยกเลิกบิล</button><button class="btn ghost" data-m="no">ปิด</button></div>');
        if (!r) return;
        if (r.act === 'invoice') printOrder(localOrder(S.cur, 'open'), 'invoice');
        if (r.act === 'move') { var t = await askText('ย้ายโต๊ะ', 'ไปโต๊ะ', S.cur.table, 'numeric'); if (t) { S.cur.table = t; touchCur(); render(); toast('กด "บันทึก" เพื่อยืนยันการย้าย'); } }
        if (r.act === 'void' && o) { await voidOrder(o); S.cur = null; drop('draft'); S.view = 'tables'; render(); }
        break;
      }
      case 'pay-method': S.pay.method = v; render(); break;
      case 'quick': S.pay.received = v; render(); break;
      case 'confirm-pay': confirmPay(); break;
      case 'bill': billDetail(id); break;
      case 'bills-reload': if ((S.billsDate || today()) < day(new Date(Date.now() - 2 * 86400000).toISOString())) loadBills(); else pull(); break;
      case 'sum-reload': {
        var d = S.summaryDate || today();
        try { var sr = await rpc('summary', { date: d }); S.remoteSummary = Object.assign({ date: d }, sr.summary); render(); } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'send-summary': {
        if (!await confirmBox('ส่งสรุปเข้า Telegram?', 'ส่งสรุปของวันที่ ' + (S.summaryDate || today()), 'ส่ง')) return;
        try { await rpc('sendSummary', { date: S.summaryDate || today() }); toast('ส่งสรุปแล้ว'); } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'reload-images': await loadImages(true); toast('โหลดรูปใหม่แล้ว'); break;
      case 'sync-now': case 'sync-detail': nextTry = 0; flush(); pull(); toast('กำลังซิงก์…'); break;
      case 'review': reviewList(); break;
      case 'lock': lockNow(); break;
      case 'logout': {
        if (S.outbox.length && !await confirmBox('ยังมี ' + S.outbox.length + ' รายการที่ยังไม่ได้ส่ง', 'ถ้าออกตอนนี้ รายการจะยังอยู่ในเครื่อง แต่จะส่งไม่ได้จนกว่าจะเข้าสู่ระบบใหม่', 'ออกอยู่ดี', true)) return;
        if (!S.outbox.length && !await confirmBox('ออกจากระบบ?', 'ต้องใช้รหัสเครื่องเพื่อเข้าใหม่', 'ออก', true)) return;
        S.auth = null; drop('auth'); S.mgrSession = false; render(); break;
      }
      case 'printer-connect': try { var nm = await ECRPrinter.connect(); toast('เชื่อมต่อ ' + nm + ' แล้ว'); } catch (err) { if (err.name !== 'NotFoundError') toast(err.message, 'err'); } render(); break;
      case 'printer-off': ECRPrinter.disconnect(); render(); break;
      case 'printer-test': printOrder({ id: 'TEST', type: 'dinein', table: '0', items: [{ name: 'ทดสอบภาษาไทย ข้าวมันไก่', qty: 1, total: 0, selected: [{ name: 'ข้าวมัน' }] }], total: 0, createdAt: new Date().toISOString(), method: 'cash', received: 0, change: 0 }, 'receipt'); break;
      case 'mgr-unlock': { var pin = await managerPin('เข้าส่วนตั้งค่าผู้จัดการ'); if (pin) { S.mgrSession = true; S.mgrPin = pin; render(); refreshAdmin(); } break; }
      case 'admin-status': refreshAdmin(); break;
      case 'menu-edit': S.menuDraft = JSON.parse(JSON.stringify(S.menu || { settings: {}, categories: [], optionGroups: [], menuItems: [] })); S.view = 'menuedit'; render(); break;
      case 'menu-cancel': if (await confirmBox('ออกโดยไม่บันทึก?', '', 'ออก', true)) { S.menuDraft = null; S.view = 'settings'; render(); } break;
      case 'menu-save': {
        try { var mr = await rpc('saveConfig', { menu: S.menuDraft, managerPin: S.mgrPin || '' }); S.menu = mr.menu; save('menu', S.menu); S.menuDraft = null; S.view = 'settings'; render(); toast('บันทึกเมนูแล้ว'); }
        catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'item-edit': editItem(id); break;
      case 'item-new': editItem(null); break;
      case 'cat-edit': editCat(id); break;
      case 'cat-new': editCat(null); break;
      case 'grp-edit': editGroup(id); break;
      case 'grp-new': editGroup(null); break;
      case 'qr-upload': case 'logo-upload': {
        var key = a === 'qr-upload' ? 'qr' : 'logo';
        var url = await pickImage(a === 'qr-upload' ? 600 : 300, 0.85);
        if (!url) return toast('รูปใหญ่เกินไปหรือยกเลิก', 'err');
        try { await rpc('saveImage', { key: key, dataUrl: url, managerPin: S.mgrPin || '' }); S.images[key] = url; save('images', S.images); toast('บันทึกรูปแล้ว'); } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'table-count': {
        var tc = await askText('จำนวนโต๊ะ', 'จำนวนโต๊ะที่แสดงเสมอ', String((S.menu.settings || {}).tableCount || CFG.tables || 5), 'numeric');
        if (!tc) return;
        var mm = JSON.parse(JSON.stringify(S.menu)); mm.settings = mm.settings || {}; mm.settings.tableCount = Number(tc) || 5;
        try { var tr = await rpc('saveConfig', { menu: mm, managerPin: S.mgrPin || '' }); S.menu = tr.menu; save('menu', S.menu); render(); } catch (err) { toast(err.message, 'err'); }
        break;
      }
      case 'set-mgr-pin': case 'set-lock-pin': {
        var p1 = await askText(a === 'set-mgr-pin' ? 'PIN ผู้จัดการใหม่' : 'PIN ล็อกแอปใหม่ (ใช้ทุกเครื่องของสาขา)', 'ตัวเลข 4-8 หลัก', '', 'numeric');
        if (!p1) return;
        var ar = await adminCall(a === 'set-mgr-pin' ? 'setManagerPin' : 'setLockPin', { pin: p1 });
        if (ar) { if (ar.lockHash) { S.auth.lockHash = ar.lockHash; save('auth', S.auth); } toast('ตั้ง PIN แล้ว'); refreshAdmin(); }
        break;
      }
      case 'tg-set': {
        var r2 = await modal('<h3>ตั้งค่า Telegram</h3><p class="muted">ใส่ token ของ bot และ Chat ID ของกลุ่ม (ระบบไม่แสดงค่าเดิม)</p><label class="fld"><span>Bot token</span><input name="token" autocomplete="off"></label><label class="fld"><span>Chat ID</span><input name="chat" inputmode="numeric"></label>' +
          '<div class="row gap"><button class="btn ghost grow" data-m="no">ยกเลิก</button><button class="btn primary grow" data-m="ok">บันทึก</button></div>');
        if (r2 && r2.act === 'ok' && await adminCall('setTelegram', { token: r2.data.token, chat: r2.data.chat })) { toast('บันทึกแล้ว'); refreshAdmin(); }
        break;
      }
      case 'tg-test': { var tt = await adminCall('testTelegram'); if (tt) toast(tt.sent ? 'ส่งข้อความทดสอบแล้ว' : 'ส่งไม่สำเร็จ: ' + tt.error, tt.sent ? '' : 'err'); break; }
      case 'sum-auto': { var on = !(S.adminStatus && S.adminStatus.summaryAuto); if (await adminCall('setSummaryAuto', { on: on })) { toast(on ? 'เปิดสรุปอัตโนมัติแล้ว' : 'ปิดแล้ว'); refreshAdmin(); } break; }
      case 'mode': {
        var toLive = !(S.adminStatus && S.adminStatus.mode === 'live');
        if (!await confirmBox(toLive ? 'เปิดใช้งานจริง?' : 'กลับไปโหมดทดสอบ?', toLive ? 'ทุกเครื่องของสาขานี้จะบันทึกลง Google Sheet จริงทันที' : 'บิลใหม่จะไปลงชีททดสอบ', 'ยืนยัน', toLive)) return;
        if (S.outbox.length) return toast('ส่งรายการค้างให้หมดก่อน', 'err');
        var mr2 = await adminCall('setMode', { mode: toLive ? 'live' : 'test' });
        if (mr2) { S.orders = {}; persistOrders(); S.auth.mode = mr2.mode; save('auth', S.auth); refreshAdmin(); pull(); toast('เปลี่ยนโหมดแล้ว'); }
        break;
      }
    }
  });
  async function refreshAdmin() { var r = await adminCall('status'); if (r) { S.adminStatus = r; if (S.view === 'settings') render(); } }

  async function pinKey(k) {
    if (S.lockUntil > Date.now()) return;
    if (k === 'C') pinBuf = '';
    else if (k === 'OK') {
      var h = await sha(S.auth.salt + '|' + pinBuf);
      if (h === S.auth.lockHash) { S.locked = false; S.lockFails = 0; lastAct = Date.now(); render(); pull(); ECRPrinter && ECRPrinter.reconnect().then(renderStatus); return; }
      S.lockFails++; pinBuf = '';
      if (S.lockFails >= 5) { S.lockUntil = Date.now() + 30000; S.lockFails = 0; renderLock(); setTimeout(renderLock, 30500); return; }
      toast('PIN ไม่ถูกต้อง', 'err');
    } else if (pinBuf.length < 8) pinBuf += k;
    drawPin();
  }

  async function billDetail(id) {
    var o = S.orders[id] || (S.remoteBills && S.remoteBills.orders.filter(function (x) { return x.id === id; })[0]);
    if (!o) return;
    var w = canWrite();
    var html = '<h3>บิล #' + code(o.id) + ' · ' + (o.type === 'dinein' ? 'โต๊ะ ' + esc(o.table) : esc(o.name || 'Take Away')) + '</h3>' +
      '<p class="muted">สั่ง ' + day(o.createdAt) + ' ' + hm(o.createdAt) + (o.paidAt ? '<br>รับเงิน ' + day(o.paidAt) + ' ' + hm(o.paidAt) + ' · ' + (o.method === 'qr' ? 'QR' : 'เงินสด รับ ' + money(o.received) + ' ทอน ' + money(o.change)) : '') + (o.status === 'void' ? '<br><b class="pink">ยกเลิกแล้ว</b>' : '') + '</p>' +
      '<div class="lines">' + o.items.map(function (l) { return '<div class="line"><span class="lname"><span>' + l.qty + 'x ' + esc(l.name) + '</span>' + (optText(l) ? '<small>' + esc(optText(l)) + '</small>' : '') + '</span><span class="amt">฿' + money(l.total) + '</span></div>'; }).join('') + '</div>' +
      '<div class="total"><span>รวม</span><b>฿' + money(o.total) + '</b></div><div class="col gap">' +
      (w && o.status === 'open' ? '<button class="btn primary" data-m="open">เปิดบิล / รับชำระ</button>' : '') +
      (o.status === 'paid' ? '<button class="btn ghost" data-m="print">พิมพ์ใบเสร็จซ้ำ</button>' : '') +
      (o.status === 'open' ? '<button class="btn ghost" data-m="invoice">พิมพ์ใบแจ้งยอด</button>' : '') +
      (w && o.status !== 'void' ? '<button class="btn danger" data-m="void">ยกเลิกบิล</button>' : '') +
      '<button class="btn ghost" data-m="no">ปิด</button></div>';
    var r = await modal(html, { cls: 'tall' });
    if (!r) return;
    if (r.act === 'open') startOrder(o);
    if (r.act === 'print') printOrder(o, 'receipt');
    if (r.act === 'invoice') printOrder(o, 'invoice');
    if (r.act === 'void') voidOrder(o);
  }

  async function reviewList() {
    var html = '<h3>รายการที่ส่งไม่สำเร็จ</h3>' + (S.review.length ? S.review.map(function (x, i) {
      var p = x.op.payload, ord = p.order || {};
      return '<div class="card"><b>' + ({ saveOrder: 'บันทึกบิล', pay: 'รับชำระ', void: 'ยกเลิกบิล' }[x.op.action] || x.op.action) + ' #' + code(x.op.orderId) + '</b>' +
        '<p class="muted">' + esc(x.message) + '<br>' + (ord.type === 'dinein' ? 'โต๊ะ ' + esc(ord.table) : esc(ord.type || '')) + ' · ' + (ord.items ? ord.items.length + ' รายการ' : '') + (p.received ? ' · รับ ' + money(p.received) : '') + ' · ' + day(x.op.at) + ' ' + hm(x.op.at) + '</p>' +
        '<div class="row gap"><button class="btn ghost grow" data-m="retry:' + i + '">ลองส่งใหม่</button><button class="btn ghost danger-t grow" data-m="drop:' + i + '">ทิ้ง</button></div></div>';
    }).join('') : '<p class="muted">ไม่มี</p>') + '<button class="btn ghost wide" data-m="no">ปิด</button>' +
      (S.outbox.length ? '<h4 class="mt">รอส่ง ' + S.outbox.length + ' รายการ</h4>' + S.outbox.map(function (x) { return '<p class="muted">' + x.action + ' #' + code(x.orderId) + ' · ลอง ' + x.tries + ' ครั้ง ' + esc(x.err || '') + '</p>'; }).join('') : '');
    var r = await modal(html, { cls: 'tall' });
    if (!r || r.act === 'no') return;
    var parts = r.act.split(':'), item = S.review[Number(parts[1])];
    if (!item) return;
    if (parts[0] === 'retry') {
      S.review.splice(Number(parts[1]), 1); save('review', S.review);
      item.op.opId = opid(); item.op.tries = 0;
      if (item.op.action === 'saveOrder' && item.error === 'TABLE_BUSY') { var t = await askText('โต๊ะซ้ำ', 'ย้ายไปโต๊ะ', '', 'numeric'); if (!t) { S.review.push(item); save('review', S.review); return; } item.op.payload.order.table = t; }
      S.outbox.push(item.op); save('outbox', S.outbox); flush();
    } else if (parts[0] === 'drop') {
      if (await confirmBox('ทิ้งรายการนี้?', 'รายการนี้จะไม่ถูกส่งเข้าระบบ ตรวจให้แน่ใจว่าไม่ใช่ยอดจริง', 'ทิ้ง', true)) { S.review.splice(Number(parts[1]), 1); save('review', S.review); pull(); }
    }
    renderStatus();
  }

  /* ---------------- boot ---------------- */
  window.addEventListener('printer-change', renderStatus);
  if (S.auth && S.auth.lockHash) S.locked = true;
  if (S.cur) S.view = 'order';
  render();
  if (S.auth) { if (!S.locked) pull(); loadImages(false); flush(); }
  setInterval(function () { if (document.visibilityState === 'visible' && !S.locked && S.view !== 'pay') { if (S.outbox.length) flush(); else pull(); } }, POLL_MS);
  setInterval(renderStatus, 30000);
  window.addEventListener('beforeunload', function (e) { if (S.outbox.length) { e.preventDefault(); e.returnValue = ''; } });
})();
