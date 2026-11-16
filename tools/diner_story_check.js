// Checks assets/js/diner-story.js against the format the engine (assets/js/diner-talk.js) plays. No dependencies.
// Usage: node tools/diner_story_check.js        prints "OK n scenes, n steps" or the errors (exit code 1).
// It never rewrites the script: list script errors for the author. Keep the token patterns below in step with tok() / fx() in diner-talk.js.
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var file = path.join(__dirname, '..', 'assets', 'js', 'diner-story.js');
var win = {}; vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window: win }, { filename: file });
var S = win.DINER_STORY, errs = [], steps = 0;
function err(where, msg) { errs.push(where + ': ' + msg); }
if (!S || !S.scenes || !S.order) { console.log('no DINER_STORY'); process.exit(1); }

var COND = [/^(t|p|d|loop|pages)(>=|<=|>|<|=)\d+$/, /^top=[tpd]$/, /^(lamp|fairy|sign|pic|wx)=\d+$/, /^(dark|playing|empty|name)$/, /^f:\w+$/, /^end:\w+$/];
var FX = [/^[tpd][+-]\d+$/, /^f:\w+$/, /^f-\w+$/, /^cup:[01]$/, /^own:1$/, /^set:(lamp|fairy|sign|pic|wx)=\d+$/, /^page:\w+$/, /^end:\w+$/];
var VARS = ['name', 'art', 'they', 'them', 'their', 'They', 'Their', 's', 'is', 'has', 'was'];
var ON = ['x-lamp', 'x-fairy', 'x-sign', 'x-wx', 'x-pic', 'x-sip', 'x-sugar', 'x-leaves', 'x-zoom', 'x-cat', 'draw', 'art', 'empty', 'skip', 'play', 'fireworks', 'book'];
function chkCond(where, c) { String(c).split(/\s+/).forEach(function (t) { if (!t) return; var u = t.replace(/^!/, ''); if (!COND.some(function (r) { return r.test(u); })) err(where, 'bad cond token "' + t + '"'); }); }
function chkFx(where, f) { String(f).split(/\s+/).forEach(function (t) { if (!t) return; if (!FX.some(function (r) { return r.test(t); })) err(where, 'bad fx token "' + t + '"'); }); }
function chkText(where, t) {
    if (typeof t !== 'string' || !t) { err(where, 'text must be a non-empty string'); return; }
    var re = /\{([^}]*)\}/g, m; while ((m = re.exec(t))) { var k = m[1].split('|')[0]; if (VARS.indexOf(k) < 0) err(where, 'unknown variable {' + m[1] + '}'); if (/[{]/.test(m[1])) err(where, 'bad braces'); }
    if (/[{}]/.test(t.replace(/\{[^}]*\}/g, ''))) err(where, 'stray brace');
}

S.order.forEach(function (id) { if (!S.scenes[id]) err('order', 'scene "' + id + '" is missing'); });
Object.keys(S.scenes).forEach(function (id) {
    var sc = S.scenes[id], st = sc.steps, W = function (i) { return id + '#' + i; }, labels = {};
    if (sc.where !== 'book' && sc.where !== 'stool') err(id, 'where must be book or stool');
    if (sc.gate) chkCond(id + ' gate', sc.gate);
    if (!st || !st.length) { err(id, 'no steps'); return; }
    st.forEach(function (s, i) { if (s[0] === '#') { if (labels[s[1]]) err(W(i), 'duplicate label ' + s[1]); labels[s[1]] = i; } });
    function need(i, l) { if (typeof l !== 'string' || !(l in labels)) err(W(i), 'jump to missing label "' + l + '"'); }
    st.forEach(function (s, i) {
        steps++;
        if (!Array.isArray(s)) { err(W(i), 'step is not an array'); return; }
        var k = s[0];
        if (k === 'j' || k === 'n') chkText(W(i), s[1]);
        else if (k === '?') {
            if (s.length < 3 || s.length > 5) { err(W(i), 'a reply list needs 2 to 4 options'); return; }
            s.slice(1).forEach(function (o) {
                if (!Array.isArray(o) || typeof o[0] !== 'string') { err(W(i), 'bad reply'); return; }
                chkText(W(i), o[0]); chkFx(W(i), o[1] || ''); if (o[2]) need(i, o[2]);
            });
        }
        else if (k === '#') { if (typeof s[1] !== 'string') err(W(i), 'label'); }
        else if (k === '>') need(i, s[1]);
        else if (k === 'if') { chkCond(W(i), s[1]); need(i, s[2]); }
        else if (k === 'do') chkFx(W(i), s[1]);
        else if (k === 'hold') { chkCond(W(i), s[1]); if (!(s[2] > 0)) err(W(i), 'seconds'); need(i, s[3]); need(i, s[4]); chkText(W(i), s[5]); }
        else if (k === 'ask') { if (s[1] !== 'name') err(W(i), 'ask only supports name'); chkText(W(i), s[2]); }
        else if (k === 'go') { if (!S.scenes[s[1]]) err(W(i), 'go to missing scene "' + s[1] + '"'); }
        else if (k === 'end') { }
        else err(W(i), 'unknown step "' + k + '"');
    });
    // no path runs forever: every step must be able to reach an end, and no loop may be made only of silent steps (if, jump, label, do)
    var next = function (i) {
        var s = st[i], k = s[0], out = [];
        if (k === 'end' || k === 'go') return out;
        if (k === '>') return [labels[s[1]]];
        if (k === 'if') return [labels[s[2]], i + 1];
        if (k === '?') { s.slice(1).forEach(function (o) { out.push(o[2] ? labels[o[2]] : i + 1); }); return out; }
        if (k === 'hold') return [labels[s[3]], labels[s[4]]];
        return [i + 1];
    };
    var memo = {};
    function ends(i, seen) {
        if (i === undefined) return false; if (i >= st.length) return true;
        if (memo[i] !== undefined) return memo[i]; if (seen[i]) return false; seen[i] = 1;
        var n = next(i), r = n.length === 0 || n.some(function (j) { return ends(j, seen); }); delete seen[i];
        if (r) memo[i] = true; return r;
    }
    st.forEach(function (s, i) { if (!Array.isArray(s)) return; if (!ends(i, {})) err(W(i), 'cannot reach an end (loops forever)'); });
    var silent = { '#': 1, '>': 1, 'if': 1, 'do': 1 };
    function loop(i, seen) {
        if (i >= st.length || !st[i] || !silent[st[i][0]]) return false; if (seen[i]) return true; seen[i] = 1;
        var r = next(i).some(function (j) { return j !== undefined && loop(j, seen); }); delete seen[i]; return r;
    }
    st.forEach(function (s, i) { if (silent[s[0]] && loop(i, {})) err(W(i), 'a loop with nothing shown in it'); });
});
(S.react || []).forEach(function (r, i) {
    var w = 'react[' + i + ']';
    if (ON.indexOf(r.on) < 0) err(w, 'unknown on "' + r.on + '"');
    if (r.if) chkCond(w, r.if); if (r.fx) chkFx(w, r.fx); if (r.only && !S.scenes[r.only]) err(w, 'only: missing scene');
    if (!Array.isArray(r.say) || !r.say.length) err(w, 'say'); else r.say.forEach(function (l) { if (l[0] !== 'j' && l[0] !== 'n') err(w, 'say line kind'); else chkText(w, l[1]); });
});
Object.keys(S.after || {}).forEach(function (k) { (S.after[k] || []).forEach(function (t, i) { chkText('after.' + k + '[' + i + ']', t); }); });
['stay', 'song', 'day', 'morning'].forEach(function (e) { if (!S.scenes['end_' + e]) err('endings', 'scene end_' + e + ' is missing'); if (!S.after[e]) err('endings', 'after.' + e + ' is missing'); });

if (errs.length) { console.log(errs.length + ' problem(s):\n' + errs.join('\n')); process.exit(1); }
console.log('OK ' + Object.keys(S.scenes).length + ' scenes, ' + steps + ' steps');
