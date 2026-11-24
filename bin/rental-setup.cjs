#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const bulk = require('./bulk-register.cjs');
const { parseArgs } = require('node:util');
const { createInterface } = require('node:readline/promises');
const { randomBytes } = require('node:crypto');
const platform = require('./platform.cjs');
const initialArgs = process.argv.slice(2);
const explicitProject = require.main===module && initialArgs[0]==='--project' ? initialArgs[1] : undefined;
if(require.main===module&&initialArgs[0]==='--project'&&!explicitProject)throw Error('--project PROJECT 값을 입력하세요.');
const PROJECT = explicitProject ?? process.env.OHSUNG_PROJECT ?? 'ohsung-rental';
if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(PROJECT)||PROJECT.startsWith('demo-')) throw Error('운영 Firebase 프로젝트 ID를 확인하세요.');
const ROOT = path.resolve(__dirname,'..');
const WINDOWS = process.platform === 'win32';
const suffix=PROJECT==='ohsung-rental'?'':`-${PROJECT}`;
const PRIVATE = WINDOWS ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'OhsungRental-private'+suffix) : path.join(os.homedir(), '.ohsung-rental-private'+suffix);
const DEFAULT_JOURNAL = process.env.OHSUNG_JOURNAL ? path.resolve(process.env.OHSUNG_JOURNAL) : path.join(PRIVATE, 'admin-student-credentials.json');
const validId = v => typeof v === 'string' && /^[0-9]{7}$/.test(v);
const validName = v => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(v);
const validGrade = v => Number.isInteger(v) && v >= 1 && v <= 3;
const randomPassword = () => `Aa1!${randomBytes(12).toString('base64url')}`;
const stamp = () => `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`;
const HELP = `빌리러 오성 통합 관리자 CLI (프로젝트: ${PROJECT})
rental-setup help
rental-setup list [--query 검색어] [--grade 1|2|3]
rental-setup show 학번
rental-setup register [--roster JSON] [--journal JSON] [--initial-password 값] [--apply]
rental-setup add 학번 --name 이름 [--grade 1|2|3] [--initial-password 값] [--apply]
rental-setup edit 학번 [--name 이름] [--grade 1|2|3] [--apply]
rental-setup reset 학번 [--initial-password 값] [--apply]
rental-setup reset-all [--initial-password 값] [--apply]
rental-setup enable 학번 [--apply] / enable-all [--apply]
rental-setup disable 학번 [--apply] / disable-all [--apply]
rental-setup delete 학번 [--apply] / delete-all [--apply]
rental-setup sync [--roster JSON] [--apply]
rental-setup purge 학번 [--apply] / purge-all [--apply]
rental-setup doctor / audit
rental-setup private-path
register/sync는 --roster JSON 또는 OHSUNG_ROSTER가 필요합니다.
일괄 등록은 최대 1,000명씩 Auth import. 기존 계정은 덮어쓰지 않습니다.
기본값은 조회/사전 검사입니다. --apply만 실제 변경하며 확인 문구가 필요합니다.
--concurrency 1~10 (기본 5): 개별 변경 작업의 동시 처리 수
삭제는 Auth 계정 제거 + Firestore 비활성 프로필 보존입니다. 대여 기록은 삭제하지 않습니다.`+platform.HELP;
const options = {apply:{type:'boolean'},check:{type:'boolean'},roster:{type:'string'},journal:{type:'string'},name:{type:'string'},grade:{type:'string'},query:{type:'string'},'initial-password':{type:'string'},concurrency:{type:'string'}};
const allowed = {
  help:[], 'private-path':[], audit:[], doctor:[], list:['query','grade'], show:[],
  register:['roster','journal','initial-password'],add:['name','grade','initial-password'],edit:['name','grade'],
  reset:['initial-password'], 'reset-all':['initial-password'],enable:[], 'enable-all':[],disable:[], 'disable-all':[],delete:[], 'delete-all':[],purge:[], 'purge-all':[],sync:['roster']
};
const single = new Set(['show','add','edit','reset','enable','disable','delete','purge']);
const mutations = new Set(Object.keys(allowed).filter(c=>!['help','private-path','audit','doctor','list','show'].includes(c)));
function parse(argv){
  const {positionals,values:o}=parseArgs({args:argv,allowPositionals:true,options});
  const [cmd='help',id,...extra]=positionals;
  if(!Object.hasOwn(allowed,cmd)||extra.length||(single.has(cmd)?!validId(id):id!==undefined)) throw Error('명령/학번 형식을 확인하세요. rental-setup help');
  if(o.apply&&o.check) throw Error('--apply와 --check는 함께 사용할 수 없습니다.');
  if((cmd==='register'||cmd==='sync')&&!o.roster&&!process.env.OHSUNG_ROSTER) throw Error('명단을 지정하세요: --roster JSON 또는 OHSUNG_ROSTER 환경변수');
  const keys = [...allowed[cmd],...(mutations.has(cmd)?['apply','check','concurrency']:[])];
  if(Object.keys(o).some(k=>!keys.includes(k))) throw Error('해당 명령에서 지원하지 않는 옵션입니다.');
  if(o.grade!==undefined && !/^[123]$/.test(o.grade)) throw Error('학년은 1~3입니다.');
  if(o.name!==undefined && !validName(o.name)) throw Error('이름은 제어문자 없는 1~80자로 입력하세요.');
  if(cmd==='add'&&!o.name || cmd==='edit'&&o.name===undefined&&o.grade===undefined) throw Error('--name 또는 --grade 옵션을 확인하세요.');
  if(o['initial-password']!==undefined&&(o['initial-password'].length<6||o['initial-password'].length>128)) throw Error('비밀번호는 6~128자로 입력하세요.');
  const concurrency=Number(o.concurrency??5);
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>10) throw Error('동시 처리 수는 1~10입니다.');
  return {cmd,id,o,concurrency};
}
function readRoster(file){
  const rows=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(!Array.isArray(rows)||!rows.length) throw Error('명단 JSON은 비어 있지 않은 배열이어야 합니다.');
  const seen=new Set();
  return rows.map(r=>{
    if(!r||Array.isArray(r)||!validId(r.studentId)||!validName(r.name)||Object.keys(r).some(k=>!['studentId','name','grade'].includes(k))||r.grade!==undefined&&!validGrade(r.grade)||seen.has(r.studentId)) throw Error('명단의 학번/이름/학년/중복을 확인하세요.');
    seen.add(r.studentId);return {studentId:r.studentId,name:r.name.trim(),...(r.grade===undefined?{}:{grade:r.grade})};
  });
}
function state(id,u,p,role){
  if(role?.exists)return 'protected';
  if(!p?.exists)return 'missingProfile';
  const d=p.data();
  if(!validId(id)||d.studentId!==id||!validName(d.name)||d.grade!==undefined&&!validGrade(d.grade)||d.isActive!==undefined&&typeof d.isActive!=='boolean'||Object.keys(d).some(k=>!['studentId','name','grade','isActive'].includes(k))) return 'mismatch';
  if(!u)return d.isActive===false?'archived':'missingAuth';
  if(u.uid!==id||u.email!==`${id}@students.ohsung-rental.invalid`||u.customClaims?.student_id!==id||Object.keys(u.customClaims??{}).some(k=>k!=='student_id'))return 'mismatch';
  return u.disabled||d.isActive===false?'disabled':'enabled';
}
const managed = s=>s==='enabled'||s==='disabled';
function windowsACL(file,initialize=false){
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'bin','private-acl.ps1'),'-Target',file,...(initialize?['-Initialize']:[])],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error('Windows private ACL check failed. Run install.ps1 and check folder permissions.');
}
function assertPrivateFile(file){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('Unsafe private file');
  if(WINDOWS)windowsACL(file);
  else if(s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error('Private file permissions invalid');
}
function createPrivate(file,data){
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(data,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function privateDirectory(){
  if(WINDOWS){if(!fs.existsSync(PRIVATE))windowsACL(PRIVATE,true);const s=fs.lstatSync(PRIVATE);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe private directory');windowsACL(PRIVATE);return;}
  fs.mkdirSync(PRIVATE,{recursive:true,mode:0o700});
  const s=fs.lstatSync(PRIVATE);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error('개인 폴더 접근 권한을 확인하세요: chmod 700 ~/.ohsung-rental-private');
}
function projectPath(){return ROOT;}
let auditChecked=false;
function audit(entry){
  const file=path.join(PRIVATE,'student-admin-audit.jsonl');
  if(!auditChecked&&fs.existsSync(file))assertPrivateFile(file);
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('Unsafe audit file');
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|(fs.constants.O_NOFOLLOW??0),0o600);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||(!WINDOWS&&(s.uid!==process.getuid()||(s.mode&0o077)!==0)))throw Error('감사 로그 권한 오류');fs.writeSync(fd,JSON.stringify({time:new Date().toISOString(),project:PROJECT,...entry})+'\n');fs.fsyncSync(fd);auditChecked=true;}finally{fs.closeSync(fd);}
}
async function confirm(text){
  if(!process.stdin.isTTY)throw Error('변경은 대화형 터미널에서만 허용됩니다.');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{return (await rl.question(`계속하려면 ${text} 입력: `))===text;}finally{rl.close();}
}
async function readTargets(auth,db,ids){
  if(ids===null){const snap=await db.collection('users').get();ids=snap.docs.map(d=>d.id).filter(validId).sort();}
  const rows=[];
  for(let i=0;i<ids.length;i+=100){
    const chunk=ids.slice(i,i+100);
    const [a,p,r]=await Promise.all([auth.getUsers(chunk.map(uid=>({uid}))),db.getAll(...chunk.map(id=>db.doc(`users/${id}`))),db.getAll(...chunk.map(id=>db.doc(`roles/${id}`)))]);
    const accounts=new Map(a.users.map(u=>[u.uid,u]));const profiles=new Map(p.map(d=>[d.id,d]));const roles=new Map(r.map(d=>[d.id,d]));
    for(const id of chunk){const u=accounts.get(id),profile=profiles.get(id),role=roles.get(id);rows.push({id,u,profile,state:state(id,u,profile,role)});}
  }return rows;
}
async function current(auth,db,id){const [r]=await readTargets(auth,db,[id]);if(!managed(r.state))throw Error('학생 계정 검증 실패');return r;}
async function profileUpdate(db,id,changes){
  const p=db.doc(`users/${id}`),r=db.doc(`roles/${id}`);
  await db.runTransaction(async t=>{const [ps,rs]=await Promise.all([t.get(p),t.get(r)]);if(rs.exists||!ps.exists||!managed(state(id,{uid:id,email:`${id}@students.ohsung-rental.invalid`,customClaims:{student_id:id}},ps,rs)))throw Error('프로필 변경 중 계정 상태 불일치');t.update(p,changes);});
}
async function hasOpenRental(db,id){
  // Single-field query avoids needing a composite index. Unknown states fail closed.
  const q=await db.collection('rentals').where('userId','==',id).get();
  return q.docs.some(d=>d.get('status')!=='returned');
}
async function mutate(auth,db,action,id,changes={}){
  if(action==='purge'){
    const [row]=await readTargets(auth,db,[id]);
    if(row.state!=='archived')throw Error('삭제 보관 상태가 아닙니다.');
    const p=db.doc(`users/${id}`),r=db.doc(`roles/${id}`),q=db.collection('rentals').where('userId','==',id).limit(1);
    await db.runTransaction(async t=>{
      const [ps,rs,loans]=await Promise.all([t.get(p),t.get(r),t.get(q)]);
      if(state(id,null,ps,rs)!=='archived'||!loans.empty)throw Error('계정 또는 대여 기록을 보존해야 합니다.');
      t.delete(p);
    });return;
  }
  const row=await current(auth,db,id);
  if(action==='edit'||action==='sync'){await profileUpdate(db,id,changes);return;}
  if(action==='reset'){await auth.updateUser(id,{password:changes.password});await auth.revokeRefreshTokens(id);return;}
  if(action==='enable'){
    if(row.state==='enabled')return;
    await auth.updateUser(id,{disabled:false});
    await profileUpdate(db,id,{isActive:true});return;
  }
  if(action==='disable'||action==='delete'){
    if(await hasOpenRental(db,id))throw Error('미반납 대여가 있어 중단했습니다.');
    // Deny Firestore access to already-issued tokens before Auth mutation.
    await profileUpdate(db,id,{isActive:false});
    await auth.updateUser(id,{disabled:true});
    await auth.revokeRefreshTokens(id);
    if(action==='delete'){
      if(await hasOpenRental(db,id))throw Error('처리 중 대여가 확인되어 비활성 상태로 유지했습니다.');
      await current(auth,db,id);
      await auth.deleteUser(id); // Retain inactive profile as tombstone; never delete rentals.
    }return;
  }
  throw Error('지원하지 않는 변경');
}
async function withFirebase(frontend,fn){
  if(process.env.FIREBASE_AUTH_EMULATOR_HOST!==undefined||process.env.FIRESTORE_EMULATOR_HOST!==undefined)throw Error('Emulator 환경변수를 해제하세요. 운영 프로젝트 전용 도구입니다.');
  const req=createRequire(path.join(frontend,'package.json'));
  const explicitADC=process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if(explicitADC || process.env.OHSUNG_USE_ADC==='1'){
    let app,db; const sdk=req('firebase-admin/app');
    try { const connect=()=>{app=sdk.initializeApp({projectId:PROJECT,credential:sdk.applicationDefault()});db=req('firebase-admin/firestore').getFirestore(app);return {auth:req('firebase-admin/auth').getAuth(app),db,app};};
      return await fn({env:{...process.env},connect});
    } finally {try{if(db)await db.terminate();}finally{if(app)await sdk.deleteApp(app);}}
  }
  const lib=path.join(frontend,'node_modules','firebase-tools','lib');
  const {version}=require(path.join(lib,'..','package.json'));
  if(version!=='15.37.0')throw Error('Firebase CLI 로그인 호환 버전을 확인하거나 표준 ADC를 사용하세요.');
  const {getGlobalDefaultAccount}=require(path.join(lib,'auth.js'));
  const {clientId,clientSecret}=require(path.join(lib,'api.js'));
  const token=getGlobalDefaultAccount()?.tokens?.refresh_token;
  if(!token)throw Error('Firebase CLI 로그인 정보가 없습니다. 기존 firebase login을 확인하세요.');
  const tmp=fs.mkdtempSync(path.join(PRIVATE,'.admin-adc-'));
  const credential=path.join(tmp,'credentials.json');let app,sdk,db;
  const prev=process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const removeCredential=()=>fs.rmSync(tmp,{recursive:true,force:true});
  const interrupt=()=>{
    // Bulk account commands may handle cancellation and finish their current batch.
    if(process.listenerCount('SIGINT')===1)process.exit(130);
  };
  const terminate=()=>{
    if(process.listenerCount('SIGTERM')===1)process.exit(143);
  };
  process.once('exit',removeCredential);
  process.on('SIGINT',interrupt);
  process.on('SIGTERM',terminate);
  try{
    createPrivate(credential,{type:'authorized_user',client_id:clientId(),client_secret:clientSecret(),refresh_token:token});
    process.env.GOOGLE_APPLICATION_CREDENTIALS=credential;
    const env={...process.env};
    const connect=()=>{sdk=req('firebase-admin/app');app=sdk.initializeApp({projectId:PROJECT,credential:sdk.applicationDefault()});db=req('firebase-admin/firestore').getFirestore(app);return {auth:req('firebase-admin/auth').getAuth(app),db,app};};
    return await fn({env,connect});
  }finally{
    try{if(db)await db.terminate();}
    finally{
      try{if(app)await sdk.deleteApp(app);}
      finally{
        if(prev===undefined)delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        else process.env.GOOGLE_APPLICATION_CREDENTIALS=prev;
        process.removeListener('SIGINT',interrupt);
        process.removeListener('SIGTERM',terminate);
        process.removeListener('exit',removeCredential);
        removeCredential();
      }
    }
  }
}
async function register(frontend,cmd,id,o,ctx){
  const singleRow=cmd==='add'?{studentId:id,name:o.name.trim(),...(o.grade?{grade:Number(o.grade)}:{})}:null;
  const roster=singleRow?null:path.resolve(o.roster??process.env.OHSUNG_ROSTER);
  const rows=singleRow?[singleRow]:readRoster(roster);
  const journal=cmd==='add'?path.join(PRIVATE,`add-${id}-credentials.json`):path.resolve(o.journal??(o.roster?path.join(PRIVATE,`${path.basename(roster,'.json')}-credentials.json`):DEFAULT_JOURNAL));
  if(path.relative(PRIVATE,path.dirname(journal))!=='')throw Error('발급 기록은 개인 폴더 안에 지정하세요. rental-setup private-path');
  console.log(`프로젝트 ${PROJECT} | 명단 ${rows.length}명 | 최대 1000명씩 import`);
  const shared=o['initial-password'];
  let j;
  if(fs.existsSync(journal)){assertPrivateFile(journal);j=JSON.parse(fs.readFileSync(journal,'utf8').replace(/^\uFEFF/,''));if(!bulk.validJournal(j,PROJECT,rows,shared))throw Error('기존 발급 기록과 목록/초기 비밀번호 옵션이 다릅니다. 기존 파일과 옵션을 유지하거나 별도 --journal을 지정하세요.');}
  if(!o.apply){console.log(`명단 형식 검사 완료. 예상 최대 ${Math.ceil(rows.length/1000)}회 import. 서버 중복 검사는 실제 발급 전 수행합니다.`);return 0;}
  console.log('다른 관리자 작업/등록을 중지하세요. 서버 중복 방지 및 로컬 잠금을 함께 사용합니다.');
  if(shared!==undefined)console.log('지정 공통 비밀번호 신규 계정은 비활성 상태로 발급됩니다. 개인별 비밀번호 발급 후 활성화하세요.');
  if(!await confirm(`REGISTER ${rows.length}`))return 0;
  if(!j){j=bulk.makeJournal(PROJECT,rows,shared);const temp=journal+'.tmp-'+stamp();try{createPrivate(temp,j);fs.linkSync(temp,journal);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  console.log(`발급 기록: ${journal}`);
  const {auth,db}=ctx.connect();
  audit({action:cmd,status:'started',count:rows.length});
  const result=await bulk.provision(auth,db,PROJECT,j.students,{shared:shared!==undefined,importer:(records,options)=>bulk.guardedImport(auth,records,options,require('firebase-admin/app').SDK_VERSION)});
  audit({action:cmd,status:'finished',...result});console.log(JSON.stringify(result));
  return result.stopped?130:result.failed||result.unprocessed?1:0;
}
async function operate(auth,db,cmd,id,o,concurrency){
  const all=!single.has(cmd);
  const rows=await readTargets(auth,db,all?null:[id]);
  const counts={};for(const row of rows)counts[row.state]=(counts[row.state]??0)+1;
  console.log(JSON.stringify({project:PROJECT,counts},null,2));
  if(cmd==='list'||cmd==='show'){
    const out=rows.filter(r=>(!o.query||`${r.id} ${r.profile?.data()?.name??''}`.includes(o.query))&&(!o.grade||r.profile?.data()?.grade===Number(o.grade)));
    console.table(out.map(r=>({studentId:r.id,name:r.profile?.data()?.name??'',grade:r.profile?.data()?.grade??'',state:r.state})));return 0;
  }
  if(cmd==='doctor'){
    const map=new Map(rows.map(r=>[r.id,r]));let pageToken,studentAuth=0,authOnly=0,unverifiedAuth=0;
    do{const page=await auth.listUsers(1000,pageToken);for(const u of page.users){
      if(!validId(u.uid)&&!u.email?.endsWith('@students.ohsung-rental.invalid')&&!u.customClaims?.student_id)continue;
      studentAuth++;const r=map.get(u.uid);if(!r||!r.profile?.exists)authOnly++;else if(!managed(r.state))unverifiedAuth++;
    }pageToken=page.pageToken;}while(pageToken);
    console.log(JSON.stringify({studentAuth,authOnly,unverifiedAuth,profileStates:counts},null,2));
    console.log('검증되지 않은 계정은 자동 변경하지 않습니다.');return 0;
  }
  const action=cmd.replace(/-all$/,'');let targets=rows.filter(r=>action==='purge'?r.state==='archived':managed(r.state));
  if(action==='purge'){
    const safe=[];for(let i=0;i<targets.length;i+=concurrency){const group=targets.slice(i,i+concurrency);const q=await Promise.all(group.map(r=>db.collection('rentals').where('userId','==',r.id).limit(1).get()));group.forEach((r,j)=>{if(q[j].empty)safe.push(r);});}
    console.log(`대여 이력 때문에 보존: ${targets.length-safe.length}`);targets=safe;
  }
  if(action==='enable')targets=targets.filter(r=>r.state==='disabled');
  if(action==='disable')targets=targets.filter(r=>r.state==='enabled'||r.u?.disabled!==true||r.profile?.data()?.isActive!==false);
  let syncChanges=new Map();
  if(action==='sync'){
    const roster=readRoster(path.resolve(o.roster??process.env.OHSUNG_ROSTER)),byId=new Map(rows.map(r=>[r.id,r]));
    for(const s of roster){const r=byId.get(s.studentId);if(!r||!managed(r.state))continue;const d=r.profile.data(),c={};if(d.name!==s.name)c.name=s.name;if(s.grade!==undefined&&d.grade!==s.grade)c.grade=s.grade;if(Object.keys(c).length)syncChanges.set(r.id,c);}
    const set=new Set(roster.map(s=>s.studentId));
    console.log(JSON.stringify({metadataUpdates:syncChanges.size,newOrUnverified:roster.filter(s=>!managed(byId.get(s.studentId)?.state)).length,absentFromRoster:targets.filter(r=>!set.has(r.id)).length}));
    targets=targets.filter(r=>syncChanges.has(r.id));
  }
  // Preflight excludes any open loan before disabling/deleting.
  if(cmd==='delete-all'&&rows.some(r=>['mismatch','missingAuth','missingProfile'].includes(r.state))){console.log('불일치/미완료 프로필이 있어 전체 삭제를 중단합니다. doctor로 확인하세요.');return 1;}
  if(action==='disable'||action==='delete'){
    let blocked=0,eligible=[];
    for(let i=0;i<targets.length;i+=concurrency){const group=targets.slice(i,i+concurrency);const open=await Promise.all(group.map(r=>hasOpenRental(db,r.id)));group.forEach((r,j)=>{if(open[j])blocked++;else eligible.push(r);});}
    console.log(`미반납으로 제외: ${blocked}`);targets=eligible;
    if(action==='delete'&&cmd==='delete-all'&&blocked){console.log('미반납 계정이 있어 전체 삭제를 중단합니다. 먼저 반납을 처리하세요.');return 1;}
  }
  console.log(`작업: ${cmd} | 대상: ${targets.length}`);
  if(!o.apply||!targets.length){console.log('변경하지 않았습니다.');return !all&&!targets.length?1:0;}
  if(action==='delete')console.log('Auth 계정을 영구 삭제합니다. 비활성 프로필 및 대여 기록은 보존합니다. 계정 복구는 자동 지원하지 않습니다.');
  if(action==='purge')console.log('Auth가 없고 대여 이력이 없는 보관 프로필만 영구 제거합니다.');
  if(action==='enable')console.log('기존 비밀번호 그대로 활성화합니다. 공통 비밀번호인 계정은 먼저 개인별 비밀번호를 설정하세요.');
  if(action==='reset'&&o['initial-password']!==undefined)console.log('지정 비밀번호로 변경합니다. 활성 상태는 유지됩니다. 공통 비밀번호는 공개 운영 환경에서 타인 계정 접근 위험을 유발합니다.');
  const phrase=`${cmd.toUpperCase()} ${targets.length}`;
  if(!await confirm(phrase)){console.log('취소했습니다.');return 0;}
  const runId=stamp();
  audit({runId,action:cmd,status:'started',count:targets.length});
  let passwords=new Map();
  if(action==='reset'){
    const out=path.join(PRIVATE,`reset-credentials-${runId}.json`);
    const entries=targets.map(r=>({studentId:r.id,password:o['initial-password']??randomPassword()}));
    createPrivate(out,{projectId:PROJECT,runId,students:entries,note:'변경 시도 대상. 감사 로그 성공 항목과 대조 후 전달.'});
    passwords=new Map(entries.map(s=>[s.studentId,s.password]));console.log(`새 비밀번호 기록: ${out}`);
  }
  let stopped=false;const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let ok=0,failed=0;
  try{
    for(let i=0;i<targets.length&&!stopped;i+=concurrency){
      await Promise.all(targets.slice(i,i+concurrency).map(async r=>{
        try{
          const changes=action==='reset'?{password:passwords.get(r.id)}:action==='sync'?syncChanges.get(r.id):{...(o.name!==undefined?{name:o.name.trim()}:{}),...(o.grade!==undefined?{grade:Number(o.grade)}:{})};
          await mutate(auth,db,action,r.id,changes);audit({runId,action:cmd,studentId:r.id,status:'success'});ok++;
        }catch(e){failed++;audit({runId,action:cmd,studentId:r.id,status:'failed',code:e.code??'CHECK_OR_WRITE_FAILED'});}
      }));console.log(`진행 ${ok+failed}/${targets.length} · 성공 ${ok} · 실패 ${failed}`);
    }
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  audit({runId,action:cmd,status:'finished',success:ok,failed,unprocessed:targets.length-ok-failed});
  console.log(JSON.stringify({runId,success:ok,failed,unprocessed:targets.length-ok-failed}));return stopped?130:failed?1:0;
}
async function main(argv){
  const platformArgs=platform.parsePlatform(argv);
  if(platformArgs){
    privateDirectory();let lock;const lockPath=path.join(PRIVATE,'.student-admin.lock');
    try{
      if(platformArgs.o.apply){lock=fs.openSync(lockPath,'wx',0o600);fs.writeFileSync(lock,`${process.pid}\n`);}
      return await withFirebase(ROOT,ctx=>platform.runPlatform(platformArgs,{...ctx.connect(),project:PROJECT,privateDir:PRIVATE,createPrivate,stamp,randomPassword,confirm,audit}));
    }finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(lockPath);}}
  }
  const {cmd,id,o,concurrency}=parse(argv);
  if(cmd==='help'){console.log(HELP);return 0;}
  if(cmd==='private-path'){console.log(PRIVATE);return 0;}
  privateDirectory();
  if(cmd==='audit'){const file=path.join(PRIVATE,'student-admin-audit.jsonl');if(fs.existsSync(file))assertPrivateFile(file);console.log(fs.existsSync(file)?`감사 로그: ${file}`:'감사 로그 없음');return 0;}
  let lock;const lockPath=path.join(PRIVATE,'.student-admin.lock');
  try{
    if(o.apply){lock=fs.openSync(lockPath,'wx',0o600);fs.writeFileSync(lock,`${process.pid}\n`);}
    const frontend=projectPath();
    if(cmd==='register'||cmd==='add'){
      if(!o.apply)return await register(frontend,cmd,id,o,{});
      return await withFirebase(frontend,ctx=>register(frontend,cmd,id,o,ctx));
    }
    return await withFirebase(frontend,ctx=>{const {auth,db}=ctx.connect();return operate(auth,db,cmd,id,o,concurrency);});
  }finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(lockPath);}}
}
module.exports={parse,state,managed,readRoster,mutate,hasOpenRental};
if(require.main===module)main(initialArgs[0]==='--project'?initialArgs.slice(2):initialArgs).then(code=>{process.exitCode=code;}).catch(e=>{console.error('실행 실패:',e.code??e.message);process.exitCode=1;});
