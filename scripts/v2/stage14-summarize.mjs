import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const audit=process.argv[2],b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const runs=[];
for(const e of await fs.readdir(b.runRoot,{withFileTypes:true})){
 if(!e.isDirectory())continue;const directory=path.join(b.runRoot,e.name);
 let controller=null,e2b=null,page=null;try{controller=await read(path.join(directory,'controller-receipt.json'));}catch{}
 try{e2b=await read(path.join(directory,'e2b-receipt.json'));}catch{}
 try{page=await read(path.join(directory,'page-run-receipt.json'));}catch{}
 if(!controller&&!e2b&&!page)continue;
 let samples=[];try{samples=(await fs.readFile(path.join(directory,'resource-samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
 const processMap=new Map();
 for(const sample of samples.filter(s=>s.type==='PROCESS_RSS'&&Array.isArray(s.processes)))for(const p of sample.processes){
  const key=p.pid+':'+p.createdAt,current=processMap.get(key)??{pid:p.pid,name:p.name,createdAt:p.createdAt,observedSamples:0,maxRssMiB:null,maxPrivateMiB:null};
  current.observedSamples++;if(p.workingSetBytes!=null&&Number.isFinite(+p.workingSetBytes))current.maxRssMiB=Math.max(current.maxRssMiB??0,+p.workingSetBytes/1048576);if(p.privateBytes!=null&&Number.isFinite(+p.privateBytes))current.maxPrivateMiB=Math.max(current.maxPrivateMiB??0,+p.privateBytes/1048576);processMap.set(key,current);
 }
 const node=samples.filter(s=>s.type==='HOST_AND_OBSERVER_NODE');
 const max=field=>node.length?Math.max(...node.map(s=>s.node[field]/1048576)):null;
 let reopen=null;try{reopen=await read(path.join(directory,'store-reopen.json'));}catch{}
 const events=e2b?.events??[];const coldStart=events.find(e=>e.phase==='translation_runtime_cache'&&e.mode==='cold'),coldEnd=events.find(e=>e.phase==='translation_runtime_cache_complete'&&e.mode==='cold');
 const summary={directory,controller,e2b,page,reopen,observed:{sampleCount:samples.length,hostSamples:node.length,validGpuSamples:samples.filter(s=>s.type==='GPU_NVML'&&Number.isFinite(s.usedMiB)).length,failedOrMissing:samples.filter(s=>s.value===null),hostMinimumAvailableMiB:node.length?Math.min(...node.map(s=>s.hostAvailableMiB)):null,hostStartAvailableMiB:node[0]?.hostAvailableMiB??null,hostEndAvailableMiB:node.at(-1)?.hostAvailableMiB??null,gpuMaxUsedMiB:samples.filter(s=>s.type==='GPU_NVML'&&Number.isFinite(s.usedMiB)).reduce((m,s)=>Math.max(m??0,s.usedMiB),null),nodeMaxRssMiB:max('rss'),nodeMaxHeapUsedMiB:max('heapUsed'),nodeMaxExternalMiB:max('external'),perProcess:[...processMap.values()],systemScope:true,continuousPeak:false,processVramMiB:null,processVramReason:'NOT_MEASURED',actualAdapterAndParseMs:coldStart&&coldEnd?coldEnd.elapsedMs-coldStart.elapsedMs:null}};
 runs.push(summary);
}
const preflight=await read(path.join(audit,'evidence/runtime-preflight.json'));
const runtimeRoot=path.dirname(preflight.baseConfig.llamaServer),runtimePins=[];
for(const name of (await fs.readdir(runtimeRoot)).filter(n=>/^(?:llama-server(?:-impl)?\.(?:exe|dll)|llama\.dll|ggml.*\.dll|cudart.*\.dll|cublas.*\.dll|runtime-files\.json)$/.test(n))){
 const p=path.join(runtimeRoot,name),key=path.resolve(p).toLowerCase(),pin=b.protectedFiles.find(r=>path.resolve(r.path).toLowerCase()===key);
 runtimePins.push({path:p,baselineSha256:pin?.sha256??null,baselineBytes:pin?.bytes??null,finalVerification:'INCLUDED_IN_FINAL_PROTECTED_FULL_HASH_CHECK'});
}
const policies={automaticRetries:0,modelFallbacks:0,downloads:0,externalInferenceCalls:0,paidApiCalls:0,measuredCost:null,humanGtPages:0,roiLevelOcrResume:false,rendererStandaloneCheckpoint:false};
const summary={at:new Date().toISOString(),scope:'STAGE14_ONLY',audit,runRoot:b.runRoot,runs,runtimePins,policies};
await fs.writeFile(path.join(audit,'evidence/runtime-summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify(runs.map(r=>({directory:r.directory,status:r.e2b?.status??r.page?.status??r.controller?.status,actualInferenceCalls:r.e2b?.actualInferenceCalls??null,failure:r.e2b?.failure??r.page?.failure??null,resources:{minRam:r.observed.hostMinimumAvailableMiB,maxGpu:r.observed.gpuMaxUsedMiB,samples:r.observed.sampleCount},pages:r.page?.rows?.map(p=>({status:p.status,code:p.errorCode,artifacts:p.artifacts?.map(a=>a.name)}))})),null,2));
