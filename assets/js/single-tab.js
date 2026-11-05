/* One window at a time: a second tab or window of the app shows a notice instead of loading, so two copies never
   fight over playback, the database or ffmpeg. Uses the Web Locks API (the lock is released the moment the page closes).
   A reload keeps working: the new page waits a moment for the old one to let go. */
(function () {
  'use strict';
  if (!navigator.locks || !navigator.locks.request) return;
  var ctl = new AbortController();
  var gave = setTimeout(function () { ctl.abort(); }, 2500);
  navigator.locks.request('zeno-ui-window', { signal: ctl.signal }, function () {
    clearTimeout(gave);
    return new Promise(function () {});                       /* hold it for as long as this page lives */
  }).catch(function () {
    var show = function () {
      document.documentElement.innerHTML = '<head><meta charset="utf-8"><title>ZENO</title></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0c;color:#e8e8ea;font-family:system-ui,sans-serif;text-align:center"><div><div style="font-size:1.4rem;font-weight:800;letter-spacing:.12em;margin-bottom:.6rem">ALREADY OPEN</div><div style="color:#8a8a93;font-size:.9rem;max-width:26rem;line-height:1.5">ZENO is already running in another window or tab. Use that one, then close this.</div></div></body>';
      try { window.stop(); } catch (e) {}
    };
    show();
    document.addEventListener('DOMContentLoaded', show);
  });
})();
