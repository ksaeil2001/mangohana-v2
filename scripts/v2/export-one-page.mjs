import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {stripTypeScriptTypes} from 'node:module';
import {reportToStudioResult} from '../../apps/engine/result.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=(code,message)=>Object.assign(new Error(message),{code});
const requireValue=(condition,code,message)=>{if(!condition)throw failure(code,message);};
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'};
const evidenceCode='EXPORT_EVIDENCE_INVALID';

export async function readBytes(file,maximum,code=evidenceCode){
 let info,bytes;
 try{
  info=await fs.lstat(file);
  requireValue(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=maximum,code,'검증 파일의 형식과 크기를 확인해 주세요.');
  bytes=await fs.readFile(file);
 }catch(error){if(error.code===code)throw error;throw failure(code,'필요한 검증 파일을 읽지 못했습니다: '+path.basename(file));}
 requireValue(bytes.length===info.size,code,'읽는 동안 검증 파일이 변경됐습니다.');
 return bytes;
}
export async function readJson(file,maximum=16*1024*1024){
 const bytes=await readBytes(file,maximum);
 try{return {bytes,value:JSON.parse(bytes.toString('utf8'))};}catch{throw failure(evidenceCode,'검증 JSON을 확인해 주세요: '+path.basename(file));}
}
function sourceMime(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 throw failure('EXPORT_SOURCE_MISMATCH','검증 원본의 이미지 형식을 확인하지 못했습니다.');
}
async function existingMatches(file,bytes){
 let info;
 try{info=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return false;throw error;}
 requireValue(info.isFile()&&!info.isSymbolicLink()&&info.size===bytes.length,'EXPORT_CONFLICT','기존 산출물은 덮어쓰지 않습니다: '+path.basename(file));
 requireValue((await fs.readFile(file)).equals(bytes),'EXPORT_CONFLICT','기존 산출물의 내용이 다릅니다: '+path.basename(file));
 return true;
}
async function writeSameOrCreate(file,bytes){
 if(await existingMatches(file,bytes))return;
 try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;await existingMatches(file,bytes);}
}
async function loadSites(){
 const generated=path.join(root,'apps/sites/.sites-runtime','source-export-verification-'+randomUUID());
 await fs.mkdir(generated,{recursive:true});
 const sourceHashes={};
 for(const name of ['studio-local-translation','studio-model','studio-files']){
  const source=await fs.readFile(path.join(root,'apps/sites/lib',name+'.ts'),'utf8');
  sourceHashes['apps/sites/lib/'+name+'.ts']=sha(Buffer.from(source));
  await fs.writeFile(path.join(generated,name+'.mjs'),stripTypeScriptTypes(source).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'),{flag:'wx'});
 }
 const result={model:await import(pathToFileURL(path.join(generated,'studio-model.mjs')).href),files:await import(pathToFileURL(path.join(generated,'studio-files.mjs')).href),sourceHashes};
 for(const [name,digest]of Object.entries(sourceHashes))requireValue(sha(await fs.readFile(path.join(root,name)))===digest,'EXPORT_SOURCE_CHANGED','Sites 내보내기 코드가 실행 중 변경됐습니다.');return result;
}

/** Shared source-only evidence adapter; callers bind this job to their own immutable run manifest. */
export async function verifyJobEvidence({jobId,jobDirectory,sourcePath,sourceSha256,resultPath,regions,expectedReportSha256}){
 requireValue(samePath(await fs.realpath(jobDirectory),jobDirectory),evidenceCode,'다른 위치를 가리키는 작업 폴더는 사용하지 않습니다.');
 const {value:state}=await readJson(path.join(jobDirectory,'state.json'));
 const {bytes:storedReportBytes,value:storedReport}=await readJson(path.join(jobDirectory,'report.json'));
 const {value:report}=await readJson(path.join(jobDirectory,'engine-report.json'));
 requireValue(state.version===1&&state.id===jobId&&state.status==='completed'&&state.reportSha256===sha(storedReportBytes)&&isDeepStrictEqual(report,storedReport)&&(expectedReportSha256===undefined||expectedReportSha256===state.reportSha256),evidenceCode,'작업 완료 상태와 실행 보고서가 일치하지 않습니다.');
 if(state.contextSha256!==undefined){
  const {bytes,value:context}=await readJson(path.join(jobDirectory,'translation-context.json'),1024*1024),receipt=report.translationContext;
  const dispatchNumber=Object.hasOwn(state,'contextPageNumber')?state.contextPageNumber:context.pageNumber===null?null:state.pageNumber??null;
  requireValue(/^[0-9a-f]{64}$/.test(state.contextSha256)&&sha(bytes)===state.contextSha256&&context.version===1&&context.owner===state.owner&&context.projectId===state.projectId&&context.sourceSha256===state.sourceSha256&&context.pageNumber===dispatchNumber&&receipt?.snapshotSha256===state.contextSha256&&receipt.glossaryRevision===context.glossaryRevision&&typeof receipt.consumed==='boolean',evidenceCode,'실행 보고서와 저장한 번역 문맥이 일치하지 않습니다.');
  if(receipt.consumed)requireValue(Array.isArray(report.translationRequests)&&report.translationRequests.length>0&&report.translationRequests.every(request=>request.scope==='page'&&request.contextSnapshotSha256===state.contextSha256),evidenceCode,'문맥을 사용한 페이지 요청의 증거가 없습니다.');
 }
 requireValue(report.jobId===jobId&&report.originalPreserved===true&&report.image?.originalMime===state.mime&&report.image.width===state.width&&report.image.height===state.height&&Object.hasOwn(extensions,state.mime),evidenceCode,'원본과 작업에 대응하는 보고서가 필요합니다.');
 requireValue(Number.isFinite(Date.parse(state.createdAt))&&Number.isFinite(Date.parse(state.updatedAt)),evidenceCode,'작업의 생성·완료 시각을 확인해 주세요.');
 requireValue(typeof sourcePath==='string'&&path.isAbsolute(sourcePath),'EXPORT_SOURCE_MISMATCH','원본 입력 경로를 확인해 주세요.');
 const original=await readBytes(sourcePath,8*1024*1024,'EXPORT_SOURCE_MISMATCH');
 const preserved=await readBytes(path.join(jobDirectory,'source'+extensions[state.mime]),8*1024*1024,'EXPORT_SOURCE_MISMATCH');
 const sourceHash=sha(original);
 requireValue(sourceHash===sourceSha256&&sourceHash===state.sourceSha256&&sourceHash===report.hashes?.original&&sourceHash===sha(preserved)&&sourceMime(original)===report.image.originalMime,'EXPORT_SOURCE_MISMATCH','원본 파일과 완료 기록의 해시·형식이 다릅니다.');
 const assets={};
 for(const [kind,name]of [['normalized','normalized.png'],['cleaned','cleaned.png'],['candidate','candidate.png'],['mask','removal-mask.png']]){
  const bytes=await readBytes(path.join(jobDirectory,name),32*1024*1024);
  requireValue(sha(bytes)===report.hashes?.[kind]&&bytes.length>=24&&sourceMime(bytes)==='image/png'&&bytes.readUInt32BE(16)===report.image.width&&bytes.readUInt32BE(20)===report.image.height,evidenceCode,'보고서와 결과 PNG의 해시·크기가 다릅니다.');
  assets[kind]=bytes;
 }
 let derived;
 try{derived=reportToStudioResult(report,{cleanedPng:assets.cleaned,candidatePng:assets.candidate});}catch{throw failure(evidenceCode,'OCR·번역·식자·글꼴 증거를 확인하지 못했습니다.');}
 const {value:result}=await readJson(resultPath,128*1024*1024);
 requireValue(isDeepStrictEqual(result,derived)&&regions===derived.blocks.length,'EXPORT_RESULT_MISMATCH','저장된 대사·이미지가 완료된 엔진 결과와 다릅니다.');
 return {state,report,reportBytes:storedReportBytes,original,assets,result,sourceHash};
}

/** Execute the exact current Sites render/import/re-export path without writing artifacts yet. */
export async function prepareSourceExport({verified,evidence,inputPath,outputDirectory,projectName='일본어 한 장 실제 검증',pageId=evidence.jobId,projectId=evidence.jobId}){
 const {state,report,original,result}=verified;
 const {model,files,sourceHashes}=await loadSites();
 const blocks=model.validateBlocks(result.blocks);
 const page={id:pageId,name:path.basename(inputPath),image:'data:'+report.image.originalMime+';base64,'+original.toString('base64'),
  cleanImage:result.clean_image,finalImage:result.final_image,finalImageSignature:model.blockVisualSignature(blocks),
  width:report.image.width,height:report.image.height,blocks,status:'review',reviewed:false,processed:true};
 requireValue(model.canUseFinalImage(page),evidenceCode,'검증된 최종 PNG와 편집 기준이 필요합니다.');
 const exported=Buffer.from(await(await files.renderPage(page)).arrayBuffer()),digest=sha(exported);
 requireValue(digest===report.hashes.candidate,'EXPORT_RESULT_MISMATCH','Sites 내보내기 PNG가 엔진 결과와 다릅니다.');
 const backup={format:'trio-studio-v1',project:{...model.emptyProject(projectName),id:projectId,createdAt:state.createdAt,updatedAt:state.updatedAt,pages:[page]}};
 const backupBytes=Buffer.from(JSON.stringify(backup));
 const imported=model.validateProject(JSON.parse(backupBytes.toString('utf8')).project);
 requireValue(imported.pages.length===1&&model.canUseFinalImage(imported.pages[0]),'EXPORT_RESULT_MISMATCH','TRIO 재가져오기 결과를 확인하지 못했습니다.');
 const restored=Buffer.from(await(await files.renderPage(imported.pages[0])).arrayBuffer());
 requireValue(restored.equals(exported),'EXPORT_RESULT_MISMATCH','TRIO 재가져오기 뒤 내보내기 PNG가 다릅니다.');
 const complete={...evidence,sourceExportVerified:true,projectImportVerified:true,exportSha256:digest,importedExportSha256:sha(restored),exportBytes:exported.length,
  width:report.image.width,height:report.image.height,measurements:report.measurements,sourceExportCodeHashes:sourceHashes,output:path.join(outputDirectory,'exported.png')};
 const outputs=[['exported.png',exported],['project.trio',backupBytes],['verification.json',Buffer.from(JSON.stringify(complete,null,2))]];
 return {complete,outputs};
}
export async function writeSourceExport(directory,outputs){
 // Check all existing files before creating any new output; never replace prior evidence.
 for(const [name,bytes]of outputs)await existingMatches(path.join(directory,name),bytes);
 for(const [name,bytes]of outputs)await writeSameOrCreate(path.join(directory,name),bytes);
}

/** Legacy public API and output paths are preserved. This never starts an engine. */
export async function exportOnePage(directory){
 requireValue(typeof directory==='string'&&path.isAbsolute(directory),evidenceCode,'검증 실행 폴더의 절대 경로가 필요합니다.');
 const runRoot=path.resolve(directory);requireValue(runRoot!==path.parse(runRoot).root,evidenceCode,'검증 실행 폴더를 확인해 주세요.');
 const {value:evidence}=await readJson(path.join(runRoot,'verification-engine.json')),{value:input}=await readJson(path.join(runRoot,'input.json'));
 requireValue(evidence.status==='completed'&&evidence.originalPreserved===true&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(evidence.jobId),evidenceCode,'완료된 엔진 검증 기록이 필요합니다.');
 const jobDirectory=path.join(runRoot,'jobs',evidence.jobId);requireValue(typeof evidence.jobDirectory==='string'&&samePath(path.resolve(evidence.jobDirectory),jobDirectory),evidenceCode,'작업 폴더가 이 검증 실행에 속하지 않습니다.');
 const verified=await verifyJobEvidence({jobId:evidence.jobId,jobDirectory,sourcePath:input.path,sourceSha256:evidence.sourceSha256,resultPath:path.join(runRoot,'studio-result.json'),regions:evidence.regions});
 const prepared=await prepareSourceExport({verified,evidence,inputPath:input.path,outputDirectory:runRoot});await writeSourceExport(runRoot,prepared.outputs);return prepared.complete;
}

if(process.argv[1]&&samePath(path.resolve(process.argv[1]),fileURLToPath(import.meta.url))){
 try{
  const args=process.argv.slice(2);
  requireValue(args.length===2&&args[0]==='--resume','EXPORT_USAGE','사용법: node scripts/v2/export-one-page.mjs --resume <검증 실행 폴더>');
  console.log(JSON.stringify(await exportOnePage(path.resolve(args[1]))));
 }catch(error){console.error(JSON.stringify({status:'failed',code:error.code??'EXPORT_FAILED',message:error.message}));process.exitCode=1;}
}
