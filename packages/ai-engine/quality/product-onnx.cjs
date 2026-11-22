'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {fingerprintFiles, key} = require('./recovery-checkpoint.cjs');
const {pagePromptData, resolveTerms, assertDraftPredicates} = require('./translation-contract.cjs');
const {assessKoreanOutput} = require('./korean-output.cjs');
const {rectangle} = require('./source-line-roi.cjs');
const {collectProcess, secretlessEnvironment, assertActive} = require('../vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const source = path.resolve(__dirname, '../../../scripts/v2/local_review');
const bridge = path.join(source, 'product_onnx.py');
const spec = require('../../../scripts/v2/local_review/context-model.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function requireStage(value,code) {
  if (!value) throw Object.assign(Error('로컬 ONNX 단계의 파일 또는 실행 기록을 확인해 주세요.'),{code});
}

function productOnnx(config) {
  if (config.onnxModelsRoot === undefined) return null;
  requireStage(typeof config.onnxModelsRoot==='string' && path.isAbsolute(config.onnxModelsRoot),'CONFIG_PATH');
  const hasOcr = config.onnxOcr ?? true;
  const hasTranslation = config.onnxTranslation ?? true;
  requireStage(typeof hasOcr === 'boolean' && typeof hasTranslation === 'boolean' && (hasOcr || hasTranslation), 'CONFIG_PATH');
  const textTileLimit = config.onnxTextTileLimit ?? 0;
  requireStage(Number.isSafeInteger(textTileLimit) && textTileLimit >= 0 && textTileLimit <= 16, 'CONFIG_PATH');
  const root=path.resolve(config.onnxModelsRoot), pack=path.dirname(path.dirname(config.python));
  const qwen=path.join(root,'MangohanaV2-semantic/qwen3-4b-instruct-onnx-41a4dd4d');
  const vision=path.join(root,'MangohanaV2-vision');
  const assets={
    ocr:[path.join(vision,'ogkalu-16e8a622/detector-v4-s_int8.onnx'),path.join(vision,'rapidocr-v4-5e7ff7a3/ch_PP-OCRv4_det_infer.onnx'),
      ...['resource-manifest.json','sidecar/trio_ocr_sidecar.py','recognizer/tokenizer/vocab.json','recognizer/onnx/vision_fp16.onnx',
        'recognizer/onnx/decoder_prefill_int8.onnx','recognizer/onnx/decoder_step_int8.onnx'].map(file=>path.join(pack,file))],
    translation:spec.files.map(([name])=>path.join(qwen,name))
  };
  const scripts={ocr:['ocr.py','pages.py','text_detector.py','../vision/region_detector.py'],translation:['context_translation.py','context-model.json','quality.py']};
  async function preflight(){
    const required = [bridge, config.python, ...(hasOcr ? assets.ocr : []), ...(hasTranslation ? assets.translation : [])];
    await Promise.all(required.map(async file=>requireStage((await fs.stat(file)).isFile(),'RESOURCE_MISSING')));
    if (hasTranslation) {
      for(const [name,size] of spec.files) requireStage((await fs.stat(path.join(qwen,name))).size===size,'RESOURCE_MISSING');
      requireStage((await fs.stat(path.join(qwen,'tokenizer-deps','tokenizers','__init__.py'))).isFile(),'RESOURCE_MISSING');
    }
  }
  async function configuration(stage,engineFile) {
    const files=[engineFile,config.python,bridge,...scripts[stage].map(s=>path.join(source,s)),...assets[stage]];
    if(stage==='translation') files.push(path.join(qwen,'tokenizer-deps','tokenizers'));
    return key({stage,provider:'onnx-cpu',files:await fingerprintFiles(files),root,...(stage==='ocr'?{textTileLimit}:{})});
  }
  async function execute(stage,request,owner,signal,temp,onDispatch){
    assertActive(signal);
    const body=Buffer.from(JSON.stringify(stage==='ocr'&&textTileLimit?{...request,textTileLimit}:request),'utf8'),requestSha256=hash(body);
    const process=owner.spawn(config.python,['-I','-B','-X','utf8',bridge,stage,root],{
      cwd:path.dirname(config.python),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],
      env:{...secretlessEnvironment(config.python,temp),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',ORT_DISABLE_TELEMETRY:'1'}
    });
    const stop=()=>{void owner.terminate(process,true).catch(()=>{});};
    const collect=collectProcess(process,{stdoutLimit:8*1024*1024,onOverflow:stop});
    signal.addEventListener('abort',stop,{once:true});
    try {
      onDispatch?.();
      process.child.stdin.on('error',()=>{}); // Child close/exit and its bound reply decide the outcome.
      process.child.stdin.end(body);
      let bytes;
      try { bytes=await collect(); } catch(error) {
        if(stage==='translate') throw Object.assign(Error('번역 요청의 결과가 도착하지 않았습니다.'),{code:'RESULT_UNKNOWN'});
        throw error;
      }
      assertActive(signal);
      let reply;try {reply=JSON.parse(bytes.toString('utf8'));} catch {}
      requireStage(reply?.provider==='onnx-cpu' && reply.stage===stage && reply.requestSha256===requestSha256 && reply.data,
        stage==='translate'?'RESULT_UNKNOWN':'OCR_INCOMPLETE');
      return {data:reply.data,requestSha256};
    } finally {signal.removeEventListener('abort',stop);if(!process.closed)await owner.terminate(process,true);}
  }
  return {hasOcr,hasTranslation,preflight,configuration,execute};
}

function extractionFromOnnx(data,{jobId,pageNumber,sourceSha256,width,height}) {
  requireStage(!(data.failure==='OCR_UNAVAILABLE'&&data.inferenceStarted===false),'OCR_UNAVAILABLE');
  requireStage(data.page===jobId && data.sourceSha256===sourceSha256 && data.width===width && data.height===height &&
    Array.isArray(data.lines) && Array.isArray(data.detections) && Array.isArray(data.uncoveredBubbles),'OCR_INCOMPLETE');
  requireStage(data.lines.length>0 && !data.uncoveredBubbles.length && !data.independentSearch?.unsearchedPixelBoxes?.length,'OCR_REVIEW_REQUIRED');
  const speechBubbles=data.lines.map((row,index)=>{
    requireStage(['text_bubble','text_free'].includes(row.kind) && typeof row.source==='string' && row.source.trim(),'OCR_REVIEW_REQUIRED');
    requireStage(row.bbox && ['x','y','width','height'].every(k=>Number.isFinite(row.bbox[k])),'OCR_INCOMPLETE');
    return {id:row.id,text:row.source,type:'speech_bubble',language:'ja',bbox:row.bbox,polygon:rectangle(row.bbox),
      confidence:row.confidence,readingOrder:index+1,inventoryLineIds:[row.id],
      ...(Number.isSafeInteger(row.panelOrder)&&row.panelOrder>0?{panelOrder:row.panelOrder}:{}),notes:'',speakerCandidates:[]};
  });
  // The product selector uses the same detected boxes for translate/preserve/review.
  // Tile duplicates were already removed by OCR; presenting them again would create ambiguous owners.
  const ids=new Set(data.lines.map(row=>row.id));
  const regions=data.detections.filter(r=>ids.has(r.id));
  return {extraction:{pageNumber,speechBubbles,nonSpeechText:[],warnings:[]},
    detection:{version:1,imageSha256:sourceSha256,width,height,executionProvider:'CPUExecutionProvider',regions,models:data.models}};
}

function translationRequest(input,lines) {
  return {lines:lines.map(line=>({id:line.id,source:line.sourceText})),context:pagePromptData(input,{compact:true})};
}

function onnxTranslationTargets(groups) {
  return groups.map(group => ({ id: group.id, order: group.readingOrder, sourceText: group.text,
    sourceLanguage: group.language, sourceLineIds: group.inventoryLineIds }));
}

function onnxFlagsAllowed(row, input) {
  if (!Array.isArray(row?.flags) || row.flags.some(flag => flag !== 'JAPANESE_REMAINS' && flag !== 'NO_HANGUL')) return false;
  if (!row.flags.length) return true;
  // Provider warnings stay in the reply. Authorization comes from the bound input.
  const region = input?.regions.find(region => region.id === row.id && region.sourceText === row.source);
  if (!region) return false;
  const { terms } = resolveTerms(input, region);
  const compliance = assessKoreanOutput({ sourceText: region.sourceText, translatedText: row.ko, terms });
  return compliance.status === 'PASS' && compliance.exceptions.length > 0;
}

function translatedPage(reply,lines,inspect,ledger,translationInput) {
  const {data,requestSha256}=reply, generation=data.generation;
  requireStage(!(data.failure==='TRANSLATION_INPUT_LIMIT'&&data.inferenceStarted===false),'TRANSLATION_INPUT_LIMIT');
  requireStage(!(data.failure==='TRANSLATION_PROVIDER_UNAVAILABLE'&&data.inferenceStarted===false),'TRANSLATION_PROVIDER_UNAVAILABLE');
  requireStage(data.revision===spec.revision && generation?.eos===true &&
    [generation.inputTokens,generation.generatedTokens].every(n=>Number.isSafeInteger(n)&&n>0) &&
    Array.isArray(data.lines) && data.lines.length===lines.length,'PAGE_TRANSLATION_INVALID');
  const pending=[],records=[];
  requireStage(data.lines.every((row, i) => row?.id === lines[i].id && row.source === lines[i].sourceText &&
    typeof row.ko === 'string' && row.ko.trim()), 'PAGE_TRANSLATION_INVALID');
  assertDraftPredicates(data.lines.map(row => ({ id: row.id, sourceText: row.source, translatedText: row.ko })),
    { requestSha256, responseSha256: ledger.responseSha256 });
  for (const [index,line] of lines.entries()) {
    const row=data.lines[index];
    requireStage(onnxFlagsAllowed(row, translationInput), 'PAGE_TRANSLATION_INVALID');
    const qaReport=inspect({sourceText:line.sourceText,translatedText:row.ko,dialogueType:line.dialogueType});
    requireStage(!qaReport.issues.some(i=>i.type==='NUMBER_MISMATCH'&&i.severity==='error'),'TRANSLATION_NUMBER_MISMATCH');
    pending.push({id:line.id,sourceText:line.sourceText,proposedSource:line.sourceText,translatedText:row.ko,rawTranslatedText:row.rawKo,qaReport});
    records.push({id:line.id,engine:'local_ai',requestId:ledger.requestId,requestScope:'page',usedExactTm:false,qaReport,
      requestedContextFingerprint:requestSha256,returnedContextFingerprint:requestSha256,responseIdentity:'validated_page_json_ids',
      rawTranslatedText:row.rawKo,normalizations:row.normalizations,modelHttpRequests:0,durationMs:ledger.durationMs});
  }
  return {pending,records,request:{...ledger,scope:'page',transport:'onnx-cpu',providerRevision:spec.revision,
    contextFingerprint:requestSha256,usedImageContext:false,imageSha256:null,regionIds:lines.map(l=>l.id),
    httpRequests:0,localGenerations:1,usage:{prompt_tokens:generation.inputTokens,completion_tokens:generation.generatedTokens,
      total_tokens:generation.inputTokens+generation.generatedTokens}}};
}
module.exports={productOnnx,extractionFromOnnx,onnxTranslationTargets,translationRequest,onnxFlagsAllowed,translatedPage,revision:spec.revision};
