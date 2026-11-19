import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async file => JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));

async function saveBound(file, data) {
  const value=JSON.stringify(data,null,2)+'\n';
  try { await fs.writeFile(file,value,{encoding:'utf8',flag:'wx'}); }
  catch (error) {
    if(error.code!=='EEXIST' || await fs.readFile(file,'utf8')!==value) throw error;
  }
}

async function hash(file) {
  const h=createHash('sha256');
  for await(const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function worker(python, name, args, tmp) {
  const env={SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,PATH:path.dirname(python),TEMP:tmp,TMP:tmp,
    HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',ORT_DISABLE_TELEMETRY:'1',OMP_WAIT_POLICY:'PASSIVE'};
  const script=path.join(repo,'scripts','v2','local_review',name+'.py');
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-X','utf8','-B',script,...args],{cwd:repo,env,windowsHide:true,stdio:'inherit'});
    child.once('error',reject);child.once('exit',resolve);
  });
  if(code!==0) throw Error('로컬 '+name+' 단계가 완료되지 않았습니다.');
}

async function main() {
  const {values:v}=parseArgs({options:Object.fromEntries(
    ['input','manifest','originals','output','config','models','backend'].map(k=>[k,{type:'string'}]))});
  if(Boolean(v.input)===Boolean(v.manifest) || Boolean(v.originals)!==Boolean(v.manifest))
    throw Error('원본 이미지 --input <파일> 또는 --manifest <원본목록> --originals <원본폴더>를 지정하세요.');
  const defaultRoot='E:/Dev/Outputs/MangohanaV2-20261111';
  const output=path.resolve(v.output??path.join(defaultRoot,'local-page-'+randomUUID()));
  const models=path.resolve(v.models??'E:/Dev/Models');
  const config=await readJson(v.config??path.join(defaultRoot,'engine-config.json'));
  const originals=await fs.realpath(v.input?path.dirname(path.resolve(v.input)):v.originals);
  const pages=v.input?[{id:'local-001',work:'local',index:1,source:path.basename(v.input)}]:await readJson(v.manifest);
  const legacyManifest=await fs.stat(path.join(output,'source-only.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const backend=v.backend??(v.models||legacyManifest?'legacy-onnx':'web');
  if(backend==='web'){
    const {runWebBatch}=await import('./web-review-batch.mjs');
    const state=await runWebBatch({rows:pages,originals,output,siteOrigin:config.siteOrigin});
    console.log(JSON.stringify({output,total:state.total,ready:state.ready,backend}));
    if(state.ready!==state.total)process.exitCode=2;
    return;
  }
  if(backend!=='legacy-onnx')throw Error('지원하는 실행 경로는 web 또는 legacy-onnx입니다.');
  if(typeof config.python!=='string'||!path.isAbsolute(config.python)) throw Error('기존 엔진의 로컬 Python 경로가 필요합니다.');
  const pack=path.dirname(path.dirname(config.python));
  const vision=path.join(models,'MangohanaV2-vision');
  const pageModel=path.join(models,'MangohanaV2-semantic','qwen3-4b-instruct-onnx-41a4dd4d');
  const detector=path.join(vision,'ogkalu-16e8a622','detector-v4-s_int8.onnx');
  const textDetector=path.join(vision,'rapidocr-v4-5e7ff7a3','ch_PP-OCRv4_det_infer.onnx');
  const mask=path.join(vision,'text-mask-onnx-20261110T203802715Z','comic-text-mask-unet-resnet18-384.onnx');
  for(const file of [config.python,detector,textDetector,mask,path.join(pageModel,'onnx','model_q4.onnx')]) await fs.access(file);
  const tmp=path.join(output,'tmp');
  await fs.mkdir(tmp,{recursive:true});
  const manifest=path.join(output,'source-only.json');
  await saveBound(path.join(output,'source-root.json'),{originals});
  await saveBound(manifest,pages);
  const common=['--manifest',manifest,'--output',output];
  await worker(config.python,'ocr',[...common,'--originals',originals,'--detector',detector,'--text-detector',textDetector,'--pack',pack],tmp);
  await worker(config.python,'translate',[...common,'--model',pageModel],tmp);
  await worker(config.python,'render',[...common,'--mask',mask],tmp);
  const receipts=[];
  for(const item of pages) {
    const dir=path.join(output,'pages',item.id);
    const {result:render}=await readJson(path.join(dir,'render.json'));
    const {result:mt}=await readJson(path.join(dir,'translation.json'));
    const status=render.qualityStatus;
    const expectedFile=status==='READY_FOR_REVIEW'?'review.png':'diagnostic.png';
    if(render.page!==item.id || mt.page!==item.id || render.outputFile!==expectedFile ||
       !['READY_FOR_REVIEW','NEEDS_ENGINE_WORK','PARTIAL_TYPESETTING'].includes(status))
      throw Error('페이지 실행 기록이 일치하지 않습니다.');
    const file=path.join(dir,render.outputFile);
    if(await hash(file)!==render.sha256) throw Error('식자 결과의 파일 지문이 다릅니다.');
    receipts.push({page:item.id,model:mt.model,batches:mt.batchCount,status:render.qualityStatus,
      file:path.relative(output,file),sha256:render.sha256,humanReview:'NOT_REVIEWED'});
  }
  const ready=receipts.filter(r=>r.status==='READY_FOR_REVIEW').length;
  await saveBound(path.join(output,'results.json'),{pages:receipts,ready,total:receipts.length});
  console.log(JSON.stringify({output,ready,total:receipts.length,needsWork:receipts.length-ready}));
  if(ready<receipts.length) process.exitCode=2;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
