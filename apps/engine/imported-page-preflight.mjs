// Server-owned Stage14 profile. No model, renderer, image encoder or downloader is called here.
import fs from 'node:fs/promises';import {createReadStream} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';
import {readBounded} from './translation-review-store.mjs';import {digest,demand,regularDirectory,writeExclusive} from './image-permit-store.mjs';
import {probeLamaRuntime} from './lama-runtime-preflight.mjs';
import {createLayoutSourceLoader} from './layout-review-source.mjs';
import {getAllSourcePreflight}from'./layout-source-preflight.mjs';
const require=createRequire(import.meta.url),{verifyImportedMask,inspectFontGlyphs,assertExecutionEnvironment}=require('../../packages/ai-engine/quality/imported-image-contract.cjs');
const execute=promisify(execFile),repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const STAGE14_IMAGE_OUTPUT_ROOT='E:/Dev/Outputs/MangohanaV2-20261111';
const sourcePath=new URL('./stage14r3-ocr-source.json',import.meta.url);
export async function loadStage14ImageProfile(){
 const sourceBytes=await readBounded(sourcePath),source=JSON.parse(sourceBytes),configBytes=await readBounded(source.creationConfigPath),config=JSON.parse(configBytes);
 return {source,config,sourceDescriptorSha256:digest(sourceBytes),profileSha256:digest(configBytes)};
}
async function pin(file){
 const before=await fs.lstat(file);demand(before.isFile()&&!before.isSymbolicLink()&&path.resolve(await fs.realpath(file)).toLowerCase()===path.resolve(file).toLowerCase(),'IMAGE_ASSET_INVALID');
 const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);const after=await fs.lstat(file);
 demand(before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&!after.isSymbolicLink(),'IMAGE_ASSET_CHANGED');
 return {path:path.resolve(file),sha256:h.digest('hex'),bytes:after.size,ino:after.ino,dev:after.dev,mtimeMs:after.mtimeMs};
}
async function anchorsUnchanged(pins){for(const p of pins){const s=await fs.lstat(p.path);demand(s.isFile()&&!s.isSymbolicLink()&&s.ino===p.ino&&s.dev===p.dev&&s.size===p.bytes&&s.mtimeMs===p.mtimeMs&&path.resolve(await fs.realpath(p.path)).toLowerCase()===p.path.toLowerCase(),'IMAGE_ASSET_CHANGED');}}
export async function probeImageEnvironment({outputRoot,outputDirectory,permitId,ownedRootPid,writeProbe=true}){
 await regularDirectory(outputRoot);demand(path.dirname(outputDirectory)===path.resolve(outputRoot),'IMAGE_PATH_UNSAFE');
 const stats=await fs.statfs(outputRoot);let outputWritable=true;
 if(writeProbe){const probe=path.join(outputRoot,'.preflight-'+randomUUID());try{await writeExclusive(probe,'stage14-write-probe');demand(await fs.readFile(probe,'utf8')==='stage14-write-probe','OUTPUT_WRITE_FAILED');}catch{outputWritable=false;}finally{await fs.unlink(probe).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 let vramFreeMiB=null,gpuProbeError=null,processes=null,processProbeError=null;
 try{const {stdout}=await execute('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:15000,maxBuffer:16384});const values=stdout.trim().split(/\r?\n/).map(Number);if(values.length&&values.every(Number.isFinite))vramFreeMiB=Math.min(...values);}catch(e){gpuProbeError=e.code??'GPU_PROBE_UNKNOWN';}
 try{
  const script="$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress";
  const {stdout}=await execute(path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  const rows=JSON.parse(stdout),owned=new Set(ownedRootPid?[ownedRootPid]:[]);let count=-1;while(count!==owned.size){count=owned.size;for(const r of rows)if(owned.has(r.ParentProcessId))owned.add(r.ProcessId);}
  processes=rows.filter(p=>/^(?:electron|python(?:w|\d+(?:\.\d+)?)?|llama-server|llama-cli)\.exe$/i.test(p.Name)&&!owned.has(p.ProcessId)).map(p=>({pid:p.ProcessId,name:p.Name}));
 }catch(e){processProbeError=e.code??'PROCESS_PROBE_UNKNOWN';}
 let repositoryLocked=false;try{const lock=JSON.parse(await readBounded(path.join(outputRoot,'.image-execution-lock','owner.json')));repositoryLocked=lock.permitId!==permitId||lock.pid!==process.pid;}catch(e){if(e.code!=='ENOENT')repositoryLocked=true;else {try{await fs.lstat(path.join(outputRoot,'.image-execution-lock'));repositoryLocked=true;}catch(x){if(x.code!=='ENOENT')throw x;}}}
 const environment={ramFreeMiB:os.freemem()/1048576,vramFreeMiB,diskFreeBytes:stats.bavail*stats.bsize,outputWritable,otherEngineProcesses:processes,
  repositoryLocked,recoveryAvailable:process.platform==='win32',gpuProbeError,processProbeError,guardRamMiB:512,guardVramMiB:128};
 assertExecutionEnvironment(environment);return environment;
}
export function createStage14Preflight({outputRoot=STAGE14_IMAGE_OUTPUT_ROOT,profileLoader=loadStage14ImageProfile,environmentProbe=probeImageEnvironment}={}){
 const cache=new Map(),layoutSource=createLayoutSourceLoader({profileLoader});
 return async({binding,inputs,outputDirectory,mode='full',readiness,permitId,ownedRootPid,phase})=>{
  const blockers=[],facts={};let fingerprint=null;
  try{
   const profile=await profileLoader(),{config,source}=profile;
   demand(/^E:[\\/]/i.test(path.resolve(outputRoot)),'IMAGE_OUTPUT_DRIVE_REQUIRED');
   demand((config.modelAlias??'gemma4-e2b-local')==='gemma4-e2b-local'&&source.expectedGeneration===binding.sourceProcessingGeneration&&source.expectedCheckpointSha256===binding.sourceProvenance.originalCheckpointSha256,'IMAGE_PROFILE_INCOMPATIBLE');
   facts.profile={profileSha256:profile.profileSha256,sourceDescriptorSha256:profile.sourceDescriptorSha256,modelAlias:config.modelAlias??'gemma4-e2b-local',sourceProcessingGeneration:source.expectedGeneration};
   if(mode==='monitor'){
    const saved=cache.get(readiness?.fingerprint);demand(saved,'IMAGE_PREFLIGHT_REQUIRED');await anchorsUnchanged(saved.pins);
    demand(saved.profileSha256===profile.profileSha256&&saved.sourceDescriptorSha256===profile.sourceDescriptorSha256,'IMAGE_PROFILE_CHANGED');
    for(const name of ['source.png','normalized.png'])demand(digest(await readBounded(path.join(source.directory,name)))===(name==='source.png'?binding.current.sourceSha256:binding.current.normalizedSha256),'IMPORTED_PAGE_IMAGE_MISMATCH');
    // Content checks at irreversible boundaries; intervening monitor ticks check identity anchors.
    if(['before-lama','before-cleaned-diagnostics','before-diagnostic-commit','before-typeset','before-result','before-receipt'].includes(phase))for(const p of saved.pins)demand((await pin(p.path)).sha256===p.sha256,'IMAGE_ASSET_CHANGED');
    fingerprint=readiness.fingerprint;
   }else{
    try{await fs.lstat(outputDirectory);throw Object.assign(Error('출력 폴더가 이미 존재합니다.'),{code:'OUTPUT_EXISTS'});}catch(e){if(e.code!=='ENOENT')throw e;}
    const paths=[config.python,config.lamaWorker,config.lamaModel,config.lamaTileWrapper,config.rendererBundle,
     path.join(config.repository,'scripts/sites-local/lama-stdio.py'),path.join(config.repository,'scripts/local-preview/lama_http.py'),
     path.join(repository,'scripts/v2/warm-job.mjs'),path.join(repository,'scripts/v2/warm-job.ps1'),path.join(repository,'scripts/v2/imported-page-image-worker.cjs'),
     path.join(repository,'packages/ai-engine/quality/imported-image-pipeline.cjs'),path.join(repository,'packages/ai-engine/quality/imported-image-contract.cjs'),path.join(repository,'packages/ai-engine/quality/imported-image-diagnostics.cjs'),
     path.join(repository,'packages/ai-engine/quality/background-layout.cjs'),path.join(repository,'packages/ai-engine/quality/imported-layout-background.cjs'),path.join(repository,'packages/ai-engine/quality/korean-utterance.cjs'),
     path.join(repository,'packages/ai-engine/quality/source-layout-preflight.cjs'),path.join(repository,'packages/ai-engine/.build/layout-source-geometry.cjs'),path.join(repository,'apps/engine/layout-source-preflight.mjs'),
     path.join(repository,'apps/engine/layout-review-store.mjs'),path.join(repository,'apps/engine/layout-review-service.mjs'),path.join(repository,'apps/engine/layout-review-source.mjs'),
     path.join(repository,'apps/engine/layout-text-measurement.mjs'),path.join(repository,'packages/ai-engine/quality/layout-measurement-worker.cjs'),path.join(repository,'packages/ai-engine/.build/layout-measurement.js'),
     path.join(repository,'apps/engine/imported-page-controller.mjs'),path.join(repository,'apps/engine/image-permit-store.mjs'),path.join(repository,'apps/engine/imported-page-preflight.mjs'),
     path.join(repository,'apps/engine/lama-runtime-preflight.mjs'),
     path.join(repository,'apps/engine/imported-page-runtime.mjs'),path.join(repository,'packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs'),
     path.join(repository,'packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs'),path.join(source.directory,'removal-mask.png'),path.join(source.directory,'removal-mask-learned-gray.png'),
     path.join(source.directory,'learned-mask-evidence.json'),path.join(source.directory,'source-mask-evidence.json')];
    const fontPath=path.join(config.resourcesPath,'pipeline-resources/pretendard-ko-fallback/1.3.9/PretendardVariable.ttf');paths.push(fontPath);
    const pins=[];for(const p of paths){demand(path.isAbsolute(p??''),'IMAGE_ASSET_INVALID');pins.push(await pin(p));}
    const catalog=JSON.parse(await readBounded(path.join(repository,'scripts/v2/resources.json'))),lama=catalog.resources.find(r=>r.id==='lama-fp32'),model=pins.find(p=>p.path===path.resolve(config.lamaModel));
    demand(model.sha256===lama.sha256&&model.bytes===lama.bytes,'LAMA_MODEL_INVALID');
    facts.lamaRuntime=await probeLamaRuntime(config);
    const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(config.buildRoot,'src/main/productionTypesetFontResource.js')).href);
    const font=await initializeProductionTypesetFontResource(config.resourcesPath,{warn:()=>{}});demand(font.enabled,'FONT_UNAVAILABLE');
    facts.font=inspectFontGlyphs(await readBounded(fontPath),inputs.lines.map(l=>l.userTranslation).join('\n'));
    facts.mask=await verifyImportedMask({sourceDirectory:source.directory,inputs,expectedAlgorithm:config.textMaskAlgorithm,read:readBounded});
    if(binding.layoutReview){
     demand(JSON.stringify(binding.layoutReview)===JSON.stringify(inputs.layoutReview),'LAYOUT_EXECUTION_BINDING_INVALID');
     const layout=await layoutSource(binding),approved=binding.layoutReview;
     if(approved.entries.length)demand(approved.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'&&approved.sourceReviewFingerprint===layout.sourceReviewFingerprint,'LAYOUT_SOURCE_STALE');
     const all=await getAllSourcePreflight(layout,approved);
     facts.layout={status:all?.status??'SOURCE_PREFLIGHT_UNAVAILABLE',layoutRevision:approved.layoutRevision,planSha256:approved.planSha256,actualCleanedVerified:false,manualEntries:approved.entries.length,sourcePreflight:all};
     demand(all&&all.regions.length===inputs.lines.length,'SOURCE_PREFLIGHT_REQUIRED');
     demand(all.blockers.length===0,'MANUAL_LAYOUT_REQUIRED');
    }
    facts.pins=pins;fingerprint=digest({profile:facts.profile,pins,mask:facts.mask,font:facts.font,lamaRuntime:facts.lamaRuntime,layoutReview:binding.layoutReview??null,outputDirectory,selectedSetSha256:binding.receipt.selectedSetSha256,documentSha256:binding.documentSha256});
    cache.set(fingerprint,{pins,profileSha256:profile.profileSha256,sourceDescriptorSha256:profile.sourceDescriptorSha256});
   }
   facts.environment=await environmentProbe({outputRoot:path.resolve(outputRoot),outputDirectory:path.resolve(outputDirectory),permitId,ownedRootPid,writeProbe:mode!=='monitor'});
   facts.recovery={exclusiveConsumption:true,automaticRetry:false,unknownAfterCrash:true,kernelJobRequired:true};
  }catch(e){blockers.push({code:/^[A-Z_]{1,80}$/.test(e.code??'')?e.code:'IMAGE_PREFLIGHT_FAILED',message:e.message});}
  return {status:blockers.length?'BLOCKED':'READY',fingerprint,blockers,...facts,executionAuthorized:false,actualCalls:{ocr:0,gemma:0,lama:0,renderer:0},pngCreated:0};
 };
}
