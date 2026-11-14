/* Phone remote, page side (see remote.py).
   - Settings > Phone remote: switch on / off, QR code, PIN, forget phones.
   - While the remote is on: picks up the phone's commands (long poll) and reports what is playing once a second.
   Uses app.js globals: player, playingId, playInfo, audio, nowId, queue, order, pos, scopeOf, titles,
   togglePlayVideo, skip, stepEpisode, setVol, toggleMute, closePlayer, playVideo, togglePlay, nextTrack, prevTrack,
   userSeekTo, toggleAudioMute, paintAudioVol, playSource, allSrc. */
(function () {
  'use strict';
  var on = false, looping = false, reportT = null, lastSent = '';

  // ---------------------------------------------------------------- settings section
  function paint(d) {
    var box = document.getElementById('rm-box');
    if (!box || !d) return;
    on = !!d.enabled;
    document.getElementById('rm-toggle').classList.toggle('on', on);
    document.getElementById('rm-toggle-txt').textContent = on ? 'On' : 'Off';
    var live = document.getElementById('rm-live');
    live.classList.toggle('hidden', !on);
    if (!on) return;
    var qr = document.getElementById('rm-qr');
    if (d.qr) { qr.src = d.qr; qr.classList.remove('hidden'); } else qr.classList.add('hidden');
    document.getElementById('rm-url').textContent = d.url || 'No network found. Connect this PC to Wi-Fi or a router.';
    document.getElementById('rm-pin').textContent = d.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
    document.getElementById('rm-phones').textContent = d.phones ? d.phones + (d.phones === 1 ? ' phone paired' : ' phones paired') : 'No phone paired yet';
    if (!d.running) document.getElementById('rm-url').textContent = 'Could not open the network port (47400-47403 busy?).';
  }
  function refresh() { return api('/api/remote/info').then(function (d) { paint(d); if (d.enabled) loop(); return d; }).catch(function () {}); }
  window.remoteToggle = function () {
    post('/api/remote/enable', { on: !on }).then(function (d) {
      paint(d); if (d.enabled) { loop(); toast('Phone remote on. Windows may ask to allow ULTRON on your network: choose Private networks.', 9000); }
    }).catch(function (e) { toast(errMsg(e), 6000); });
  };
  window.remoteReset = function () {
    post('/api/remote/reset', {}).then(function (d) { paint(d); toast('New code made. Paired phones were forgotten.'); }).catch(function (e) { toast(errMsg(e), 6000); });
  };
  var prev = window.openSettings;
  window.openSettings = function () { var r = prev && prev.apply(this, arguments); refresh(); return r; };

  // ---------------------------------------------------------------- what is playing
  function state() {
    try {
      if (typeof playingId !== 'undefined' && playingId) {
        var priv = scopeOf(playingId) === 'private', d = player.duration;
        return { kind: 'video', private: priv, id: priv ? null : playingId, title: priv ? '' : (titles[playingId] || ''),
                 sub: priv ? '' : (playInfo && playInfo.series ? playInfo.series + ' · Episode ' + playInfo.index + ' of ' + playInfo.total : ''),
                 pos: player.currentTime || 0, dur: isFinite(d) && d > 0 ? d : 0, paused: !!player.paused,
                 vol: player.volume, muted: !!player.muted, has_next: !!(playInfo && playInfo.next), has_prev: !!(playInfo && playInfo.prev) };
      }
      if (typeof nowId !== 'undefined' && nowId && queue.length && pos >= 0) {
        var t = queue[order[pos]] || {}, ad = audio.duration;
        return { kind: 'music', title: t.title || '', sub: [t.artist, t.album].filter(Boolean).join(' · '),
                 pos: audio.currentTime || 0, dur: isFinite(ad) && ad > 0 ? ad : 0, paused: !!audio.paused,
                 vol: audio.volume, muted: !!audio.muted, has_next: true, has_prev: true };
      }
    } catch (e) {}
    return { kind: 'none' };
  }
  function report(force) {
    if (!on) return;
    var s = state(); s.src = 'page';
    var key = JSON.stringify(s);
    if (!force && key === lastSent && s.kind === 'none') return;     // idle: say it once
    lastSent = key;
    post('/api/remote/status', s).catch(function () {});
  }

  // ---------------------------------------------------------------- the phone's commands
  function run(c) {
    var a = c.arg, video = typeof playingId !== 'undefined' && playingId;
    switch (c.cmd) {
      case 'play_video': if (a) playVideo(String(a)); return;
      case 'shuffle_music': playSource(allSrc(), true); return;
    }
    if (video) {
      switch (c.cmd) {
        case 'toggle': togglePlayVideo(); break;
        case 'seek_rel': skip(a); break;
        case 'seek_abs': player.currentTime = Math.max(0, Math.min(a, player.duration || 0)); break;
        case 'vol': setVol(a); break;
        case 'mute': toggleMute(); break;
        case 'next': stepEpisode(1); break;
        case 'prev': stepEpisode(-1); break;
        case 'close': closePlayer(); break;
      }
    } else if (typeof nowId !== 'undefined' && nowId) {
      switch (c.cmd) {
        case 'toggle': togglePlay(); break;
        case 'seek_rel': userSeekTo(Math.max(0, (audio.currentTime || 0) + a)); break;
        case 'seek_abs': userSeekTo(a); break;
        case 'vol': audio.volume = a; audio.muted = false; var v = document.getElementById('vol'); if (v) v.value = Math.round(a * 100); paintAudioVol(); break;
        case 'mute': toggleAudioMute(); break;
        case 'next': nextTrack(); break;
        case 'prev': prevTrack(); break;
      }
    }
  }
  function loop() {
    if (looping) return;
    looping = true;
    clearInterval(reportT); reportT = setInterval(function () { report(false); }, 1000);
    (function next() {
      fetch('/api/remote/poll?src=page', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.on) { looping = false; on = false; clearInterval(reportT); return; }   // switched off: stop until Settings turns it on
        (d.cmds || []).forEach(function (c) { try { run(c); } catch (e) { console.error('remote', e); } });
        if ((d.cmds || []).length) setTimeout(function () { report(true); }, 150);
        next();
      }).catch(function () { setTimeout(next, 5000); });
    })();
  }

  window.addEventListener('load', function () { setTimeout(refresh, 2500); });
})();
