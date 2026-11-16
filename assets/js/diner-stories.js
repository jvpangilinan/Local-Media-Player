/* The Diner: your own stories. Folders in DATA_DIR/stories/<name>/ hold story.txt plus pictures; the server compiles them
   (/api/stories/<id>) into the format diner-talk.js plays. Juno's story (window.DINER_STORY) stays the default.
   Follows prefs.diner_story; falls back to Juno when the story is missing or has errors. Settings row: #story-pick etc. */
(function () {
    'use strict';
    var JUNO = window.DINER_STORY, KEY = 'ultron_diner_story', cur = null, busy = false;
    function pref() { try { return (typeof prefs !== 'undefined' && prefs) || {}; } catch (e) { return {}; } }
    function $(i) { return document.getElementById(i); }
    function api(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

    function errs(list) { var b = $('story-errs'); if (!b) return; b.textContent = ''; (list || []).forEach(function (e) { var d = document.createElement('div'); d.textContent = 'line ' + e.line + ': ' + e.msg; b.appendChild(d); }); b.classList.toggle('hidden', !(list && list.length)); }

    // make the engine play the chosen story; true when it took
    function apply(id, force) {
        if (!window.dinerTalk || !window.dinerTalk.use) return;
        if (!force && id === cur) return;
        if (!id) { if (window.dinerTalk.use(JUNO, KEY)) { cur = ''; hookRoom('', {}); } return; }
        if (busy) return; busy = true;
        api('/api/stories/' + encodeURIComponent(id)).then(function (s) {
            busy = false; errs(s.errors);
            if (s.errors && s.errors.length) { apply('', true); return; }
            var st = s.story; st.user = true; st.title = s.title;
            if (window.dinerTalk.use(st, KEY + ':' + id)) { cur = id; hookRoom('/stories/' + encodeURIComponent(id) + '/', s.pics); }
        }).catch(function () { busy = false; errs([]); apply('', true); });
    }
    function hookRoom(base, pics) { try { if (window.dinerStoryHook) window.dinerStoryHook(base, pics); } catch (e) {} }

    function paintRow() {
        var sel = $('story-pick'); if (!sel) return;
        api('/api/stories').then(function (d) {
            var want = pref().diner_story || '', ids = (d.stories || []).map(function (s) { return s.id; });
            sel.textContent = '';
            var o = document.createElement('option'); o.value = ''; o.textContent = "Juno's story (built in)"; sel.appendChild(o);
            (d.stories || []).forEach(function (s) { var p = document.createElement('option'); p.value = s.id; p.textContent = (s.title || s.id) + (s.errors && s.errors.length ? ' (has errors)' : ''); sel.appendChild(p); });
            sel.value = ids.indexOf(want) >= 0 ? want : '';
            var me = (d.stories || []).filter(function (s) { return s.id === sel.value; })[0]; errs(me ? me.errors : []);
        }).catch(function () {});
    }
    window.dinerStories = {
        pick: function (id) { if (typeof setPref === 'function') setPref({ diner_story: id || '' }); apply(id || '', true); },
        reload: function () { paintRow(); apply(pref().diner_story || '', true); },
        again: function () { var id = pref().diner_story || ''; try { localStorage.removeItem(id ? KEY + ':' + id : KEY); } catch (e) {} apply(id, true); },
        open: function () {
            fetch('/api/stories/open', { method: 'POST', headers: { 'X-LMP': '1' } }).then(function (r) { return r.json().catch(function () { return {}; }); })
                .then(function (j) { if (j.error && typeof toast === 'function') toast(j.error); setTimeout(paintRow, 800); }).catch(function () {});
        }
    };

    var _ps = window.paintSettings;
    if (typeof _ps === 'function') window.paintSettings = function () { var r = _ps.apply(this, arguments); try { paintRow(); apply(pref().diner_story || ''); } catch (e) { console.error(e); } return r; };
    function boot() { apply(pref().diner_story || ''); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); }); else setTimeout(boot, 0);
})();
