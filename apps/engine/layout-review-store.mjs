import fs from 'node:fs/promises';import path from 'node:path';import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';import {createRequire} from 'node:module';
import {atomicState} from './store.mjs';import {readBounded} from './translation-review-store.mjs';
const require=createRequire(import.meta.url),{normalizeManualEntries,footprintFits,POLICY}=require('../../packages/ai-engine/quality/background-layout.cjs');
const {singleUtteranceLineVerified}=require('../../packages/ai-engine/quality/korean-utterance.cjs');
const {evaluateKoreanTypesetting,VERSION}=require('../../packages/ai-engine/quality/korean-typesetting-standard.cjs');
const {layoutPlanDigest}=require('../../packages/ai-engine/quality/layout-roi-contract.cjs');
const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex'),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),count=v=>Number.isSafeInteger(v)&&v>=0;
const error=(code,status=409)=>Object.assign(Error(code),{code,status}),must=(v,code,status)=>{if(!v)throw error(code,status);};
const exact=(v,keys)=>must(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k)),'LAYOUT_INPUT_INVALID',422);
const base=b=>({owner:b.current.ownerScope,documentId:b.documentId,documentSha256:b.documentSha256,projectId:b.current.projectId,pageId:b.current.pageId,pageNumber:b.current.pageNumber,editRevision:b.current.editRevision,contextRevision:b.current.contextRevision,sourceSha256:b.current.sourceSha256,normalizedSha256:b.current.normalizedSha256,eventSha256:b.receipt.eventSha256,selectedSetSha256:b.receipt.selectedSetSha256,sourceProcessingGeneration:b.sourceProcessingGeneration});
export async function createLayoutReviewStore({root,loadSource,measureText,resolveRoiExpansion,clock=()=>Date.now()}){
 must(path.isAbsolute(root??'')&&[loadSource,measureText,clock].every(f=>typeof f==='function'),'LAYOUT_STORE_CONFIG',503);
 const directory=path.resolve(root);let chain=Promise.resolve(),closed=false,key;
 const serial=fn=>{const p=chain.then(()=>{must(!closed,'LAYOUT_STORE_CLOSED',503);return fn();});chain=p.catch(()=>{});return p;};
 async function regular(dir){const s=await fs.lstat(dir);must(s.isDirectory()&&!s.isSymbolicLink()&&path.resolve(await fs.realpath(dir)).toLowerCase()===path.resolve(dir).toLowerCase(),'LAYOUT_STORE_CORRUPT',503);}
 async function secret(create=false){if(key)return key;const file=path.join(directory,'layout-key.bin');if(create){await fs.mkdir(directory,{recursive:true});await regular(directory);try{const h=await fs.open(file,'wx',0o600);try{await h.writeFile(randomBytes(32));await h.sync();}finally{await h.close();}}catch(e){if(e.code!=='EEXIST')throw e;}}
  key=await readBounded(file,32);must(key.length===32,'LAYOUT_STORE_CORRUPT',503);return key;
 }
 const seal=async v=>({...v,signature:createHmac('sha256',await secret(true)).update(JSON.stringify(v)).digest('hex')});
 async function verify(v){must(v&&typeof v==='object'&&hex(v.signature),'LAYOUT_STORE_CORRUPT',503);const {signature,...p}=v,mac=createHmac('sha256',await secret()).update(JSON.stringify(p)).digest();must(timingSafeEqual(mac,Buffer.from(signature,'hex')),'LAYOUT_STORE_CORRUPT',503);return v;}
 function target(b){must(hex(b?.documentId)&&hex(b?.current?.ownerScope),'LAYOUT_PAGE_NOT_FOUND',404);return path.join(directory,b.documentId);}
 const fileFor=(dir,n)=>{must(count(n)&&n>0&&n<=10000,'LAYOUT_STORE_CORRUPT',503);return path.join(dir,'revision-'+n+'.json');};
 async function current(b,context){const dir=target(b);let head;
  try{await regular(directory);await regular(dir);head=await verify(JSON.parse(await readBounded(path.join(dir,'head.json'),4096)));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  must(head.documentId===b.documentId&&count(head.layoutRevision),'LAYOUT_STORE_CORRUPT',503);
  const bytes=await readBounded(fileFor(dir,head.layoutRevision),256*1024),v=await verify(JSON.parse(bytes));must(digest(bytes)===head.sha256&&v.layoutRevision===head.layoutRevision,'LAYOUT_STORE_CORRUPT',503);
  must(v.binding.owner===b.current.ownerScope,'LAYOUT_PAGE_NOT_FOUND',404);must(digest(v.binding)===digest(base(b)),'LAYOUT_SOURCE_STALE');
  if(context)must(v.sourceReviewFingerprint===context.sourceReviewFingerprint,'LAYOUT_SOURCE_STALE');
  if(v.layoutRevision>1){const previous=await readBounded(fileFor(dir,v.layoutRevision-1),256*1024);await verify(JSON.parse(previous));must(digest(previous)===v.previousSha256,'LAYOUT_STORE_CORRUPT',503);}
  return {record:v,bytes,sha256:digest(bytes)};
 }
 const view=v=>v?{layoutRevision:v.layoutRevision,state:v.state,entries:structuredClone(v.entries),planSha256:v.planSha256,sourceReviewFingerprint:v.sourceReviewFingerprint,approval:structuredClone(v.approval),validation:structuredClone(v.validation),...(v.roiExpansion?{roiExpansion:structuredClone(v.roiExpansion)}:{}),executionAuthorized:false}:{layoutRevision:0,state:'UNREVIEWED',entries:[],planSha256:null,approval:null,executionAuthorized:false};
 async function resolveRoi(b,context,before,entries,reference,phase){
  if(!reference)return {context,roiExpansion:null};must(hex(reference)&&typeof resolveRoiExpansion==='function','ROI_APPROVAL_REQUIRED',403);
  const result=await resolveRoiExpansion({binding:b,context,before:before?.record??null,entries,reference,phase});must(result?.context?.sourceReviewFingerprint===context.sourceReviewFingerprint&&result.roiExpansion?.receiptId===reference&&result.roiExpansion.entriesSha256===digest(entries),'ROI_APPROVAL_STALE');return result;
 }
 async function validation(b,entries,context,signal){
  signal?.throwIfAborted();const normalized=normalizeManualEntries(entries,context.regions,context.width,context.height),measured=await measureText(normalized,context,{signal});signal?.throwIfAborted();
  must(measured?.fontLoaded===true&&measured.cleanupConfirmed===true&&Array.isArray(measured.entries)&&measured.entries.length===normalized.length&&new Set(measured.entries.map(e=>e.id)).size===normalized.length,'LAYOUT_MEASUREMENT_UNKNOWN',503);
  const checks=normalized.map(entry=>{const pixels=context.inspectEntry(entry),m=measured.entries.find(v=>v.id===entry.id),fits=!!m&&m.fontSizePx===entry.fontSizePx&&m.fontSizePx>12&&m.completeText===true&&m.fitsBox===true&&m.linesSeparated===true;
   const singleLineVerified=singleUtteranceLineVerified(context.regions.find(r=>r.id===entry.id).text,Array.isArray(m?.layout?.lines)?m.layout.lines.map(l=>l.text):null);
   const footprint=fits&&singleLineVerified&&pixels.sourceReviewable===true&&footprintFits(pixels.previewInterior,m.inkBounds),region=context.regions.find(r=>r.id===entry.id);
   const standard=evaluateKoreanTypesetting({text:region.text,lines:m?.layout?.lines?.map(l=>l.text),stage:'SOURCE_METRICS',fontSizePx:m?.fontSizePx,lineHeight:entry.lineHeight,shape:'rectangle',measurement:m,
    safety:{safeAreaVerified:footprint,otherRegionCollision:false,protectedArtworkCollision:false},glyphs:context.fontGlyphsVerified?{supported:true,missingGlyphOccurrences:0}:{},mapping:{expectedId:entry.id,actualId:m?.id,expectedOrder:region.order??0,actualOrder:region.order??0}});
   const sourceFootprintVerified=footprint&&standard.status!=='BLOCKED';
   return {id:entry.id,status:sourceFootprintVerified?'SOURCE_REVIEWABLE_CLEANED_PENDING':'MANUAL_LAYOUT_REQUIRED',sourceFootprintVerified,singleLineVerified,cleanedVerified:false,measurement:m,standard,sourceEvidence:pixels.evidence,reasonCodes:[...pixels.reasonCodes??[],...(!fits?['TEXT_FIT_NOT_VERIFIED']:[]),...(!singleLineVerified?['SINGLE_UTTERANCE_LINE_BREAK']:[]),...(!sourceFootprintVerified?['SOURCE_ARTWORK_OR_CONTRAST_COLLISION']:[]),...standard.hardViolations.map(v=>v.rule+':'+v.code)]};});
  const standardReviewSha256=digest({version:VERSION,sourceReviewFingerprint:context.sourceReviewFingerprint,entries:normalized,bundleSha256:measured.bundleSha256??null,checks:checks.map(c=>({id:c.id,standard:c.standard,sourceFootprintVerified:c.sourceFootprintVerified,inkBounds:c.measurement?.inkBounds}))});
  return {entries:normalized,status:checks.every(c=>c.sourceFootprintVerified)?'SOURCE_REVIEWABLE_CLEANED_PENDING':'MANUAL_LAYOUT_REQUIRED',checks,standardReviewSha256,measurementKind:'REAL_FONT_TEXT_METRICS_NO_PAGE_PAINT',cleanedVerified:false,executionAuthorized:false,sourceReviewFingerprint:context.sourceReviewFingerprint};
 }
 async function commit(b,context,before,value){
  await fs.mkdir(directory,{recursive:true});await regular(directory);const lock=path.join(directory,'.writer-lock');try{await fs.mkdir(lock);}catch(e){if(e.code==='EEXIST')throw error('LAYOUT_WRITE_BUSY');throw e;}
  try{const latest=await current(b,context);must((latest?.sha256??null)===(before?.sha256??null),'LAYOUT_REVISION_CONFLICT');
   const dir=target(b);await fs.mkdir(dir,{recursive:true});await regular(dir);const n=(before?.record.layoutRevision??0)+1;must(n<=10000,'LAYOUT_REVISION_LIMIT');
   const record=await seal({version:1,kind:'USER_LAYOUT_REVIEW',policy:POLICY,binding:base(b),source:structuredClone(context.source),sourceReviewFingerprint:context.sourceReviewFingerprint,layoutRevision:n,previousSha256:before?.sha256??null,...value,recordedAt:new Date(clock()).toISOString(),executionAuthorized:false});
   const file=fileFor(dir,n),h=await fs.open(file,'wx',0o600);const bytes=Buffer.from(JSON.stringify(record));try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
   await atomicState(dir,await seal({version:1,documentId:b.documentId,layoutRevision:n,sha256:digest(bytes)}),'head.json');return view(record);
  }finally{await fs.rmdir(lock);}
 }
 const validRequest=c=>must(typeof c.requestKey==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(c.requestKey)&&count(c.expectedLayoutRevision),'LAYOUT_INPUT_INVALID',422);
 async function contextFor(b){const context=await loadSource(b);must(context&&hex(context.sourceReviewFingerprint)&&Array.isArray(context.regions),'LAYOUT_SOURCE_UNAVAILABLE',503);return context;}
 return {
  async get(b,{context}={}){must(!closed,'LAYOUT_STORE_CLOSED',503);context??=await contextFor(b);return view((await current(b,context))?.record);},
  async validate(b,c,{context,signal}={}){exact(c,['expectedLayoutRevision','requestKey','entries',...(Object.hasOwn(c??{},'roiApproval')?['roiApproval']:[])]);validRequest(c);context??=await contextFor(b);const before=await current(b,context);must((before?.record.layoutRevision??0)===c.expectedLayoutRevision,'LAYOUT_REVISION_CONFLICT');const effective=await resolveRoi(b,context,before,c.entries,c.roiApproval,'validate');return validation(b,c.entries,effective.context,signal);},
  save(b,c,{context,signal}={}){return serial(async()=>{exact(c,['expectedLayoutRevision','requestKey','entries',...(Object.hasOwn(c??{},'roiApproval')?['roiApproval']:[])]);validRequest(c);context??=await contextFor(b);const before=await current(b,context),commandSha256=digest(c);
   if(before?.record.requestKey===c.requestKey){must(before.record.commandSha256===commandSha256,'LAYOUT_IDEMPOTENCY_CONFLICT');return {...view(before.record),duplicate:true};}
   must((before?.record.layoutRevision??0)===c.expectedLayoutRevision,'LAYOUT_REVISION_CONFLICT');const effective=await resolveRoi(b,context,before,c.entries,c.roiApproval,'save'),result=await validation(b,c.entries,effective.context,signal);must((await contextFor(b)).sourceReviewFingerprint===context.sourceReviewFingerprint,'LAYOUT_SOURCE_STALE');signal?.throwIfAborted();
   if(effective.roiExpansion)must(result.checks.every(c=>c.sourceFootprintVerified),'LAYOUT_SAFETY_BLOCKED',422);
   return commit(b,context,before,{state:'DRAFT',entries:result.entries,planSha256:layoutPlanDigest(context.sourceReviewFingerprint,result.entries,effective.roiExpansion),...(effective.roiExpansion?{roiExpansion:effective.roiExpansion}:{}),approval:null,validation:result,requestKey:c.requestKey,commandSha256});
  });},
  approve(b,c,{context,signal}={}){return serial(async()=>{exact(c,['expectedLayoutRevision','requestKey','planSha256','reviewAcknowledged',...(Object.hasOwn(c??{},'expectedStandardReviewSha256')?['expectedStandardReviewSha256']:[])]);validRequest(c);must(c.reviewAcknowledged===true&&hex(c.planSha256),'LAYOUT_APPROVAL_REQUIRED',403);context??=await contextFor(b);const before=await current(b,context),commandSha256=digest(c);
   if(before?.record.requestKey===c.requestKey){must(before.record.commandSha256===commandSha256,'LAYOUT_IDEMPOTENCY_CONFLICT');return {...view(before.record),duplicate:true};}
   must(before&&before.record.layoutRevision===c.expectedLayoutRevision&&before.record.planSha256===c.planSha256,'LAYOUT_REVISION_CONFLICT');must(before.record.state==='DRAFT','LAYOUT_APPROVAL_REQUIRED',403);
   const effective=await resolveRoi(b,context,before,before.record.entries,before.record.roiExpansion?.receiptId,'approve'),result=await validation(b,before.record.entries,effective.context,signal);must(result.checks.every(r=>r.sourceFootprintVerified),'LAYOUT_SAFETY_BLOCKED',422);must((await contextFor(b)).sourceReviewFingerprint===context.sourceReviewFingerprint,'LAYOUT_SOURCE_STALE');signal?.throwIfAborted();
   if(result.checks.some(r=>r.standard.status==='WARN')||Object.hasOwn(c,'expectedStandardReviewSha256'))must(hex(c.expectedStandardReviewSha256)&&c.expectedStandardReviewSha256===result.standardReviewSha256,'LAYOUT_STANDARD_REVIEW_STALE',409);
   return commit(b,context,before,{state:'APPROVED_SOURCE_LAYOUT_CLEANED_PENDING',entries:result.entries,planSha256:c.planSha256,...(effective.roiExpansion?{roiExpansion:effective.roiExpansion}:{}),approval:{kind:'USER_REVIEWED_LAYOUT_SOURCE',sourceReviewed:true,maskReviewed:true,artworkReviewed:true,translationPreserved:true,sourceDraftRevision:before.record.layoutRevision,approvedAt:new Date(clock()).toISOString(),cleanedVerified:false,humanFinalImageQualityVerified:false,imageExecutionAuthorized:false,typesettingStandard:{version:VERSION,reviewSha256:result.standardReviewSha256,regions:result.checks.map(r=>({id:r.id,codes:r.standard.softWarnings.map(v=>v.code)}))}},validation:result,requestKey:c.requestKey,commandSha256});
  });},
  async executionSnapshot(b){const v=(await current(b))?.record;if(!v)return {version:1,layoutRevision:0,state:'UNREVIEWED',entries:[],source:null,planSha256:null};must(v.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'&&v.approval?.sourceReviewed===true,'LAYOUT_APPROVAL_REQUIRED',423);
   must(v.entries.every(e=>{const text=b.regions?.find(r=>r.regionId===e.id)?.selectedUserTranslation??e.text,lines=v.validation?.checks?.find(c=>c.id===e.id)?.measurement?.layout?.lines;return singleUtteranceLineVerified(text,Array.isArray(lines)?lines.map(l=>l.text):null);}),'LAYOUT_APPROVAL_REQUIRED',423);
   if(v.roiExpansion)await resolveRoi(b,await contextFor(b),{record:v},v.entries,v.roiExpansion.receiptId,'execution');
   return {version:1,layoutRevision:v.layoutRevision,state:v.state,entries:structuredClone(v.entries),source:structuredClone(v.source),sourceReviewFingerprint:v.sourceReviewFingerprint,planSha256:v.planSha256,approval:structuredClone(v.approval),...(v.roiExpansion?{roiExpansion:structuredClone(v.roiExpansion)}:{})};},
  async history(b){const last=await current(b);if(!last)return [];const out=[];let previous=null;for(let n=1;n<=last.record.layoutRevision;n++){const bytes=await readBounded(fileFor(target(b),n),256*1024),r=await verify(JSON.parse(bytes));must(r.previousSha256===previous&&r.binding.owner===b.current.ownerScope,'LAYOUT_STORE_CORRUPT',503);previous=digest(bytes);out.push(view(r));}return out;},
  async close(){await chain;closed=true;key?.fill(0);}
 };
}
