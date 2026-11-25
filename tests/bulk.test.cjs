'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {chunks,makeJournal,validJournal,importRecord,authIndex,classify,provision,legacy,guardedImport}=require('../bin/bulk-register.cjs');
const {pbkdf2Sync}=require('node:crypto');
const project='demo-ohsung-rental',id='2600000',rows=[{studentId:id,name:'Test',grade:1}],s=makeJournal(project,rows).students[0];
const snap=d=>({exists:d!==undefined,data:()=>d});
const acct={uid:id,email:`${id}@students.ohsung-rental.invalid`,customClaims:{student_id:id},displayName:`ohsung-student-provisioning:${s.provisioningId}`,disabled:false};
const idx=u=>({uid:new Map(u.map(x=>[x.uid,x])),emails:new Map(u.map(x=>[x.email,[x]]))});
test('batch splits 1278 into 1000 and 278',()=>a.deepEqual(chunks(Array(1278).fill(0),1000).map(x=>x.length),[1000,278]));
test('journal preserves password and marker, rejects mismatch',()=>{const j=makeJournal(project,rows);a.ok(validJournal(j,project,rows));a.ok(!validJournal(j,project,[{...rows[0],grade:2}]));const shared=makeJournal(project,rows,'Example-Pass');a.ok(validJournal(shared,project,rows,'Example-Pass'));a.ok(!validJournal(shared,project,rows));});
test('asynchronous import hash preserves PBKDF2 strength and claims',async()=>{const r=await importRecord(s,true);a.equal(r.disabled,true);a.equal(r.uid,id);a.deepEqual(r.customClaims,{student_id:id});a.deepEqual(r.passwordHash,pbkdf2Sync(s.password,r.passwordSalt,120000,32,'sha256'));});
test('Auth preflight retains case-insensitive duplicate email detection',async()=>{
 const account={uid:id,email:`${id}@Students.ohsung-rental.invalid`,customClaims:{student_id:id}};
 const duplicate={uid:'legacy-import',email:`${id}@students.ohsung-rental.invalid`};
 const index=await authIndex({listUsers:async()=>({users:[account,duplicate]})});
 a.equal(index.uid.get(id),account);
 a.equal(index.emails.get(`${id}@students.ohsung-rental.invalid`).length,2);
 a.equal(classify(s,project,index,snap(),snap(),snap()),'blocked');
});
test('operational imports send distinct salts, no raw password, and reject duplicate credentials',async()=>{
 const password='Example-Shared-QA!123';
 const roster=[rows[0],{studentId:'2600002',name:'Example second'}];
 const journal=makeJournal(project,roster,password);
 const x=mock();
 let request;
 const handler={async invokeRequestHandler(_url,_settings,data){
  request=data;
  return x.auth.importUsers(data.users);
 }};
 const auth={
  listUsers:x.auth.listUsers,
  authRequestHandler:handler,
  importUsers(records,options){
   a.deepEqual(options.hash,{algorithm:'PBKDF2_SHA256',rounds:120000});
   return this.authRequestHandler.invokeRequestHandler('',{getEndpoint:()=>'/accounts:batchCreate'},{
    users:records,allowOverwrite:true,sanityCheck:false,
   },{});
  },
 };
 const result=await provision(auth,x.db,project,journal.students,{
  shared:true,log:()=>{},
  importer:(records,options)=>guardedImport(auth,records,options,'14.5.1'),
 });
 a.equal(result.issued,2);
 a.equal(request.allowOverwrite,false);
 a.equal(request.sanityCheck,true);
 a.notDeepEqual(request.users[0].passwordSalt,request.users[1].passwordSalt);
 a.notDeepEqual(request.users[0].passwordHash,request.users[1].passwordHash);
 for(const [index,record] of request.users.entries()){
  a.equal(Object.hasOwn(record,'password'),false);
  a.equal(record.disabled,true);
  a.deepEqual(record.customClaims,{student_id:roster[index].studentId});
  a.deepEqual(record.passwordHash,pbkdf2Sync(password,record.passwordSalt,120000,32,'sha256'));
 }
});
test('existing accounts cannot be imported over',()=>{a.equal(classify(s,project,idx([acct]),snap(rows[0]),snap(),snap()),'complete');a.equal(classify(s,project,idx([acct]),snap(),snap(),snap()),'blocked');a.equal(classify(s,project,idx([]),snap(),snap({admin:true}),snap()),'blocked');a.equal(classify(s,project,idx([{...acct,uid:'other'}]),snap(),snap(),snap()),'blocked');a.equal(classify(s,project,idx([{...acct,uid:legacy(project,s),email:'old@example.invalid'}]),snap(),snap(),snap()),'blocked');});
test('only matching staged profile and marker resume',()=>{const p=snap({...rows[0],isActive:false,provisioningId:s.provisioningId});a.equal(classify(s,project,idx([acct]),p,snap(),snap()),'resume');a.equal(classify(s,project,idx([{...acct,displayName:'foreign'}]),p,snap(),snap()),'blocked');});
function mock({beforeCreate,afterBulk}={}){
 const users=new Map(),docs=new Map(),imports=[],staged=[];let listUserCalls=0;
 const getAll=async(...refs)=>refs.map(ref=>snap(docs.get(ref.path)));
 const db={
  doc:path=>({path}),
  getAll,
  bulkWriter:()=>({
   async create(ref,data){
    beforeCreate?.(docs);
    if(docs.has(ref.path))throw Error('exists');
    docs.set(ref.path,data);
    staged.push(ref.path);
   },
   async close(){afterBulk?.(docs);},
  }),
  runTransaction:async callback=>callback({getAll,set:(ref,data)=>docs.set(ref.path,data)}),
 };
 const auth={
  getUsers:async identifiers=>{const matches=new Map();for(const identifier of identifiers){if(identifier.uid&&users.has(identifier.uid))matches.set(identifier.uid,users.get(identifier.uid));if(identifier.email){for(const user of users.values())if(user.email?.toLowerCase()===identifier.email.toLowerCase())matches.set(user.uid,user);}}return {users:[...matches.values()]};},
  listUsers:async(maximum=1000,pageToken)=>{listUserCalls++;const start=Number(pageToken??0),all=[...users.values()];return {users:all.slice(start,start+maximum),pageToken:start+maximum<all.length?String(start+maximum):undefined};},
  importUsers:async records=>{
   imports.push(records.length);
   for(const record of records){
    if(users.has(record.uid))throw Error('overwrite');
    users.set(record.uid,record);
   }
   return {successCount:records.length,failureCount:0};
  },
 };
 return {auth,db,users,docs,imports,staged,get listUserCalls(){return listUserCalls;},options:{log:()=>{},importer:auth.importUsers}};
}
test('bulk register then skip already complete without overwrite',async()=>{
 const x=mock(),j=makeJournal(project,rows);
 const first=await provision(x.auth,x.db,project,j.students,x.options);
 a.equal(first.issued,1);
 a.equal(x.docs.get(`users/${id}`).isActive,true);
 const second=await provision(x.auth,x.db,project,j.students,x.options);
 a.equal(second.skipped,1);
 a.deepEqual(x.staged,[`users/${id}`]);
 a.deepEqual(x.imports,[1]);
});
test('complete batches reuse the preceding global Auth index without extra scans',async()=>{
 const roster=Array.from({length:1001},(_,index)=>({studentId:String(2600000+index),name:'Test'}));
 const journal=makeJournal(project,roster),x=mock();
 for(const student of journal.students){
  x.users.set(student.studentId,{uid:student.studentId,email:`${student.studentId}@students.ohsung-rental.invalid`,displayName:`ohsung-student-provisioning:${student.provisioningId}`,customClaims:{student_id:student.studentId},disabled:false});
  x.docs.set(`users/${student.studentId}`,{studentId:student.studentId,name:student.name,isActive:true});
 }
 const result=await provision(x.auth,x.db,project,journal.students,x.options);
 a.equal(result.skipped,1001);
 a.equal(x.listUserCalls,4);
});
test('shared import leaves both Auth and profile disabled',async()=>{
 const x=mock(),j=makeJournal(project,rows,'Example-Pass');
 await provision(x.auth,x.db,project,j.students,{...x.options,shared:true});
 a.equal(x.users.get(id).disabled,true);
 a.equal(x.docs.get(`users/${id}`).isActive,false);
});
test('explicit shared activation is bound to its journal and issues active accounts',async()=>{
 const x=mock(),password='Example-Shared-QA!123';
 const j=makeJournal(project,rows,password,true);
 a.equal(j.version,3);
 a.ok(validJournal(j,project,rows,password,true));
 a.ok(!validJournal(j,project,rows,password));
 a.ok(!validJournal(makeJournal(project,rows,password),project,rows,password,true));
 const opts={...x.options,shared:true,activate:true};
 const first=await provision(x.auth,x.db,project,j.students,opts);
 a.equal(first.issued,1);
 a.equal(x.users.get(id).disabled,false);
 a.equal(x.docs.get(`users/${id}`).isActive,true);
 const retry=await provision(x.auth,x.db,project,j.students,opts);
 a.equal(retry.skipped,1);
 a.deepEqual(x.imports,[1]);
});
test('shared active registration resumes an already imported staged account',async()=>{
 const x=mock(),j=makeJournal(project,rows,'Example-Shared-QA!123',true),student=j.students[0];
 x.docs.set(`users/${id}`,{...rows[0],isActive:false,provisioningId:student.provisioningId});
 x.users.set(id,await importRecord(student,false));
 const result=await provision(x.auth,x.db,project,j.students,{...x.options,shared:true,activate:true});
 a.equal(result.issued,1);
 a.equal(x.docs.get(`users/${id}`).isActive,true);
 a.deepEqual(x.imports,[]);
});
test('recover staged imported account without reimport',async()=>{
 const x=mock();
 x.docs.set(`users/${id}`,{...rows[0],isActive:false,provisioningId:s.provisioningId});
 x.users.set(id,acct);
 const result=await provision(x.auth,x.db,project,[s],x.options);
 a.equal(result.issued,1);
 a.deepEqual(x.imports,[]);
});
test('BulkWriter preserves a conflicting profile created after preflight',async()=>{
 const other={...rows[0],name:'Existing profile'};
 const x=mock({beforeCreate:docs=>docs.set(`users/${id}`,other)});
 const result=await provision(x.auth,x.db,project,[s],x.options);
 a.equal(result.failed,1);
 a.deepEqual(x.docs.get(`users/${id}`),other);
 a.deepEqual(x.imports,[]);
});
test('a new role after profile staging blocks Auth import and keeps the profile inactive',async()=>{
 const x=mock({afterBulk:docs=>docs.set(`roles/${id}`,{admin:true})});
 const result=await provision(x.auth,x.db,project,[s],x.options);
 a.equal(result.failed,1);
 a.equal(x.docs.get(`users/${id}`).isActive,false);
 a.deepEqual(x.imports,[]);
});
test('provision requires a guarded Auth importer',async()=>{
 await a.rejects(provision(null,null,project,[s]),/안전한 Auth import/);
});
