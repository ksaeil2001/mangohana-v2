import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {fixture} from './imported-page-fixture.mjs';
import {createEngineServer} from '../../apps/engine/server.mjs';import {once} from 'node:events';
let api={};try{api=await import('../../apps/engine/imported-page-controller.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const sha=x=>createHash('sha256').update(x).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=','base64');
async function setup(t,{http=false,tempRoot}={}){
 const f=await fixture(t,{http,tempRoot});assert.equal(typeof api.createImportedPageController,'function','missing one-page execution controller');
 const root=path.join(f.root,'permits'),outputRoot=path.join(f.root,'outputs');await fs.mkdir(outputRoot);
 let runs=0,checks=0,block=null,runner=null,publishFailure=false,monitor=null,inspectGate=null;
 const options={root,outputRoot,reviewStore:f.store,inspectInputs:async(binding,options)=>{if(inspectGate)await inspectGate(options);return f.inspect(binding);},
  preflight:async args=>{checks++;if(monitor)await monitor(args);if(block)throw Object.assign(Error(block),{code:block});return {status:'READY',fingerprint:sha('fixed-assets-profile-mask-font'),checks:{inputs:true,mask:true,font:true,lama:true,resources:true},blockers:[]};},
  runPipeline:async args=>{runs++;try{if(runner)return await runner(args);await args.revalidate('before-lama');await args.revalidate('before-typeset');return {pngBytes:png,report:{current:args.binding.current,sourceGeneration:2,executionGeneration:args.permit.executionGeneration,lines:args.inputs.lines},cleanupConfirmed:true};}catch(e){e.cleanupConfirmed??=true;throw e;}},
  verifyOutput:async bytes=>{assert.deepEqual(bytes,png);if(publishFailure)throw Error('simulated result readback failure');return {width:1,height:1,sha256:sha(bytes)};}};
 const controller=await api.createImportedPageController(options);t.after(()=>controller.close());
 const prepare=()=>controller.prepare(f.principal,f.document.documentId,f.expected);
 const approve=p=>controller.approve(f.principal,f.document.documentId,{permitId:p.permitId,proposalSha256:p.proposalSha256,executionAcknowledged:true});
 const start=p=>controller.start(f.principal,f.document.documentId,{permitId:p.permitId});
 return {...f,root,outputRoot,controller,options,prepare,approve,start,runs:()=>runs,checks:()=>checks,setBlock:v=>{block=v;},setRunner:v=>{runner=v;},setMonitor:v=>{monitor=v;},setInspectGate:v=>{inspectGate=v;},failPublish:()=>{publishFailure=true;}};
}
test('preflight never promotes thirteen translation approvals to image permission',async t=>{
 const f=await setup(t),before=await fs.readFile(f.file),p=await f.prepare();assert.equal(p.state,'AWAITING_APPROVAL');assert.equal(p.maximumExecutions,1);assert.notEqual(p.executionGeneration,2);assert.equal(f.runs(),0);
 await assert.rejects(f.start(p),{code:'IMAGE_EXECUTION_APPROVAL_REQUIRED'});assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readdir(f.outputRoot),[]);
});
test('approved page runs once; duplicate requests and lost completion response return durable receipt',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);await f.start(p);await f.controller.settle(p.permitId);
 const done=await f.controller.get(f.principal,f.document.documentId,p.permitId);assert.equal(done.state,'SUCCEEDED');assert.equal(f.runs(),1);assert.equal(done.result.sha256,sha(png));
 await f.start(p);assert.equal(f.runs(),1);assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'SUCCEEDED');
 assert.deepEqual(await fs.readFile(path.join(p.outputDirectory,'final.png')),png);assert.equal(done.result.sourceProcessingGeneration,2);assert.equal(done.result.executionGeneration,p.executionGeneration);
 assert.equal(done.result.userTranslations,13);assert.equal(done.result.semanticWarnings,4);
});
test('another session and another page cannot approve, run, cancel or query a permit',async t=>{
 const f=await setup(t),p=await f.prepare();for(const [o,d] of [[sha('other'),f.document.documentId],[f.principal,sha('other-page')]]){
  await assert.rejects(f.controller.approve(o,d,{permitId:p.permitId,proposalSha256:p.proposalSha256,executionAcknowledged:true}));
  await assert.rejects(f.controller.start(o,d,{permitId:p.permitId}));await assert.rejects(f.controller.cancel(o,d,p.permitId));await assert.rejects(f.controller.get(o,d,p.permitId));
 }assert.equal(f.runs(),0);
});
for(const kind of ['context','edit','source','normalized','regions','selection','approval','mask','font','ram','vram','write','profile'])test('rejects changed '+kind+' before any pipeline call',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);
 if(kind==='context')f.setContext(1);else if(kind==='edit')await f.mutate(d=>{d.editRevision++;},{resign:true});
 else if(['source','normalized'].includes(kind))await fs.writeFile(path.join(f.dir,kind+'.png'),'changed');
 else if(kind==='regions')f.data.regions.pop();else if(kind==='selection')f.data.regions[0].selectedUserTranslation='변조';
 else if(kind==='approval'){/* signed journal corruption below */}
 else f.setBlock('PREFLIGHT_'+kind.toUpperCase());
 if(kind==='approval'){/* covered by signed-event tests below; corrupt permit approval itself */const a=path.join(f.root,p.permitId,'approval.json');await fs.appendFile(a,'tamper');}
 await assert.rejects(f.start(p));assert.equal(f.runs(),0);
});
test('changed revision during LaMa revalidation stops before typesetting or publishing',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);f.setRunner(async a=>{f.setContext(1);await a.revalidate('during-lama');assert.fail('must stop');});
 await f.start(p);await f.controller.settle(p.permitId);assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'FAILED');await assert.rejects(fs.stat(path.join(p.outputDirectory,'final.png')),{code:'ENOENT'});
});
test('persistent cancellation interrupts active owned pipeline and prohibits replay',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);let entered;const started=new Promise(r=>{entered=r;});
 f.setRunner(async a=>{entered();await new Promise(r=>a.signal.addEventListener('abort',r,{once:true}));throw Object.assign(Error('cancelled'),{code:'CANCELLED',cleanupConfirmed:true});});
 await f.start(p);await started;await f.controller.cancel(f.principal,f.document.documentId,p.permitId);await f.controller.settle(p.permitId);
 assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'CANCELLED');await f.start(p);assert.equal(f.runs(),1);
});
test('cancellation before consumption never launches',async t=>{const f=await setup(t),p=await f.prepare();await f.approve(p);await f.controller.cancel(f.principal,f.document.documentId,p.permitId);await f.start(p);assert.equal(f.runs(),0);});
test('publication readback exception is RESULT_UNKNOWN and never retries or removes PNG',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);f.failPublish();await f.start(p);await f.controller.settle(p.permitId);
 assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'RESULT_UNKNOWN');assert.deepEqual(await fs.readFile(path.join(p.outputDirectory,'final.png')),png);await f.start(p);assert.equal(f.runs(),1);
});
test('consumption without outcome after process restart is unknown, including retry request',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);await f.start(p);await f.controller.settle(p.permitId);await fs.rename(path.join(f.root,p.permitId,'outcome.json'),path.join(f.root,p.permitId,'saved-outcome.json'));
 const restarted=await api.createImportedPageController(f.options);t.after(()=>restarted.close());assert.equal((await restarted.get(f.principal,f.document.documentId,p.permitId)).state,'RESULT_UNKNOWN');await restarted.start(f.principal,f.document.documentId,{permitId:p.permitId});assert.equal(f.runs(),1);
});
test('existing output directory or file is preserved and consumes permit without launch',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);await fs.mkdir(p.outputDirectory);await fs.writeFile(path.join(p.outputDirectory,'existing.png'),'preserved');await f.start(p);await f.controller.settle(p.permitId);assert.equal(f.runs(),0);assert.equal(await fs.readFile(path.join(p.outputDirectory,'existing.png'),'utf8'),'preserved');
});
test('approval binds proposal hash and requires separate explicit acknowledgement; browser authority fields rejected',async t=>{
 const f=await setup(t),p=await f.prepare();for(const cmd of [{permitId:p.permitId,proposalSha256:p.proposalSha256,executionAcknowledged:false},{permitId:p.permitId,proposalSha256:sha('wrong'),executionAcknowledged:true},{permitId:p.permitId,proposalSha256:p.proposalSha256,executionAcknowledged:true,owner:f.principal}])await assert.rejects(f.controller.approve(f.principal,f.document.documentId,cmd));assert.equal(f.runs(),0);
});
test('HTTP session/scope, exact command and separate approval are enforced; general jobs stay locked',async t=>{
 const f=await setup(t,{http:true}),origin='http://127.0.0.1:5173',server=createEngineServer({store:{imageExecutionAuthorized:false,health:async()=>({ready:true}),submit:async()=>assert.fail('general jobs'),get:async()=>null,getResult:async()=>null},reviewStore:f.store,imageController:f.controller,allowedOrigin:origin});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port,page='/translation-review-pages/'+f.document.documentId;
 const headers={origin,cookie:f.cookie,'Content-Type':'application/json','X-Mangohana-Review-Scope':f.store.scope(f.principal)},post=(suffix,body,h=headers)=>fetch(base+page+suffix,{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await post('/image-preflight',f.expected,{...headers,cookie:''})).status,403);assert.equal((await post('/image-preflight',{...f.expected,owner:f.principal})).status,422);
 const p=await (await post('/image-preflight',f.expected)).json();assert.equal(p.state,'AWAITING_APPROVAL');const uri='/image-permits/'+p.permitId;
 assert.equal((await post(uri+'/execute',{})).status,403);assert.equal((await post('/image-permits',{permitId:p.permitId,proposalSha256:p.proposalSha256,executionAcknowledged:true})).status,200);
 assert.equal((await post(uri+'/execute',{})).status,202);await f.controller.settle(p.permitId);assert.equal(f.runs(),1);assert.equal((await post(uri+'/execute',{})).status,202);assert.equal(f.runs(),1);
 const good=await fetch(base+page+uri,{headers});assert.equal((await good.json()).state,'SUCCEEDED');assert.equal((await fetch(base+page+uri,{headers:{...headers,'X-Mangohana-Review-Scope':sha('other')}})).status,409);
 assert.equal((await fetch(base+'/jobs',{method:'POST',headers})).status,423);
});
test('concurrent execute requests consume only once while approval duplicates retain one event',async t=>{
 const f=await setup(t),p=await f.prepare();await Promise.all([f.approve(p),f.approve(p)]);await Promise.all([f.start(p),f.start(p)]);await f.controller.settle(p.permitId);assert.equal(f.runs(),1);assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'SUCCEEDED');
});
test('a changed published PNG becomes unknown on status lookup and cannot run again',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);await f.start(p);await f.controller.settle(p.permitId);await fs.writeFile(path.join(p.outputDirectory,'final.png'),'tampered');assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'RESULT_UNKNOWN');assert.equal((await f.start(p)).state,'RESULT_UNKNOWN');assert.equal(f.runs(),1);
});
test('unconfirmed owned process cleanup retains a lock, reports unknown and prevents replay',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);f.setRunner(async()=>{throw Object.assign(Error('lost worker'),{code:'IMAGE_RUNTIME_UNKNOWN',cleanupConfirmed:false});});await f.start(p);await f.controller.settle(p.permitId);assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'RESULT_UNKNOWN');assert.ok((await fs.stat(path.join(f.outputRoot,'.image-execution-lock'))).isDirectory());await f.start(p);assert.equal(f.runs(),1);
});
test('cancellation accepted before completion commit cannot be reported as succeeded',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);let entered,resume;const reached=new Promise(r=>{entered=r;}),release=new Promise(r=>{resume=r;});
 f.setMonitor(async a=>{if(a.phase==='before-outcome'){entered();await release;}});await f.start(p);await reached;
 await f.controller.cancel(f.principal,f.document.documentId,p.permitId);resume();await f.controller.settle(p.permitId);const done=await f.controller.get(f.principal,f.document.documentId,p.permitId);assert.equal(done.state,'RESULT_UNKNOWN');assert.deepEqual(await fs.readFile(path.join(p.outputDirectory,'final.png')),png);await f.start(p);assert.equal(f.runs(),1);
});
test('expired approval is visibly unauthorized and refuses dispatch',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);const expired=await api.createImportedPageController({...f.options,clock:()=>p.expiresAt+1});t.after(()=>expired.close());assert.equal((await expired.get(f.principal,f.document.documentId,p.permitId)).executionAuthorized,false);await assert.rejects(expired.start(f.principal,f.document.documentId,{permitId:p.permitId}),{code:'IMAGE_PERMIT_EXPIRED'});assert.equal(f.runs(),0);
});
test('a substituted output junction cannot publish a PNG into the preserved source directory',async t=>{
 // The E: regression tmp volume cannot create Windows junctions. Use the user's OS tmp on C:.
 const tempRoot=process.platform==='win32'?path.join(os.homedir(),'AppData','Local','Temp'):os.tmpdir(),f=await setup(t,{tempRoot}),p=await f.prepare();let substituted=false;await f.approve(p);f.setRunner(async a=>{await fs.rename(a.outputDirectory,a.outputDirectory+'-preserved');await fs.symlink(f.dir,a.outputDirectory,'junction');substituted=true;return {pngBytes:png,report:{synthetic:true},cleanupConfirmed:true};});
 await f.start(p);await f.controller.settle(p.permitId);assert.equal(substituted,true,'must actually exercise a substituted junction');assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'RESULT_UNKNOWN');await assert.rejects(fs.stat(path.join(f.dir,'final.png')),{code:'ENOENT'});
});
test('cancelling the pre-consumption input inspection propagates its signal and never consumes or launches',async t=>{
 const f=await setup(t),p=await f.prepare();await f.approve(p);let entered;const reached=new Promise(r=>{entered=r;});
 f.setInspectGate(async({signal})=>{assert.ok(signal instanceof AbortSignal);entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();});
 const starting=f.start(p);const rejected=assert.rejects(starting,{name:'AbortError'});await reached;await f.controller.cancel(f.principal,f.document.documentId,p.permitId);await rejected;await f.controller.settle(p.permitId);
 assert.equal(f.runs(),0);assert.equal((await f.controller.get(f.principal,f.document.documentId,p.permitId)).state,'CANCELLED');await assert.rejects(fs.stat(path.join(f.root,p.permitId,'consumed.json')),{code:'ENOENT'});
});
