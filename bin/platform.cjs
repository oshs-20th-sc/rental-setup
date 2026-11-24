'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {parseArgs}=require('node:util');
const ROOT=path.resolve(__dirname,'..');
const CONFIG=path.join(ROOT,'config');
const COMMANDS={
  'setup-status':[], 'setup':['domain'], 'db-create':['location'],
  'auth-config':['domain'], 'web-apps':[], 'web-app-create':['name'], 'web-config':['app-id'],
  'rules-status':[], 'rules-deploy':[], 'rules-rollback':['ruleset'],
  'indexes-status':[], 'indexes-deploy':[], 'inventory-init':[],
  'products-list':[], 'products-add':['category','name','number'], 'products-import':['file'],
  'products-edit':['id','category','name','number'], 'products-enable':['id'], 'products-disable':['id'],
  'admins-list':[], 'admin-add':['email','name'], 'admin-grant':['email','name'], 'admin-revoke':['email'], 'rentals-summary':[]
};
const READ=new Set(['setup-status','web-apps','web-config','rules-status','indexes-status','products-list','admins-list','rentals-summary']);
const HELP=`\nFirebase 및 운영 관리 (rental-setup)\n  setup-status                         초기 설정 상태\n  setup [--domain HOST] [--apply]      Rules, 인덱스, Auth 설정, 재고 초기화\n  db-create --location LOCATION [--apply]  기본 Standard Native DB 생성\n  auth-config [--domain HOST] [--apply]    이메일/비밀번호 및 도메인 추가\n  web-apps / web-app-create --name NAME [--apply]\n  web-config [--app-id APP_ID]          VITE_* 공개 설정 표시\n  rules-status / rules-deploy [--apply]\n  rules-rollback --ruleset ID [--apply]\n  indexes-status / indexes-deploy [--apply]\n  inventory-init [--apply]              물품 번호 예약 검사/초기화\n  products-list\n  products-add --category CAT --name NAME --number N [--apply]\n  products-import --file JSON [--apply]\n  products-edit --id ID [--category CAT] [--name NAME] [--number N] [--apply]\n  products-enable --id ID / products-disable --id ID [--apply]\n  admins-list\n  admin-add --email EMAIL --name NAME [--apply]\n  admin-grant --email EMAIL --name NAME [--apply] (기존 검증된 계정)\n  admin-revoke --email EMAIL [--apply]\n  rentals-summary\n환경변수 OHSUNG_PROJECT 또는 명령 맨 앞 --project PROJECT 로 프로젝트 지정.\n`;
function parsePlatform(argv){
 const [cmd,...rest]=argv;if(!Object.hasOwn(COMMANDS,cmd))return null;
 const opts=Object.fromEntries(COMMANDS[cmd].map(k=>[k,{type:'string'}]));
 if(!READ.has(cmd))Object.assign(opts,{apply:{type:'boolean'},check:{type:'boolean'}});
 const {values:o}=parseArgs({args:rest,options:opts,allowPositionals:false});
 if(o.apply&&o.check)throw Error('--apply와 --check 중 하나만 사용하세요.');
 const required={ 'db-create':['location'],'web-app-create':['name'],'rules-rollback':['ruleset'],'products-add':['category','name','number'],'products-import':['file'],'products-edit':['id'],'products-enable':['id'],'products-disable':['id'],'admin-add':['email','name'],'admin-grant':['email','name'],'admin-revoke':['email']}[cmd]||[];
 if(required.some(k=>!o[k]))throw Error('필수 옵션 누락: '+required.join(', '));
 if(cmd==='products-edit'&&!['category','name','number'].some(k=>o[k]!==undefined))throw Error('수정할 항목을 지정하세요.');
 if(o.domain!==undefined&&!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(o.domain))throw Error('도메인은 https:// 및 경로 없이 입력하세요.');
 if(o.location&&!/^[a-z][a-z0-9-]{1,39}$/.test(o.location))throw Error('location 형식 오류');
 if(o.id&&!/^[A-Za-z0-9_-]{1,128}$/.test(o.id))throw Error('물품 ID 형식 오류');
 if(o.ruleset&&!/^[A-Za-z0-9_-]{1,128}$/.test(o.ruleset))throw Error('ruleset 이름은 짧은 ID로 입력하세요.');
 if(o.email&&(!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(o.email)||o.email.toLowerCase().endsWith('@students.ohsung-rental.invalid')))throw Error('관리자 실제 이메일을 입력하세요.');
 if(o.name!==undefined)validText(o.name,'이름');
 if(o.number!==undefined&&(!/^\d{1,4}$/.test(o.number)||Number(o.number)<1))throw Error('번호는 1~9999 정수입니다.');
 return {cmd,o};
}
function validText(v,label,cat=false){if(typeof v!=='string'||!v.trim()||v.trim().length>80||/\p{Cc}/u.test(v)||(cat&&/[|/]/.test(v)))throw Error(label+' 형식 오류');return v.trim();}
function productInput(row){
 if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['category','name','displayNo','isEnabled'].includes(k)))throw Error('물품 JSON 필드 오류');
 const {displayNo}=row;if(!Number.isInteger(displayNo)||displayNo<1||displayNo>9999)throw Error('물품 번호는 1~9999 정수입니다.');
 if(row.isEnabled!==undefined&&typeof row.isEnabled!=='boolean')throw Error('isEnabled는 boolean입니다.');
 return {category:validText(row.category,'카테고리',true),name:validText(row.name,'물품명'),displayNo,isEnabled:row.isEnabled??true};
}
const key=p=>`${p.category}|${p.displayNo}`;
function productRows(file){const rows=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));if(!Array.isArray(rows)||!rows.length)throw Error('비어 있지 않은 JSON 배열 필요');const out=rows.map(productInput);if(new Set(out.map(key)).size!==out.length)throw Error('파일 내 카테고리/번호 중복');return out;}
const sha=s=>createHash('sha256').update(s).digest('hex');
function indexKey(row){
 const fields=(row.fields||[]).map(f=>[f.fieldPath,f.order||f.arrayConfig||null]);
 // Firestore appends the default __name__ ordering; compare it explicitly.
 if(fields.length&&!fields.some(f=>f[0]==='__name__'))fields.push(['__name__',fields.at(-1)[1]==='DESCENDING'?'DESCENDING':'ASCENDING']);
 return JSON.stringify([row.queryScope,fields]);
}
function indexPlan(expected,actual){return expected.map(w=>{const match=actual.find(a=>a.collectionGroup===w.collectionGroup&&indexKey(a)===indexKey(w));return {definition:w,state:match?.state??'MISSING',name:match?.name??null};});}
function client(credential){return async (host,resource,{method='GET',body}={})=>{
 const {access_token}=await credential.getAccessToken();
 const res=await fetch(`https://${host}/${resource}`,{method,headers:{Authorization:`Bearer ${access_token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
 const result=await res.json();if(!res.ok){const e=Error(`${host}: HTTP ${res.status} ${result.error?.status??''}`);e.code=`HTTP_${res.status}`;e.status=res.status;throw e;}return result;
};}
const enc=encodeURIComponent;
const FIRE='firestore.googleapis.com',IDENT='identitytoolkit.googleapis.com',MAN='firebase.googleapis.com';
async function paginated(api,host,url,field){const out=[];let token;do{const page=await api(host,url+(token?(url.includes('?')?'&':'?')+'pageToken='+enc(token):''));out.push(...(page[field]||[]));token=page.nextPageToken;}while(token);return out;}
async function getDatabase(api,project){try{return await api(FIRE,`v1/projects/${project}/databases/(default)`);}catch(e){if(e.status===404)return null;throw e;}}
async function getAuthConfig(api,project){return api(IDENT,`admin/v2/projects/${project}/config`);}
function authPatch(current,domain){const body={},mask=[];if(current.signIn?.email?.enabled!==true||current.signIn?.email?.passwordRequired!==true){body.signIn={email:{enabled:true,passwordRequired:true}};mask.push('signIn.email.enabled','signIn.email.passwordRequired');}if(domain&&!(current.authorizedDomains||[]).includes(domain.toLowerCase())){body.authorizedDomains=[...new Set([...(current.authorizedDomains||[]),domain.toLowerCase()])];mask.push('authorizedDomains');}return {body,mask};}
async function updateAuth(api,project,domain,apply){const current=await getAuthConfig(api,project),plan=authPatch(current,domain);console.log(JSON.stringify({emailEnabled:current.signIn?.email?.enabled===true,passwordRequired:current.signIn?.email?.passwordRequired===true,authorizedDomains:current.authorizedDomains??[],plannedFields:plan.mask}));if(apply&&plan.mask.length){await api(IDENT,`admin/v2/projects/${project}/config?updateMask=${enc(plan.mask.join(','))}`,{method:'PATCH',body:plan.body});console.log('Auth 설정 적용 완료');}return plan;}
async function indexes(api,project,apply){const config=JSON.parse(fs.readFileSync(path.join(CONFIG,'firestore.indexes.json'),'utf8'));if(config.fieldOverrides?.length)throw Error('이 버전은 fieldOverrides 자동 적용을 지원하지 않습니다.');const defs=config.indexes;const actual=[];for(const group of new Set(defs.map(d=>d.collectionGroup))){const all=await paginated(api,FIRE,`v1/projects/${project}/databases/(default)/collectionGroups/${enc(group)}/indexes`,'indexes');actual.push(...all.map(a=>({...a,collectionGroup:group})));}const plan=indexPlan(defs,actual);console.table(plan.map(x=>({collection:x.definition.collectionGroup,fields:x.definition.fields.map(f=>`${f.fieldPath}:${f.order??f.arrayConfig}`).join(', '),state:x.state})));
 if(apply)for(const p of plan.filter(p=>p.state==='MISSING')){const {collectionGroup,...definition}=p.definition;try{const op=await api(FIRE,`v1/projects/${project}/databases/(default)/collectionGroups/${enc(collectionGroup)}/indexes`,{method:'POST',body:definition});console.log('인덱스 생성 요청:',op.name??'accepted');}catch(e){if(e.status!==409)throw e;console.log('이미 생성 요청된 인덱스 — 상태를 다시 확인하세요.');}}
 console.log('기존 인덱스는 삭제하지 않습니다. READY 상태까지 indexes-status로 확인하세요.');return plan;
}
async function rulesState(service){try{return await service.getFirestoreRuleset();}catch(e){if(e.code==='security-rules/not-found'||e.code==='not-found')return null;throw e;}}
function rulesDigest(s){return s?.source?.length===1&&typeof s.source[0].content==='string'?sha(s.source[0].content):null;}
async function rules(service,ctx,cmd,o){const source=fs.readFileSync(path.join(CONFIG,'firestore.rules'),'utf8'),current=await rulesState(service);const same=rulesDigest(current)===sha(source);console.log(JSON.stringify({current:current?.name??null,currentHash:rulesDigest(current),bundledHash:sha(source),matches:same}));
 if(cmd==='rules-rollback'&&!o.apply){const previous=await service.getRuleset(o.ruleset);console.log('복원 대상:',previous.name);return;}
 if(cmd==='rules-status'||!o.apply)return;
 if(cmd==='rules-deploy'&&same)return;
 if(current){const file=path.join(ctx.privateDir,`rules-backup-${ctx.stamp()}.json`);ctx.createPrivate(file,{projectId:ctx.project,name:current.name,source:current.source});console.log('기존 규칙 백업:',file);}
 if(cmd==='rules-rollback'){const previous=await service.getRuleset(o.ruleset);await service.releaseFirestoreRuleset(previous);console.log('복원 규칙:',previous.name);}else{const released=await service.releaseFirestoreRulesetFromSource(source);console.log('적용 규칙:',released.name);}
 const after=await rulesState(service);if(cmd==='rules-deploy'&&rulesDigest(after)!==sha(source)||cmd==='rules-rollback'&&after?.name!==o.ruleset)throw Error('배포 후 Rules 확인 실패. 상태 재확인 필요');
}
async function inventory(db,apply){const {migrateInventory}=await import('../lib/migrate-inventory.mjs');const r=await migrateInventory(db,{apply});console.log(JSON.stringify({totalProducts:r.totalProducts,totalReservations:r.totalReservations,missingReservations:r.newReservations.length,enabledBackfills:r.enabledBackfills.length,borrowerNameBackfills:r.borrowerNameBackfills.length,alreadyReady:r.alreadyReady,applied:r.applied}));return r;}
const ready=s=>s.exists&&s.data()?.ready===true&&Object.keys(s.data()).length===1;
async function upsertProduct(db,product,apply){const reserve=db.doc(`productNumbers/${key(product)}`),settings=db.doc('inventorySettings/v1'),ref=db.collection('products').doc();
 return db.runTransaction(async t=>{const [s,r]=await Promise.all([t.get(settings),t.get(reserve)]);if(!ready(s))throw Error('inventory-init을 먼저 실행하세요.');if(r.exists){const pid=r.data()?.productId;if(typeof pid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(pid))throw Error('잘못된 번호 예약');const p=await t.get(db.doc(`products/${pid}`));if(!p.exists||key(p.data())!==key(product)||p.data().name!==product.name||(p.data().isEnabled!==false)!==product.isEnabled)throw Error('동일 번호의 기존 물품과 정보가 다릅니다.');return {state:'exists',id:pid};}if(apply){t.create(ref,{...product,status:'available',activeRentalId:null});t.create(reserve,{productId:ref.id});}return {state:apply?'created':'new',id:apply?ref.id:undefined};});}
async function editProduct(db,cmd,o,apply){const ref=db.doc(`products/${o.id}`),settings=db.doc('inventorySettings/v1');return db.runTransaction(async t=>{const p=await t.get(ref);if(!p.exists)throw Error('물품 없음');const old=p.data();if(!['available','rented','return_requested'].includes(old.status))throw Error('알 수 없는 대여 상태');const item=productInput({category:o.category??old.category,name:o.name??old.name,displayNo:o.number===undefined?old.displayNo:Number(o.number),isEnabled:cmd==='products-enable'?true:cmd==='products-disable'?false:old.isEnabled!==false});const changed=key(item)!==key(old);if(cmd==='products-edit'&&(old.status!=='available'||old.activeRentalId!==null))throw Error('대여 중에는 사용 여부만 변경할 수 있습니다.');if(changed){if(old.status!=='available'||old.activeRentalId!==null)throw Error('대여 중 번호/카테고리 변경 금지');const a=db.doc(`productNumbers/${key(old)}`),b=db.doc(`productNumbers/${key(item)}`);const [s,ar,br]=await Promise.all([t.get(settings),t.get(a),t.get(b)]);if(!ready(s)||!ar.exists||ar.data()?.productId!==ref.id||br.exists)throw Error('물품 번호 인덱스 불일치 또는 중복');if(apply){t.delete(a);t.create(b,{productId:ref.id});}}if(apply)t.update(ref,item);return {id:ref.id,old:{category:old.category,name:old.name,displayNo:old.displayNo,isEnabled:old.isEnabled!==false},next:item};});}
function adminIdentity(u){return !!u&&typeof u.uid==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(u.uid)&&!/^\d{7}$/.test(u.uid)&&typeof u.email==='string'&&!u.email.toLowerCase().endsWith('@students.ohsung-rental.invalid')&&!Object.hasOwn(u.customClaims??{},'student_id');}
function activeAdminProfile(data){
 return data&&typeof data.name==='string'&&data.name.trim().length>0&&data.name.length<=80&&
  !/[\x00-\x1f\x7f]/.test(data.name)&&!Object.hasOwn(data,'studentId')&&
  !Object.hasOwn(data,'provisioningId')&&(!Object.hasOwn(data,'isActive')||data.isActive===true);
}
async function remainingAdmin(auth,db,roles,targetUid){
 for(const {id} of roles){
  if(id===targetUid)continue;
  let account;
  try{account=await auth.getUser(id);}
  catch(error){if(error.code==='auth/user-not-found')continue;throw error;}
  if(!adminIdentity(account)||account.disabled)continue;
  const profile=db.doc(`users/${id}`);
  if(activeAdminProfile((await profile.get()).data()))return {profile,role:db.doc(`roles/${id}`)};
 }
 return null;
}
async function adminChange(auth,db,cmd,o,ctx){let user;try{user=await auth.getUserByEmail(o.email);}catch(e){if(e.code!=='auth/user-not-found')throw e;}
 if(cmd==='admin-add'&&user)throw Error('이미 Auth 계정이 존재합니다. 검증 후 admin-grant를 사용하세요.');
 if(cmd!=='admin-add'&&(!adminIdentity(user)||cmd==='admin-grant'&&(!user.emailVerified||user.disabled)))throw Error('학생 계정이 아니며 이메일 확인이 완료된 활성 관리자 계정인지 확인하세요.');
 console.log(JSON.stringify({action:cmd,email:o.email,existing:!!user}));
 if(cmd==='admin-revoke'){
  const role=db.doc(`roles/${user.uid}`);
  const {docs}=await db.collection('roles').where('admin','==',true).get();
  if(!docs.some(({id})=>id===user.uid))throw Error('관리자 역할 없음');
  const survivor=await remainingAdmin(auth,db,docs,user.uid);
  if(!survivor)throw Error('마지막 관리자 권한은 삭제할 수 없습니다. 로그인 가능한 다른 관리자부터 확인하세요.');
  if(!o.apply)return;
  await db.runTransaction(async transaction=>{
   const [current,otherRole,otherProfile]=await Promise.all([
    transaction.get(role),transaction.get(survivor.role),transaction.get(survivor.profile),
   ]);
   if(current.data()?.admin!==true)throw Error('관리자 역할 없음');
   if(otherRole.data()?.admin!==true||!activeAdminProfile(otherProfile.data()))throw Error('마지막 관리자 권한은 삭제할 수 없습니다.');
   transaction.delete(role);
  });
  await auth.revokeRefreshTokens(user.uid);
  return;
 }
 if(!o.apply)return;
 if(cmd==='admin-add'){const password=ctx.randomPassword(),file=path.join(ctx.privateDir,`admin-credentials-${ctx.stamp()}.json`);ctx.createPrivate(file,{projectId:ctx.project,email:o.email,password});user=await auth.createUser({email:o.email,password,disabled:true});if(!adminIdentity(user))throw Error('생성한 관리자 UID/이메일 검증 실패. 계정 비활성 상태 유지');console.log('초기 관리자 비밀번호 파일:',file);}
 const uid=user.uid,profile=db.doc(`users/${uid}`),role=db.doc(`roles/${uid}`);
 await db.runTransaction(async t=>{const [p,r]=await Promise.all([t.get(profile),t.get(role)]);if(p.exists&&Object.keys(p.data()).some(k=>!['name','isActive'].includes(k))||r.exists&&Object.keys(r.data()).some(k=>k!=='admin'))throw Error('기존 프로필/역할과 충돌합니다.');t.set(profile,{name:validText(o.name,'관리자 이름'),isActive:true});t.set(role,{admin:true});});
 if(cmd==='admin-add')await auth.updateUser(uid,{disabled:false});console.log('관리자 권한 적용 완료');
}
const bundledConfigCommands=new Set(['setup','setup-status','rules-status','rules-deploy','indexes-status','indexes-deploy']);
async function runPlatform(parsed,ctx){const {cmd,o}=parsed;if(bundledConfigCommands.has(cmd)){const check=ctx.assertBundledConfig??(()=>require('../scripts/sync-firestore-config.cjs').assertBundledConfig());check();}const {project,auth,db,app}=ctx;const api=client(app.options.credential);const service=()=>require('firebase-admin/security-rules').getSecurityRules(app);console.log(`대상 Firebase 프로젝트: ${project} | ${o.apply?'실제 변경':'조회/사전 검사'}`);
 if(o.apply&&!await ctx.confirm(`${cmd.toUpperCase()} ${project}`)){console.log('취소');return 0;}
 if(o.apply)ctx.audit({action:cmd,status:'started'});
 try{
  if(cmd==='db-create'){const d=await getDatabase(api,project);if(d){console.log(JSON.stringify({exists:true,location:d.locationId,type:d.type,edition:d.databaseEdition}));}else{console.log('신규 기본 데이터베이스:',o.location,'STANDARD / FIRESTORE_NATIVE');if(o.apply){const op=await api(FIRE,`v1/projects/${project}/databases?databaseId=${enc('(default)')}`,{method:'POST',body:{locationId:o.location,type:'FIRESTORE_NATIVE',databaseEdition:'STANDARD'}});console.log('생성 요청:',op.name??'accepted','— 완료 후 setup-status 실행');}}}
  else if(cmd==='auth-config')await updateAuth(api,project,o.domain,!!o.apply);
  else if(cmd==='web-apps'||cmd==='web-app-create'||cmd==='web-config'){
    const apps=await paginated(api,MAN,`v1beta1/projects/${project}/webApps`,'apps');console.table(apps.map(a=>({appId:a.appId,displayName:a.displayName})));if(cmd==='web-app-create'){const same=apps.filter(a=>a.displayName===o.name);if(same.length)console.log('동일 표시명 앱이 이미 존재합니다.');else if(o.apply){const op=await api(MAN,`v1beta1/projects/${project}/webApps`,{method:'POST',body:{displayName:o.name}});console.log('생성 요청:',op.name??'accepted');}}else if(cmd==='web-config'){const id=o['app-id']??(apps.length===1?apps[0].appId:null);if(!id||!apps.some(a=>a.appId===id))throw Error('--app-id를 지정하세요.');const c=await api(MAN,`v1beta1/projects/${project}/webApps/${enc(id)}/config`);if(c.projectId!==project||!c.apiKey||!c.authDomain||!c.appId)throw Error('웹 설정 불일치');console.log(`VITE_FIREBASE_API_KEY=${c.apiKey}\nVITE_FIREBASE_AUTH_DOMAIN=${c.authDomain}\nVITE_FIREBASE_PROJECT_ID=${c.projectId}\nVITE_FIREBASE_APP_ID=${c.appId}`);}}
  else if(cmd.startsWith('rules-'))await rules(service(),ctx,cmd,o);
  else if(cmd.startsWith('indexes-'))await indexes(api,project,!!o.apply);
  else if(cmd==='inventory-init')await inventory(db,!!o.apply);
  else if(cmd==='setup'||cmd==='setup-status'){
    const d=await getDatabase(api,project);if(!d){console.log('기본 Firestore 없음. db-create --location LOCATION으로 먼저 준비하세요.');return 1;}if(d.type!=='FIRESTORE_NATIVE'||d.databaseEdition&&d.databaseEdition!=='STANDARD')throw Error('Standard Native 기본 DB가 필요합니다.');console.log('Firestore 위치:',d.locationId);
    // Validate all dependencies before mutating configuration.
    await updateAuth(api,project,o.domain,false);await rules(service(),ctx,'rules-status',{});await indexes(api,project,false);await inventory(db,false);
    if(o.apply){await rules(service(),ctx,'rules-deploy',o);await indexes(api,project,true);await inventory(db,true);await updateAuth(api,project,o.domain,true);console.log('초기 설정 요청 완료. 인덱스 READY 및 관리자/학생 등록을 별도로 확인하세요.');}}
  else if(cmd==='products-list'){const snap=await db.collection('products').get();console.table(snap.docs.map(d=>({id:d.id,...d.data()})));}
  else if(cmd==='products-add'||cmd==='products-import'){const rows=cmd==='products-add'?[productInput({category:o.category,name:o.name,displayNo:Number(o.number)})]:productRows(o.file);if(o.apply)for(const p of rows)await upsertProduct(db,p,false);const counts={};for(const p of rows){const r=await upsertProduct(db,p,!!o.apply);counts[r.state]=(counts[r.state]??0)+1;}console.log(JSON.stringify(counts));}
  else if(['products-edit','products-enable','products-disable'].includes(cmd))console.log(JSON.stringify(await editProduct(db,cmd,o,!!o.apply)));
  else if(cmd==='admins-list'){const rows=await db.collection('roles').where('admin','==',true).get();console.table(rows.docs.map(r=>({uid:r.id,admin:true})));}
  else if(cmd.startsWith('admin-'))await adminChange(auth,db,cmd,o,ctx);
  else if(cmd==='rentals-summary'){const snap=await db.collection('rentals').get();const counts={};for(const d of snap.docs){const status=d.get('status')??'UNKNOWN';counts[status]=(counts[status]??0)+1;}console.log(JSON.stringify(counts));}
  if(o.apply)ctx.audit({action:cmd,status:'finished'});return 0;
 }catch(e){if(o.apply)ctx.audit({action:cmd,status:'failed',code:e.code??'CHECK_OR_WRITE_FAILED'});throw e;}
}
module.exports={COMMANDS,HELP,parsePlatform,indexKey,indexPlan,authPatch,productInput,productRows,upsertProduct,editProduct,adminIdentity,runPlatform};
