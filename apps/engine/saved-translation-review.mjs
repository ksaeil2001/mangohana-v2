// Fixed server-owned development intake. Browser input selects neither paths nor authority.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {realpath} from 'node:fs/promises';
import {readBounded} from './translation-review-store.mjs';
const require=createRequire(import.meta.url),{inspectSubmission}=require('../../packages/ai-engine/quality/human-translation-review.cjs');
const sha=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function must(ok){if(!ok)throw Object.assign(Error('보존한 개발용 원본·선택문 또는 출처가 변경됐습니다. 원자료를 보존하고 적용을 중단합니다.'),{code:'REVIEW_SOURCE_CONFLICT',status:409});}
export async function loadSavedTranslationReview(id){
 must(id==='stage14r3');
 const descriptor=JSON.parse(await readBounded(new URL('./stage14r3-review-source.json',import.meta.url),64*1024));must(descriptor.id===id);
 const files=Object.fromEntries(await Promise.all(Object.entries(descriptor.files).map(async([key,spec])=>{
  const file=path.resolve(root,spec.path);must((await realpath(file)).toLowerCase()===file.toLowerCase());const bytes=await readBounded(file,8*1024*1024);must(sha(bytes)===spec.sha256);return [key,bytes];
 })));
 const packet=JSON.parse(files.packet),submission=JSON.parse(files.submission),candidates=JSON.parse(files.candidates),input=JSON.parse(files.input),checkpoint=JSON.parse(files.checkpoint);
 const inspected=inspectSubmission(packet,submission),b=packet.bindings;
 must(packet.packetSha256===descriptor.packetSha256&&packet.regions.length===13&&inspected.regions.length===13);
 must(sha(files.source)===packet.scope.sourceSha256&&sha(files.normalized)===b.normalizedSha256&&sha(files.candidates)===b.candidateSetSha256&&sha(files.input)===b.translationInputSha256);
 must(packet.fullSourceDataUrl==='data:image/png;base64,'+files.source.toString('base64'));
 const {fingerprint,...unsigned}=input;must(fingerprint===sha(unsigned)&&fingerprint===b.inputFingerprint);
 for(const key of ['owner','projectId','pageId','pageNumber','sourceSha256'])must(packet.scope[key]===input.scope[key]);
 must(checkpoint.scope.ownerScope===packet.scope.owner);
 for(const key of ['projectId','pageId','pageNumber','sourceSha256'])must(packet.scope[key]===checkpoint.scope[key]);
 must(checkpoint.scope.normalizedSha256===b.normalizedSha256&&checkpoint.payload.extraction.speechBubbles.length===13);
 const regions=packet.regions.map(r=>{
  const row=inspected.regions.find(v=>v.regionId===r.regionId),candidate=candidates.candidates.find(v=>v.id===r.regionId),observed=input.regions.find(v=>v.id===r.regionId);
  must(row&&candidate&&observed&&row.selectedTranslation&&candidate.sourceText===r.sourceText&&candidate.rawTranslatedText===r.translatedText&&observed.sourceText===r.sourceText);
  return {regionId:r.regionId,order:r.order,rawOcr:r.rawOcrText,sourceText:r.sourceText,sourceReading:candidate.proposedSource??candidate.sourceText,sourceReadingOrigin:candidate.proposedSource===undefined?'SAVED_OCR_SOURCE':'SAVED_AI_PROPOSED_SOURCE',originalAiTranslation:r.translatedText,selectedUserTranslation:row.selectedTranslation,selectionOrigin:row.selectionOrigin,editRevision:row.editRevision,originalConfirmedByHuman:row.confirmedByHuman,sourceLineIds:r.sourceLineIds,bbox:r.bbox,riskSignals:r.signals,originalRiskDecisions:row.riskDecisions,remainingUncertainties:row.remainingUncertainties,aiCandidateOrigin:r.origin,originalRationale:row.rationale};
 });
 return {id,packetSha256:packet.packetSha256,submissionSha256:sha(files.submission),parsedSubmissionSha256:sha(submission),sourceSha256:packet.scope.sourceSha256,normalizedSha256:b.normalizedSha256,candidateSetSha256:b.candidateSetSha256,translationInputSha256:b.translationInputSha256,selectedSetSha256:sha(regions.map(r=>[r.regionId,r.selectedUserTranslation,r.selectionOrigin,r.editRevision])),sourceScope:packet.scope,processingGeneration:b.processingGeneration,sourceContextRevision:b.contextRevision,sourceBaselineEditRevision:b.baseEditRevision,sourceImage:packet.fullSourceDataUrl,normalizedImage:'data:image/png;base64,'+files.normalized.toString('base64'),originalCheckpointSha256:sha(files.checkpoint),regions};
}
