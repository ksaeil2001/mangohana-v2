// E-only synthetic policy paths and fake child objects; no Python/model/process execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),boundaries=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs'),{runtimeCacheIdentity}=require('../../packages/ai-engine/quality/owned-runtime.cjs');
let api={};try{api=require('../../packages/ai-engine/quality/ocr-environment.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const root=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/ocr-env-'+Date.now()+'-'+randomUUID().slice(0,6));
async function fixture(){assert.equal(typeof api.prepareOcrEnvironmentPolicy,'function');const directory=path.join(root,randomUUID()),profileRoot=path.join(directory,'profile'),pythonExecutable=path.join(directory,'python.exe');await fs.mkdir(profileRoot,{recursive:true});await fs.writeFile(pythonExecutable,'SYNTHETIC_FILE_NOT_EXECUTABLE');return {directory,profileRoot,pythonExecutable,policy:await api.prepareOcrEnvironmentPolicy({profileRoot,pythonExecutable})};}
function fakeChild(){const child=new EventEmitter();Object.assign(child,{pid:12345,exitCode:null,signalCode:null,killed:false,kill(){this.killed=true;this.exitCode=0;this.emit('close',0,null);return true;}});return child;}
async function withSpawn(operation){const original=childProcess.spawn,calls=[];childProcess.spawn=function(...args){const child=fakeChild();calls.push({args,child});return child;};const release=boundaries.acquireHooks();try{return await operation(calls);}finally{release();childProcess.spawn=original;syncBuiltinESMExports();}}

test('an immutable policy creates only a private E home with a stable effective cache identity',async()=>{
 const f=await fixture();assert.equal(f.policy.version,'ocr-private-home-v1');assert.equal(Object.isFrozen(f.policy),true);assert.equal(Object.isFrozen(f.policy.identity),true);assert.equal(path.dirname(f.policy.home),f.profileRoot);assert.equal((await fs.lstat(f.policy.home)).isDirectory(),true);assert.equal(f.policy.identity.home,f.policy.home);assert.equal(f.policy.identity.python,f.policy.pythonExecutable);const again=await api.prepareOcrEnvironmentPolicy(f);assert.deepEqual(again.identity,f.policy.identity);await assert.rejects(api.prepareOcrEnvironmentPolicy({...f,profileRoot:'C:/outside-private-output'}),{code:'CONFIG_PATH'});
 const other=await fixture(),context={kind:'ocr',ownerScope:'a'.repeat(64),projectId:'book'};assert.notEqual(runtimeCacheIdentity({...context,configuration:{ocrEnvironment:f.policy.identity}}),runtimeCacheIdentity({...context,configuration:{ocrEnvironment:other.policy.identity}}));
});
test('the explicit fifth policy survives async/nested owners while the nearest owner retains the child',async()=>{
 const f=await fixture(),job=new boundaries.ProcessOwner(),cache=new boundaries.ProcessOwner(),env={SYSTEMROOT:'C:/Windows',PATH:'E:/local',hoMe:'CALLER_HOME',uSeRpRoFiLe:'CALLER_PROFILE'},options={windowsHide:true,stdio:'ignore',env};await withSpawn(async calls=>{
  const child=await job.run(async()=>{await new Promise(resolve=>setImmediate(resolve));return cache.run(()=>childProcess.spawn(f.pythonExecutable,['-I','-X','utf8','-B','trusted-sidecar.py'],options));},undefined,undefined,undefined,f.policy);
  assert.equal(calls.length,1);const actual=calls[0].args[2];assert.notEqual(actual,options);assert.notEqual(actual.env,env);assert.equal(actual.env.HOME,f.policy.home);assert.equal(actual.env.USERPROFILE,f.policy.home);assert.equal(Object.keys(actual.env).filter(key=>['HOME','USERPROFILE'].includes(key.toUpperCase())).length,2);assert.equal(env.hoMe,'CALLER_HOME');assert.equal(env.uSeRpRoFiLe,'CALLER_PROFILE');assert.equal(job.children.size,0);assert.equal(cache.children.has(child),true);await cache.cleanup();
 });
});
test('no scope, a different executable and absent explicit env pass the same opaque options unchanged',async()=>{
 const f=await fixture(),owner=new boundaries.ProcessOwner(),opaque=new Proxy({},{get(){throw new Error('opaque options were read');}});await withSpawn(async calls=>{
  childProcess.spawn(f.pythonExecutable,[],opaque);owner.run(()=>childProcess.spawn(path.join(f.directory,'foreign.exe'),[],opaque),undefined,undefined,undefined,f.policy);const noEnv={stdio:'ignore'};owner.run(()=>childProcess.spawn(f.pythonExecutable,[],noEnv),undefined,undefined,undefined,f.policy);assert.equal(calls[0].args[2],opaque);assert.equal(calls[1].args[2],opaque);assert.equal(calls[2].args[2],noEnv);await owner.cleanup();
 });
});
test('existing parent spawn denial and abort happen before any OCR environment options are inspected',async()=>{
 const f=await fixture(),owner=new boundaries.ProcessOwner(),opaque=new Proxy({},{get(){throw new Error('env read before denial');}});await withSpawn(async calls=>{
  const deny={allowSpawn:false};assert.throws(()=>owner.run(()=>owner.run(()=>childProcess.spawn(f.pythonExecutable,[],opaque),undefined,undefined,undefined,f.policy),undefined,undefined,deny),{code:'PROCESS_RESTART_REQUIRED'});const controller=new AbortController();controller.abort();assert.throws(()=>owner.run(()=>childProcess.spawn(f.pythonExecutable,[],opaque),undefined,controller.signal,undefined,f.policy),{code:'CANCELLED'});assert.equal(calls.length,0);assert.equal(owner.children.size,0);
 });
});
test('policy injection never imports ambient secrets or mutates process.env and does not leak past run',async()=>{
 const f=await fixture(),owner=new boundaries.ProcessOwner(),key='MANGOHANA_TEST_OCR_ENV_SECRET',old=process.env[key];process.env[key]='SYNTHETIC_SECRET';const supplied={PATH:'local-only'},options={env:supplied};try{await withSpawn(async calls=>{
  owner.run(()=>childProcess.spawn(f.pythonExecutable,[],options),undefined,undefined,undefined,f.policy);assert.equal(calls[0].args[2].env[key],undefined);assert.equal(process.env[key],'SYNTHETIC_SECRET');assert.deepEqual(supplied,{PATH:'local-only'});owner.run(()=>childProcess.spawn(f.pythonExecutable,[],options));assert.equal(calls[1].args[2],options);assert.equal(supplied.HOME,undefined);await owner.cleanup();
 });}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
});
