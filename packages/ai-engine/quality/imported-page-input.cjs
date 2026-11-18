'use strict';
// Read-only input contract. Server callbacks are capabilities, never browser JSON.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {createCheckpointSession,key}=require('./recovery-checkpoint.cjs');
const {selectDialogueRegions}=require('./region-selection.cjs');
const sha=x=>createHash('sha256').update(Buffer.isBuffer(x)?x:typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const same=(a,b)=>key(a)===key(b),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function must(ok,code='IMPORTED_PAGE_INPUT_REJECTED'){if(!ok)throw Object.assign(Error('저장 승인·원래 OCR 출처·현재 페이지 입력이 일치하지 않습니다.'),{code,status:409});}
async function read(file,limit=16*1024*1024){
 const st=await fs.lstat(file);must(st.isFile()&&!st.isSymbolicLink()&&st.size>0&&st.size<=limit&&path.resolve(await fs.realpath(file))===path.resolve(file));
 const h=await fs.open(file,'r');try{const a=await h.stat(),b=await h.readFile(),z=await h.stat(),named=await fs.lstat(file);must(a.ino===st.ino&&a.dev===st.dev&&b.length===st.size&&a.mtimeMs===z.mtimeMs&&a.size===z.size&&named.ino===a.ino&&named.dev===a.dev&&!named.isSymbolicLink());return b;}finally{await h.close();}
}
function imageBytes(url){must(typeof url==='string'&&url.startsWith('data:image/png;base64,'));const encoded=url.slice(22),b=Buffer.from(encoded,'base64');must(b.length>24&&b.length<=8*1024*1024&&b.toString('base64')===encoded&&b.subarray(0,8).toString('hex')==='89504e470d0a1a0a');return b;}
async function inspectImportedPageInputs({binding:b,source,readCurrentOcr,signal}){
 signal?.throwIfAborted();must(b?.version==='saved-imported-page-input-v1'&&typeof readCurrentOcr==='function');
 const r=b.receipt,c=b.current,p=b.sourceProvenance,s=p?.scope;
 must(b.authenticationLevel==='ANONYMOUS_SESSION'&&b.accountAuth==='NOT_AVAILABLE'&&b.executionAuthorized===false&&b.independentSemanticVerification===null&&c.processingGeneration===null);
 must(r?.kind==='USER_TRANSLATION_IMPORT_AND_APPLICATION'&&r.executionAuthorized===false&&r.independentGroundTruthVerified===false&&r.userAcknowledgement?.explicitImport===true&&r.userAcknowledgement?.allSelectedTranslations===true&&r.userAcknowledgement?.risksAcceptedForApplication===true&&r.userAcknowledgement?.independentMeaningClaimed===false);
 must(r.documentId===b.documentId&&r.projectId===c.projectId&&r.pageId===c.pageId&&r.editRevision===c.editRevision&&r.contextRevision===c.contextRevision&&r.sessionScope===sha('mangohana-review-session-v1\0'+c.ownerScope)&&hex(b.documentSha256)&&hex(r.eventSha256));
 must(source&&path.isAbsolute(source.directory)&&source.expectedCheckpointSha256===p.originalCheckpointSha256&&source.expectedGeneration===b.sourceProcessingGeneration&&hex(p.originalCheckpointSha256));
 const dir=path.resolve(source.directory),st=await fs.lstat(dir);must(st.isDirectory()&&!st.isSymbolicLink()&&path.resolve(await fs.realpath(dir))===dir);
 const cpBytes=await read(path.join(dir,'checkpoint-ocr.json')),cp=JSON.parse(cpBytes),state=JSON.parse(await read(path.join(dir,'state.json')));
 const scope={ownerScope:s.owner,projectId:s.projectId,pageId:s.pageId,sourceSha256:c.sourceSha256,normalizedSha256:c.normalizedSha256,sourceLanguage:state.sourceLanguage,pageNumber:s.pageNumber};
 must(s.sourceSha256===c.sourceSha256&&c.pageNumber===s.pageNumber&&sha(cpBytes)===source.expectedCheckpointSha256&&cp.jobId===source.jobId&&state.id===source.jobId&&state.sequence===source.expectedGeneration);
 must(same(cp.scope,scope)&&state.owner===s.owner&&state.projectId===s.projectId&&state.pageId===s.pageId&&state.pageNumber===s.pageNumber&&state.sourceSha256===scope.sourceSha256&&state.checkpoints?.ocr?.sha256===sha(cpBytes)&&hex(cp.identity?.configuration));
 const original=await read(path.join(dir,'source.png'),8*1024*1024),normalized=await read(path.join(dir,'normalized.png'),8*1024*1024);
 must(sha(original)===c.sourceSha256&&sha(normalized)===c.normalizedSha256&&original.equals(imageBytes(b.sourceImage))&&normalized.equals(imageBytes(b.normalizedImage)),'IMPORTED_PAGE_IMAGE_MISMATCH');
 const resumeFrom={directory:dir,jobId:source.jobId,checkpoints:state.checkpoints};
 const strict=createCheckpointSession({directory:dir,jobId:'read-only-original-import-source',scope,resumeFrom,signal}),verified=await strict.load('ocr',cp.identity);
 must(verified,'IMPORTED_PAGE_ORIGINAL_OCR_REQUIRED');
 const current=await readCurrentOcr({scope:structuredClone(scope),resumeFrom,originalIdentity:structuredClone(cp.identity),source});
 must(current?.value&&same(current.value.payload,verified.payload),'IMPORTED_PAGE_CURRENT_OCR_REQUIRED');
 const payload=current.value.payload,e=payload.extraction,groups=e?.speechBubbles;
 must(Array.isArray(groups)&&groups.length===b.regions.length&&groups.length>0&&new Set(groups.map(g=>g.id)).size===groups.length&&new Set(b.regions.map(row=>row.regionId)).size===groups.length);
 must(Array.isArray(e.warnings)&&e.warnings.every(w=>typeof w==='string'&&!/^OCR_REGION_(CROP|RECOGNITION)_(FAILED|EMPTY):/.test(w))&&!payload.ocrRefinement?.reviews?.length&&!payload.regionSelection?.needsReviewRegions);
 // Re-run the unchanged owning 75% source-line/ROI coverage contract, never OCR inference.
 const selected=selectDialogueRegions(payload.preSelectionExtraction,payload.regionDetection);
 must(same(selected.extraction,e)&&same(selected.selection,payload.regionSelection),'IMPORTED_PAGE_OCR_MAPPING_MISMATCH');
 const decisions=payload.regionSelection?.decisions;must(Array.isArray(decisions));
 const lines=b.regions.map(row=>{
  const g=groups.find(g=>g.id===row.regionId),d=decisions.find(d=>d.id===row.regionId),ids=g?.ocrRefinement?.sourceDetectionIds??g?.productionOcrProvenance?.sourceDetectionIds??[];
  must(g&&g.text===row.sourceText&&g.readingOrder===row.order&&same(g.bbox,row.bbox)&&same(ids,row.sourceLineIds)&&e.pageNumber===scope.pageNumber,'IMPORTED_PAGE_OCR_MAPPING_MISMATCH');
  must(d&&d.action==='translate'&&same(d.sourceLineIds,ids)&&Array.isArray(d.lineMapping)&&d.lineMapping.length===ids.length&&new Set(d.lineMapping.map(m=>m.sourceDetectionId)).size===ids.length&&d.lineMapping.every(m=>ids.includes(m.sourceDetectionId)&&m.status==='unique'&&m.roiIds.length===1),'IMPORTED_PAGE_OCR_MAPPING_MISMATCH');
  must(typeof row.selectedUserTranslation==='string'&&row.selectedUserTranslation.trim()&&typeof row.originalAiTranslation==='string'&&row.userAcknowledgement?.selectionReviewed===true&&row.userAcknowledgement?.risksAcceptedForApplication===true&&row.independentSemanticVerification===null);
  return {...structuredClone(row),id:row.regionId,pageNumber:c.pageNumber,sourceText:g.text,aiTranslation:row.originalAiTranslation,userTranslation:row.selectedUserTranslation,ocrEditStatus:'ai_proposed',ocrGeometry:structuredClone(g),roiMapping:structuredClone(d)};
 });
 must(sha(b.regions.map(row=>[row.regionId,row.selectedUserTranslation,row.selectionOrigin,row.editRevision]))===r.selectedSetSha256);
 signal?.throwIfAborted();must(sha(await read(path.join(dir,'checkpoint-ocr.json')))===sha(cpBytes)&&same(JSON.parse(await read(path.join(dir,'state.json'))),state),'IMPORTED_PAGE_SOURCE_CHANGED');
 must(original.equals(await read(path.join(dir,'source.png'),8*1024*1024))&&normalized.equals(await read(path.join(dir,'normalized.png'),8*1024*1024)),'IMPORTED_PAGE_SOURCE_CHANGED');
 return {status:'IMPORTED_PAGE_INPUTS_READY',current:structuredClone(c),source:{scope,processingGeneration:state.sequence,checkpointSha256:sha(cpBytes),originalIdentity:cp.identity,strictLoader:strict.evidence(),ocrCompatibility:current.compatibility??null,currentIdentity:current.currentIdentity??null,payloadSha256:sha(payload)},
  application:{documentId:b.documentId,documentSha256:b.documentSha256,eventSha256:r.eventSha256,selectedSetSha256:r.selectedSetSha256,packetSha256:p.packetSha256,submissionBytesSha256:p.submissionSha256},lines,ocrRegions:lines.length,userTranslationsUsable:lines.length,
  authenticationLevel:b.authenticationLevel,accountAuth:b.accountAuth,independentSemanticVerification:null,independentGroundTruthVerified:false,executionAuthorized:false,
  actualCalls:{ocr:0,gemma:0,lama:0,renderer:0},imageFilesCreated:0,newCheckpointWritten:false,maskAndRendererValidation:'NOT_RUN'};
}
module.exports={inspectImportedPageInputs};
