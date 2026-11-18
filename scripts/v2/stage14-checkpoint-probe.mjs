// Current real OCR checkpoint replay through the unchanged product checkpoint loader. No model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),audit=process.argv[2],b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
const {createCheckpointSession}=require('../../packages/ai-engine/quality/recovery-checkpoint.cjs');
const {parsePageTranslation}=require('../../packages/ai-engine/quality/page-translation.cjs');
const read=p=>fs.readFile(p,'utf8').then(JSON.parse),sha=x=>createHash('sha256').update(x).digest('hex');
const dirs=(await fs.readdir(b.runRoot,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name.startsWith('single-page-'));
if(dirs.length!==1)throw Error('EXPLICIT_SINGLE_RUN_REQUIRED');
const run=path.join(b.runRoot,dirs[0].name),page=await read(path.join(run,'page-run-receipt.json')),row=page.rows[0],directory=row.jobDirectory,state=await read(path.join(directory,'state.json'));
const original=await fs.readFile(path.join(directory,'checkpoint-ocr.json')),saved=JSON.parse(original),receipt=state.checkpoints?.ocr;
if(!receipt||sha(original)!==receipt.sha256)throw Error('ACTUAL_CHECKPOINT_RECEIPT_REQUIRED');
const output=path.join(b.runRoot,'current-ocr-checkpoint-replay');await fs.mkdir(output);
const loader=(scope=saved.scope,identity=saved.identity,sourceDirectory=directory)=>createCheckpointSession({directory:output,jobId:'stage14-no-inference-probe',scope,resumeFrom:{directory:sourceDirectory,jobId:state.id,checkpoints:state.checkpoints}});
const valid=loader(),value=await valid.load('ocr',saved.identity);if(!value)throw Error('REAL_CHECKPOINT_REUSE_FAILED');
const mismatches=[];
for(const [name,scope,identity]of [['wrong-source',{...saved.scope,sourceSha256:'f'.repeat(64)},saved.identity],['wrong-owner',{...saved.scope,ownerScope:'e'.repeat(64)},saved.identity],['wrong-work',{...saved.scope,projectId:'other-work'},saved.identity],['wrong-page',{...saved.scope,pageId:'other-page'},saved.identity],['wrong-model-configuration',saved.scope,{...saved.identity,configuration:'d'.repeat(64)}]]){
 const l=loader(scope,identity),out=await l.load('ocr',identity);mismatches.push({name,rejected:out===null,evidence:l.evidence()});
}
const damaged=path.join(output,'damaged-copy');await fs.mkdir(damaged);await fs.writeFile(path.join(damaged,'checkpoint-ocr.json'),Buffer.concat([original,Buffer.from('\ncorrupted-copy')] ),{flag:'wx'});
const corrupt=loader(saved.scope,saved.identity,damaged),bad=await corrupt.load('ocr',saved.identity);mismatches.push({name:'damaged-checkpoint-copy',rejected:bad===null,evidence:corrupt.evidence()});
const translationInput=await read(path.join(directory,'translation-input.json')),response=await read(path.join(directory,'translation-response-page.json'));
const content=response.response.choices?.[0]?.message?.content;let jsonError=null,parseError=null;
const reasoning=response.response.choices?.[0]?.message?.reasoning_content;
try{JSON.parse(content);}catch(e){jsonError={name:e.name,message:e.message};}
try{parsePageTranslation(content,translationInput.regions);}catch(e){parseError={code:e.code,name:e.name};}
const contract={scope:'OFFLINE_ANALYSIS_OF_SAVED_ACTUAL_PAGE_RESPONSE',requestId:response.requestId,model:response.response.model,promptVersion:response.promptVersion,expectedRegionIds:translationInput.regions.map(r=>r.id),finishReason:response.response.choices?.[0]?.finish_reason,usage:response.response.usage??null,responseContentBytes:Buffer.byteLength(content??''),responseContentSha256:sha(content??''),jsonError,parseError,sourceMaxTokens:2400,sourceTemperature:0,cause:response.response.choices?.[0]?.finish_reason==='length'&&response.response.usage?.completion_tokens===2400?'ACTUAL_NATIVE_RESPONSE_TRUNCATED_AT_UNCHANGED_2400_OUTPUT_TOKEN_CAP':'REFER_TO_RAW_RESPONSE',rawResponsePath:path.join(directory,'translation-response-page.json'),rawResponseSha256:sha(await fs.readFile(path.join(directory,'translation-response-page.json'))),modelRequests:1,automaticRetry:false,promptOrSamplingChanged:false,partiallyApplied:false};
contract.responseReasoningBytes=typeof reasoning==='string'?Buffer.byteLength(reasoning):null;
contract.cause=content===''&&typeof reasoning==='string'&&contract.finishReason==='length'?'EMPTY_FINAL_CONTENT_WITH_REASONING_OUTPUT_AND_LENGTH_AT2400':contract.cause;
contract.rootCauseLimit='Observed channel/format/budget incompatibility; changing max_tokens alone is not validated as a fix.';
const preservation=sha(await fs.readFile(path.join(directory,'checkpoint-ocr.json')))===sha(original);
const result={scope:'C_CURRENT_REAL_OCR_CHECKPOINT_REPLAY_NOT_NEW_OCR_OR_FULL_RUNTIME_RECOVERY',jobId:state.id,checkpointReceipt:receipt,scopeIdentity:saved.scope,configurationIdentity:saved.identity,validReuse:!!value,reusedStages:valid.evidence().reusedStages,payloadSha256:sha(JSON.stringify(value?.payload)),restoredOcrGroups:value?.payload?.extraction?.speechBubbles?.length??null,mismatches,originalCheckpointUnchanged:preservation,additionalModelCalls:0,roiUnitResume:false,actualRuntimeRecoveryVerified:false};
// Keep the response diagnosis separate from the loader's result to avoid conflating C and D.
result.translationResponseAnalysis=contract;
if(!mismatches.every(m=>m.rejected)||!preservation)throw Error('CHECKPOINT_REJECTION_OR_PRESERVATION_FAILED');
await fs.writeFile(path.join(audit,'evidence/current-real-checkpoint-replay.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({validReuse:result.validReuse,restoredOcrGroups:result.restoredOcrGroups,rejected:mismatches.length,originalUnchanged:preservation,additionalModelCalls:0,pageFinishReason:contract.finishReason,usage:contract.usage,cause:contract.cause}));
