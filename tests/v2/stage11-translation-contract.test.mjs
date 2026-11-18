import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
let api={};try{api=require('../../packages/ai-engine/quality/translation-contract.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const {parsePageTranslation}=require('../../packages/ai-engine/quality/page-translation.cjs');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function fixture(){
 const scope={owner:'a'.repeat(64),projectId:'book',pageId:'p2',pageNumber:2,sourceSha256:'b'.repeat(64)};
 const groups=[{id:'a',text:'田中は3個持っていない。',readingOrder:1,productionOcrProvenance:{sourceDetectionIds:['s1','s2']},speakerCandidates:['田中']},{id:'b',text:'待ってください。',readingOrder:2,productionOcrProvenance:{sourceDetectionIds:['s3']},speakerCandidates:[]}];
 const extraction={pageNumber:2,speechBubbles:groups,nonSpeechText:[{id:'sfx',text:'ドン',type:'sound_effect'}]};
 const lines=groups.map((g,i)=>({id:g.id,order:i+1,pageNumber:2,sourceText:g.text,sourceLanguage:'ja',dialogueType:'speech',ocrEditStatus:'ai_proposed',sourceLineIds:g.productionOcrProvenance.sourceDetectionIds}));
 const context={version:1,...scope,glossaryRevision:3,glossary:[{id:'name',source:'田中',target:'다나카',category:'character',priority:1}],conditionalGlossary:[],profiles:[],previousPages:[],previousContext:[]};
 return {scope,extraction,lines,context:{...context,snapshotSha256:hash(context)}};
}
const build=f=>{assert.equal(typeof api.buildTranslationInput,'function','Stage11 immutable input contract required');return api.buildTranslationInput(f);};
const seal=f=>{delete f.context.snapshotSha256;f.context.snapshotSha256=hash(f.context);return f;};
const result=(id,translation,source_reading)=>({id,translatedText:translation,proposedSource:source_reading??'unchanged',uncertain:false});
test('source identities, multiline group, reading order and preserve observations survive immutable input',()=>{
 const f=fixture(),before=structuredClone(f),x=build(f);
 assert.deepEqual(x.regions.map(r=>r.id),['a','b']);assert.deepEqual(x.regions[0].sourceLineIds,['s1','s2']);
 assert.equal(x.regions[0].speaker.status,'AI_PROPOSED');assert.equal(x.regions[0].speaker.confirmed,false);
 assert.equal(x.regions[1].speaker.name,null);assert.equal(x.preserved[0].id,'sfx');assert.deepEqual(f,before);
});
for(const defect of ['missing','duplicate','unknown','source-change','order','owned','duplicate-source','needs-review'])test('input rejects '+defect+' before model request',()=>{
 const f=fixture();if(defect==='missing')f.lines.pop();if(defect==='duplicate')f.lines[1].id='a';if(defect==='unknown')f.lines[1].id='foreign';if(defect==='source-change')f.lines[0].sourceText='行く';if(defect==='order')f.lines.reverse();if(defect==='owned')f.lines[0].userTranslation='사용자 확정';if(defect==='duplicate-source'){f.extraction.speechBubbles[1].productionOcrProvenance.sourceDetectionIds=['s1'];f.lines[1].sourceLineIds=['s1'];}if(defect==='needs-review')f.selection={needsReviewRegions:1,decisions:[{id:'a',action:'needs_review'}]};
 assert.throws(()=>build(f));
});
for(const field of ['owner','projectId','pageId','pageNumber','sourceSha256'])test('bound context rejects foreign '+field,()=>{
 const f=fixture();f.context[field]=field==='pageNumber'?9:'foreign';seal(f);assert.throws(()=>build(f),{code:'TRANSLATION_CONTEXT_INVALID'});
});
test('context tampering and stale current revision cannot silently become empty context',()=>{
 const f=fixture();f.context.glossary[0].target='스즈키';assert.throws(()=>build(f),{code:'TRANSLATION_CONTEXT_INVALID'});
 const g=fixture();const x=build(g);assert.throws(()=>api.validateTranslationBatch({input:x,results:[result('a','다나카는 3개 없어.'),result('b','기다려 주세요.')],currentContextRevision:4}),{code:'TRANSLATION_CONTEXT_STALE'});
});
test('unreviewed, future and foreign prior turns cannot become confirmed prompt facts',()=>{
 const f=fixture();f.context.previousContext=[{source:'前',translation:'사망했다',status:'AI_PROPOSED',pageNumber:1},{source:'未来',translation:'미래',status:'USER_CONFIRMED',pageNumber:3},{source:'他',translation:'다른 작품',status:'USER_CONFIRMED',pageNumber:1,projectId:'other'}];
 const x=build(seal(f));assert.equal(x.context.previousVerified.length,0);assert.equal(x.context.excluded.length,3);
 assert.equal(JSON.stringify(api.linePromptData(x,'a')).includes('사망했다'),false);
});
test('confirmed terms retain priority while unknown conditional speaker terms are deferred',()=>{
 const f=fixture();f.context.conditionalGlossary=[{id:'conditional',source:'田中',target:'다나카 님',condition:{speaker:'田中'}},{id:'speech',source:'待って',target:'기다려',condition:{dialogueType:'speech'}}];
 const x=build(seal(f)),a=api.linePromptData(x,'a'),b=api.linePromptData(x,'b');
 assert.equal(a.terms[0].target,'다나카');assert.equal(a.terms.some(t=>t.id==='conditional'),false);assert.equal(b.terms[0].id,'speech');
 assert.ok(x.context.excluded.some(e=>e.reason==='CONDITIONAL_TERM_UNRESOLVED'));
});
test('prompt budget keeps relevant confirmed terminology before lower priority context and records omissions',()=>{
 const f=fixture();f.context.previousContext=Array.from({length:20},(_,i)=>({id:'t'+i,source:'前'.repeat(100),translation:'앞'.repeat(100),status:'AI_PROPOSED',pageNumber:1}));
 const x=build(seal(f));assert.ok(api.linePromptData(x,'a').terms.some(t=>t.id==='name'));assert.ok(x.context.excluded.length>=20);
});
test('all output identities are checked before any candidate can replace original or user values',()=>{
 const f=fixture(),x=build(f),before=structuredClone(f);
 for(const results of [[result('a','다나카는 3개 없어.')],[result('a','다나카는 3개 없어.'),result('a','기다려')],[result('a','다나카는 3개 없어.'),result('z','기다려')],[result('a','다나카는 3개 없어.'),result('b',' ')]] )assert.throws(()=>api.validateTranslationBatch({input:x,results}));
 assert.deepEqual(f,before);
 const out=api.validateTranslationBatch({input:x,results:[result('b','기다려 주세요.',f.lines[1].sourceText),result('a','다나카는 3개 없어.',f.lines[0].sourceText)]});
 assert.deepEqual(out.map(r=>r.id),['a','b']);assert.equal(out[0].semantic.humanSemanticVerified,null);assert.equal(out[0].semantic.semanticAccuracy,null);assert.equal(out[0].semantic.automaticQualityApproval,false);
});
test('blank interpreted source is rejected rather than treating it as valid source observation',()=>{
 assert.throws(()=>parsePageTranslation(JSON.stringify({regions:[{id:'a',source_reading:' ',translation:'다나카',uncertain:false}]}),[fixture().lines[0]]),{code:'PAGE_TRANSLATION_INVALID'});
});
test('risk signals distinguish conservative warnings from meaning certification and preserve normal paraphrases',()=>{
 const f=fixture(),x=build(f);
 const cases=[['a','스즈키는 2개 있어.','GLOSSARY_CONFLICT'],['a','다나카는 3개 있어.','POLARITY_RISK'],['b','기다려','REGISTER_RISK']];
 for(const [id,text,code]of cases){const r=api.assessSemanticRisk({region:x.regions.find(r=>r.id===id),translatedText:text,terms:api.linePromptData(x,id).terms});assert.ok(r.signals.some(s=>s.code===code));assert.equal(r.semanticAccuracy,null);}
 for(const text of ['고마워','정말 고맙다','고맙네']){const r=api.assessSemanticRisk({region:{sourceText:'ありがとう',dialogueType:'speech',speaker:{confirmed:false}},translatedText:text});assert.equal(r.signals.length,0);assert.equal(r.semanticReviewRequired,true);assert.equal(r.draftUsable,true);assert.equal(r.automaticQualityApproval,false);}
});

test('standalone risk inspection cannot certify schema or region mapping',()=>{
 const r=api.assessSemanticRisk({region:{sourceText:'ありがとう'},translatedText:'고마워'});
 assert.equal(r.statuses.includes('OUTPUT_SCHEMA_VALID'),false);assert.equal(r.statuses.includes('REGION_MAPPING_VALID'),false);
});
test('applicable specific confirmed terms override generic wording and unresolved conflicts become review signals',()=>{
 const f=fixture();f.context.conditionalGlossary=[{id:'specific',source:'田中',target:'다나카 씨',condition:{dialogueType:'speech'},priority:2}];
 const x=build(seal(f));assert.deepEqual(api.linePromptData(x,'a').terms.map(t=>t.target),['다나카 씨']);
 f.context.conditionalGlossary.push({id:'conflict',source:'田中',target:'다나카 님',condition:{dialogueType:'speech'},priority:2});
 const y=build(seal(f)),data=api.linePromptData(y,'a');assert.equal(data.terms.length,0);assert.ok(data.excluded.some(e=>e.reason==='CONFIRMED_TERM_CONFLICT'));
 const results=[result('a','다나카는 3개 없어.',f.lines[0].sourceText),result('b','기다려 주세요.',f.lines[1].sourceText)];
 assert.ok(api.validateTranslationBatch({input:y,results})[0].semantic.signals.some(s=>s.code==='GLOSSARY_POLICY_CONFLICT'));
});
test('explicit AI term status cannot be promoted to a confirmed term by a valid snapshot hash',()=>{
 const f=fixture();f.context.glossary[0].status='AI_PROPOSED';const x=build(seal(f));assert.equal(api.linePromptData(x,'a').terms.length,0);
});
test('user-owned speaker is distinct from AI candidates and conditional honorifics keep the relation condition',()=>{
 const f=fixture();f.lines[0].speaker='田中';f.lines[0].ocrUserOwnedFields=['speaker'];f.context.profiles=[{id:'tanaka',name:'田中',aliases:[],speechStyle:'존댓말',relationshipNotes:'현재 상대를 확인해야 함'}];
 f.context.conditionalGlossary=[{id:'sir',source:'田中',target:'다나카 씨',condition:{speaker:'田中'}}];
 const x=build(seal(f)),data=api.linePromptData(x,'a');assert.equal(data.source.speaker.confirmed,true);assert.equal(data.source.addressee.status,'UNKNOWN');assert.ok(data.profiles.some(p=>p.id==='tanaka'));assert.ok(data.terms.some(t=>t.id==='sir'));
});

test('mandatory source exceeding the prompt budget is held intact instead of silently truncating or dropping it',()=>{
 const x=build(fixture());assert.throws(()=>api.linePromptData(x,'a',{budget:100}),{code:'TRANSLATION_INPUT_LIMIT'});
});
