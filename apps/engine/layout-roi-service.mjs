import {createRequire} from 'node:module';import {readBounded} from './translation-review-store.mjs';import {createRoiLedger,roiSha} from './layout-roi-ledger.mjs';import {validateRoiCombination,roiBinding} from './layout-roi-validation.mjs';import {measureLayoutText} from './layout-text-measurement.mjs';
const require=createRequire(import.meta.url),sharp=require('sharp'),{createBackgroundScene}=require('../../packages/ai-engine/quality/background-layout.cjs');
const must=(v,code)=>{if(!v)throw Object.assign(Error(code),{code,status:409});},hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),equal=(a,b)=>roiSha(a)===roiSha(b);
const exact=(v,fields)=>must(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&Object.keys(v).every(k=>fields.includes(k)),'ROI_INPUT_INVALID');
export function createRoiExpansionService({root,run,store,presentation,measureText=measureLayoutText}){
 const ledger=createRoiLedger({root}),metrics=new Map();
 const codeFiles=['layout-roi-ledger.mjs','layout-roi-service.mjs','layout-roi-validation.mjs','layout-review-store.mjs','layout-review-service.mjs','layout-review-source.mjs','layout-text-measurement.mjs','layout-readability-presentation.mjs','typesetting-layout-adapter.mjs','typesetting-resume-source.mjs','typesetting-only-preflight.mjs','../../packages/ai-engine/quality/layout-roi-contract.cjs','../../packages/ai-engine/quality/background-layout.cjs','../../packages/ai-engine/quality/imported-layout-background.cjs','../../packages/ai-engine/quality/typesetting-only-native.cjs'];
 const codePins=async()=>Object.fromEntries(await Promise.all(codeFiles.map(async f=>[f,roiSha(await readBounded(new URL(f,import.meta.url)))])));
 async function measure(entries,context,{signal}={}){const bundleSha256=roiSha(await readBounded(new URL('../../packages/ai-engine/.build/layout-measurement.js',import.meta.url))),key=e=>roiSha({entry:e,font:context.source.fontSha256,bundleSha256}),missing=entries.filter(e=>!metrics.has(key(e)));let result;
  if(missing.length){result=await measureText(missing,context,{signal});must(result.fontLoaded===true&&result.cleanupConfirmed===true&&result.entries?.length===missing.length&&new Set(result.entries.map(e=>e.id)).size===missing.length,'ROI_MEASUREMENT_UNKNOWN');for(const e of missing){const m=result.entries.find(m=>m.id===e.id);must(m,'ROI_MEASUREMENT_UNKNOWN');metrics.set(key(e),structuredClone(m));}}
  return {fontLoaded:true,cleanupConfirmed:true,bundleSha256,entries:entries.map(e=>structuredClone(metrics.get(key(e)))),evidenceDirectory:result?.evidenceDirectory??null,paintCalls:0,encodeCalls:0,actualPageSupplied:false};
 }
 async function validate(binding,baseLayout,choices,context,signal){
  const beforeCode=await codePins(),inspected=await presentation.inspect({...binding,layoutReview:baseLayout},{signal}),{pack,source}=inspected;
  must(equal(context.source,inspected.context.source)&&context.sourceReviewFingerprint===inspected.context.sourceReviewFingerprint,'ROI_SOURCE_STALE');
  const decode=async value=>sharp(Buffer.from(value.slice(value.indexOf(',')+1),'base64'),{limitInputPixels:12_000_000}).ensureAlpha().raw().toBuffer();
  const [sourcePixels,maskPixels,cleanedPixels]=await Promise.all(['normalized','mask','cleaned'].map(k=>decode(pack.preview[k])));
  const result=await validateRoiCombination({binding,baseLayout,pack,context,sourceProof:source.proof,sourcePixels,maskPixels,cleanedPixels,choices,measureText:measure,signal});
  must(equal(beforeCode,await codePins()),'ROI_CODE_CHANGED_DURING_VALIDATION');result.proposal.codePins=beforeCode;result.proposal.codeFingerprint=roiSha(beforeCode);result.proposalSha256=roiSha(result.proposal);
  return {result,source,pack,context,sourcePixels,maskPixels,cleanedPixels};
 }
 async function receiptFor(binding,reference,context){must(hex(reference),'ROI_APPROVAL_REQUIRED');const receipt=await ledger.read(reference),p=receipt.proposal;must(equal(p.binding,roiBinding(binding,p.baseLayout))&&equal(p.source,context.source)&&p.sourceReviewFingerprint===context.sourceReviewFingerprint,'ROI_APPROVAL_STALE');return receipt;}
 const metadata=r=>({version:1,kind:'APPROVED_ROI_EXPANSION',receiptId:r.receiptId,receiptSha256:roiSha(r),proposalSha256:r.proposalSha256,baseLayoutRevision:r.proposal.baseLayout.layoutRevision,baseLayoutPlanSha256:r.proposal.baseLayout.planSha256,cleanedSha256:r.proposal.cleanedSha256,sourceReviewFingerprint:r.proposal.sourceReviewFingerprint,entriesSha256:roiSha(r.proposal.manualEntries),wholePlanSha256:roiSha(r.proposal.entries),regions:structuredClone(r.proposal.expansions)});
 async function resolveForLayout({binding,reference,entries,before,context,phase}){
  const receipt=await receiptFor(binding,reference,context),p=receipt.proposal,r=metadata(receipt),expected=p.baseLayout.layoutRevision+(phase==='approve'?1:phase==='execution'?2:0);
  must(before?.layoutRevision===expected&&equal(entries,p.manualEntries),'ROI_APPROVAL_STALE');
  if(phase==='save'||phase==='validate')must(before.state===p.baseLayout.state&&before.planSha256===p.baseLayout.planSha256&&equal(before.approval,p.baseLayout.approval),'ROI_APPROVAL_STALE');
  else must(equal(before.roiExpansion,r)&&before.state===(phase==='approve'?'DRAFT':'APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'),'ROI_APPROVAL_STALE');
  const fresh=await validate(binding,p.baseLayout,p.choices,context);must(fresh.result.status==='READY_FOR_EXPLICIT_ROI_REVIEW'&&fresh.result.proposalSha256===receipt.proposalSha256,'ROI_SAFETY_OR_CODE_STALE');
  const guards=[...context.otherBoxes,...p.entries.map(e=>({id:e.id,bbox:e.bbox}))],sourceScene=createBackgroundScene({width:context.width,height:context.height,sourcePixels:fresh.sourcePixels,maskPixels:fresh.maskPixels,sourceSha256:context.source.normalizedSha256,maskSha256:context.source.maskSha256}),regions=context.regions.map(v=>{const expansion=p.expansions.find(e=>e.id===v.id);return expansion?{...v,allowedBbox:{...expansion.approvedBbox}}:v;});
  const effective={...context,regions,inspectEntry:e=>sourceScene.inspectManual({id:e.id,bbox:e.bbox,allowedBbox:regions.find(r=>r.id===e.id).allowedBbox,otherBoxes:guards})};
  return {context:effective,roiExpansion:r,receipt,validation:fresh.result};
 }
 async function authorizeAdapter(binding,context){const r=binding.layoutReview?.roiExpansion;must(r,'ROI_APPROVAL_REQUIRED');const checked=await resolveForLayout({binding,context,reference:r.receiptId,entries:binding.layoutReview.entries,before:binding.layoutReview,phase:'execution'});return {baseLayout:checked.receipt.proposal.baseLayout,roiExpansion:checked.roiExpansion,validation:checked.validation};}
 const common=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256','expectedLayoutRevision','requestKey'];
 function command(body,fields){exact(body,[...common,...fields]);must(Number.isSafeInteger(body.expectedLayoutRevision)&&body.expectedLayoutRevision>=0&&typeof body.requestKey==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestKey),'ROI_INPUT_INVALID');return Object.fromEntries(common.slice(0,4).map(k=>[k,body[k]]));}
 return {
  resolveForLayout,authorizeAdapter,
  validate(owner,id,body,{signal}={}){const guards=command(body,['choices']);return run(owner,id,guards,signal,async(b,c,s)=>{const base=await store.executionSnapshot(b);must(base.layoutRevision===body.expectedLayoutRevision,'LAYOUT_REVISION_CONFLICT');return (await validate(b,base,body.choices,c,s)).result;});},
  approveRoi(owner,id,body,{signal}={}){const guards=command(body,['choices','proposalSha256','standardReviewSha256','roiAcknowledged']);must(body.roiAcknowledged===true&&hex(body.proposalSha256)&&hex(body.standardReviewSha256),'ROI_APPROVAL_REQUIRED');return run(owner,id,guards,signal,async(b,c,s,revalidate)=>{
   const base=await store.executionSnapshot(b);must(base.layoutRevision===body.expectedLayoutRevision,'LAYOUT_REVISION_CONFLICT');const checked=(await validate(b,base,body.choices,c,s)).result;must(checked.status==='READY_FOR_EXPLICIT_ROI_REVIEW'&&checked.proposalSha256===body.proposalSha256&&checked.standardReviewSha256===body.standardReviewSha256,'ROI_REVIEW_STALE');await revalidate();s.throwIfAborted();
   const receipt=await ledger.approve(checked.proposal,body);return {state:'ROI_APPROVED_LAYOUT_NOT_SAVED',receiptId:receipt.receiptId,receiptSha256:roiSha(receipt),proposalSha256:receipt.proposalSha256,roiExpansion:metadata(receipt),layoutRevision:base.layoutRevision,executionAuthorized:false,permitIssued:false};
  });},
  save(owner,id,body,{signal}={}){const guards=command(body,['receiptId','proposalSha256','saveAcknowledged']);must(body.saveAcknowledged===true,'LAYOUT_SAVE_ACK_REQUIRED');return run(owner,id,guards,signal,async(b,c,s)=>{const r=await receiptFor(b,body.receiptId,c);must(r.proposalSha256===body.proposalSha256,'ROI_REVIEW_STALE');return store.save(b,{expectedLayoutRevision:body.expectedLayoutRevision,requestKey:body.requestKey,entries:r.proposal.manualEntries,roiApproval:r.receiptId},{context:c,signal:s});});},
  approveLayout(owner,id,body,{signal}={}){const guards=command(body,['planSha256','expectedStandardReviewSha256','reviewAcknowledged']);return run(owner,id,guards,signal,(b,c,s)=>store.approve(b,{expectedLayoutRevision:body.expectedLayoutRevision,requestKey:body.requestKey,planSha256:body.planSha256,expectedStandardReviewSha256:body.expectedStandardReviewSha256,reviewAcknowledged:body.reviewAcknowledged},{context:c,signal:s}));},
  async close(){metrics.clear();await ledger.close();}
 };
}
