// Synthetic fetch/storage only. No browser, real server, account or AI request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';

class MemoryStorage{
 map=new Map();failWrite=false;
 get length(){return this.map.size;}key(index){return [...this.map.keys()][index]??null;}
 getItem(key){return this.map.get(key)??null;}
 setItem(key,value){if(this.failWrite)throw new Error('quota');this.map.set(key,value);}
 removeItem(key){this.map.delete(key);}
}
const scope={projectId:'work-one',pageId:'page-one',regionId:'region-one',source:'合成の原文です。',translation:'수정 중인 대사'};
const pair={source:'合成',target:'합성 표기'};
const scopeA='a'.repeat(64),scopeB='b'.repeat(64);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function projection(revision=0,terms=[],scopeId=scopeA){return {projectId:scope.projectId,scopeId,revision,terms,profiles:[]};}
function entry(value={id:'term-one',...pair},status='USER_MODIFIED',revision=1,history){return {id:value.id,status,value,currentRevision:revision,originalValue:value,proposals:[],history:history??[{revision,status,value,createdAt:'2026-11-11T00:00:00Z'}]};}
function ack(body,previous=[]){
 const change=body.changes[0],revision=body.expected_revision+1;
 const old=previous.find(item=>item.id===(change.id??change.term.id));
 const value=change.term??old.value,status=change.type==='confirm_term'?'USER_CONFIRMED':'USER_MODIFIED';
 const term=entry(value,status,revision,[...(old?.history??[]),{revision,status,value,createdAt:'2026-11-11T00:00:00Z'}]);
 return {...projection(revision,[...previous.filter(item=>item.id!==term.id),term]),appliedRevision:revision,replayed:false};
}

test('context client preserves explicit intent, canonical state and scoped drafts',async t=>{
 const file=new URL('../lib/studio-context.ts',import.meta.url);
 assert.equal(await access(file).then(()=>true,()=>false),true,'context client must exist before saving user terminology');
 const output=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/sites-context-client-'+Date.now());await mkdir(output,{recursive:true});
 const compiled=path.join(output,'studio-context.mjs');await writeFile(compiled,stripTypeScriptTypes(await readFile(file,'utf8')));
 const {createStudioContextSession,CONTEXT_INTENT_PREFIX}=await import(pathToFileURL(compiled));
 let sequence=0;
 const make=(fetcher,storage=new MemoryStorage(),selected=scope)=>createStudioContextSession(selected,{fetcher,storage,nonce:()=>`operation-${++sequence}`});

 await t.test('upsert and explicit confirm use separate exact commands and credentials, never client authority',async()=>{
  const calls=[];let terms=[];
  const session=make(async(url,init={})=>{calls.push({url:String(url),init});if(init.method!=='POST')return Response.json(projection());const value=ack(JSON.parse(init.body),terms);terms=value.terms;return Response.json(value);});
  await session.load();session.setDraft(pair);await session.save();
  assert.equal(calls.length,2);const first=JSON.parse(calls[1].init.body);
  assert.deepEqual(first,{expected_revision:0,idempotency_key:'context:operation-1',changes:[{type:'upsert_term',term:{id:'operation-1',...pair}}]});
  assert.equal(calls[1].url,'/api/engine/projects/work-one/context');assert.equal(calls[1].init.credentials,'same-origin');
  assert.equal(calls[1].init.cache,'no-store');assert.equal(calls[1].init.redirect,'error');
  assert.equal(calls[1].init.headers['X-Mangohana-Context-Scope'],scopeA);
  assert.equal(session.getSnapshot().canonical.terms[0].status,'USER_MODIFIED');
  assert.equal(calls.filter(call=>call.init.method==='POST').length,1);
  const review=session.getReview();assert.equal(review.source,pair.source);assert.equal(review.target,pair.target);
  await session.confirm(review);
  assert.deepEqual(JSON.parse(calls[2].init.body),{expected_revision:1,idempotency_key:'context:operation-2',changes:[{type:'confirm_term',id:'operation-1',expectedEntryRevision:1}]});
  assert.equal(session.getSnapshot().canonical.terms[0].status,'USER_CONFIRMED');
  for(const call of calls.filter(call=>call.init.method==='POST'))assert.doesNotMatch(call.init.body,/"(?:owner|status|provenance|reference)"/);
 });

 await t.test('network-unknown intent survives a new session and replays only the same stored body/key',async()=>{
  const storage=new MemoryStorage(),bodies=[];let firstBody;
  const first=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection());firstBody=JSON.parse(init.body);bodies.push(init.body);throw new TypeError('lost response');},storage);
  await first.load();first.setDraft(pair);await first.save();assert.equal(first.getSnapshot().status,'unknown');first.dispose();
  let posts=0;const resumed=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json({scopeId:scopeA,error:'unknown'},{status:503});posts++;bodies.push(init.body);return Response.json({...ack(firstBody),replayed:true});},storage,{...scope,pageId:'another-page',regionId:'another-region',source:'別の原文'});
  await resumed.load();assert.equal(posts,0);assert.equal(resumed.getSnapshot().canonical,null);assert.equal(resumed.getSnapshot().pending.length,1);
  await resumed.recover(resumed.getSnapshot().pending[0].nonce);assert.equal(posts,1);assert.equal(bodies[0],bodies[1]);assert.equal(storage.length,0);
  assert.equal(resumed.getSnapshot().canonical.terms[0].value.target,pair.target);
 });

 await t.test('multiple durable operation keys coexist and resolving one never removes another tab intent',async()=>{
  const storage=new MemoryStorage();const original=make(async(_url,init={})=>init.method==='POST'?Promise.reject(new Error('lost')):Response.json(projection()),storage);
  await original.load();original.setDraft(pair);await original.save();original.dispose();
  const firstKey=storage.key(0),record=JSON.parse(storage.getItem(firstKey)),other=structuredClone(record);other.nonce='other-tab';other.body.idempotency_key='context:other-tab';other.body.changes[0].term.id='other-tab';
  storage.setItem(CONTEXT_INTENT_PREFIX+scope.projectId+':other-tab',JSON.stringify(other));
  const resumed=make(async(_url,init={})=>init.method==='POST'?Response.json(ack(JSON.parse(init.body))):Response.json(projection()),storage);
  await resumed.load();assert.equal(resumed.getSnapshot().pending.length,2);await resumed.recover(record.nonce);
  assert.equal(storage.length,1);assert.equal(resumed.getSnapshot().pending[0].nonce,'other-tab');
 });

 await t.test('a definite CAS conflict retires that command, preserves draft and requires a scoped reload before a new user command',async()=>{
  const storage=new MemoryStorage(),bodies=[];let reads=0;
  const session=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection(reads++?2:0));bodies.push(JSON.parse(init.body));return bodies.length===1?Response.json({error:'conflict',code:'CONTEXT_REVISION_CONFLICT',scopeId:scopeA},{status:409}):Response.json(ack(bodies.at(-1)));},storage);
  await session.load();session.setDraft(pair);await session.save();assert.equal(session.getSnapshot().status,'conflict');assert.equal(session.getSnapshot().needsReload,true);assert.deepEqual(session.getSnapshot().draft,pair);
  const old=JSON.parse(storage.getItem(storage.key(0)));assert.equal(old.state,'conflict');await session.save();assert.equal(bodies.length,1);
  await session.load();assert.deepEqual(session.getSnapshot().draft,pair);await session.save();assert.equal(bodies.length,2);assert.equal(bodies[1].expected_revision,2);assert.notEqual(bodies[0].idempotency_key,bodies[1].idempotency_key);assert.deepEqual(old.body,bodies[0]);
 });

 await t.test('failed or aborted GET never replaces known canonical data with empty state',async()=>{
  const known=projection(3,[entry(undefined,'USER_CONFIRMED',3)]);let reads=0;
  const session=make(async()=>{if(reads++===0)return Response.json(known);throw new DOMException('cancelled','AbortError');});
  await session.load();session.setDraft(pair);await session.load();assert.equal(session.getSnapshot().canonical.revision,3);assert.equal(session.getSnapshot().canonical.terms.length,1);assert.deepEqual(session.getSnapshot().draft,pair);
 });

 await t.test('late GET and project disposal cannot overwrite a newer canonical revision or manual draft',async()=>{
  const old=deferred(),fresh=deferred();let reads=0;
  const session=make(()=>reads++?fresh.promise:old.promise),one=session.load();session.setDraft(pair);const two=session.load();
  fresh.resolve(Response.json(projection(4,[entry(undefined,'USER_MODIFIED',4)])));await two;
  old.resolve(Response.json(projection(1,[entry()])));await one;assert.equal(session.getSnapshot().canonical.revision,4);assert.deepEqual(session.getSnapshot().draft,pair);
  const cancelled=deferred();const closed=make(()=>cancelled.promise);const operation=closed.load();closed.dispose();cancelled.resolve(Response.json(projection(9)));await operation;assert.equal(closed.getSnapshot().canonical,null);
 });

 await t.test('late POST after close leaves its durable intent and cannot alter a different selected project',async()=>{
  const storage=new MemoryStorage(),late=deferred();let body;
  const old=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection());body=JSON.parse(init.body);return late.promise;},storage);
  await old.load();old.setDraft(pair);const operation=old.save();old.dispose();
  const other=make(async()=>Response.json({projectId:'work-two',scopeId:'c'.repeat(64),revision:0,terms:[],profiles:[]}),storage,{...scope,projectId:'work-two'});await other.load();other.setDraft({source:'別',target:'다른 초안'});
  late.resolve(Response.json(ack(body)));await operation;assert.equal(storage.length,1);assert.equal(other.getSnapshot().canonical.projectId,'work-two');assert.deepEqual(other.getSnapshot().draft,{source:'別',target:'다른 초안'});
 });

 await t.test('explicit confirmation rejects stale review values and never promotes an AI proposal automatically',async()=>{
  let known=projection(1,[entry(undefined,'AI_PROPOSED')]),posts=0;
  const session=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(known);posts++;known=ack(JSON.parse(init.body),known.terms);return Response.json(known);});
  await session.load();session.setDraft(pair);assert.equal(session.getReview(),null);await session.confirm(null);assert.equal(posts,0);
  await session.save();assert.equal(posts,1);const review=session.getReview();assert.ok(review);session.setDraft({...pair,target:'바꾼 초안'});await session.confirm(review);assert.equal(posts,1);
 });

 await t.test('double-clicking confirm while one exact user command is in flight cannot create another key',async()=>{
  const waiting=deferred(),calls=[];const session=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection(1,[entry()]));calls.push(JSON.parse(init.body));return waiting.promise;});
  await session.load();session.setDraft(pair);const review=session.getReview(),first=session.confirm(review);const second=session.confirm(review);
  waiting.resolve(Response.json(ack(calls[0],[entry()])));await Promise.all([first,second]);assert.equal(calls.length,1);
 });

 await t.test('storage write failure prevents POST and keeps the edited source pair',async()=>{
  const storage=new MemoryStorage();let posts=0;const session=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection());},storage);
  await session.load();session.setDraft(pair);storage.failWrite=true;await session.save();assert.equal(posts,0);assert.deepEqual(session.getSnapshot().draft,pair);assert.ok(session.getSnapshot().storageError);
 });

 await t.test('corrupt durable records are preserved and block new commands rather than becoming empty pending state',async()=>{
  const storage=new MemoryStorage(),key=CONTEXT_INTENT_PREFIX+scope.projectId+':broken';storage.setItem(key,'not JSON');let posts=0;
  const session=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection());},storage);
  await session.load();session.setDraft(pair);await session.save();assert.equal(posts,0);assert.equal(storage.getItem(key),'not JSON');assert.ok(session.getSnapshot().storageError);
 });

 await t.test('a nonce collision cannot overwrite a retired command',async()=>{
  const storage=new MemoryStorage();let posts=0;const fetcher=async(_url,init={})=>{if(init.method==='POST'){posts++;return Response.json({scopeId:scopeA,code:'CONTEXT_REVISION_CONFLICT'},{status:409});}return Response.json(projection());};
  const first=createStudioContextSession(scope,{fetcher,storage,nonce:()=> 'same-nonce'});await first.load();first.setDraft(pair);await first.save();const before=storage.getItem(storage.key(0));
  const second=createStudioContextSession(scope,{fetcher,storage,nonce:()=> 'same-nonce'});await second.load();second.setDraft({...pair,target:'새 초안'});await second.save();assert.equal(posts,1);assert.equal(storage.getItem(storage.key(0)),before);
 });

 await t.test('a malformed successful POST remains unknown and preserves prior canonical data and the frozen key',async()=>{
  const storage=new MemoryStorage();let posts=0;const session=make(async(_url,init={})=>{if(init.method==='POST'){posts++;return Response.json({projectId:'wrong',revision:8,terms:[]});}return Response.json(projection(2,[entry(undefined,'USER_MODIFIED',2)]));},storage);
  await session.load();session.setDraft(pair);await session.save();assert.equal(posts,1);assert.equal(session.getSnapshot().status,'unknown');assert.equal(session.getSnapshot().canonical.revision,2);assert.equal(storage.length,1);
 });

 await t.test('simple edits preserve permitted existing metadata and never overwrite conditional terms',async()=>{
  const saved=entry({id:'saved',...pair,note:'기존 메모',category:'character',priority:3});let body;
  const session=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection(1,[saved]));body=JSON.parse(init.body);return Response.json(ack(body,[saved]));});
  await session.load();session.setDraft({...pair,target:'새 표기'});await session.save();assert.deepEqual(body.changes[0].term,{...saved.value,target:'새 표기'});
  let posts=0;const conditional=entry({...saved.value,condition:{speaker:'named-speaker'}});
  const guarded=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection(1,[conditional]));});await guarded.load();guarded.setDraft(pair);await guarded.save();assert.equal(posts,0);
 });

 await t.test('input scope/raw OCR and current manual translation are never modified by saved context',async()=>{
  const selected=structuredClone(scope),before=JSON.stringify(selected);const session=make(async()=>Response.json(projection(1,[entry()])),new MemoryStorage(),selected);
  await session.load();session.setDraft(pair);assert.equal(JSON.stringify(selected),before);assert.equal(session.getSnapshot().scope.source,scope.source);assert.equal(session.getSnapshot().scope.translation,scope.translation);
 });
 await t.test('non-string project identities or operation nonces cannot reach a request',async()=>{
  for(const projectId of [undefined,44,{}])assert.throws(()=>createStudioContextSession({...scope,projectId},{storage:new MemoryStorage(),fetcher:()=>assert.fail('invalid identity reached fetch')}));
  let posts=0;const session=createStudioContextSession(scope,{storage:new MemoryStorage(),nonce:()=>undefined,fetcher:async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection());}});
  await session.load();session.setDraft(pair);await session.save();assert.equal(posts,0);
 });
 await t.test('two explicit recovery acknowledgements for one nonce settle safely after the other tab removes it',async()=>{
  const storage=new MemoryStorage();let body;const first=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection());body=JSON.parse(init.body);throw new Error('lost');},storage);
  await first.load();first.setDraft(pair);await first.save();first.dispose();const stored=JSON.parse(storage.getItem(storage.key(0)));
  const a=deferred(),b=deferred();const recover=(waiting)=>make(async(_url,init={})=>init.method==='POST'?waiting.promise:Response.json({scopeId:scopeA},{status:503}),storage);
  const one=recover(a),two=recover(b);await one.load();await two.load();const opOne=one.recover(stored.nonce),opTwo=two.recover(stored.nonce);
  a.resolve(Response.json({...ack(body),replayed:true}));await opOne;b.resolve(Response.json({...ack(body),replayed:true}));await opTwo;
  assert.equal(one.getSnapshot().status,'ready');assert.equal(two.getSnapshot().status,'ready');assert.equal(storage.length,0);
 });
 await t.test('pending body and displayed pair are immutable while the durable request remains unknown',async()=>{
  const storage=new MemoryStorage(),session=make(async(_url,init={})=>init.method==='POST'?Promise.reject(new Error('lost')):Response.json(projection()),storage);
  await session.load();session.setDraft(pair);await session.save();const intent=session.getSnapshot().pending[0],before=storage.getItem(storage.key(0));
  assert.throws(()=>{intent.body.expected_revision=99;},TypeError);assert.throws(()=>{intent.pair.source='changed';},TypeError);assert.equal(storage.getItem(storage.key(0)),before);
 });
 await t.test('ledger scan failure after durable readback stops before POST and preserves that exact intent',async()=>{
  class FailingScanStorage extends MemoryStorage{failOnce=true;get length(){if(this.map.size&&this.failOnce){this.failOnce=false;throw new Error('scan interrupted');}return this.map.size;}}
  const storage=new FailingScanStorage();let posts=0;
  const session=make(async(_url,init={})=>{if(init.method==='POST'){posts++;return Response.json(ack(JSON.parse(init.body)));}return Response.json(projection());},storage);
  await session.load();session.setDraft(pair);await session.save();assert.equal(posts,0);assert.equal(storage.map.size,1);assert.ok(session.getSnapshot().storageError);assert.deepEqual(session.getSnapshot().draft,pair);
 });
 await t.test('cookie scope rotation keeps the old unknown record unresolved and never adopts a new scope into it',async()=>{
  const storage=new MemoryStorage(),calls=[];let owner=scopeA;
  const session=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection(0,[],owner));calls.push(init);if(owner===scopeA)throw new Error('old owner committed but reply lost');return Response.json({scopeId:scopeB,code:'CONTEXT_SCOPE_CHANGED',error:'scope changed'},{status:409});},storage);
  await session.load();session.setDraft(pair);await session.save();const key=storage.key(0),before=storage.getItem(key),pending=JSON.parse(before);assert.equal(pending.scopeId,scopeA);
  owner=scopeB;await session.recover(pending.nonce);assert.equal(calls[1].headers['X-Mangohana-Context-Scope'],scopeA);assert.equal(storage.getItem(key),before);assert.equal(session.getSnapshot().pending.length,1);assert.equal(session.getSnapshot().retired.length,0);
  await session.load();assert.equal(session.getSnapshot().canonical.scopeId,scopeB);assert.deepEqual(session.getSnapshot().draft,pair);await session.save();await session.recover(pending.nonce);assert.equal(calls.length,2);assert.equal(storage.getItem(key),before);
 });
 await t.test('a new owner loaded after reopening cannot resend or silently retire another scope intent',async()=>{
  const storage=new MemoryStorage();const old=make(async(_url,init={})=>init.method==='POST'?Promise.reject(new Error('lost')):Response.json(projection()),storage);await old.load();old.setDraft(pair);await old.save();old.dispose();const key=storage.key(0),before=storage.getItem(key),intent=JSON.parse(before);let posts=0;
  const current=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection(0,[],scopeB));},storage);await current.load();current.setDraft(pair);await current.recover(intent.nonce);await current.save();assert.equal(posts,0);assert.equal(storage.getItem(key),before);assert.equal(current.getSnapshot().pending.length,1);
 });
 await t.test('wrong-scope successful response cannot clear a frozen original request',async()=>{
  const storage=new MemoryStorage();const session=make(async(_url,init={})=>init.method==='POST'?Response.json({...ack(JSON.parse(init.body)),scopeId:scopeB}):Response.json(projection()),storage);
  await session.load();session.setDraft(pair);await session.save();assert.equal(session.getSnapshot().status,'unknown');assert.equal(storage.length,1);assert.equal(JSON.parse(storage.getItem(storage.key(0))).scopeId,scopeA);assert.equal(session.getSnapshot().canonical.scopeId,scopeA);
 });
 await t.test('missing or malformed context scope cannot authorize a new save',async()=>{
  for(const scopeId of [undefined,'not-a-scope','a'.repeat(63)]){let posts=0;const session=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json({...projection(),scopeId});});await session.load();session.setDraft(pair);await session.save();assert.equal(posts,0);assert.equal(session.getSnapshot().canonical,null);}
 });
 await t.test('scope-less legacy intent stays preserved without being rebound to the current owner',async()=>{
  const storage=new MemoryStorage();const old=make(async(_url,init={})=>init.method==='POST'?Promise.reject(new Error('lost')):Response.json(projection()),storage);await old.load();old.setDraft(pair);await old.save();old.dispose();const key=storage.key(0),legacy=JSON.parse(storage.getItem(key));delete legacy.scopeId;storage.setItem(key,JSON.stringify(legacy));const before=storage.getItem(key);let posts=0;
  const current=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection());},storage);await current.load();await current.recover(legacy.nonce);current.setDraft(pair);await current.save();assert.equal(posts,0);assert.equal(storage.getItem(key),before);assert.equal(current.getSnapshot().pending.length,1);
 });
 await t.test('a displayed confirmation review is bound to its owner scope even when values/revisions coincide',async()=>{
  let owner=scopeA,posts=0;const session=make(async(_url,init={})=>{if(init.method==='POST')posts++;return Response.json(projection(1,[entry()],owner));});await session.load();session.setDraft(pair);const shown=session.getReview();owner=scopeB;await session.load();assert.equal(session.getSnapshot().canonical.scopeId,scopeB);await session.confirm(shown);assert.equal(posts,0);
 });
 await t.test('a scoped 503 can recover the old request while an unscoped error cannot authorize replay',async()=>{
  const storage=new MemoryStorage();let body;const prior=make(async(_url,init={})=>{if(init.method!=='POST')return Response.json(projection());body=JSON.parse(init.body);throw new Error('lost');},storage);await prior.load();prior.setDraft(pair);await prior.save();prior.dispose();const pending=JSON.parse(storage.getItem(storage.key(0)));let scoped=false,posts=0;
  const resumed=make(async(_url,init={})=>{if(init.method==='POST'){posts++;assert.equal(init.headers['X-Mangohana-Context-Scope'],scopeA);return Response.json({...ack(body),replayed:true});}return Response.json(scoped?{scopeId:scopeA,error:'unknown'}:{error:'legacy or unknown server'},{status:503});},storage);
  await resumed.load();await resumed.recover(pending.nonce);assert.equal(posts,0);assert.equal(storage.length,1);scoped=true;await resumed.load();assert.equal(resumed.getSnapshot().canonical,null);await resumed.recover(pending.nonce);assert.equal(posts,1);assert.equal(storage.length,0);
 });
 await writeFile(path.join(output,'scope.json'),JSON.stringify({kind:'SYNTHETIC_CONTEXT_CLIENT_TESTS',realHttpRequests:0,aiCalls:0,browserRuns:0}));
});
