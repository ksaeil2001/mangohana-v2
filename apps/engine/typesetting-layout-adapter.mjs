// Separate layout/ROI authorization over immutable cleaned provenance. No Permit,
// approval writer, model runner or rendering capability exists in this adapter.
import {roiSha} from './layout-roi-ledger.mjs';import {createRequire} from 'node:module';const {layoutPlanDigest}=createRequire(import.meta.url)('../../packages/ai-engine/quality/layout-roi-contract.cjs');
const must=(v,code='TYPESETTING_LAYOUT_ADAPTER_INVALID')=>{if(!v)throw Object.assign(Error(code),{code,status:409});};
export function createTypesettingLayoutAdapter({authorize,loadSource}){
 must(typeof authorize==='function'&&typeof loadSource==='function');
 return async binding=>{
  const context=await loadSource(binding),checked=await authorize(binding,context),l=binding.layoutReview,r=checked?.roiExpansion,base=checked?.baseLayout,v=checked?.validation,p=v?.proposal;
  must(l?.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'&&base?.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'&&r&&roiSha(l.roiExpansion)===roiSha(r)&&l.layoutRevision===base.layoutRevision+2&&r.baseLayoutRevision===base.layoutRevision&&l.approval?.sourceDraftRevision===base.layoutRevision+1&&r.entriesSha256===roiSha(l.entries));
  must(l.planSha256===layoutPlanDigest(l.sourceReviewFingerprint,l.entries,r));
  must(roiSha(l.source)===roiSha(base.source)&&roiSha(l.source)===roiSha(context.source)&&l.sourceReviewFingerprint===base.sourceReviewFingerprint&&l.sourceReviewFingerprint===context.sourceReviewFingerprint&&roiSha(p?.source)===roiSha(context.source),'TYPESETTING_LAYOUT_SOURCE_CHANGED');
  must(v.status==='READY_FOR_EXPLICIT_ROI_REVIEW'&&p.checks?.length===13&&new Set(p.checks.map(c=>c.id)).size===13&&p.checks.every(c=>c.standard?.hardViolations?.length===0&&c.sourceFootprintVerified&&c.cleanedPixelFootprintVerified),'TYPESETTING_LAYOUT_SAFETY_BLOCKED');
  return {baseLayout:structuredClone(base),proof:{version:1,kind:'NEW_SIGNED_LAYOUT_WITH_SEPARATE_ROI_AUTHORITY',originalLayoutReviewSha256:roiSha(base),layoutReviewSha256:roiSha(l),roiReceiptSha256:r.receiptSha256,proposalSha256:r.proposalSha256,entriesSha256:r.entriesSha256,wholePlanSha256:r.wholePlanSha256,standardReviewSha256:p.standardReviewSha256,originalReuseAuthorized:false,executionAuthorized:false,finalRaster:'PENDING',preflight:{status:'SOURCE_PREFLIGHT_PASS',regions:p.checks.map(c=>({id:c.id,sourceFootprintVerified:c.sourceFootprintVerified,cleanedPixelFootprintVerified:c.cleanedPixelFootprintVerified,standard:c.standard,finalRaster:'PENDING'})),blockers:[],combinationWarnings:p.combinationWarnings}}};
 };
}
