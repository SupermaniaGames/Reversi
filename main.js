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

/* ---------- computer ---------- */
// Pure functions: the board is the same flat array of 64 numbers; `me` is the colour (1 or 2) the computer plays.
const PW=(()=>{ // positional weights: corners great, the squares next to corners bad, edges good
  const q=[[100,-20,10,5],[-20,-50,-2,-2],[10,-2,1,1],[5,-2,1,0]],w=[];
  for(let r=0;r<8;r++)for(let c=0;c<8;c++)w.push(q[r<4?r:7-r][c<4?c:7-c]);
  return w;
})();
const CORNERS=[0,7,56,63],XSQ={9:0,14:7,49:56,54:63},CSQ={1:0,8:0,6:7,15:7,48:56,57:56,55:63,62:63};
const isEdge=i=>{const r=i>>3,c=i&7;return r==0||r==7||c==0||c==7};
const ORD=[...Array(64).keys()].sort((a,b)=>PW[b]-PW[a]);     // search order: best squares first
// every ray from a square, as lists of squares (needs 2+ squares to flank something)
const RAYS=Array.from({length:64},(_,i)=>{const r=i>>3,c=i&7,out=[];
  for(const [dr,dc] of DIRS){const ray=[];let rr=r+dr,cc=c+dc;while(rr>=0&&rr<8&&cc>=0&&cc<8){ray.push(rr*8+cc);rr+=dr;cc+=dc}if(ray.length>=2)out.push(ray)}
  return out});
// fast in-place move for the search: returns the number of flipped discs (0 = illegal, board untouched), fills fl
function makeFast(b,i,p,fl){
  let n=0;const o=3-p;
  for(const ray of RAYS[i]){
    let k=0;while(k<ray.length&&b[ray[k]]==o)k++;
    if(k>0&&k<ray.length&&b[ray[k]]==p)for(let j=0;j<k;j++){b[ray[j]]=p;fl[n++]=ray[j]}
  }
  if(n)b[i]=p;return n;
}
function undoFast(b,i,p,fl,n){b[i]=0;const o=3-p;for(let j=0;j<n;j++)b[fl[j]]=o}
function canFlip(b,i,p){
  const o=3-p;
  for(const ray of RAYS[i]){let k=0;while(k<ray.length&&b[ray[k]]==o)k++;if(k>0&&k<ray.length&&b[ray[k]]==p)return true}
  return false;
}
function mobilityOf(b,p){let n=0;for(let i=0;i<64;i++)if(!b[i]&&canFlip(b,i,p))n++;return n}
// discs that can never be flipped, counted along the edges from the corners we own
function stableEdge(b,p){
  let n=0;
  for(const [c,d1,d2] of [[0,1,8],[7,-1,8],[56,1,-8],[63,-1,-8]]){
    if(b[c]!=p)continue;n++;
    for(const d of [d1,d2]){let i=c+d;while(i>=0&&i<64&&b[i]==p&&(d==1||d==-1?(i>>3)==(c>>3):(i&7)==(c&7))){n++;i+=d}}
  }
  return n;
}
// static evaluation from p's point of view. kind 1 = hard (weights, mobility, corners), 2 = expert (adds stability and the stage of the game)
function evalPos(b,p,kind){
  const o=3-p;let pos=0,mine=0,theirs=0;
  for(let i=0;i<64;i++){const v=b[i];if(v==p){pos+=PW[i];mine++}else if(v==o){pos-=PW[i];theirs++}}
  // an X or C square is only bad while its corner is empty
  for(const x in XSQ)if(b[XSQ[x]]){if(b[x]==p)pos+=50;else if(b[x]==o)pos-=50}
  for(const x in CSQ)if(b[CSQ[x]]){if(b[x]==p)pos+=15;else if(b[x]==o)pos-=15}
  let cm=0;for(const c of CORNERS){if(b[c]==p)cm++;else if(b[c]==o)cm--}
  const mm=mobilityOf(b,p),mo=mobilityOf(b,o);
  if(kind==1)return pos+5*(mm-mo)+25*cm;
  const empties=64-mine-theirs,mob=(mm+mo)?100*(mm-mo)/(mm+mo):0;
  const st=stableEdge(b,p)-stableEdge(b,o),late=empties<16?(16-empties)/16:0;
  return pos*(empties>24?1:.6)+mob*(empties>12?4:2)+cm*40+st*10+(mine-theirs)*late*12;
}
// negamax with alpha-beta. Moves are tried best-square-first; passes do not use up depth; two passes in a row end the game.
function searchRoot(b0,me,o){
  const b=Int8Array.from(b0),fls=Array.from({length:70},()=>new Int8Array(24));
  let nodes=0,stop=false;const dl=Date.now()+o.ms;
  const timeUp=()=>{if(!(++nodes&511)&&Date.now()>dl)stop=true;return stop};
  function nm(p,d,al,be,ply,passed){
    if(timeUp())return 0;
    if(d<=0)return evalPos(b,p,o.kind);
    let best=-1e9,any=false;
    for(let k=0;k<64;k++){
      const i=ORD[k];if(b[i])continue;
      const n=makeFast(b,i,p,fls[ply]);if(!n)continue;
      any=true;
      const s=-nm(3-p,d-1,-be,-al,ply+1,false);
      undoFast(b,i,p,fls[ply],n);
      if(stop)return 0;
      if(s>best){best=s;if(s>al){al=s;if(al>=be)return best}}
    }
    if(!any){
      if(passed)return finalScore(b,p);
      return -nm(3-p,d,-be,-al,ply+1,true);
    }
    return best;
  }
  const rootMoves=()=>{const m=[];for(let i=0;i<64;i++)if(!b[i]&&canFlip(b,i,me))m.push(i);return m};
  return {nm,b,fls,rootMoves,get stop(){return stop},nodes:()=>nodes};
}
const finalScore=(b,p)=>{let d=0;for(let i=0;i<64;i++)d+=b[i]==p?1:b[i]?-1:0;return d*1000};
// best move at a fixed depth; PV (the previous best) is searched first. Returns {mv,score,done}
function bestAtDepth(S,me,depth,order){
  let best=-1,bs=-1e9,al=-1e9;
  for(const i of order){
    const n=makeFast(S.b,i,me,S.fls[0]);
    const s=-S.nm(3-me,depth-1,-1e9,-al,1,false);
    undoFast(S.b,i,me,S.fls[0],n);
    if(S.stop)return {mv:best,score:bs,done:false};
    if(s>bs){bs=s;best=i;if(s>al)al=s}
  }
  return {mv:best,score:bs,done:true};
}
// exact disc-difference solve of the endgame (few empty squares); null if the deadline passes first
function solveEnd(b0,me,ms){
  const b=Int8Array.from(b0),fls=Array.from({length:70},()=>new Int8Array(24));
  let nodes=0,stop=false;const dl=Date.now()+ms;
  function ex(p,al,be,ply,passed){
    if(!(++nodes&1023)&&Date.now()>dl)stop=true;if(stop)return 0;
    let best=-1e9,any=false;
    for(let k=0;k<64;k++){
      const i=ORD[k];if(b[i])continue;
      const n=makeFast(b,i,p,fls[ply]);if(!n)continue;
      any=true;
      const s=-ex(3-p,-be,-al,ply+1,false);
      undoFast(b,i,p,fls[ply],n);
      if(stop)return 0;
      if(s>best){best=s;if(s>al){al=s;if(al>=be)return best}}
    }
    if(!any)return passed?finalScore(b,p):-ex(3-p,-be,-al,ply+1,true);
    return best;
  }
  let best=-1,bs=-1e9;
  const moves=[];for(let k=0;k<64;k++){const i=ORD[k];if(!b[i]&&canFlip(b,i,me))moves.push(i)}
  for(const i of moves){
    const n=makeFast(b,i,me,fls[0]);
    const s=-ex(3-me,-1e9,-bs,1,false);
    undoFast(b,i,me,fls[0],n);
    if(stop)return null;
    if(s>bs){bs=s;best=i}
  }
  return best;
}
const shuffled=a=>{a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
// level: 'easy' | 'medium' | 'hard' | 'expert'. opts.ms overrides the expert's time limit (used by tests).
function pickMove(b,me,level,opts){
  const moves=legalMoves(b,me);
  if(moves.length<2)return moves.length?moves[0]:-1;
  if(level=='easy'){
    const cs=moves.filter(i=>CORNERS.includes(i));
    return cs.length&&Math.random()<.5?cs[0]:moves[Math.floor(Math.random()*moves.length)];
  }
  if(level=='medium'){
    let best=-1,bs=-1e9;
    for(const i of moves){
      const flips=linesAt(b,i,me).reduce((a,l)=>a+l.length,0);
      let s=flips*3+PW[i]*.5;
      if(CORNERS.includes(i))s+=200;else if(isEdge(i))s+=12;
      if(i in XSQ&&!b[XSQ[i]])s-=70;else if(i in CSQ&&!b[CSQ[i]])s-=40;
      s+=Math.random()*4;
      if(s>bs){bs=s;best=i}
    }
    return best;
  }
  const empties=b.reduce((a,x)=>a+(x?0:1),0);
  if(level=='hard'){
    const S=searchRoot(b,me,{ms:1500,kind:1});
    const r=bestAtDepth(S,me,4,shuffled(moves));
    return r.mv>=0?r.mv:moves[0];
  }
  // expert: iterative deepening to about depth 7 within the time limit, then an exact solve for the last squares
  const ms=(opts&&opts.ms)||1800,t0=Date.now();
  let order=shuffled(moves),best=order[0];
  const endgame=empties<=12;
  const first=bestAtDepth(searchRoot(b,me,{ms,kind:2}),me,Math.min(3,empties),order);   // quick fallback
  if(first.mv>=0){best=first.mv;order=[best,...order.filter(x=>x!=best)]}
  if(endgame){
    const ex=solveEnd(b,me,Math.max(100,ms-(Date.now()-t0)));
    if(ex!==null&&ex>=0)return ex;
  }
  const maxD=endgame?empties:7;
  for(let d=4;d<=maxD&&d<=9;d++){
    const left=ms-(Date.now()-t0);if(left<40)break;
    const Sd=searchRoot(b,me,{ms:left,kind:2});
    const r=bestAtDepth(Sd,me,d,order);
    if(!r.done)break;
    best=r.mv;order=[best,...order.filter(x=>x!=best)];
    if(Math.abs(r.score)>=900)break;   // forced win or loss found
  }
  return best;
}


/* ---------- start a game ---------- */
$('#play').onclick=startGame;
function startGame(){
  leave();
  const first=S.first=='r'?1+Math.floor(Math.random()*2):+S.first;
  const u=mp.me(),a1=myAv(),a2=AVS[(AVS.indexOf(a1)+1)%AVS.length],bot=S.mode=='bot';
  g={b:startBoard(),shown:startBoard(),turn:first,moves:0,st:'play',busy:false,bot,level:S.level,idle:0,last:-1,winner:0,
     names:{1:u&&u.name||(bot?'You':'Player 1'),2:bot?'Computer':'Player 2'},avs:{1:a1,2:bot?'🤖':a2}};
  show('game');$('#series').hidden=true;note('');buildCards();buildBoard();status();sfx.start();botTurn();humanTimer();
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
  if(g.online)t.textContent=g.st=='play'?(g.turn==g.seat?'Your turn':g.names[g.turn]+"'s turn"):g.st=='series'?'Series over':g.winner?(g.winner==g.seat?'You win this game':g.names[g.winner]+' wins this game'):'Draw';
  else if(g.st=='done')t.textContent=g.winner?g.names[g.winner]+' wins':'Draw';
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
  if(g.online)return sendMove(i);
  g.idle=0;doMove(i);
}

function doMove(i){
  const p=g.turn,lines=linesAt(g.b,i,p);if(!lines.length)return;
  stopTimer();g.busy=true;g.last=i;g.b=applyDiscs(g.b,i,p);g.moves++;
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
  markCards();status();syncCells();botTurn();humanTimer();
}

function finish(){
  g.st='done';g.winner=winnerOf(g.b);stopTimer();
  markCards();status();syncCells();markWin(g.winner);
  if(g.winner&&!(g.bot&&g.winner==2))sfx.win();else sfx.lose();
  ctx.t1=setTimeout(showResult,g.winner?1500:700);
}
// pulse a ring on every disc of the winner
function markWin(w){$$('#sq .sq').forEach((k,i)=>k.classList.toggle('win',!!w&&!!g&&g.b[i]==w))}
$('#hintbtn').onclick=()=>{S.hints=S.hints=='on'?'off':'on';saveHints();markSeg();syncCells()};

/* ---------- online rooms: lobby, best-of-3 series, timers, chat ---------- */
const TARGET=2,TURN_MS=15000;   // 3 games at most, first to 2 wins the series; 15 seconds per turn
const zeros=()=>Array(64).fill(0);
const inviteUrl=code=>location.origin+location.pathname.replace(/index\.html$/,'')+'?room='+code;

// Pure patch builders. They run inside Firestore transactions, so they only look at the room data they are given.
// The room board holds seat numbers (1 = host, 2 = guest). Every change is guarded by gid (which game) and moves (which move).
function applyMove(d,seat,sq,auto){
  if(d.status!='play'||d.turn!=seat||!(sq>=0&&sq<64))return null;
  if(!linesAt(d.b,sq,seat).length)return null;
  const b=applyDiscs(d.b,sq,seat);
  const p={b,moves:d.moves+1,lm:sq,pass:0};
  p['idle'+seat]=auto?(d['idle'+seat]||0)+1:0;
  const a=advance(b,seat);
  if(a.over){
    const w=winnerOf(b);
    if(w){const k='s'+w,n=(d[k]||0)+1;p[k]=n;if(n>=TARGET){p.status='series';p.sw=w;p.why='win'}else p.status='done'}
    else p.status='done';
  }else{p.turn=a.turn;p.pass=a.pass}   // a.pass = the seat that had no move and was skipped (0 = nobody)
  return p;
}
const sendGuard=(d,gid,moves)=>d.gid==gid&&d.moves==moves;
// the player ran out of time: play a legal move for them, or forfeit the series on the third missed turn in a row
function timeoutPatch(d,gid,moves){
  if(d.status!='play'||!sendGuard(d,gid,moves))return null;
  const seat=d.turn,n=(d['idle'+seat]||0)+1;
  if(n>=3)return {status:'series',sw:3-seat,why:'forfeit',['idle'+seat]:n};
  const mv=pickMove(d.b,seat,'medium');
  return mv<0?null:applyMove(d,seat,mv,true);
}
const startPatch=d=>{
  const starter=d.status=='lobby'?1:3-d.starter;
  return {status:'play',b:startBoard(),turn:starter,starter,moves:0,lm:-1,pass:0,game:1,gid:d.gid+1,s1:0,s2:0,idle1:0,idle2:0,rm1:false,rm2:false,sw:0,why:'',gone:0};
};
function nextGamePatch(d,gid){
  if(d.status!='done'||d.gid!=gid)return null;
  const starter=3-d.starter,decided=winnerOf(d.b)!=0;   // a draw replays the same game number
  return {status:'play',b:startBoard(),turn:starter,starter,moves:0,lm:-1,pass:0,game:decided?d.game+1:d.game,gid:d.gid+1,idle1:0,idle2:0};
}

/* ---- joining ---- */
function enterRoom(code){
  leave();ctx.room=code;ctx.seen=0;ctx.cl=0;
  show('lobby');$('#rcode').textContent=code;say('lmsg','Connecting...');$('#start').hidden=true;$('#plist').innerHTML='';
  $('#chatbtn').hidden=false;
  ctx.ru=mp.watchRoom(code,onRoom,e=>roomGone(fe(e)));
  ctx.cu=mp.watchChat(code,onChat);
}
function roomGone(msg){ctx.room=null;home();ask('Room closed',msg,'OK',()=>{},true)}
$('#create').onclick=async()=>{
  say('ferr');
  try{enterRoom(await mp.createRoom(myAv()))}catch(e){say('ferr',fe(e))}
};
async function joinCode(c){
  try{await mp.joinRoom(c,myAv());enterRoom(c)}catch(e){show('friends');say('ferr',fe(e))}
}
$('#join').onclick=()=>{
  const c=$('#code').value.trim();
  if(!/^\d{4}$/.test(c))return say('ferr','Enter the 4-digit room code');
  say('ferr');joinCode(c);
};
// an invite link (?room=1234) joins automatically once the player is signed in
(()=>{const q=new URLSearchParams(location.search).get('room');if(/^\d{4}$/.test(q||'')){pendingRoom=q;history.replaceState(null,'',location.pathname)}})();
function tryPending(){
  if(!pendingRoom)return;
  if(!mp.me()){if(cur()!='auth'){say('aerr','Sign in or play as guest to join room '+pendingRoom);show('auth')}return}
  const c=pendingRoom;pendingRoom=null;joinCode(c);
}
$('#wa').onclick=()=>window.open('https://wa.me/?text='+encodeURIComponent('Join my Reversi game! Room code '+ctx.room+'\n'+inviteUrl(ctx.room)),'_blank');
$('#copy').onclick=async()=>{
  try{await navigator.clipboard.writeText(inviteUrl(ctx.room));say('lmsg','Invite link copied')}
  catch{say('lmsg','Could not copy. Long-press the link below.')}
};
$('#start').onclick=()=>mp.txRoom(ctx.room,d=>d.status=='lobby'&&d.players.length==2?startPatch(d):null).catch(e=>say('lmsg',fe(e)));

function renderLobby(d){
  const ul=$('#plist');ul.innerHTML='';
  d.players.forEach((p,i)=>{
    const li=document.createElement('li');
    li.textContent=(p.av||'')+' '+p.name+(i==0?' (host)':'');ul.append(li);
  });
  const full=d.players.length>=2;
  say('lmsg',full?(ctx.seat==1?'Your friend is here. Tap Start game.':'Waiting for the host to start...'):'Waiting for a friend to join...');
  $('#start').hidden=!(ctx.seat==1&&full);
  $('#link').textContent=inviteUrl(ctx.room);
}

/* ---- room updates ---- */
function onRoom(d){
  if(!ctx.room)return;
  if(!d)return roomGone('That room no longer exists.');
  const u=mp.me(),idx=u?d.players.findIndex(p=>p.uid==u.uid):-1;
  if(idx<0)return roomGone('You are no longer in this room.');
  ctx.rd=d;ctx.seat=idx+1;
  if(d.status=='closed')return roomGone('The host closed the room.');
  if(d.status=='lobby'){if(cur()=='lobby')renderLobby(d);return}
  if(!g||!g.online||g.code!=ctx.room)startOnline(d);
  applySnap(d);
}
function startOnline(d){
  const pl=d.players;
  g={online:true,code:ctx.room,seat:ctx.seat,names:{1:pl[0].name,2:pl[1]?pl[1].name:'?'},avs:{1:pl[0].av||'🙂',2:pl[1]?(pl[1].av||'🙂'):'🙂'},
     b:zeros(),shown:zeros(),turn:d.turn,st:d.status,winner:0,busy:false,sending:false,gid:-1,idle:0,last:-1};
  show('game');$('#series').hidden=false;buildCards();buildBoard();
}
// a new room snapshot: animate the one new disc and its flips, or just redraw if anything else changed
function applySnap(d){
  if(!g||!g.online)return;
  if(g.busy){g.pend=d;return}
  g.d=d;
  if(d.gid!==g.gid){
    const first=g.gid==-1;
    g.gid=d.gid;g.fin=null;g.tkey=null;g.pkey=null;
    $('#result').hidden=true;markWin(0);note('');
    clearTimeout(ctx.rt);clearTimeout(ctx.nx);
    g.last=d.lm;syncDiscs(d.b);if(!first)sfx.start();
    return afterSync(d);
  }
  const add=[];let chg=false;
  for(let i=0;i<64;i++)if(d.b[i]!=g.shown[i]){if(!g.shown[i])add.push(i);else chg=true}
  if(add.length==1){
    const i=add[0],p=d.b[i],ls=linesAt(g.shown,i,p);
    if(applyDiscs(g.shown,i,p).every((v,k)=>v==d.b[k]))return animateIn(d,i,p,ls);
  }
  if(add.length||chg){g.last=d.lm;syncDiscs(d.b)}
  afterSync(d);
}
function animateIn(d,i,p,ls){
  g.busy=true;g.last=d.lm;syncCells();
  animateMove(i,p,ls,()=>{
    g.busy=false;
    const q=g.pend;g.pend=null;
    if(q)applySnap(q);else afterSync(d);
  });
}
function afterSync(d){
  if(!g)return;
  const fin=d.status=='done'||(d.status=='series'&&d.why=='win');
  g.d=d;g.b=d.b.slice();g.turn=d.turn;g.st=d.status;g.sending=false;g.last=d.lm;g.winner=fin?winnerOf(d.b):0;
  markCards();status();syncCells();seriesLine(d);
  const key=d.gid+'/'+d.status+'/'+d.moves;
  if(d.status=='play'){
    $('#result').hidden=true;
    if(d.pass&&g.pkey!=key){g.pkey=key;note(d.pass==g.seat?'You have no legal move, so your turn is skipped.':g.names[d.pass]+' has no legal move and passes.',4500)}
    if(g.tkey!=key){g.tkey=key;timerOnline(d)}
    return;
  }
  stopTimer();g.tkey=null;
  if(d.status=='series')rematchUi(d);
  if(g.fin==key)return;
  g.fin=key;
  const w=g.winner;
  if(fin)markWin(w);
  if(w){if(w==g.seat)sfx.win();else sfx.lose()}
  if(d.status=='done'){
    note(w?(w==g.seat?'You won game '+d.game+'.':g.names[w]+' won game '+d.game+'.')+' Next game starting...':'Draw. Replaying this game...');
    const code=g.code,gid=d.gid;
    ctx.nx=setTimeout(()=>mp.txRoom(code,x=>nextGamePatch(x,gid)).catch(()=>{}),g.seat==1?4000:6000);
  }else ctx.rt=setTimeout(()=>showOnlineResult(g&&g.d),w?1500:300);
}
function seriesLine(d){
  const me=g.seat,opp=3-me;
  $('#series').textContent='Game '+d.game+' of 3 · First to '+TARGET+' · You '+(d['s'+me]||0)+' – '+(d['s'+opp]||0)+' '+g.names[opp];
}
function note(m,ms){clearTimeout(ctx.nt);$('#note').textContent=m||'';if(m&&ms)ctx.nt=setTimeout(()=>{$('#note').textContent=''},ms)}

/* ---- playing ---- */
async function sendMove(sq){
  if(g.sending)return;
  g.sending=true;syncCells();
  const gid=g.gid,seat=g.seat,mv=g.d.moves;
  try{await mp.txRoom(g.code,d=>sendGuard(d,gid,mv)?applyMove(d,seat,sq,false):null)}
  catch(e){note(fe(e));if(g)g.sending=false;syncCells()}
}
const autoPlay=(code,gid,mv)=>mp.txRoom(code,d=>timeoutPatch(d,gid,mv)).catch(()=>{});
// the player whose turn it is acts at 15 seconds; the other phone steps in 6 seconds later in case that player went offline
function timerOnline(d){
  const gid=d.gid,mv=d.moves,mine=d.turn==g.seat,code=g.code;
  startTimer(d.turn,()=>{if(mine)autoPlay(code,gid,mv);else ctx.bk=setTimeout(()=>autoPlay(code,gid,mv),6000)});
}

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
function humanTimer(){if(g&&g.bot&&g.st=='play'&&g.turn==1)startTimer(1,botAutoPlay);else stopTimer()}
function botAutoPlay(){
  if(!g||g.st!='play'||g.turn!=1||g.busy)return;
  g.idle=(g.idle||0)+1;
  if(g.idle>=3){stopTimer();g.st='done';syncCells();ask('Game closed','You missed 3 turns in a row, so the game was closed.','OK',home,true);return}
  doMove(pickMove(g.b,1,'medium'));
}
// the computer thinks for a moment (never less than about 0.7s, so its move is easy to follow)
function botTurn(){
  if(!g||!g.bot||g.st!='play'||g.turn!=2||g.busy)return;
  const gg=g,t0=Date.now();
  ctx.bt=setTimeout(()=>{
    if(g!==gg||g.st!='play'||g.turn!=2||g.busy)return;
    const mv=pickMove(g.b,2,g.level);
    const wait=Math.max(0,700-(Date.now()-t0));
    ctx.bt=setTimeout(()=>{if(g===gg&&g.st=='play'&&g.turn==2&&!g.busy&&mv>=0)doMove(mv)},wait);
  },60);
}

/* ---- series result and rematch ---- */
function showOnlineResult(d){
  if(!g||!g.online||!d||d.status!='series')return;
  const me=g.seat,opp=3-me,iWon=d.sw==me,list=$('#rlist');list.innerHTML='';
  let title;
  if(d.why=='win')title=iWon?'You win the series!':g.names[opp]+' wins the series';
  else if(d.why=='forfeit')title=iWon?g.names[opp]+' timed out. You win!':'You timed out. Series lost';
  else title=iWon?g.names[opp]+' left. You win!':'You left the series';
  $('#rtitle').textContent=title;
  [d.sw,3-d.sw].forEach((s,i)=>{
    const row=document.createElement('div');row.className='rrow'+(i==0?' r0':'');
    const av=document.createElement('span');av.className='rav';av.textContent=g.avs[s];
    const nm=document.createElement('span');nm.className='nm';nm.textContent=g.names[s]+(s==me?' (you)':'');
    const n=d['s'+s]||0,tag=document.createElement('span');tag.textContent=n+(n==1?' game won':' games won');
    row.append(av,nm,tag);list.append(row);
  });
  confetti(iWon);
  $('#result').hidden=false;rematchUi(d);
}
function rematchUi(d){
  const b=$('#rreplay'),mine=!!d['rm'+g.seat];
  b.textContent=d.gone?'Opponent left':mine?'Waiting...':'Rematch';
  b.disabled=!!d.gone||mine;
  if(d.rm1&&d.rm2){
    clearTimeout(ctx.rr);const code=g.code;
    ctx.rr=setTimeout(()=>mp.txRoom(code,x=>x.status=='series'&&x.rm1&&x.rm2?startPatch(x):null).catch(()=>{}),g.seat==1?0:2500);
  }
}

/* ---- leaving ---- */
function exitRoom(){
  const code=ctx.room,seat=ctx.seat,d=ctx.rd,u=mp.me();
  if(!code||!seat||!u)return;
  let job;
  if(!d||d.status=='lobby'){
    job=seat==1?mp.txRoom(code,x=>x.status=='lobby'?{status:'closed'}:null)
               :mp.txRoom(code,x=>x.status=='lobby'?{players:x.players.filter(p=>p.uid!=u.uid)}:null);
  }else{
    job=mp.txRoom(code,x=>(x.status=='play'||x.status=='done')?{status:'series',sw:3-seat,why:'left',gone:seat}:{gone:seat});
  }
  Promise.resolve(job).catch(()=>{});
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

