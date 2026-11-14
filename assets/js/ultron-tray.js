/* What the system-tray icon can see and do: it asks trayInfo() what is playing and sends commands through trayCmd(). */
(function () {
    function vid() { try { return (typeof playingId !== 'undefined') && playingId; } catch (e) { return null; } }
    window.trayInfo = function () {
        var r = { title: '', artist: '', playing: false, video: false, muted: false };
        try {
            var v = vid();
            if (v) {
                r.video = true; r.title = (document.getElementById('player-title') || {}).textContent || '';
                r.playing = !player.paused; r.muted = !!player.muted;
            } else if (typeof nowId !== 'undefined' && nowId) {
                r.title = (document.getElementById('np-title') || {}).textContent || '';
                r.artist = (document.getElementById('np-artist') || {}).textContent || '';
                r.playing = !audio.paused; r.muted = !!audio.muted;
            }
        } catch (e) {}
        return r;
    };
    window.trayCmd = function (name) {
        try {
            var v = vid();
            if (name === 'toggle') { if (v) togglePlayVideo(); else togglePlay(); }
            else if (name === 'next') { if (v) { if (typeof playNextNow === 'function') playNextNow(); } else nextTrack(); }
            else if (name === 'prev') { if (!v) prevTrack(); else { player.currentTime = 0; } }
            else if (name === 'mute') { var m = v ? player : audio; m.muted = !m.muted; }
        } catch (e) {}
    };
})();
