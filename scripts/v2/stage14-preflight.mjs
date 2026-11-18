import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),audit=process.argv[2];
const root=process.cwd(),b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
const base=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
const previous='E:/Dev/Outputs/MangohanaV2-20261111/warm-pages-2026-11-11T00-48-06.075Z-ceb347b6';
const warm=JSON.parse(await fs.readFile(path.join(previous,'candidate-config.json'),'utf8'));
const sha=async p=>{const h=createHash('sha256');for await(const c of createReadStream(p))h.update(c);return h.digest('hex');};
const pins=[];
for(const key of ['gemmaModel','llamaServer','python','lamaWorker','lamaModel','lamaTileWrapper','rendererBundle','mmproj','regionDetectorWorker','regionDetectorModel','textMaskWorker','textMaskModel']){
 const file=warm[key]??base[key];if(!file){pins.push({key,path:null,sha256:null,reason:'NOT_CONFIGURED'});continue;}
 pins.push({key,path:file,bytes:(await fs.stat(file)).size,sha256:await sha(file)});
}
const font=path.join(root,'packages/ai-engine/vendor/trio/resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf');
pins.push({key:'font',path:font,bytes:(await fs.stat(font)).size,sha256:await sha(font)});
const resources=JSON.parse(await fs.readFile('scripts/v2/resources.json','utf8'));
for(const id of ['gemma-e2b','lama-fp32']){const pin=pins.find(p=>p.key===(id==='gemma-e2b'?'gemmaModel':'lamaModel')),expected=resources.resources.find(r=>r.id===id);if(pin.sha256!==expected.sha256)throw Error('MODEL_PIN_MISMATCH');}
const ps=String.raw`$ErrorActionPreference='Stop'; $os=Get-CimInstance Win32_OperatingSystem; $models=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(llama-server|python|electron)\.exe$' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate); $top=@(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Id,ProcessName,WorkingSet64,PrivateMemorySize64); @{os=@{totalPhysicalKiB=$os.TotalVisibleMemorySize;availablePhysicalKiB=$os.FreePhysicalMemory};gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name);existingModelProcesses=$models;topProcesses=$top} | ConvertTo-Json -Depth 6`;
const system=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',windowsHide:true,timeout:20000}));
let gpu=null,gpuError=null;try{gpu=execFileSync('nvidia-smi',['--query-gpu=name,memory.total,memory.used,memory.free,driver_version','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();}catch(e){gpuError=e.code??'GPU_PROBE_FAILED';}
const temp=path.join(b.runRoot,'preflight-temp');await fs.mkdir(temp);
const {secretlessEnvironment}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
let python=null;try{python=execFileSync(base.python,['-I','-B','-c','import sys,importlib.metadata as m; print(sys.version); print("onnxruntime="+m.version("onnxruntime")); print("paddlepaddle="+m.version("paddlepaddle"))'],{encoding:'utf8',windowsHide:true,timeout:20000,env:secretlessEnvironment(base.python,temp)}).trim();}catch(e){python={error:e.code??'PYTHON_VERSION_FAILED',output:e.stdout?.toString()??null};}
let llamaVersion=null;try{llamaVersion=execFileSync(base.llamaServer,['--version'],{encoding:'utf8',windowsHide:true,timeout:20000,env:secretlessEnvironment(base.llamaServer,temp),stdio:['ignore','pipe','pipe']}).trim();}catch(e){llamaVersion={error:e.code??'VERSION_FAILED'};}
const sourceManifest='E:/Dev/Outputs/MangohanaV2-20261111/inputs-japanese/source-manifest.json';
const candidates=JSON.parse(await fs.readFile(sourceManifest,'utf8'));
const inputPins=[];for(const name of (await fs.readdir(path.dirname(sourceManifest))).filter(n=>n.endsWith('.png')).sort()){
 const p=path.join(path.dirname(sourceManifest),name);inputPins.push({path:p,bytes:(await fs.stat(p)).size,sha256:await sha(p),provenance:'EXISTING_DEVELOPMENT_INPUT_MANIFEST_NOT_HUMAN_GT'});
}
const result={at:new Date().toISOString(),node:process.version,nodeProcess:process.memoryUsage(),system,gpu,gpuError,pins,python,llamaVersion,quantization:'Q4_K_M',baseConfig:base,warmReferenceConfiguration:warm,baseConfigSha256:await sha('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json'),warmConfigSha256:await sha(path.join(previous,'candidate-config.json')),inputManifest:{path:sourceManifest,sha256:await sha(sourceManifest),data:candidates},inputs:inputPins,stage13InheritedDrift:b.inheritedStage13ProtectedDrift,outputWriteProbe:true,hostMemory:{totalMiB:os.totalmem()/1048576,availableMiB:os.freemem()/1048576},memoryPolicy:{hostAvailableAbortBelowMiB:512,processRssLimitMiB:null,gpuFreeAbortBelowMiB:128,intervalMs:2000},actualInferenceCalls:0,externalInferenceCalls:0,paidApiCalls:0,tokens:null,cost:null,humanGtPages:0};
await fs.writeFile(path.join(audit,'evidence/runtime-preflight.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({pins:pins.length,modelsPinned:true,systemAvailableMiB:result.hostMemory.availableMiB,gpu,existingModelProcesses:system.existingModelProcesses.length,inputPages:inputPins.length,python,llamaVersion,outputWriteProbe:true,inheritedDrift:b.inheritedStage13ProtectedDrift.length}));
