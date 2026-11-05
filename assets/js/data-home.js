/* Settings > Your data: shows where the app keeps your data, and tells you once when it was brought over from an older version. */
(function () {
  'use strict';
  var info = null;
  function paint() {
    var el = document.getElementById('data-home-path');
    if (!el || !info) return;
    el.textContent = info.path;
    var why = document.getElementById('data-home-why');
    if (why) why.textContent = info.where === 'app-folder'
      ? 'This version keeps its data inside its own folder. Export a backup before you move to a newer version.'
      : info.where === 'custom'
        ? 'The data folder was chosen with the ZENO_DATA_DIR setting.'
        : 'Kept outside the app folder, so a newer version finds your password, favorites and settings by itself.';
  }
  window.openDataFolder = function () {
    post('/api/data/open').catch(function (e) { toast(errMsg(e), 6000); });
  };
  var prev = window.openSettings;
  window.openSettings = function () { var r = prev && prev.apply(this, arguments); paint(); return r; };
  window.addEventListener('load', function () {
    api('/api/data/info').then(function (d) {
      info = d; paint();
      if (d.imported_from) setTimeout(function () { toast('Brought over your password, favorites and settings from ' + d.imported_from, 9000); }, 1500);
    }).catch(function () {});
  });
})();
