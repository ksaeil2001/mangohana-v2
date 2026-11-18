// Recover the explicitly supplied interrupted prefix without modifying it.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureResource} from '../resources.mjs';
const execute=promisify(execFile),args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--partial')throw new Error('PARTIAL_ARGUMENT_REQUIRED');
const directory=path.resolve('E:/Dev/Models/MangohanaV2-semantic/qwen35-9b-3885219b');
const resource={id:'qwen35-9b-q4-k-m',fileName:'Qwen3.5-9B-Q4_K_M-3885219b.gguf',url:'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf',bytes:5680522464,sha256:'03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'};
const prefix=path.resolve(args[1]);
if(path.dirname(prefix).toLowerCase()!==directory.toLowerCase()||!path.basename(prefix).startsWith('.'+resource.fileName+'.')||!prefix.endsWith('.partial'))throw new Error('PARTIAL_PATH_INVALID');
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-qwen9b-resume-'+new Date().toISOString().replaceAll(':','-');await fs.mkdir(output,{recursive:false});
const parts=[],attempts=[],started=performance.now();let result;
async function inspect(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||!stat.size)throw new Error('PARTIAL_STATE_INVALID');return stat;}
const initial=await inspect(prefix);if(initial.size>=resource.bytes)throw new Error('PARTIAL_SIZE_INVALID');parts.push({file:prefix,bytes:initial.size,kind:'preserved_original_prefix'});
console.log(JSON.stringify({output,prefixBytes:initial.size,totalBytes:resource.bytes}));
async function writeAll(handle,bytes){let offset=0;while(offset<bytes.length){const next=await handle.write(bytes,offset,bytes.length-offset);if(!next.bytesWritten)throw new Error('WRITE_ZERO');offset+=next.bytesWritten;}}
try{
 for(let index=0;index<3;index++){
  const offset=parts.reduce((sum,part)=>sum+part.bytes,0);if(offset===resource.bytes)break;
  const response=await fetch(resource.url,{headers:{Range:'bytes='+offset+'-','Accept-Encoding':'identity'},signal:AbortSignal.timeout(10*60_000)});
  const range=response.headers.get('content-range')?.match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/);
  if(response.status!==206||!range||Number(range[1])!==offset||Number(range[2])!==resource.bytes-1||Number(range[3])!==resource.bytes||!['identity',null].includes(response.headers.get('content-encoding'))){await response.body?.cancel();throw new Error('RANGE_IDENTITY_INVALID');}
  const file=path.join(directory,'.'+resource.fileName+'.'+randomUUID()+'.range-tail'),handle=await fs.open(file,'wx');
  const attempt={start:offset,status:response.status,contentRange:response.headers.get('content-range'),file};attempts.push(attempt);
  let received=0,networkError;
  try{
   for await(const chunk of response.body){if(offset+received+chunk.length>resource.bytes)throw new Error('RANGE_LIMIT');await writeAll(handle,chunk);received+=chunk.length;}
  }catch(error){networkError=error;if(error.cause?.code!=='UND_ERR_SOCKET'&&error.name!=='TimeoutError')throw error;}
  finally{await handle.sync();await handle.close();attempt.receivedBytes=received;}
  if(received)parts.push({file,bytes:received,kind:'separate_range_tail'});
  attempt.complete=!networkError;attempt.error=networkError?'REMOTE_TRANSFER_INTERRUPTED':null;
  console.log(JSON.stringify({event:'range_received',start:offset,receivedBytes:received,complete:!networkError,totalReceived:parts.reduce((sum,part)=>sum+part.bytes,0)}));
 }
 if(parts.reduce((sum,part)=>sum+part.bytes,0)!==resource.bytes)throw new Error('RANGE_INCOMPLETE');
 const identity=randomUUID(),staged=path.join(directory,'.'+resource.fileName+'.'+identity+'.resume-combined');
 const handle=await fs.open(staged,'wx'),hash=createHash('sha256');let total=0,bucket=-1;
 try{
  for(const part of parts){
   const before=await inspect(part.file);if(before.size!==part.bytes)throw new Error('PART_CHANGED');const partHash=createHash('sha256');
   for await(const chunk of createReadStream(part.file,{highWaterMark:1024*1024})){hash.update(chunk);partHash.update(chunk);await writeAll(handle,chunk);total+=chunk.length;const next=Math.floor(total/500_000_000);if(next!==bucket){bucket=next;console.log(JSON.stringify({event:'combining_verified_parts',bytes:total,totalBytes:resource.bytes}));}}
   const after=await inspect(part.file);if(before.size!==after.size||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new Error('PART_CHANGED');part.sha256=partHash.digest('hex');
  }
  await handle.sync();
 }finally{await handle.close();}
 const digest=hash.digest('hex');if(total!==resource.bytes||digest!==resource.sha256)throw new Error('COMBINED_SHA_MISMATCH');
 const verified=path.join(directory,'.'+resource.fileName+'.'+identity+'.verified');
 if(path.dirname(staged)!==directory||path.dirname(verified)!==directory)throw new Error('STAGE_PATH_INVALID');
 const systemRoot=process.env.SystemRoot??'C:/Windows',powershell=path.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const script="$ErrorActionPreference='Stop'; [System.IO.File]::Move($env:MANGOHANA_RESUME_SOURCE, $env:MANGOHANA_RESUME_TARGET)";
 const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));Object.assign(env,{MANGOHANA_RESUME_SOURCE:staged,MANGOHANA_RESUME_TARGET:verified});
 await execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env,timeout:30_000,maxBuffer:64*1024});
 result=await ensureResource(resource,{directory});
 const after=await inspect(prefix);if(after.size!==initial.size||after.ino!==initial.ino||after.mtimeMs!==initial.mtimeMs)throw new Error('ORIGINAL_PREFIX_CHANGED');
 await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'PINNED_MODEL_RANGE_RECOVERY_NO_INFERENCE',resource,originalPrefixPreserved:true,parts,attempts,combinedSha256:digest,result,elapsedMs:Math.round(performance.now()-started)},null,2),{flag:'wx'});
 console.log(JSON.stringify({output,status:'verified',originalPrefixPreserved:true,result}));
}catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({scope:'PINNED_MODEL_RANGE_RECOVERY_NO_INFERENCE',code:/^[A-Z_0-9]+$/.test(error.message??'')?error.message:'RECOVERY_FAILED',parts,attempts,elapsedMs:Math.round(performance.now()-started)},null,2),{flag:'wx'});throw new Error('MODEL_RECOVERY_FAILED_SEE_EVIDENCE');}
