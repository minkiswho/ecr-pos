/* ECR POS — Bluetooth (BLE) ESC/POS printer: Thai text rendered as image */
(function () {
  'use strict';
  var SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000fee7-0000-1000-8000-00805f9b34fb', '0000ae30-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ff80-0000-1000-8000-00805f9b34fb'
  ];
  var P = { device: null, ch: null, name: '', busy: false };

  function supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

  async function findChar(server) {
    var services = await server.getPrimaryServices();
    for (var i = 0; i < services.length; i++) {
      var chars = [];
      try { chars = await services[i].getCharacteristics(); } catch (e) { continue; }
      for (var j = 0; j < chars.length; j++) {
        var c = chars[j];
        if (c.properties.writeWithoutResponse || c.properties.write) return c;
      }
    }
    throw new Error('ไม่พบช่องส่งข้อมูลของเครื่องพิมพ์');
  }

  async function attach(device) {
    var server = await device.gatt.connect();
    P.ch = await findChar(server);
    P.device = device;
    P.name = device.name || 'Printer';
    device.addEventListener('gattserverdisconnected', function () { P.ch = null; emit(); });
    try { localStorage.setItem('ecr_printer_id', device.id); localStorage.setItem('ecr_printer_name', P.name); } catch (e) { }
    emit();
    return P.name;
  }

  async function connect() {
    if (!supported()) throw new Error('เครื่องนี้ไม่รองรับ Bluetooth ผ่านเว็บ (ใช้ Chrome บน Android)');
    var device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    return attach(device);
  }

  async function reconnect() {
    if (P.ch) return true;
    try {
      if (P.device) { await attach(P.device); return true; }
      if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
      var id = localStorage.getItem('ecr_printer_id');
      var list = await navigator.bluetooth.getDevices();
      var d = list.filter(function (x) { return x.id === id; })[0];
      if (!d) return false;
      await attach(d);
      return true;
    } catch (e) { return false; }
  }

  function disconnect() {
    try { if (P.device && P.device.gatt.connected) P.device.gatt.disconnect(); } catch (e) { }
    P.ch = null; P.device = null;
    try { localStorage.removeItem('ecr_printer_id'); } catch (e) { }
    emit();
  }

  function emit() { try { window.dispatchEvent(new CustomEvent('printer-change')); } catch (e) { } }

  async function write(bytes) {
    var ch = P.ch;
    if (!ch) throw new Error('ยังไม่ได้เชื่อมต่อเครื่องพิมพ์');
    var size = 180;
    var noResp = !!ch.properties.writeWithoutResponse && !!ch.writeValueWithoutResponse;
    for (var i = 0; i < bytes.length; i += size) {
      var part = bytes.slice(i, i + size);
      if (noResp) await ch.writeValueWithoutResponse(part);
      else if (ch.writeValueWithResponse) await ch.writeValueWithResponse(part);
      else await ch.writeValue(part);
      if (noResp && (i / size) % 8 === 7) await new Promise(function (r) { setTimeout(r, 25); });
    }
  }

  function rasterize(canvas) {
    var w = canvas.width, h = canvas.height;
    var data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var bw = Math.ceil(w / 8);
    var out = new Uint8Array(8 + bw * h);
    out.set([0x1d, 0x76, 0x30, 0x00, bw & 255, (bw >> 8) & 255, h & 255, (h >> 8) & 255], 0);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = (y * w + x) * 4;
        var lum = data[k] * 0.3 + data[k + 1] * 0.59 + data[k + 2] * 0.11;
        if (data[k + 3] > 0 && lum < 160) out[8 + y * bw + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    return out;
  }

  async function printCanvas(canvas) {
    if (P.busy) throw new Error('กำลังพิมพ์อยู่');
    P.busy = true;
    try {
      if (!P.ch) { var ok = await reconnect(); if (!ok) throw new Error('ยังไม่ได้เชื่อมต่อเครื่องพิมพ์'); }
      await write(new Uint8Array([0x1b, 0x40]));
      // send in bands of 128 rows to keep printer buffer happy
      var band = 128, w = canvas.width;
      for (var y = 0; y < canvas.height; y += band) {
        var h = Math.min(band, canvas.height - y);
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(canvas, 0, y, w, h, 0, 0, w, h);
        await write(rasterize(c));
      }
      await write(new Uint8Array([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]));
    } finally { P.busy = false; }
  }

  /* ---------- receipt layout ---------- */
  // doc = [{t:'text', s:'...', size:26, bold, align:'left|center|right', right:'...'} , {t:'hr'}, {t:'gap', h}, {t:'img', img}]
  function render(doc, paperMM) {
    var W = paperMM === 58 ? 384 : 576;
    var pad = 8;
    var font = function (size, bold) { return (bold ? '700 ' : '400 ') + size + 'px "Sarabun","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif'; };
    var probe = document.createElement('canvas').getContext('2d');
    var ops = [], y = pad;
    doc.forEach(function (b) {
      if (b.t === 'hr') { ops.push({ t: 'hr', y: y + 8 }); y += 18; return; }
      if (b.t === 'gap') { y += b.h || 10; return; }
      if (b.t === 'img' && b.img) {
        var iw = Math.min(b.w || 220, W - pad * 2), ih = iw * (b.img.height / b.img.width || 1);
        ops.push({ t: 'img', img: b.img, x: (W - iw) / 2, y: y, w: iw, h: ih }); y += ih + 6; return;
      }
      var size = b.size || 26, lh = Math.round(size * 1.35);
      probe.font = font(size, b.bold);
      var rightW = b.right ? probe.measureText(b.right).width + 16 : 0;
      var maxW = W - pad * 2 - rightW;
      var words = String(b.s || '').split(/(\s+)/), line = '', lines = [];
      words.forEach(function (wd) {
        var test = line + wd;
        if (probe.measureText(test).width > maxW && line.trim()) { lines.push(line.trim()); line = wd.trimStart(); }
        else line = test;
      });
      if (line.trim() || !lines.length) lines.push(line.trim());
      // hard-wrap very long tokens (Thai has no spaces)
      var wrapped = [];
      lines.forEach(function (l) {
        var cur = '';
        Array.from(l).forEach(function (ch) {
          if (probe.measureText(cur + ch).width > maxW && cur) { wrapped.push(cur); cur = ch; } else cur += ch;
        });
        wrapped.push(cur);
      });
      wrapped.forEach(function (l, i) {
        ops.push({ t: 'text', s: l, size: size, bold: b.bold, align: b.align, y: y + size, right: i === 0 ? b.right : '' });
        y += lh;
      });
    });
    y += pad;
    var c = document.createElement('canvas');
    c.width = W; c.height = Math.ceil(y);
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, c.height);
    g.fillStyle = '#000'; g.strokeStyle = '#000'; g.textBaseline = 'alphabetic';
    ops.forEach(function (o) {
      if (o.t === 'hr') { g.setLineDash([6, 4]); g.lineWidth = 2; g.beginPath(); g.moveTo(pad, o.y); g.lineTo(W - pad, o.y); g.stroke(); g.setLineDash([]); return; }
      if (o.t === 'img') { g.drawImage(o.img, o.x, o.y, o.w, o.h); return; }
      g.font = font(o.size, o.bold);
      var x = pad;
      if (o.align === 'center') x = (W - g.measureText(o.s).width) / 2;
      else if (o.align === 'right') x = W - pad - g.measureText(o.s).width;
      g.fillText(o.s, x, o.y);
      if (o.right) g.fillText(o.right, W - pad - g.measureText(o.right).width, o.y);
    });
    return c;
  }

  window.ECRPrinter = {
    supported: supported, connect: connect, reconnect: reconnect, disconnect: disconnect,
    printCanvas: printCanvas, render: render,
    status: function () { return { connected: !!P.ch, name: P.name || localStorage.getItem('ecr_printer_name') || '' }; }
  };
})();
