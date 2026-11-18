/** User terminology only. This client never starts AI or edits page content. */
export const CONTEXT_INTENT_PREFIX='mangohana.context-intent.v1:';
export const SAVED_CONTEXT_NOTICE='이번 처리에 반영되는지는 결과에서 확인해 주세요.';
export type ContextScope={projectId:string;pageId:string;regionId:string;source:string;translation:string};
export type TermPair={source:string;target:string};
type Condition={speaker?:string;dialogueType?:'speech'|'thought'|'narration'|'unknown';targetContext?:string};
export type TermValue=TermPair&{id:string;note?:string;category?:'character'|'skill'|'location'|'tone'|'general'|'honorific';condition?:Condition;priority?:number};
export type SavedTerm={id:string;status:'AI_PROPOSED'|'USER_MODIFIED'|'USER_CONFIRMED';value:TermValue;currentRevision:number};
export type ProjectContext={projectId:string;scopeId:string;revision:number;terms:SavedTerm[]};
type Change={type:'upsert_term';term:TermValue}|{type:'confirm_term';id:string;expectedEntryRevision:number};
type Command={expected_revision:number;idempotency_key:string;changes:[Change]};
export type TermReview=TermPair&{projectId:string;scopeId:string;contextRevision:number;id:string;entryRevision:number};
export type ContextIntent={version:1;nonce:string;projectId:string;scopeId?:string;scope:Pick<ContextScope,'projectId'|'pageId'|'regionId'>;createdAt:string;state:'pending'|'conflict'|'rejected';body:Command;pair:TermPair};
export type ContextState={scope:Readonly<ContextScope>;status:'idle'|'loading'|'ready'|'writing'|'unknown'|'conflict'|'error';busy:boolean;canonical:ProjectContext|null;observedScopeId?:string;scopeBlocked:boolean;draft:TermPair;pending:ContextIntent[];retired:ContextIntent[];needsReload:boolean;error?:string;storageError?:string;notice?:string};
export type ContextStorage=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
type Options={fetcher?:typeof fetch;storage?:ContextStorage;nonce?:()=>string};
const id=/^[A-Za-z0-9_-]{1,128}$/,controls=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const statuses=new Set(['AI_PROPOSED','USER_MODIFIED','USER_CONFIRMED']);
const validScope=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const text=(value:unknown,max=200):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!controls.test(value);
const fail=(message='저장된 작품 표기 응답을 확인하지 못했어요.')=>new Error(message);
function frozen<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))frozen(item);Object.freeze(value);}return value;}
function keys(value:Record<string,unknown>,allowed:string[],required=allowed){if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw fail();}
function termValue(value:unknown):TermValue{
 if(!object(value))throw fail();keys(value,['id','source','target','note','category','condition','priority'],['id','source','target']);
 if(typeof value.id!=='string'||!id.test(value.id)||!text(value.source)||!text(value.target))throw fail();
 const result:TermValue={id:value.id,source:value.source,target:value.target};
 if(value.note!==undefined){if(typeof value.note!=='string'||value.note.length>1000||controls.test(value.note))throw fail();result.note=value.note;}
 if(value.category!==undefined){if(!['character','skill','location','tone','general','honorific'].includes(String(value.category)))throw fail();result.category=value.category as TermValue['category'];}
 if(value.priority!==undefined){if(!count(value.priority)||value.priority>1000)throw fail();result.priority=value.priority;}
 if(value.condition!==undefined){
  if(!object(value.condition))throw fail();keys(value.condition,['speaker','dialogueType','targetContext'],[]);const condition:Condition={};
  if(value.condition.speaker!==undefined){if(!text(value.condition.speaker,128))throw fail();condition.speaker=value.condition.speaker;}
  if(value.condition.dialogueType!==undefined){if(!['speech','thought','narration','unknown'].includes(String(value.condition.dialogueType)))throw fail();condition.dialogueType=value.condition.dialogueType as Condition['dialogueType'];}
  if(value.condition.targetContext!==undefined){if(!text(value.condition.targetContext,500))throw fail();condition.targetContext=value.condition.targetContext;}
  result.condition=condition;
 }
 return result;
}
function context(value:unknown,projectId:string):ProjectContext{
 if(!object(value)||value.projectId!==projectId||!validScope(value.scopeId)||!count(value.revision)||!Array.isArray(value.terms)||value.terms.length>1000)throw fail();
 const seen=new Set<string>(),revision=value.revision;
 const terms=value.terms.map(item=>{
  if(!object(item)||typeof item.id!=='string'||seen.has(item.id)||!statuses.has(String(item.status))||!count(item.currentRevision)||item.currentRevision<1||item.currentRevision>revision)throw fail();
  const parsed=termValue(item.value);if(parsed.id!==item.id)throw fail();seen.add(item.id);
  return {id:item.id,status:item.status as SavedTerm['status'],value:parsed,currentRevision:item.currentRevision};
 });
 return frozen({projectId,scopeId:value.scopeId,revision,terms});
}
function command(value:unknown):Command{
 if(!object(value))throw fail();keys(value,['expected_revision','idempotency_key','changes']);
 if(!count(value.expected_revision)||typeof value.idempotency_key!=='string'||!Array.isArray(value.changes)||value.changes.length!==1)throw fail();
 const change=value.changes[0];if(!object(change))throw fail();let parsed:Change;
 if(change.type==='upsert_term'){keys(change,['type','term']);parsed={type:'upsert_term',term:termValue(change.term)};}
 else{keys(change,['type','id','expectedEntryRevision']);if(change.type!=='confirm_term'||typeof change.id!=='string'||!id.test(change.id)||!count(change.expectedEntryRevision))throw fail();parsed={type:'confirm_term',id:change.id,expectedEntryRevision:change.expectedEntryRevision};}
 return {expected_revision:value.expected_revision,idempotency_key:value.idempotency_key,changes:[parsed]};
}
function record(value:unknown,projectId:string):ContextIntent{
 if(!object(value))throw fail();keys(value,['version','nonce','projectId','scopeId','scope','createdAt','state','body','pair'],['version','nonce','projectId','scope','createdAt','state','body','pair']);
 if(value.version!==1||value.projectId!==projectId||typeof value.nonce!=='string'||!id.test(value.nonce)||!['pending','conflict','rejected'].includes(String(value.state))||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!object(value.scope)||!object(value.pair))throw fail();
 keys(value.scope,['projectId','pageId','regionId']);keys(value.pair,['source','target']);
 if(value.scope.projectId!==projectId||!text(value.scope.pageId)||!text(value.scope.regionId)||!text(value.pair.source)||!text(value.pair.target))throw fail();
 if(Object.hasOwn(value,'scopeId')&&!validScope(value.scopeId))throw fail();
 const body=command(value.body);if(body.idempotency_key!=='context:'+value.nonce)throw fail();
 if(body.changes[0].type==='upsert_term'&&(body.changes[0].term.source!==value.pair.source||body.changes[0].term.target!==value.pair.target))throw fail();
 return frozen<ContextIntent>({version:1,nonce:value.nonce,projectId,...(validScope(value.scopeId)?{scopeId:value.scopeId}:{}),scope:{projectId,pageId:value.scope.pageId,regionId:value.scope.regionId},createdAt:value.createdAt,state:value.state as ContextIntent['state'],body,pair:{source:value.pair.source,target:value.pair.target}});
}
const unconditional=(term:SavedTerm)=>!term.value.condition||Object.keys(term.value.condition).length===0;
export function matchingTerms(state:ContextState){return state.canonical?.terms.filter(term=>term.value.source===state.draft.source)??[];}
export function contextIntentBlocked(state:ContextState,intent:ContextIntent){return !validScope(intent.scopeId)||!validScope(state.observedScopeId)||state.scopeBlocked||intent.scopeId!==state.observedScopeId;}
function review(state:ContextState):TermReview|null{
 const candidates=matchingTerms(state).filter(unconditional),entry=candidates[0];
 if(state.busy||state.storageError||state.needsReload||state.pending.length||candidates.length!==1||entry.status!=='USER_MODIFIED'||entry.value.target!==state.draft.target||!state.canonical||state.scopeBlocked||state.canonical.scopeId!==state.observedScopeId)return null;
 return {projectId:state.scope.projectId,scopeId:state.canonical.scopeId,contextRevision:state.canonical.revision,id:entry.id,entryRevision:entry.currentRevision,source:entry.value.source,target:entry.value.target};
}

export function createStudioContextSession(selected:ContextScope,{fetcher=globalThis.fetch,storage,nonce=()=>crypto.randomUUID()}:Options={}){
 if(typeof selected.projectId!=='string'||!id.test(selected.projectId)||!text(selected.pageId)||!text(selected.regionId)||typeof selected.source!=='string'||typeof selected.translation!=='string')throw fail('선택한 작품과 대사 정보를 확인해 주세요.');
 const scope=Object.freeze({...selected}),prefix=CONTEXT_INTENT_PREFIX+scope.projectId+':',url='/api/engine/projects/'+encodeURIComponent(scope.projectId)+'/context';
 let state:ContextState={scope,status:'idle',busy:false,canonical:null,scopeBlocked:false,draft:{source:'',target:''},pending:[],retired:[],needsReload:false};
 let generation=0,active=true,controller:AbortController|undefined;const listeners=new Set<()=>void>();
 const update=(patch:Partial<ContextState>)=>{if(!active)return;state={...state,...patch};for(const listener of listeners)listener();};
 const message=(cause:unknown)=>cause instanceof Error?cause.message:'표기 저장 여부를 확인하지 못했어요.';
 function requiredStorage(){if(!storage)throw fail('표기 요청을 안전하게 보관할 저장 공간을 사용할 수 없어요.');return storage;}
 function records(){
  const durable=requiredStorage(),result:ContextIntent[]=[];
  for(let index=0;index<durable.length;index++){
   const key=durable.key(index);if(!key?.startsWith(prefix))continue;
   const raw=durable.getItem(key);if(!raw||raw.length>16384)throw fail();const parsed=record(JSON.parse(raw),scope.projectId);
   if(key!==prefix+parsed.nonce)throw fail();result.push(parsed);
  }
  return result;
 }
 function syncPending(){
  try{const all=records();update({pending:all.filter(item=>item.state==='pending'),retired:all.filter(item=>item.state!=='pending'),storageError:undefined});return true;}
  catch{update({storageError:'보관한 표기 요청을 확인하지 못했어요. 원기록은 유지했으며 새 요청을 보내지 않아요.'});return false;}
 }
 function persist(intent:ContextIntent,previous?:ContextIntent){
  const durable=requiredStorage(),key=prefix+intent.nonce,current=durable.getItem(key);
  if(previous?current!==JSON.stringify(previous):current!==null)throw fail('다른 표기 요청 기록이 있어 덮어쓰지 않았어요.');
  const raw=JSON.stringify(intent);durable.setItem(key,raw);if(durable.getItem(key)!==raw)throw fail('표기 요청의 안전한 보관을 확인하지 못했어요.');
 }
 function remove(intent:ContextIntent){const durable=requiredStorage(),key=prefix+intent.nonce,current=durable.getItem(key);if(current===null)return;if(current!==JSON.stringify(intent))throw fail('표기 요청 기록이 바뀌어 지우지 않았어요.');durable.removeItem(key);if(durable.getItem(key)!==null)throw fail('표기 요청 기록 정리를 확인하지 못했어요.');}
 const current=(ticket:number)=>active&&ticket===generation;
 function begin(){controller?.abort();controller=new AbortController();return {ticket:++generation,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])};}
 function accept(parsed:ProjectContext){if(state.canonical&&parsed.scopeId===state.canonical.scopeId&&parsed.revision<state.canonical.revision)throw fail('이전 버전의 표기 응답이라 현재 저장 내용을 유지했어요.');}
 async function load(){
  if(!active||state.status==='writing')return;syncPending();const {ticket,signal}=begin();let responseScope:string|undefined;update({busy:true,status:'loading',error:undefined});
  try{
   const response=await fetcher(url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal});
   const raw:unknown=await response.json();if(!current(ticket))return;responseScope=object(raw)&&validScope(raw.scopeId)?raw.scopeId:undefined;
   update({observedScopeId:responseScope,scopeBlocked:responseScope?false:state.scopeBlocked});
   if(!response.ok)throw fail('저장된 표기를 불러오지 못했어요. 기존 내용과 작성 중인 표기는 유지해요.');
   const parsed=context(raw,scope.projectId);accept(parsed);
   update({canonical:parsed,busy:false,status:state.pending.length?'unknown':'ready',needsReload:false,notice:state.needsReload?'최신 저장 내용을 불러왔어요. 작성한 표기는 그대로 유지했어요.':state.notice});
  }catch(cause){if(current(ticket))update({busy:false,observedScopeId:responseScope,needsReload:true,status:state.pending.length?'unknown':'error',error:message(cause)});}
 }
 function validateAck(raw:unknown,intent:ContextIntent){
  const parsed=context(raw,scope.projectId);if(parsed.scopeId!==intent.scopeId||!object(raw)||raw.appliedRevision!==intent.body.expected_revision+1||typeof raw.replayed!=='boolean'||parsed.revision<Number(raw.appliedRevision)||!Array.isArray(raw.terms))throw fail();
  const change=intent.body.changes[0],termId=change.type==='upsert_term'?change.term.id:change.id;
  const item=raw.terms.find(value=>object(value)&&value.id===termId);if(!object(item)||!Array.isArray(item.history))throw fail();
  const version=item.history.find(value=>object(value)&&value.revision===raw.appliedRevision);
  if(!object(version)||version.status!==(change.type==='upsert_term'?'USER_MODIFIED':'USER_CONFIRMED'))throw fail();
  const saved=termValue(version.value);if(saved.id!==termId||saved.source!==intent.pair.source||saved.target!==intent.pair.target)throw fail();
  return parsed;
 }
 async function send(intent:ContextIntent){
  if(contextIntentBlocked(state,intent))return;
  const {ticket,signal}=begin();update({busy:true,status:'writing',error:undefined,notice:undefined});
  try{
   // The cookie remains the authority; this opaque scope only binds an old intent.
   const response=await fetcher(url,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-Mangohana-Context-Scope':intent.scopeId!},body:JSON.stringify(intent.body),signal});
   const raw:unknown=await response.json();
   if(!current(ticket))return;
   const responseScope=object(raw)&&validScope(raw.scopeId)?raw.scopeId:undefined;
   if(object(raw)&&raw.code==='CONTEXT_SCOPE_CHANGED'||responseScope&&responseScope!==intent.scopeId){
    update({observedScopeId:responseScope,scopeBlocked:true,busy:false,status:'unknown',error:'접속 정보가 바뀌었어요. 이전 저장 여부는 아직 확인되지 않았으며 원래 요청과 작성한 표기는 유지해요.'});return;
   }
   if(!responseScope)throw fail('표기 응답의 접속 정보를 확인하지 못했어요. 원래 요청을 유지해요.');
   if(!response.ok){
    if([400,401,403,404,413,422].includes(response.status)||response.status===409&&object(raw)&&['CONTEXT_REVISION_CONFLICT','CONTEXT_TERM_CONFLICT'].includes(String(raw.code))){
     const rejected=frozen<ContextIntent>({...intent,state:response.status===409?'conflict':'rejected'});persist(rejected,intent);syncPending();
     update({busy:false,status:response.status===409?'conflict':'error',needsReload:response.status===409||state.needsReload,error:response.status===409?'다른 변경과 충돌했어요. 작성한 표기는 유지했으니 최신 저장 내용을 불러와 확인해 주세요.':'표기 변경이 거절됐어요. 작성한 내용을 확인해 주세요.'});return;
    }
    throw fail('저장 여부를 확인하지 못했어요. 보관한 같은 요청으로 확인해 주세요.');
   }
   const parsed=validateAck(raw,intent);if(!current(ticket))return;accept(parsed);
   update({canonical:parsed,observedScopeId:parsed.scopeId,scopeBlocked:false});remove(intent);syncPending();
   update({busy:false,status:state.pending.length?'unknown':'ready',needsReload:false,notice:(intent.body.changes[0].type==='confirm_term'?'표기를 확정해 저장했어요.':'표기는 저장했어요. 내용을 확인한 뒤 별도로 확정할 수 있어요.')+' '+SAVED_CONTEXT_NOTICE});
  }catch(cause){if(current(ticket)){syncPending();update({busy:false,status:'unknown',error:message(cause)+' 보관한 요청의 저장 여부를 다시 확인할 수 있어요.'});}}
 }
 function canStart(){return active&&!state.busy&&!!state.canonical&&!state.scopeBlocked&&state.canonical.scopeId===state.observedScopeId&&!state.needsReload&&syncPending()&&!state.pending.length;}
 async function prepare(change:Change,pair:TermPair,operationNonce:string){
  const intent=frozen<ContextIntent>({version:1,nonce:operationNonce,projectId:scope.projectId,scopeId:state.canonical!.scopeId,scope:{projectId:scope.projectId,pageId:scope.pageId,regionId:scope.regionId},createdAt:new Date().toISOString(),state:'pending',body:{expected_revision:state.canonical!.revision,idempotency_key:'context:'+operationNonce,changes:[change]},pair:{...pair}});
  try{persist(intent);if(!syncPending()){update({error:'보관한 요청을 다시 확인하지 못해 서버 전송을 시작하지 않았어요.'});return;}}catch(cause){update({storageError:message(cause),error:'표기 요청을 보관하지 못해 서버에 보내지 않았어요.'});return;}
  await send(intent);
 }
 async function save(){
  if(!canStart())return;
  const pair={...state.draft};if(!text(pair.source)||!text(pair.target)){update({error:'일본어 원문과 한국어 표기를 각각 200자 안으로 입력해 주세요.'});return;}
  const matches=matchingTerms(state),plain=matches.filter(unconditional);
  if(plain.length>1||matches.length&&!plain.length){update({error:'같은 원문의 조건부 또는 여러 저장 항목이 있어 이 간단한 입력으로 덮어쓰지 않아요.'});return;}
  const operationNonce=nonce();if(typeof operationNonce!=='string'||!id.test(operationNonce)){update({error:'요청 식별자를 만들지 못했어요.'});return;}
  await prepare({type:'upsert_term',term:{...(plain[0]?.value??{id:operationNonce}),...pair}},pair,operationNonce);
 }
 async function confirm(shown:TermReview|null){
  if(!canStart())return;const latest=review(state);if(!shown||!latest||JSON.stringify(shown)!==JSON.stringify(latest)){update({error:'현재 저장된 표기를 다시 읽고 확인해 주세요.'});return;}
  const operationNonce=nonce();if(typeof operationNonce!=='string'||!id.test(operationNonce))return;
  await prepare({type:'confirm_term',id:latest.id,expectedEntryRevision:latest.entryRevision},{source:latest.source,target:latest.target},operationNonce);
 }
 async function recover(operationNonce:string){
  if(!active||state.busy||!syncPending())return;const intent=state.pending.find(item=>item.nonce===operationNonce);if(intent)await send(intent);
 }
 return {
  getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  setDraft:(draft:TermPair)=>{if(active&&state.status!=='writing')update({draft:{source:draft.source,target:draft.target},error:undefined,notice:undefined});},
  getReview:()=>review(state),load,save,confirm,recover,syncPending,
  activate:()=>{active=true;generation++;controller?.abort();syncPending();update({busy:false,status:state.pending.length?'unknown':state.canonical?'ready':'idle'});},
  dispose:()=>{active=false;generation++;controller?.abort();},
 };
}
export type StudioContextSession=ReturnType<typeof createStudioContextSession>;
