import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture, sha, png } from '../../../tests/v2/offline-evaluation-fixture.mjs';
import { mutationCatalog, materializeCase } from './catalog.mjs';
import { classifyMutation, summarizeByLane } from './metrics.mjs';
import { evaluateOcrPages } from '../offline/ocr.mjs';
import { evaluateOfflineRun, validateOfflineReport } from '../offline/evaluator.mjs';
import { compareImagePixels, evaluateTypesetting } from '../offline/quality.mjs';
import { summarizeRequestRecords } from '../offline/operations.mjs';
import { assertCommitAllowed, validateCommonContract } from '../../contracts/src/v2-common-contract.mjs';
import { inspectTranslationQuality } from '../../../apps/desktop/src/shared/translation/translationQa.ts';

export const saveJson=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});};
const bytesJson=x=>Buffer.from(JSON.stringify(x));
const code=e=>e.code??e.message;
const datasetFixture=()=>fixture({after(){}});
async function rewrite(f,kind,change,rehash=true) {
  const pin=f.page.artifacts.find(a=>a.kind===kind),file=path.join(f.assets,pin.path),obj=JSON.parse(await fs.readFile(file,'utf8'));
  change(obj);const bytes=bytesJson(obj);await fs.writeFile(file,bytes);if(rehash)pin.sha256=sha(bytes);return obj;
}
async function translations(f) {
  await f.add('translations','translations','translations.json',{lines:[{id:'g1',sourceText:'あ',aiTranslation:'아'}],records:[{id:'g1',requestId:'r1',durationMs:0,modelHttpRequests:0}]});
}
async function completed(f) {
  await translations(f);await f.add('report','report','report.json',{jobId:f.page.binding.jobId});
  await f.add('candidate','candidate','candidate.png',f.source);await f.add('cleaned','cleaned','cleaned.png',f.source);
  await rewrite(f,'state',s=>{s.status='completed';s.stage='completed';delete s.errorCode;});
}
async function persistOffline(f,dir) {
  const options=await f.seal();await fs.cp(f.dir,dir,{recursive:true,errorOnExist:true,force:false});
  return {...options,datasetPath:path.join(dir,'dataset.json'),evidencePath:path.join(dir,'evidence.json'),evidenceRoot:path.join(dir,'assets'),workspace:path.join(dir,'derived')};
}
async function offline(f,dir) {
  const options=await persistOffline(f,dir);
  try {const report=await evaluateOfflineRun(options);await saveJson(path.join(dir,'result.json'),report);return {decision:'pass',report};}
  catch(e){await saveJson(path.join(dir,'rejection.json'),{code:code(e)});return {decision:'error',rejection:code(e)};}
}
const attempt=(n,status='succeeded',manualEdits=0)=>({attemptId:'a'+n,jobId:'job-1',number:n,status,manualEdits});
const apiResult=(decision,evidence,reason=null)=>({decision,evidence,reason});

async function ocrCase(c,x,dir) {
  if(c.mutationId==='OCR-12') {
    const f=await datasetFixture();await persistOffline(f,path.join(dir,'valid-offline'));
    await rewrite(f,'final_ocr',v=>{v.speechBubbles[0].productionOcrProvenance.sourceDetectionIds=[];});
    const r=await offline(f,path.join(dir,'mutated-offline'));
    return apiResult(r.decision,r,r.rejection);
  }
  const source=await png(Array(16).fill(255));const file=path.join(dir,'source.png');await fs.writeFile(file,source,{flag:'wx'});
  const r=await evaluateOcrPages({runId:c.mutationId,split:'dev',workspace:path.join(dir,'derived'),pages:[{
    pageId:'synthetic-page',workId:'synthetic-work',duplicateGroupId:'synthetic-unique',source:{path:file,sha256:sha(source)},
    groundTruth:{status:'verified',reviewer:'PROGRAMMATIC_SYNTHETIC_ORACLE_NOT_HUMAN',reviewedAt:'2026-11-12T08:00:00Z',regions:x.reference.regions},
    finalOcr:{speechBubbles:x.regions},evidenceKind:'synthetic'}]});
  await saveJson(path.join(dir,'ocr-result.json'),r);
  const m=r.pages[0].ocr,signal=m.characterErrors>0 || m.falseNegatives>0 || m.falsePositives>0 || m.readingOrderErrors>0;
  if(['OCR-08','OCR-10'].includes(c.mutationId))return apiResult('unsupported',{metrics:m,mapping:x.mapping,furigana:x.furigana},c.reason);
  if(c.mutationId==='OCR-13')return apiResult('unmeasured',{detectorConfidence:x.detectionConfidence,submittedRecognitionAccuracy:x.recognitionAccuracy,independentRecognitionAccuracy:null},c.reason);
  if(['OCR-14','OCR-15'].includes(c.mutationId)) {
    const a=x.reference.glyphBox,b=x.redetection,intersection=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
    return apiResult('review',{sourceQuad:{x:0,y:0,width:10,height:10},redetectedQuad:b,sourceQuadCoverage:b.width*b.height/100,
      existingThreshold:.75,syntheticGlyphRetention:intersection/(a.width*a.height),realGlyphPreservation:null,metrics:m},c.reason);
  }
  return apiResult(signal?'error':'pass',{metrics:m,scope:'MEASURED_NONZERO_ERROR_SIGNAL_NO_PRODUCT_ACCEPTANCE_THRESHOLD'});
}

async function semanticCase(c,x,dir) {
  const qa=inspectTranslationQuality({sourceText:x.source,translatedText:x.translation});await saveJson(path.join(dir,'legacy-rule-qa.json'),qa);
  const f=await datasetFixture();await rewrite(f,'final_ocr',v=>v.speechBubbles[0].text=x.source);
  await f.add('translations','translations','translations.json',{lines:[{id:'g1',sourceText:x.source,aiTranslation:x.translation}],records:[]});
  const r=await offline(f,path.join(dir,'offline'));assert.equal(r.decision,'pass','Quality mutation must have valid hashes and structure');
  assert.equal(r.report.pages[0].semantic.majorCriticalErrors.value,null);
  if(c.area==='semantic_rules')return apiResult(qa.issues.some(i=>i.severity==='error')?'error':qa.issues.length?'review':'pass',{ruleQa:qa,independentSemantic:r.report.pages[0].semantic},c.reason);
  if(c.truth==='normal')return apiResult('unsupported',{ruleQa:qa,ruleControl:qa.passed?'CORRECT_PASS':'FALSE_ALARM',independentSemantic:null,semanticVerified:false},'SEMANTIC_DETECTION_NOT_IMPLEMENTED');
  return apiResult('unsupported',{ruleQa:qa,structuralValidation:'passed',independentSemantic:r.report.pages[0].semantic},'SEMANTIC_DETECTION_NOT_IMPLEMENTED');
}

async function imageCase(c,x,dir) {
  const source=await png(x.source,x.width,x.height),cleaned=await png(x.cleaned,x.width,x.height);
  const mask=indices=>Array.from({length:x.width*x.height},(_,i)=>{const v=indices.includes(i)?255:0;return [v,v,v,255];}).flat();
  const removalPixels=x.encoding==='studio_inverse_alpha'
    ?Array.from({length:x.width*x.height},(_,i)=>[255,255,255,x.removal.includes(i)?255:0]).flat():mask(x.removal);
  const remove=await png(removalPixels,x.width,x.height),protect=await png(mask(x.protection),x.width,x.height);
  for(const [name,bytes] of [['source.png',source],['cleaned.png',cleaned],['removal.png',remove],['protection.png',protect],['oracle-cleaned.png',await png(x.reference.cleaned,x.width,x.height)]])
    await fs.writeFile(path.join(dir,name),bytes,{flag:'wx'});
  const r=await compareImagePixels({source,cleaned,removal:{bytes:remove,encoding:x.encoding},protection:{bytes:protect,encoding:'binary255_active_protect'}});
  await saveJson(path.join(dir,'pixel-result.json'),r);
  const differentPixels=(a,b)=>a.reduce((n,_,i)=>i%4===0 && a.slice(i,i+4).some((v,j)=>v!==b[i+j])?n+1:n,0);
  const oracle={differentFromKnownSyntheticCleanPixels:differentPixels(x.reference.cleaned,x.cleaned),hiddenBackgroundAvailable:x.reference.hiddenBackgroundAvailable,
    sourceResidueEvaluation:r.sourceResidue,insideArtworkDamage:r.insideArtworkDamage,qualityApproval:r.qualityApproval};
  assert.equal(r.insideArtworkDamage.value,null);assert.equal(r.qualityApproval,false);
  const signal=r.outsideMaskChangedPixels.value>0 || r.protectedChangedPixels.value>0 || r.removalProtectionOverlapPixels.value>0;
  const decision=!x.reference.hiddenBackgroundAvailable?'unmeasured':signal?'error':c.truth==='normal'?'pass':'unsupported';
  return apiResult(decision,{pixelMeasurements:r,syntheticOracle:oracle,detectorScope:'PIXEL_DELTA_AND_MASK_INVARIANTS_NOT_GLYPH_OR_ARTWORK_CLASSIFICATION'},c.reason??(decision==='unsupported'?'IMAGE_CONTENT_DETECTOR_NOT_IMPLEMENTED':null));
}

async function typesettingCase(c,x,dir) {
  const outside=x.pixels===null?null:x.pixels.filter(p=>!x.safePixels.includes(p)).length;
  const f={renderPath:'engine_png',report:{typesetting:{layoutReport:[{id:x.layoutId,fontSizePx:x.fontSizePx,productionFontLoaded:x.fontLoaded,glyphFontLoaded:x.fontLoaded,raster:outside===null?{}:{outsideInteriorPixels:outside}}]}},
    get:k=>k==='translations'?{json:{lines:[{id:x.translationId,aiTranslation:x.text}]}}:undefined};
  await saveJson(path.join(dir,'engine-layout-submission.json'),f.report);
  if(x.pixels) {
    const raw=Array(64*4).fill(0);for(const i of x.pixels)raw.splice(i*4,4,0,0,0,255);
    await fs.writeFile(path.join(dir,'toy-raster.png'),await png(raw,8,8),{flag:'wx'});
  }
  try {
    const r=evaluateTypesetting(f);await saveJson(path.join(dir,'typesetting-result.json'),r);
    assert.equal(r.missingGlyphs.value,null);assert.equal(r.minimumSizePass.value,null);
    return apiResult(outside===null || c.mutationId==='TYPE-05'?'unmeasured':outside>0?'review':c.truth==='normal'?'pass':'unsupported',
      {report:r,oracleGlyphCount:x.reference.text.length,renderedToyGlyphCount:x.glyphs.length,independentRealGlyphAudit:null,
        toyRasterOutsideSafePixels:outside,scope:'TOY_GLYPH_PRIMITIVES_AND_BOUND_ENGINE_CLAIMS_NOT_REAL_FONT_RENDERING'},c.reason);
  }catch(e){return apiResult('error',{rejection:code(e)},code(e));}
}

async function admissionCase(mode,dir) {
  const file=new URL('../../../tests/v2/fixtures/mutation-common.json',import.meta.url),candidate=JSON.parse(await fs.readFile(file,'utf8'));
  candidate.quality.execution='succeeded';candidate.receipt={receiptId:'receipt-1',jobId:candidate.identity.jobId,identity:structuredClone(candidate.identity),manifestSha256:'8'.repeat(64),complete:true,artifactHashes:candidate.artifacts.map(a=>({artifactId:a.artifactId,sha256:a.sha256}))};
  const args={candidate,ticket:{identity:structuredClone(candidate.identity),sourceSha256:'a'.repeat(64),normalizedSha256:'b'.repeat(64),contextSnapshotSha256:null},
    current:{identity:structuredClone(candidate.identity),sourceSha256:'a'.repeat(64),normalizedSha256:'b'.repeat(64),execution:'running',cancelled:false,protectedTranslations:[],finalArtifactSha256:'9'.repeat(64),contextSnapshotSha256:null}};
  if(mode==='user_overwrite') {
    candidate.targets[0].text.userConfirmed={value:'사용자 확정',editRevision:2};
    args.current.protectedTranslations=[{targetId:'target-1',userModified:null,userConfirmed:structuredClone(candidate.targets[0].text.userConfirmed)}];
  }
  validateCommonContract(candidate);assertCommitAllowed(structuredClone(args));
  await saveJson(path.join(dir,'admission-original.json'),args);
  if(mode==='generation')args.candidate.identity.processingGeneration--;
  if(mode==='revision')args.candidate.identity.sourceRevision--;
  if(mode==='failed_replace')args.candidate.quality.execution='failed';
  if(mode==='user_overwrite')args.candidate.targets[0].text.userConfirmed=null;
  // Seal the candidate's own receipt consistently; the authoritative ticket remains unchanged.
  args.candidate.receipt.identity=structuredClone(args.candidate.identity);
  await saveJson(path.join(dir,'admission-mutant.json'),args);const old=JSON.stringify(args.current);
  try {assertCommitAllowed(args);return apiResult('pass',{currentUnchanged:old===JSON.stringify(args.current)});}
  catch(e){assert.equal(JSON.stringify(args.current),old);return apiResult('error',{rejection:code(e),currentUnchanged:true,previousPngHash:args.current.finalArtifactSha256},code(e));}
}

async function operationsCase(c,x,dir) {
  const mode=x.mode;
  if(['generation','revision','user_overwrite','failed_replace'].includes(mode))return admissionCase(mode,dir);
  const f=await datasetFixture();
  if(['retry','manual','legal_retry','shared_cost','zero'].includes(mode))await completed(f);
  if(['retry','manual','legal_retry'].includes(mode)) {
    f.page.operationsArtifactId='ops';await f.add('ops','operations','ops.json',{schemaVersion:1,identity:f.page.binding,attempts:mode==='manual'?[attempt(1,'succeeded',1)]:[attempt(1,'failed'),attempt(2)],delivery:null,resources:{}});
  }
  await persistOffline(f,path.join(dir,'original-offline'));
  if(mode==='hash')await rewrite(f,'final_ocr',v=>v.warnings=['tampered'],false);
  if(mode==='job')f.page.artifacts.find(a=>a.kind==='final_ocr').origin.jobId='foreign-job';
  if(mode==='page')await rewrite(f,'state',s=>s.pageId='foreign-page');
  if(mode==='owner')await rewrite(f,'state',s=>s.owner='foreign-owner');
  if(mode==='work')await f.add('context','context','context.json',{workId:'foreign-work',owner:f.page.binding.ownerId,projectId:f.page.binding.projectId,sourceSha256:sha(f.source)});
  if(mode==='no_model')f.page.evidenceKind='actual_product';
  if(mode==='failed_completed')f.page.declaredOutcome='succeeded';
  if(mode==='partial')await rewrite(f,'state',s=>{s.status='completed';s.stage='completed';});
  if(mode==='foreign_gt') {
    f.annotation.workId='foreign-work';f.dataset.pages[0].annotation={...f.dataset.pages[0].annotation,...await f.pin('annotations/dev/dataset-page-1.json',f.annotation)};
  }
  if(mode==='ai_human') {
    f.page.assessmentArtifactId='assessment';await f.add('assessment','assessment','assessment.json',{schemaVersion:1,identity:f.page.binding,subjectArtifactId:'ocr',subjectSha256:f.page.artifacts.find(a=>a.id==='ocr').sha256,actor:'ai',reviewerId:'fake-human',annotationSha256:null,reviewedAt:'2026-11-12T08:00:00Z',axes:['semantic'],errors:[],complete:true});
  }
  const evaluated=await offline(f,path.join(dir,'mutated-offline'));
  if(evaluated.decision==='error')return apiResult('error',{rejection:evaluated.rejection},evaluated.rejection);
  const report=evaluated.report;
  if(mode==='no_model')return apiResult('review',{execution:report.pages[0].execution,verifiedSuccess:report.summary.verifiedFirstAttemptSuccessRate},'INDEPENDENT_RUNTIME_EXECUTION_NOT_VERIFIED');
  if(['normal','legal_retry','zero','unknown'].includes(mode)) {
    const requests=summarizeRequestRecords([{requestId:'zero',durationMs:mode==='zero'?0:null,modelHttpRequests:mode==='zero'?0:null,observedApiCost:mode==='zero'?{value:0,currency:'USD',scope:'product_api'}:null}]);
    return apiResult(mode==='unknown'?'unmeasured':'pass',{summary:report.summary,requestMeasurements:requests},mode==='unknown'?'API_COST_NOT_FULLY_REPORTED':null);
  }
  if(mode==='shared_cost') {
    const records=[{id:'g1',requestId:'shared',durationMs:1,modelHttpRequests:1,observedApiCost:{value:.25,currency:'USD',scope:'product_api'}},{id:'g2',requestId:'shared',durationMs:1,modelHttpRequests:1,observedApiCost:{value:.25,currency:'USD',scope:'product_api'}}];
    report.pages[0].processing.translationRequests=summarizeRequestRecords(records);
    assert.equal(report.pages[0].processing.translationRequests.apiCost.value,.25);
    await saveJson(path.join(dir,'shared-request-original-receipts.json'),records);
  }
  await saveJson(path.join(dir,'report-original.json'),report);
  if(['retry','manual'].includes(mode))report.summary.recordedSuccess.firstAttempt=1;
  if(mode==='quality_pass')report.states.QUALITY_NOT_MEASURED=false;
  if(mode==='deliverable')report.pages[0].deliveryEligibility={status:'deliverable',reasons:[]};
  if(mode==='unknown_cost')report.pages[0].processing.translationRequests.apiCost={value:0,unit:'currency',reason:'API_COST_NOT_FULLY_REPORTED'};
  if(mode==='shared_cost')report.pages[0].processing.translationRequests.apiCost.value=.5;
  await saveJson(path.join(dir,'report-mutant.json'),report);
  try {validateOfflineReport(report);return apiResult('pass',{mode,claimAccepted:true,reason:'REPORT_VALIDATOR_HAS_NO_RAW_REQUEST_RECEIPT_RECOMPUTATION'},'REPORT_CONTRACT_MUTATION_ACCEPTED');}
  catch(e){return apiResult('error',{mode,rejection:code(e)},code(e));}
}

async function fileManifest(dir,relative='') {
  const out=[];
  for(const e of await fs.readdir(path.join(dir,relative),{withFileTypes:true})) {
    const p=path.join(relative,e.name);if(e.isDirectory())out.push(...await fileManifest(dir,p));
    else {const b=await fs.readFile(path.join(dir,p));out.push({path:p.replaceAll('\\','/'),bytes:b.length,sha256:sha(b)});}
  }
  return out.sort((a,b)=>a.path.localeCompare(b.path));
}
function differences(a,b,prefix='') {
  if(JSON.stringify(a)===JSON.stringify(b))return [];
  if(!a || !b || typeof a!=='object' || typeof b!=='object')return [{path:prefix,before:a??null,after:b??null}];
  return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>differences(a[k],b[k],prefix?prefix+'.'+k:k));
}
async function effectiveInjectionProof(dir,c) {
  const exists=async p=>fs.access(path.join(dir,p)).then(()=>true,()=>false),changes=[];
  const compare=async(a,b)=>differences(JSON.parse(await fs.readFile(path.join(dir,a),'utf8')),JSON.parse(await fs.readFile(path.join(dir,b),'utf8'))).map(d=>({...d,originalFile:a,mutatedFile:b}));
  if(await exists('report-original.json'))changes.push(...await compare('report-original.json','report-mutant.json'));
  else if(await exists('admission-original.json'))changes.push(...await compare('admission-original.json','admission-mutant.json'));
  else if(await exists('original-offline') || await exists('valid-offline')) {
    const before=await exists('original-offline')?'original-offline':'valid-offline';
    const originals=await fileManifest(path.join(dir,before)),mutated=await fileManifest(path.join(dir,'mutated-offline'));
    for(const f of originals.filter(f=>f.path.endsWith('.json') && !f.path.startsWith('derived/'))) {
      if(mutated.some(g=>g.path===f.path))changes.push(...await compare(before+'/'+f.path,'mutated-offline/'+f.path));
    }
  }
  else changes.push(...await compare('original.json','mutant.json'));
  if(c.truth==='defect')assert.ok(changes.length,'No effective data mutation');
  return {verified:true,method:'DIFF_ACTUAL_DETECTOR_INPUTS_NOT_OPERATOR_SELECTOR',changes};
}
export async function runMutationCampaign({outputDir,cases=mutationCatalog()}) {
  await fs.mkdir(outputDir,{recursive:false});
  // Pre-registration is persisted before the first detector is called.
  const preregistered=cases.map(({baseline,...c})=>c);
  await saveJson(path.join(outputDir,'Stage07_Mutation_Cases.json'),{schemaVersion:1,scope:'ISOLATED_SYNTHETIC',cases:preregistered});
  const results=[];
  for(const c of cases) {
    const dir=path.join(outputDir,'fixtures',c.mutationId);await fs.mkdir(dir,{recursive:true});
    const {baseline,mutant,proof}=materializeCase(c);
    await saveJson(path.join(dir,'original.json'),baseline);await saveJson(path.join(dir,'mutant.json'),mutant);await saveJson(path.join(dir,'injection-proof.json'),proof);
    const result=c.area==='ocr'?await ocrCase(c,mutant,dir):c.area.startsWith('semantic')?await semanticCase(c,mutant,dir):c.area==='image'?await imageCase(c,mutant,dir):c.area==='typesetting'?await typesettingCase(c,mutant,dir):await operationsCase(c,mutant,dir);
    const effectiveProof=await effectiveInjectionProof(dir,c);await saveJson(path.join(dir,'effective-injection-proof.json'),effectiveProof);
    await saveJson(path.join(dir,'detector-result.json'),result);
    results.push({mutationId:c.mutationId,originalFixtureId:c.originalFixtureId,area:c.area,lane:c.lane,severity:c.severity,truth:c.truth,independentOracle:c.independentOracle,
      oracleOrigin:c.oracleOrigin,expectedDecision:c.expectedDecision,actualDecision:result.decision,decision:result.decision,
      classification:classifyMutation({...c,...result}),expectationMatched:c.expectedDecision===result.decision,detector:c.detector,
      reason:result.reason,missedReason:result.decision==='pass' && c.truth==='defect'?result.reason:null,errorType:c.label,
      applicableScope:c.area==='semantic'?'RULE_QA_WITHOUT_INDEPENDENT_SEMANTIC_DETECTION':c.area==='typesetting'?'TOY_PIXELS_AND_REPORTED_LAYOUT_ONLY':c.lane,
      changedDataScope:effectiveProof.changes.map(p=>({path:p.path,originalFile:p.originalFile,mutatedFile:p.mutatedFile})),
      detectionEvidence:result.evidence,injectionProof:proof,effectiveInjectionProof:effectiveProof,evidenceFiles:await fileManifest(dir)});
  }
  const summary={byLane:summarizeByLane(results),byArea:Object.fromEntries([...new Set(results.map(r=>r.area))].map(area=>[area,summarizeByLane(results.filter(r=>r.area===area))]))};
  const report={schemaVersion:1,kind:'STAGE07_SYNTHETIC_MUTATION_RESULTS',createdAt:new Date().toISOString(),criteria:'STAGE07_PREREGISTERED_OBSERVATION_NOT_STAGE08_PRODUCT_THRESHOLDS',summary,results,
    expectedBehaviorMismatches:results.filter(r=>!r.expectationMatched).map(r=>r.mutationId),realMangaDetectionRates:null,
    limitations:['Synthetic oracles are programmatic and never registered as human GT.','Pixel deltas do not classify artwork or certify hidden background.','Rule QA scores do not measure semantic accuracy.','Integrity and structure detections are excluded from quality counts.']};
  await saveJson(path.join(outputDir,'Stage07_Detection_Results.json'),report);return report;
}
