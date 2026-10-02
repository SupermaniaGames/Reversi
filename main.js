let mp;
try{mp=await import('./multiplayer.js')}catch(e){
  console.error('Firebase setup problem:',e);
  const why=String(e&&e.message||'').includes('Firebase config')?e.message:'Online play is not set up. Check firebase-config.js';
  const off=()=>{throw new Error(why)};
  mp={me:()=>null,onUser(cb){setTimeout(()=>cb(null))},signIn:off,signUp:off,guest:off,logout:async()=>{},createRoom:off,joinRoom:off,txRoom:off,watchRoom:off,setRoom:off,sendChat:off,watchChat:off,saveProfile:async()=>{},loadProfile:async()=>null};
}

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const NAME={1:'Black',2:'White'},LV={easy:'Easy',medium:'Medium',hard:'Hard',expert:'Expert'};
const S={mode:'pass',level:'medium',first:1,how:'basics',hints:'on'};
try{if(localStorage.getItem('rv_hints')=='off')S.hints='off'}catch{}
const saveHints=()=>{try{localStorage.setItem('rv_hints',S.hints)}catch{}};
let g=null,ctx={},upd=false,pendingRoom=null;
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;

const show=id=>$$('.sc').forEach(s=>s.hidden=s.id!=id);
const say=(id,m)=>$('#'+id).textContent=m||'';
const fe=e=>({'auth/email-already-in-use':'That username is taken','auth/invalid-credential':'Wrong username or password','auth/user-not-found':'Wrong username or password','auth/wrong-password':'Wrong username or password','auth/operation-not-allowed':'Turn on Email/Password sign-in in Firebase','auth/network-request-failed':'No connection','auth/admin-restricted-operation':'Turn on Anonymous sign-in in Firebase','permission-denied':'The database rules are blocking this. Add the reversiRooms rules in Firebase.'}[e.code]||e.message||String(e));

/* ---------- rules (pure functions, reused by the computer and the online patches) ---------- */
// b: 64 numbers, index = row*8+col, row 0 = top, col 0 = file A. 0 empty, 1 Black, 2 White.
const DIRS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const startBoard=()=>{const b=Array(64).fill(0);b[27]=2;b[36]=2;b[28]=1;b[35]=1;return b};
// the discs p would flip by playing at i, grouped per direction and ordered outward from i (empty list = illegal move)
function linesAt(b,i,p){
  if(b[i])return [];
  const r=i>>3,c=i&7,o=3-p,out=[];
  for(const [dr,dc] of DIRS){
    const line=[];let rr=r+dr,cc=c+dc;
    while(rr>=0&&rr<8&&cc>=0&&cc<8&&b[rr*8+cc]==o){line.push(rr*8+cc);rr+=dr;cc+=dc}
    if(line.length&&rr>=0&&rr<8&&cc>=0&&cc<8&&b[rr*8+cc]==p)out.push(line);
  }
  return out;
}
const legalMoves=(b,p)=>{const m=[];for(let i=0;i<64;i++)if(!b[i]&&linesAt(b,i,p).length)m.push(i);return m};
function applyDiscs(b,i,p){const nb=b.slice();nb[i]=p;for(const l of linesAt(b,i,p))for(const x of l)nb[x]=p;return nb}
const countDiscs=b=>{const n=[0,0,0];for(const x of b)n[x]++;return n};
// who moves after `mover` has played: the opponent, or the mover again if the opponent must pass, or the game is over
function advance(b,mover){
  const o=3-mover;
  if(legalMoves(b,o).length)return {turn:o,pass:0,over:false};
  if(legalMoves(b,mover).length)return {turn:mover,pass:o,over:false};
  return {turn:mover,pass:0,over:true};
}
const winnerOf=b=>{const n=countDiscs(b);return n[1]>n[2]?1:n[2]>n[1]?2:0};
const sqName=i=>'ABCDEFGH'[i&7]+((i>>3)+1);

/* ---------- sound: your files if present, otherwise synthesised ---------- */
let ac=null,muted=false,soundsLoaded=false;const bufs={};
try{muted=localStorage.getItem('rv_mute')=='1'}catch{}
const audio=()=>{
  if(!ac){try{ac=new(window.AudioContext||window.webkitAudioContext)()}catch{return null}}
  if(ac.state=='suspended')ac.resume();return ac;
};
async function loadSounds(){
  if(soundsLoaded)return;soundsLoaded=true;
  const a=audio();if(!a)return;
  for(const n of ['place','flip','win','lose','start']){
    try{const r=await fetch(n+'.mp3');if(!r.ok)continue;bufs[n]=await a.decodeAudioData(await r.arrayBuffer())}catch{}
  }
}
document.addEventListener('pointerdown',()=>{audio();loadSounds()},{passive:true});
function playBuf(n,v=1){
  const a=audio(),b=bufs[n];if(!a||muted||!b)return false;
  const s=a.createBufferSource(),gn=a.createGain();gn.gain.value=v;s.buffer=b;s.connect(gn).connect(a.destination);s.start();return true;
}
function tone(f,t0,d,type,v){
  const a=audio();if(!a||muted)return;
  const o=a.createOscillator(),gn=a.createGain(),t=a.currentTime+t0;
  o.type=type;o.frequency.setValueAtTime(f,t);gn.gain.setValueAtTime(v,t);gn.gain.exponentialRampToValueAtTime(.001,t+d);
  o.connect(gn).connect(a.destination);o.start(t);o.stop(t+d);
}
function slide(f0,f1,t0,d,type,v){
  const a=audio();if(!a||muted)return;
  const o=a.createOscillator(),gn=a.createGain(),t=a.currentTime+t0;
  o.type=type;o.frequency.setValueAtTime(f0,t);o.frequency.exponentialRampToValueAtTime(f1,t+d);
  gn.gain.setValueAtTime(v,t);gn.gain.exponentialRampToValueAtTime(.001,t+d);
  o.connect(gn).connect(a.destination);o.start(t);o.stop(t+d);
}
// short plastic "clack": muffled noise tick plus a low thump
function clack(t0,v,f){
  const a=audio();if(!a||muted)return;
  const t=a.currentTime+t0,n=Math.floor(a.sampleRate*.04),buf=a.createBuffer(1,n,a.sampleRate),ch=buf.getChannelData(0);
  for(let i=0;i<n;i++)ch[i]=(Math.random()*2-1)*Math.pow(1-i/n,3);
  const s=a.createBufferSource(),lp=a.createBiquadFilter(),gn=a.createGain();
  lp.type='lowpass';lp.frequency.value=f;gn.gain.value=v;s.buffer=buf;
  s.connect(lp).connect(gn).connect(a.destination);s.start(t);
  const o=a.createOscillator(),og=a.createGain();
  o.type='sine';o.frequency.setValueAtTime(150+f/12,t);o.frequency.exponentialRampToValueAtTime(70,t+.06);
  og.gain.setValueAtTime(v*.6,t);og.gain.exponentialRampToValueAtTime(.001,t+.08);
  o.connect(og).connect(a.destination);o.start(t);o.stop(t+.09);
}
const sfx={
  place(){if(playBuf('place'))return;clack(0,.5,1700);clack(.1,.2,1200);clack(.17,.08,900)},
  flip(){if(playBuf('flip',.6))return;clack(0,.2,2800)},
  start(){if(playBuf('start'))return;[392,523,659,784].forEach((f,i)=>tone(f,i*.11,.22,'triangle',.2));tone(1047,.5,.6,'triangle',.22)},
  win(){if(playBuf('win'))return;[523,659,784,1047,784,1047,1319].forEach((f,i)=>tone(f,i*.13,.32,'triangle',.22));tone(262,0,1,'sine',.14)},
  lose(){if(playBuf('lose'))return;slide(440,110,0,.6,'sawtooth',.13);slide(330,80,.3,.7,'sawtooth',.13)}
};
const setMuteLabel=()=>$('#mute').textContent=muted?'Muted':'Sound';
setMuteLabel();
$('#mute').onclick=()=>{muted=!muted;try{localStorage.setItem('rv_mute',muted?'1':'0')}catch{}setMuteLabel();if(!muted)sfx.place()};

/* ---------- characters ---------- */
const AVS=['🦁','🐯','🐼','🦊','🐸','🐵','🦄','🐲','🤖','👑','🥷','🧙','👻','🐧','🦖','🐙'];
const myAv=()=>{try{return localStorage.getItem('rv_av')||AVS[0]}catch{return AVS[0]}};
const setAv=a=>{try{localStorage.setItem('rv_av',a)}catch{}if(mp.me())mp.saveProfile(a).catch(()=>{})};
function buildAvGrid(){
  const gr=$('#avgrid');gr.innerHTML='';
  AVS.forEach(a=>{
    const b=document.createElement('button');b.textContent=a;b.setAttribute('aria-label','Character '+a);
    b.classList.toggle('on',a==myAv());
    b.onclick=()=>{setAv(a);buildAvGrid()};gr.append(b);
  });
}

/* ---------- menu ---------- */
function markSeg(){
  $$('.seg').forEach(sg=>[...sg.children].forEach(b=>b.classList.toggle('on',String(S[sg.dataset.k])==b.dataset.v)));
  const bot=S.mode=='bot';$('#lvl').hidden=!bot;$('#lvll').hidden=!bot;
  $$('.hp').forEach(p=>p.hidden=p.dataset.t!=S.how);
  $('#hintbtn').textContent='Hints: '+(S.hints=='on'?'On':'Off');
}
$$('.seg').forEach(sg=>sg.onclick=e=>{const b=e.target.closest('button');if(!b)return;S[sg.dataset.k]=isNaN(b.dataset.v)?b.dataset.v:+b.dataset.v;if(sg.dataset.k=='hints')saveHints();markSeg()});
markSeg();
// small diagram boards on the How to play screen: B black, W white, N new disc, F flipped disc, h legal-move dot
$$('.mini[data-s]').forEach(x=>{x.innerHTML=[...x.dataset.s.replace(/\|/g,'')].map(c=>c=='.'?'<i></i>':'<i class="'+c+'"></i>').join('')});

function renderMe(){
  const u=mp.me(),m=$('#me');m.innerHTML='';
  const ab=document.createElement('button');ab.className='avbtn';ab.textContent=myAv();ab.setAttribute('aria-label','Choose your character');
  ab.onclick=()=>{buildAvGrid();show('chars')};m.append(ab);
  const un=document.createElement('span');un.className='uname';un.textContent=u?u.name:'Not signed in';m.append(un);
  const b=document.createElement('button');b.className='btn';
  if(u){b.textContent='Log out';b.onclick=async()=>{await mp.logout();renderMe()}}
  else{b.textContent='Sign in';b.onclick=()=>show('auth')}
  m.append(b);
}
async function syncProfile(){
  try{const p=await mp.loadProfile();if(p&&p.rvav&&p.rvav!=myAv()){try{localStorage.setItem('rv_av',p.rvav)}catch{}renderMe()}}catch{}
}
mp.onUser(u=>{renderMe();if(u)syncProfile();tryPending()});
renderMe();
try{const lu=localStorage.getItem('rv_user');if(lu)$('#u').value=lu}catch{}

function leave(){
  exitRoom();
  [ctx.ru,ctx.cu].forEach(f=>{if(f)try{f()}catch{}});
  ['t1','t2','bt','bk','nx','rr','rt','nt'].forEach(k=>clearTimeout(ctx[k]));clearInterval(ctx.tt);
  (ctx.fx||[]).forEach(clearTimeout);ctx={};g=null;
  $('#result').hidden=true;$('#dlg').hidden=true;$('#chat').hidden=true;$('#chatbtn').hidden=true;$('#chatbtn').classList.remove('new');
  $('#series').hidden=true;$('#note').textContent='';
  $('#rreplay').textContent='Replay';$('#rreplay').disabled=false;
}
function home(){leave();show('home');renderMe();applyUpdate()}

$$('[data-go]').forEach(b=>b.onclick=()=>{
  const v=b.dataset.go;
  if(v=='how'){S.how='basics';markSeg();return show('how')}
  if(v=='friends')return show(mp.me()?'friends':'auth');
  if(v=='bot')return ask('Computer comes in step 2','The computer opponent and its four levels are built in step 2. Try Pass N Play for now.','OK',()=>{},true);
  S.mode=v;markSeg();show('setup');
});

async function doAuth(create){
  const u=$('#u').value.trim(),p=$('#p').value;
  if(!/^[A-Za-z0-9_]{3,14}$/.test(u))return say('aerr','Username: 3-14 letters, numbers or _');
  if(p.length<6)return say('aerr','Password needs 6 or more characters');
  try{
    create?await mp.signUp(u,p):await mp.signIn(u,p);
    try{localStorage.setItem('rv_user',u)}catch{}
    say('aerr');$('#p').value='';
    if(create)mp.saveProfile(myAv()).catch(()=>{});else await syncProfile();
    afterAuth();
  }catch(e){say('aerr',fe(e))}
}
$('#guest').onclick=async()=>{
  const t=$('#u').value.trim(),name=/^[A-Za-z0-9_]{3,14}$/.test(t)?t:'Guest'+(1000+Math.floor(Math.random()*9000));
  try{await mp.guest(name);say('aerr');afterAuth()}catch(e){say('aerr',fe(e))}
};
$('#signin').onclick=()=>doAuth(false);
$('#signup').onclick=()=>doAuth(true);

function afterAuth(){renderMe();if(pendingRoom)tryPending();else if(!ctx.room)show('friends')}

/* ---------- computer: added in step 2 ---------- */

/* ---------- start a game ---------- */
$('#play').onclick=startGame;
function startGame(){
  if(S.mode=='bot')return ask('Computer comes in step 2','The computer opponent and its four levels are built in step 2. Pass N Play works now.','OK',()=>{},true);
  leave();
  const first=S.first=='r'?1+Math.floor(Math.random()*2):+S.first;
  const u=mp.me(),a1=myAv(),a2=AVS[(AVS.indexOf(a1)+1)%AVS.length],bot=S.mode=='bot';
  g={b:startBoard(),shown:startBoard(),turn:first,moves:0,st:'play',busy:false,bot,level:S.level,idle:0,last:-1,winner:0,
     names:{1:u&&u.name||(bot?'You':'Player 1'),2:bot?'Computer':'Player 2'},avs:{1:a1,2:bot?'🤖':a2}};
  show('game');$('#series').hidden=true;note('');buildCards();buildBoard();status();sfx.start();
}

// online, every player sees themselves as Black (view colour 1) and the other player as White
const vc=s=>g.online?(s==g.seat?1:2):s;
const seatOf=v=>g.online?(v==1?g.seat:3-g.seat):v;
const myTurn=()=>!g?false:g.online?g.turn==g.seat:g.bot?g.turn==1:true;
function buildCards(){
  const el=$('#cards');el.innerHTML='';
  [1,2].forEach(v=>{
    const s=seatOf(v);
    const d=document.createElement('div');d.className='pc p'+v+(v==2?' r':'');d.dataset.s=s;
    d.innerHTML='<span class="av"></span><div class="pn"><b></b><small></small></div><i class="chip"></i>';
    d.querySelector('.av').textContent=g.avs[s];
    d.querySelector('b').textContent=g.names[s];
    d.querySelector('small').textContent=NAME[v]+(g.bot&&v==2?' · '+LV[g.level]:'');
    el.append(d);
  });
  markCards();
}
const markCards=()=>$$('.pc').forEach(d=>d.classList.toggle('act',!!g&&g.st=='play'&&+d.dataset.s==g.turn));
// live disc count, taken from what is on screen (so it changes as the discs flip)
function renderCounts(){
  if(!g)return;const n=countDiscs(g.shown);
  $$('.pc').forEach(d=>d.querySelector('.chip').textContent=n[+d.dataset.s]);
}

function status(){
  const s=$('#status');s.innerHTML='';
  if(!g)return;
  const i=document.createElement('i');i.className='v'+vc(g.turn);
  const t=document.createElement('span');
  if(g.st=='done')t.textContent=g.winner?g.names[g.winner]+' wins':'Draw';
  else t.textContent=g.bot?(g.turn==1?'Your turn':'Computer is thinking'):g.names[g.turn]+"'s turn";
  s.append(i,t);
}

/* ---------- board ---------- */
const cell=i=>$('#sq .sq[data-i="'+i+'"]');
const discAt=i=>$('#sq .sq[data-i="'+i+'"] .d');
// view colour 1 = black face up, 2 = white face up; --n counts half turns so every flip rotates the same way
function disc(v){
  const d=document.createElement('div');d.className='d';
  d.innerHTML='<i class="sh"></i><div class="fl"><b class="fa"></b><b class="fb"></b></div>';
  d.querySelector('.fl').style.setProperty('--n',v==1?0:1);return d;
}
function buildBoard(){
  const b=$('#board');
  b.innerHTML='<div id="plate"><div id="lc"></div><div id="lr"></div><div id="gold"><div id="bfrm"><div id="sq"></div><div id="wl"></div></div></div></div>';
  $('#lc').innerHTML=[...'ABCDEFGH'].map(x=>'<span>'+x+'</span>').join('');
  $('#lr').innerHTML=[1,2,3,4,5,6,7,8].map(x=>'<span>'+x+'</span>').join('');
  const sq=$('#sq');
  for(let i=0;i<64;i++){
    const k=document.createElement('button');k.className='sq';k.dataset.i=i;k.setAttribute('aria-label','Square '+sqName(i));
    k.onclick=()=>tap(i);sq.append(k);
  }
  syncDiscs(g.b);syncCells();
}
function syncDiscs(b){
  $$('#sq .d').forEach(d=>d.remove());
  b.forEach((s,i)=>{if(s)cell(i).append(disc(vc(s)))});
  g.shown=b.slice();renderCounts();
}
// enable squares, show the legal-move dots (if hints are on) and the last-move marker
function syncCells(){
  if(!g)return;
  const play=g.st=='play'&&!g.busy&&!g.sending&&myTurn();
  const moves=play&&S.hints=='on'?legalMoves(g.b,g.turn):[],hv=vc(g.turn);
  $$('#sq .sq').forEach((k,i)=>{
    k.disabled=!play||!!g.b[i];
    k.classList.toggle('h',moves.includes(i));
    k.classList.toggle('hb',hv==1);k.classList.toggle('hw',hv==2);
    k.classList.toggle('last',i==g.last);
  });
}
// timers for animations; all of them are cleared when the game is left
const later=(fn,ms)=>{(ctx.fx=ctx.fx||[]).push(setTimeout(()=>{if(g)fn()},ms))};
function shake(i){const k=cell(i);k.classList.remove('no');void k.offsetWidth;k.classList.add('no');later(()=>k.classList.remove('no'),400)}

function tap(i){
  if(!g||g.st!='play'||g.busy||g.sending||!myTurn()||g.b[i])return;
  if(!linesAt(g.b,i,g.turn).length){shake(i);note('That square is not a legal move. A move must trap at least one disc.',2800);return}
  note('');
  doMove(i);
}

function doMove(i){
  const p=g.turn,lines=linesAt(g.b,i,p);if(!lines.length)return;
  g.busy=true;g.last=i;g.b=applyDiscs(g.b,i,p);g.moves++;
  syncCells();
  animateMove(i,p,lines,()=>{g.busy=false;afterMove(p)});
}

// the new disc drops in with a bounce, then every trapped disc flips over, one after another along each line
function animateMove(i,p,lines,done){
  const el=disc(vc(p));el.classList.add('drop');cell(i).append(el);
  g.shown[i]=p;renderCounts();sfx.place();
  const FD=reduced?.05:.5,ST=reduced?0:.11,BASE=reduced?.05:.38;
  let end=(reduced?.05:.42)*1000;
  lines.forEach(line=>line.forEach((x,k)=>{
    const t=BASE+k*ST,d=discAt(x),fl=d.querySelector('.fl');
    d.style.setProperty('--del',t+'s');d.style.setProperty('--fd',FD+'s');
    d.classList.add('fx');fl.style.setProperty('--n',+fl.style.getPropertyValue('--n')+1);
    later(()=>{sfx.flip();g.shown[x]=p;renderCounts()},(t+FD*.45)*1000);
    later(()=>d.classList.remove('fx'),(t+FD)*1000+30);
    end=Math.max(end,(t+FD)*1000+60);
  }));
  later(()=>{el.classList.remove('drop');done()},end);
}

function afterMove(p){
  const a=advance(g.b,p);
  if(a.over)return finish();
  g.turn=a.turn;
  if(a.pass)note(NAME[vc(a.pass)]+' has no legal move and passes. '+NAME[vc(a.turn)]+' plays again.',4500);
  markCards();status();syncCells();
}

function finish(){
  g.st='done';g.winner=winnerOf(g.b);
  markCards();status();syncCells();markWin(g.winner);
  if(g.winner&&!(g.bot&&g.winner==2))sfx.win();else sfx.lose();
  ctx.t1=setTimeout(showResult,g.winner?1500:700);
}
// pulse a ring on every disc of the winner
function markWin(w){$$('#sq .sq').forEach((k,i)=>k.classList.toggle('win',!!w&&!!g&&g.b[i]==w))}
$('#hintbtn').onclick=()=>{S.hints=S.hints=='on'?'off':'on';saveHints();markSeg();syncCells()};

/* ---------- online rooms: added in step 3 ---------- */
const TARGET=2,TURN_MS=15000;   // best of 3, first to 2 wins the series; 15 seconds per turn
const comingOnline=()=>ask('Online play comes in step 3','Rooms, chat, timers, series and rematch are built in step 3.','OK',()=>{},true);
$('#create').onclick=comingOnline;$('#join').onclick=comingOnline;
// an invite link (?room=1234) joins automatically once the player is signed in
(()=>{const q=new URLSearchParams(location.search).get('room');if(/^\d{4}$/.test(q||'')){pendingRoom=q;history.replaceState(null,'',location.pathname)}})();
function tryPending(){
  if(!pendingRoom)return;
  if(!mp.me()){if(cur()!='auth'){say('aerr','Sign in or play as guest to join room '+pendingRoom);show('auth')}return}
  pendingRoom=null;comingOnline();
}
function exitRoom(){}
function note(m,ms){clearTimeout(ctx.nt);$('#note').textContent=m||'';if(m&&ms)ctx.nt=setTimeout(()=>{$('#note').textContent=''},ms)}

/* ---- timer (online and against the computer) ---- */
function stopTimer(){clearInterval(ctx.tt);clearTimeout(ctx.bk);$$('.pc').forEach(d=>delete d.dataset.t)}
function startTimer(seat,onTimeout){
  stopTimer();
  const end=Date.now()+TURN_MS,card=$('.pc[data-s="'+seat+'"]');
  const tick=()=>{
    const left=Math.max(0,Math.ceil((end-Date.now())/1000));
    if(card)card.dataset.t=left;
    if(left<=0){clearInterval(ctx.tt);onTimeout()}
  };
  tick();ctx.tt=setInterval(tick,250);
}

/* ---- chat ---- */
function onChat(list){
  const box=$('#msgs'),u=mp.me();box.innerHTML='';
  list.forEach(m=>{
    const e=document.createElement('div');e.className='m'+(u&&m.uid==u.uid?' me':'');
    const b=document.createElement('b');b.textContent=m.name;
    const t=document.createElement('span');t.textContent=m.text;
    e.append(b,t);box.append(e);
  });
  box.scrollTop=box.scrollHeight;
  ctx.cl=list.length;
  if($('#chat').hidden){if(ctx.cl>(ctx.seen||0))$('#chatbtn').classList.add('new')}else ctx.seen=ctx.cl;
}
$('#chatbtn').onclick=()=>{$('#chat').hidden=false;ctx.seen=ctx.cl||0;$('#chatbtn').classList.remove('new');$('#msgs').scrollTop=$('#msgs').scrollHeight};
$('#cclose').onclick=()=>{$('#chat').hidden=true};
async function sendChatMsg(){
  const t=$('#ct').value.trim();if(!t||!ctx.room)return;
  $('#ct').value='';
  try{await mp.sendChat(ctx.room,t.slice(0,200))}catch(e){note(fe(e))}
}
$('#send').onclick=sendChatMsg;
$('#ct').onkeydown=e=>{if(e.key=='Enter')sendChatMsg()};

/* ---------- results ---------- */
function confetti(on){
  const cf=$('#confetti');cf.innerHTML='';
  if(on&&!reduced)for(let i=0;i<26;i++){
    const s=document.createElement('span');s.textContent=['🎉','✨','⭐','🎊'][i%4];
    s.style.left=Math.random()*100+'%';s.style.animationDuration=3+Math.random()*3+'s';s.style.animationDelay=Math.random()*3+'s';cf.append(s);
  }
}
function showResult(){
  if(!g||g.st!='done')return;
  const w=g.winner,n=countDiscs(g.b),list=$('#rlist');list.innerHTML='';
  $('#rtitle').textContent=!w?"It's a draw":g.bot?(w==1?'You win!':'Computer wins!'):g.names[w]+' wins!';
  const order=w?[w,3-w]:[1,2];
  order.forEach((p,i)=>{
    const row=document.createElement('div');row.className='rrow'+(w&&i==0?' r0':'');
    const av=document.createElement('span');av.className='rav';av.textContent=g.avs[p];
    const nm=document.createElement('span');nm.className='nm';nm.textContent=g.names[p]+' ('+NAME[vc(p)]+')';
    const tag=document.createElement('span');tag.textContent=n[p]+(n[p]==1?' disc':' discs');
    row.append(av,nm,tag);list.append(row);
  });
  confetti(!!w);
  $('#rreplay').textContent='Replay';$('#rreplay').disabled=false;
  $('#result').hidden=false;
}
$('#rmenu').onclick=home;
$('#rreplay').onclick=()=>{
  if(g&&g.online){const seat=g.seat;mp.txRoom(g.code,x=>x.status=='series'?{['rm'+seat]:true}:null).catch(()=>{});return}
  $('#result').hidden=true;startGame();
};
$('#rshare').onclick=()=>shareApp('I just played Supermania Reversi! Come play with me:');

/* ---------- share app ---------- */
async function shareApp(text){
  const url=location.origin+location.pathname.replace(/index\.html$/,'');
  text=text||'Play Supermania Reversi with me!';
  if(navigator.share){try{await navigator.share({title:'Supermania Reversi',text,url});return}catch(e){if(e.name=='AbortError')return}}
  window.open('https://wa.me/?text='+encodeURIComponent(text+'\n'+url),'_blank');
}
$('#shareapp').onclick=()=>shareApp();

/* ---------- "are you sure?" and the phone's back button ---------- */
function ask(title,text,yes,cb,info){
  $('#dno').hidden=!!info;
  $('#dt').textContent=title;$('#dp').textContent=text;$('#dyes').textContent=yes;
  $('#dyes').onclick=()=>{closeDlg();cb()};$('#dno').onclick=closeDlg;$('#dlg').hidden=false;
}
const closeDlg=()=>{$('#dlg').hidden=true};
const cur=()=>($$('.sc').find(s=>!s.hidden)||{}).id;
function leaveFlow(){
  const sc=cur();
  if(sc=='game'&&g&&(g.online?(g.st=='play'||g.st=='done'):g.st!='done'))ask('Leave game?',g.online?'Leaving now means you forfeit the series.':'Your game will be lost.','Leave',home);
  else home();
}
$$('[data-back]').forEach(b=>b.onclick=leaveFlow);
let armed=false,exiting=false;
document.addEventListener('pointerdown',()=>{if(!armed){armed=true;history.pushState({sm:1},'')}},{passive:true});
addEventListener('popstate',()=>{
  armed=false;
  if(exiting)return;
  if(!$('#dlg').hidden){closeDlg();return}
  if(!$('#result').hidden){home();return}
  if(cur()=='home')ask('Exit app?','Do you want to exit Supermania Reversi?','Exit',()=>{exiting=true;try{window.close()}catch{}history.go(-2)});
  else leaveFlow();
});

/* ---------- updates come from the network, never a stale cache ---------- */
if('serviceWorker' in navigator){
  const had=!!navigator.serviceWorker.controller;let reloaded=false;
  navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(r=>{
    r.update();
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState=='visible')r.update()});
  });
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(had&&!reloaded){reloaded=true;upd=true;applyUpdate()}});
}
// Resuming an installed app does not reload it, so compare the files on the server with the ones this
// page started with. A newer version reloads the app as soon as it is on a menu screen (never mid-game).
async function fileSig(){
  let h=0;
  for(const f of ['index.html','main.js','multiplayer.js','style.css','manifest.json','firebase-config.js']){
    const r=await fetch(f,{cache:'no-store'});if(!r.ok)throw 0;
    const t=await r.text();for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))|0;
  }
  return h;
}
let sig0=null;
async function checkUpdate(){
  if(!navigator.onLine||document.visibilityState!='visible')return;
  try{const s=await fileSig();if(sig0===null)sig0=s;else if(s!==sig0)upd=true}catch{}
  applyUpdate();
}
function applyUpdate(){
  if(!upd)return;
  if(!['home','how','setup','chars','auth','friends'].includes(cur())||!$('#result').hidden||!$('#dlg').hidden)return;
  location.reload();
}
checkUpdate();
document.addEventListener('visibilitychange',checkUpdate);
setInterval(checkUpdate,120000);

/* ---------- install button ---------- */
let installEvt=null;
const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone;
const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
let installedNow=false;
const showInstall=()=>{$('#install').hidden=!!standalone||installedNow};
addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvt=e;showInstall()});
addEventListener('appinstalled',()=>{installEvt=null;installedNow=true;showInstall()});
$('#install').onclick=async()=>{
  if(installEvt){installEvt.prompt();await installEvt.userChoice;installEvt=null;showInstall()}
  else if(isIOS)ask('Install on iPhone','Tap the Share button in Safari, then choose Add to Home Screen.','OK',()=>{},true);
  else installHelp();
};
// the browser has not offered its install prompt: say why it may be, and show what it sees
async function installHelp(){
  let m={};const mu=document.querySelector('link[rel=manifest]').href;
  try{m=await (await fetch(mu,{cache:'no-store'})).json()}catch{}
  const start=new URL(m.start_url||'.',mu),id=m.id?new URL(m.id,start.origin).href:'(none)',scope=new URL(m.scope||'.',mu).href;
  ask('Install app',
   'Chrome has not offered its install prompt. Try the 3 dot menu, then Install app or Add to Home screen.\n\n'+
   'If it says already installed, uninstall the older copy (long-press its icon, Uninstall), then clear this site\'s data in Chrome and reload.\n\n'+
   'This app sees:\nid: '+id+'\nscope: '+scope,'OK',()=>{},true);
}
showInstall();

