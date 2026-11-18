// Saved-output evaluation and isolated candidate packet. Never applies a job.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';
const require=createRequire(import.meta.url),audit=process.argv[2];
const page=require('../../packages/ai-engine/quality/page-translation.cjs'),contract=require('../../packages/ai-engine/quality/translation-contract.cjs'),revision=require('../../packages/ai-engine/quality/translation-revision.cjs');
const {inspectTranslationQuality}=await tsImport('../../packages/ai-engine/vendor/trio/src/shared/translation/translationQa.ts',import.meta.url);
const saved='C:/dev/Projects/_audits/MangoHana_14R2_20261113_215800/evidence/saved',actual=path.join(audit,process.argv[3]==='after-memory'?'evidence/actual-model-after-memory':'evidence/actual-model');
const read=async(base,n)=>JSON.parse(await fs.readFile(path.join(base,n),'utf8')),sha=x=>createHash('sha256').update(x).digest('hex');
const input=await read(saved,'translation-input.json'),ocr=await read(saved,'ocr.json'),historical=await read(saved,'translation-response-page.json'),savedTranslations=await read(saved,'translations.json');
const previous=page.parsePageTranslationResponse(historical.response,input.regions),oldValidated=contract.validateTranslationBatch({input,results:previous}),model=await read(actual,'model-receipt.json'),plan=await read(actual,'selection-plan.json');
let a,b,error=null,comparison={status:'BLOCKED',candidates:previous,applied:false,executionAuthorized:false};
try{
 a=await read(actual,'A-validated.json');b=await read(actual,'B-validated.json');
 comparison=revision.reviewSelectiveReplacement({plan,input,previousResults:previous,replacementResults:b.parsed});
}catch(e){error=e.code??e.message;}
const qa=row=>inspectTranslationQuality({sourceText:row.sourceText,translatedText:row.translatedText,dialogueType:input.regions.find(r=>r.id===row.id).dialogueType});
const bQa=b?.parsed.map(r=>({id:r.id,qaReport:qa(r)}))??[];
// Production's numeric QA errors are a separate requirement beyond language.
const qaErrors=bQa.flatMap(r=>r.qaReport.issues.filter(i=>i.severity==='error').map(issue=>({id:r.id,issue})));
if(qaErrors.length)comparison={...comparison,status:'REJECTED_PRESERVED',candidates:previous,reasons:[...(comparison.reasons??[]),...qaErrors],applied:false,executionAuthorized:false};
const rows=input.regions.map((region,i)=>{
 const old=oldValidated[i],ar=a?.validated.find(r=>r.id===region.id),br=b?.validated.find(r=>r.id===region.id),group=ocr.speechBubbles.find(r=>r.id===region.id);
 return {id:region.id,order:region.order,rawOcrText:group.productionOcrProvenance?.recognition?.rawOcrText??null,ocrObservation:region.sourceText,sourceLineIds:region.sourceLineIds,bbox:group.bbox,
  historicalA13:{modelSourceReading:old.proposedSource,translation:old.rawTranslatedText,originalQa:savedTranslations.records.find(r=>r.id===region.id)?.qaReport,currentPolicy:old.semantic},
  controlledA5:ar?{modelSourceReading:ar.proposedSource,translation:ar.rawTranslatedText,language:ar.semantic.outputCompliance,semanticSignals:ar.semantic.signals,qaReport:qa(ar)}:null,
  candidateB5:br?{modelSourceReading:br.proposedSource,translation:br.rawTranslatedText,language:br.semantic.outputCompliance,semanticSignals:br.semantic.signals,qaReport:qa(br)}:null,
  proposed13Origin:br?'NEW_B5_CANDIDATE':'REUSED_HISTORICAL_A13',candidateSetStatus:comparison.status,
  humanReview:{status:'HUMAN_REVIEW_PENDING',humanSemanticVerified:null,correctedTranslation:null},sourceObservationPromotedFromModel:false};
});
const languageFailures=x=>x?.validated.filter(r=>r.semantic.outputCompliance.status!=='PASS').length??null;
const metrics={historicalA13:{regions:13,languageFailures:oldValidated.filter(r=>r.semantic.outputCompliance.status!=='PASS').length,kind:'PAST_REAL_EXECUTION_REEVALUATED_BY_CURRENT_POLICY',newCalls:0},controlledA5:{regions:a?.validated.length??0,languageFailures:languageFailures(a)},candidateB5:{regions:b?.validated.length??0,languageFailures:languageFailures(b)},sourceReadingChangesA5:a?.parsed.filter(r=>r.proposedSource!==r.sourceText).length??null,sourceReadingChangesB5:b?.parsed.filter(r=>r.proposedSource!==r.sourceText).length??null,qaErrors,semanticAccuracy:null,humanReviewedRegions:0};
const output={version:'stage14r3-comparison-v1',status:comparison.status,error,inputFingerprint:input.fingerprint,modelReceiptSha256:sha(await fs.readFile(path.join(actual,'model-receipt.json'))),metrics,rows,selection:{regionIds:plan.regionIds,maximumCalls:2},policy:{humanReviewRequired:true,automaticApproval:false,executionAuthorized:false,unflaggedIsNotSemanticPass:true,fullThirteenFreshInference:false},comparison:{...comparison,candidates:undefined},model};
await fs.writeFile(path.join(audit,'Stage14R3_Thirteen_Region_Comparison.json'),JSON.stringify(output,null,2),{flag:'wx'});
if(comparison.status==='UNREVIEWED_CANDIDATE_SET')await fs.writeFile(path.join(audit,'Stage14R3_Unreviewed_Candidates.json'),JSON.stringify({version:'stage14r3-unreviewed-candidates-v1',status:'UNREVIEWED_CANDIDATE_SET',sourceSha256:input.scope.sourceSha256,inputFingerprint:input.fingerprint,regionIds:input.regions.map(r=>r.id),candidates:comparison.candidates,origins:rows.map(r=>({id:r.id,origin:r.proposed13Origin})),humanSemanticVerified:null,executionAuthorized:false,applied:false},null,2),{flag:'wx'});
const esc=s=>String(s??'—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const html='<!doctype html><html lang="ko"><meta charset="utf-8"><title>Stage14-R3 미검수 번역 비교</title><style>body{font:16px system-ui;max-width:1500px;margin:30px auto;padding:16px;line-height:1.6}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:9px;text-align:left;vertical-align:top}small{color:#555}.hold{background:#fff3dd}</style><h1>Stage14-R3 — 사람 미검수 후보 비교</h1><p class="hold">검토 완료 0/13. 모든 번역은 AI 후보입니다. 한국어 문자 검사 통과는 의미 정확도 합격이 아닙니다. 이 문서는 제품 값을 반영하거나 LaMa·식자를 실행하지 않습니다. 상태: '+esc(comparison.status)+'</p><p>과거 A13의 8개 영역을 재사용하고 지정 5개에 A/B 각1회만 새 추론했습니다. 원문·source_reading·translation을 구분합니다.</p><table><thead><tr><th>영역 / OCR 원문</th><th>과거 A13</th><th>동일5영역 A</th><th>새 B</th><th>검토 상태</th></tr></thead><tbody>'+rows.map(r=>'<tr><td><small>'+esc(r.id)+'</small><br>'+esc(r.ocrObservation)+'</td><td>'+esc(r.historicalA13.translation)+'</td><td>'+esc(r.controlledA5?.translation)+'</td><td>'+esc(r.candidateB5?.translation)+'<br><small>판독 제안: '+esc(r.candidateB5?.modelSourceReading)+'</small></td><td>HUMAN_REVIEW_PENDING<br><small>'+esc((r.candidateB5?.semanticSignals??r.historicalA13.currentPolicy.signals).map(s=>s.code).join(', '))+'</small></td></tr>').join('')+'</tbody></table><p>수혜 관계·인명 표기·연속 대사·짧은 감탄사를 원본 페이지와 함께 사람이 확인해야 합니다. 의미/작화/잔상/최종 식자 품질은 아직 확인하지 않았습니다.</p></html>';
await fs.writeFile(path.join(audit,'Stage14R3_Unreviewed_Comparison.html'),html,{flag:'wx'});
console.log(JSON.stringify({status:comparison.status,metrics,error}));
