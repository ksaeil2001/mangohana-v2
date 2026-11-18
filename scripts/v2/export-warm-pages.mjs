// Source export from immutable completed evidence only. No engine, model, browser or server launch.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {readBytes,readJson,verifyJobEvidence,prepareSourceExport} from './export-one-page.mjs';
const require=createRequire(import.meta.url),{imageHeader}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const {cacheProof,runtimeReuseMode,validateRuntimeConfiguration}=require('../../apps/engine/verify-warm.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest=/^[0-9a-f]{64}$/;
const scope='SOURCE_EXPORT_FROM_REAL_WARM_PIPELINE';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const fail=code=>Object.assign(new Error(code),{code});
const requireValue=(value,code='EXPORT_WARM_BINDING_INVALID')=>{if(!value)throw fail(code);};
async function canonical(directory){requireValue(same(await fs.realpath(directory),directory),'EXPORT_EVIDENCE_INVALID');const stat=await fs.lstat(directory);requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'EXPORT_EVIDENCE_INVALID');}
async function mustBeAbsent(file){try{await fs.lstat(file);throw fail('EXPORT_CONFLICT');}catch(error){if(error.code!=='ENOENT')throw error;}}
function verifyHeader(bytes,mime,width,height,code,maximum){try{const actual=imageHeader(bytes,mime,maximum);requireValue(actual.width===width&&actual.height===height,code);}catch{throw fail(code);}}

/** Optional CLI proof: all subprocess APIs and non-data-URL fetches are denied, even if caught. */
export function installSourceOnlyGuard(){
 const methods=['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'],originals=new Map(methods.map(key=>[key,childProcess[key]])),fetch=globalThis.fetch;let childProcessRequests=0,externalFetchRequests=0,restored=false;
 for(const key of methods)childProcess[key]=()=>{childProcessRequests++;throw fail('EXPORT_NATIVE_PROCESS_DENIED');};
 globalThis.fetch=async(input,...options)=>{const address=typeof input==='string'?input:input instanceof URL?input.href:input?.url;if(typeof address!=='string'||!/^data:image\/png;base64,/.test(address)){externalFetchRequests++;throw fail('EXPORT_EXTERNAL_FETCH_DENIED');}return Reflect.apply(fetch,globalThis,[input,...options]);};syncBuiltinESMExports();
 return {proof:()=>({childProcessRequests,externalFetchRequests,childProcessBoundary:'DENIED',externalFetchBoundary:'DENIED'}),restore(){if(restored)return;restored=true;for(const [key,value]of originals)childProcess[key]=value;globalThis.fetch=fetch;syncBuiltinESMExports();}};
}

export async function exportWarmPages(directory){
 requireValue(typeof directory==='string'&&path.isAbsolute(directory)&&/^E:[\\/]/i.test(directory),'EXPORT_EVIDENCE_INVALID');
 const runRoot=path.resolve(directory);await canonical(runRoot);
 const planFile=path.join(runRoot,'warm-plan.json'),warmFile=path.join(runRoot,'verification-warm.json'),innerFile=path.join(runRoot,'verification-inner.json');
 const [{value:plan,bytes:planBytes},{value:warm,bytes:warmBytes},{value:inner,bytes:innerBytes}]=await Promise.all([readJson(planFile),readJson(warmFile),readJson(innerFile)]);
 requireValue(plan.version===1&&plan.scope==='TWO_DISTINCT_JAPANESE_TECHNICAL_SAMPLES'&&uuid.test(plan.runId)&&same(plan.runRoot,runRoot)&&digest.test(plan.ownerScope)&&typeof plan.projectId==='string'&&plan.projectId.length>0&&plan.projectId.length<=200&&Array.isArray(plan.inputs)&&plan.inputs.length===2);
 requireValue(plan.manualCorrections===0&&plan.browserFlowVerified===false&&plan.storyChronologyVerified===false&&new Set(plan.inputs.map(sample=>sample.pageId)).size===2&&new Set(plan.inputs.map(sample=>sample.sourceSha256)).size===2);
 const ordinals=new Set();for(const sample of plan.inputs){requireValue(Number.isSafeInteger(sample.ordinal)&&sample.ordinal>=1&&sample.ordinal<=2&&!ordinals.has(sample.ordinal)&&uuid.test(sample.pageId)&&digest.test(sample.sourceSha256)&&typeof sample.originalPath==='string'&&path.isAbsolute(sample.originalPath)&&typeof sample.copyPath==='string'&&path.isAbsolute(sample.copyPath)&&path.dirname(path.resolve(sample.copyPath)).toLowerCase()===path.join(runRoot,'inputs').toLowerCase()&&Number.isSafeInteger(sample.bytes)&&sample.bytes>0&&sample.bytes<=8*1024*1024&&typeof sample.name==='string'&&sample.name.length>0&&sample.name.length<=180);ordinals.add(sample.ordinal);}
 requireValue([warm,inner].every(value=>value.version===1&&value.runId===plan.runId&&value.scope===plan.scope&&value.manualCorrections===0&&value.browserFlowVerified===false&&value.storyChronologyVerified===false&&Array.isArray(value.pages)&&value.pages.length<=2)&&['verified_runtime_reuse','verified_translation_reuse','partial','failed'].includes(warm.status)&&['completed','partial','failed'].includes(inner.status)&&isDeepStrictEqual(warm.pages,inner.pages));
 let mode,configHash;
 try{
  mode=runtimeReuseMode(plan);
  if(plan.runtimeReuseMode!==undefined){
   requireValue(same(plan.configPath,path.join(runRoot,'candidate-config.json'))&&digest.test(plan.configSha256),'EXPORT_WARM_CONFIGURATION_INVALID');
   const {value:config,bytes}=await readJson(plan.configPath);configHash=hash(bytes);
   requireValue(configHash===plan.configSha256&&same(config.runRoot,runRoot)&&same(config.profileRoot,path.join(runRoot,'profile'))&&same(config.dataRoot,path.join(runRoot,'jobs')),'EXPORT_WARM_CONFIGURATION_INVALID');
   validateRuntimeConfiguration(plan,config);
  }
 }catch{throw fail('EXPORT_WARM_CONFIGURATION_INVALID');}
 requireValue([warm,inner].every(value=>plan.runtimeReuseMode!==undefined?value.runtimeReuseMode===mode&&value.refineConnectedOcr===plan.refineConnectedOcr:(value.runtimeReuseMode??'OCR_WARM_TRANSLATION_WARM')===mode&&(value.refineConnectedOcr??false)===(plan.refineConnectedOcr===true)),'EXPORT_WARM_COMPLETION_INVALID');
 let pipelineComplete=false;
 if(['verified_runtime_reuse','verified_translation_reuse'].includes(warm.status)){
  requireValue(warm.status===(mode==='OCR_COLD_TRANSLATION_WARM'?'verified_translation_reuse':'verified_runtime_reuse'),'EXPORT_WARM_COMPLETION_INVALID');
  const proof=cacheProof(warm.pages,{runtimeReuseMode:mode});
  requireValue(inner.status==='completed'&&inner.failure==null&&warm.failure==null&&inner.cleanupConfirmed===true&&warm.cleanupConfirmed===true&&warm.innerCleanupConfirmed===true&&warm.osJobCleanupConfirmed===true&&warm.forcedTermination===false&&warm.sourceUnchanged===true&&proof.verified===true&&isDeepStrictEqual(proof,warm.cacheReuse)&&isDeepStrictEqual(proof,inner.cacheReuse),'EXPORT_WARM_COMPLETION_INVALID');
  let kernel;try{kernel=(await readJson(path.join(runRoot,'kernel-job-summary.json'))).value;}catch{throw fail('EXPORT_WARM_COMPLETION_INVALID');}
  requireValue(kernel.phase==='complete'&&kernel.runId===plan.runId&&kernel.rootExitCode===0&&kernel.supervisorExitCode===0&&kernel.supervisorClosed===true&&kernel.supervisorSignal==null&&kernel.failure==null&&kernel.kernelCleanupConfirmed===true&&kernel.activeProcessesAfter===0,'EXPORT_WARM_COMPLETION_INVALID');
  pipelineComplete=true;
 }
 const seenJobs=new Set(),seenPages=new Set(),prepared=[];const controlHashes={warmPlan:hash(planBytes),warmReport:hash(warmBytes),innerReport:hash(innerBytes),...(configHash?{candidateConfig:configHash}:{})};
 for(const row of warm.pages){
  const sample=plan.inputs.find(value=>value.ordinal===row.ordinal);requireValue(sample&&row.pageId===sample.pageId&&row.sourceSha256===sample.sourceSha256&&!seenPages.has(row.pageId));seenPages.add(row.pageId);
  if(row.evidenceVerified!==true){requireValue(row.status!=='completed'||row.evidenceVerified===false);continue;}
  requireValue(row.status==='completed'&&row.manualCorrections===0&&uuid.test(row.jobId)&&!seenJobs.has(row.jobId)&&digest.test(row.reportSha256)&&digest.test(row.candidateSha256));seenJobs.add(row.jobId);
  const jobDirectory=path.join(runRoot,'jobs',row.jobId),pageDirectory=path.join(runRoot,'page-'+String(row.ordinal).padStart(2,'0'));requireValue(same(row.jobDirectory,jobDirectory)&&same(row.pageDirectory,pageDirectory));await canonical(pageDirectory);
  const {value:pageEvidence}=await readJson(path.join(pageDirectory,'evidence.json'));requireValue(isDeepStrictEqual(pageEvidence,row));
  const verified=await verifyJobEvidence({jobId:row.jobId,jobDirectory,sourcePath:sample.originalPath,sourceSha256:sample.sourceSha256,resultPath:path.join(pageDirectory,'studio-result.json'),regions:row.regions,expectedReportSha256:row.reportSha256});
  const {state,report,assets,original}=verified;
  requireValue(state.owner===plan.ownerScope&&state.projectId===plan.projectId&&state.pageId===sample.pageId&&state.pageNumber===sample.ordinal&&state.sourceLanguage==='ja'&&report.sourceLanguage==='ja'&&report.manualCorrections===0);
  const copy=await readBytes(sample.copyPath,8*1024*1024,'EXPORT_SOURCE_MISMATCH');requireValue(hash(copy)===sample.sourceSha256&&copy.equals(original)&&copy.length===sample.bytes,'EXPORT_SOURCE_MISMATCH');
  verifyHeader(original,state.mime,state.width,state.height,'EXPORT_SOURCE_MISMATCH',8*1024*1024);requireValue(sample.width===state.width&&sample.height===state.height,'EXPORT_SOURCE_MISMATCH');
  for(const bytes of Object.values(assets))verifyHeader(bytes,'image/png',state.width,state.height,'EXPORT_EVIDENCE_INVALID',32*1024*1024);
  const pageCandidate=await readBytes(path.join(pageDirectory,'candidate.png'),32*1024*1024);requireValue(pageCandidate.equals(assets.candidate)&&row.candidateSha256===report.hashes.candidate,'EXPORT_EVIDENCE_INVALID');
  const ids=report.lines.map(line=>line.id),requests=report.translationRequests??[];
  requireValue(isDeepStrictEqual(row.regionIds,ids)&&row.regions===ids.length&&report.lines.every(line=>line.sourceText===report.ocr.speechBubbles.find(region=>region.id===line.id)?.text)&&requests.length>0&&isDeepStrictEqual(row.requestIds,requests.map(request=>request.requestId))&&row.modelHttpRequests===requests.reduce((sum,request)=>sum+request.httpRequests,0));
  const outputDirectory=path.join(pageDirectory,'source-export');await mustBeAbsent(outputDirectory);
  const evidence={...row,scope,pipelineRunId:plan.runId,pipelineStatus:warm.status,runtimeReuseMode:mode,refineConnectedOcr:plan.refineConnectedOcr===true,pipelineReports:controlHashes,newAiCalls:0,sourceExportOnly:true,originalPreserved:true,browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0,qualityStatus:'pending',pipelineCleanupConfirmed:warm.cleanupConfirmed===true,pipelineWarnings:verified.result.warnings};
  prepared.push({outputDirectory,...await prepareSourceExport({verified,evidence,inputPath:sample.originalPath,outputDirectory,projectName:'일본어 warm 파이프라인 · '+sample.ordinal,pageId:sample.pageId,projectId:plan.projectId})});
 }
 requireValue(prepared.length>0,'EXPORT_NO_COMPLETED_WARM_PAGES');
 // Recheck every destination/control file before reserving directories or writing any PNG/TRIO.
 requireValue(hash(await readBytes(planFile,16*1024*1024))===controlHashes.warmPlan&&hash(await readBytes(warmFile,16*1024*1024))===controlHashes.warmReport&&hash(await readBytes(innerFile,16*1024*1024))===controlHashes.innerReport);
 if(configHash)requireValue(hash(await readBytes(plan.configPath,16*1024*1024))===configHash,'EXPORT_WARM_CONFIGURATION_INVALID');
 for(const page of prepared)await mustBeAbsent(page.outputDirectory);
 for(const page of prepared)try{await fs.mkdir(page.outputDirectory);}catch(error){if(error.code==='EEXIST')throw fail('EXPORT_CONFLICT');throw error;}
 for(const page of prepared)for(const [name,bytes]of page.outputs)await fs.writeFile(path.join(page.outputDirectory,name),bytes,{flag:'wx'});
 return {version:1,scope,runId:plan.runId,pipelineStatus:warm.status,runtimeReuseMode:mode,refineConnectedOcr:plan.refineConnectedOcr===true,pipelineComplete:pipelineComplete&&prepared.length===2,newAiCalls:0,browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0,qualityStatus:'pending',pages:prepared.map(page=>page.complete)};
}

if(process.argv[1]&&same(path.resolve(process.argv[1]),fileURLToPath(import.meta.url))){
 let guard;try{const args=process.argv.slice(2),deny=args.includes('--deny-native'),remaining=args.filter(arg=>arg!=='--deny-native');requireValue(remaining.length===2&&remaining[0]==='--resume','EXPORT_USAGE');if(deny)guard=installSourceOnlyGuard();const result=await exportWarmPages(path.resolve(remaining[1]));if(guard){result.sourceOnlyProof=guard.proof();requireValue(result.sourceOnlyProof.childProcessRequests===0&&result.sourceOnlyProof.externalFetchRequests===0,'EXPORT_SOURCE_ONLY_PROOF_FAILED');}console.log(JSON.stringify(result));}catch(error){console.error(JSON.stringify({status:'failed',code:error.code??'EXPORT_FAILED'}));process.exitCode=1;}finally{guard?.restore();}
}
