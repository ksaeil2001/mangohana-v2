// Synthetic exceptions only. No Python, native provider, source image or AI call.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),sha=value=>createHash('sha256').update(value).digest('hex');
let api={};try{api=require('../../packages/ai-engine/quality/ocr-diagnostic.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const diagnostic=(error,options)=>{assert.equal(typeof api.createOcrFailureDiagnostic,'function');return api.createOcrFailureDiagnostic(error,options);};

test('sidecar operation failures produce fixed categories and hashes without private error contents',()=>{
 const message="Production OCR sidecar failed: No module named 'paddleocr'",error=new Error(message),value=diagnostic(error);assert.equal(value.boundary,'ocr_recognition');assert.equal(value.category,'SIDECAR_OPERATION_ERROR');assert.equal(value.causeCategory,'PYTHON_MODULE_MISSING');assert.equal(value.knownModule,'paddleocr');assert.equal(value.errorName,'Error');assert.equal(value.errorCode,null);assert.equal(value.messageSha256,sha(message));assert.equal(value.messageBytes,Buffer.byteLength(message));assert.equal(value.messageTruncated,false);assert.equal(Object.hasOwn(value,'message'),false);assert.equal(Object.hasOwn(value,'stack'),false);
});
test('arbitrary codes/names/messages and hostile getters never become raw diagnostics',()=>{
 const secret='PRIVATE_DIALOGUE_AND_AUTH_123',value=diagnostic({name:secret,code:secret,message:'Production OCR sidecar failed: '+secret,stack:'Error: '+secret+'\n at '+secret+' (C:/'+secret+'/file.js:10:2)'});assert.equal(value.errorName,'UnknownError');assert.equal(value.errorCode,null);assert.equal(JSON.stringify(value).includes(secret),false);assert.deepEqual(value.frames,[]);const hostile=new Proxy({},{get(){throw new Error(secret);}});assert.equal(JSON.stringify(diagnostic(hostile)).includes(secret),false);
});
test('ownership restart, timeout and transport faults stay distinct rather than guessed as model failures',()=>{
 const restart=diagnostic(Object.assign(new Error('secret'),{code:'PROCESS_RESTART_REQUIRED'}));assert.equal(restart.category,'OWNERSHIP_RESTART_REQUIRED');assert.equal(restart.errorCode,'PROCESS_RESTART_REQUIRED');assert.equal(diagnostic(Object.assign(new Error('secret'),{code:'OCR_TIMEOUT'})).category,'OCR_TIMEOUT');for(const [text,category]of [['Production OCR sidecar emitted invalid JSON','SIDECAR_INVALID_JSON'],['Production OCR sidecar response omitted request identity','SIDECAR_REQUEST_ID_MISSING'],['Production OCR sidecar response exceeded the size limit','SIDECAR_RESPONSE_LIMIT'],['Production OCR sidecar was closed','SIDECAR_CLOSED'],['Production OCR sidecar exited (signal:SIGTERM): PRIVATE','SIDECAR_PROCESS_EXIT']])assert.equal(diagnostic(new Error(text)).category,category);
});
test('only known origin basenames and allowlisted static function names reach stack facts',()=>{
 const compiledRoot=path.resolve('E:/synthetic-compiled'),client=pathToFileURL(path.join(compiledRoot,'src/main/ocr/runtime/productionOcrSidecarClient.js')).href;
 const error={name:'Error',message:'PRIVATE',stack:'Error: PRIVATE\n at throwInvalidResponse ('+client+':97:15)\n at PRIVATE ('+client+':54:13)\n at throwInvalidResponse (file:///C:/PRIVATE/productionOcrSidecarClient.js:1:2)\n at PRIVATE (C:/PRIVATE/key.js:100:10)'};
 const value=diagnostic(error,{compiledRoot});assert.equal(value.frames.length,2);assert.deepEqual(value.frames[0],{origin:'compiled_ocr',file:'productionOcrSidecarClient.js',function:'throwInvalidResponse',line:97,column:15});assert.equal(value.frames[1].function,'unknown');assert.equal(JSON.stringify(value).includes('PRIVATE'),false);assert.equal(JSON.stringify(value).includes('synthetic-compiled'),false);
});
test('large or repeated error content has bounded hashing/stack inspection and bounded structured output',()=>{
 const message='Production OCR sidecar failed: '+'秘'.repeat(100000),error=new Error(message),value=diagnostic(error);assert.equal(value.messageTruncated,true);assert.equal(value.messageBytes,null);assert.equal(value.messageChars,message.length);assert.equal(value.messageSha256Scope,'UTF8_PREFIX_65536_UTF16_CHARS');assert.ok(value.messageHashedBytes<=262144);assert.ok(JSON.stringify(value).length<8192);assert.equal(JSON.stringify(value).includes('秘'),false);
 const compiledRoot=path.resolve('E:/synthetic-compiled'),client=pathToFileURL(path.join(compiledRoot,'src/main/ocr/runtime/productionOcrSidecarClient.js')).href;const frames=diagnostic({message:'small',stack:'Error: small\n'+Array.from({length:1000},(_,index)=>' at throwInvalidResponse ('+client+':'+(index+1)+':1)').join('\n')},{compiledRoot});assert.ok(frames.frames.length<=8);assert.equal(frames.stackTruncated,true);
});
test('a secret suffix changes full-message hashes without returning that suffix',()=>{
 const a=diagnostic(new Error('Production OCR sidecar failed: PRIVATE_A')),b=diagnostic(new Error('Production OCR sidecar failed: PRIVATE_B'));assert.notEqual(a.messageSha256,b.messageSha256);assert.equal(JSON.stringify(a).includes('PRIVATE_A'),false);assert.equal(JSON.stringify(b).includes('PRIVATE_B'),false);
});
