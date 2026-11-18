import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
const require=createRequire(import.meta.url);
const boundaries=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
let owned={};try{owned=require('../../packages/ai-engine/quality/owned-runtime.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const need=name=>assert.equal(typeof owned[name],'function',name+' must exist');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const dead=()=>Object.assign(new Error('runtime tried to restart'),{code:'PROCESS_RESTART_REQUIRED'});

test('optional run spawn policy rejects before native spawn and nested run cannot bypass a frozen cold policy',async()=>{
 const owner=new boundaries.ProcessOwner(),native=childProcess.spawn;let spawned=0,denied=0;
 childProcess.spawn=()=>{spawned++;throw new Error('native spawn must never be called');};const release=boundaries.acquireHooks();
 try{
  const policy={allowSpawn:false,onSpawnDenied:()=>denied++};
  assert.throws(()=>owner.run(()=>childProcess.spawn(process.execPath,[]),undefined,undefined,policy),error=>error.code==='PROCESS_RESTART_REQUIRED');
  assert.throws(()=>owner.run(()=>owner.run(()=>owner.spawn(process.execPath,[])),undefined,undefined,policy),error=>error.code==='PROCESS_RESTART_REQUIRED');
  const delayed={allowSpawn:true,onSpawnDenied:()=>denied++};const call=owner.run(async()=>{await tick();return childProcess.spawn(process.execPath,[]);},undefined,undefined,delayed);delayed.allowSpawn=false;await assert.rejects(call,error=>error.code==='PROCESS_RESTART_REQUIRED');
  assert.equal(spawned,0);assert.equal(denied,3);assert.equal(owner.children.size,0);
 }finally{release();childProcess.spawn=native;syncBuiltinESMExports();}
});

test('reuse flags default to false, require booleans, and scoped identities never include malformed or missing principals',()=>{
 need('runtimeReuseFlags');need('runtimeCacheIdentity');assert.deepEqual(owned.runtimeReuseFlags({}),{ocr:false,translation:false});assert.deepEqual(owned.runtimeReuseFlags({reuseOcrRuntime:true,reuseTranslationServer:false}),{ocr:true,translation:false});
 for(const value of ['true',1,null])assert.throws(()=>owned.runtimeReuseFlags({reuseOcrRuntime:value}),error=>error.code==='CONFIG_PATH');
 const base={kind:'ocr',ownerScope:'a'.repeat(64),projectId:'book',configuration:{model:'one'}};
 const key=owned.runtimeCacheIdentity(base);assert.match(key,/^[0-9a-f]{64}$/);assert.notEqual(owned.runtimeCacheIdentity({...base,projectId:'other'}),key);assert.notEqual(owned.runtimeCacheIdentity({...base,ownerScope:'b'.repeat(64)}),key);assert.notEqual(owned.runtimeCacheIdentity({...base,configuration:{model:'two'}}),key);
 for(const scope of [undefined,'raw-cookie','a'.repeat(63)])assert.equal(owned.runtimeCacheIdentity({...base,ownerScope:scope}),null);assert.equal(owned.runtimeCacheIdentity({...base,projectId:null}),null);
});

function fakeOwner(){return {children:new Map(),run:async(operation,_auth,signal,policy)=>{if(signal?.aborted)throw signal.reason;return operation(policy);},cleanup:async function(){for(const record of this.children.values()){record.closed=true;record.child.exitCode=0;}}};}
const record=()=>({closed:false,error:false,child:{exitCode:null,signalCode:null,killed:false}});
const context=(extra={})=>({ownerScope:'a'.repeat(64),projectId:'book',configuration:{model:'one'},runtimeEvent:async()=>{},...extra});

test('same owner/project reuses one independent owner while job cleanup cannot touch its captured child',async()=>{
 need('createOwnedRuntimeCache');let creations=0,closes=0;const cacheOwners=[],events=[];
 const cache=owned.createOwnedRuntimeCache({kind:'ocr',createOwner:()=>{const owner=fakeOwner();cacheOwners.push(owner);return owner;},create:async({owner})=>({owner,generation:++creations}),destroy:async()=>{closes++;}});
 const use=extra=>cache.use(context({runtimeEvent:async(phase,data)=>events.push({phase,...data}),...extra}),async(runtime,{owner,policy,warm})=>{if(!warm){const child=record();owner.children.set(child.child,child);}assert.equal(policy.allowSpawn,!warm);return runtime.generation;});
 assert.equal(await use(),1);const jobOwner=fakeOwner();await jobOwner.cleanup();assert.equal(await use(),1);assert.equal(creations,1);assert.equal(closes,0);assert.equal(cacheOwners[0].children.values().next().value.closed,false);assert.deepEqual(events.filter(value=>value.phase==='ocr_runtime_cache').map(value=>value.mode),['cold','warm']);
 assert.equal(await use({projectId:'other'}),2);assert.equal(closes,1);assert.equal(await use({ownerScope:'b'.repeat(64)}),3);assert.equal(closes,2);await cache.close();assert.equal(closes,3);assert.equal(cache.status().owned,0);
});

test('warm restart or dead captured child fails the current operation and only a later explicit use can cold prepare',async()=>{
 need('createOwnedRuntimeCache');let creates=0,closes=0;
 const cache=owned.createOwnedRuntimeCache({kind:'ocr',createOwner:fakeOwner,create:async()=>({generation:++creates}),destroy:async()=>{closes++;}});
 const op=async(runtime,{owner,warm,policy})=>{if(!warm){const child=record();owner.children.set(child.child,child);return runtime.generation;}policy.onSpawnDenied();throw dead();};
 assert.equal(await cache.use(context(),op),1);await assert.rejects(cache.use(context(),op),error=>error.code==='PROCESS_RESTART_REQUIRED');assert.equal(creates,1);assert.equal(closes,1);assert.equal(await cache.use(context(),op),2);assert.equal(creates,2);
 await assert.rejects(cache.use(context(),async(runtime,{owner})=>{const child=owner.children.values().next().value;child.closed=true;child.child.exitCode=1;return 'must not accept a dead warm child';}),error=>error.code==='PROCESS_RESTART_REQUIRED');assert.equal(creates,2);assert.equal(await cache.use(context(),op),3);await cache.close();
});

test('zero captured children and ineligible owner/project never retain a successful runtime',async()=>{
 need('createOwnedRuntimeCache');let creates=0,closes=0;
 const cache=owned.createOwnedRuntimeCache({kind:'ocr',createOwner:fakeOwner,create:()=>({generation:++creates}),destroy:()=>{closes++;}});
 await cache.use(context(),()=>1);await cache.use(context(),()=>2);assert.equal(creates,2);assert.equal(closes,2);
 const op=async(runtime,{owner})=>{const child=record();owner.children.set(child.child,child);return runtime.generation;};
 await cache.use(context({ownerScope:undefined}),op);await cache.use(context({ownerScope:undefined}),op);assert.equal(creates,4);assert.equal(closes,4);assert.equal(cache.status().retained,false);await cache.close();
});

test('prepare failure always closes partial service and independent owner; uncertain release blocks new cold factories',async()=>{
 need('createOwnedRuntimeCache');let creates=0,closes=0,ownerCleanups=0;
 const cache=owned.createOwnedRuntimeCache({kind:'ocr',createOwner:()=>({...fakeOwner(),cleanup:async()=>{ownerCleanups++;throw new Error('owner still alive');}}),create:()=>({generation:++creates}),prepare:()=>{throw new Error('preflight failed');},destroy:()=>{closes++;}});
 await assert.rejects(cache.use(context(),()=>1),error=>error.code==='RUNTIME_LEASE_BLOCKED');assert.equal(creates,1);assert.equal(closes,1);assert.equal(ownerCleanups,1);await assert.rejects(cache.use(context({projectId:'other'}),()=>1),error=>error.code==='RUNTIME_LEASE_BLOCKED');assert.equal(creates,1);await assert.rejects(cache.close(),error=>error.code==='RUNTIME_LEASE_BLOCKED');
});

test('explicit false service release is unconfirmed even when the separate owner cleanup finishes',async()=>{
 need('createOwnedRuntimeCache');let creates=0;
 const cache=owned.createOwnedRuntimeCache({kind:'ocr',createOwner:fakeOwner,create:()=>({generation:++creates}),destroy:()=>false});
 await assert.rejects(cache.use(context(),()=>1),error=>error.code==='RUNTIME_LEASE_BLOCKED');assert.equal(cache.status().blocked,true);await assert.rejects(cache.use(context({projectId:'new'}),()=>1),error=>error.code==='RUNTIME_LEASE_BLOCKED');assert.equal(creates,1);await assert.rejects(cache.close(),error=>error.code==='RUNTIME_LEASE_BLOCKED');
});
