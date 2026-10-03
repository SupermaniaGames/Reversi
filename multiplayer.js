import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {getAuth,onAuthStateChanged,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,updateProfile,signInAnonymously,deleteUser} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {getFirestore,doc,getDoc,setDoc,onSnapshot,updateDoc,runTransaction,collection,addDoc,query,orderBy,limit,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import * as fc from './firebase-config.js';

const cfg=fc.firebaseConfig||fc.default;
if(!cfg||!cfg.apiKey||!cfg.appId||!cfg.messagingSenderId)throw new Error('Firebase config is missing apiKey, messagingSenderId or appId in firebase-config.js');

const app=initializeApp(cfg),auth=getAuth(app),db=getFirestore(app);
const mail=u=>u.toLowerCase()+'@supermania.games';
const R=c=>doc(db,'reversiRooms',c);

export const me=()=>auth.currentUser&&{uid:auth.currentUser.uid,name:auth.currentUser.displayName||''};
export const onUser=cb=>onAuthStateChanged(auth,cb);
export const signIn=(u,p)=>signInWithEmailAndPassword(auth,mail(u),p);
// Username accounts: the username is the login (stored lower-case as usernames/{name}), the password is the password.
// The same account works in every Supermania game that uses this Firebase project.
export const nameTaken=async u=>(await getDoc(doc(db,'usernames',u.toLowerCase()))).exists();
export const signUp=async(u,p)=>{
  if(await nameTaken(u))throw {code:'auth/email-already-in-use'};
  const c=await createUserWithEmailAndPassword(auth,mail(u),p);
  try{await setDoc(doc(db,'usernames',u.toLowerCase()),{uid:c.user.uid,name:u})}
  catch(e){await deleteUser(c.user).catch(()=>{});throw {code:'auth/email-already-in-use'}}
  await updateProfile(c.user,{displayName:u});
  await setDoc(doc(db,'players',c.user.uid),{name:u,created:Date.now()},{merge:true}).catch(()=>{});
};
// the chosen character follows the account (field rvav, so other games' fields are left alone)
export const saveProfile=av=>{const u=auth.currentUser;return u?setDoc(doc(db,'players',u.uid),{name:u.displayName||'',rvav:av},{merge:true}):Promise.resolve()};
export const loadProfile=async()=>{const u=auth.currentUser;if(!u)return null;const s=await getDoc(doc(db,'players',u.uid));return s.exists()?s.data():null};
export const guest=async(name)=>{const c=await signInAnonymously(auth);await updateProfile(c.user,{displayName:name})};
export const logout=()=>signOut(auth);

// Room document (flat, no nested arrays). Seat 1 = host, seat 2 = guest.
// status: 'lobby' | 'play' | 'done' (game over, next game coming) | 'series' (best-of-3 over) | 'closed'
// b: 64 numbers (0 empty, 1 or 2 = seat; index = row*8+col, row 0 = top), turn (seat), moves, lm (last move square, -1 none)
// game (1-3), gid (changes every started game), starter, s1/s2 game wins, idle1/idle2 missed turns in a row,
// rm1/rm2 rematch votes, sw (series winner seat), why ('win'|'forfeit'|'left'), gone (seat that left), pass (seat that had to pass, else 0)
export async function createRoom(av){
  const u=me();
  for(let n=0;n<10;n++){
    const code=String(1000+Math.floor(Math.random()*9000));
    try{
      await runTransaction(db,async tx=>{
        const s=await tx.get(R(code));
        if(s.exists()&&Date.now()-s.data().created<6*36e5)throw 'taken';
        tx.set(R(code),{host:u.uid,status:'lobby',created:Date.now(),players:[{uid:u.uid,name:u.name,av:av||'🙂'}],
          b:Array(64).fill(0),turn:1,moves:0,lm:-1,game:1,gid:0,starter:1,s1:0,s2:0,idle1:0,idle2:0,rm1:false,rm2:false,sw:0,why:'',gone:0,pass:0});
      });
      return code;
    }catch(e){if(e!=='taken')throw e}
  }
  throw new Error('Could not find a free code. Try again.');
}

export const joinRoom=(code,av)=>runTransaction(db,async tx=>{
  const u=me(),s=await tx.get(R(code));
  if(!s.exists())throw new Error('No room with that code');
  const d=s.data();
  if(d.players.some(p=>p.uid==u.uid))return;
  if(d.status!='lobby')throw new Error('That game already started');
  if(d.players.length>=2)throw new Error('Room is full');
  tx.update(R(code),{players:[...d.players,{uid:u.uid,name:u.name,av:av||'🙂'}]});
});

// fn(roomData) returns a patch object to write, or null to do nothing. It may run more than once, so keep it pure.
export const txRoom=(code,fn)=>runTransaction(db,async tx=>{
  const s=await tx.get(R(code));
  if(!s.exists())return false;
  const patch=fn(s.data());
  if(!patch)return false;
  tx.update(R(code),patch);return true;
});

export const watchRoom=(code,cb,err)=>onSnapshot(R(code),s=>cb(s.exists()?s.data():null,s.metadata.hasPendingWrites),err);
export const setRoom=(code,patch)=>updateDoc(R(code),patch);

const CH=code=>collection(db,'reversiRooms',code,'chat');
export const sendChat=(code,text)=>addDoc(CH(code),{uid:me().uid,name:me().name,text,ts:serverTimestamp()});
export const watchChat=(code,cb)=>onSnapshot(query(CH(code),orderBy('ts'),limit(60)),s=>cb(s.docs.map(d=>d.data())),()=>{});
