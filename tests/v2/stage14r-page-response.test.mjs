// Saved actual failure + synthetic final responses. No inference is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const api=require('../../packages/ai-engine/quality/page-translation.cjs');
const {buildTranslationInput,validateTranslationBatch}=require('../../packages/ai-engine/quality/translation-contract.cjs');
const raw=await fs.readFile(new URL('./fixtures/stage14r/page-reasoning-only.json',import.meta.url));
const saved=JSON.parse(raw);
const lines=Array.from({length:13},(_,i)=>({id:'region-'+(i+1),sourceText:'待ってください。',sourceLanguage:'ja',order:i+1,pageNumber:1,sourceLineIds:['source-'+i],ocrEditStatus:'ai_proposed'}));
const input=buildTranslationInput({lines,extraction:{pageNumber:1,speechBubbles:lines.map(l=>({id:l.id,text:l.sourceText,readingOrder:l.order,productionOcrProvenance:{sourceDetectionIds:l.sourceLineIds}})),nonSpeechText:[]},scope:{owner:'a'.repeat(64),projectId:'work',pageId:'page',pageNumber:1,sourceSha256:'b'.repeat(64)}});
const good=()=>lines.map(l=>({id:l.id,source_reading:l.sourceText,translation:'기다려 주세요.',uncertain:false}));
const envelope=(regions=good(),extra={})=>({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({regions})}}],usage:{prompt_tokens:100,completion_tokens:500,total_tokens:600},...extra});
const parse=r=>{assert.equal(typeof api.parsePageTranslationResponse,'function');return api.parsePageTranslationResponse(r,lines);};

test('raw Stage14 failure fixture is byte-exact and never becomes a translation through reasoning',()=>{
 assert.equal(createHash('sha256').update(raw).digest('hex'),'4559e3ad520b55d5ac7226d1738c536c350750d642c19f10049f21910f1cafc9');
 assert.equal(Buffer.byteLength(saved.response.choices[0].message.content),0);
 assert.equal(Buffer.byteLength(saved.response.choices[0].message.reasoning_content),7970);
 assert.throws(()=>parse(saved.response),{code:'PAGE_TRANSLATION_INVALID'});
});
test('empty final content is rejected even when the reasoning channel contains valid thirteen-region JSON',()=>{
 const r=envelope();r.choices[0].message.reasoning_content=r.choices[0].message.content;r.choices[0].message.content='';
 assert.throws(()=>parse(r),{code:'PAGE_TRANSLATION_INVALID'});
});
test('length completion is rejected even if its final bytes happen to parse as complete JSON',()=>{
 const r=envelope();r.choices[0].finish_reason='length';r.usage.completion_tokens=2400;
 assert.throws(()=>parse(r),{code:'PAGE_TRANSLATION_INVALID'});
});
for(const defect of ['partial-json','schema','missing','duplicate','foreign','empty'])test('final channel rejects '+defect+' without changing any original or confirmed values',()=>{
 const source=structuredClone(lines),protectedValues={png:'old-png-bytes',trio:'old-trio-bytes',confirmed:'사용자 확정 문장'},before=structuredClone(protectedValues),rows=good(),r=envelope(rows);
 if(defect==='partial-json')r.choices[0].message.content=r.choices[0].message.content.slice(0,-8);
 else {if(defect==='schema')rows[0].uncertain='false';if(defect==='missing')rows.pop();if(defect==='duplicate')rows[12]={...rows[0]};if(defect==='foreign')rows[12].id='unrequested';if(defect==='empty')rows[0].translation=' ';r.choices[0].message.content=JSON.stringify({regions:rows});}
 assert.throws(()=>parse(r),{code:'PAGE_TRANSLATION_INVALID'});assert.deepEqual(lines,source);assert.deepEqual(protectedValues,before);
});
test('normal thirteen-region final JSON passes Stage11 while human review is still required',()=>{
 const r=envelope();r.choices[0].message.reasoning_content='unrelated diagnostic text';
 const out=validateTranslationBatch({input,results:parse(r)});assert.deepEqual(out.map(x=>x.id),lines.map(x=>x.id));
 assert.ok(out.every(x=>x.semantic.automaticQualityApproval===false&&x.semantic.humanSemanticVerified===null));
});
test('uncertain dialogue remains a review signal and cannot be automatically approved',()=>{
 const rows=good();rows[0].uncertain=true;
 const out=validateTranslationBatch({input,results:parse(envelope(rows))});
 assert.equal(out[0].uncertain,true);assert.ok(out[0].semantic.signals.some(x=>x.code==='MODEL_UNCERTAIN'));assert.equal(out[0].semantic.automaticQualityApproval,false);
});
test('small validated response sets combine only after the whole thirteen-ID set exists',()=>{
 const rows=good(),sets=[rows.slice(0,3),rows.slice(3,6),rows.slice(6,9),rows.slice(9)];
 const results=sets.map((batch,i)=>api.parsePageTranslation(JSON.stringify({regions:batch}),lines.slice(i*3,i===3?13:(i+1)*3)));
 assert.throws(()=>validateTranslationBatch({input,results:results.slice(0,3).flat()}),{code:'TRANSLATION_RESPONSE_INVALID'});
 assert.throws(()=>validateTranslationBatch({input,results:[...results.flat(),results[0][0]]}),{code:'TRANSLATION_RESPONSE_INVALID'});
 assert.equal(validateTranslationBatch({input,results:results.flat()}).length,13);
});
test('page request enforces a zero reasoning budget without changing sampling or the output cap',()=>{
 const request=api.buildPageTranslationRequest({lines,imageDataUrl:'data:image/png;base64,aA==',translationInput:input});
 assert.equal(request.reasoning_budget_tokens,0);assert.equal(request.max_tokens,2400);assert.equal(request.temperature,0);
 assert.equal(request.reasoning_format,undefined);assert.equal(request.chat_template_kwargs?.enable_thinking,false);
});
