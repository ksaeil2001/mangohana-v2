'use strict';
const {createHash}=require('node:crypto');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const MESSAGE_CHARS=65536,STACK_CHARS=32768,FRAME_LIMIT=8;
const names=new Set(['Error','TypeError','RangeError','SyntaxError','AbortError','ProductionOcrUnavailableError','RuntimeLeaseError']);
const codes=new Set(['ENOENT','EACCES','EPERM','EPIPE','ENOMEM','ERR_STREAM_DESTROYED','ERR_INVALID_ARG_TYPE','OCR_TIMEOUT','OCR_EMPTY','OCR_INCOMPLETE','OCR_UNAVAILABLE','OCR_RESOURCE_UNAVAILABLE','PRODUCTION_OCR_RUNTIME_FAILED','PROCESS_RESTART_REQUIRED','CANCELLED','CLEANUP_FAILED','RUNTIME_LEASE_BLOCKED']);
const get=(value,key)=>{try{return value?.[key];}catch{return undefined;}};
const text=value=>typeof value==='string'?value:'';
const sha=value=>createHash('sha256').update(value).digest('hex');
const normalize=file=>{try{const resolved=path.resolve(file.startsWith('file:')?fileURLToPath(file):file);return process.platform==='win32'?resolved.toLowerCase():resolved;}catch{return null;}};

function category(code,message){
 if(code==='PROCESS_RESTART_REQUIRED')return 'OWNERSHIP_RESTART_REQUIRED';
 if(code==='OCR_TIMEOUT')return 'OCR_TIMEOUT';
 if(code==='CANCELLED')return 'CANCELLED';
 if(code==='OCR_EMPTY'||code==='OCR_INCOMPLETE')return 'OCR_RESULT_INVALID';
 const prefixes=[['Production OCR sidecar failed: ','SIDECAR_OPERATION_ERROR'],['Production OCR sidecar exited (','SIDECAR_PROCESS_EXIT'],['Production OCR sidecar was closed','SIDECAR_CLOSED'],['Production OCR sidecar emitted invalid JSON','SIDECAR_INVALID_JSON'],['Production OCR sidecar response omitted request identity','SIDECAR_REQUEST_ID_MISSING'],['Production OCR sidecar response exceeded the size limit','SIDECAR_RESPONSE_LIMIT'],['Invalid Production OCR sidecar response','SIDECAR_RESPONSE_INVALID'],['Invalid Production OCR detail image dimensions','OCR_IMAGE_DIMENSIONS'],['Production OCR detail tile (','OCR_DETAIL_TILE_ERROR'],['Invalid Production OCR detection response','OCR_DETECTION_RESPONSE_INVALID']];
 for(const [prefix,value]of prefixes)if(message.startsWith(prefix))return value;
 return 'UNCLASSIFIED_OCR_ERROR';
}
function cause(message,kind){
 if(kind!=='SIDECAR_OPERATION_ERROR')return {causeCategory:'UNCLASSIFIED',knownModule:null};
 const detail=message.slice('Production OCR sidecar failed: '.length);
 if(detail.startsWith('No module named ')){
  const knownModule=['paddleocr','paddlex','paddle','numpy','onnxruntime','PIL','cpuinfo'].find(name=>detail.startsWith("No module named '"+name+"'")||detail.startsWith("No module named '"+name+'.'))??null;
  return {causeCategory:'PYTHON_MODULE_MISSING',knownModule};
 }
 if(detail.startsWith('DLL load failed')||detail.startsWith('The specified module could not be found'))return {causeCategory:'PYTHON_DLL_LOAD_ERROR',knownModule:null};
 if(detail.startsWith('[Errno 2]')||detail.startsWith('[WinError 2]'))return {causeCategory:'FILE_NOT_FOUND',knownModule:null};
 if(detail.startsWith('[Errno 13]')||detail.startsWith('[WinError 5]'))return {causeCategory:'FILE_PERMISSION',knownModule:null};
 if(detail.startsWith('Unknown engine')||detail.startsWith('Unsupported engine'))return {causeCategory:'MODEL_ENGINE_CONFIGURATION',knownModule:null};
 if(detail.startsWith('std::bad_alloc')||detail.startsWith('bad allocation')||detail.startsWith('Unable to allocate')||detail.startsWith('Out of memory'))return {causeCategory:'ALLOCATION_ERROR',knownModule:null};
 return {causeCategory:'UNCLASSIFIED',knownModule:null};
}
function origins(compiledRoot){
 const engineRoot=path.resolve(__dirname,'..'),compiled=typeof compiledRoot==='string'?path.resolve(compiledRoot):path.join(engineRoot,'.build','compiled');
 const entries=[
  ['main/ocr/runtime/productionOcrSidecarClient.js',['throwInvalidResponse','ProductionOcrSidecarClient.probe','ProductionOcrSidecarClient.detect','ProductionOcrSidecarClient.recognizeGroup']],
  ['main/ocr/runtime/productionOcrSidecarTransport.js',['ProductionOcrSidecarTransport.invoke','ProductionOcrSidecarTransport.consumeStdout','ProductionOcrSidecarTransport.ensureStarted','ProductionOcrSidecarTransport.handleWorkerFailure','ProductionOcrSidecarTransport.stopWorker']],
  ['main/ocr/detection/productionOcrDetailDetector.js',['ProductionOcrDetailDetector.detect','ProductionOcrDetailDetector.detectPage']],
  ['main/ocr/detection/productionDetectorParser.js',['parseProductionOcrDetections','parseDetection','throwInvalid']],
  ['main/ocr/pipeline/productionOcrPipeline.js',['ProductionOcrPipeline.execute']],
  ['main/productionOcrService.js',['Object.execute','execute','ensureRuntime','prepareRuntime']],
  ['main/imageCrop.js',['cropProductionOcrGroup']],['main/abortSignals.js',['throwIfAborted']],
 ];
 const rows=entries.map(([relative,functions])=>[path.join(compiled,'src',relative),'compiled_ocr',functions]);
 rows.push([path.join(engineRoot,'quality','owned-runtime.cjs'),'quality_owner',['Object.use','use']],[path.join(engineRoot,'quality','runtime-lease.cjs'),'quality_owner',['Object.use','use','run','step']],[path.join(engineRoot,'vendor','trio','scripts','sites-local','engine.cjs'),'engine_boundary',['recognize','executeJob','Object.run','run']]);
 return new Map(rows.map(([file,origin,functions])=>[normalize(file),{file:path.basename(file),origin,functions:new Set(functions)}]));
}
function frames(stack,compiledRoot){
 const known=origins(compiledRoot),result=[],seen=new Set();
 for(const line of stack.slice(0,STACK_CHARS).split(/\r?\n/)){
  const match=/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);if(!match)continue;
  const item=known.get(normalize(match[2]));if(!item)continue;const lineNumber=Number(match[3]),column=Number(match[4]);if(lineNumber<1||lineNumber>100000||column<1||column>100000)continue;
  const inputFunction=(match[1]??'').replace(/^(?:async|new)\s+/,'');const value={origin:item.origin,file:item.file,function:item.functions.has(inputFunction)?inputFunction:'unknown',line:lineNumber,column};const key=JSON.stringify(value);if(seen.has(key))continue;seen.add(key);result.push(value);if(result.length===FRAME_LIMIT)break;
 }
 return result;
}

/** Privacy boundary: returns fixed enums, bounded digests and allowlisted static source facts only. */
function createOcrFailureDiagnostic(error,{compiledRoot}={}){
 const message=text(get(error,'message')),sample=message.slice(0,MESSAGE_CHARS),stack=text(get(error,'stack')),rawCode=get(error,'code'),rawName=get(error,'name'),errorCode=codes.has(rawCode)?rawCode:null,kind=category(errorCode,sample),truncated=message.length>MESSAGE_CHARS;
 return {version:1,boundary:'ocr_recognition',category:kind,...cause(sample,kind),errorName:names.has(rawName)?rawName:'UnknownError',errorCode,messageChars:message.length,messageBytes:truncated?null:Buffer.byteLength(sample),messageHashedBytes:Buffer.byteLength(sample),messageSha256:sha(sample),messageSha256Scope:truncated?'UTF8_PREFIX_65536_UTF16_CHARS':'FULL_UTF8',messageTruncated:truncated,stackTruncated:stack.length>STACK_CHARS,frames:frames(stack,compiledRoot)};
}
module.exports={createOcrFailureDiagnostic};
