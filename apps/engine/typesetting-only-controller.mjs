import {createImportedPageController} from './imported-page-controller.mjs';import {digest,demand} from './image-permit-store.mjs';
// The caller supplies only current session/revision guards. Source selection and
// all paths/hashes come from the server's audited policy, never browser JSON.
export async function createTypesettingOnlyController({sourceResolver,...options}){
 demand(typeof sourceResolver==='function','TYPESETTING_SOURCE_CONFIG',503);
 const controller=await createImportedPageController({...options,executionMode:'TYPESETTING_ONLY',enrichBinding:async binding=>({...binding,typesettingSource:(await sourceResolver(binding)).proof}),inspectInputs:async binding=>{const value=await sourceResolver(binding);demand(digest(value.proof)===digest(binding.typesettingSource),'TYPESETTING_SOURCE_CHANGED');return value.inputs;}});
 return {...controller,async inspectSource(owner,documentId){
  const d=(await options.reviewStore.get(owner,documentId)).document,expected={expectedEditRevision:d.editRevision,expectedContextRevision:d.contextRevision,eventSha256:d.receipt.eventSha256,selectedSetSha256:d.receipt.selectedSetSha256};
  return options.reviewStore.withEngineInputs(owner,documentId,expected,async(binding,revalidate)=>{const {proof,inputs}=await sourceResolver(binding);await revalidate();return{status:'SOURCE_VERIFIED_SEPARATE_EXECUTION_APPROVAL_REQUIRED',executionMode:'TYPESETTING_ONLY',documentId,expected,layoutRevision:binding.layoutReview.layoutRevision,sourcePermitId:proof.sourcePermitId,sourceGeneration:proof.sourceExecutionGeneration,cleanedSha256:proof.cleanedSha256,sourceManifestSha256:proof.manifestSha256,width:proof.width,height:proof.height,ocrReused:inputs.ocrRegions,approvedTranslations:inputs.userTranslationsUsable,manualEntries:binding.layoutReview.entries.length,sourceReviewFingerprint:proof.sourceReviewFingerprint,layoutPlanSha256:proof.layoutPlanSha256,codeAudit:proof.codeAudit,sourcePixels:proof.independentPixels,originalReuseAuthorized:false,executionAuthorized:false,permitIssued:false,finalPngVerified:false,capabilities:{ocr:false,gemma:false,lama:false,maskModel:false,typesetting:true}};});
 }};
}
