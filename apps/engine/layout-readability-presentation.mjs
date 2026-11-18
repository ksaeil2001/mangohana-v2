// Owner-bound presentation of trusted measurement evidence. No write/execution port.
import fs from'node:fs/promises';import path from'node:path';import{createHmac,timingSafeEqual}from'node:crypto';import{createRequire}from'node:module';
import{readBounded}from'./translation-review-store.mjs';import{readabilityDigest}from'./layout-readability-review.mjs';import{regularDirectory,permitId}from'./image-permit-store.mjs';import{imageExecutionBinding}from'./imported-page-controller.mjs';import{createLayoutSourceLoader}from'./layout-review-source.mjs';
const require=createRequire(import.meta.url),sharp=require('sharp'),{layoutTextMatches}=require('../../packages/ai-engine/quality/background-layout.cjs'),{inspectKoreanText}=require('../../packages/ai-engine/quality/korean-typesetting-standard.cjs');
export{readabilityDigest};const fail=code=>{throw Object.assign(Error('현재 세션·승인·배치와 비교 자료가 일치하는지 확인해 주세요.'),{code,status:409});};
export function verifyReadabilityBinding(p,b){
 const expected={owner:b.current.ownerScope,documentId:b.documentId,documentSha256:b.documentSha256,eventSha256:b.receipt.eventSha256,selectedSetSha256:b.receipt.selectedSetSha256,editRevision:b.current.editRevision,contextRevision:b.current.contextRevision,layoutRevision:b.layoutReview.layoutRevision,layoutPlanSha256:b.layoutReview.planSha256,layoutApprovalSha256:readabilityDigest(b.layoutReview.approval)};
 if(p.kind!=='READ_ONLY_CLEANED_READABILITY_COMPARISON'||readabilityDigest(p.binding)!==readabilityDigest(expected)||p.sourceReviewFingerprint!==b.layoutReview.sourceReviewFingerprint||p.regions?.length!==b.regions.length||new Set(p.regions.map(r=>r.id)).size!==p.regions.length||p.regions.some(r=>!b.regions.some(v=>v.regionId===r.id&&v.selectedUserTranslation===r.text)))fail('READABILITY_BINDING_MISMATCH');
 if(p.approved!==false||p.saved!==false||p.authorizedForExecution!==false||p.actualImageExecution!==false||p.actualModelCalls!==0||p.paintCalls!==0||p.encodeCalls!==0)fail('READABILITY_AUTHORITY_INVALID');
 for(const r of p.regions)for(const c of r.proposedCandidates){const text=inspectKoreanText(r.text,c.entry.text.split('\n'));if(c.entry.id!==r.id||!layoutTextMatches(r.text,c.entry.text)||text.intraWordBreaks||text.punctuationOnlyLines.length||text.leadingDetachedPunctuation.length||c.approved!==false||c.saved!==false||c.authorizedForExecution!==false||c.actualFinalRasterVerified!==false||c.finalRaster!=='PENDING'||c.standard.hardViolations.length)fail('READABILITY_CANDIDATE_INVALID');}
 return true;
}
async function verifiedSuccess(p,b,{permitRoot,outputRoot}){
 const id=p.success?.permitId;if(!permitId(id))fail('READABILITY_SUCCESS_SOURCE_INVALID');const dir=path.join(permitRoot,id);await regularDirectory(permitRoot);await regularDirectory(dir);const key=await readBounded(path.join(permitRoot,'image-permit-key.bin'),32),r={};
 try{for(const name of['proposal','approval','consumed','outcome']){const signed=JSON.parse(await readBounded(path.join(dir,name+'.json'))),{signature,...unsigned}=signed,mac=createHmac('sha256',key).update(JSON.stringify(unsigned)).digest();if(!/^[a-f0-9]{64}$/.test(signature??'')||!timingSafeEqual(Buffer.from(signature,'hex'),mac))fail('READABILITY_SUCCESS_SIGNATURE_INVALID');r[name]=signed;}}finally{key.fill(0);}
 const proposal=r.proposal,expected=imageExecutionBinding(b),actual={...proposal.binding};delete actual.executionMode;delete actual.typesettingSourceSha256;
 if(proposal.permitId!==id||proposal.executionMode!=='TYPESETTING_ONLY'||proposal.maximumExecutions!==1||readabilityDigest(actual)!==readabilityDigest(expected)||proposal.sourceCleaned?.cleanedSha256!==p.cleanedSha256||proposal.executionGeneration!==p.success.generation||r.consumed.executionCount!==1||r.consumed.executionGeneration!==p.success.generation||r.outcome.state!=='SUCCEEDED')fail('READABILITY_SUCCESS_SOURCE_INVALID');
 for(const v of[r.approval,r.consumed,r.outcome])if(v.permitId!==id||v.proposalSha256!==readabilityDigest(proposal))fail('READABILITY_SUCCESS_SOURCE_INVALID');
 const directory=path.join(outputRoot,'stage14r3-typesetting-'+id);if(path.resolve(proposal.outputDirectory)!==path.resolve(directory)||path.resolve(p.assets.final.file)!==path.join(path.resolve(directory),'final.png')||r.outcome.result?.sha256!==p.success.sha256)fail('READABILITY_SUCCESS_OUTPUT_INVALID');
 return {permitId:id,generation:p.success.generation,state:'SUCCEEDED',executionCount:1,approvalSignatureVerified:true};
}
export function createReadOnlyReadabilityReview({reviewStore,packFile,permitRoot,outputRoot,sourceResolver,loadSource=createLayoutSourceLoader()}){
 async function inspect(binding,{signal,revalidate=async()=>{}}={}){
   signal?.throwIfAborted();
   const pack=JSON.parse(await readBounded(packFile,8*1024*1024));verifyReadabilityBinding(pack,binding);await revalidate();
   for(const[relative,hash]of Object.entries(pack.codePins)){if(!/^(?:packages\/ai-engine\/(?:quality|\.build)|apps\/engine)\/[\w./-]+$/.test(relative)||relative.split('/').includes('..')||readabilityDigest(await readBounded(path.resolve(relative)))!==hash)fail('READABILITY_CODE_CHANGED');}
   const source=await sourceResolver(binding),context=await loadSource(binding);
   if(source.proof.cleanedSha256!==pack.cleanedSha256||source.proof.manifestSha256!==pack.sourceProof.manifestSha256||context.sourceReviewFingerprint!==pack.sourceReviewFingerprint||context.source.fontSha256!==pack.source.fontSha256)fail('READABILITY_SOURCE_CHANGED');
   const success=await verifiedSuccess(pack,binding,{permitRoot,outputRoot}),images={};
   const permitted={normalized:source.proof.normalizedSha256,mask:source.proof.maskSha256,cleaned:source.proof.cleanedSha256,final:pack.success.sha256};
   for(const[name,a]of Object.entries(pack.assets)){if(!Object.hasOwn(permitted,name)||a.sha256!==permitted[name])fail('READABILITY_ASSET_INVALID');const info=await fs.lstat(a.file);if(!info.isFile()||info.isSymbolicLink()||path.resolve(await fs.realpath(a.file)).toLowerCase()!==path.resolve(a.file).toLowerCase())fail('READABILITY_ASSET_INVALID');const bytes=await readBounded(a.file,32*1024*1024),meta=await sharp(bytes,{limitInputPixels:12_000_000}).metadata();if(readabilityDigest(bytes)!==a.sha256||meta.width!==pack.width||meta.height!==pack.height||meta.format!=='png')fail('READABILITY_ASSET_CHANGED');images[name]='data:image/png;base64,'+bytes.toString('base64');}
   await revalidate();signal?.throwIfAborted();const {assets,sourceProof,codePins,...safePack}=pack;
   return {source,context,pack:{...safePack,success:{...success,sha256:pack.success.sha256,width:pack.width,height:pack.height},preview:{...images,fontData:context.preview.fontData,fontIdentity:context.preview.fontIdentity},packSha256:readabilityDigest(pack),sessionOwnerVerified:true,existingCleanedVerified:true,executionAuthority:false}};
 }
 return{inspect,async get(owner,id,{signal}={}){
  signal?.throwIfAborted();const d=(await reviewStore.get(owner,id)).document,expected={expectedEditRevision:d.editRevision,expectedContextRevision:d.contextRevision,eventSha256:d.receipt.eventSha256,selectedSetSha256:d.receipt.selectedSetSha256};
  return reviewStore.withEngineInputs(owner,id,expected,async(binding,revalidate)=>(await inspect(binding,{signal,revalidate})).pack);
 }};
}
