'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {parse,state,mutate}=require('../bin/rental-setup.cjs');
const id='2600000';
const account={uid:id,email:`${id}@students.ohsung-rental.invalid`,customClaims:{student_id:id},disabled:false};
const snapshot=(name,d)=>({id:name,exists:d!==undefined,data:()=>d,get:k=>d?.[k]});
const profile={studentId:id,name:'가상 학생',grade:1};
const role=snapshot(id,undefined);
function mock({u={...account},p={...profile},r,loans=[]}={}){
  const events=[];
  const ref=path=>({path,id:path.split('/')[1]});
  const get=doc=>doc.query?{docs:loans.map((d,i)=>snapshot(String(i),d)),empty:loans.length===0}:snapshot(doc.id,doc.path.startsWith('roles/')?r:p);
  const db={doc:ref,getAll:async(...refs)=>refs.map(get),collection:()=>({where:()=>{const q={query:true,get:async()=>get(q),limit:()=>q};return q;}}),runTransaction:async fn=>fn({get:async doc=>get(doc),update:(doc,changes)=>{events.push(['profile',changes]);p={...p,...changes};},delete:()=>{events.push(['purge']);p=undefined;}})};
  const auth={getUsers:async()=>({users:u?[u]:[]}),updateUser:async(_,changes)=>{events.push(['auth',changes]);u={...u,...changes};},revokeRefreshTokens:async()=>events.push(['revoke']),deleteUser:async()=>{events.push(['deleteAuth']);u=null;}};
  return {auth,db,events};
}
test('read only by default, explicit apply',()=>{assert.equal(parse(['reset',id]).o.apply,undefined);assert.equal(parse(['reset',id,'--apply']).o.apply,true);});
test('bulk roster commands require an explicit or configured roster',()=>{const previous=process.env.OHSUNG_ROSTER;try{delete process.env.OHSUNG_ROSTER;assert.throws(()=>parse(['register']),/--roster JSON/);assert.throws(()=>parse(['sync']),/--roster JSON/);assert.doesNotThrow(()=>parse(['register','--roster','students.json']));process.env.OHSUNG_ROSTER='students.json';assert.doesNotThrow(()=>parse(['sync']));}finally{if(previous===undefined)delete process.env.OHSUNG_ROSTER;else process.env.OHSUNG_ROSTER=previous;}});
test('reject bad id, options, grade and concurrency',()=>{for(const a of [['delete','123'],['show',id,'--apply'],['edit',id,'--grade','4'],['delete-all','--check','--apply'],['reset-all','--concurrency','20']])assert.throws(()=>parse(a));});
test('strict student identity and admin exclusion',()=>{const p=snapshot(id,profile);assert.equal(state(id,account,p,role),'enabled');assert.equal(state(id,account,p,snapshot(id,{admin:true})),'protected');assert.equal(state(id,{...account,customClaims:{student_id:id,admin:true}},p,role),'mismatch');assert.equal(state(id,{...account,email:'other@example.invalid'},p,role),'mismatch');});
test('archive and pending provisioning exclusion',()=>{assert.equal(state(id,null,snapshot(id,{...profile,isActive:false}),role),'archived');assert.equal(state(id,account,snapshot(id,{...profile,provisioningId:'test'}),role),'mismatch');});
test('reset changes password and revokes existing refresh tokens',async()=>{const x=mock({u:{...account,disabled:true}});await mutate(x.auth,x.db,'reset',id,{password:'Example-Unique-Password'});assert.deepEqual(x.events,[['auth',{password:'Example-Unique-Password'}],['revoke']]);});
test('edit changes only profile',async()=>{const x=mock();await mutate(x.auth,x.db,'edit',id,{name:'가상 이름',grade:2});assert.deepEqual(x.events,[['profile',{name:'가상 이름',grade:2}]]);});
test('enable preserves password',async()=>{const x=mock({u:{...account,disabled:true},p:{...profile,isActive:false}});await mutate(x.auth,x.db,'enable',id);assert.deepEqual(x.events,[['auth',{disabled:false}],['profile',{isActive:true}]]);});
test('disable gates profile, disables and revokes',async()=>{const x=mock();await mutate(x.auth,x.db,'disable',id);assert.deepEqual(x.events,[['profile',{isActive:false}],['auth',{disabled:true}],['revoke']]);});
test('delete blocked by open or unknown rental status',async()=>{for(const status of ['rented','return_requested','unknown']){const x=mock({loans:[{status}]});await assert.rejects(mutate(x.auth,x.db,'delete',id));assert.deepEqual(x.events,[]);}});
test('delete retains profile and rental history',async()=>{const x=mock({loans:[{status:'returned'}]});await mutate(x.auth,x.db,'delete',id);assert.deepEqual(x.events,[['profile',{isActive:false}],['auth',{disabled:true}],['revoke'],['deleteAuth']]);});
test('admin account cannot be changed',async()=>{const x=mock({r:{admin:true}});await assert.rejects(mutate(x.auth,x.db,'reset',id,{password:'Example-Unique-Password'}));assert.deepEqual(x.events,[]);});
test('purge only archived profile with no rental history',async()=>{const x=mock({u:null,p:{...profile,isActive:false}});await mutate(x.auth,x.db,'purge',id);assert.deepEqual(x.events,[['purge']]);const y=mock({u:null,p:{...profile,isActive:false},loans:[{status:'returned'}]});await assert.rejects(mutate(y.auth,y.db,'purge',id));assert.deepEqual(y.events,[]);});
