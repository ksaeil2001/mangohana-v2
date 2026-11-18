// Real TS payload/adapter/client/registry. Intercepted HTTP; no AI or external service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const compiled=await fs.mkdtemp(path.join(os.tmpdir(),'stage11-real-ts-'));
execFileSync(process.execPath,['packages/ai-engine/node_modules/typescript/bin/tsc','-p','packages/ai-engine/tsconfig.json','--outDir',compiled],{windowsHide:true,stdio:'pipe'});
await fs.writeFile(path.join(compiled,'package.json'),'{"type":"module"}');
const load=p=>import(pathToFileURL(path.join(compiled,'src',p)).href);
const {createLocalAiTranslationAdapter}=await load('main/translation/adapters/localAiAdapter.js');
const {createTranslationEngineRegistry}=await load('main/translation/translationEngineRegistry.js');
const {buildTranslationContextPayload}=await load('shared/translation/translationPayload.js');
const {inspectTranslationQuality}=await load('shared/translation/translationQa.js');
const line=(id,text,extra={})=>({id,sourceText:text,pageNumber:1,order:id==='a'?1:2,sourceLanguage:'ja',dialogueType:'speech',parseWarnings:[],parseConfidence:1,...extra});
test('V2 safe payload cannot reuse AI/reference translations or future page TM',()=>{
 const payload=buildTranslationContextPayload({dialogueLines:[line('a','ありがとう',{aiTranslation:'AI_UNREVIEWED',referenceTranslation:'REFERENCE_NOT_GT'}),line('b','ありがとう')],targetLineId:'b',v2SafeContext:true});
 assert.equal(payload.contextWindow.previousTurns[0].resolvedTranslation,undefined);assert.equal(payload.entities.fuzzyTmMatches.length,0);
});
test('strict text request uses confirmed input, one structured response and unchanged sampling',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);const requests=[];
 const raw=JSON.stringify({regions:[{id:'b',source_reading:'ありがとう',translation:'고마워',uncertain:false}]});
 globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({choices:[{message:{content:raw}}]})};};
 const payload=buildTranslationContextPayload({dialogueLines:[line('a','昨日',{aiTranslation:'UNREVIEWED_POISON'}),line('b','ありがとう')],targetLineId:'b',v2SafeContext:true});
 const schema={type:'json_schema',json_schema:{name:'manga_dialogue_line',strict:true,schema:{type:'object'}}};
 payload.stage11={promptVersion:'stage11-text-v1',data:{source:{id:'b',source:'ありがとう'},terms:[{source:'猫',target:'고양이',status:'USER_CONFIRMED'}]},responseFormat:schema};
 const result=await createTranslationEngineRegistry([createLocalAiTranslationAdapter()]).executeTranslation(payload,{engineType:'local_ai',localAiRuntime:'custom',localAiModel:'gemma4-e2b-local',localAiEndpoint:'http://127.0.0.1:1',skipQaInspection:true});
 assert.equal(requests.length,1);assert.deepEqual(requests[0].body.response_format,schema);assert.equal(requests[0].body.temperature,0.3);assert.equal(requests[0].body.model,'gemma4-e2b-local');
 assert.equal(JSON.stringify(requests).includes('UNREVIEWED_POISON'),false);assert.ok(JSON.stringify(requests).includes('USER_CONFIRMED'));assert.equal(result.translatedText,raw);
});
test('strict response stays raw so markdown/extra explanations cannot be cleaned into a valid success',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
 const raw='```json\n{"regions":[]}\n```';globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:raw}}]})});
 const payload=buildTranslationContextPayload({dialogueLines:[line('b','ありがとう')],targetLineId:'b',v2SafeContext:true});
 payload.stage11={promptVersion:'stage11-text-v1',data:{source:{id:'b',source:'ありがとう'}},responseFormat:{type:'json_schema'}};
 const result=await createLocalAiTranslationAdapter().translate(payload,{localAiRuntime:'custom',localAiEndpoint:'http://127.0.0.1:1',localAiModel:'gemma4-e2b-local'});
 assert.equal(result.translatedText,raw);
});

test('character speech rules are an advisory QA signal while normal context-dependent variants remain drafts',()=>{
 const profile={id:'hero',name:'다나카',aliases:['田中'],speechStyle:'존댓말'};
 const qa=inspectTranslationQuality({sourceText:'今行きます。',translatedText:'지금 간다.',speakerProfile:profile,dialogueType:'speech'});
 assert.ok(qa.issues.some(i=>i.type==='SPEECH_STYLE_MISMATCH'));assert.equal(qa.issues.some(i=>i.type==='SPEECH_STYLE_MISMATCH'&&i.severity==='error'),false);
});
