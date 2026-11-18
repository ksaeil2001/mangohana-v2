// One internal text-only RAM diagnosis. No product source/config/job mutation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readBaseline} from './baseline.mjs';
import {runProfiledModel} from './runtime-profiled.mjs';
import {textOnlyRequest} from './profile-policy.mjs';
const require=createRequire(import.meta.url);
const {buildPageTranslationRequest,parsePageTranslation}=require('../../../packages/ai-engine/quality/page-translation.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
const noMmapNoHost=args.at(-1)==='--no-mmap-no-host';if(noMmapNoHost)args.pop();
if(![2,6].includes(args.length)||args[0]!=='--job'||(args.length===6&&(args[2]!=='--asset-receipt'||args[4]!=='--asset-receipt-sha256'||! /^[a-f0-9]{64}$/.test(args[5]))))throw new Error('JOB_ARGUMENT_REQUIRED');
const priorAssetReceipt=args.length===6?{path:args[3],sha256:args[5]}:undefined;
const baseline=await readBaseline(args[1]);
const kind=noMmapNoHost?'NO_MMAP_NO_HOST_TEXT_ONLY_9B_RESOURCE_ABLATION':'TEXT_ONLY_RAW_OCR_PAGE_CONTEXT_9B_RESOURCE_ABLATION';
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-qwen35-9b-text-'+(noMmapNoHost?'nommap-':'')+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
await fs.mkdir(output,{recursive:false});await fs.mkdir(path.join(output,'executed-source'));
const sourceFiles=['scripts/v2/semantic/probe-qwen35-9b-text.mjs','scripts/v2/semantic/runtime-profiled.mjs','scripts/v2/semantic/profile-policy.mjs','scripts/v2/semantic/asset-receipt.mjs','scripts/v2/semantic/baseline.mjs','packages/ai-engine/quality/page-translation.cjs','packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs'];
const codeHashes={};
for(const name of sourceFiles){const bytes=await fs.readFile(name);codeHashes[name]=sha(bytes);await fs.writeFile(path.join(output,'executed-source',name.replaceAll('/','__')+'.txt'),bytes,{flag:'wx'});}
const sourceReportBytes=await fs.readFile(path.join(baseline.job,'report.json'));
if(sha(sourceReportBytes)!==baseline.reportSha256)throw new Error('SOURCE_REPORT_CHANGED');
const report=JSON.parse(sourceReportBytes);
const lines=baseline.lines.map(line=>({...line,sourceLanguage:'ja',typesetting:{bbox:report.ocr.speechBubbles.find(bubble=>bubble.id===line.id).bbox}}));
const directory='E:/Dev/Models/MangohanaV2-semantic/qwen35-9b-3885219b';
const modelResource={id:'qwen35-9b-q4-k-m',fileName:'Qwen3.5-9B-Q4_K_M-3885219b.gguf',url:'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf',bytes:5680522464,sha256:'03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'};
// Identity verification includes the previously prepared projector; launch args omit it.
const projectorResource={id:'qwen35-9b-mmproj-f16',fileName:'mmproj-Qwen3.5-9B-F16-3885219b.gguf',url:'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/mmproj-F16.gguf',bytes:918166080,sha256:'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f'};
const profile={gpuLayers:20,contextSize:8192,batchSize:512,ubatchSize:512,imageMaxTokens:0,thinking:false,reasoningBudget:0,...(noMmapNoHost?{loadMode:'none',noHost:true}:{})};
const parameters={temperature:.6,top_p:.95,top_k:20,min_p:0,presence_penalty:0,repeat_penalty:1,seed:42,cache_prompt:false,max_tokens:2400,chat_template_kwargs:{enable_thinking:false}};
const alias=noMmapNoHost?'qwen35-9b-text-nommap':'qwen35-9b-text-semantic';
console.log(JSON.stringify({output,kind,imagesSentToModel:false,projectorLoaded:false,sceneManuallyProvided:false,profile}));
const result=await runProfiledModel({output,resource:modelResource,directory,projector:{resource:projectorResource,directory},alias,profile,priorAssetReceipt,async evaluate(request){
 const body=textOnlyRequest(buildPageTranslationRequest({lines,imageDataUrl:'data:image/png;base64,'+baseline.image.toString('base64')}));
 const payload={...body,...parameters};
 await fs.writeFile(path.join(output,'request-payload.json'),JSON.stringify({model:alias,stream:false,...payload},null,2),{flag:'wx'});
 const response=await request('text-only-page-context',{...body,...parameters});
 return {regions:parsePageTranslation(response.content,lines),responseIdentity:'validated_page_json_ids',requestId:response.requestId};
}});
const current=await readBaseline(baseline.job);
if(current.imageSha256!==baseline.imageSha256||current.reportSha256!==baseline.reportSha256)throw new Error('SOURCE_EVIDENCE_CHANGED');
const codeStable=Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,sha(await fs.readFile(name))===codeHashes[name]])));
const evidence={kind,productPathExecuted:false,sceneManuallyProvided:false,sourceTextManuallyCorrected:false,
 sourceJob:baseline.job,sourceImageSha256:baseline.imageSha256,sourceReportSha256:baseline.reportSha256,sourceEvidenceUnchanged:true,
 imageReadForIntegrityAndContractOnly:true,imageIncludedInAttemptedRequests:false,imagesSentToModel:false,projectorLoaded:false,projectorIdentityVerifiedButNotLoaded:Boolean(result.projectorModel),
 pageTextContextIncludedInRequests:result.modelHttpRequests>0,pageTextContextDeliveredWithValidResponse:result.successfulHttpRequests>0,
 modelRevision:'3885219b6810b007914f3a7950a8d1b469d598a5',baseModelRevision:'c202236235762e1c871ad0ccb60c8ee5ba337b9a',license:'Apache-2.0',parameters,
 ...result,sourceCodeHashesAtStart:codeHashes,sourceFilesUnchangedDuringRun:codeStable,qualityStatus:result.result?'PENDING_SEMANTIC_REVIEW':'NOT_EVALUATED_NO_MODEL_RESPONSE'};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:evidence.status,failure:evidence.failure,result:evidence.result,modelIntegrityMs:evidence.modelIntegrityMs,loadMs:evidence.loadMs,loadAttemptMs:evidence.loadAttemptMs,elapsedMs:evidence.elapsedMs,modelHttpRequests:evidence.modelHttpRequests,imagesSentToModel:false,cleanupConfirmed:evidence.cleanupConfirmed}));
if(result.failure||Object.values(codeStable).some(value=>!value))process.exitCode=1;
