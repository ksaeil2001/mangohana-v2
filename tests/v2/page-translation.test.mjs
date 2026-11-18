import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {buildPageTranslationRequest,parsePageTranslation}=createRequire(import.meta.url)('../../packages/ai-engine/quality/page-translation.cjs');
const lines=()=>[{id:'a',sourceText:'おはようございます。',sourceLanguage:'ja',order:1},{id:'b',sourceText:'あ::ありがとう。',sourceLanguage:'ja',order:2}];
const response=(regions)=>JSON.stringify({regions});
const good=()=>[{id:'a',source_reading:'おはようございます。',translation:'안녕하세요.',uncertain:false},{id:'b',source_reading:'あ…ありがとう。',translation:'아:: 고마워.',uncertain:false}];
test('binds page imagery, trusted terminology and previous context to exact target IDs',()=>{
 const request=buildPageTranslationRequest({lines:lines(),imageDataUrl:'data:image/png;base64,aGVsbG8=',glossary:[{source:'ありがとう',target:'고마워'}],previousContext:[{source:'昨日',translation:'어제'}]});
 assert.equal(request.messages[1].content[1].image_url.url,'data:image/png;base64,aGVsbG8=');
 assert.match(request.messages[1].content[0].text,/고마워/);assert.match(request.messages[1].content[0].text,/어제/);
 assert.deepEqual(request.response_format.json_schema.schema.properties.regions.items.properties.id.enum,['a','b']);
 assert.equal(request.response_format.json_schema.schema.properties.regions.items.properties.translation.minLength,1);
});
test('keeps original OCR and proposed reading separate while normalizing only display punctuation',()=>{
 const input=lines(),snapshot=structuredClone(input);const parsed=parsePageTranslation(response(good()),input);
 assert.equal(parsed[1].sourceText,input[1].sourceText);assert.equal(parsed[1].proposedSource,'あ…ありがとう。');assert.equal(parsed[1].translatedText,'아… 고마워.');assert.equal(parsed[1].rawTranslatedText,'아:: 고마워.');assert.deepEqual(input,snapshot);
});
test('rejects duplicate, missing and foreign response IDs before applying any line',()=>{
 const input=lines();for(const rows of [[good()[0]],[good()[0],good()[0]],[good()[0],{...good()[1],id:'foreign'}]])assert.throws(()=>parsePageTranslation(response(rows),input));
});
test('rejects empty translations and invalid response shapes rather than dropping a dialogue',()=>{
 for(const value of ['', '   ', '\u0000'])assert.throws(()=>parsePageTranslation(response([{...good()[0],translation:value},good()[1]]),lines()));
 assert.throws(()=>parsePageTranslation('```json\n'+response(good())+'\n```',lines()));
 assert.throws(()=>parsePageTranslation(response([{...good()[0],uncertain:'false'},good()[1]]),lines()));
});
test('punctuation-only source cannot acquire a neighbouring sentence',()=>{
 const input=[{id:'pause',sourceText:'……',sourceLanguage:'ja',order:1}];
 const parsed=parsePageTranslation(response([{id:'pause',source_reading:'……',translation:'고마워!',uncertain:false}]),input);
 assert.equal(parsed[0].translatedText,'……');assert.ok(parsed[0].normalizations.includes('preserved_punctuation_only_source'));
});
test('manual translations are never accepted as unowned AI draft input',()=>{
 const input=lines();input[0].userTranslation='사용자가 쓴 문장';assert.throws(()=>buildPageTranslationRequest({lines:input,imageDataUrl:'data:image/png;base64,aA=='}));
});

test('previous page drafts remain explicitly unreviewed model context rather than confirmed reference translations',()=>{
 const request=buildPageTranslationRequest({lines:lines(),imageDataUrl:'data:image/png;base64,aGVsbG8=',previousContext:[{source:'昨日',translation:'어제',status:'AI_PROPOSED'}]});
 const data=JSON.parse(request.messages[1].content[0].text.split('\n').slice(1).join('\n'));
 assert.equal(data.previousPageContext[0].status,'AI_PROPOSED');
 assert.match(request.messages[0].content,/미검수 AI 후보/);
});
