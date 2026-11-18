// Read-only saved-owner probe. It neither represents a live browser nor issues an execution permit.
import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createTranslationReviewStore,loadStage14ReviewCatalog} from '../../apps/engine/store.mjs';import {createContextStore} from '../../apps/engine/context.mjs';
import {createImportedPageInspector} from '../../apps/engine/imported-page-inspector.mjs';import {createStage14Preflight,STAGE14_IMAGE_OUTPUT_ROOT} from '../../apps/engine/imported-page-preflight.mjs';
import {digest,writeExclusive} from '../../apps/engine/image-permit-store.mjs';
const destination=path.resolve(process.argv[2]??'docs/validation/stage14r3-image-preparation-20261115/evidence'),config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json'));
const reviewRoot=path.join(config.dataRoot,'translation-reviews'),names=(await fs.readdir(reviewRoot)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));if(names.length!==1)throw Error('EXPECTED_ONE_SAVED_STAGE14_DOCUMENT');
const bytes=await fs.readFile(path.join(reviewRoot,names[0])),saved=JSON.parse(bytes),contexts=await createContextStore({root:path.join(config.dataRoot,'contexts')});let reviews;
const started=Date.now();
try{
 reviews=await createTranslationReviewStore({root:reviewRoot,loadCatalog:loadStage14ReviewCatalog,contextRevision:async(o,p)=>(await contexts.snapshot(o,p)).revision,withContextRevision:(o,p,r,fn)=>contexts.withRevision(o,p,r,fn)});
 const expected={expectedEditRevision:saved.editRevision,expectedContextRevision:saved.contextRevision,eventSha256:saved.receipt.eventSha256,selectedSetSha256:saved.receipt.selectedSetSha256};
 const inspector=createImportedPageInspector(),preflight=createStage14Preflight();
 const result=await reviews.withEngineInputs(saved.owner,saved.documentId,expected,async(binding,revalidate)=>{
  console.log('SAVED_APPROVAL_HMAC_AND_REVISIONS_VERIFIED · NO_IMAGE_PERMISSION');const inputs=await inspector(binding);await revalidate();
  await writeExclusive(path.join(destination,'actual-engine-inputs.json'),JSON.stringify(inputs,null,2));console.log('OCR_REUSED='+inputs.ocrRegions+'/13 · USER_TRANSLATIONS_USABLE='+inputs.userTranslationsUsable+'/13');
  const proposedOutputDirectory=path.join(STAGE14_IMAGE_OUTPUT_ROOT,'stage14r3-preparation-'+randomUUID()),readiness=await preflight({binding,inputs,outputDirectory:proposedOutputDirectory});await revalidate();
  return {status:readiness.status,readiness,proposedOutputDirectory,documentSha256:digest(bytes),eventSha256:saved.receipt.eventSha256,selectedSetSha256:saved.receipt.selectedSetSha256,
   editRevision:saved.editRevision,contextRevision:saved.contextRevision,ocrReused:inputs.ocrRegions,userTranslationsUsable:inputs.userTranslationsUsable,semanticWarnings:inputs.lines.flatMap(l=>l.riskSignals).length,
   scope:'ACTUAL_SAVED_OWNER_READ_ONLY_NOT_LIVE_BROWSER_SESSION',liveBrowserSessionVerified:false,imageExecutionAuthorized:false,permitIssued:false,
   actualImagePipelineCalls:{lama:0,typeset:0,pngOutput:0},sourceProcessingGeneration:inputs.source.processingGeneration,executionGeneration:null,durationMs:Date.now()-started};
 });
 await writeExclusive(path.join(destination,'actual-preflight.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,readiness:{status:result.readiness.status,blockers:result.readiness.blockers,environment:result.readiness.environment},proposedOutputDirectory:result.proposedOutputDirectory}));
}finally{await reviews?.close();await contexts.close();}
