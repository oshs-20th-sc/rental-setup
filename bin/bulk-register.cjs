'use strict';
// Self-contained replacement for the older web-project provisioning script.
const {randomBytes,createHash,pbkdf2}=require('node:crypto');
const {promisify}=require('node:util');
const BATCH=1000, READ=100, ROUNDS=120000;
const HASH_CONCURRENCY=4, READ_CONCURRENCY=5;
const deriveKey=promisify(pbkdf2);
const chunks=(a,n)=>Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n));
const email=s=>`${s.studentId}@students.ohsung-rental.invalid`;
const marker=s=>`ohsung-student-provisioning:${s.provisioningId}`;
const legacy=(project,s)=>`student-${createHash('sha256').update(`${project}\0${s.studentId}`).digest('hex')}`;
const core=s=>({studentId:s.studentId,name:s.name,...(s.grade===undefined?{}:{grade:s.grade})});
const equalCore=(d,s)=>d&&d.studentId===s.studentId&&d.name===s.name&&d.grade===s.grade;
const stageMatches=(d,s)=>equalCore(d,s)&&d.isActive===false&&d.provisioningId===s.provisioningId&&Object.keys(d).every(k=>['studentId','name','grade','isActive','provisioningId'].includes(k));
const completeMatches=(d,s)=>equalCore(d,s)&&Object.keys(d).every(k=>['studentId','name','grade','isActive'].includes(k))&&(d.isActive===undefined||typeof d.isActive==='boolean');
const identity=(u,s)=>u&&u.uid===s.studentId&&u.email?.toLowerCase()===email(s)&&u.customClaims?.student_id===s.studentId&&Object.keys(u.customClaims).length===1;
const owned=(u,s)=>identity(u,s)&&u.displayName===marker(s);
function makeJournal(project,roster,shared,activate=false){return {version:activate?3:shared===undefined?1:2,projectId:project,students:roster.map(s=>({...core(s),password:shared??`Aa1!${randomBytes(32).toString('base64url')}`,provisioningId:randomBytes(32).toString('base64url')}))};}
function validJournal(j,project,roster,shared,activate=false){return (activate?shared!==undefined&&j?.version===3:j?.version===(shared===undefined?1:2)||(shared!==undefined&&j?.version===1))&&j.projectId===project&&Array.isArray(j.students)&&j.students.length===roster.length&&j.students.every((s,i)=>equalCore(s,roster[i])&&Object.keys(s).every(k=>['studentId','name','grade','password','provisioningId'].includes(k))&&/^[A-Za-z0-9_-]{43}$/.test(s.provisioningId??'')&&(shared===undefined?/^Aa1![A-Za-z0-9_-]{43}$/.test(s.password??''):s.password===shared));}
async function importRecord(s,disabled){const salt=randomBytes(16);const passwordHash=await deriveKey(s.password,salt,ROUNDS,32,'sha256');return {uid:s.studentId,email:email(s),displayName:marker(s),disabled,customClaims:{student_id:s.studentId},passwordSalt:salt,passwordHash};}
async function prepareImports(students,disabled,isStopped){
 const prepared=new Map();let next=0;
 async function worker(){
  while(!isStopped()){
   const index=next++;
   if(index>=students.length)return;
   const student=students[index];prepared.set(student.studentId,await importRecord(student,disabled));
  }
 }
 await Promise.all(Array.from({length:Math.min(HASH_CONCURRENCY,students.length)},worker));
 return prepared;
}
async function authIndex(auth){
 const uid=new Map(),emails=new Map();let token;
 do{
  const page=await auth.listUsers(1000,token);
  for(const user of page.users){
   uid.set(user.uid,user);
   if(user.email){const key=user.email.toLowerCase(),matches=emails.get(key)??[];matches.push(user);emails.set(key,matches);}
  }
  token=page.pageToken;
 }while(token);
 return {uid,emails};
}
function classify(s,project,idx,p,r,l){const u=idx.uid.get(s.studentId), byEmail=idx.emails.get(email(s))??[];if(r.exists||l.exists||idx.uid.has(legacy(project,s))||byEmail.some(a=>a.uid!==s.studentId)||byEmail.length>1)return 'blocked';if(p.exists&&completeMatches(p.data(),s)&&identity(u,s))return 'complete';if(p.exists&&!stageMatches(p.data(),s))return 'blocked';if(u&&(!p.exists||!owned(u,s)))return 'blocked';return u?'resume':'new';}
async function plan(auth,db,project,students,index){
 const idx=index??await authIndex(auth),groups=chunks(students,READ),rows=[];
 for(let offset=0;offset<groups.length;offset+=READ_CONCURRENCY){
  const pages=await Promise.all(groups.slice(offset,offset+READ_CONCURRENCY).map(async group=>{
   const refs=group.map(s=>({
    s,p:db.doc(`users/${s.studentId}`),r:db.doc(`roles/${s.studentId}`),l:db.doc(`users/${legacy(project,s)}`),
   }));
   const docs=await db.getAll(...refs.flatMap(x=>[x.p,x.r,x.l]));
   return refs.map((x,i)=>{
    const [profile,roleSnapshot,legacyProfileSnapshot]=docs.slice(i*3,i*3+3);
    return {...x,profile,roleSnapshot,legacyProfileSnapshot,kind:classify(x.s,project,idx,profile,roleSnapshot,legacyProfileSnapshot)};
   });
  }));
  rows.push(...pages.flat());
 }
 return {rows,index:idx};
}
async function stageGroup(db,rows,isStopped=()=>false){
 const missing=rows.filter(x=>x.kind==='new'&&!x.profile.exists);
 if(!missing.length)return;
 const writer=db.bulkWriter(),pending=[];
 try{
  for(const group of chunks(missing,READ)){
   if(isStopped())break;
   for(const x of group){
    // Create-only writes cannot replace an existing profile. The fresh read
    // after this batch distinguishes our staged records from conflicting writes.
    pending.push(writer.create(x.p,{...core(x.s),isActive:false,provisioningId:x.s.provisioningId})
     .catch(()=>undefined));
   }
   await new Promise(resolve=>setImmediate(resolve));
  }
 }finally{await writer.close();}
 await Promise.all(pending);
}
async function finalizeGroup(db,rows,disabled){
 return db.runTransaction(async t=>{
  const docs=await t.getAll(...rows.flatMap(x=>[x.p,x.r,x.l]));
  let done=0;
  for(let i=0;i<rows.length;i++){
   const x=rows[i],[profile,role,legacyProfile]=docs.slice(i*3,i*3+3);
   if(role.exists||legacyProfile.exists||!profile.exists||!stageMatches(profile.data(),x.s))continue;
   t.set(x.p,{...core(x.s),isActive:!disabled});
   done++;
  }
  return done;
 });
}
// Mirrors the guarded batchCreate adapter in the main web repository. Fail closed
// on SDK changes, since the public importUsers method alone overwrites duplicate UIDs.
function guardedImport(auth,records,options,sdkVersion){
 const handler=auth.authRequestHandler;
 if(sdkVersion!=='14.5.1'||typeof handler?.invokeRequestHandler!=='function')throw Error('중복 방지를 확인할 수 없는 Firebase SDK 버전');
 const guardedHandler=Object.create(handler);
 guardedHandler.invokeRequestHandler=(url,settings,data,params)=>{
   if(settings.getEndpoint()!=='/accounts:batchCreate'||!Array.isArray(data?.users))throw Error('Auth import 중복 방지 적용 실패');
   return handler.invokeRequestHandler(url,settings,{...data,allowOverwrite:false,sanityCheck:true},params);
 };
 const guardedAuth=Object.create(auth);guardedAuth.authRequestHandler=guardedHandler;
 return guardedAuth.importUsers(records,options);
}
async function provision(auth,db,project,students,{shared=false,activate=false,log=console.log,importer}={}){
 if(activate&&!shared)throw Error('--activate requires a shared initial password');
 const disabled=shared&&!activate;
 if(typeof importer!=='function')throw Error('안전한 Auth import 함수를 명시해야 합니다.');
 let issued=0,skipped=0,failed=0,stopped=false;
 let lastAuthIndex;
 const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{for(const batch of chunks(students,BATCH)){
   if(stopped)break;
   const reusedAuthIndex=lastAuthIndex!==undefined;
   const initial=await plan(auth,db,project,batch,lastAuthIndex),rows=initial.rows;
   lastAuthIndex=initial.index;
   const candidates=rows.filter(x=>x.kind==='new'||x.kind==='resume');
   if(!candidates.length){
    const currentIndex=reusedAuthIndex?await authIndex(auth):initial.index;
    for(const x of rows){
     const kind=classify(x.s,project,currentIndex,x.profile,x.roleSnapshot,x.legacyProfileSnapshot);
     if(kind==='complete')skipped++;
     else failed++;
    }
    lastAuthIndex=currentIndex;
    log(`Issued ${issued} / skipped ${skipped} / failed ${failed}`);
    continue;
   }
   await stageGroup(db,candidates,()=>stopped);
   if(stopped)break;
   // Keep the fresh duplicate and ownership checks after password hashing.
   // Hashes are prepared first so role or alias changes during that work are
   // caught by the current pre-import scan and Firestore re-read.
   const prepared=await prepareImports(candidates.filter(x=>x.kind==='new').map(x=>x.s),disabled,()=>stopped);
   if(stopped)break;
   // Refresh all accounts before each import so existing duplicate email
   // aliases remain visible, even when they came from an older bulk import.
   const currentAuthIndex=await authIndex(auth);
   const checked=(await plan(auth,db,project,candidates.map(x=>x.s),currentAuthIndex)).rows,ready=[],fresh=[];
   const candidateIds=new Set(candidates.map(x=>x.s.studentId));
   for(const x of rows){
    if(candidateIds.has(x.s.studentId))continue;
    const kind=classify(x.s,project,currentAuthIndex,x.profile,x.roleSnapshot,x.legacyProfileSnapshot);
    if(kind==='complete')skipped++;
    else failed++;
   }
   for(const x of checked){
    if(x.kind==='complete'){skipped++;continue;}
    if(x.kind==='blocked'){failed++;continue;}
    if(stageMatches(x.profile.data(),x.s)){
     if(x.kind==='resume'){ready.push(x);continue;}
     if(x.kind==='new'&&prepared.has(x.s.studentId)){
      ready.push(x);
      fresh.push(prepared.get(x.s.studentId));
      continue;
     }
    }
    failed++;
   }
   log(`Auth import: ${fresh.length} accounts (max ${BATCH})`);
   if(stopped)break;
   if(fresh.length){const result=await importer(fresh,{hash:{algorithm:'PBKDF2_SHA256',rounds:ROUNDS}});log(`Auth import result: ${result.successCount} success / ${result.failureCount} failed`);}
   // Verify every result independently, including a previous interrupted import. Never overwrite existing accounts.
   const verified=ready.length?await authIndex(auth):currentAuthIndex,finalize=[];
   for(const x of ready){const u=verified.uid.get(x.s.studentId),aliases=verified.emails.get(email(x.s))??[];if(!owned(u,x.s)||aliases.length!==1||verified.uid.has(legacy(project,x.s))||u.disabled!==disabled){failed++;continue;}finalize.push(x);}
   for(const group of chunks(finalize,READ)){if(stopped)break;const n=await finalizeGroup(db,group,disabled);issued+=n;failed+=group.length-n;}
   lastAuthIndex=verified;
   log(`Issued ${issued} / skipped ${skipped} / failed ${failed}`);
 }
 return {issued,skipped,failed,unprocessed:students.length-issued-skipped-failed,stopped};
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
module.exports={BATCH,ROUNDS,HASH_CONCURRENCY,chunks,makeJournal,validJournal,importRecord,prepareImports,authIndex,classify,provision,legacy,guardedImport};
