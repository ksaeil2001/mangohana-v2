// Automatic-condition internal PoC only. No product job, source image or config edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readBaseline} from './baseline.mjs';
import {runProfiledModel} from './runtime-profiled.mjs';
const require=createRequire(import.meta.url);
const {buildPageTranslationRequest,parsePageTranslation}=require('../../../packages/ai-engine/quality/page-translation.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
if(![2,6].includes(args.length)||args[0]!=='--job'||(args.length===6&&(args[2]!=='--asset-receipt'||args[4]!=='--asset-receipt-sha256'||! /^[a-f0-9]{64}$/.test(args[5]))))throw new Error('JOB_ARGUMENT_REQUIRED');
const priorAssetReceipt=args.length===6?{path:args[3],sha256:args[5]}:undefined;
const baseline=await readBaseline(args[1]);
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-qwen35-9b-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
await fs.mkdir(output,{recursive:false});await fs.mkdir(path.join(output,'executed-source'));
const sourceFiles=['scripts/v2/semantic/probe-qwen35-9b.mjs','scripts/v2/semantic/runtime-profiled.mjs','scripts/v2/semantic/asset-receipt.mjs','scripts/v2/semantic/baseline.mjs','scripts/v2/semantic/protocol.mjs','packages/ai-engine/quality/page-translation.cjs','packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs'];
const codeHashes={};
for(const name of sourceFiles){const bytes=await fs.readFile(name);codeHashes[name]=sha(bytes);await fs.writeFile(path.join(output,'executed-source',name.replaceAll('/','__')+'.txt'),bytes,{flag:'wx'});}
const sourceReportBytes=await fs.readFile(path.join(baseline.job,'report.json'));
if(sha(sourceReportBytes)!==baseline.reportSha256)throw new Error('SOURCE_REPORT_CHANGED');
const report=JSON.parse(sourceReportBytes);
const lines=baseline.lines.map(line=>({...line,sourceLanguage:'ja',typesetting:{bbox:report.ocr.speechBubbles.find(bubble=>bubble.id===line.id).bbox}}));
const directory='E:/Dev/Models/MangohanaV2-semantic/qwen35-9b-3885219b';
const modelResource={id:'qwen35-9b-q4-k-m',fileName:'Qwen3.5-9B-Q4_K_M-3885219b.gguf',url:'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf',bytes:5680522464,sha256:'03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'};
const projectorResource={id:'qwen35-9b-mmproj-f16',fileName:'mmproj-Qwen3.5-9B-F16-3885219b.gguf',url:'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/mmproj-F16.gguf',bytes:918166080,sha256:'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f'};
const profile={gpuLayers:20,contextSize:8192,batchSize:4096,ubatchSize:4096,imageMaxTokens:1024,thinking:false,reasoningBudget:0};
const parameters={temperature:.6,top_p:.95,top_k:20,min_p:0,presence_penalty:0,repeat_penalty:1,seed:42,cache_prompt:false,max_tokens:2400,chat_template_kwargs:{enable_thinking:false}};
console.log(JSON.stringify({output,kind:'AUTOMATIC_IMAGE_AND_RAW_OCR_9B_CANDIDATE',sceneManuallyProvided:false,profile}));
const result=await runProfiledModel({output,resource:modelResource,directory,projector:{resource:projectorResource,directory},alias:'qwen35-9b-semantic',profile,priorAssetReceipt,async evaluate(request){
 const body=buildPageTranslationRequest({lines,imageDataUrl:'data:image/png;base64,'+baseline.image.toString('base64')});
 const response=await request('automatic-page-image-context',{...body,...parameters});
 return {regions:parsePageTranslation(response.content,lines),responseIdentity:'validated_page_json_ids',requestId:response.requestId};
}});
const current=await readBaseline(baseline.job);
if(current.imageSha256!==baseline.imageSha256||current.reportSha256!==baseline.reportSha256)throw new Error('SOURCE_EVIDENCE_CHANGED');
const codeStable=Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,sha(await fs.readFile(name))===codeHashes[name]])));
const evidence={kind:'AUTOMATIC_IMAGE_AND_RAW_OCR_9B_CANDIDATE',productPathExecuted:false,sceneManuallyProvided:false,sourceTextManuallyCorrected:false,
 sourceJob:baseline.job,sourceImageSha256:baseline.imageSha256,sourceReportSha256:baseline.reportSha256,sourceEvidenceUnchanged:true,
 imageIncludedInAttemptedRequests:result.modelHttpRequests>0,imagesSentToModel:result.successfulHttpRequests>0?true:(result.modelHttpRequests===0?false:null),
 pageTextContextConsumed:result.successfulHttpRequests>0?true:(result.modelHttpRequests===0?false:null),modelRevision:'3885219b6810b007914f3a7950a8d1b469d598a5',baseModelRevision:'c202236235762e1c871ad0ccb60c8ee5ba337b9a',license:'Apache-2.0',parameters,
 ...result,sourceCodeHashesAtStart:codeHashes,sourceFilesUnchangedDuringRun:codeStable,qualityStatus:'PENDING_SEMANTIC_REVIEW'};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:evidence.status,failure:evidence.failure,result:evidence.result,modelIntegrityMs:evidence.modelIntegrityMs,loadMs:evidence.loadMs,elapsedMs:evidence.elapsedMs,modelHttpRequests:evidence.modelHttpRequests,cleanupConfirmed:evidence.cleanupConfirmed}));
if(result.failure||Object.values(codeStable).some(value=>!value))process.exitCode=1;
