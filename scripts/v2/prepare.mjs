import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { buildEngine, engineRoot } from '../../packages/ai-engine/build.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const configuration=JSON.parse(await fs.readFile(path.join(root,'scripts/v2/resources.json'),'utf8'));
const runRoot='E:/Dev/Outputs/MangohanaV2-20261111';
const resource=id=>{const item=configuration.resources.find(item=>item.id===id);if(!item)throw new Error('고정 리소스가 없습니다.');return {...item,path:path.resolve(configuration.roots[item.root],item.fileName)};};
async function hash(file){const result=createHash('sha256');for await(const chunk of createReadStream(file))result.update(chunk);return result.digest('hex');}
async function verify(item){const info=await fs.stat(item.path);if(info.size!==item.bytes||await hash(item.path)!==item.sha256)throw new Error(`${item.id} 리소스의 무결성이 맞지 않습니다. resources.mjs를 먼저 실행하세요.`);}
async function atomicJson(file,value){const temporary=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2),{flag:'wx'});await fs.rename(temporary,file);}

async function extractRuntime(archives,destination){
  const marker=path.join(destination,'runtime-files.json');
  try {
    const saved=JSON.parse(await fs.readFile(marker,'utf8'));
    if(saved.archives.join('|')!==archives.map(item=>item.sha256).join('|'))throw new Error('실행기 출처가 다릅니다.');
    for(const file of saved.files){const target=path.resolve(destination,file.path);if(!target.startsWith(path.resolve(destination)+path.sep)||await hash(target)!==file.sha256)throw new Error('기존 실행기의 파일이 달라졌습니다.');}
    return;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.mkdir(destination,{recursive:false});
  const {default:yauzl}=await import(pathToFileURL(path.join(engineRoot,'node_modules/yauzl/index.js')).href);
  const files=[];
  for(const archive of archives){
    await new Promise((resolve,reject)=>{
      yauzl.open(archive.path,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
        if(error)return reject(error);
        let total=0;
        zip.on('error',reject);zip.on('end',resolve);
        zip.on('entry',entry=>{void(async()=>{
          const mode=(entry.externalFileAttributes>>>16)&0o170000;
          const target=path.resolve(destination,entry.fileName);
          if(mode===0o120000||entry.isEncrypted()||entry.fileName.includes('\\')||!target.startsWith(path.resolve(destination)+path.sep)||entry.uncompressedSize>1024*1024*1024)throw new Error('안전하지 않은 실행기 ZIP입니다.');
          total+=entry.uncompressedSize;if(total>2*1024*1024*1024)throw new Error('실행기 압축 해제 한도를 넘었습니다.');
          if(entry.fileName.endsWith('/'))await fs.mkdir(target,{recursive:true});
          else{
            await fs.mkdir(path.dirname(target),{recursive:true});
            const stream=await new Promise((done,fail)=>zip.openReadStream(entry,(e,s)=>e?fail(e):done(s)));
            const temporary=target+'.'+randomUUID()+'.partial';
            await pipeline(stream,createWriteStream(temporary,{flags:'wx'}));
            const fileHash=await hash(temporary);
            try{await fs.access(target);if(await hash(target)!==fileHash)throw new Error('실행기 ZIP의 파일 이름이 충돌합니다.');await fs.unlink(temporary);}
            catch(error){if(error.code==='ENOENT')await fs.rename(temporary,target);else throw error;}
            if(!files.some(file=>file.path===entry.fileName))files.push({path:entry.fileName,sha256:fileHash});
          }
          zip.readEntry();
        })().catch(error=>{zip.close();reject(error);});});
        zip.readEntry();
      });
    });
  }
  await fs.writeFile(marker,JSON.stringify({archives:archives.map(item=>item.sha256),files},null,2),{flag:'wx'});
}

await fs.mkdir(runRoot,{recursive:true});
console.log('엔진 TypeScript와 Canvas를 빌드합니다.');
const built=await buildEngine();
try { await fs.access(path.join(engineRoot,'node_modules/electron/dist/electron.exe')); }
catch { throw new Error('Electron 실행 파일이 없습니다. packages/ai-engine에서 node node_modules/electron/install.js로 공식 런타임을 설치한 뒤 다시 준비하세요.'); }
for(const id of ['gemma-e2b','lama-fp32','ocr-pack','ocr-manifest','ocr-signature','llama-cuda12','cudart12'])await verify(resource(id));
const runtimeRoot='E:/Dev/Models/Runtimes/llama-b10621-cuda12.4-v2';
await fs.mkdir(path.dirname(runtimeRoot),{recursive:true});
await extractRuntime([resource('llama-cuda12'),resource('cudart12')],runtimeRoot);
const installedLocalAppData='E:/Dev/Models/Managed';
const storeRoot=path.join(installedLocalAppData,'Trio/resources/pipeline-resources');
const lock=JSON.parse(await fs.readFile(path.join(built.resourcesPath,'pipeline-resources/pipeline-resource-lock.json'),'utf8'));
const publisherAllowlist=JSON.parse(await fs.readFile(path.join(built.resourcesPath,'pipeline-resources/ocr-publisher-allowlist.json'),'utf8'));
const installer=await import(pathToFileURL(path.join(built.buildRoot,'src/main/resourcePackInstaller.js')).href);
console.log('기존 installer의 서명·publisher pin·파일 검증으로 OCR 팩을 준비합니다.');
const installed=await installer.installResourcePack({resourceStoreRoot:storeRoot,lock,resourceId:'trio-production-ocr-win32-x64',transactionId:randomUUID(),publisherAllowlist});
const config={...built,runRoot,profileRoot:path.join(runRoot,'profile'),dataRoot:path.join(runRoot,'jobs'),installedLocalAppData,
  llamaServer:path.join(runtimeRoot,'llama-server.exe'),gemmaModel:resource('gemma-e2b').path,modelAlias:'gemma4-e2b-local',
  python:path.join(installed.absolutePath,'runtime/python.exe'),lamaWorker:path.join(built.repository,'resources/managed-inpainting/lama_onnx.py'),
  lamaModel:resource('lama-fp32').path,lamaTileWrapper:path.join(built.repository,'scripts/local-preview/lama_worker.py'),
  port:45911,siteOrigin:'http://127.0.0.1:5173'};
for(const key of ['llamaServer','gemmaModel','python','lamaWorker','lamaModel','lamaTileWrapper','rendererBundle'])if(!(await fs.stat(config[key])).isFile())throw new Error(`${key} 파일이 없습니다.`);
await atomicJson(path.join(runRoot,'engine-config.json'),config);
await atomicJson(path.join(runRoot,'preparation.json'),{preparedAt:new Date().toISOString(),engineCompiled:true,ocrSignatureAndFilesVerified:true,ocrResourceRoot:installed.absolutePath,lamaExecutionProvider:'CPUExecutionProvider',realInferenceRun:false,paidApiCalls:0});
console.log(JSON.stringify({prepared:true,config:path.join(runRoot,'engine-config.json'),realInferenceRun:false}));
