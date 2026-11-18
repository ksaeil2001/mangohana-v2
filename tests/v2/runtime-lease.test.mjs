import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
let createRuntimeLeasePool;
try{({createRuntimeLeasePool}=require('../../packages/ai-engine/quality/runtime-lease.cjs'));}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const factory=()=>{assert.equal(typeof createRuntimeLeasePool,'function','runtime lease pool must exist');return createRuntimeLeasePool;};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const observe=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,error}));
const busy=error=>error?.code==='RUNTIME_LEASE_BUSY';
const blocked=error=>error?.code==='RUNTIME_LEASE_BLOCKED';
const closed=error=>error?.code==='RUNTIME_LEASE_CLOSED';

test('same healthy identity survives successful uses; replacing identity waits for actual disposal',async()=>{
 const createPool=factory(),created=[],destroyed=[],release=deferred();let oldDestroyStarted=false;
 const pool=createPool({create:async({identity})=>{const value={identity,healthy:true};created.push(value);return value;},validate:value=>value.healthy,destroy:async value=>{destroyed.push(value);if(value.identity==='ocr-a'){oldDestroyStarted=true;await release.promise;}},cleanupMs:250});
 assert.equal(await pool.use({identity:'ocr-a'},value=>value.identity),'ocr-a');
 const first=await pool.use({identity:'ocr-a'},value=>value);assert.equal(created.length,1);assert.equal(pool.status().retained,true);
 const next=pool.use({identity:'ocr-b'},value=>value.identity);await tick();assert.equal(oldDestroyStarted,true);assert.equal(created.length,1);await assert.rejects(pool.use({identity:'ocr-a'},()=>{}),busy);release.resolve();assert.equal(await next,'ocr-b');assert.equal(destroyed[0],first);assert.equal(created.length,2);
 await pool.close();assert.deepEqual(destroyed,created);assert.equal(pool.status().owned,0);await assert.rejects(pool.use({identity:'ocr-b'},()=>{}),closed);
});

test('unhealthy retained runtime is destroyed before a cold factory, and an unhealthy successful result is not retained',async()=>{
 const createPool=factory(),created=[],destroyed=[];
 const pool=createPool({create:async()=>{const value={alive:true};created.push(value);return value;},validate:async value=>value.alive,destroy:value=>{destroyed.push(value);}});
 const first=await pool.use({identity:'one'},value=>value);first.alive=false;
 assert.equal(await pool.use({identity:'one'},value=>{assert.equal(destroyed[0],first);value.alive=false;return 'valid completed result';}),'valid completed result');
 assert.equal(created.length,2);assert.equal(pool.status().retained,false);assert.equal(destroyed.length,2);await pool.close();
});

test('operation failure disposes once and drains before allowing a later use',async()=>{
 const createPool=factory(),destroy=deferred(),started=deferred();let creates=0,disposals=0;
 const pool=createPool({create:()=>({id:++creates}),validate:()=>true,destroy:async()=>{disposals++;started.resolve();await destroy.promise;},cleanupMs:250});
 const result=observe(pool.use({identity:'a'},async()=>{throw new Error('inference failed');}));await started.promise;await assert.rejects(pool.use({identity:'a'},()=>{}),busy);assert.equal(creates,1);destroy.resolve();const failure=await result;assert.equal(failure.ok,false);assert.match(failure.error.message,/inference failed/);assert.equal(disposals,1);
 assert.equal(await pool.use({identity:'a'},()=>7),7);assert.equal(creates,2);await pool.close();assert.equal(disposals,2);
});

test('aborting a factory drains its late resource and destroys it exactly once before a next lease',async()=>{
 const createPool=factory(),creation=deferred(),cleanup=deferred(),entered=deferred(),controller=new AbortController();let creates=0,disposals=0,operationCalls=0;
 const pool=createPool({create:({signal})=>{creates++;assert.equal(signal.aborted,false);entered.resolve();return creation.promise;},validate:()=>true,destroy:async()=>{disposals++;await cleanup.promise;},cleanupMs:250});
 let settled=false;const run=observe(pool.use({identity:'a',signal:controller.signal},()=>{operationCalls++;return 'late success';})).then(value=>{settled=true;return value;});await entered.promise;controller.abort();await tick();assert.equal(settled,false);await assert.rejects(pool.use({identity:'b'},()=>{}),busy);
 creation.resolve({resource:true});await tick();assert.equal(disposals,1);assert.equal(settled,false);cleanup.resolve();const result=await run;assert.equal(result.ok,false);assert.equal(result.error.name,'AbortError');assert.equal(operationCalls,0);assert.equal(pool.status().owned,0);assert.equal(pool.status().blocked,false);await pool.close();assert.equal(creates,1);assert.equal(disposals,1);
});

test('abort destroys an active value but also drains a late operation result before returning',async()=>{
 const createPool=factory(),operation=deferred(),entered=deferred(),controller=new AbortController();let disposals=0,settled=false;
 const pool=createPool({create:()=>({}),validate:()=>true,destroy:()=>{disposals++;},cleanupMs:250});
 const run=observe(pool.use({identity:'a',signal:controller.signal},()=>{entered.resolve();return operation.promise;})).then(value=>{settled=true;return value;});await entered.promise;controller.abort();await tick();assert.equal(disposals,1);assert.equal(settled,false);await assert.rejects(pool.use({identity:'b'},()=>{}),busy);operation.resolve('late forbidden success');const result=await run;assert.equal(result.ok,false);assert.equal(result.error.name,'AbortError');assert.equal(disposals,1);assert.equal(pool.status().blocked,false);await pool.close();
});

test('close during create drains the resource, rejects late success, and shares one cleanup across concurrent close and abort',async()=>{
 const createPool=factory(),creation=deferred(),entered=deferred(),controller=new AbortController();let disposed=0;
 const pool=createPool({create:()=>{entered.resolve();return creation.promise;},validate:()=>true,destroy:()=>{disposed++;},cleanupMs:250});
 const use=observe(pool.use({identity:'a',signal:controller.signal},()=>assert.fail('must not execute')));await entered.promise;const firstClose=pool.close(),secondClose=pool.close();assert.equal(firstClose,secondClose);controller.abort();creation.resolve({});const result=await use;assert.equal(result.ok,false);await firstClose;assert.equal(disposed,1);assert.equal(pool.status().closed,true);assert.equal(pool.status().owned,0);await assert.rejects(pool.use({identity:'b'},()=>{}),closed);
});

test('simultaneous operation rejection, close and abort cannot destroy the same value twice',async()=>{
 const createPool=factory(),operation=deferred(),entered=deferred(),controller=new AbortController();let disposed=0;
 const pool=createPool({create:()=>({}),validate:()=>true,destroy:async()=>{disposed++;await tick();},cleanupMs:250});
 const use=observe(pool.use({identity:'a',signal:controller.signal},()=>{entered.resolve();return operation.promise;}));await entered.promise;operation.reject(new Error('operation ended'));const close=pool.close();controller.abort();const result=await use;assert.equal(result.ok,false);await close;assert.equal(disposed,1);assert.equal(pool.status().owned,0);
});

test('cleanup rejection and explicit unconfirmed cleanup permanently block even a different cold identity',async()=>{
 const createPool=factory();for(const uncertain of [()=>{throw new Error('child still alive');},()=>false]){let creates=0;
  const pool=createPool({create:()=>({id:++creates}),validate:()=>true,destroy:uncertain,cleanupMs:25});
  await assert.rejects(pool.use({identity:'a'},()=>{throw new Error('work failed');}),blocked);assert.equal(pool.status().blocked,true);assert.equal(pool.status().owned,1);await assert.rejects(pool.use({identity:'b'},()=>{}),blocked);assert.equal(creates,1);await assert.rejects(pool.close(),blocked);
 }
});

test('unsettled late creation blocks on a bounded deadline and destroys a resource arriving after that deadline once', {timeout:1500},async()=>{
 const createPool=factory(),creation=deferred(),entered=deferred(),controller=new AbortController();let disposed=0,creates=0;
 const pool=createPool({create:()=>{creates++;entered.resolve();return creation.promise;},validate:()=>true,destroy:()=>{disposed++;},cleanupMs:20});
 const use=observe(pool.use({identity:'a',signal:controller.signal},()=>assert.fail('late execution')));await entered.promise;controller.abort();const result=await use;assert.equal(result.ok,false);assert.equal(blocked(result.error),true);assert.equal(pool.status().blocked,true);await assert.rejects(pool.use({identity:'b'},()=>{}),blocked);assert.equal(creates,1);
 creation.resolve({late:true});await tick();await tick();assert.equal(disposed,1);assert.equal(pool.status().owned,0);assert.equal(pool.status().blocked,true);await assert.rejects(pool.close(),blocked);
});

test('a timed-out operation is never returned as success and failure to drain it blocks permanently', {timeout:1500},async()=>{
 const createPool=factory(),operation=deferred(),entered=deferred();let disposed=0;
 const pool=createPool({create:()=>({}),validate:()=>true,destroy:()=>{disposed++;},cleanupMs:20});
 const use=observe(pool.use({identity:'a',signal:AbortSignal.timeout(15)},()=>{entered.resolve();return operation.promise;}));await entered.promise;const result=await use;assert.equal(result.ok,false);assert.equal(blocked(result.error),true);assert.equal(disposed,1);assert.equal(pool.status().blocked,true);operation.resolve('late result');await tick();await assert.rejects(pool.use({identity:'a'},()=>{}),blocked);await assert.rejects(pool.close(),blocked);
});

test('a never-confirmed destroy is bounded and remains blocked even if cleanup later succeeds', {timeout:1500},async()=>{
 const createPool=factory(),cleanup=deferred();let disposed=0;
 const pool=createPool({create:()=>({}),validate:()=>true,destroy:()=>{disposed++;return cleanup.promise;},cleanupMs:20});
 await pool.use({identity:'a'},()=>1);await assert.rejects(pool.close(),blocked);assert.equal(disposed,1);assert.equal(pool.status().blocked,true);cleanup.resolve();await tick();await tick();assert.equal(pool.status().owned,0);assert.equal(pool.status().blocked,true);await assert.rejects(pool.use({identity:'b'},()=>{}),blocked);
});

test('pre-aborted requests do not create resources and rejected factories own their partial cleanup contract',async()=>{
 const createPool=factory(),controller=new AbortController();controller.abort();let creates=0,disposed=0;
 const pool=createPool({create:()=>{creates++;throw new Error('factory cleaned partial owner before rejection');},validate:()=>true,destroy:()=>{disposed++;}});
 await assert.rejects(pool.use({identity:'a',signal:controller.signal},()=>{}),error=>error.name==='AbortError');assert.equal(creates,0);await assert.rejects(pool.use({identity:'a'},()=>{}),/factory cleaned/);assert.equal(creates,1);assert.equal(disposed,0);assert.equal(pool.status().blocked,false);await pool.close();
});

test('a factory that reports uncertain partial cleanup blocks without assuming its unreturned resource was released',async()=>{
 const createPool=factory();let creates=0,disposals=0;
 const pool=createPool({create:()=>{creates++;const error=new Error('partial child cleanup unconfirmed');error.cleanupUncertain=true;throw error;},validate:()=>true,destroy:()=>{disposals++;}});
 await assert.rejects(pool.use({identity:'a'},()=>{}),blocked);assert.equal(pool.status().blocked,true);await assert.rejects(pool.use({identity:'b'},()=>{}),blocked);assert.equal(creates,1);assert.equal(disposals,0);await assert.rejects(pool.close(),blocked);
});

test('a successful prior request signal cannot later kill a retained runtime or the next borrower',async()=>{
 const createPool=factory(),controller=new AbortController();let createSignal,creates=0,disposals=0;
 const pool=createPool({create:({signal})=>{createSignal=signal;creates++;return {};},validate:()=>true,destroy:()=>{disposals++;}});
 await pool.use({identity:'same',signal:controller.signal},()=>1);controller.abort();await tick();assert.equal(createSignal.aborted,false);assert.equal(disposals,0);await pool.use({identity:'same'},()=>2);assert.equal(creates,1);await pool.close();assert.equal(disposals,1);
});

test('abort during post-operation health validation drains the validator and cannot return the earlier successful result',async()=>{
 const createPool=factory(),health=deferred(),entered=deferred(),controller=new AbortController();let checks=0,disposals=0,settled=false;
 const pool=createPool({create:()=>({}),validate:()=>{checks++;if(checks===2){entered.resolve();return health.promise;}return true;},destroy:()=>{disposals++;},cleanupMs:250});
 const use=observe(pool.use({identity:'a',signal:controller.signal},()=>7)).then(value=>{settled=true;return value;});await entered.promise;controller.abort();await tick();assert.equal(disposals,1);assert.equal(settled,false);health.resolve(true);const result=await use;assert.equal(result.ok,false);assert.equal(result.error.name,'AbortError');assert.equal(pool.status().blocked,false);await pool.close();
});

test('a failed identity-switch disposal cannot start its cold factory even when late cleanup later completes', {timeout:1500},async()=>{
 const createPool=factory(),cleanup=deferred();let creates=0;
 const pool=createPool({create:()=>({id:++creates}),validate:()=>true,destroy:()=>cleanup.promise,cleanupMs:20});await pool.use({identity:'a'},()=>1);await assert.rejects(pool.use({identity:'b'},()=>2),blocked);assert.equal(creates,1);cleanup.resolve();await tick();await tick();assert.equal(creates,1);assert.equal(pool.status().blocked,true);await assert.rejects(pool.close(),blocked);
});

test('one isolated Node child survives reuse and close confirms that exact child exited', {timeout:5000,skip:!process.env.MANGOHANA_LEASE_TEST_DIR&&'Set an E-drive MANGOHANA_LEASE_TEST_DIR to run the real child ownership check'},async t=>{
 const createPool=factory(),directory=path.resolve(process.env.MANGOHANA_LEASE_TEST_DIR,'child-'+process.pid+'-'+Date.now());await mkdir(directory,{recursive:true});let created=0,disposed=0,owned;
 const pool=createPool({create:async()=>{
  created++;const child=spawn(process.execPath,['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],{cwd:directory,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit'),ready=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});owned={child,exited};await ready;return owned;
 },validate:value=>value.child.exitCode===null&&value.child.signalCode===null&&!value.child.killed,destroy:async value=>{disposed++;value.child.kill();const [code,signal]=await value.exited;await writeFile(path.join(directory,'exit-proof.json'),JSON.stringify({pid:value.child.pid,code,signal,created,disposed}));},cleanupMs:1500});
 t.after(async()=>{try{await pool.close();}finally{if(owned&&owned.child.exitCode===null&&owned.child.signalCode===null){owned.child.kill();await owned.exited;}}});
 const first=await pool.use({identity:'isolated-node'},value=>value.child.pid),second=await pool.use({identity:'isolated-node'},value=>value.child.pid);assert.equal(first,second);assert.equal(created,1);assert.equal(disposed,0);await pool.close();assert.equal(disposed,1);assert.equal(pool.status().owned,0);assert.ok(owned.child.exitCode!==null||owned.child.signalCode!==null);await writeFile(path.join(directory,'verification.json'),JSON.stringify({scope:'ONE_ISOLATED_NODE_CHILD_ONLY',samePid:first===second,created,disposed,closed:pool.status().closed,aiCalls:0}));
});
