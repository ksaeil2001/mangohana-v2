// Only called after the Controller has durably consumed a separately approved Permit.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createWarmJob} from '../../scripts/v2/warm-job.mjs';import {loadStage14ImageProfile} from './imported-page-preflight.mjs';
import {readBounded} from './translation-review-store.mjs';import {demand,digest,writeExclusive} from './image-permit-store.mjs';
import {publishGateJson,readGateJson} from '../../packages/ai-engine/quality/imported-image-diagnostics.cjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Private failure evidence never authorizes execution. Kernel cleanup takes precedence.
export async function readImportedWorkerError({directory,permit,completion}){
 const failure=code=>Object.assign(Error('이미지 실행이 중단됐습니다. 보존된 실패 진단을 확인해 주세요.'),{code});
 if(completion?.kernelCleanupConfirmed!==true||completion?.supervisorClosed!==true)return failure('IMAGE_CLEANUP_UNKNOWN');
 if(completion.supervisorExitCode!==0||!Number.isInteger(completion.rootExitCode)||completion.rootExitCode===0)return failure('IMAGE_RUNTIME_FAILED');
 try{
  const record=JSON.parse(await readBounded(path.join(directory,'failure.json'),256*1024));
  const codes=new Set(['MANUAL_LAYOUT_REQUIRED','FONT_OR_GLYPH_ERROR','TYPESET_OVERFLOW','TYPESET_TEXT_MISMATCH','TYPESET_RESULT','CLEANUP_FAILED','IMAGE_CLEANUP_UNKNOWN','DIAGNOSTIC_SAVE_FAILED','DIAGNOSTIC_PORTS_REQUIRED','BACKGROUND_DIAGNOSTICS_INVALID','DIAGNOSTIC_NATIVE_PIXEL_PROOF_REQUIRED','TYPESETTING_ONLY_AI_CALL_FORBIDDEN','TYPESETTING_SOURCE_CHANGED','TYPESETTING_SOURCE_BINDING_INVALID','TYPESETTING_FRAME_INVALID','TYPESETTING_CANDIDATE_INVALID','TYPESETTING_ONLY_PERMIT_REQUIRED','FONT_UNAVAILABLE','SOURCE_CHANGED']);
  if(record.version!==1||record.permitId!==permit.permitId||record.executionGeneration!==permit.executionGeneration||!codes.has(record.code)||record.forbidden?.network!==0||record.forbidden?.otherProcess!==0)return failure('IMAGE_RUNTIME_FAILED');
  return Object.assign(failure(record.code),{workerFailure:{reportedCode:record.code,lastCompletedGate:typeof record.lastCompletedGate==='string'&&/^[a-z-]{1,64}$/.test(record.lastCompletedGate)?record.lastCompletedGate:null,layoutDiagnosticsAvailable:[1,2,3,4].includes(record.layoutDiagnostics?.version),diagnosticArtifactsRecorded:!!record.diagnosticArtifacts?.cleaned,backgroundDiagnosticsRecorded:!!record.diagnosticArtifacts?.background,diagnosticPersistenceFailed:!!record.diagnosticPersistenceError,stackAvailable:typeof record.stack==='string'}});
 }catch{return failure('IMAGE_RUNTIME_FAILED');}
}
export function createImportedPageRuntime({executionMode='FULL_IMAGE'}={}){demand(['FULL_IMAGE','TYPESETTING_ONLY'].includes(executionMode),'IMAGE_RUNTIME_CONFIG',503);return async args=>{
 const {binding,inputs,permit,outputDirectory,signal,revalidate}=args;await revalidate('runtime-start');
 demand((permit.executionMode??'FULL_IMAGE')===executionMode,'IMAGE_EXECUTION_MODE_MISMATCH');const typed=executionMode==='TYPESETTING_ONLY';
 const {config:originalConfig,source}=await loadStage14ImageProfile(),directory=path.join(outputDirectory,'work'),profileRoot=path.join(directory,'profile');
 await fs.mkdir(directory);await fs.mkdir(path.join(profileRoot,'engine-temp'),{recursive:true});
 const config=typed?{buildRoot:originalConfig.buildRoot,resourcesPath:originalConfig.resourcesPath,rendererBundle:originalConfig.rendererBundle,textMaskAlgorithm:originalConfig.textMaskAlgorithm,profileRoot}:{...originalConfig,profileRoot},workerSource=typed?{directory:source.directory,expectedGeneration:source.expectedGeneration,expectedCheckpointSha256:source.expectedCheckpointSha256}:source;await writeExclusive(path.join(directory,'input.json'),JSON.stringify({binding,inputs,permit,config,source:workerSource}));
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:originalConfig.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
 const log=await fs.open(path.join(directory,'runtime.log'),'wx');let writing=Promise.resolve(),child,completion,polling,stopping=false,guardError;
 const append=b=>{writing=writing.then(()=>log.write(b));};const abort=()=>void child?.stop();signal.addEventListener('abort',abort,{once:true});
 try{
  child=await createWarmJob({directory,runId:permit.executionGeneration,executable:path.join(repository,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(repository,typed?'scripts/v2/typesetting-only-worker.cjs':'scripts/v2/imported-page-image-worker.cjs'),directory,'--disable-gpu'],cwd:repository,env,maxLifetimeMs:10*60*1000,onStdout:append,onStderr:append});
  await revalidate('before-worker-resume',{ownedRootPid:child.ready.rootPid});signal.throwIfAborted();
  polling=(async()=>{const handled=new Set();let last=0;while(!stopping&&!child.closed){
   try{
    const names=(await fs.readdir(directory)).filter(n=>/^gate-request-\d+\.json$/.test(n)&&!handled.has(n));
    for(const name of names){const q=await readGateJson(path.join(directory,name));if(q===null)continue;demand(q.permitId===permit.permitId&&q.executionGeneration===permit.executionGeneration&&typeof q.nonce==='string'&&q.nonce.length===36&&/^[a-z-]{1,64}$/.test(q.phase),'IMAGE_RUNTIME_GATE_INVALID');
     await revalidate(q.phase,{ownedRootPid:child.ready.rootPid});await publishGateJson(path.join(directory,name.replace('request','response')),{...q,allowed:true});handled.add(name);}
    if(Date.now()-last>=2000){last=Date.now();await revalidate('during-image',{ownedRootPid:child.ready.rootPid});}
   }catch(e){guardError=e;await child.stop();break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }})();
  await child.resume();completion=await child.completion;stopping=true;await polling;await writing;
  await writeExclusive(path.join(directory,'controller-receipt.json'),JSON.stringify(completion));
  demand(completion.kernelCleanupConfirmed===true&&completion.supervisorClosed===true,'IMAGE_CLEANUP_UNKNOWN',503);
  if(guardError)throw guardError;signal.throwIfAborted();if(completion.rootExitCode!==0||completion.supervisorExitCode!==0)throw await readImportedWorkerError({directory,permit,completion});
  const result=JSON.parse(await readBounded(path.join(directory,'result.json'))),pngBytes=await readBounded(path.join(directory,'candidate.png'),32*1024*1024);
  demand(result.permitId===permit.permitId&&result.executionGeneration===permit.executionGeneration&&result.pngSha256===digest(pngBytes)&&result.cleanupConfirmed===true,'IMAGE_RESULT_INVALID');
  if(typed)demand(result.report?.executionMode==='TYPESETTING_ONLY'&&Object.values(result.forbidden??{missing:1}).every(v=>v===0)&&['ocr','gemma','lama','maskModel'].every(k=>result.report.actualCalls?.[k]===0),'TYPESETTING_ONLY_AI_CALL_FORBIDDEN');
  return {pngBytes,report:{...result.report,kernelProcessReceipt:completion},cleanupConfirmed:true};
 }catch(error){if(child&&!child.closed)completion=await child.stop();else if(child)completion??=await child.completion;const cleanupConfirmed=!child||completion?.kernelCleanupConfirmed===true;
  // AbortSignal supplies a DOMException whose code is read-only. Preserve cleanup in a new error.
  throw Object.assign(Error('이미지 실행을 중단했습니다. 저장된 실행 상태를 확인해 주세요.'),{code:signal.aborted?'CANCELLED':/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'IMAGE_RUNTIME_FAILED',cleanupConfirmed,...(error.workerFailure?{workerFailure:error.workerFailure}:{})});
 }finally{stopping=true;signal.removeEventListener('abort',abort);if(child&&!child.closed)await child.stop();await polling;await writing;await log.close();}
};}
export async function verifyImportedOutput(bytes,inputs){const {default:sharp}=await import('sharp'),image=sharp(bytes,{limitInputPixels:12_000_000}),metadata=await image.metadata();
 const {source}=await loadStage14ImageProfile(),sourceBytes=await readBounded(path.join(source.directory,'normalized.png'));demand(digest(sourceBytes)===inputs.current.normalizedSha256,'IMPORTED_PAGE_IMAGE_MISMATCH');const frame=await sharp(sourceBytes,{limitInputPixels:12_000_000}).metadata();
 demand(metadata.format==='png'&&(!metadata.pages||metadata.pages===1)&&metadata.width===frame.width&&metadata.height===frame.height,'IMAGE_RESULT_INVALID');
 await image.raw().toBuffer();return {width:metadata.width,height:metadata.height,sha256:digest(bytes),reopenedAndDecoded:true};
}
