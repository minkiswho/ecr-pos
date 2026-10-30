// Minimal in-memory Google Apps Script mock for backend tests
const vm = require('vm');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function makeSheet(name, rows) {
  const data = rows ? rows.map(r => r.slice()) : [];
  const fmts = {};
  const s = {
    name, data, fmts,
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
        getValue() { return this.getValues()[0][0]; },
        setValues(vals) { vals.forEach((row, i) => { while (data.length < r + i) data.push([]); row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; }); }); },
        setValue(v) { this.setValues([[v]]); },
        setNumberFormat(f) { fmts[r + ':' + c] = f; },
      };
    },
    appendRow(row) { data.push(row.slice()); },
    deleteRow(r) { data.splice(r - 1, 1); },
  };
  return s;
}

function makeSpreadsheet(sheets) {
  const map = {};
  Object.keys(sheets).forEach(k => { map[k] = makeSheet(k, sheets[k]); });
  return {
    map,
    getSheetByName: n => map[n] || null,
    insertSheet: n => (map[n] = makeSheet(n, [])),
  };
}

function load(branchFile, spreadsheets, props = {}) {
  const store = Object.assign({}, props);
  const cache = {};
  const sent = [];
  const triggers = [];
  const ctx = {
    console,
    JSON, Math, Date, Number, String, Array, Object, Error, isFinite, parseInt,
    SpreadsheetApp: { openById: id => { if (!spreadsheets[id]) throw new Error('no sheet ' + id); return spreadsheets[id]; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate(d, tz, f) {
        const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
        if (p.hour === '24') p.hour = '00';
        return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('H', String(Number(p.hour))).replace('mm', p.minute);
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
    UrlFetchApp: { fetch: (url, o) => { sent.push(o.payload.text); return { getContentText: () => '{"ok":true}', getResponseCode: () => 200 }; } },
    Logger: { log: () => {} },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: () => {}, newTrigger: h => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push({ getHandlerFunction: () => h }) }) }) }) },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'apps-script');
  vm.runInContext(fs.readFileSync(path.join(dir, branchFile), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'), ctx);
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, call, store, sent };
}

module.exports = { load, makeSpreadsheet };
