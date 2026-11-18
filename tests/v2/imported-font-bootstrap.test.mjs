import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createWarmJob} from '../../scripts/v2/warm-job.mjs';
import {readGateJson,publishGateJson} from '../../packages/ai-engine/quality/imported-image-diagnostics.cjs';
const repository=path.resolve(new URL('../..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
async function probe(t,fault){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'font-bootstrap-')),runId='font-only-'+randomUUID();
 // The unchanged atomic Windows Job supervisor requires its private control directory on E:.
 const control=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests',runId);await fs.mkdir(control);
 const config={profileRoot:path.join(root,'profile'),repository:path.join(repository,'packages/ai-engine/vendor/trio'),buildRoot:path.join(repository,'packages/ai-engine/.build/compiled'),resourcesPath:path.join(repository,'packages/ai-engine/.build/resources'),rendererBundle:path.join(repository,'packages/ai-engine/.build/renderer.js'),python:path.join(root,'NO_PYTHON_ALLOWED.exe')};
 await fs.writeFile(path.join(root,'input.json'),JSON.stringify({config,permit:{permitId:randomUUID(),executionGeneration:runId},inputs:{},source:{},fontProbeFault:fault===true,layoutDiagnosticProbe:fault==='layout-diagnostics'}),{flag:'wx'});
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));Object.assign(env,{TEMP:root,TMP:root,LOCALAPPDATA:process.env.LOCALAPPDATA??root,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
 let log='',job,polling,stop=false;
 try{
  job=await createWarmJob({directory:control,runId,executable:path.join(repository,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(repository,'tests/v2/fixtures/imported-font-only-worker.cjs'),root,'--disable-gpu'],cwd:repository,env,maxLifetimeMs:90000,onStdout:b=>{log+=b;},onStderr:b=>{log+=b;}});
  polling=(async()=>{const handled=new Set();while(!stop&&!job.closed){for(const name of (await fs.readdir(root)).filter(n=>/^gate-request-\d+\.json$/.test(n)&&!handled.has(n))){const q=await readGateJson(path.join(root,name));if(q===null)continue;assert.ok(['worker-start',fault==='layout-diagnostics'?'after-typeset':'font-only-probe'].includes(q.phase));await publishGateJson(path.join(root,name.replace('request','response')),{...q,allowed:true});handled.add(name);}await new Promise(r=>setTimeout(r,30));}})();
  await job.resume();const receipt=await job.completion;stop=true;await polling;
  const font=JSON.parse(await fs.readFile(path.join(root,'font-only-probe.json'))),failure=JSON.parse(await fs.readFile(path.join(root,'failure.json'))),files=await fs.readdir(root),result={root,control,receipt,font,failure,imageFiles:files.filter(n=>/\.(png|jpe?g|trio|ctp)$/i.test(n)),log};
  await fs.writeFile(path.join(root,'probe-summary.json'),JSON.stringify(result,null,2),{flag:'wx'});
  t.diagnostic('FONT_ONLY_EVIDENCE='+path.join(root,'probe-summary.json'));return result;
 }finally{stop=true;if(job&&!job.closed)await job.stop();await polling;}
}
for(const fault of [false,true])test(fault?'worker font failure stays closed with a stack before any image pipeline':'worker bootstrap loads the signed production font without image execution',async t=>{
 const p=await probe(t,fault);assert.equal(p.receipt.kernelCleanupConfirmed,true);assert.equal(p.receipt.activeProcessesAfter,0);assert.equal(p.receipt.rootExitCode,1,'intentional font-only stop, never a successful image run');assert.deepEqual(p.imageFiles,[]);assert.ok(Object.values(p.font.calls).every(v=>v===0));assert.ok(Object.values(p.failure.forbidden).every(v=>v===0));
 assert.equal(p.font.observed.loaded,!fault);assert.equal(p.font.observed.checked,!fault);assert.equal(p.failure.code,fault?'FONT_ONLY_PROBE_BLOCKED':'FONT_ONLY_PROBE_COMPLETE');
 assert.equal(p.failure.lastCompletedGate,'font-only-probe');assert.equal(typeof p.failure.stack,'string');assert.ok(p.failure.stack.includes('imported-font-only-worker.cjs'));assert.ok(p.failure.stack.length<=16384);
 assert.equal(p.failure.version,1);assert.equal(p.failure.executionGeneration,p.receipt.runId);
});
test('worker persists bound per-region layout diagnostics without an image execution',async t=>{
 const p=await probe(t,'layout-diagnostics'),input=JSON.parse(await fs.readFile(path.join(p.root,'input.json')));
 assert.equal(p.failure.version,1);assert.equal(p.failure.permitId,input.permit.permitId);assert.equal(p.failure.executionGeneration,p.receipt.runId);assert.equal(p.failure.code,'MANUAL_LAYOUT_REQUIRED');assert.equal(p.failure.lastCompletedGate,'after-typeset');
 const diagnostic=p.failure.layoutDiagnostics;assert.equal(diagnostic.rejectedRegion,'synthetic-region');assert.equal(diagnostic.regions[0].fontSizePx,12);assert.ok(diagnostic.regions[0].failures.includes('SAFE_AREA_NOT_VERIFIED'));assert.ok(!JSON.stringify(diagnostic).includes('SYNTHETIC_PRIVATE_TEXT'));
 assert.equal(p.receipt.kernelCleanupConfirmed,true);assert.equal(p.receipt.activeProcessesAfter,0);assert.deepEqual(p.imageFiles,[]);assert.ok(Object.values(p.font.calls).every(v=>v===0));
});
