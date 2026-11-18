// Sampled observations, never a continuous peak or per-page exclusive allocation claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
const run=(exe,args)=>new Promise(resolve=>execFile(exe,args,{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:2*1024*1024},(e,stdout)=>resolve(e?{error:e.code??'PROBE_FAILED'}:{stdout})));
export async function observe({directory,onStop=()=>{},phase=()=>null,rootPid=process.pid}){
 const file=path.join(directory,'resource-samples.jsonl');fs.writeFileSync(file,'',{flag:'wx'});
 const started=performance.now(),samples=[],pending=new Set();let stopped=false,gpuBusy=false,processBusy=false;
 const emit=v=>{const row={at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),phase:phase(),...v};samples.push(row);fs.appendFileSync(file,JSON.stringify(row)+'\n');};
 const host=()=>{const availableMiB=os.freemem()/1048576;emit({type:'HOST_AND_OBSERVER_NODE',hostTotalMiB:os.totalmem()/1048576,hostAvailableMiB:availableMiB,observerPid:process.pid,node:process.memoryUsage()});if(availableMiB<512)onStop('HOST_MEMORY_PRESSURE');};
 async function gpu(){if(gpuBusy){emit({type:'GPU_NVML',value:null,reason:'PROBE_IN_FLIGHT'});return;}gpuBusy=true;try{const r=await run(path.join(process.env.SystemRoot??'C:/Windows','System32/nvidia-smi.exe'),['--query-gpu=memory.total,memory.used,memory.free','--format=csv,noheader,nounits']);if(r.error){emit({type:'GPU_NVML',value:null,reason:r.error});onStop('GPU_MONITOR_FAILED');return;}const [totalMiB,usedMiB,freeMiB]=r.stdout.trim().split(/\r?\n/)[0].split(',').map(s=>Number(s.trim()));if(![totalMiB,usedMiB,freeMiB].every(Number.isFinite)){emit({type:'GPU_NVML',value:null,reason:'GPU_FORMAT'});onStop('GPU_MONITOR_FAILED');}else{emit({type:'GPU_NVML',totalMiB,usedMiB,freeMiB,scope:'SYSTEM_GPU_NOT_PROCESS_EXCLUSIVE'});if(freeMiB<128)onStop('GPU_MEMORY_PRESSURE');}}finally{gpuBusy=false;}}
 async function processes(){if(processBusy){emit({type:'PROCESS_RSS',value:null,reason:'PROBE_IN_FLIGHT'});return;}processBusy=true;try{
  const ps=`$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $ids=@(${Number(rootPid)}); for($i=0;$i -lt 8;$i++){ $next=@($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object ProcessId); if(!$next.Count){break}; $ids+= $next }; @($all | Where-Object {$ids -contains $_.ProcessId} | ForEach-Object { @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');workingSetBytes=$_.WorkingSetSize;privateBytes=$_.PrivatePageCount} }) | ConvertTo-Json -Depth 3 -Compress`;
  const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps]);if(r.error){emit({type:'PROCESS_RSS',value:null,reason:r.error});return;}try{const value=JSON.parse(r.stdout||'[]');emit({type:'PROCESS_RSS',processes:Array.isArray(value)?value:[value],scope:'ROOT_AND_DESCENDANTS_INCLUDES_OBSERVATION_HELPERS'});}catch{emit({type:'PROCESS_RSS',value:null,reason:'PROCESS_FORMAT'});}
 }finally{processBusy=false;}}
 const tracked=fn=>{const p=fn().catch(e=>emit({type:'MONITOR_ERROR',value:null,reason:e.code??'OBSERVATION_FAILED'}));pending.add(p);p.finally(()=>pending.delete(p));};
 host();tracked(gpu);tracked(processes);
 const timer=setInterval(()=>{if(stopped)return;host();tracked(gpu);tracked(processes);},2000);
 return {samples,async stop(){stopped=true;clearInterval(timer);await Promise.allSettled([...pending]);host();return {scope:'SAMPLED_SYSTEM_RAM_GPU_AND_PROCESS_RSS_NOT_CONTINUOUS_PEAK',hostIntervalMs:2000,gpuIntervalMs:2000,processIntervalMs:2000,peakVerified:false,samples:samples.length,minAvailableRamMiB:Math.min(...samples.filter(s=>s.type==='HOST_AND_OBSERVER_NODE').map(s=>s.hostAvailableMiB)),maxObservedGpuUsedMiB:samples.filter(s=>s.type==='GPU_NVML'&&Number.isFinite(s.usedMiB)).reduce((m,s)=>Math.max(m??s.usedMiB,s.usedMiB),null),failedOrMissingSamples:samples.filter(s=>s.value===null).length,processVramBytes:null,processVramReason:'NOT_QUERIED_WDDM_PER_PROCESS_ALLOCATION_NOT_ASSUMED',file};}};
}
