/* ULTRON persist: keeps every browser-side setting (theme, palette, flair, DJ, layout...) in data/localstore.json,
   so nothing is lost when the app closes. Loaded first, synchronously, before any other script reads storage. */
(function () {
  'use strict';
  var SKIP = /^lmp_private_token$/, LS;
  try { LS = window.localStorage; LS.length; } catch (e) { return; }
  var ready = false;
  try {                                                   /* 1. restore: the server copy wins for keys it has */
    var x = new XMLHttpRequest(); x.open('GET', '/api/ls', false); x.send(null);
    if (x.status === 200) {
      var d = JSON.parse(x.responseText || '{}');
      Object.keys(d).forEach(function (k) { if (!SKIP.test(k)) LS.setItem(k, d[k]); });
    }
    ready = true;
  } catch (e) {}
  var timer = 0, busy = false, again = false;
  function snapshot() {
    var o = {};
    for (var i = 0; i < LS.length; i++) { var k = LS.key(i); if (!SKIP.test(k)) o[k] = LS.getItem(k); }
    return o;
  }
  function push(sync) {
    timer = 0;
    if (!ready && !sync) return;
    var body = JSON.stringify(snapshot());
    try {
      if (sync) { var r = new XMLHttpRequest(); r.open('POST', '/api/ls', false); r.setRequestHeader('Content-Type', 'application/json'); r.setRequestHeader('X-LMP', '1'); r.send(body); return; }
      if (busy) { again = true; return; }
      busy = true;
      fetch('/api/ls', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LMP': '1' }, body: body, keepalive: body.length < 60000 })
        .catch(function () {}).then(function () { busy = false; if (again) { again = false; queue(); } });
    } catch (e) { busy = false; }
  }
  function queue() { if (!timer) timer = setTimeout(push, 400); }
  try {                                                   /* 2. save: every write is mirrored (debounced) */
    var P = Storage.prototype, s = P.setItem, rm = P.removeItem, cl = P.clear;
    P.setItem = function (k, v) { s.apply(this, arguments); if (this === LS) queue(); };
    P.removeItem = function (k) { rm.apply(this, arguments); if (this === LS) queue(); };
    P.clear = function () { cl.apply(this, arguments); if (this === LS) queue(); };
  } catch (e) {}
  window.addEventListener('pagehide', function () { if (timer) { clearTimeout(timer); push(true); } });
  window.addEventListener('beforeunload', function () { if (timer) { clearTimeout(timer); push(true); } });
  if (ready && !LS.getItem('lmp_persist_init')) { LS.setItem('lmp_persist_init', '1'); }   /* first run: mirror what is already there */
})();
