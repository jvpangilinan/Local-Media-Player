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
  var rated = {};                                   // ratings sent from the phone (the page does not keep them per video)
  var sleep = { at: 0, eov: false, base: null };
  function sleepState() { return sleep.eov ? { mode: 'eov' } : sleep.at ? { mode: 'min', left: Math.max(0, Math.round((sleep.at - Date.now()) / 1000)) } : null; }
  function state() {
    try {
      if (typeof playingId !== 'undefined' && playingId) {
        var priv = scopeOf(playingId) === 'private', d = player.duration;
        var subs = [].slice.call(player.textTracks || []).map(function (t, i) { return { id: i, on: t.mode === 'showing', lang: t.language || '', label: t.label || t.language || 'Subtitle ' + (i + 1) }; });
        return { kind: 'video', private: priv, id: priv ? null : playingId, vid: priv ? null : playingId, title: priv ? '' : (titles[playingId] || ''),
                 sub: priv ? '' : (playInfo && playInfo.series ? playInfo.series + ' · Episode ' + playInfo.index + ' of ' + playInfo.total : ''),
                 series_id: priv ? null : (playInfo && playInfo.series_id) || null, rating: priv ? null : (rated[playingId] || null),
                 pos: player.currentTime || 0, dur: isFinite(d) && d > 0 ? d : 0, paused: !!player.paused, speed: player.playbackRate || 1,
                 vol: player.volume, muted: !!player.muted, has_next: !!(playInfo && playInfo.next), has_prev: !!(playInfo && playInfo.prev),
                 subs: subs, audios: [], can_audio: false, can_chapters: false, sleep: sleepState() };
      }
      if (typeof nowId !== 'undefined' && nowId && queue.length && pos >= 0) {
        var t = queue[order[pos]] || {}, ad = audio.duration, up = [];
        for (var k = pos; k < Math.min(order.length, pos + 16); k++) { var q = queue[order[k]] || {}; up.push({ p: k, title: q.title || '', artist: q.artist || '', tid: q.id }); }
        return { kind: 'music', tid: t.id, liked: typeof likedIds !== 'undefined' && likedIds.has(t.id), title: t.title || '', sub: [t.artist, t.album].filter(Boolean).join(' · '),
                 pos: audio.currentTime || 0, dur: isFinite(ad) && ad > 0 ? ad : 0, paused: !!audio.paused, speed: 1,
                 vol: audio.volume, muted: !!audio.muted, has_next: true, has_prev: true, queue: up, qpos: pos, sleep: sleepState() };
      }
    } catch (e) {}
    return { kind: 'none' };
  }
  // sleep timer for the in-window player and music (the native player has its own): fade the last 20 s, then pause
  function media() { return (typeof playingId !== 'undefined' && playingId) ? player : (typeof nowId !== 'undefined' && nowId) ? audio : null; }
  function setSleep(v) {
    var m = media();
    if (sleep.base != null && m) m.volume = sleep.base;
    sleep = { at: 0, eov: false, base: null };
    if (v === 'eov') sleep.eov = true; else if (v) sleep.at = Date.now() + v * 60000;
    if (typeof toast === 'function') toast(v === 'eov' ? 'Sleep timer: stops after this one' : v ? 'Sleep timer: ' + v + ' minutes' : 'Sleep timer off');
  }
  function sleepTick() {
    if (!sleep.at) return;
    var m = media(), left = sleep.at - Date.now();
    if (!m) return;
    if (left > 20000) return;
    if (sleep.base == null) sleep.base = m.volume;
    if (left > 0) { m.volume = sleep.base * left / 20000; return; }
    m.pause(); m.volume = sleep.base; sleep = { at: 0, eov: false, base: null };
    if (typeof toast === 'function') toast('Sleep timer: paused. Good night', 5000);
  }
  function endedSleep(m) { if (!sleep.eov) return; sleep.eov = false; setTimeout(function () { try { if (typeof hideNext === 'function') hideNext(); m.pause(); } catch (e) {} }, 60); }
  try { player.addEventListener('ended', function () { endedSleep(player); }); audio.addEventListener('ended', function () { endedSleep(audio); }); } catch (e) {}

  function musicSource(a) {
    if (a.kind === 'playlist') return { type: 'playlist', id: a.id, title: 'Playlist' };
    if (a.kind === 'liked') { var lp = (typeof playlists !== 'undefined' ? playlists : []).filter(function (p) { return p.liked; })[0]; return lp ? { type: 'playlist', id: lp.id, title: lp.name } : null; }
    if (a.kind === 'recent') return recentSrc();
    if (a.kind === 'album') return { type: 'filter', filter: { album: a.id }, title: 'Album' };
    if (a.kind === 'search') return { type: 'filter', filter: { q: a.q }, title: 'Search' };
    return allSrc();
  }
  function playMusic(a) {
    var src = musicSource(a);
    if (!src) { toast('Nothing to play there yet'); return; }
    fetchSource(src).then(function (r) {
      if (!r.tracks.length) { toast('Nothing to play there yet'); return; }
      if (typeof playingId !== 'undefined' && playingId) closePlayer();
      playList(r.tracks, a.shuffle ? Math.floor(Math.random() * r.tracks.length) : Math.min(a.start || 0, r.tracks.length - 1), a.shuffle ? true : undefined);
    }).catch(function (e) { toast(errMsg(e)); });
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
      case 'play_video':
        if (!a) return;
        window.__remoteFront = true;                       // the native player opens fullscreen and in front (app.js playNative)
        Promise.resolve(playVideo(String(a))).then(function () {
          window.__remoteFront = false;
          if (typeof playingId !== 'undefined' && playingId) front(true);   // built-in player: bring the app forward, fullscreen
        });
        return;
      case 'shuffle_music': playSource(allSrc(), true); return;
      case 'play_music': playMusic(a); return;
      case 'surprise': if (typeof surprise === 'function') { window.__remoteFront = true; surprise('public'); setTimeout(function () { window.__remoteFront = false; if (playingId) front(true); }, 1200); } return;
      case 'heart': if (typeof toggleLike === 'function') toggleLike(null, String(a)); return;
      case 'rate': rated[a.id] = a.stars; post('/api/videos/' + encodeURIComponent(a.id) + '/rating', { stars: a.stars }).then(function () { toast(a.stars ? 'Rated ' + a.stars + ' stars' : 'Rating cleared'); }).catch(function () {}); return;
      case 'queue_jump': if (typeof jumpTo === 'function' && typeof nowId !== 'undefined' && nowId) jumpTo(a); return;
      case 'sleep': setSleep(a); return;
      case 'pc_mute':                                        // the sound moved to the phone (or came back)
        if (typeof playingId !== 'undefined' && playingId) { player.muted = !!a; if (!a) privAutoMuted = false; }
        else if (typeof audio !== 'undefined') { audio.muted = !!a; try { paintAudioVol(); } catch (e) {} }
        if (typeof toast === 'function') toast(a ? 'Sound is on your phone' : 'Sound is back on the PC');
        return;
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
        case 'fullscreen': front(!isFS); break;
        case 'sub': if (typeof setCC === 'function') setCC(a === 'off' ? -1 : a); break;
        case 'speed': if (typeof setSpeed === 'function') setSpeed(a); break;
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
  function front(fs) {
    post('/api/instance/show', {}).catch(function () {});          // the window comes forward even while you are on another app
    try { setFS(fs); } catch (e) {}
  }
  function loop() {
    if (looping) return;
    looping = true;
    clearInterval(reportT); reportT = setInterval(function () { sleepTick(); report(false); }, 1000);
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
