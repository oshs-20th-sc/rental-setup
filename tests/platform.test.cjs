'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {parsePlatform,indexKey,indexPlan,authPatch,productInput,productRows,adminIdentity,upsertProduct,editProduct,runPlatform}=require('../bin/platform.cjs');
const {guardedImport}=require('../bin/bulk-register.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const defs=JSON.parse(fs.readFileSync(path.join(__dirname,'../config/firestore.indexes.json'))).indexes;
test('all 12 repository indexes present',()=>a.equal(defs.length,12));
test('index matches implicit __name__ DESC and rejects different fields',()=>{const d=defs[0];const existing={...d,fields:[...d.fields,{fieldPath:'__name__',order:'DESCENDING'}],state:'READY'};a.equal(indexKey(d),indexKey(existing));a.equal(indexPlan([d],[existing])[0].state,'READY');a.equal(indexPlan([d],[{...existing,collectionGroup:'other'}])[0].state,'MISSING');a.equal(indexPlan([d],[{...existing,fields:[...d.fields,{fieldPath:'__name__',order:'ASCENDING'}]}])[0].state,'MISSING');});
test('email configuration adds domain without deleting others',()=>{const c={signIn:{email:{enabled:false},anonymous:{enabled:true}},authorizedDomains:['existing.example.org']};const p=authPatch(c,'new.example.org');a.deepEqual(p.body.authorizedDomains,['existing.example.org','new.example.org']);a.deepEqual(p.body.signIn.email,{enabled:true,passwordRequired:true});a.ok(!p.mask.includes('signIn.anonymous'));a.deepEqual(authPatch({signIn:{email:{enabled:true,passwordRequired:true}},authorizedDomains:['new.example.org']},'new.example.org').mask,[]);});
test('platform commands default to preview and reject invalid arguments',()=>{a.equal(parsePlatform(['setup']).o.apply,undefined);a.equal(parsePlatform(['rules-deploy','--apply']).o.apply,true);for(const args of [['setup','--domain','https://x.com'],['indexes-status','--apply'],['db-create'],['products-edit','--id','id'],['products-add','--category','Umbrella','--name','Test','--number','0'],['admin-add','--email','2600000@students.ohsung-rental.invalid','--name','X'],['rules-deploy','--check','--apply']])a.throws(()=>parsePlatform(args));});
test('bundled config failure stops setup before confirmation or API use',async()=>{let apiCalls=0,confirmed=false;const command=parsePlatform(['setup','--apply']);await a.rejects(runPlatform(command,{assertBundledConfig(){throw Error('config drift');},project:'demo-ohsung-rental',app:{options:{credential:{getAccessToken:async()=>{apiCalls++;return {access_token:'unused'};}}}},confirm:async()=>{confirmed=true;return true;},audit:()=>{},auth:{},db:{}}),/config drift/);a.equal(apiCalls,0);a.equal(confirmed,false);});
test('product validation and duplicate manifest rejection',()=>{a.deepEqual(productInput({category:' umbrella ',name:'test',displayNo:1}),{category:'umbrella',name:'test',displayNo:1,isEnabled:true});for(const r of [{category:'a/b',name:'x',displayNo:1},{category:'a',name:'x',displayNo:0},{category:'a',name:'x',displayNo:1,status:'rented'}])a.throws(()=>productInput(r));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ohsung-test-'));try{const file=path.join(dir,'products.json');fs.writeFileSync(file,JSON.stringify([{category:'a',name:'x',displayNo:1},{category:'a',name:'y',displayNo:1}]));a.throws(()=>productRows(file));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('student identities cannot become admin through role commands',()=>{a.ok(adminIdentity({uid:'randomUID',email:'admin@example.org'}));for(const u of [{uid:'2600000',email:'admin@example.org'},{uid:'randomUID',email:'2600000@students.ohsung-rental.invalid'},{uid:'randomUID',email:'admin@example.org',customClaims:{student_id:'2600000'}}])a.equal(adminIdentity(u),false);});
test('last login-capable admin cannot be revoked, even if disabled roles remain',async()=>{
 const target={uid:'admin-user',email:'admin@example.test'};
 const other={uid:'other-admin',email:'other@example.test'};
 async function run({hasOther=true,disabled=false,profileAvailable=true}={}){
  const events=[];
  const roles=[{id:target.uid},...(hasOther?[{id:other.uid}]:[])];
  const data=new Map([
   ['roles/admin-user',{admin:true}],
   ['roles/other-admin',{admin:true}],
   ...(profileAvailable?[['users/other-admin',{name:'Example other'}]]:[]),
  ]);
  const snapshot=ref=>({data:()=>data.get(ref.path)});
  const db={
   doc:path=>({path,get:async()=>snapshot({path})}),
   collection:()=>({where:()=>({get:async()=>({docs:roles})})}),
   runTransaction:async fn=>fn({get:async ref=>snapshot(ref),delete:ref=>events.push(['delete',ref.path])}),
  };
  const auth={
   getUserByEmail:async()=>target,
   getUser:async()=>({...other,disabled}),
   revokeRefreshTokens:async uid=>events.push(['revoke',uid]),
  };
  const result=runPlatform(parsePlatform(['admin-revoke','--email',target.email,'--apply']),{
   project:'demo-ohsung-rental', app:{options:{credential:{}}}, auth,db,confirm:async()=>true,audit:()=>{},
  });
  return {result,events};
 }
 for(const cases of [{hasOther:false},{disabled:true},{profileAvailable:false}]){
  const {result,events}=await run(cases);
  await a.rejects(result,/마지막 관리자/);
  a.deepEqual(events,[]);
 }
 const {result,events}=await run();
 await result;
 a.deepEqual(events,[['delete','roles/admin-user'],['revoke','admin-user']]);
});
test('guarded import sets server no-overwrite and sanity-check, fails closed on version change',async()=>{let sent;const auth={authRequestHandler:{invokeRequestHandler:(_u,_s,data)=>{sent=data;return Promise.resolve({successCount:1});}},importUsers(records){return this.authRequestHandler.invokeRequestHandler('',{getEndpoint:()=>'/accounts:batchCreate'},{users:records});}};await guardedImport(auth,[{uid:'demo'}],{},'14.5.1');a.equal(sent.allowOverwrite,false);a.equal(sent.sanityCheck,true);a.throws(()=>guardedImport(auth,[],{},'0.0.0'));a.throws(()=>guardedImport({importUsers:()=>{}},[],{},'14.5.1'));});
function fakeDb(initial){const docs=new Map(Object.entries(initial));let seq=0;const ref=p=>({path:p,id:p.split('/').at(-1)});const get=r=>({exists:docs.has(r.path),data:()=>docs.get(r.path),id:r.id});const db={doc:ref,collection:p=>({doc:()=>ref(`${p}/p${++seq}`)}),runTransaction:async fn=>fn({get:async r=>get(r),create:(r,d)=>{if(docs.has(r.path))throw Error('exists');docs.set(r.path,d);},update:(r,d)=>docs.set(r.path,{...docs.get(r.path),...d}),delete:r=>docs.delete(r.path)})};return {db,docs};}
const product={category:'umbrella',name:'test',displayNo:1,isEnabled:true};
test('product create reserves number, repeated import skips without duplicate',async()=>{const {db,docs}=fakeDb({'inventorySettings/v1':{ready:true}});a.equal((await upsertProduct(db,product,false)).state,'new');a.equal(docs.size,1);const r=await upsertProduct(db,product,true);a.equal(docs.get(`productNumbers/umbrella|1`).productId,r.id);a.equal(docs.get(`products/${r.id}`).status,'available');a.equal((await upsertProduct(db,product,true)).state,'exists');await a.rejects(upsertProduct(db,{...product,name:'conflict'},true));a.equal(docs.size,3);});
test('product editing moves reservation atomically, blocks loaned metadata changes',async()=>{const {db,docs}=fakeDb({'inventorySettings/v1':{ready:true},'products/p1':{...product,status:'available',activeRentalId:null},'productNumbers/umbrella|1':{productId:'p1'}});await editProduct(db,'products-edit',{id:'p1',number:'2'},true);a.ok(!docs.has('productNumbers/umbrella|1'));a.equal(docs.get('productNumbers/umbrella|2').productId,'p1');docs.set('products/p1',{...docs.get('products/p1'),status:'rented',activeRentalId:'loan1'});await a.rejects(editProduct(db,'products-edit',{id:'p1',name:'other'},true));await editProduct(db,'products-disable',{id:'p1'},true);a.equal(docs.get('products/p1').isEnabled,false);a.equal(docs.get('products/p1').activeRentalId,'loan1');});
