// Saved historical model output, read-only at source. Not a new inference or Stage13 checkpoint.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createJobStore} from '../../apps/engine/store.mjs';
const audit=process.argv[2],b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
const oldRoot='E:/Dev/Outputs/MangohanaV2-20261111/warm-pages-2026-11-11T00-08-54.910Z-7ea75d17';
const read=p=>fs.readFile(p,'utf8').then(JSON.parse),sha=b=>createHash('sha256').update(b).digest('hex');
const outer=await read(path.join(oldRoot,'verification-warm.json')),inner=await read(path.join(oldRoot,'verification-inner.json'));
const host=outer.memoryObservations.samples.filter(s=>s.sampleType==='HOST_RAM'&&Number.isFinite(s.osAvailableMiB));
const min=host.reduce((a,s)=>s.osAvailableMiB<a.osAvailableMiB?s:a,host[0]);
const historical={scope:'C_SAVED_REAL_MODEL_RUN_REPLAY_NOT_NEW_EXECUTION',root:oldRoot,outerStatus:outer.status,outerFailure:outer.failure,elapsedMs:outer.elapsedMs,minHostAvailableSample:min,policy:{thresholdMiB:512,measuredField:'os.freemem() / 1048576 SYSTEM_AVAILABLE_PHYSICAL_RAM',processRssLimitMiB:null,gpuLimitMiB:null},innerCleanup:inner.cleanupConfirmed,osJobCleanup:outer.osJobCleanupConfirmed,cacheReuse:inner.cacheReuse,pages:[],leakProven:false,leakReason:'No per-process RSS timeline or repeat baseline proves a leak. Retained OCR/LLM co-residency and system pressure are observations, not root-cause certification.'};
const replayDir=path.join(b.runRoot,'historical-server-replay');await fs.mkdir(replayDir);const jobs=path.join(replayDir,'jobs');await fs.mkdir(jobs);
let completed;
for(const row of inner.pages){
 const jobDir=path.join(oldRoot,'jobs',row.jobId),state=await read(path.join(jobDir,'state.json')),files=await fs.readdir(jobDir),hashes=[];
 for(const name of files){const p=path.join(jobDir,name);if((await fs.stat(p)).isFile()){const data=await fs.readFile(p);hashes.push({name,bytes:data.length,sha256:sha(data)});}}
 historical.pages.push({ordinal:row.ordinal,jobId:row.jobId,sourceSha256:row.sourceSha256,status:row.status,stateStatus:state.status,stateErrorCode:state.errorCode??null,hasStage13Receipt:!!state.resultReceipt,hasStage13Checkpoints:!!state.checkpoints,hashes});
 if(row.status==='completed'&&!completed){completed={...row,state,jobDir,hashes};await fs.cp(jobDir,path.join(jobs,row.jobId),{recursive:true,errorOnExist:true,force:false});}
}
if(!completed)throw Error('HISTORICAL_COMPLETED_PAGE_REQUIRED');
let runs=0;const engine={health:()=>({ready:true}),inspectImage:()=>{throw Error('REPLAY_MUST_NOT_INSPECT');},run:()=>{runs++;throw Error('REPLAY_MUST_NOT_INFER');},close:async()=>{}};
const store=await createJobStore({root:jobs,engine});let state=null,result=null,error=null;
try{state=await store.get(completed.state.owner,completed.jobId);try{result=await store.getResult(completed.state.owner,completed.jobId);}catch(e){error={code:e.code??null,status:e.status??e.statusCode??null};}}finally{await store.close();}
const preserved=[];for(const row of historical.pages){const original=path.join(oldRoot,'jobs',row.jobId);for(const h of row.hashes)preserved.push({jobId:row.jobId,name:h.name,unchanged:sha(await fs.readFile(path.join(original,h.name)))===h.sha256});}
const replay={scope:'C_LEGACY_SAVED_MODEL_RESULT_COPIED_TO_ISOLATED_CURRENT_STORE_NOT_ACTUAL_RUNTIME_RESTART',copiedJobId:completed.jobId,restoredStatus:state?.status??null,restoredErrorCode:state?.errorCode??null,resultReturned:!!result,getResultError:error,additionalModelCalls:runs,originalsUnchanged:preserved.every(r=>r.unchanged),preserved,stage13ReceiptPresent:!!completed.state.resultReceipt,stage13CheckpointPresent:!!completed.state.checkpoints,browserIndexedDb:false};
await fs.writeFile(path.join(audit,'evidence/historical-warm-replay.json'),JSON.stringify({historical,replay},null,2),{flag:'wx'});
console.log(JSON.stringify({oldFailure:outer.failure,minHostAvailableMiB:min.osAvailableMiB,firstPageOriginalPreserved:replay.originalsUnchanged,replayedState:state?.status,restoredErrorCode:state?.errorCode??null,resultReturned:!!result,additionalModelCalls:runs,hasStage13Receipt:replay.stage13ReceiptPresent}));
