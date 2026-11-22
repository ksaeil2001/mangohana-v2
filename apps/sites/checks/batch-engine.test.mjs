import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
const directory=new URL('../.sites-runtime/batch-engine-checks/',import.meta.url);await mkdir(directory,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-engine','studio-batch-engine','studio-state']){
 try{const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');await writeFile(new URL(name+'.mjs',directory),stripTypeScriptTypes(source).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));}catch(error){if(error.code!=='ENOENT')throw error;}
}
const model=await import(new URL('studio-model.mjs',directory)),state=await import(new URL('studio-state.mjs',directory)),engine=await import(new URL('studio-engine.mjs',directory));
let batch={};try{batch=await import(new URL('studio-batch-engine.mjs',directory));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const required=()=>assert.equal(typeof batch.processProjectBatch,'function');
const originalFetch=globalThis.fetch,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const jobId=index=>'00000000-0000-4000-8000-'+String(index+1).padStart(12,'0');
function project(count=10){const p=model.emptyProject('배치 합성 원고');p.id='book-one';p.pages=Array.from({length:count},(_,i)=>({id:'page-'+(i+1),name:String(i+1).padStart(3,'0')+'.png',image:'data:image/png;base64,'+Buffer.from([i+1]).toString('base64'),width:20,height:20,blocks:[model.makeBlock({id:'old-'+i,text:'이전 수동값 '+i})],status:'ready',reviewed:false,engineGeneration:0}));return p;}
async function batchResponse(form,p,offset=0){
 const manifest=JSON.parse(form.get('manifest')),files=form.getAll('files');
 return {id:'11111111-1111-4111-8111-111111111111',projectId:p.id,sourceLanguage:'ja',status:'queued',totalPages:manifest.length,pages:await Promise.all(manifest.map(async(member,i)=>({key:member.key,name:files[i].name,pageId:member.page_id,pageNumber:member.page_number??offset+i+1,jobId:jobId(offset+i),sourceSha256:sha(Buffer.from(await files[i].arrayBuffer())),status:'queued',job:{id:jobId(offset+i),pageId:member.page_id,projectId:p.id,pageNumber:member.page_number??offset+i+1,status:'queued',stage:'queued'}})))};
}
function completed(binding,p){return {id:binding.jobId,projectId:p.id,pageId:binding.pageId,pageNumber:binding.pageNumber,status:'completed',stage:'completed',result:{blocks:[model.makeBlock({id:binding.pageId+'-new',source:'原文',text:'실제 AI 증거가 아닌 합성 응답'})]}};}
function batchCompletedView(receipt){return {...receipt,status:'completed',pages:receipt.pages.map(page=>({...page,status:'completed',job:{...page.job,status:'completed',stage:'completed'}}))};}
const jobResult=url=>/\/jobs\/([^/]+)\/result$/.exec(String(url))?.[1];
const callbacks=overrides=>({onIntent:async()=>{},onJobs:async()=>{},onResult:()=>{},onError:()=>{},onStage:()=>{},...overrides});
const options=current=>({currentPageId:()=>current,concurrency:3,pollIntervalMs:0});

test('a partial batch receipt preserves both bindings, applies its completed page and pauses only the unknown page',async()=>{
 const p=project(2),results=[],errors=[],bindings=[],posts=[];let receipt;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(init.method==='POST'){
   posts.push(String(url));
   receipt=await batchResponse(init.body,p);receipt.status='partial';
   for(const [i,status] of ['completed','result_unknown'].entries()){receipt.pages[i].status=status;receipt.pages[i].job.status=status;}
   return Response.json(receipt);
  }
  if(String(url).endsWith('/batches/'+receipt.id))return Response.json(receipt);
  const id=jobResult(url);
  if(id){const entry=receipt.pages.find(item=>item.jobId===id);assert.ok(entry);return Response.json(completed(entry,p).result);}
  const entry=receipt.pages.find(item=>String(url).endsWith(item.jobId));assert.ok(entry);
  return Response.json(entry.status==='completed'?completed(entry,p):{...entry.job,stage:'result_unknown'});
 };
 try{
  const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,
   callbacks({onJobs:items=>bindings.push(...items),onResult:id=>results.push(id),onError:(id,error,terminal,retryable)=>errors.push([id,error,terminal,retryable])}),options('page-1'));
  assert.deepEqual(summary,{completed:1,failed:0,paused:1});assert.deepEqual(results,['page-1']);
  assert.equal(bindings.length,2);assert.deepEqual(posts,['/api/engine/batches']);
  assert.equal(errors.length,1);assert.equal(errors[0][0],'page-2');assert.ok(errors[0][1] instanceof batch.BatchPendingError);
  assert.match(errors[0][1].message,/미확정/);assert.deepEqual(errors[0].slice(2),[false,false]);
 }finally{globalThis.fetch=originalFetch;}
});

test('ten pages use one durable multipart submission then batch status and bounded result fetching',async()=>{
 required();const p=project(),calls=[],results=[],intents=[];let response,durable=false,active=0,maximum=0;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  calls.push([String(url),init.method||'GET']);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches')){assert.equal(intents.at(-1).phase,'sending');response=await batchResponse(init.body,p);return Response.json(response);}
  if(String(url).endsWith('/batches/'+response.id)){assert.equal(durable,true);return Response.json(batchCompletedView(response));}
  const id=jobResult(url);
  if(id){assert.equal(durable,true);active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,3));active--;return Response.json(completed(response.pages.find(value=>value.jobId===id),p).result);}
  throw new Error('unexpected '+url);
 };
 try{const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:async intent=>intents.push(intent),onJobs:async bindings=>{assert.equal(bindings.length,10);await Promise.resolve();durable=true;},onResult:(id,result)=>results.push([id,result])}),options('page-6'));
  assert.equal(calls.filter(([url,method])=>url.endsWith('/batches')&&method==='POST').length,1);assert.equal(calls.filter(([url,method])=>url.endsWith('/batches/'+response.id)&&method==='GET').length,1);assert.equal(results.length,10);assert.equal(summary.completed,10);assert.equal(maximum,3);
  assert.deepEqual(calls.filter(([url])=>url.endsWith('/result')).slice(0,3).map(([url])=>url.split('/').at(-2)),[jobId(5),jobId(6),jobId(7)]);
  assert.deepEqual(intents.map(intent=>intent.phase),['prepared','sending']);
 }finally{globalThis.fetch=originalFetch;}
});
test('bulk targets skip actual processed pages while legacy reviewed flags and explicit current remain compatible',()=>{
 const p=project(3);p.pages[0].processed=true;p.pages[1].reviewed=true;
 assert.deepEqual(state.getRunTargets(p,'all').map(page=>page.id),['page-2','page-3']);assert.deepEqual(state.getRunTargets(p,'current','page-1').map(page=>page.id),['page-1']);
 p.pages[0].jobId=jobId(0);p.pages[0].jobEndpoint='/api/engine';p.pages[0].status='paused';assert.deepEqual(state.getRunTargets(p,'all').map(page=>page.id),['page-1','page-2','page-3']);
});
test('batch routing restores saved local jobs without resubmission while current fresh and legacy jobs retain single-page behavior',()=>{
 assert.equal(typeof batch.getBatchRunTargets,'function');const p=project(4);p.pages[0]={...p.pages[0],jobId:jobId(0),jobEndpoint:'/api/engine'};p.pages[1]={...p.pages[1],jobId:jobId(1),jobEndpoint:'https://legacy.example/engine'};
 assert.deepEqual(batch.getBatchRunTargets(p.pages,'all','/api/engine').map(page=>page.id),['page-1','page-3','page-4']);
 assert.deepEqual(batch.getBatchRunTargets([p.pages[0]],'current','').map(page=>page.id),['page-1']);
 assert.deepEqual(batch.getBatchRunTargets([p.pages[2]],'current','/api/engine'),[]);
 assert.deepEqual(batch.getBatchRunTargets([p.pages[1]],'all','/api/engine'),[]);
});
test('restoring known jobs polls current and next pages with bounded concurrency and no batch, source, or health POST',async()=>{
 required();const p=project(10),calls=[];p.pages=p.pages.map((page,i)=>({...page,jobId:jobId(i),jobEndpoint:'/api/engine',status:'paused',enginePageNumber:i+10}));let active=0,maximum=0;
 globalThis.fetch=async(url,init={})=>{assert.equal(init.method,undefined);assert.match(String(url),/\/jobs\//);calls.push(String(url).split('/').at(-1));active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));active--;const page=p.pages.find(page=>String(url).endsWith(page.jobId));return Response.json(completed({pageId:page.id,jobId:page.jobId,pageNumber:page.enginePageNumber},p));};
 try{const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-7'));assert.equal(summary.completed,10);assert.equal(maximum,3);assert.deepEqual(calls.slice(0,3),[jobId(6),jobId(7),jobId(8)]);}finally{globalThis.fetch=originalFetch;}
});
test('a reader page change reprioritizes the next free polling slot without moving the reader',async()=>{
 required();const p=project(8);p.pages=p.pages.map((page,i)=>({...page,jobId:jobId(i),jobEndpoint:'/api/engine',status:'paused'}));let current='page-1';const calls=[];
 globalThis.fetch=async(url)=>{const page=p.pages.find(page=>String(url).endsWith(page.jobId));calls.push(page.id);if(page.id==='page-1')current='page-6';return Response.json(completed({pageId:page.id,jobId:page.jobId},p));};
 try{await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),{currentPageId:()=>current,concurrency:1,pollIntervalMs:0});assert.deepEqual(calls.slice(0,4),['page-1','page-6','page-7','page-8']);assert.equal(current,'page-6');}finally{globalThis.fetch=originalFetch;}
});
test('unknown server order is omitted and established absolute page numbers and cursor-independent keys survive gaps',async()=>{
 required();const p=project(3);p.pages[0].enginePageNumber=7;p.pages[2].enginePageNumber=19;const keys=[],manifests=[];
 globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});assert.ok(String(url).endsWith('/batches'));keys.push(init.body.get('idempotency_key'));manifests.push(JSON.parse(init.body.get('manifest')));throw new TypeError('synthetic lost response');};
 try{for(const current of ['page-1','page-3'])await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),options(current));assert.equal(keys[0],keys[1]);assert.deepEqual(manifests[0].map(member=>member.page_number),[7,undefined,19]);assert.equal(Object.hasOwn(manifests[0][1],'page_number'),false);}finally{globalThis.fetch=originalFetch;}
});
test('stop during accepted POST still binds every job before pausing and never starts polling',async()=>{
 required();const p=project(),controller=new AbortController();let bindings=[],posts=0,gets=0;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches')){posts++;const body=await batchResponse(init.body,p);controller.abort();return Response.json(body);}
  gets++;throw new Error('must not poll after stop');
 };
 try{await assert.rejects(batch.processProjectBatch(p,p.pages,'','ja','ko',controller.signal,callbacks({onJobs:async value=>{bindings=value;}}),options('page-1')),error=>error.name==='AbortError');assert.equal(posts,1);assert.equal(bindings.length,10);assert.equal(gets,0);}finally{globalThis.fetch=originalFetch;}
});
test('abort drains every in-flight retry receipt before settling so a late child cannot reopen processing',async()=>{
 required();const baseline=project(2);baseline.pages=baseline.pages.map((page,i)=>({...page,jobId:jobId(i),jobEndpoint:'/api/engine',status:'failed'}));let current=baseline,releaseSlow,started,settled=false,postCount=0;const saved=[];
 const bothStarted=new Promise(resolve=>started=resolve),slow=new Promise(resolve=>releaseSlow=resolve),controller=new AbortController(),requestId='concurrent-retry';
 current={...current,pages:current.pages.map(page=>state.transitionPage(page,{type:'start',requestId}))};
 globalThis.fetch=async(url,init={})=>{
  const text=String(url),index=text.includes(jobId(0))?0:1;
  if(text.endsWith('/retry')){postCount++;if(postCount===2)started();if(index===0)await slow;return Response.json({id:jobId(index+20),pageId:baseline.pages[index].id,projectId:baseline.id,pageNumber:index+1,status:'queued',stage:'queued'});}
  if(text.endsWith('/'+jobId(0))||text.endsWith('/'+jobId(1)))return Response.json({id:jobId(index),pageId:baseline.pages[index].id,projectId:baseline.id,pageNumber:index+1,status:'failed',stage:'failed'});
  return new Promise((resolve,reject)=>{if(init.signal.aborted)reject(init.signal.reason);else init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
 };
 const run=batch.processProjectBatch(baseline,baseline.pages,'','ja','ko',controller.signal,callbacks({onJobs:bindings=>{saved.push(...bindings);current=state.bindProjectBatch(current,baseline.pages,requestId,{bindings,pollPageIds:baseline.pages.map(page=>page.id)});}}),options('page-1')).finally(()=>{settled=true;current={...current,pages:current.pages.map(page=>state.transitionPage(page,{type:'pause',requestId}))};});
 const observed=run.catch(error=>error);
 try{await bothStarted;controller.abort();await new Promise(resolve=>setTimeout(resolve,0));const returnedBeforeDrain=settled;releaseSlow();const error=await observed;assert.equal(error.name,'AbortError');assert.equal(returnedBeforeDrain,false);assert.equal(saved.length,2);assert.deepEqual(current.pages.map(page=>page.status),['paused','paused']);assert.ok(current.pages.every(page=>!page.requestId));assert.deepEqual(current.pages.map(page=>page.jobId),[jobId(20),jobId(21)]);}finally{releaseSlow();await observed;globalThis.fetch=originalFetch;}
});
test('a failed durable receipt prevents another delayed failed GET from creating a new retry POST',async()=>{
 required();const p=project(2);p.pages=p.pages.map((page,i)=>({...page,jobId:jobId(i),jobEndpoint:'/api/engine',status:'failed'}));let releaseSecond,failedStorage,posts=0;
 const secondGate=new Promise(resolve=>releaseSecond=resolve),storageFailure=new Promise(resolve=>failedStorage=resolve);
 globalThis.fetch=async(url,init={})=>{const index=String(url).includes(jobId(0))?0:1;if(String(url).endsWith('/retry')){posts++;return Response.json({id:jobId(index+20),pageId:p.pages[index].id,projectId:p.id,pageNumber:index+1,status:'queued',stage:'queued'});}if(index===1)await secondGate;return Response.json({id:jobId(index),pageId:p.pages[index].id,projectId:p.id,pageNumber:index+1,status:'failed',stage:'failed'});};
 const observed=batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onJobs:()=>{failedStorage();throw new Error('IndexedDB unavailable');}}),options('page-1')).catch(error=>error);
 try{await storageFailure;await new Promise(resolve=>setTimeout(resolve,0));releaseSecond();const error=await observed;assert.match(error.message,/저장/);assert.equal(posts,1);}finally{releaseSecond();await observed;globalThis.fetch=originalFetch;}
});
test('a fresh batch omits an already-completed or saved current page that is outside its manifest',async()=>{
 required();for(const selected of ['page-1','page-2']){const p=project(3);p.pages[0].processed=true;p.pages[1]={...p.pages[1],jobId:jobId(0),jobEndpoint:'/api/engine',status:'paused'};let receipt,currentHint;
  globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});if(String(url).endsWith('/batches')){currentHint=init.body.get('current_page_id');receipt=await batchResponse(init.body,p,2);if(currentHint&&!receipt.pages.some(page=>page.pageId===currentHint))return Response.json({error:'current page must belong to manifest'},{status:422});return Response.json(receipt);}if(String(url).endsWith('/batches/'+receipt?.id))return Response.json(batchCompletedView(receipt));const id=jobResult(url);if(id)return Response.json(completed(receipt.pages.find(page=>page.jobId===id),p).result);const binding=String(url).endsWith(jobId(0))?{pageId:'page-2',jobId:jobId(0),pageNumber:1}:receipt.pages.find(page=>String(url).endsWith(page.jobId));return Response.json(completed(binding,p));};
  try{const summary=await batch.processProjectBatch(p,state.getRunTargets(p,'all'),'','ja','ko',new AbortController().signal,callbacks(),options(selected));assert.equal(summary.completed,2);assert.equal(summary.paused,0);assert.equal(currentHint,null);}finally{globalThis.fetch=originalFetch;}
 }
});
test('lost batch response restores original membership by key without any file reupload',async()=>{
 required();let p=project(),intent,response,postCount=0,resolveCount=0;const first=new AbortController();
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches')){postCount++;response=await batchResponse(init.body,p);throw new TypeError('lost response after commit');}
  throw new Error('unexpected');
 };
 try{
  await batch.processProjectBatch(p,p.pages,'','ja','ko',first.signal,callbacks({onIntent:value=>{intent=value;}}),options('page-1'));
  assert.equal(intent.phase,'sending');p={...p,pages:p.pages.map(page=>({...page,pendingBatch:intent,status:'failed'}))};p=model.restoreProject(p);
  globalThis.fetch=async(url,init={})=>{
   if(String(url).startsWith('data:'))throw new Error('must not read originals for resolve');
   if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
   if(String(url).endsWith('/batches/resolve')){resolveCount++;assert.deepEqual(JSON.parse(init.body),{project_id:p.id,idempotency_key:intent.key});return Response.json(response);}
   if(String(url).endsWith('/batches/'+response.id))return Response.json(batchCompletedView(response));
   const id=jobResult(url);if(id)return Response.json(completed(response.pages.find(value=>value.jobId===id),p).result);
   throw new Error('must not reupload');
  };
  const result=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-7'));assert.equal(result.completed,10);assert.equal(postCount,1);assert.equal(resolveCount,1);
 }finally{globalThis.fetch=originalFetch;}
});
test('pages added after an unknown response get a separate key while the original group resolves without reupload',async()=>{
 required();let p=project(2),intent,original;const posted=[];let resolved=0;
 globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});original=await batchResponse(init.body,p);throw new TypeError('unknown response');};
 try{await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:value=>intent=value}),options('page-1'));p={...p,pages:[...p.pages.map(page=>({...page,pendingBatch:intent,status:'paused'})),project(3).pages[2]]};
  const receipts=[original];globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:')){assert.equal(String(url),p.pages[2].image);return originalFetch(url,init);}if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});if(String(url).endsWith('/batches/resolve')){resolved++;assert.equal(JSON.parse(init.body).idempotency_key,intent.key);return Response.json(original);}if(String(url).endsWith('/batches')){posted.push({key:init.body.get('idempotency_key'),members:JSON.parse(init.body.get('manifest'))});const receipt={...await batchResponse(init.body,p,2),id:'22222222-2222-4222-8222-222222222222'};receipts.push(receipt);return Response.json(receipt);}const batchHit=receipts.find(r=>String(url).endsWith('/batches/'+r.id));if(batchHit)return Response.json(batchCompletedView(batchHit));const id=jobResult(url);if(id)return Response.json(completed(receipts.flatMap(r=>r.pages).find(page=>page.jobId===id),p).result);throw new Error('unexpected '+url);};
  const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-3'));assert.equal(summary.completed,3);assert.equal(resolved,1);assert.equal(posted.length,1);assert.notEqual(posted[0].key,intent.key);assert.deepEqual(posted[0].members.map(member=>member.page_id),['page-3']);
 }finally{globalThis.fetch=originalFetch;}
});
test('resolving an old receipt cannot reattach a member that continued editing in a new generation',async()=>{
 required();for(const scope of ['current','all']){let p=project(2),intent,oldReceipt,newReceipt;const gets=[];
  globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});oldReceipt=await batchResponse(init.body,p);throw new TypeError('unknown accepted response');};
  try{await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:value=>intent=value}),options('page-2'));p={...p,pages:p.pages.map(page=>({...page,pendingBatch:intent,status:'paused'}))};p.pages[0]={...state.transitionPage(p.pages[0],{type:'continue-editing'}),engineGeneration:1,processed:false,blocks:[{...p.pages[0].blocks[0],text:'분리 후 새 수동 대사'}]};const baseline=p.pages,requestId='resolve-after-manual';let live=p;
   globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});if(String(url).endsWith('/batches/resolve'))return Response.json(oldReceipt);if(String(url).endsWith('/batches')){newReceipt={...await batchResponse(init.body,p,20),id:'22222222-2222-4222-8222-222222222222'};Object.assign(newReceipt.pages[0],{jobId:oldReceipt.pages[0].jobId,pageNumber:1});Object.assign(newReceipt.pages[0].job,{id:oldReceipt.pages[0].jobId,pageNumber:1});return Response.json(newReceipt);}const batchHit=[oldReceipt,newReceipt].filter(Boolean).find(r=>String(url).endsWith('/batches/'+r.id));if(batchHit)return Response.json(batchCompletedView(batchHit));const id=jobResult(url);if(id){const binding=[...oldReceipt.pages,...(newReceipt?.pages||[])].find(page=>page.jobId===id);gets.push(binding.jobId);return Response.json(completed(binding,p).result);}throw new Error('unexpected '+url);};
   const result=await batch.processProjectBatch(p,scope==='current'?[p.pages[1]]:p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:value=>{live=state.bindProjectBatch(live,baseline,requestId,{intent:value,pollPageIds:scope==='current'?['page-2']:['page-1','page-2']});},onJobs:bindings=>{for(const binding of bindings)if(binding.pageId==='page-1'){assert.notEqual(binding.batchKey,intent.key);assert.equal(binding.generation,1);}live=state.bindProjectBatch(live,baseline,requestId,{bindings,pollPageIds:scope==='current'?['page-2']:['page-1','page-2']});},onResult:(id,result)=>{live={...live,pages:live.pages.map(page=>page.id===id?state.transitionPage(page,{type:'result',requestId,result}):page)};}}),options('page-2'));
   assert.equal(result.completed,scope==='current'?1:2);if(scope==='current'){assert.ok(!gets.includes(oldReceipt.pages[0].jobId));assert.equal(live.pages[0].jobId,undefined);assert.equal(live.pages[0].blocks[0].text,'분리 후 새 수동 대사');assert.equal(live.pages[0].engineGeneration,1);assert.equal(state.canEditPage(live.pages[0]),true);}else{assert.ok(newReceipt);assert.equal(newReceipt.pages[0].jobId,oldReceipt.pages[0].jobId);assert.ok(gets.includes(newReceipt.pages[0].jobId));}
  }finally{globalThis.fetch=originalFetch;}
 }
});
test('a prepared group with removed or changed source members stays unknown and cannot create a replacement submission',async()=>{
 required();const p=project(2);let intent;const controller=new AbortController();
 globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});throw new Error('POST forbidden');};
 try{await assert.rejects(batch.processProjectBatch(p,p.pages,'','ja','ko',controller.signal,callbacks({onIntent:value=>{intent=value;if(value.phase==='sending')controller.abort();}}),options('page-1')),error=>error.name==='AbortError');assert.equal(intent.phase,'prepared');
  for(const changed of [{...p,pages:[p.pages[0]]},{...p,pages:p.pages.map((page,i)=>i?{...page,image:p.pages[0].image}:page)}]){changed.pages=changed.pages.map(page=>({...page,pendingBatch:intent,status:'paused'}));let submitted=0;globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);submitted++;throw new Error('no server submission');};const summary=await batch.processProjectBatch(changed,changed.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-1'));assert.equal(summary.paused,changed.pages.length);assert.equal(submitted,0);}
 }finally{globalThis.fetch=originalFetch;}
});
test('malformed page or job mapping is rejected before any ID or result is applied',async()=>{
 required();for(const corrupt of [value=>value.pages.pop(),value=>{value.pages[1].jobId=value.pages[0].jobId;},value=>{value.pages[1].pageId='wrong-page';},value=>{value.pages[0].sourceSha256='0'.repeat(64);}]){
  const p=project(3);let applied=0;
  globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});const response=await batchResponse(init.body,p);corrupt(response);return Response.json(response);};
  try{await assert.rejects(batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onJobs:()=>applied++,onResult:()=>applied++}),options('page-1')),/연결|대응|배치|식별/);assert.equal(applied,0);}finally{globalThis.fetch=originalFetch;}
 }
});
test('unconfirmed resolver status never becomes a fresh AI submission or clears old manual data',async()=>{
 required();const p=project(2);let intent;
 globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});throw new TypeError('before response');};
 try{await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:value=>{intent=value;}}),options('page-1'));
  const copy={...p,pages:p.pages.map(page=>({...page,pendingBatch:intent,status:'failed'}))},snapshot=JSON.stringify(copy);let uploads=0;
  globalThis.fetch=async(url,init={})=>{if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});if(String(url).endsWith('/batches/resolve'))return Response.json({code:'BATCH_UNKNOWN',error:'아직 확인되지 않음'},{status:404});uploads++;throw new Error('forbidden');};
  const summary=await batch.processProjectBatch(copy,copy.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-2'));assert.equal(summary.paused,2);assert.equal(summary.failed,0);assert.equal(uploads,0);assert.equal(JSON.stringify(copy),snapshot);
 }finally{globalThis.fetch=originalFetch;}
});
test('binding a whole receipt is atomic and keeps prior dialogue and reading state intact',()=>{
 assert.equal(typeof state.bindProjectBatch,'function');const p=project(3),before=JSON.stringify(p),requestId='operation-one';
 const bindings=p.pages.map((page,i)=>({pageId:page.id,jobId:jobId(i),pageNumber:i+1}));
 const bound=state.bindProjectBatch(p,p.pages,requestId,{bindings,pollPageIds:[p.pages[0].id]});
 assert.equal(JSON.stringify(p),before);assert.deepEqual(bound.pages.map(page=>page.jobId),bindings.map(binding=>binding.jobId));
 assert.equal(bound.pages[0].requestId,requestId);assert.equal(bound.pages[1].status,'paused');assert.equal(bound.pages[2].status,'paused');
 assert.equal(bound.pages[0].blocks,p.pages[0].blocks);
 const stale={...p,pages:p.pages.map((page,i)=>i===1?{...page,blocks:[{...page.blocks[0],text:'나중 사용자 수정'}]}:page)};
 assert.throws(()=>state.bindProjectBatch(stale,p.pages,requestId,{bindings,pollPageIds:p.pages.map(page=>page.id)}),/변경|이전|수정/);
 assert.equal(stale.pages[0].jobId,undefined);assert.equal(stale.pages[1].blocks[0].text,'나중 사용자 수정');
});
test('receipt provenance skips a detached manual non-poll member even when the new run baseline already includes its edits',()=>{
 const p=project(2),members=p.pages.map((page,i)=>({pageId:page.id,generation:0,name:page.name,sourceSha256:sha(Buffer.from([i+1]))})),intent={key:'a'.repeat(64),projectId:p.id,source:'ja',target:'ko',phase:'sending',members};
 p.pages=p.pages.map(page=>({...page,pendingBatch:intent,status:'paused'}));p.pages[0]={...state.transitionPage(p.pages[0],{type:'continue-editing'}),engineGeneration:1,blocks:[{...p.pages[0].blocks[0],text:'분리한 수동 대사'}]};
 const bindings=p.pages.map((page,i)=>({pageId:page.id,jobId:jobId(i),pageNumber:i+1,batchKey:intent.key,generation:0,sourceSha256:members[i].sourceSha256}));
 const bound=state.bindProjectBatch(p,p.pages,'new-request',{bindings,pollPageIds:['page-2']});assert.equal(bound.pages[0],p.pages[0]);assert.equal(bound.pages[0].jobId,undefined);assert.equal(bound.pages[0].blocks[0].text,'분리한 수동 대사');assert.equal(bound.pages[1].jobId,jobId(1));
});
test('a failed job retries only on a later explicit action and an unknown retry response reuses its key',async()=>{
 required();const p=project(1),old=jobId(0),child=jobId(20);p.pages[0]={...p.pages[0],status:'failed',jobId:old,jobEndpoint:'/api/engine',enginePageNumber:1};
 const keys=[],saved=[];let lose=true;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).endsWith('/retry')){keys.push(JSON.parse(init.body).idempotency_key);if(lose){lose=false;throw new TypeError('accepted retry response lost');}return Response.json({id:child,pageId:p.pages[0].id,projectId:p.id,pageNumber:1,status:'queued',stage:'queued'});}
  if(String(url).endsWith('/'+old))return Response.json({id:old,pageId:p.pages[0].id,projectId:p.id,pageNumber:1,status:'failed',stage:'failed'});
  if(String(url).endsWith('/'+child)){assert.equal(saved.at(-1).jobId,child);return Response.json({id:child,pageId:p.pages[0].id,projectId:p.id,pageNumber:1,status:'failed',stage:'failed'});}
  throw new Error('unexpected '+url);
 };
 try{const first=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onJobs:bindings=>saved.push(...bindings)}),options('page-1'));assert.equal(first.paused,1);assert.equal(saved.length,0);
  const second=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onJobs:bindings=>saved.push(...bindings)}),options('page-1'));assert.equal(second.failed,1);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(saved.length,1);
 }finally{globalThis.fetch=originalFetch;}
});
test('a retry commit remains unknown and a restored paused parent reuses the same retry key on the next explicit action',async()=>{
 required();const p=project(1);p.pages[0]={...p.pages[0],jobId:jobId(0),jobEndpoint:'/api/engine',status:'failed'};const keys=[];let saved=0;
 globalThis.fetch=async(url,init={})=>{if(String(url).endsWith('/retry')){keys.push(JSON.parse(init.body).idempotency_key);return Response.json({code:'RETRY_COMMIT_UNKNOWN',error:'재시도 접수 저장 확인 필요'},{status:503});}return Response.json({id:jobId(0),pageId:p.pages[0].id,projectId:p.id,pageNumber:null,status:'failed',stage:'failed'});};
 try{const first=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onJobs:()=>saved++}),options('page-1'));assert.equal(first.paused,1);assert.equal(first.failed,0);p.pages[0].status='paused';const second=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onJobs:()=>saved++}),options('page-1'));assert.equal(second.paused,1);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(saved,0);assert.equal(p.pages[0].jobId,jobId(0));}finally{globalThis.fetch=originalFetch;}
});
test('a preserved retry-acceptance-unknown child pauses immediately without becoming failed or issuing a replacement POST',async()=>{
 required();const p=project(1);p.pages[0]={...p.pages[0],jobId:jobId(20),jobEndpoint:'/api/engine',status:'paused'};const controller=new AbortController();let gets=0,errors=[];
 globalThis.fetch=async(url,init={})=>{assert.equal(init.method,undefined);assert.equal(String(url),'/api/engine/jobs/'+jobId(20));gets++;if(gets>2)controller.abort();return Response.json({id:jobId(20),projectId:p.id,pageId:p.pages[0].id,pageNumber:null,status:'queued',stage:'retry_acceptance_unknown',errorCode:'RETRY_COMMIT_UNKNOWN'});};
 try{const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',controller.signal,callbacks({onError:(id,error,terminal)=>errors.push({id,error,terminal})}),options('page-1'));assert.equal(summary.paused,1);assert.equal(summary.failed,0);assert.equal(gets,1);assert.equal(errors[0].terminal,false);assert.equal(errors[0].error instanceof batch.BatchPendingError,true);assert.equal(p.pages[0].jobId,jobId(20));}finally{globalThis.fetch=originalFetch;}
});
test('durable receipt failure stops before polling and prepared storage failure stops before submission',async()=>{
 required();for(const fail of ['prepared','receipt']){const p=project(2);let posts=0,gets=0;
  globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});if(String(url).endsWith('/batches')){posts++;return Response.json(await batchResponse(init.body,p));}gets++;throw new Error('must not poll');};
  try{await assert.rejects(batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:intent=>{if(fail==='prepared'&&intent.phase==='prepared')throw new Error('IndexedDB failure');},onJobs:()=>{throw new Error('IndexedDB failure');}}),options('page-1')),/저장/);assert.equal(posts,fail==='prepared'?0:1);assert.equal(gets,0);}finally{globalThis.fetch=originalFetch;}
 }
});
test('stopping before POST restores a prepared intent rather than creating an unknown submitted request',async()=>{
 required();const p=project(2),controller=new AbortController();let finalIntent,uploads=0;
 globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});uploads++;throw new Error('POST forbidden');};
 try{await assert.rejects(batch.processProjectBatch(p,p.pages,'','ja','ko',controller.signal,callbacks({onIntent:intent=>{finalIntent=intent;if(intent.phase==='sending')controller.abort();}}),options('page-1')),error=>error.name==='AbortError');assert.equal(uploads,0);assert.equal(finalIntent.phase,'prepared');}finally{globalThis.fetch=originalFetch;}
});
test('pending metadata survives local restore but imported backups cannot inherit remote batch ownership',async()=>{
 required();const p=project(2);let intent;
 globalThis.fetch=async(url,init={})=>{if(String(url).startsWith('data:'))return originalFetch(url,init);if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});throw new TypeError('unknown acceptance');};
 try{await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:value=>intent=value}),options('page-1'));}finally{globalThis.fetch=originalFetch;}
 const pendingProject={...p,pages:p.pages.map(page=>({...page,status:'processing',pendingBatch:intent}))};
 const restored=model.restoreProject(pendingProject);assert.equal(restored.pages[0].pendingBatch.key,intent.key);assert.equal(restored.pages[0].status,'paused');assert.equal(state.canEditPage(restored.pages[0]),false);
 const imported=model.validateProject(pendingProject);assert.equal(imported.pages[0].pendingBatch,undefined);assert.equal(imported.pages[0].jobId,undefined);
 const corrupt=structuredClone(pendingProject);corrupt.pages[0].pendingBatch.members.push({...corrupt.pages[0].pendingBatch.members[0]});assert.throws(()=>model.restoreProject(corrupt),/배치/);
});

test('BATCH_UPLOAD_BUSY 429 reverts intent to prepared so resume resubmits once with the same key',async()=>{
 required();let p=project(3);const intents=[],posts=[];let resolves=0,response;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches/resolve')){resolves++;throw new Error('must not resolve pre-admission busy rejection');}
  if(String(url).endsWith('/batches')){
   posts.push(init.body.get('idempotency_key'));
   if(posts.length===1)return Response.json({code:'BATCH_UPLOAD_BUSY',error:'다른 배치 업로드를 저장하고 있습니다. 잠시 후 다시 시도해 주세요.'},{status:429});
   response=await batchResponse(init.body,p);return Response.json(response,{status:202});
  }
  if(String(url).endsWith('/batches/'+response.id))return Response.json(batchCompletedView(response));
  const id=jobResult(url);
  if(id)return Response.json(completed(response.pages.find(value=>value.jobId===id),p).result);
  throw new Error('unexpected '+url);
 };
 try{
  const first=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:intent=>{intents.push(intent);}}),options('page-1'));
  assert.deepEqual(first,{completed:0,failed:0,paused:3});
  assert.deepEqual(intents.map(intent=>intent.phase),['prepared','sending','prepared']);
  assert.equal(resolves,0);
  const prepared=intents.at(-1);
  const resumedProject={...p,pages:p.pages.map(page=>({...page,pendingBatch:prepared,status:'paused'}))};
  const second=await batch.processProjectBatch(resumedProject,resumedProject.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:intent=>{intents.push(intent);}}),options('page-1'));
  assert.deepEqual(second,{completed:3,failed:0,paused:0});
  assert.equal(posts.length,2);assert.equal(posts[0],posts[1]);assert.equal(resolves,0);
 }finally{globalThis.fetch=originalFetch;}
});

test('non-busy 429 keeps sending phase and resolves without reuploading originals',async()=>{
 required();let p=project(2);const intents=[];let posts=0,resolves=0,uploads=0,response;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches')){posts++;response=await batchResponse(init.body,p);return Response.json({code:'BATCH_LIMIT',error:'보관할 수 있는 배치 수를 초과했습니다.'},{status:429});}
  throw new Error('unexpected '+url);
 };
 try{
  const first=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks({onIntent:intent=>{intents.push(intent);}}),options('page-1'));
  assert.deepEqual(first,{completed:0,failed:0,paused:2});
  assert.deepEqual(intents.map(intent=>intent.phase),['prepared','sending']);
  const sending=intents.at(-1);
  const resumedProject={...p,pages:p.pages.map(page=>({...page,pendingBatch:sending,status:'paused'}))};
  globalThis.fetch=async(url,init={})=>{
   if(String(url).startsWith('data:')){uploads++;return originalFetch(url,init);}
   if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
   if(String(url).endsWith('/batches/resolve')){resolves++;return Response.json(response);}
   if(String(url).endsWith('/batches')){uploads++;throw new Error('must not reupload');}
   if(String(url).endsWith('/batches/'+response.id))return Response.json(batchCompletedView(response));
   const id=jobResult(url);
   if(id)return Response.json(completed(response.pages.find(value=>value.jobId===id),p).result);
   throw new Error('unexpected '+url);
  };
  const second=await batch.processProjectBatch(resumedProject,resumedProject.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-1'));
  assert.deepEqual(second,{completed:2,failed:0,paused:0});assert.equal(posts,1);assert.equal(resolves,1);assert.equal(uploads,0);
 }finally{globalThis.fetch=originalFetch;}
});

test('thirty fresh pages read each original image only once and poll batch status in 2 requests without images',async()=>{
 required();const p=project(30);let dataReads=0,batchPosts=0,batchGets=0,jobStatusGets=0,resultGets=0,response;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:')){dataReads++;return originalFetch(url,init);}
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches')){batchPosts++;response=await batchResponse(init.body,p);return Response.json(response);}
  if(String(url).endsWith('/batches/'+response.id)){
   batchGets++;
   if(batchGets<3){
    return Response.json({...response,status:'running',pages:response.pages.map(page=>({...page,status:'running',job:{...page.job,status:'running',stage:'translating'}}))});
   }
   return Response.json(batchCompletedView(response));
  }
  const id=jobResult(url);
  if(id){resultGets++;return Response.json(completed(response.pages.find(value=>value.jobId===id),p).result);}
  if(String(url).includes('/jobs/')){jobStatusGets++;}
  throw new Error('unexpected '+url);
 };
 try{
  const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-1'));
  assert.deepEqual(summary,{completed:30,failed:0,paused:0});
  assert.equal(batchPosts,1);
  assert.equal(dataReads,30);
  assert.equal(batchGets,3);
  assert.equal(jobStatusGets,0);
  assert.equal(resultGets,30);
 }finally{globalThis.fetch=originalFetch;}
});

test('incomplete batch status falls back to per-job polling without dropping pages and restored batchId resumes via batch endpoint',async()=>{
 required();const p=project(3);let batchGets=0,jobGets=0,response;
 globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('data:'))return originalFetch(url,init);
  if(String(url).endsWith('/health'))return Response.json({status:'ok',batchSupported:true});
  if(String(url).endsWith('/batches')){response=await batchResponse(init.body,p);return Response.json(response);}
  if(String(url).endsWith('/batches/'+response.id)){
   batchGets++;
   // Deliberately omit page-3 so the batch falls back cleanly to per-job polling.
   return Response.json({...response,pages:response.pages.slice(0,2)});
  }
  if(String(url).includes('/jobs/')){
   jobGets++;
   return Response.json(completed(response.pages.find(value=>String(url).endsWith(value.jobId)),p));
  }
  throw new Error('unexpected '+url);
 };
 try{
  const summary=await batch.processProjectBatch(p,p.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-1'));
  assert.deepEqual(summary,{completed:3,failed:0,paused:0});assert.equal(batchGets,1);assert.equal(jobGets,3);
 }finally{globalThis.fetch=originalFetch;}

 // Saved batchId survives restoreProject and resumes directly via GET /batches/:id
 const savedBatchId='33333333-3333-4333-8333-333333333333';
 const saved=model.restoreProject({...p,pages:p.pages.map((page,i)=>({...page,jobId:jobId(i),batchId:savedBatchId,jobEndpoint:'/api/engine',status:'paused'}))});
 assert.equal(saved.pages[0].batchId,savedBatchId);
 let resumedBatchGets=0,resumedResultGets=0;
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/batches/'+savedBatchId)){
   resumedBatchGets++;
   return Response.json({id:savedBatchId,projectId:p.id,status:'completed',pages:saved.pages.map((page,i)=>({pageId:page.id,jobId:page.jobId,status:'completed',job:{id:page.jobId,projectId:p.id,pageId:page.id,pageNumber:i+1,status:'completed',stage:'completed'}}))});
  }
  const id=jobResult(url);
  if(id){resumedResultGets++;return Response.json(completed({jobId:id,pageId:saved.pages.find(pg=>pg.jobId===id).id},p).result);}
  throw new Error('unexpected '+url);
 };
 try{
  const resumed=await batch.processProjectBatch(saved,saved.pages,'','ja','ko',new AbortController().signal,callbacks(),options('page-1'));
  assert.deepEqual(resumed,{completed:3,failed:0,paused:0});assert.equal(resumedBatchGets,1);assert.equal(resumedResultGets,3);
 }finally{globalThis.fetch=originalFetch;}
});
