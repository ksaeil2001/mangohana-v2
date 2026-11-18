import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import {registerHooks} from 'node:module';
import path from 'node:path';

// Only this module's filesystem import is wrapped; storage remains isolated on the real E: filesystem.
const contextUrl=new URL('../../apps/engine/context.mjs',import.meta.url).href,slot='context-test-io-'+process.pid;
const io={rename:nativeFs.rename,open:nativeFs.open,mkdir:nativeFs.mkdir};globalThis[slot]=io;
const wrapper='data:text/javascript,'+encodeURIComponent(`export * from 'node:fs/promises';export const rename=(...args)=>globalThis[${JSON.stringify(slot)}].rename(...args);export const open=(...args)=>globalThis[${JSON.stringify(slot)}].open(...args);export const mkdir=(...args)=>globalThis[${JSON.stringify(slot)}].mkdir(...args);`);
const hooks=registerHooks({resolve(specifier,context,next){return specifier==='node:fs/promises'&&context.parentURL?.split('?')[0]===contextUrl?{url:wrapper,shortCircuit:true}:next(specifier,context);}});
after(()=>{hooks.deregister();delete globalThis[slot];});
const {createContextStore}=await import(contextUrl+'?context-store-tests');
const sha=value=>createHash('sha256').update(value).digest('hex');
const alice=sha('synthetic-context-alice'),bob=sha('synthetic-context-bob'),project='project-one';
const testRoot=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/context-store-'+process.pid+'-'+Date.now());
await nativeFs.mkdir(testRoot,{recursive:true});
const namespace=(root,owner=alice,id=project)=>path.join(root,sha(owner+'\0'+id));
const term=(id='name',source='春樹',target='하루키')=>({type:'upsert_term',term:{id,source,target,category:'character'}});
const request=(expectedRevision,idempotencyKey,changes)=>({expectedRevision,idempotencyKey,changes});
async function fixture(t){
 const root=await nativeFs.mkdtemp(path.join(testRoot,'store-'));let store=await createContextStore({root});
 t.after(async()=>{io.rename=nativeFs.rename;io.open=nativeFs.open;io.mkdir=nativeFs.mkdir;await store.close();assert.equal(path.dirname(root),testRoot);await nativeFs.rm(root,{recursive:true,force:true});});
 return {root,get store(){return store;},set store(value){store=value;}};
}

test('empty contexts are owner/project scoped and do not create project records',async t=>{
 const f=await fixture(t),a=await f.store.get(alice,project);
 assert.deepEqual({revision:a.revision,terms:a.terms,profiles:a.profiles},{revision:0,terms:[],profiles:[]});
 assert.deepEqual(await nativeFs.readdir(f.root),[]);
 await f.store.apply(alice,project,request(0,'edit',[term()]));
 assert.equal((await f.store.get(bob,project)).revision,0);assert.equal((await f.store.get(alice,'another-project')).revision,0);
 assert.deepEqual(await nativeFs.readdir(f.root),[path.basename(namespace(f.root))]);
});

test('user changes require a later explicit current-revision confirmation for canonical terminology',async t=>{
 const f=await fixture(t),edited=await f.store.apply(alice,project,request(0,'edit',[term()]));
 assert.equal(edited.revision,1);assert.equal(edited.terms[0].status,'USER_MODIFIED');assert.equal(edited.terms[0].currentRevision,1);
 assert.deepEqual((await f.store.snapshot(alice,project)).terms,[]);
 await assert.rejects(f.store.apply(alice,project,request(1,'stale-confirm',[{type:'confirm_term',id:'name',expectedEntryRevision:0}])),{code:'CONTEXT_REVISION_CONFLICT'});
 const confirmed=await f.store.apply(alice,project,request(1,'confirm',[{type:'confirm_term',id:'name',expectedEntryRevision:1}]));
 assert.equal(confirmed.revision,2);assert.equal(confirmed.terms[0].status,'USER_CONFIRMED');
 const snapshot=await f.store.snapshot(alice,project,{sourceText:'春樹さん。'});assert.equal(snapshot.revision,2);assert.equal(snapshot.glossaryRevision,2);
 assert.deepEqual(snapshot.terms.map(value=>({source:value.source,target:value.target})),[{source:'春樹',target:'하루키'}]);assert.match(snapshot.contentSha256,/^[a-f0-9]{64}$/);
});

test('AI proposals and original reference material survive user changes without automatic promotion or overwriting',async t=>{
 const f=await fixture(t),reference={sourceJobId:'job-one',pageId:'page-one',pageNumber:1,regionId:'region:1',sourceSha256:sha('source'),reportSha256:sha('report'),editRevision:0};
 const proposal={type:'propose_term',term:{id:'name',source:'春樹',target:'춘수'},reference};
 const first=await f.store.propose(alice,project,request(0,'proposal',[proposal]));assert.equal(first.terms[0].status,'AI_PROPOSED');
 assert.deepEqual((await f.store.snapshot(alice,project)).terms,[]);
 await f.store.apply(alice,project,request(1,'correct',[term()]));
 await f.store.apply(alice,project,request(2,'confirm',[{type:'confirm_term',id:'name',expectedEntryRevision:2}]));
 const newer=await f.store.propose(alice,project,request(3,'proposal-new',[{...proposal,term:{...proposal.term,target:'하루'}}]));
 const entry=newer.terms[0];assert.equal(entry.status,'USER_CONFIRMED');assert.equal(entry.value.target,'하루키');assert.equal(entry.originalValue.target,'춘수');
 assert.deepEqual(entry.proposals.map(value=>value.value.target),['춘수','하루']);assert.deepEqual(entry.proposals[0].reference,reference);assert.equal(entry.history.length,4);
 assert.equal((await f.store.snapshot(alice,project)).terms[0].target,'하루키');
});

test('profiles keep explicit provenance and are not silently turned into canonical glossary entries',async t=>{
 const f=await fixture(t),profile={id:'hero',name:'하루키',aliases:['春樹'],speechStyle:'관계가 확인될 때만 존댓말',relationshipNotes:'형제 관계 미확정'};
 await f.store.apply(alice,project,request(0,'profile',[{type:'upsert_profile',profile}]));
 const confirmed=await f.store.apply(alice,project,request(1,'confirm-profile',[{type:'confirm_profile',id:'hero',expectedEntryRevision:1}]));
 assert.equal(confirmed.profiles[0].status,'USER_CONFIRMED');assert.deepEqual(confirmed.profiles[0].value,profile);assert.deepEqual((await f.store.snapshot(alice,project)).terms,[]);
});

test('one atomic receipt makes concurrent and restarted replay idempotent while changed payloads conflict',async t=>{
 const f=await fixture(t),input=request(0,'same-key',[term()]),responses=await Promise.all([f.store.apply(alice,project,input),f.store.apply(alice,project,input)]);
 assert.deepEqual(responses.map(value=>value.replayed).sort(),[false,true]);assert.equal((await f.store.get(alice,project)).revision,1);
 await f.store.close();f.store=await createContextStore({root:f.root});
 const replay=await f.store.apply(alice,project,input);assert.equal(replay.appliedRevision,1);assert.equal(replay.replayed,true);assert.equal(replay.terms[0].history.length,1);
 await assert.rejects(f.store.apply(alice,project,request(0,'same-key',[term('name','春樹','다른 이름')])),{code:'CONTEXT_IDEMPOTENCY_CONFLICT'});
 await assert.rejects(f.store.apply(alice,project,request(0,'new-key',[term()])),{code:'CONTEXT_REVISION_CONFLICT'});
 const disk=JSON.parse(await nativeFs.readFile(path.join(namespace(f.root),'state.json'),'utf8'));assert.equal(disk.receipts.length,1);assert.equal(disk.revision,1);
});

test('concurrent different CAS mutations cannot both commit the same base revision',async t=>{
 const f=await fixture(t),outcomes=await Promise.allSettled([f.store.apply(alice,project,request(0,'a',[term('a')])),f.store.apply(alice,project,request(0,'b',[term('b')]))]);
 assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);assert.equal(outcomes.find(value=>value.status==='rejected').reason.code,'CONTEXT_REVISION_CONFLICT');
 assert.equal((await f.store.get(alice,project)).terms.length,1);
});

test('replaying an older receipt reports its application revision without restoring stale content',async t=>{
 const f=await fixture(t),first=request(0,'first',[term()]);await f.store.apply(alice,project,first);
 await f.store.apply(alice,project,request(1,'second',[term('name','春樹','새 표기')]));
 const replay=await f.store.apply(alice,project,first);assert.equal(replay.revision,2);assert.equal(replay.appliedRevision,1);assert.equal(replay.replayed,true);assert.equal(replay.terms[0].value.target,'새 표기');
 await assert.rejects(f.store.propose(alice,project,request(0,'first',[{type:'propose_term',term:term().term}])),{code:'CONTEXT_IDEMPOTENCY_CONFLICT'});
});

test('editing a confirmed term preserves its history and requires confirmation of the new value',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'first',[term()]));await f.store.apply(alice,project,request(1,'confirm',[{type:'confirm_term',id:'name',expectedEntryRevision:1}]));
 const changed=await f.store.apply(alice,project,request(2,'edit-again',[term('name','春樹','새 표기')]));assert.equal(changed.terms[0].status,'USER_MODIFIED');assert.equal(changed.terms[0].history[1].status,'USER_CONFIRMED');assert.deepEqual((await f.store.snapshot(alice,project)).terms,[]);
});

test('client status injection, AI commands, invalid revisions, paths and unverified previous context are rejected before writing',async t=>{
 const f=await fixture(t);
 for(const input of [request(0,'bad',[{...term(),term:{...term().term,status:'USER_CONFIRMED'}}]),request(0,'bad',[{type:'propose_term',term:term().term}]),request(Number.MAX_SAFE_INTEGER+1,'bad',[term()]),{...request(0,'bad',[term()]),previousContext:[]},request(0,'bad',[{...term(),reference:{sourceSha256:'invalid'}}])])await assert.rejects(f.store.apply(alice,project,input),{code:'CONTEXT_INPUT_INVALID'});
 await assert.rejects(f.store.apply(alice,'../project',request(0,'bad',[term()])),{code:'CONTEXT_INPUT_INVALID'});
 await assert.rejects(f.store.snapshot(alice,project,{previousContext:[]}),{code:'CONTEXT_INPUT_INVALID'});
 assert.deepEqual(await nativeFs.readdir(f.root),[]);
});

test('identifiers and command types are strings rather than values coerced by regular expressions',async t=>{
 const f=await fixture(t);
 for(const change of [term(123),{type:5,term:term().term},{type:'confirm_term',id:123,expectedEntryRevision:0},{type:'upsert_profile',profile:{id:123,name:'인물',aliases:[]}}])await assert.rejects(f.store.apply(alice,project,request(0,'invalid',[change])),{code:'CONTEXT_INPUT_INVALID'});
 assert.deepEqual(await nativeFs.readdir(f.root),[]);
});

test('canonical snapshots are literal, deterministic and detached from caller mutations',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'edit',[term('punctuation','行こう。','가자.')]));
 await f.store.apply(alice,project,request(1,'confirm',[{type:'confirm_term',id:'punctuation',expectedEntryRevision:1}]));
 assert.deepEqual((await f.store.snapshot(alice,project,{sourceText:'行こう！'})).terms,[]);
 const first=await f.store.snapshot(alice,project,{sourceText:'行こう。'}),again=await f.store.snapshot(alice,project,{sourceText:'行こう。'});assert.equal(first.contentSha256,again.contentSha256);
 first.terms[0].target='changed';const view=await f.store.get(alice,project);view.terms[0].history[0].value.target='changed';
 assert.equal((await f.store.snapshot(alice,project)).terms[0].target,'가자.');
});

test('contradictory confirmed terms with the same literal source and condition cannot both become canonical',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'edit',[term('a'),term('b','春樹','춘수')]));
 await f.store.apply(alice,project,request(1,'confirm-a',[{type:'confirm_term',id:'a',expectedEntryRevision:1}]));
 await assert.rejects(f.store.apply(alice,project,request(2,'confirm-b',[{type:'confirm_term',id:'b',expectedEntryRevision:1}])),{code:'CONTEXT_TERM_CONFLICT'});
 assert.equal((await f.store.get(alice,project)).revision,2);assert.equal((await f.store.snapshot(alice,project)).terms.length,1);
});

test('a real rename fault preserves one pending receipt and blocks different writes across restart',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'seed',[term()]));
 const directory=namespace(f.root),stateFile=path.join(directory,'state.json'),savedFile=path.join(directory,'state.before-fault.json'),before=await nativeFs.readFile(stateFile),input=request(1,'pending',[term('name','春樹','하루키 새 표기')]);let fault=true;
 io.rename=async(from,to)=>{if(fault&&to===stateFile){fault=false;await nativeFs.rename(stateFile,savedFile);await nativeFs.mkdir(stateFile);}return nativeFs.rename(from,to);};
 try{
  await assert.rejects(f.store.apply(alice,project,input),{code:'CONTEXT_COMMIT_UNKNOWN'});
  const pending=(await nativeFs.readdir(directory)).filter(name=>name.startsWith('.pending-'));assert.equal(pending.length,1);
  await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
  await assert.rejects(f.store.apply(alice,project,request(1,'another-key',[term()])),{code:'CONTEXT_COMMIT_UNKNOWN'});
  assert.equal((await nativeFs.readdir(directory)).filter(name=>name.startsWith('.pending-')).length,1);assert.deepEqual(await nativeFs.readFile(savedFile),before);
 }finally{io.rename=nativeFs.rename;await nativeFs.rmdir(stateFile);await nativeFs.rename(savedFile,stateFile);}
 await f.store.close();f.store=await createContextStore({root:f.root});
 await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
 await assert.rejects(f.store.apply(alice,project,request(1,'pending',[term()])),{code:'CONTEXT_IDEMPOTENCY_CONFLICT'});
 const recovered=await f.store.apply(alice,project,input);assert.equal(recovered.revision,2);assert.equal(recovered.terms[0].history.length,2);
 const replay=await f.store.apply(alice,project,input);assert.equal(replay.replayed,true);assert.equal(replay.revision,2);
 assert.deepEqual((await nativeFs.readdir(directory)).filter(name=>name.startsWith('.pending-')),[]);
});

test('partial candidate artifacts never become an empty context or get overwritten automatically',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'seed',[term()]));
 const candidate=path.join(namespace(f.root),'.pending-'+randomUUID()+'.json'),partial=Buffer.from('{"partial":');await nativeFs.writeFile(candidate,partial,{flag:'wx'});
 await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
 await assert.rejects(f.store.apply(alice,project,request(1,'new',[term()])),{code:'CONTEXT_COMMIT_UNKNOWN'});assert.deepEqual(await nativeFs.readFile(candidate),partial);
 await f.store.close();f.store=await createContextStore({root:f.root});await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
});

test('a lost rename acknowledgment is resolved from the committed receipt without a second mutation',async t=>{
 const f=await fixture(t),input=request(0,'lost-ack',[term()]);let fault=true;
 io.rename=async(from,to)=>{await nativeFs.rename(from,to);if(fault){fault=false;throw new Error('SYNTHETIC_RENAME_ACK_LOST');}};
 await assert.rejects(f.store.apply(alice,project,input),{code:'CONTEXT_COMMIT_UNKNOWN'});io.rename=nativeFs.rename;
 assert.equal((await f.store.get(alice,project)).revision,1);
 const replay=await f.store.apply(alice,project,input);assert.equal(replay.replayed,true);assert.equal(replay.terms[0].history.length,1);
 await f.store.close();f.store=await createContextStore({root:f.root});assert.equal((await f.store.apply(alice,project,input)).revision,1);
});

test('a first-save rename fault can recover its one preserved candidate without an existing state file',async t=>{
 const f=await fixture(t),stateFile=path.join(namespace(f.root),'state.json'),input=request(0,'first-save',[term()]);let fault=true;
 io.rename=async(from,to)=>{if(fault){fault=false;await nativeFs.mkdir(to);}return nativeFs.rename(from,to);};
 await assert.rejects(f.store.apply(alice,project,input),{code:'CONTEXT_COMMIT_UNKNOWN'});io.rename=nativeFs.rename;await nativeFs.rmdir(stateFile);
 await f.store.close();f.store=await createContextStore({root:f.root});await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
 const recovered=await f.store.apply(alice,project,input);assert.equal(recovered.revision,1);assert.equal(recovered.terms[0].history.length,1);
});

test('a real candidate-open failure preserves the prior state and blocks a new mutation',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'seed',[term()]));const directory=namespace(f.root),stateFile=path.join(directory,'state.json'),before=await nativeFs.readFile(stateFile);let failedCandidate;
 io.open=async(file,flags,...rest)=>{if(flags==='wx'&&path.basename(file).startsWith('.pending-')&&!failedCandidate){failedCandidate=file;await nativeFs.mkdir(file);}return nativeFs.open(file,flags,...rest);};
 await assert.rejects(f.store.apply(alice,project,request(1,'open-fault',[term('name','春樹','수정')])),{code:'CONTEXT_COMMIT_UNKNOWN'});io.open=nativeFs.open;
 assert.deepEqual(await nativeFs.readFile(stateFile),before);assert.equal((await nativeFs.lstat(failedCandidate)).isDirectory(),true);
 await assert.rejects(f.store.apply(alice,project,request(1,'another-key',[term()])),{code:'CONTEXT_COMMIT_UNKNOWN'});
 await f.store.close();f.store=await createContextStore({root:f.root});await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});assert.deepEqual(await nativeFs.readFile(stateFile),before);
});

for(const code of ['EACCES','ENOSPC'])test(`an injected ${code} namespace mkdir failure preserves the memory reservation with zero artifacts`,async t=>{
 const f=await fixture(t),target=namespace(f.root),input=request(0,'first-memory-reservation',[term()]);let fault=true;
 io.mkdir=async(directory,...args)=>{if(fault&&directory===target){fault=false;throw Object.assign(new Error('SYNTHETIC_NAMESPACE_MKDIR_FAILURE'),{code});}return nativeFs.mkdir(directory,...args);};
 await assert.rejects(f.store.apply(alice,project,input),{code:'CONTEXT_COMMIT_UNKNOWN'});io.mkdir=nativeFs.mkdir;
 assert.deepEqual(await nativeFs.readdir(f.root),[],'the failure precedes every namespace/candidate/state artifact');
 await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
 await assert.rejects(f.store.snapshot(alice,project),{code:'CONTEXT_COMMIT_UNKNOWN'});
 await assert.rejects(f.store.apply(alice,project,request(0,'another-key',[term()])),{code:'CONTEXT_COMMIT_UNKNOWN'});
 await assert.rejects(f.store.apply(alice,project,request(0,'first-memory-reservation',[term('name','春樹','changed')])),{code:'CONTEXT_IDEMPOTENCY_CONFLICT'});
 assert.deepEqual(await nativeFs.readdir(f.root),[],'a different key cannot bypass the retained unknown operation');
 const recovered=await f.store.apply(alice,project,input);assert.equal(recovered.revision,1);assert.equal(recovered.appliedRevision,1);assert.equal(recovered.terms[0].history.length,1);
 const replay=await f.store.apply(alice,project,input);assert.equal(replay.replayed,true);assert.equal(replay.revision,1);
 const disk=JSON.parse(await nativeFs.readFile(path.join(target,'state.json'),'utf8'));assert.equal(disk.receipts.length,1);assert.equal(disk.entries[0].history.length,1);
});

test('corrupt committed state fails closed and preserves the original bytes',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'seed',[term()]));
 const stateFile=path.join(namespace(f.root),'state.json'),bytes=Buffer.from('{"broken":');await nativeFs.writeFile(stateFile,bytes);
 await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_CORRUPT'});await assert.rejects(f.store.apply(alice,project,request(1,'new',[term()])),{code:'CONTEXT_CORRUPT'});assert.deepEqual(await nativeFs.readFile(stateFile),bytes);
});

test('a valid JSON edit with a stale checksum also fails closed',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'seed',[term()]));
 const stateFile=path.join(namespace(f.root),'state.json'),state=JSON.parse(await nativeFs.readFile(stateFile,'utf8'));state.entries[0].history[0].value.target='altered';const bytes=Buffer.from(JSON.stringify(state));await nativeFs.writeFile(stateFile,bytes);
 await assert.rejects(f.store.get(alice,project),{code:'CONTEXT_CORRUPT'});assert.deepEqual(await nativeFs.readFile(stateFile),bytes);
});

test('a valid context file copied into another owner namespace is not accepted as that owner',async t=>{
 const f=await fixture(t);await f.store.apply(alice,project,request(0,'seed',[term()]));const bytes=await nativeFs.readFile(path.join(namespace(f.root),'state.json'));
 const other=namespace(f.root,bob);await nativeFs.mkdir(other);await nativeFs.writeFile(path.join(other,'state.json'),bytes);
 await assert.rejects(f.store.get(bob,project),{code:'CONTEXT_CORRUPT'});assert.deepEqual(await nativeFs.readFile(path.join(other,'state.json')),bytes);assert.equal((await f.store.get(alice,project)).revision,1);
});
