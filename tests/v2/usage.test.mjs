import test from 'node:test';
import assert from 'node:assert/strict';
import {usageFromReport} from '../../apps/engine/store.mjs';

const tokens=(prompt_tokens=11,completion_tokens=7)=>({prompt_tokens,completion_tokens,total_tokens:prompt_tokens+completion_tokens});
function page(requestId='shared',count=6,durationMs=123,usage=tokens()){
 const regionIds=Array.from({length:count},(_,index)=>requestId+'-'+index);
 return {translations:regionIds.map((id,index)=>({id,requestId,requestScope:'page',modelHttpRequests:index===0?1:0,durationMs,usage})),
  translationRequests:[{requestId,scope:'page',regionIds,httpRequests:1,durationMs,usage}],measurements:{elapsedMs:999.25}};
}

test('one shared page request contributes duration and tokens once despite six member records',()=>{
 const report=page(),before=structuredClone(report),usage=usageFromReport(report,1200);
 assert.equal(usage.localModelRequests,1);assert.equal(usage.modelRequestMs,123);
 assert.deepEqual(usage.tokenUsage,{promptTokens:11,completionTokens:7,totalTokens:18});
 assert.equal(usage.processingMs,1200);assert.equal(usage.engineMeasuredMs,999.25);assert.equal(usage.monetaryCost,null);
 assert.deepEqual(report,before,'usage aggregation must preserve the raw report and copied member evidence');
});

test('different shared requests and a legacy region each contribute their own usage once',()=>{
 const a=page('a',2,10,tokens(3,2)),b=page('b',3,20,tokens(4,3));
 const report={...a,translations:[...a.translations,...b.translations,{id:'legacy',modelHttpRequests:2,durationMs:7,usage:tokens(2,1)}],translationRequests:[...b.translationRequests,...a.translationRequests]};
 const usage=usageFromReport(report,77);
 assert.equal(usage.localModelRequests,4);assert.equal(usage.modelRequestMs,37);
 assert.equal(usage.tokenUsage,null,'legacy region records do not prove request-level token consumption');
 assert.equal(usage.engineMeasuredMs,999.25);
});

test('different shared request token ledgers are summed once each',()=>{
 const a=page('a',2,10,tokens(3,2)),b=page('b',3,20,tokens(4,3));
 const usage=usageFromReport({...a,translations:[...a.translations,...b.translations],translationRequests:[...b.translationRequests,...a.translationRequests]},77);
 assert.equal(usage.localModelRequests,2);assert.equal(usage.modelRequestMs,30);
 assert.deepEqual(usage.tokenUsage,{promptTokens:7,completionTokens:5,totalTokens:12});
});

test('legacy per-region request and duration sums remain compatible while absent token counts stay unknown',()=>{
 const usage=usageFromReport({translations:[{modelHttpRequests:1,durationMs:5},{modelHttpRequests:2,durationMs:8}],measurements:{elapsedMs:25}},40);
 assert.equal(usage.localModelRequests,3);assert.equal(usage.modelRequestMs,13);assert.equal(usage.engineMeasuredMs,25);
 assert.equal(usage.tokenUsage,null);assert.equal(usage.monetaryCost,null);
});

test('a missing or invalid shared duration never falls back to duplicated member durations',()=>{
 for(const durationMs of [undefined,null,-1,NaN,Infinity]){
  const report=page();report.translationRequests[0].durationMs=durationMs;
  const usage=usageFromReport(report,20);assert.equal(usage.modelRequestMs,null);assert.equal(usage.localModelRequests,1);
 }
});

test('missing, partial, invalid or incoherent token evidence stays unknown and never uses member copies',()=>{
 for(const tokenEvidence of [undefined,null,{prompt_tokens:1,completion_tokens:2},tokens(-1,2),tokens(0.5,1),{...tokens(),total_tokens:999},tokens(Number.MAX_SAFE_INTEGER+1,0)]){
  const report=page();report.translationRequests[0].usage=tokenEvidence;
  assert.equal(usageFromReport(report,20).tokenUsage,null);
 }
});

test('absent or ambiguous request ledgers cannot manufacture measured zero or member-based totals',()=>{
 const missing=page();delete missing.translationRequests;
 const duplicate=page();duplicate.translationRequests.push({...duplicate.translationRequests[0]});
 const foreign=page();foreign.translationRequests[0].requestId='another-page';
 for(const report of [{translations:[]},missing,duplicate,foreign]){
  const usage=usageFromReport(report,20);
  assert.equal(usage.localModelRequests,null);assert.equal(usage.modelRequestMs,null);assert.equal(usage.tokenUsage,null);
 }
});

test('overflowing sums stay unknown and an absent engine measurement is not fabricated',()=>{
 const report={translations:[{modelHttpRequests:Number.MAX_SAFE_INTEGER,durationMs:Number.MAX_VALUE,usage:tokens(Number.MAX_SAFE_INTEGER,0)},{modelHttpRequests:1,durationMs:Number.MAX_VALUE,usage:tokens(1,0)}]};
 const usage=usageFromReport(report,20);
 assert.equal(usage.localModelRequests,null);assert.equal(usage.modelRequestMs,null);assert.equal(usage.tokenUsage,null);assert.equal(usage.engineMeasuredMs,null);
 const a=page('a',1,10,tokens(Number.MAX_SAFE_INTEGER,0)),b=page('b',1,20,tokens(1,0));
 const shared=usageFromReport({...a,translations:[...a.translations,...b.translations],translationRequests:[...a.translationRequests,...b.translationRequests]},20);
 assert.equal(shared.localModelRequests,2);assert.equal(shared.tokenUsage,null);
});
