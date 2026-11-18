import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,readdir,open,rename} from 'node:fs/promises';
import path from 'node:path';

export const CONTEXT_LIMITS=Object.freeze({bytes:4*1024*1024,terms:1000,profiles:100,versions:100,receipts:2000,changes:100});
const digest=value=>createHash('sha256').update(value).digest('hex'),shaPattern=/^[a-f0-9]{64}$/;
const idPattern=/^[A-Za-z0-9_-]{1,128}$/,keyPattern=/^[A-Za-z0-9._:-]{1,200}$/;
const pendingPattern=/^\.pending-[a-f0-9-]{36}\.json$/,controls=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ownedRoots=new Set(),statuses=new Set(['AI_PROPOSED','USER_MODIFIED','USER_CONFIRMED']);
const error=(status,code,message)=>Object.assign(new Error(message),{status,code});
const must=(condition,code='CONTEXT_INPUT_INVALID',status=422)=>{if(!condition)throw error(status,code,'작품 문맥 기록과 요청을 확인해 주세요.');};
const unknown=()=>error(503,'CONTEXT_COMMIT_UNKNOWN','문맥 변경의 저장 여부를 확인하지 못했습니다. 원자료와 요청 식별자를 보존하고 같은 요청으로 확인해 주세요.');
const corrupt=()=>error(503,'CONTEXT_CORRUPT','저장된 작품 문맥의 무결성을 확인하지 못했습니다. 원기록은 보존했습니다.');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const text=(value,max,empty=false)=>typeof value==='string'&&value.length<=max&&!controls.test(value)&&(empty||value.trim().length>0);
const counter=value=>Number.isSafeInteger(value)&&value>=0;
const validId=value=>typeof value==='string'&&idPattern.test(value);
const validSha=value=>typeof value==='string'&&shaPattern.test(value);
const clone=value=>structuredClone(value);
function shape(value,allowed,required=[]){must(plain(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key)));}
function canonical(value){return JSON.stringify(sortValue(value));}
function sortValue(value){return Array.isArray(value)?value.map(sortValue):plain(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,sortValue(value[key])])):value;}
function checksum(value){const {checksum:_ignored,...content}=value;return digest(canonical(content));}
function seal(value){return {...value,checksum:checksum(value)};}
function identity(owner,projectId){must(typeof owner==='string'&&shaPattern.test(owner)&&typeof projectId==='string'&&idPattern.test(projectId));}
function reference(value){
  if(value===undefined)return undefined;
  shape(value,['sourceJobId','pageId','pageNumber','regionId','sourceSha256','reportSha256','editRevision']);
  for(const key of ['sourceJobId','pageId'])if(value[key]!==undefined)must(typeof value[key]==='string'&&idPattern.test(value[key]));
  if(value.regionId!==undefined)must(text(value.regionId,200));
  if(value.pageNumber!==undefined)must(Number.isSafeInteger(value.pageNumber)&&value.pageNumber>0&&value.pageNumber<=100000);
  for(const key of ['sourceSha256','reportSha256'])if(value[key]!==undefined)must(typeof value[key]==='string'&&shaPattern.test(value[key]));
  if(value.editRevision!==undefined)must(counter(value.editRevision));
  return clone(value);
}
function term(value){
  shape(value,['id','source','target','note','category','condition','priority'],['id','source','target']);
  must(validId(value.id)&&text(value.source,200)&&text(value.target,200));
  if(value.note!==undefined)must(text(value.note,1000,true));
  if(value.category!==undefined)must(['character','skill','location','tone','general','honorific'].includes(value.category));
  if(value.priority!==undefined)must(counter(value.priority)&&value.priority<=1000);
  if(value.condition!==undefined){shape(value.condition,['speaker','dialogueType','targetContext']);if(value.condition.speaker!==undefined)must(text(value.condition.speaker,128));if(value.condition.dialogueType!==undefined)must(['speech','thought','narration','unknown'].includes(value.condition.dialogueType));if(value.condition.targetContext!==undefined)must(text(value.condition.targetContext,500));}
  return clone(value);
}
function profile(value){
  shape(value,['id','name','aliases','description','speechStyle','relationshipNotes'],['id','name','aliases']);
  must(validId(value.id)&&text(value.name,200)&&Array.isArray(value.aliases)&&value.aliases.length<=30&&value.aliases.every(alias=>text(alias,200)));
  for(const key of ['description','speechStyle','relationshipNotes'])if(value[key]!==undefined)must(text(value[key],1000,true));
  return clone(value);
}
function captureRequest(input,mode){
  shape(input,['expectedRevision','idempotencyKey','changes'],['expectedRevision','idempotencyKey','changes']);
  must(counter(input.expectedRevision)&&typeof input.idempotencyKey==='string'&&keyPattern.test(input.idempotencyKey)&&Array.isArray(input.changes)&&input.changes.length>0&&input.changes.length<=CONTEXT_LIMITS.changes);
  const seen=new Set(),changes=input.changes.map(change=>{
    must(plain(change)&&typeof change.type==='string');const kind=change.type.endsWith('_term')?'term':change.type.endsWith('_profile')?'profile':null;must(kind);
    if(change.type===(mode==='apply'?'upsert_':'propose_')+kind){shape(change,['type',kind,'reference'],['type',kind]);const value=kind==='term'?term(change[kind]):profile(change[kind]);reference(change.reference);must(!seen.has(kind+':'+value.id));seen.add(kind+':'+value.id);return clone(change);}
    must(mode==='apply'&&change.type==='confirm_'+kind);shape(change,['type','id','expectedEntryRevision'],['type','id','expectedEntryRevision']);must(validId(change.id)&&counter(change.expectedEntryRevision));must(!seen.has(kind+':'+change.id));seen.add(kind+':'+change.id);return clone(change);
  });
  const request={expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey,changes};
  return {...request,mode,digest:digest(canonical({mode,...request}))};
}
function empty(owner,projectId){return seal({version:1,owner,projectId,revision:0,entries:[],receipts:[],createdAt:null,updatedAt:null,previousChecksum:null});}
const current=entry=>entry.history.find(version=>version.revision===entry.currentRevision);
function validateDocument(value,owner,projectId){
  try{
    shape(value,['version','owner','projectId','revision','entries','receipts','createdAt','updatedAt','previousChecksum','checksum'],['version','owner','projectId','revision','entries','receipts','checksum']);
    must(value.version===1&&value.owner===owner&&value.projectId===projectId&&counter(value.revision)&&validSha(value.checksum)&&checksum(value)===value.checksum);
    must(Array.isArray(value.entries)&&Array.isArray(value.receipts)&&value.receipts.length===value.revision&&value.receipts.length<=CONTEXT_LIMITS.receipts);
    must(value.revision===0?value.createdAt===null&&value.updatedAt===null&&value.previousChecksum===null:Number.isFinite(Date.parse(value.createdAt))&&Number.isFinite(Date.parse(value.updatedAt))&&validSha(value.previousChecksum));
    const ids=new Set();let terms=0,profiles=0;
    for(const entry of value.entries){
      shape(entry,['kind','id','currentRevision','history'],['kind','id','currentRevision','history']);must(['term','profile'].includes(entry.kind)&&validId(entry.id)&&!ids.has(entry.kind+':'+entry.id));ids.add(entry.kind+':'+entry.id);
      entry.kind==='term'?terms++:profiles++;must(Array.isArray(entry.history)&&entry.history.length>0&&entry.history.length<=CONTEXT_LIMITS.versions);let effective,previousRevision=0;
      for(const version of entry.history){
        shape(version,['revision','status','value','reference','createdAt'],['revision','status','value','createdAt']);must(counter(version.revision)&&version.revision>previousRevision&&version.revision<=value.revision&&statuses.has(version.status)&&Number.isFinite(Date.parse(version.createdAt)));previousRevision=version.revision;
        const item=entry.kind==='term'?term(version.value):profile(version.value);must(item.id===entry.id);reference(version.reference);
        if(version.status==='USER_CONFIRMED')must(effective&&canonical(version.value)===canonical(effective.value)&&canonical(version.reference??null)===canonical(effective.reference??null));
        if(version.status!=='AI_PROPOSED'||!effective||effective.status==='AI_PROPOSED')effective=version;
      }
      must(effective&&entry.currentRevision===effective.revision&&current(entry));
    }
    must(terms<=CONTEXT_LIMITS.terms&&profiles<=CONTEXT_LIMITS.profiles);
    const keys=new Set();for(const [index,receipt] of value.receipts.entries()){shape(receipt,['key','digest','mode','appliedRevision','createdAt'],['key','digest','mode','appliedRevision','createdAt']);must(typeof receipt.key==='string'&&keyPattern.test(receipt.key)&&!keys.has(receipt.key)&&validSha(receipt.digest)&&['apply','propose'].includes(receipt.mode)&&receipt.appliedRevision===index+1&&Number.isFinite(Date.parse(receipt.createdAt)));keys.add(receipt.key);}
    return value;
  }catch{throw corrupt();}
}
function projection(document){return {projectId:document.projectId,revision:document.revision,...Object.fromEntries(['term','profile'].map(kind=>[kind==='term'?'terms':'profiles',document.entries.filter(entry=>entry.kind===kind).map(entry=>{const active=current(entry);return {id:entry.id,status:active.status,value:clone(active.value),currentRevision:entry.currentRevision,originalValue:clone(entry.history[0].value),proposals:clone(entry.history.filter(version=>version.status==='AI_PROPOSED')),history:clone(entry.history)};})]))};}
function reply(document,receipt,replayed){return {...projection(document),appliedRevision:receipt.appliedRevision,replayed};}
async function regularDirectory(location){const info=await lstat(location);must(info.isDirectory()&&!info.isSymbolicLink()&&samePath(await realpath(location),location),'CONTEXT_STORE_UNAVAILABLE',503);}
async function boundedFile(file){
  const before=await lstat(file);must(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=CONTEXT_LIMITS.bytes&&samePath(await realpath(file),file),'CONTEXT_CORRUPT',503);
  const handle=await open(file,'r');try{const first=await handle.stat();must(first.ino===before.ino&&first.dev===before.dev&&first.size===before.size,'CONTEXT_CORRUPT',503);const bytes=await handle.readFile(),last=await handle.stat(),named=await lstat(file);must(bytes.length===before.size&&last.size===first.size&&last.mtimeMs===first.mtimeMs&&!named.isSymbolicLink()&&named.ino===first.ino&&named.dev===first.dev,'CONTEXT_CORRUPT',503);return bytes;}finally{await handle.close();}
}
async function readDocument(file,owner,projectId){try{return validateDocument(JSON.parse((await boundedFile(file)).toString('utf8')),owner,projectId);}catch(cause){if(cause.code==='ENOENT')throw cause;throw corrupt();}}
function nextDocument(state,request){
  must(state.revision===request.expectedRevision,'CONTEXT_REVISION_CONFLICT',409);must(state.revision<Number.MAX_SAFE_INTEGER&&state.receipts.length<CONTEXT_LIMITS.receipts,'CONTEXT_LIMIT',413);
  const next=clone(state),now=new Date().toISOString();next.revision++;next.previousChecksum=state.checksum;next.createdAt??=now;next.updatedAt=now;
  for(const change of request.changes){
    const kind=change.type.endsWith('_term')?'term':'profile',id=change.id??change[kind].id;let entry=next.entries.find(value=>value.kind===kind&&value.id===id),active=entry&&current(entry),value,ref,status;
    if(change.type.startsWith('confirm_')){must(active&&entry.currentRevision===change.expectedEntryRevision,'CONTEXT_REVISION_CONFLICT',409);value=clone(active.value);ref=active.reference;status='USER_CONFIRMED';}
    else {value=clone(change[kind]);ref=change.reference;status=request.mode==='apply'?'USER_MODIFIED':'AI_PROPOSED';}
    if(!entry){entry={kind,id,currentRevision:next.revision,history:[]};next.entries.push(entry);}
    must(entry.history.length<CONTEXT_LIMITS.versions,'CONTEXT_LIMIT',413);
    entry.history.push({revision:next.revision,status,value,...(ref===undefined?{}:{reference:clone(ref)}),createdAt:now});
    if(status!=='AI_PROPOSED'||!active||active.status==='AI_PROPOSED')entry.currentRevision=next.revision;
  }
  const confirmed=new Map();for(const entry of next.entries.filter(value=>value.kind==='term')){const active=current(entry);if(active.status!=='USER_CONFIRMED')continue;const key=canonical({source:active.value.source,condition:active.value.condition??{}}),prior=confirmed.get(key);must(prior===undefined||prior===active.value.target,'CONTEXT_TERM_CONFLICT',409);confirmed.set(key,active.value.target);}
  must(next.entries.filter(entry=>entry.kind==='term').length<=CONTEXT_LIMITS.terms&&next.entries.filter(entry=>entry.kind==='profile').length<=CONTEXT_LIMITS.profiles,'CONTEXT_LIMIT',413);
  const receipt={key:request.idempotencyKey,digest:request.digest,mode:request.mode,appliedRevision:next.revision,createdAt:now};next.receipts.push(receipt);
  const sealed=seal(next);must(Buffer.byteLength(JSON.stringify(sealed,null,2))<=CONTEXT_LIMITS.bytes,'CONTEXT_LIMIT',413);return sealed;
}

/** One engine host owns this root. Previous-page verification and HTTP authorization are separate integrations. */
export async function createContextStore({root}={}){
  must(typeof root==='string'&&path.isAbsolute(root),'CONTEXT_STORE_UNAVAILABLE',503);const directory=path.resolve(root),rootKey=process.platform==='win32'?directory.toLowerCase():directory;
  must(directory!==path.parse(directory).root&&!ownedRoots.has(rootKey),'CONTEXT_STORE_IN_USE',503);ownedRoots.add(rootKey);
  try{await mkdir(directory,{recursive:true,mode:0o700});await regularDirectory(directory);}catch(cause){ownedRoots.delete(rootKey);throw cause;}
  const uncertain=new Map();let queue=Promise.resolve(),closed=false,closing;
  const serial=action=>{const operation=queue.then(()=>{must(!closed,'CONTEXT_STORE_CLOSED',503);return action();});queue=operation.catch(()=>{});return operation;};
  const location=(owner,projectId)=>path.join(directory,digest(owner+'\0'+projectId));
  async function load(owner,projectId){
    const target=location(owner,projectId);let entries;
    try{await regularDirectory(target);entries=await readdir(target,{withFileTypes:true});}catch(cause){if(cause.code==='ENOENT')return {target,state:empty(owner,projectId),pending:[],memory:uncertain.get(target)};throw cause;}
    const candidates=entries.filter(entry=>entry.name.startsWith('.pending-'));let state,missing=false;
    try{state=await readDocument(path.join(target,'state.json'),owner,projectId);}catch(cause){if(cause.code==='ENOENT'){missing=true;state=empty(owner,projectId);}else {if(candidates.length||uncertain.has(target))throw unknown();throw cause;}}
    if(missing&&entries.some(entry=>!entry.name.startsWith('.pending-')))throw unknown();
    const pending=[];
    for(const entry of candidates){
      if(!pendingPattern.test(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw unknown();
      let document;try{document=await readDocument(path.join(target,entry.name),owner,projectId);}catch{throw unknown();}
      const receipt=document.receipts.at(-1);if(!receipt)throw unknown();
      const committed=state.receipts.find(value=>value.key===receipt.key);
      if(committed?.digest===receipt.digest&&committed.appliedRevision===receipt.appliedRevision)continue;
      pending.push({file:path.join(target,entry.name),document});
    }
    const memory=uncertain.get(target);
    if(memory&&state.receipts.some(receipt=>receipt.key===memory.request.idempotencyKey&&receipt.digest===memory.request.digest))uncertain.delete(target);
    return {target,state,pending,memory:uncertain.get(target)};
  }
  async function publish(target,document,request,file,existing=false){
    const reservation={document,request,file};uncertain.set(target,reservation);
    try{
      try{await mkdir(target,{mode:0o700});}catch(cause){if(cause.code!=='EEXIST')throw cause;}await regularDirectory(target);
      if(!existing){const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(document,null,2));await handle.sync();}finally{await handle.close();}}
      await rename(file,path.join(target,'state.json'));uncertain.delete(target);return reply(document,document.receipts.at(-1),false);
    }catch{throw unknown();}
  }
  async function mutate(owner,projectId,input,mode){
    identity(owner,projectId);const request=captureRequest(input,mode);
    return serial(async()=>{
      const loaded=await load(owner,projectId),{target,state,pending,memory}=loaded,prior=state.receipts.find(receipt=>receipt.key===request.idempotencyKey);
      if(prior)must(prior.digest===request.digest,'CONTEXT_IDEMPOTENCY_CONFLICT',409);
      const unresolved=pending.length?pending:memory?[{file:memory.file,document:memory.document,memory:true}]:[];
      if(unresolved.length){
        must(unresolved.length===1,'CONTEXT_COMMIT_UNKNOWN',503);const candidate=unresolved[0],receipt=candidate.document.receipts.at(-1);
        if(receipt.key===request.idempotencyKey)must(receipt.digest===request.digest,'CONTEXT_IDEMPOTENCY_CONFLICT',409);else throw unknown();
        if(prior||candidate.document.previousChecksum!==state.checksum||candidate.document.revision!==state.revision+1||state.revision!==request.expectedRevision)throw unknown();
        if(memory&&memory.document.checksum!==candidate.document.checksum)throw unknown();
        return publish(target,candidate.document,request,candidate.file,!candidate.memory);
      }
      if(prior)return reply(state,prior,true);
      const next=nextDocument(state,request);return publish(target,next,request,path.join(target,'.pending-'+randomUUID()+'.json'));
    });
  }
  async function known(owner,projectId){const loaded=await load(owner,projectId);if(loaded.pending.length||loaded.memory)throw unknown();return loaded.state;}
  return Object.freeze({
    async get(owner,projectId){identity(owner,projectId);return serial(async()=>projection(await known(owner,projectId)));},
    // Preview only: validate persisted state without waiting behind a long inspection.
    // Pending/unknown commits still fail closed; mutations keep the serialized guard.
    async readRevision(owner,projectId){identity(owner,projectId);must(!closed,'CONTEXT_STORE_CLOSED',503);return (await known(owner,projectId)).revision;},
    // Server-only conditional commit; holds the same queue as glossary edits.
    async withRevision(owner,projectId,expectedRevision,commit){
      identity(owner,projectId);must(counter(expectedRevision)&&typeof commit==='function');
      return serial(async()=>{const state=await known(owner,projectId);must(state.revision===expectedRevision,'REVIEW_REVISION_CONFLICT',409);const revalidate=async()=>{const latest=await known(owner,projectId);must(latest.revision===expectedRevision&&latest.checksum===state.checksum,'REVIEW_REVISION_CONFLICT',409);};const result=await commit(revalidate);await revalidate();return result;});
    },
    apply:(owner,projectId,input)=>mutate(owner,projectId,input,'apply'),
    // Internal engine integration only; no browser route or automatic confirmation is supplied.
    propose:(owner,projectId,input)=>mutate(owner,projectId,input,'propose'),
    async snapshot(owner,projectId,options={}){
      identity(owner,projectId);shape(options,['sourceText']);if(options.sourceText!==undefined)must(text(options.sourceText,8000,true));const corpus=options.sourceText;
      return serial(async()=>{const state=await known(owner,projectId),terms=state.entries.filter(entry=>entry.kind==='term'&&current(entry).status==='USER_CONFIRMED').map(entry=>clone(current(entry).value)).filter(value=>corpus===undefined||corpus.includes(value.source)).sort((a,b)=>(b.priority??0)-(a.priority??0)||b.source.length-a.source.length||(a.id<b.id?-1:a.id>b.id?1:0));
        const profiles=state.entries.filter(entry=>entry.kind==='profile'&&current(entry).status==='USER_CONFIRMED').map(entry=>clone(current(entry).value));
        return {projectId,revision:state.revision,glossaryRevision:state.revision,terms,profiles,contentSha256:digest(canonical({version:1,owner,projectId,revision:state.revision,terms,profiles}))};});
    },
    close(){return closing??=(async()=>{await queue;closed=true;ownedRoots.delete(rootKey);})();},
  });
}
