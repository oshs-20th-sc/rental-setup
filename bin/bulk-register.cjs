'use strict';
// Self-contained replacement for the older web-project provisioning script.
const {randomBytes,createHash,pbkdf2Sync}=require('node:crypto');
const BATCH=1000, READ=100, ROUNDS=120000;
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
function importRecord(s,disabled){const salt=randomBytes(16);return {uid:s.studentId,email:email(s),displayName:marker(s),disabled,customClaims:{student_id:s.studentId},passwordSalt:salt,passwordHash:pbkdf2Sync(s.password,salt,ROUNDS,32,'sha256')};}
async function authIndex(auth){const uid=new Map(),emails=new Map();let token;do{const p=await auth.listUsers(1000,token);for(const u of p.users){uid.set(u.uid,u);if(u.email){const key=u.email.toLowerCase();const a=emails.get(key)??[];a.push(u);emails.set(key,a);}}token=p.pageToken;}while(token);return {uid,emails};}
function classify(s,project,idx,p,r,l){const u=idx.uid.get(s.studentId), byEmail=idx.emails.get(email(s))??[];if(r.exists||l.exists||idx.uid.has(legacy(project,s))||byEmail.some(a=>a.uid!==s.studentId)||byEmail.length>1)return 'blocked';if(p.exists&&completeMatches(p.data(),s)&&identity(u,s))return 'complete';if(p.exists&&!stageMatches(p.data(),s))return 'blocked';if(u&&(!p.exists||!owned(u,s)))return 'blocked';return u?'resume':'new';}
async function plan(auth,db,project,students){
 const idx=await authIndex(auth),rows=[];
 for(const group of chunks(students,READ)){
  const refs=group.map(s=>({
   s,p:db.doc(`users/${s.studentId}`),r:db.doc(`roles/${s.studentId}`),l:db.doc(`users/${legacy(project,s)}`),
  }));
  const docs=await db.getAll(...refs.flatMap(x=>[x.p,x.r,x.l]));
  for(let i=0;i<refs.length;i++){
   const x=refs[i],[profile,role,legacyProfile]=docs.slice(i*3,i*3+3);
   rows.push({...x,profile,kind:classify(x.s,project,idx,profile,role,legacyProfile)});
  }
 }
 return rows;
}
async function stageGroup(db,rows){
 const missing=rows.filter(x=>x.kind==='new'&&!x.profile.exists);
 if(!missing.length)return;
 const writer=db.bulkWriter(),pending=[];
 try{
  for(const x of missing){
   // Create-only writes cannot replace an existing profile. The fresh read
   // after this batch distinguishes our staged records from conflicting writes.
   pending.push(writer.create(x.p,{...core(x.s),isActive:false,provisioningId:x.s.provisioningId})
    .catch(()=>undefined));
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
 const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{for(const batch of chunks(students,BATCH)){
   if(stopped)break;
   const rows=await plan(auth,db,project,batch);skipped+=rows.filter(x=>x.kind==='complete').length;failed+=rows.filter(x=>x.kind==='blocked').length;
   const candidates=rows.filter(x=>x.kind==='new'||x.kind==='resume');
   for(const group of chunks(candidates,READ)){if(stopped)break;await stageGroup(db,group);}
   if(stopped)break;
   // Hash before re-reading Auth and Firestore so a long batch cannot rely on
   // stale role or identity checks. Finalization verifies the profile again.
   const prepared=new Map(candidates.filter(x=>x.kind==='new').map(x=>[x.s.studentId,importRecord(x.s,disabled)]));
   const checked=await plan(auth,db,project,candidates.map(x=>x.s)),ready=[],fresh=[];
   for(const x of checked){
    if(x.kind==='complete'){skipped++;continue;}
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
   const verified=await authIndex(auth),finalize=[];
   for(const x of ready){const u=verified.uid.get(x.s.studentId),aliases=verified.emails.get(email(x.s))??[];if(!owned(u,x.s)||aliases.length!==1||verified.uid.has(legacy(project,x.s))||u.disabled!==disabled){failed++;continue;}finalize.push(x);}
   for(const group of chunks(finalize,READ)){if(stopped)break;const n=await finalizeGroup(db,group,disabled);issued+=n;failed+=group.length-n;}
   log(`Issued ${issued} / skipped ${skipped} / failed ${failed}`);
 }
 return {issued,skipped,failed,unprocessed:students.length-issued-skipped-failed,stopped};
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
module.exports={BATCH,ROUNDS,chunks,makeJournal,validJournal,importRecord,classify,provision,legacy,guardedImport};
