/* ULTRON */
(function(){
// ---------- new music home ----------
let picks=[],picksTried=false;
async function loadPicks(){
  try{picks=(await api('/api/music/random?limit=10')).tracks||[];}catch(e){picks=[];}
  try{if(view.kind==='home')renderHome();}catch(e){}
}
window.rerollPicks=loadPicks;
window.playPick=function(i){if(picks[i])playList(picks,i);};
window.playAllPicks=function(){if(picks.length)playList(picks,0,true);};
window.renderHome=function(){
  const f=filtersData||{artists:[],languages:[],genres:[],total:0};
  const hr=new Date().getHours(),greet=hr<5||hr>=21?'Good night':hr<12?'Good morning':hr<17?'Good afternoon':'Good evening';
  REGS.home.clear(); shelfIds=[];
  const liked=playlists.find(p=>p.liked), mine=playlists.filter(p=>!p.liked);
  const tile=(cover,name,n,shuffle)=>`<div class="group flex items-center gap-4 rounded-md bg-white/[.08] hover:bg-white/[.16] overflow-hidden cursor-pointer transition-colors pr-3" onclick="openSrc(${n})">${cover}<span class="font-bold truncate flex-1">${esc(name)}</span><button class="h-10 w-10 flex-none rounded-full bg-accent flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" onclick="event.stopPropagation();playSrc(${n},${!!shuffle})"><i class="fas fa-play ml-0.5 text-sm"></i></button></div>`;
  const q=[];
  q.push(tile(likedBox('h-16 w-16 !rounded-none'),'Liked Songs',reg(liked?plSrc(liked):{type:'playlist',id:-1,key:'pl:-1',label:'Playlist',title:'Liked Songs',liked:true}),false));
  if(forYou&&forYou.discover.length)q.push(tile(tintBox('Discover','fa-wand-magic-sparkles','h-16 w-16 !rounded-none'),'Discover mix',reg(recSrc('Discover mix',forYou.discover)),false));
  if(recentTracks.length)q.push(tile(tintBox('New arrivals','fa-clock-rotate-left','h-16 w-16 !rounded-none'),'New arrivals',reg(recentSrc()),false));
  mine.slice(0,5).forEach(p=>q.push(tile(plCover(p,'h-16 w-16 !rounded-none'),p.name,reg(plSrc(p)),false)));
  if(f.total)q.push(tile(tintBox('All songs','fa-shuffle','h-16 w-16 !rounded-none'),'Shuffle all songs',reg(allSrc()),true));
  const st=(k,v)=>`<div><dt>${k}</dt><dd>${v}</dd></div>`;
  // language playlists: "English Mix", "African Mix", ... built from the language of your songs
  const mixes=f.languages.filter(l=>l.name!=='Unknown').map(l=>shelfCard(tintBox(l.name+' mix','fa-language text-4xl','w-full aspect-square'),l.name+' Mix',l.count+' songs',reg(langSrc(l)),true));
  // Home no longer repeats the playlists page: ten random songs to try, with a shuffle button for a new set
  if(!picks.length&&!picksTried){picksTried=true;loadPicks();}
  const pickCards=picks.map((t,i)=>`<div data-tid="${t.id}" class="group w-44 flex-none p-3 rounded-lg hover:bg-white/10 transition-colors cursor-pointer" onclick="playPick(${i})"><div class="relative mb-3">${coverBox([t.id],'w-full aspect-square')}<span class="absolute right-2 bottom-2 h-11 w-11 rounded-full bg-accent text-white shadow-xl flex items-center justify-center opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all"><i class="fas fa-play ml-0.5"></i></span></div><div class="font-semibold truncate">${esc(t.title)}</div><div class="text-sm text-gray-400 truncate">${esc(t.artist)}</div></div>`);
  const fresh=recentTracks.slice(0,20).map((t,i)=>trackCard(t,i));
  const listened=!!(forYou&&(forYou.top_artists_listened||[]).length);
  const arts=listened?[]:f.artists.slice(0,20).map(a=>shelfCard(coverBox([a.sample],'w-full aspect-square',true),a.name,'Artist',reg(artistSrc(a)),false));
  const more=(a,b)=>`<div class="flex items-center gap-4"><button onclick="${a}" class="text-sm font-bold text-gray-400 hover:text-white transition-colors">${b}</button></div>`;
  $('mv-home').innerHTML=`<div class="mh"><div><div class="mh-t">${greet}</div><div class="mh-s">ULTRON &middot; THE BOOTH</div></div>
    <dl>${st('Songs',f.total)}${st('Artists',f.artists.length)}${st('Playlists',mine.length)}${st('Plays',forYou?forYou.stats.plays:0)}</dl></div>
    ${(f.total&&!(forYou&&forYou.stats.plays)&&!mine.length)?'<div class="mh-hint"><i class="fas fa-chart-simple"></i>Play a song and your stats start counting here. Make a playlist and it shows up in your shelves.</div>':''}
    <div class="grid gap-3 mt-6 mb-8" style="grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))">${q.join('')}</div>
    ${f.total?'':'<div class="border border-dashed border-white/10 p-10 text-center text-gray-500">No music found yet. Put files in media/music and press rescan.</div>'}
    ${shelf('Fresh picks',pickCards,'<button onclick="rerollPicks()" class="text-sm font-bold text-gray-400 hover:text-white transition-colors" title="Pick 10 other songs"><i class="fas fa-shuffle mr-1.5 text-xs"></i>Shuffle</button><button onclick="playAllPicks()" class="text-sm font-bold text-gray-400 hover:text-white transition-colors ml-4"><i class="fas fa-play mr-1.5 text-xs"></i>Play all</button>')}
    ${shelf('Language mixes',mixes)}
    ${recShelves()}
    ${shelf('New arrivals',fresh,more('openSrc('+reg(recentSrc())+')','Show all'))}
    ${shelf('Your artists',arts)}`;
  requestAnimationFrame(()=>shelfIds.forEach(updateArrows));
};
try{if(view.kind==='home')renderHome();}catch(e){}

// ---------- DJ deck v2: scratch, fling, cues, loops, pitch ----------
const NP=$('nowplaying'),deck=$('lm-deck'),disc=deck&&deck.querySelector('.disc'),arm=deck&&deck.querySelector('.arm');
if(!disc)return;
const RPM=0.5556,MAXFLING=24,ls=(k,d)=>{try{return JSON.parse(localStorage.getItem(k))??d}catch(e){return d}};
const DJ=Object.assign({vinyl:true,inertia:1,nowFirst:true,nowEnter:false,ring:true},ls('lmp_dj',{}));
window.djSet=(k,v)=>{DJ[k]=v;localStorage.setItem('lmp_dj',JSON.stringify(DJ));djPaint();};
function djPaint(){[['vinyl','dj-vinyl'],['precision','dj-precset'],['ring','dj-ring'],['nowFirst','dj-nowfirst'],['nowEnter','dj-nowenter']].forEach(([k,i])=>{const e=$(i);if(e)e.classList.toggle('on',!!DJ[k]);});const e=$('dj-inertia');if(e)e.value=DJ.inertia;
  const pe=$('dj-prec');if(pe){pe.textContent='PRECISION '+(DJ.precision?'ON':'OFF');pe.classList.toggle('on',!!DJ.precision);}
  const ve=$('dj-vin');if(ve){ve.textContent='VINYL SOUND '+(DJ.vinyl?'ON':'OFF');ve.classList.toggle('on',!!DJ.vinyl);}
  const h=document.querySelector('.scr-hint');if(h)h.textContent=DJ.precision?'Precision: 1 turn = 1.8 s · Shift = finer':'Drag to scratch · flick to spin';}
let AC=null,cache={id:null,buf:null,rev:null,p:null},st=null,rot=0,gt=null;
const ac=()=>{AC=AC||new(window.AudioContext||window.webkitAudioContext)();if(AC.state==='suspended')AC.resume();return AC;};
const vol=()=>audio.muted?0:audio.volume;
function prep(){
  const t=curTrack();if(!t)return Promise.resolve(null);
  if(cache.id===t.id)return cache.p;
  const c={id:t.id,buf:null,rev:null,p:null};cache=c;
  c.p=fetch(t.url).then(r=>r.arrayBuffer()).then(a=>ac().decodeAudioData(a)).then(b=>(c.buf=b)).catch(()=>{c.id=null;return null;});
  return c.p;
}
function getRev(){ // full reversed copy, built once per song
  const b=cache.buf;if(!b)return null;if(cache.rev)return cache.rev;
  const r=ac().createBuffer(b.numberOfChannels,b.length,b.sampleRate);
  for(let c=0;c<b.numberOfChannels;c++){const x=b.getChannelData(c),y=r.getChannelData(c),n=x.length;for(let i=0;i<n;i++)y[i]=x[n-1-i];}
  return cache.rev=r;
}
const hint=document.createElement('div');hint.className='scr-hint';hint.textContent='Drag to scratch · flick to spin';deck.appendChild(hint);
const rd=document.createElement('div');rd.className='scr-rate';deck.appendChild(rd);
deck.addEventListener('pointerenter',prep);
deck.querySelectorAll('img').forEach(i=>{i.draggable=false;i.style.pointerEvents='none';i.style.userSelect='none';i.style.webkitUserDrag='none';});
['dragstart','selectstart','contextmenu'].forEach(ev=>disc.addEventListener(ev,e=>e.preventDefault()));
function curRot(){try{const m=new DOMMatrix(getComputedStyle(disc).transform);return Math.atan2(m.b,m.a)*180/Math.PI;}catch(e){return 0;}}
function stopVoice(s){
  if(gt){clearInterval(gt);gt=null;}
  if(!s||!s.voice)return;const c=ac(),v=s.voice;s.voice=null;
  try{v._g.gain.setTargetAtTime(0,c.currentTime,.01);v.stop(c.currentTime+.06);}catch(e){}
}
function startVoice(dir){ // vinyl voice: pitch follows speed (the classic scratch sound)
  const b=st.buf,c=ac(),sr=c.createBufferSource(),g=c.createGain();let buf,off;
  if(dir>0){if(st.t>=b.duration-.06)return;buf=b;off=st.t;}
  else{if(st.t<.06)return;buf=getRev();off=b.duration-st.t;}
  sr.buffer=buf;sr.playbackRate.value=Math.max(.05,Math.min(Math.abs(st.rate),MAXFLING));g.gain.value=vol();sr.connect(g);g.connect(c.destination);sr._g=g;
  sr.onended=()=>{if(st&&st.voice===sr)st.ended=true;};
  sr.start(0,off);st.voice=sr;st.ended=false;
}
function grains(){ // clean voice: pitch-locked granular playback, you hear the words at any speed
  const c=ac(),L=.09,H=.045;if(!st||!st.buf)return;
  if(Math.abs(st.rate)<.05){st.gn=c.currentTime;return;}
  if(!st.gn||st.gn<c.currentTime)st.gn=c.currentTime+.01;
  while(st.gn<c.currentTime+.07){
    const when=st.gn,rev=st.rate<0,d=st.buf.duration;
    let pos=Math.max(0,Math.min(d-L-.01,st.t+st.rate*(when-c.currentTime)));
    const sr=c.createBufferSource(),g=c.createGain();
    sr.buffer=rev?getRev():st.buf;sr.connect(g);g.connect(c.destination);
    g.gain.setValueAtTime(0,when);g.gain.linearRampToValueAtTime(vol(),when+L/2);g.gain.linearRampToValueAtTime(0,when+L);
    sr.start(when,rev?d-pos-L:pos,L);st.gn+=H;
  }
}
function drive(r){
  if(!DJ.vinyl||st.clean){if(!gt)gt=setInterval(grains,12);return;}
  const ar=Math.abs(r),dir=ar<.04?0:Math.sign(r);
  if(dir!==st.dir||st.ended){stopVoice(st);st.dir=dir;if(dir)startVoice(dir);}
  if(st.voice)st.voice.playbackRate.setTargetAtTime(Math.max(.05,Math.min(ar,MAXFLING)),ac().currentTime,.015);
}
function paintScr(){const d=st.buf?st.buf.duration:(audio.duration||0),T=fmtTime(st.t);$('npg-cur').textContent=T;$('t-cur').textContent=T;if(d){const v=Math.round(st.t/d*1000);$('npg-seek').value=v;$('seek').value=v;paintRange($('npg-seek'));paintRange($('seek'));}
  rd.textContent=Math.abs(st.rate)<.05?'':(st.rate<0?'◀◀ ':'▶▶ ')+Math.abs(st.rate).toFixed(1)+'×';}
function end(){
  const s=st;if(!s)return;st=null;stopVoice(s);rd.textContent='';
  disc.classList.remove('scr');arm.style.transform='';
  disc.style.animationDelay=(-(((rot%360)+360)%360)/360*16)+'s';
  if(s.buf)userSeekTo(s.t);else if(s.scrub)audio.currentTime=s.tt;
  if(s.was)audio.play().catch(()=>{});
}
function loop(){
  if(!st)return;
  const now=performance.now(),dt=Math.min(.05,(now-st.last)/1000);st.last=now;
  if(st.scrub){const pt=st.t;st.t+=(st.tt-st.t)*Math.min(1,dt*40);st.rate=Math.abs(st.tt-st.t)<.003?0:Math.max(-16,Math.min(16,(st.t-pt)/dt));}
  else if(st.ptr){
    if(now-st.moved>110)st.target=0;
    st.rate+=(st.target-st.rate)*Math.min(1,dt*18);
  }else if(st.hold){st.rate+=(st.hold-st.rate)*Math.min(1,dt*10);}
  else{ // free spin: friction pulls the platter back to the motor speed
    const rest=st.was?1:0,tau=st.tau||2.2*DJ.inertia;
    st.rate=rest+(st.rate-rest)*Math.exp(-dt/tau);
    if(Math.abs(st.rate-rest)<.06){end();return;}
  }
  if(st.buf){
    if(!st.scrub)st.t+=st.rate*dt;
    if(st.t<=0||st.t>=st.buf.duration-.05){st.t=Math.max(0,Math.min(st.buf.duration-.05,st.t));if((!st.ptr&&!st.hold&&!st.scrub)||(st.revplay&&st.t<=0)){end();return;}}
    drive(st.rate);
  }
  if(!st.ptr){rot+=st.rate*RPM*360*dt;disc.style.setProperty('--rot',rot+'deg');}
  paintScr();requestAnimationFrame(loop);
}
async function begin(o){
  if(st||!curTrack())return false;ac();
  rot=curRot();
  const s=st=Object.assign({ptr:false,last:performance.now(),moved:performance.now(),rate:0,target:0,t:audio.currentTime,was:!audio.paused,buf:null,voice:null,dir:0,ended:false,hist:[]},o);
  audio.pause();disc.classList.add('scr');disc.style.setProperty('--rot',rot+'deg');arm.style.transform='rotate(-24deg)';
  if(cache.id!==curTrack().id||!cache.buf)toast('Loading the record...',1500);
  loop();const b=await prep();
  if(st!==s)return true;
  if(!b){toast('Could not load this song for scratching.');}else{s.buf=b;setTimeout(getRev,0);}
  return true;
}
disc.addEventListener('pointerdown',async e=>{
  e.preventDefault();ac();if(st&&st.scrub)return;
  const r=disc.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,a=Math.atan2(e.clientY-cy,e.clientX-cx);
  if(st&&!st.ptr){ // catch a spinning record
    Object.assign(st,{ptr:true,hold:0,id:e.pointerId,cx,cy,a,moved:performance.now(),target:0,hist:[]});
    st.tau=0;disc.setPointerCapture(e.pointerId);return;
  }
  if(st)return;
  if(await begin(Object.assign({ptr:true,id:e.pointerId,cx,cy,a},DJ.precision?{scrub:true,clean:true,tt:audio.currentTime}:{}))){disc.setPointerCapture(e.pointerId);}
});
disc.addEventListener('pointermove',e=>{
  if(!st||!st.ptr||e.pointerId!==st.id)return;
  const a=Math.atan2(e.clientY-st.cy,e.clientX-st.cx);let d=a-st.a;
  if(d>Math.PI)d-=2*Math.PI;if(d<-Math.PI)d+=2*Math.PI;st.a=a;
  const now=performance.now(),dt=Math.max(8,now-st.moved)/1000;st.moved=now;
  rot+=d*180/Math.PI;disc.style.setProperty('--rot',rot+'deg');
  if(st.scrub){st.tt=Math.max(0,Math.min((audio.duration||1)-.05,st.tt+d/(2*Math.PI)*1.8*(e.shiftKey?.25:1)));return;}
  st.target=Math.max(-8,Math.min(8,d/dt/(2*Math.PI)/RPM));
  st.hist.push([now,d]);while(st.hist.length&&now-st.hist[0][0]>90)st.hist.shift();
});
function release(e){
  if(!st||!st.ptr||e.pointerId!==st.id)return;
  if(st.scrub){st.ptr=false;end();return;}
  const now=performance.now();st.hist=st.hist.filter(h=>now-h[0]<=90);
  let v=0;if(st.hist.length>1&&now-st.moved<70){const sum=st.hist.reduce((x,h)=>x+h[1],0),span=Math.max(.03,(now-st.hist[0][0])/1000);v=sum/span/(2*Math.PI)/RPM;}
  st.ptr=false;st.tau=0;
  if(Math.abs(v)>1.4||!st.was&&Math.abs(v)>.6){st.rate=Math.max(-MAXFLING,Math.min(MAXFLING,v));}   // flick: keep spinning
  else if(st.was){st.rate=Math.max(-8,Math.min(8,st.rate));}                                          // let go: motor takes over
  else end();
}
['pointerup','pointercancel','lostpointercapture'].forEach(ev=>disc.addEventListener(ev,release));

// ---------- DJ tools ----------
let cq={k:null,v:null};const K=()=>'lmp_cues_'+(curTrack()||{}).id,cues=()=>{const k=K();if(cq.k!==k)cq={k,v:ls(k,{c:[null,null,null,null],bpm:0})};return cq.v;};
const save=o=>{cq={k:K(),v:o};localStorage.setItem(K(),JSON.stringify(o));};
let loopA=null,loopB=null,taps=[],wave=null,waveId=null;
const dur=()=>audio.duration||0,seekTo=t=>{audio.currentTime=Math.max(0,Math.min(dur(),t));};
const panel=document.createElement('div');panel.id='dj-panel';
panel.innerHTML=`<div class="djh"><span>DJ TOOLS</span><span class="sp"></span><button data-a="help" title="How does this work?">? HOW TO</button><button data-a="resetall" title="Clear cues, loop, BPM, speed, filter and echo">RESET ALL</button></div>
<div id="dj-help"><b>WAVEFORM</b> - drag the bar and hear the song under your cursor with no distortion, like scrubbing in a video editor. It goes quiet when you stop.<br><b>PRECISION</b> - turn it on and the record becomes a jog wheel: the song follows your hand exactly (1 turn = 1.8 s, Shift = finer) and stops the moment you let go. VINYL SOUND OFF keeps the flick and spin clean too.<br><b>ZOOM</b> - scroll on the waveform (or ZOOM +/-) to see just a few seconds around the playhead for frame-precise work. Double-click resets.<br><b>FILTER / ECHO</b> - slide the filter left to muffle, right to thin out. Hold ECHO for a beat-timed echo that rings out. They work on the playing song (not on scratching) and switch on after your first click in the app. MATCH BPM sets the speed so this song hits the BPM you type.<br><b>LOOP ROLL</b> - hold 1/2, 1/4 or 1/8 to stutter the last beat fraction; when you let go the song jumps to where it would have been (needs a BPM, it finds one for you). <b>REVERSE PLAY</b> plays the song backwards until you press it again.<br><b>Easiest way:</b> grab the record and drag it back and forth, or flick it to spin. Everything else is optional.<br>
<b>JUMP POINTS</b> - 1 to 4 save a spot in the song. Click an empty one to save where you are, click it again to jump back. Right-click clears it. CUE: playing = snap back to your start spot and pause; paused = set your start spot here.<br>
<b>LOOP</b> - press START where the loop begins, END where it ends, and it repeats. STOP LOOP lets the song continue. ½ / ×2 make the loop shorter / longer.<br>
<b>REWIND</b> - hold the buttons to scrub at 4x and hear it live. BACKSPIN flings it backwards, BRAKE slows it to a stop.<br>
<b>SPEED</b> - slide to change tempo. KEY LOCK keeps voices at the same pitch. TAP: tap the beat 4 times to set BPM (used by ×2).<br><b>KEYBOARD</b> - 1-4 jump points, C cue, I / O / X loop start / end / stop, B backspin, N brake, hold , or . to rewind / fast forward. Psst: there are hidden easter eggs - Settings lists how many you found.</div>
<div class="djr"><span class="lb">MODE</span><button id="dj-prec" data-a="prec" title="Precision: the record moves the song 1:1 like a jog wheel. One turn = 1.8 seconds, hold Shift for 4x finer. No flick, no drift.">PRECISION OFF</button><button id="dj-vin" data-a="vin" title="Vinyl sound bends the pitch. Off = clean, pitch-locked scrubbing">VINYL SOUND ON</button><button data-a="zin" title="Zoom the waveform (or scroll on it). Double-click resets">ZOOM +</button><button data-a="zout">ZOOM -</button><span class="sp"></span><b id="dj-tc">0:00.000</b></div>
<canvas id="dj-wave" height="44" title="Click anywhere to jump there"></canvas>
<div class="djr"><span class="lb">JUMP POINTS</span><button id="dj-cue" title="Playing: back to cue and pause. Paused: set cue here">CUE</button>${[1,2,3,4].map(i=>`<button class="hc" data-i="${i-1}" title="Click to save, click again to jump. Right-click clears">${i}</button>`).join('')}</div>
<div class="djr"><span class="lb">LOOP</span><button data-a="in">START</button><button data-a="out">END</button><button data-a="exit">STOP LOOP</button><button data-a="half">½</button><button data-a="dbl">×2</button></div>
<div class="djr"><span class="lb">BEAT LOOP</span>${[1,2,4,8].map(n=>`<button data-a="bl" data-n="${n}" title="Loop ${n} beat${n>1?'s':''} snapped to the beat grid">${n}</button>`).join('')}</div>
<div class="djr"><span class="lb">REWIND</span><button data-a="rew" title="Hold to rewind and hear it live">◀◀ HOLD</button><button data-a="ff" title="Hold to fast forward and hear it live">HOLD ▶▶</button><button data-a="spin">BACKSPIN</button><button data-a="brake">BRAKE</button></div>
<div class="djr"><span class="lb">NUDGE</span><button data-a="nudge" data-d="-1">-1 s</button><button data-a="nudge" data-d="-0.1">-0.1</button><button data-a="nudge" data-d="0.1">+0.1</button><button data-a="nudge" data-d="1">+1 s</button><span class="lb" style="width:auto;margin-left:.4rem">paused = you hear each step</span></div>
<div class="djr"><span class="lb">LOOP ROLL</span><button class="roll" data-f="0.5" title="Hold: stutters half a beat. Let go and the song jumps to where it would have been">1/2</button><button class="roll" data-f="0.25">1/4</button><button class="roll" data-f="0.125">1/8</button><span class="sp"></span><button id="dj-rev" data-a="rev" title="Plays the song backwards. Press again to go forward">REVERSE PLAY</button></div>
<div class="djr"><span class="lb">FILTER</span><input id="dj-flt" type="range" min="-100" max="100" value="0" title="Left: low-pass (muffled). Right: high-pass (thin). Double-click centres it"><button id="dj-echo" title="Hold for echo, let go and it rings out">ECHO (HOLD)</button></div>
<div class="djr"><span class="lb">MATCH BPM</span><input id="dj-tb" type="number" min="60" max="200" placeholder="e.g. 124" style="flex:none;width:5.5rem;min-width:0;background:rgba(255,255,255,.06);border:1px solid var(--v-line2);padding:.3rem;color:#fff"><button data-a="sync">SYNC</button><span class="lb" style="width:auto">sets the speed so this song hits that BPM</span></div>
<div class="djr"><span class="lb">SPEED</span><input id="dj-pitch" type="range" min="-16" max="16" step="0.1" value="0"><b id="dj-pv">0.0%</b><button data-a="reset" title="Back to normal speed">NORMAL</button><button id="dj-key" data-a="key" title="Keep the pitch when you change speed">KEY LOCK</button><button data-a="auto" title="Detect the BPM and beat grid automatically">AUTO BPM</button><button data-a="tap" id="dj-tap" title="Tap the beat to set BPM">TAP BPM</button></div>`;
$('npg-up').before(panel);
const wc=$('dj-wave');
function peaks(){
  const b=cache.buf;if(!b)return;const n=640,x=b.getChannelData(0),step=Math.floor(x.length/n),o=new Float32Array(n);
  for(let i=0;i<n;i++){let m=0;for(let j=i*step;j<(i+1)*step;j+=16){const v=Math.abs(x[j]);if(v>m)m=v;}o[i]=m;}wave=o;
}
let zoom=1,vs=0,zc={k:'',arr:null};
function draw(){
  if(!wave)return;const w=wc.clientWidth*2,h=88;if(wc.width!==w)wc.width=w;if(wc.height!==h)wc.height=h;
  const c=wc.getContext('2d'),d=dur()||1,t=st?st.t:audio.currentTime,wl=d/zoom;
  if(!wsd)vs=zoom>1?Math.max(0,Math.min(d-wl,t-wl/2)):0;
  const X=q=>(q-vs)/wl*w;
  c.clearRect(0,0,w,h);c.fillStyle='rgba(255,255,255,.28)';
  let arr=wave;
  if(zoom>1&&cache.buf){const k=zoom+'|'+Math.round(vs*40)+'|'+w;if(zc.k!==k){const bf=cache.buf,x=bf.getChannelData(0),cols=Math.floor(w/2),spc=wl*bf.sampleRate/cols,st2=Math.max(1,Math.floor(spc/40)),o=new Float32Array(cols);
    for(let i=0;i<cols;i++){let m=0;const s0=Math.floor(vs*bf.sampleRate+i*spc),s1=Math.min(x.length,Math.floor(s0+spc));for(let j=s0;j<s1;j+=st2){const v=Math.abs(x[j]);if(v>m)m=v;}o[i]=m;}zc={k,arr:o};}arr=zc.arr;}
  const n=arr.length;for(let i=0;i<n;i++){const x=i/n*w,hh=Math.max(2,arr[i]*h*.95);c.fillRect(x,(h-hh)/2,Math.max(1,w/n-(zoom>1?0:1)),hh);}
  if(loopA!=null){c.fillStyle='rgba(255,200,60,.28)';c.fillRect(X(loopA),0,X(loopB??t)-X(loopA),h);}
  const cb=cues();if(cb.bpm&&w*(60/cb.bpm)/wl>7){c.fillStyle='rgba(255,255,255,.22)';const bl=60/cb.bpm,off=cb.off||0;for(let x=off+Math.max(0,Math.ceil((vs-off)/bl))*bl;x<vs+wl;x+=bl)c.fillRect(X(x),0,1,h*.35);}
  cb.c.forEach((q,i)=>{if(q==null)return;c.fillStyle=['#ff4d6d','#ffd23f','#3ddc97','#4cc9f0'][i];c.fillRect(X(q)-1,0,3,h);});
  c.fillStyle='#fff';c.fillRect(X(t)-1,0,3,h);
  if(zoom>1){c.fillStyle='rgba(255,255,255,.7)';c.font='20px monospace';c.fillText(zoom.toFixed(zoom<10?1:0)+'x',8,22);}
}
wc.style.touchAction='none';let wsd=null;
const wmk=ev=>{const r=wc.getBoundingClientRect(),wl=dur()/zoom;return Math.max(0,Math.min(dur()-.05,vs+(ev.clientX-r.left)/r.width*wl));};
const setZoom=z=>{zoom=Math.max(1,Math.min(64,z));if(zoom<1.05)zoom=1;};
wc.addEventListener('wheel',e=>{e.preventDefault();setZoom(zoom*(e.deltaY<0?1.4:1/1.4));},{passive:false});
wc.addEventListener('dblclick',()=>setZoom(1));
wc.addEventListener('pointerdown',e=>{if(st||!curTrack())return;e.preventDefault();wc.setPointerCapture(e.pointerId);wsd=e.pointerId;const t=wmk(e);begin({scrub:true,clean:true,tt:t,t,was:!audio.paused});});
wc.addEventListener('pointermove',e=>{if(wsd===e.pointerId&&st&&st.scrub)st.tt=wmk(e);});
['pointerup','pointercancel'].forEach(ev=>wc.addEventListener(ev,e=>{if(wsd!==e.pointerId)return;wsd=null;if(st&&st.scrub&&!st.ptr)end();}));
function djTick(){
  requestAnimationFrame(djTick);
  if(loopA!=null&&loopB!=null&&!st&&audio.currentTime>=loopB)audio.currentTime=loopA;
  if(NP.classList.contains('hidden'))return;
  const t=curTrack();
  if(t&&waveId!==t.id){waveId=t.id;wave=null;loopA=loopB=null;const c=cues();$('dj-tap').textContent=c.bpm?c.bpm+' BPM':'TAP BPM';prep().then(()=>{if(waveId===t.id)peaks();});}
  $('dj-tc').textContent=tcf(st?st.t:audio.currentTime);
  const cc=cues().c;panel.querySelectorAll('.hc').forEach((h,i)=>{h.classList.toggle('set',cc[i]!=null);});
  draw();
}
djTick();
function setLoop(len){const a=audio.currentTime;loopA=a;loopB=Math.min(dur(),a+len);}
panel.addEventListener('click',e=>{
  const bt=e.target.closest('button');if(!bt)return;
  if(bt.id==='dj-cue'){const c=cues();if(!audio.paused){seekTo(c.pos||0);audio.pause();}else{c.pos=audio.currentTime;save(c);}return;}
  if(bt.classList.contains('hc')){const c=cues(),i=+bt.dataset.i;if(c.c[i]==null){c.c[i]=audio.currentTime;save(c);}else{seekTo(c.c[i]);audio.play().catch(()=>{});}return;}
  const a=bt.dataset.a,c=cues(),bl=c.bpm?60/c.bpm:2;
  if(a==='in')loopA=audio.currentTime,loopB=null;
  else if(a==='out'){if(loopA!=null&&audio.currentTime>loopA+.1)loopB=audio.currentTime;else toast('Press START first, then END a little later in the song');}
  else if(a==='exit')loopA=loopB=null;
  else if(a==='half'){if(loopA!=null&&loopB!=null)loopB=loopA+(loopB-loopA)/2;}
  else if(a==='dbl'){if(loopA==null)setLoop(bl*4);else if(loopB==null)loopB=Math.min(dur(),loopA+bl*4);else loopB=Math.min(dur(),loopA+(loopB-loopA)*2);}
  else if(a==='spin')begin({hold:0,rate:-1,tau:1.1,was:!audio.paused}).then(ok=>{if(ok&&st)st.rate=-18;});
  else if(a==='brake')begin({hold:0,rate:1,tau:.45,was:false}).then(ok=>{if(ok&&st)st.rate=audio.playbackRate;});
  else if(a==='tap'){const n=performance.now();taps=taps.filter(x=>n-x<2500);taps.push(n);if(taps.length>2){const bpm=Math.round(60000/((taps[taps.length-1]-taps[0])/(taps.length-1)));c.bpm=bpm;save(c);bt.textContent=bpm+' BPM';}}
  else if(a==='reset'){$('dj-pitch').value=0;$('dj-pitch').oninput();}
  else if(a==='rev')reversePlay();
  else if(a==='zin')setZoom(zoom*1.6);
  else if(a==='zout')setZoom(zoom/1.6);
  else if(a==='sync')syncBpm();
  else if(a==='prec')djSet('precision',!DJ.precision);
  else if(a==='vin')djSet('vinyl',!DJ.vinyl);
  else if(a==='nudge')nudge(+bt.dataset.d);
  else if(a==='auto')autoBpm();
  else if(a==='bl')beatLoop(+bt.dataset.n);
  else if(a==='help'){$('dj-help').classList.toggle('open');}
  else if(a==='resetall')djResetAll();
  else if(a==='key'){audio.preservesPitch=!audio.preservesPitch;bt.classList.toggle('on',audio.preservesPitch);}
});
panel.addEventListener('contextmenu',e=>{const bt=e.target.closest('.hc');if(!bt)return;e.preventDefault();const c=cues();c.c[+bt.dataset.i]=null;save(c);});
['rew','ff'].forEach(k=>{const bt=panel.querySelector(`[data-a="${k}"]`),dir=k==='rew'?-1:1;
  bt.addEventListener('pointerdown',e=>{e.preventDefault();bt.setPointerCapture(e.pointerId);begin({hold:dir*4,was:!audio.paused});});
  const up=()=>{if(st&&st.hold){st.hold=0;st.tau=.3;st.rate=st.rate;}};
  ['pointerup','pointercancel'].forEach(ev=>bt.addEventListener(ev,up));});
$('dj-pitch').oninput=function(){const p=+this.value;audio.playbackRate=1+p/100;$('dj-pv').textContent=(p>0?'+':'')+p.toFixed(1)+'%';};
$('dj-key').classList.toggle('on',audio.preservesPitch!==false);

// ---------- Now Playing is the main thing for music ----------
let wasVis=false,lastNowId=null;
audio.addEventListener('loadedmetadata',()=>{
  const t=curTrack();if(!t||t.id===lastNowId)return;lastNowId=t.id;
  if(DJ.nowFirst&&!audio.paused&&$('mv-home')&&$('mv-home').offsetParent)setTimeout(()=>{try{openNowPlaying();}catch(e){}},60);
});
setInterval(()=>{const h=$('mv-home'),v=!!(h&&h.offsetParent);
  if(v&&!wasVis&&DJ.nowEnter&&nowId&&!audio.paused&&NP.classList.contains('hidden')&&!st)try{openNowPlaying();}catch(e){}
  wasVis=v;},400);

// ---------- settings ----------
const sec=document.createElement('section');sec.className='mb-8';
sec.innerHTML=`<h4>DJ deck</h4>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Vinyl scratch sound</div><div class="text-xs text-gray-500">On: pitch bends and distorts like a real record. Off: clean, pitch-locked scrubbing so you can hear exactly where you are when you rewind</div></div><button id="dj-vinyl" class="set-switch" onclick="djSet('vinyl',!DJ.vinyl)"></button></div>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Precision jog (also in Now Playing)</div><div class="text-xs text-gray-500">The record moves the song 1:1 like a jog wheel: 1 turn = 1.8 s, no flick, no drift</div></div><button id="dj-precset" class="set-switch" onclick="djSet('precision',!DJ.precision)"></button></div>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Spectrum ring</div><div class="text-xs text-gray-500">Bars around the record that move with the music</div></div><button id="dj-ring" class="set-switch" onclick="djSet('ring',DJ.ring===false)"></button></div>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Platter inertia</div><div class="text-xs text-gray-500">How long a flick keeps spinning</div></div><select id="dj-inertia" class="set-select text-sm" onchange="djSet('inertia',+this.value)"><option value="0.5">Light</option><option value="1">Normal</option><option value="2">Heavy</option><option value="4">Endless</option></select></div>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Open Now Playing when a song starts</div><div class="text-xs text-gray-500">Starting a song from the Music screen opens the full Now Playing page</div></div><button id="dj-nowfirst" class="set-switch" onclick="djSet('nowFirst',!DJ.nowFirst)"></button></div>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Open Now Playing when I enter Music</div><div class="text-xs text-gray-500">Jumps back to Now Playing whenever you open Music while something plays</div></div><button id="dj-nowenter" class="set-switch" onclick="djSet('nowEnter',!DJ.nowEnter)"></button></div>`;
const hv=$('set-hover');if(hv){const s0=hv.closest('section');if(s0)s0.after(sec);}

// ---------- keyboard DJ + a little surprise ----------
const btn=a=>panel.querySelector(`[data-a="${a}"]`);
let typed='',keys=[];
document.addEventListener('keydown',e=>{
  if(/INPUT|TEXTAREA|SELECT/.test((e.target.tagName||''))||e.ctrlKey||e.metaKey||e.altKey)return;
  keys=keys.concat(e.key).slice(-10);
  if(JSON.stringify(keys.map(x=>x.toLowerCase()))==='["arrowup","arrowup","arrowdown","arrowdown","arrowleft","arrowright","arrowleft","arrowright","b","a"]'){keys=[];egg('konami');}
  if(e.key.length===1){typed=(typed+e.key.toLowerCase()).slice(-12);for(const w in WORDS)if(typed.endsWith(w)){typed='';egg(WORDS[w]);}}
  if(NP.classList.contains('hidden'))return;
  const k=e.key.toLowerCase();let used=true;
  if('1234'.includes(k)&&k.length===1)panel.querySelectorAll('.hc')[+k-1].click();
  else if(k==='c')$('dj-cue').click();
  else if(k==='i')btn('in').click();else if(k==='o')btn('out').click();else if(k==='x')btn('exit').click();
  else if(k==='b')btn('spin').click();else if(k==='n')btn('brake').click();
  else if(k==='r'&&!e.repeat)reversePlay();
  else if(k.length===1&&'asd'.includes(k)&&!e.repeat)rollStart([.5,.25,.125]['asd'.indexOf(k)]);
  else if(k==='e'&&!e.repeat)eb.dispatchEvent(new PointerEvent('pointerdown'));
  else if((k===','||k==='.')&&!e.repeat){begin({hold:k===','?-4:4,was:!audio.paused});}
  else used=false;
  if(used){e.preventDefault();e.stopImmediatePropagation();}
},true);
document.addEventListener('keyup',e=>{if((e.key===','||e.key==='.')&&st&&st.hold){st.hold=0;st.tau=.3;}},true);

const EGGS={autobots:['Roll out','Type the Autobot battle cry'],optimus:['Freedom','Type the leader of the Autobots'],discovery:['One more time','Type the name of a certain Daft Punk album'],konami:['30 lives','The most famous cheat code ever, on your keyboard'],logo:['Knock knock','Click the LM logo again and again'],bumblebee:['Sting','Type the yellow Autobot scout'],megatron:['Retreat','Type the leader of the Decepticons'],soundwave:['Superior','Type the Decepticon with the cassette tapes'],starscream:['Second in command','Type the Decepticon who always wants the throne'],grimlock:['King','Type the name of the Dinobot leader'],jazz:['With style','Type the Autobot who does everything with style'],ratchet:['Medic','Type the Autobot medic']};
const WORDS={autobots:'autobots',optimus:'optimus',discovery:'discovery',bumblebee:'bumblebee',megatron:'megatron',soundwave:'soundwave',starscream:'starscream',grimlock:'grimlock',jazz:'jazz',ratchet:'ratchet'};
const ES=()=>ls('lmp_eggs',[]);
function discoPaint(){document.documentElement.classList.toggle('disco',!!DJ.disco);const b=$('egg-disco'),r=$('egg-disco-row');if(b)b.classList.toggle('on',!!DJ.disco);if(r)r.style.display=ES().includes('discovery')?'':'none';}
window.discoPaint=discoPaint;
function banner(t,emoji,fs){const o=document.createElement('div');o.className='autobots';o.innerHTML='<div class="ab-t" style="'+(fs?'font-size:'+fs:'')+'">'+t+'</div>'+(emoji?'<div class="ab-truck">'+emoji+'</div>':'');document.body.appendChild(o);setTimeout(()=>o.remove(),2600);}
function egg(id){
  if(DJ.eggs===false)return;
  const f=ES();if(!f.includes(id)){f.push(id);localStorage.setItem('lmp_eggs',JSON.stringify(f));toast('Easter egg found: '+EGGS[id][0]+' ('+f.length+'/'+Object.keys(EGGS).length+')',3200);eggPaint();}
  if(id==='autobots'){banner('AUTOBOTS,<br>ROLL OUT','🚛💨');if(!NP.classList.contains('hidden')&&!st)begin({hold:0,rate:1,tau:2.8,was:!audio.paused}).then(ok=>{if(ok&&st)st.rate=22;});}
  else if(id==='optimus')banner('FREEDOM IS THE RIGHT<br>OF ALL SENTIENT BEINGS',null,'clamp(2rem,5.5vw,5rem)');
  else if(id==='discovery'){document.documentElement.classList.add('disco');banner('ONE MORE TIME','🪩','clamp(3rem,9vw,8rem)');setTimeout(discoPaint,7000);}
  else if(id==='konami'){banner('+30 LIVES',null);for(let i=0;i<46;i++){const e=document.createElement('div');e.className='ab-rain';e.textContent=['🎧','🎵','💿','🎚️'][i%4];e.style.left=Math.random()*100+'vw';e.style.animationDelay=Math.random()*1.4+'s';e.style.fontSize=(1.4+Math.random()*2)+'rem';document.body.appendChild(e);setTimeout(()=>e.remove(),3600);}}
  else if(id==='bumblebee')banner('BUMBLEBEE<br>BZZZT','🐝','clamp(2.6rem,8vw,7rem)');
  else if(id==='megatron')banner('DECEPTICONS,<br>RETREAT!','🛸','clamp(2.6rem,8vw,7rem)');
  else if(id==='soundwave')banner('SOUNDWAVE:<br>SUPERIOR','📼','clamp(2.6rem,8vw,7rem)');
  else if(id==='starscream')banner('I SHOULD BE<br>LEADER!','✈️','clamp(2.6rem,8vw,7rem)');
  else if(id==='grimlock')banner('ME GRIMLOCK<br>KING!','🦖','clamp(2.6rem,8vw,7rem)');
  else if(id==='jazz')banner('DO IT<br>WITH STYLE','🎷','clamp(2.6rem,8vw,7rem)');
  else if(id==='ratchet')banner('I AM A MEDIC,<br>NOT A DJ','🔧','clamp(2.6rem,8vw,7rem)');
  else if(id==='logo')banner('ULTRON<br>AUTOBOTS FOREVER',null,'clamp(2.4rem,7vw,6rem)');
}
window.eggPaint=function(){const f=ES(),n=Object.keys(EGGS).length,e=$('egg-sw');if(e)e.classList.toggle('on',DJ.eggs!==false);const c=$('egg-count');if(c)c.textContent=f.length+' of '+n+' found';discoPaint();const l=$('egg-list');if(l)l.innerHTML=Object.keys(EGGS).map(k=>f.includes(k)?'<span class="egg-chip on" title="'+EGGS[k][1]+'">'+EGGS[k][0]+'</span>':'<span class="egg-chip">???</span>').join('');};
const ICON={autobots:'🚛',optimus:'🛡️',discovery:'🪩',konami:'🎮',logo:'🚪',bumblebee:'🐝',megatron:'🛸',soundwave:'📼',starscream:'✈️',grimlock:'🦖',jazz:'🎷',ratchet:'🔧'};
window.eggOpen=function(){let o=$('egg-page');if(o)o.remove();o=document.createElement('div');o.id='egg-page';
  const f=ES(),ks=Object.keys(EGGS);
  o.innerHTML='<div class="ep-in"><button class="ep-x" onclick="this.closest(\'#egg-page\').remove()">✕</button><h2>EASTER EGGS</h2><p>'+f.length+' of '+ks.length+' found'+(DJ.eggs===false?' · eggs are switched off in Settings':'')+'</p><div class="ep-grid">'+ks.map(k=>f.includes(k)?'<div class="ep-c on"><i>'+ICON[k]+'</i><b>'+EGGS[k][0]+'</b><span>'+EGGS[k][1]+'</span><button onclick="egg(\''+k+'\')">Replay</button></div>':'<div class="ep-c"><i>❔</i><b>???</b><span class="ep-h" hidden>'+EGGS[k][1]+'</span><button onclick="this.previousElementSibling.hidden=false;this.remove()">Show hint</button></div>').join('')+'</div><button class="ep-r" onclick="eggReset();eggOpen()">Reset discovered</button></div>';
  o.onclick=e=>{if(e.target===o)o.remove();};document.body.appendChild(o);};
window.egg=egg;
window.eggReset=()=>{localStorage.removeItem('lmp_eggs');eggPaint();toast('Easter eggs reset - go hunt them again');};
let lc=0,lt=0;document.addEventListener('click',e=>{if(!e.target.closest('#lm-mark'))return;const n=performance.now();lc=n-lt<900?lc+1:1;lt=n;if(lc>=7){lc=0;egg('logo');}},true);
const sec2=document.createElement('section');sec2.className='mb-8';
sec2.innerHTML=`<h4>Easter eggs</h4>
<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Hidden surprises</div><div class="text-xs text-gray-500">Turn them off if you want the app to stay serious</div></div><button id="egg-sw" class="set-switch" onclick="djSet('eggs',DJ.eggs===false);eggPaint()"></button></div>
<div id="egg-disco-row" class="flex items-center justify-between gap-4 mb-3" style="display:none"><div><div class="text-sm font-semibold">Discovery color filter</div><div class="text-xs text-gray-500">Keep the disco hue-shift on all the time (unlocked by the Discovery egg)</div></div><button id="egg-disco" class="set-switch" onclick="djSet('disco',!DJ.disco);discoPaint()"></button></div>
<div class="flex items-center justify-between gap-4 mb-2"><div><div class="text-sm font-semibold">Discovered</div><div id="egg-count" class="text-xs text-gray-500"></div></div><span class="flex gap-2"><button class="set-seg px-3 text-xs" onclick="eggOpen()">Open gallery</button><button class="set-seg px-3 text-xs" onclick="eggReset()">Reset discovered</button></span></div><div id="egg-list" class="flex flex-wrap gap-2"></div>`;
sec.after(sec2);eggPaint();
// these two sections were added after the Settings tabs were built, so they had no tab and stayed hidden: give them one
(function(){const nav=$('lm-set-nav'),pane=$('lm-set-pane');if(!nav||!pane)return;
  const mine=[sec,sec2],orig=[...nav.children];
  orig.forEach(b=>b.addEventListener('click',()=>mine.forEach(s=>s.classList.remove('lm-on'))));
  mine.forEach((s,i)=>{const t=i?'Easter eggs':'DJ deck',b=document.createElement('button');b.type='button';
    b.innerHTML='<i>'+(orig.length+i+1<10?'0':'')+(orig.length+i+1)+'</i><span></span>';b.lastChild.textContent=t;
    b.addEventListener('click',()=>{[...pane.children].forEach(x=>x.classList.remove('lm-on'));s.classList.add('lm-on');[...nav.children].forEach(x=>x.classList.toggle('on',x===b));pane.scrollTop=0;if(s===sec2)eggPaint();});
    nav.appendChild(b);});
})();
// ---- X: stop the music and remove the player
const xb=document.createElement('button');xb.className='npg-close npg-x';xb.title='Stop and close the player';xb.setAttribute('aria-label','Stop');xb.innerHTML='<i class="fas fa-xmark"></i>';
xb.onclick=()=>{audio.pause();try{audio.currentTime=0;}catch(e){}closeNowPlaying();nowId=null;const b=$('audio-bar');if(b)b.classList.add('hidden');};
NP.querySelector('.npg-close').after(xb);

const VD='<svg class="vault-door" viewBox="0 0 200 200" fill="none" stroke="#ff3b3b" stroke-width="2"><circle cx="100" cy="100" r="92"/><circle cx="100" cy="100" r="80" stroke-width="5"/><circle cx="100" cy="100" r="62"/><g class="spin">'+Array.from({length:8},(_,i)=>`<line x1="100" y1="100" x2="${100+56*Math.cos(i*Math.PI/4)}" y2="${100+56*Math.sin(i*Math.PI/4)}" stroke-width="6" stroke-linecap="round"/><circle cx="${100+86*Math.cos(i*Math.PI/4+.39)}" cy="${100+86*Math.sin(i*Math.PI/4+.39)}" r="3.5" fill="#ff3b3b"/>`).join('')+'<circle cx="100" cy="100" r="16" fill="#0b0b0c" stroke-width="4"/><rect x="96" y="88" width="8" height="12" fill="#ff3b3b" stroke="none"/></g></svg>';
setInterval(()=>{const v=$('private-view');if(v&&!v.querySelector('.vault-door')&&v.children.length)v.insertAdjacentHTML('afterbegin',VD);},800);

function nudge(dl){const t=Math.max(0,Math.min(dur()-.05,audio.currentTime+dl));audio.currentTime=t;if(audio.paused)audition(t);}
function audition(t){const b=cache.buf;if(!b){prep();return;}const c=ac(),r=c.createBufferSource(),g=c.createGain(),n=c.currentTime;r.buffer=b;r.connect(g);g.connect(c.destination);g.gain.setValueAtTime(0,n);g.gain.linearRampToValueAtTime(vol(),n+.01);g.gain.setValueAtTime(vol(),n+.2);g.gain.linearRampToValueAtTime(0,n+.26);r.start(n,t,.28);}
const tcf=t=>{t=Math.max(0,t||0);const m=Math.floor(t/60),x=t-m*60;return m+':'+(x<10?'0':'')+x.toFixed(3);};
// ---------- ULTRON: auto BPM + beat grid, live spectrum ring, sleep timer, shortcut sheet ----------
function autoBpm(){
  const b=cache.buf;if(!b){toast('Loading the song... try again in a moment');prep();return 0;}
  const x=b.getChannelData(0),hop=512,from=Math.floor(x.length*.2),n=Math.min(Math.floor(90*b.sampleRate/hop),Math.floor((x.length-from)/hop)-1),env=new Float32Array(n),on=new Float32Array(n);
  for(let i=0;i<n;i++){let e=0;for(let j=0;j<hop;j+=4){const v=x[from+i*hop+j];e+=v*v;}env[i]=Math.sqrt(e);}
  for(let i=1;i<n;i++)on[i]=Math.max(0,env[i]-env[i-1]);
  const fs=hop/b.sampleRate;let best=0,bb=120;
  for(let bpm=70;bpm<=180;bpm+=.5){const lag=Math.round(60/bpm/fs);let sc=0;for(let i=0;i+lag<n;i++)sc+=on[i]*on[i+lag];sc/=Math.sqrt(bpm);if(sc>best){best=sc;bb=bpm;}}
  while(bb>=170)bb/=2;while(bb<75)bb*=2;bb=Math.round(bb);
  const P=60/bb/fs;let ph=0,pm=0;for(let k=0;k<P;k+=1){let sc=0;for(let t=k;t<n;t+=P)sc+=on[Math.round(t)]||0;if(sc>pm){pm=sc;ph=k;}}
  const bl=60/bb,off=(((from*1/b.sampleRate)+ph*fs)%bl+bl)%bl,c=cues();c.bpm=bb;c.off=off;save(c);
  $('dj-tap').textContent=bb+' BPM';toast('Detected '+bb+' BPM',1800);return bb;
}
function beatLoop(n){
  let c=cues();if(!c.bpm&&!autoBpm())return;c=cues();
  const bl=60/c.bpm,off=c.off||0,a=audio.currentTime,k=Math.round((a-off)/bl);
  loopA=Math.max(0,off+k*bl);loopB=Math.min(dur(),loopA+bl*n);if(audio.currentTime>=loopB||audio.currentTime<loopA)audio.currentTime=loopA;
}
// spectrum ring behind the record
let AN=null,FD=null,FX=null;
function ensureAn(){
  if(AN!==null)return AN;AN=false;
  try{const c=ac(),src=c.createMediaElementSource(audio),a=c.createAnalyser();a.fftSize=256;a.smoothingTimeConstant=.8;const f=c.createBiquadFilter(),dl=c.createDelay(2),fb=c.createGain(),wt=c.createGain(),sd=c.createGain();f.type='lowpass';f.frequency.value=22000;f.Q.value=.9;dl.delayTime.value=.375;fb.gain.value=.45;wt.gain.value=.6;sd.gain.value=0;src.connect(f);f.connect(a);a.connect(c.destination);f.connect(sd);sd.connect(dl);dl.connect(fb);fb.connect(dl);dl.connect(wt);wt.connect(c.destination);FX={f,dl,sd};FD=new Uint8Array(a.frequencyBinCount);AN=a;}catch(e){AN=false;}
  return AN;
}

function fxReady(){if(!ensureAn()||!FX){toast('Filter and echo switch on after your first click in the app - click once, then try again',3200);return false;}return true;}
function setFilter(v){if(!fxReady())return;const f=FX.f,t=ac().currentTime;
  if(Math.abs(v)<.03){f.type='lowpass';f.frequency.setTargetAtTime(22000,t,.03);}
  else if(v<0){f.type='lowpass';f.frequency.setTargetAtTime(22000*Math.pow(150/22000,-v),t,.03);}
  else{f.type='highpass';f.frequency.setTargetAtTime(20*Math.pow(6000/20,v),t,.03);}}
const fl=$('dj-flt');fl.oninput=()=>setFilter(+fl.value/100);fl.ondblclick=()=>{fl.value=0;setFilter(0);};
const eb=$('dj-echo');
eb.addEventListener('pointerdown',e=>{e.preventDefault();if(!fxReady())return;const c=cues();FX.dl.delayTime.setTargetAtTime(c.bpm?Math.min(1.9,60/c.bpm*.75):.375,ac().currentTime,.01);FX.sd.gain.setTargetAtTime(1,ac().currentTime,.01);eb.classList.add('on');});
['pointerup','pointercancel','pointerleave'].forEach(ev=>eb.addEventListener(ev,()=>{if(FX)FX.sd.gain.setTargetAtTime(0,ac().currentTime,.02);eb.classList.remove('on');}));
// RESET ALL: cues, loop, BPM, speed, key lock, FILTER, ECHO, match-BPM box, zoom, reverse play
function djResetFilter(){
  const f=$('dj-flt');f.value=0;
  if(FX){const t=ac().currentTime;FX.f.type='lowpass';FX.f.frequency.cancelScheduledValues(t);FX.f.frequency.setTargetAtTime(22000,t,.03);}
}
function djResetAll(){
  if(st&&st.revplay){st.revplay=false;st.hold=0;st.tau=.3;}
  slip=null;loopA=loopB=null;taps=[];
  if(curTrack())localStorage.removeItem(K());cq={k:null,v:null};
  $('dj-tap').textContent='TAP BPM';$('dj-tb').value='';
  $('dj-pitch').value=0;$('dj-pitch').oninput();audio.preservesPitch=true;$('dj-key').classList.add('on');
  djResetFilter();
  if(FX){FX.sd.gain.cancelScheduledValues(ac().currentTime);FX.sd.gain.setTargetAtTime(0,ac().currentTime,.02);}
  eb.classList.remove('on');setZoom(1);
  toast('DJ tools reset');
}
// a new song starts at normal speed with no loop carried over (the browser resets the speed on load, the slider did not follow)
audio.addEventListener('loadstart',()=>{loopA=loopB=null;slip=null;const p=$('dj-pitch');if(+p.value!==0){p.value=0;p.oninput();}});
function syncBpm(){
  let c=cues();if(!c.bpm&&!autoBpm())return;c=cues();const tb=+$('dj-tb').value;
  if(!tb){toast('Type the BPM you want to match first, for example 124');return;}
  let pc=(tb/c.bpm-1)*100;if(Math.abs(pc)>16){toast('That is more than 16% away, matched as far as the fader goes');pc=Math.max(-16,Math.min(16,pc));}
  $('dj-pitch').value=pc.toFixed(1);$('dj-pitch').oninput();audio.preservesPitch=true;$('dj-key').classList.add('on');
}

// ---------- ULTRON: reverse play, loop roll with slip ----------
function reversePlay(){
  if(st&&st.revplay){st.revplay=false;st.hold=0;st.tau=.3;return;}
  if(st)return;begin({hold:-1,revplay:true,was:!audio.paused});
}
let slip=null;
function rollStart(f){
  if(slip||st)return;if(audio.paused){toast('Loop roll works while the song is playing');return;}
  let c=cues();if(!c.bpm&&!autoBpm())return;c=cues();
  const a=audio.currentTime;slip={t:a,at:performance.now()};loopA=a;loopB=Math.min(dur(),a+60/c.bpm*f);
}
function rollEnd(){if(!slip)return;loopA=loopB=null;audio.currentTime=Math.min(dur()-.05,slip.t+(performance.now()-slip.at)/1000*audio.playbackRate);slip=null;}
panel.querySelectorAll('.roll').forEach(b=>{
  b.addEventListener('pointerdown',e=>{e.preventDefault();rollStart(+b.dataset.f);});
  ['pointerup','pointercancel','pointerleave'].forEach(ev=>b.addEventListener(ev,rollEnd));});
document.addEventListener('keyup',e=>{const k=(e.key||'').toLowerCase();if(k.length===1&&'asd'.includes(k))rollEnd();if(k==='e'&&eb)eb.dispatchEvent(new PointerEvent('pointerup'));},true);
setInterval(()=>{const r=$('dj-rev');if(r)r.classList.toggle('on',!!(st&&st.revplay));},200);
document.addEventListener('pointerdown',()=>{ensureAn();},{once:true,capture:true});
setInterval(()=>{if(AN&&AC&&AC.state==='suspended')AC.resume();},1000);
if(getComputedStyle(deck).position==='static')deck.style.position='relative';
const fx=document.createElement('canvas');fx.className='dj-fx';deck.insertBefore(fx,deck.firstChild);
function fxDraw(){
  if(!AN||DJ.ring===false||audio.paused&&!st){const c0=fx.getContext('2d');c0.clearRect(0,0,fx.width,fx.height);return;}
  const W=fx.clientWidth*devicePixelRatio;if(fx.width!==W){fx.width=W;fx.height=W;}
  AN.getByteFrequencyData(FD);const c=fx.getContext('2d'),m=W/2,r0=m*.69,col=getComputedStyle(NP).getPropertyValue('--npc')||'#fff',N=64;
  c.clearRect(0,0,W,W);c.strokeStyle=col;c.lineCap='round';c.lineWidth=Math.max(2,W/170);
  let bass=0;for(let i=0;i<6;i++)bass+=FD[i];bass/=6*255;
  for(let i=0;i<N;i++){const v=FD[Math.floor(i/N*FD.length*.8)]/255,a=i/N*Math.PI*2-Math.PI/2,l=m*(.03+.22*v*v+.05*bass);
    c.globalAlpha=.35+.65*v;c.beginPath();c.moveTo(m+Math.cos(a)*r0,m+Math.sin(a)*r0);c.lineTo(m+Math.cos(a)*(r0+l),m+Math.sin(a)*(r0+l));c.stroke();}
  c.globalAlpha=1;
}
const _tick=djTick;
(function fxLoop(){requestAnimationFrame(fxLoop);if(!NP.classList.contains('hidden'))fxDraw();})();
// sleep timer
const sl=document.createElement('button');sl.className='npg-sleep';sl.title='Sleep timer: the music fades out and stops';sl.textContent='SLEEP OFF';NP.appendChild(sl);
let slEnd=0,slVol=null;const SL=[0,15,30,60];let si=0;
sl.onclick=()=>{si=(si+1)%SL.length;if(slVol!=null){audio.volume=slVol;slVol=null;}slEnd=SL[si]?Date.now()+SL[si]*60000:0;sl.textContent=SL[si]?'SLEEP '+SL[si]+'m':'SLEEP OFF';sl.classList.toggle('on',!!SL[si]);};
setInterval(()=>{if(!slEnd)return;const r=(slEnd-Date.now())/1000;
  if(r<=0){audio.pause();if(slVol!=null)audio.volume=slVol;slVol=null;slEnd=0;si=0;sl.textContent='SLEEP OFF';sl.classList.remove('on');toast('Sleep timer: goodnight');return;}
  sl.textContent='SLEEP '+(r>=60?Math.ceil(r/60)+'m':Math.ceil(r)+'s');
  if(r<=20){if(slVol==null)slVol=audio.volume;audio.volume=Math.max(0,slVol*r/20);}},500);
// shortcut sheet: press ?
const sh=document.createElement('div');sh.id='dj-sheet';sh.innerHTML='<div><h3>SHORTCUTS</h3><p><b>?</b> this sheet &nbsp; <b>Esc</b> close</p><p><b>Now Playing</b></p><p><b>1-4</b> jump points &nbsp; <b>C</b> cue</p><p><b>I / O / X</b> loop start / end / stop</p><p><b>B</b> backspin &nbsp; <b>N</b> brake</p><p><b>,</b> hold rewind &nbsp; <b>.</b> hold fast forward</p><p><b>R</b> reverse play &nbsp; <b>A / S / D</b> hold for loop roll 1/2, 1/4, 1/8 &nbsp; <b>E</b> hold for echo</p><p><b>BEAT LOOP</b> buttons need a BPM: AUTO BPM finds it for you</p><p><b>SLEEP</b> top right fades the music out</p></div>';
sh.onclick=()=>sh.classList.remove('open');document.body.appendChild(sh);
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName||''))return;if(e.key==='?'){if(NP&&!NP.classList.contains('hidden')){sh.classList.toggle('open');e.stopImmediatePropagation();e.preventDefault();}}else if(e.key==='Escape')sh.classList.remove('open');},true);   /* ? shows the DJ sheet only on the Now Playing screen; everywhere else it is the app's own sheet (never both) */
window.DJ=DJ;djPaint();discoPaint();
})();
