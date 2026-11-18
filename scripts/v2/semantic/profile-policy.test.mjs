import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildPageTranslationRequest}=require('../../../packages/ai-engine/quality/page-translation.cjs');
test('text-only resource diagnosis cannot silently enable vision or alter raw page data',async t=>{
 assert.equal(await fs.access(new URL('./profile-policy.mjs',import.meta.url)).then(()=>true,()=>false),true,'resource and text-only policy is required before launching');
 const {modelArguments,textOnlyRequest}=await import('./profile-policy.mjs');
 const profile={gpuLayers:20,contextSize:8192,batchSize:512,ubatchSize:512,imageMaxTokens:0,thinking:false,reasoningBudget:0};
 const launch={profile,modelPath:'E:/synthetic-model.gguf',projectorPath:'E:/synthetic-projector.gguf',alias:'synthetic-alias',port:12345};
 await t.test('512 text mode omits projector and image settings and retains normal warm-up',()=>{
  const args=modelArguments(launch);
  assert.equal(args.includes('--mmproj'),false);assert.equal(args.includes(launch.projectorPath),false);
  assert.equal(args.includes('--image-max-tokens'),false);assert.equal(args.includes('--no-warmup'),false);
  for(const [flag,value]of [['--ctx-size','8192'],['--n-gpu-layers','20'],['--batch-size','512'],['--ubatch-size','512'],['--parallel','1']])assert.equal(args[args.indexOf(flag)+1],value);
 });
 await t.test('image512 and other unreviewed launch profiles fail before native execution',()=>{
  for(const changed of [{imageMaxTokens:1024},{batchSize:256},{gpuLayers:21},{contextSize:4096}])assert.throws(()=>modelArguments({...launch,profile:{...profile,...changed}}),/RESOURCE_PROFILE_INVALID/);
 });
 await t.test('the previous image4096 profile retains explicit vision arguments',()=>{
  const args=modelArguments({...launch,profile:{...profile,batchSize:4096,ubatchSize:4096,imageMaxTokens:1024}});
  assert.equal(args[args.indexOf('--mmproj')+1],launch.projectorPath);
  assert.equal(args[args.indexOf('--image-max-tokens')+1],'1024');
 });
 await t.test('the no-mmap diagnosis fixes none loading and no-host without mlock or vision',()=>{
  const args=modelArguments({...launch,profile:{...profile,loadMode:'none',noHost:true}});
  assert.equal(args[args.indexOf('--load-mode')+1],'none');assert.equal(args.includes('--no-host'),true);
  for(const flag of ['--mlock','--mmap','--mmproj','--image-max-tokens','--no-warmup'])assert.equal(args.includes(flag),false);
 });
 await t.test('unreviewed load mode and host preference combinations fail closed',()=>{
  for(const changed of [{loadMode:'mlock'},{loadMode:'none',noHost:false},{loadMode:'mmap',noHost:true},{noHost:true}])assert.throws(()=>modelArguments({...launch,profile:{...profile,...changed}}),/RESOURCE_PROFILE_INVALID/);
 });
 await t.test('text-only prompt preserves all original text and schema, omits image, and declares absence',()=>{
  const lines=[{id:'fixture-a',sourceText:'昨日は雨でした。'},{id:'fixture-b',sourceText:'そうですね。'}];
  const original=buildPageTranslationRequest({lines,imageDataUrl:'data:image/png;base64,AA=='});
  const frozen=JSON.stringify(original),converted=textOnlyRequest(original);
  assert.equal(JSON.stringify(original),frozen);
  assert.equal(converted.messages[1].content.length,1);
  assert.deepEqual(converted.messages[1].content[0],original.messages[1].content[0]);
  assert.deepEqual(converted.response_format,original.response_format);
  assert.equal(JSON.stringify(converted).includes('image_url'),false);
  assert.match(converted.messages[0].content,/그림이 제공되지 않았습니다/);
 });
});
