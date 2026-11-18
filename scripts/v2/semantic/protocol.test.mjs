import test from 'node:test';
import assert from 'node:assert/strict';
import {structuredRequest,parseStructured} from './protocol.mjs';
const lines=[{id:'dialogue-a',sourceText:'今日は寒いですね。'},{id:'dialogue-b',sourceText:'そうだね。'}];
test('binds all unedited source values and identities to one structured request',()=>{
 const input=structuredRequest(lines);
 assert.equal(input.messages[0].role,'user');
 assert.ok(input.messages[0].content.includes(JSON.stringify({regions:lines.map(line=>({id:line.id,text:line.sourceText}))})));
 assert.deepEqual(input.response_format.json_schema.schema.properties.regions.items.properties.id.enum,lines.map(line=>line.id));
});
test('maps reordered responses by exact IDs while preserving original text',()=>{
 const result=parseStructured(JSON.stringify({regions:[{id:'dialogue-b',text:'그러네.'},{id:'dialogue-a',text:'오늘 춥네요.'}]}),lines);
 assert.deepEqual(result.map(line=>line.id),lines.map(line=>line.id));assert.equal(result[0].sourceText,lines[0].sourceText);
});
test('rejects missing, duplicated and foreign IDs before returning any translation',()=>{
 for(const regions of [[{id:'dialogue-a',text:'춥네요.'}],[{id:'dialogue-a',text:'춥네요.'},{id:'dialogue-a',text:'그래.'}],[{id:'dialogue-a',text:'춥네요.'},{id:'foreign',text:'그래.'}]])assert.throws(()=>parseStructured(JSON.stringify({regions}),lines),{code:'SEMANTIC_PROTOCOL_INVALID'});
});
test('rejects empty translations, extra fields and malformed JSON',()=>{
 for(const content of ['```json\n{}\n```',JSON.stringify({regions:[{id:'dialogue-a',text:' '},{id:'dialogue-b',text:'그래.'}]}),JSON.stringify({regions:[{id:'dialogue-a',text:'춥네요.',extra:true},{id:'dialogue-b',text:'그래.'}]})])assert.throws(()=>parseStructured(content,lines),{code:'SEMANTIC_PROTOCOL_INVALID'});
});
test('does not take ownership of a manual translation',()=>{
 assert.throws(()=>structuredRequest([{...lines[0],userTranslation:'수동 수정'}]),{code:'SEMANTIC_PROTOCOL_INVALID'});
});
