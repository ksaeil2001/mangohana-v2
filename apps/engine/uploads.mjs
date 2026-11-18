import path from 'node:path';
import {crc32} from 'node:zlib';
import yauzl from 'yauzl';
import boundaries from '../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs';

export const UPLOAD_LIMITS=Object.freeze({imageBytes:8*1024*1024,archiveBytes:80*1024*1024,totalBytes:160*1024*1024,pages:100,entries:300});
const failure=(status,code,message)=>Object.assign(new Error(message),{status,code});
const requireValue=(condition,status,code,message)=>{if(!condition)throw failure(status,code,message);};
const collator=new Intl.Collator('en',{numeric:true,sensitivity:'variant'});
const imageName=/\.(png|jpe?g|webp)$/i;
const zipSignature=bytes=>bytes.length>=4&&bytes[0]===80&&bytes[1]===75&&((bytes[2]===3&&bytes[3]===4)||(bytes[2]===5&&bytes[3]===6));

function image(bytes){
 requireValue(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=UPLOAD_LIMITS.imageBytes,413,'INPUT_LIMIT','이미지는 한 장당 8MiB까지 지원합니다.');
 try{return boundaries.imageHeader(bytes);}
 catch(error){
  const code=['ANIMATED_IMAGE','IMAGE_LIMIT'].includes(error.code)?error.code:'INVALID_IMAGE';
  throw failure(code==='IMAGE_LIMIT'?413:422,code,code==='ANIMATED_IMAGE'?'움직이는 이미지는 지원하지 않습니다.':'JPG, PNG, WebP 정지 이미지의 형식과 크기를 확인해 주세요.');
 }
}
function archivePath(name){
 requireValue(typeof name==='string'&&name.length>0&&name.length<=400&&!/[\\:\x00-\x1f\x7f]/.test(name)&&!name.startsWith('/'),422,'ZIP_PATH_INVALID','ZIP 파일의 상대 경로를 확인해 주세요.');
 const parts=name.replace(/\/$/,'').split('/');
 requireValue(parts.every(part=>part.length>0&&!['.','..'].includes(part)&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),422,'ZIP_PATH_INVALID','ZIP 안에 안전하지 않은 파일 이름이 있습니다.');
 return name.normalize('NFC');
}
const macMetadata=name=>name.split('/').some(part=>part==='__MACOSX')||path.posix.basename(name)==='.DS_Store';

async function expandArchive(bytes){
 requireValue(bytes.length>0&&bytes.length<=UPLOAD_LIMITS.archiveBytes,413,'ARCHIVE_LIMIT','ZIP은 80MiB까지 지원합니다.');
 requireValue(zipSignature(bytes),422,'ZIP_INVALID','ZIP 파일의 실제 형식을 확인해 주세요.');
 let archive;
 try{archive=await yauzl.fromBufferPromise(bytes,{lazyEntries:true,autoClose:false,validateEntrySizes:true,strictFileNames:true,decodeStrings:true});}
 catch{throw failure(422,'ZIP_INVALID','ZIP 목록을 읽지 못했습니다.');}
 const images=[],ignoredFiles=[],names=new Set();let total=0,entries=0,compressedBytes=0;
 try{
  for await(const entry of archive.eachEntry()){
   requireValue(++entries<=UPLOAD_LIMITS.entries,413,'ZIP_ENTRY_LIMIT','ZIP 목록은 최대 300개까지 지원합니다.');
   const name=archivePath(entry.fileName),folded=name.toLocaleLowerCase('en');
   requireValue(!names.has(folded),422,'ZIP_DUPLICATE_PATH','ZIP에 중복되는 파일 경로가 있습니다.');names.add(folded);
   requireValue(!entry.isEncrypted(),422,'ZIP_ENCRYPTED','암호화된 ZIP 파일은 지원하지 않습니다.');
   const mode=(entry.externalFileAttributes>>>16)&0o170000;
   requireValue(mode===0||mode===0o100000||mode===0o040000,422,'ZIP_ENTRY_UNSUPPORTED','ZIP의 링크나 특수 파일은 지원하지 않습니다.');
   requireValue(Number.isSafeInteger(entry.uncompressedSize)&&Number.isSafeInteger(entry.compressedSize)&&entry.uncompressedSize>=0&&entry.compressedSize>=0,422,'ZIP_INVALID','ZIP 파일 크기 정보가 올바르지 않습니다.');
   if(name.endsWith('/')){requireValue(entry.uncompressedSize===0,422,'ZIP_INVALID','ZIP 폴더의 크기 정보가 올바르지 않습니다.');continue;}
   requireValue(mode!==0o040000,422,'ZIP_ENTRY_UNSUPPORTED','ZIP 폴더와 파일 형식이 다릅니다.');
   requireValue(entry.uncompressedSize>0&&entry.uncompressedSize<=UPLOAD_LIMITS.imageBytes,413,'INPUT_LIMIT','ZIP 안의 파일은 한 개당 8MiB까지 지원합니다.');
   total+=entry.uncompressedSize;compressedBytes+=entry.compressedSize;
   requireValue(total<=UPLOAD_LIMITS.totalBytes,413,'BATCH_BYTE_LIMIT','ZIP 해제 총용량은 160MiB까지 지원합니다.');
   if(macMetadata(name)){ignoredFiles.push({name,reason:'macos_metadata'});continue;}
   requireValue(imageName.test(name),422,'ZIP_ENTRY_UNSUPPORTED','ZIP에는 JPG, PNG, WebP 이미지만 넣어 주세요.');
   requireValue(path.posix.basename(name).length<=180,422,'ZIP_PATH_INVALID','ZIP 안의 이미지 파일 이름이 너무 깁니다.');
   requireValue(images.length<UPLOAD_LIMITS.pages,413,'BATCH_PAGE_LIMIT','한 배치는 100페이지까지 지원합니다.');images.push({name,entry});
  }
  requireValue(images.length>0,422,'NO_IMAGES','ZIP에 지원하는 이미지가 없습니다.');
  const pages=[];
  for(const item of images){
   const stream=await archive.openReadStreamPromise(item.entry),chunks=[];let read=0,checksum=0;
   try{
    for await(const chunk of stream){read+=chunk.length;requireValue(read<=UPLOAD_LIMITS.imageBytes&&read<=item.entry.uncompressedSize,413,'INPUT_LIMIT','ZIP 파일 해제 크기가 제한을 초과했습니다.');checksum=crc32(chunk,checksum);chunks.push(chunk);}
   }finally{stream.destroy();}
   requireValue(read===item.entry.uncompressedSize&&checksum===item.entry.crc32,422,'ZIP_INTEGRITY_FAILED','ZIP 해제 파일의 크기 또는 CRC가 맞지 않습니다.');
   const data=Buffer.concat(chunks,read),header=image(data);
   pages.push({key:'zip:'+item.name,name:path.posix.basename(item.name),bytes:data,mime:header.mime,width:header.width,height:header.height,sortName:item.name});
  }
  return {pages,ignoredFiles,archiveStats:{entries,compressedBytes,uncompressedBytes:total,compressionRatio:compressedBytes?total/compressedBytes:null}};
 }catch(error){if(error.status)throw error;throw failure(422,'ZIP_INVALID','ZIP 파일의 목록이나 해제 결과를 확인하지 못했습니다.');}
 finally{archive.close();}
}

/** Expand without writing paths. Decoding is repeated by the server-owned engine before durable admission. */
export async function expandUploads(files){
 requireValue(Array.isArray(files)&&files.length>0&&files.length<=UPLOAD_LIMITS.pages,413,'BATCH_PAGE_LIMIT','한 번에 이미지 1~100장을 올려 주세요.');
 const copied=files.map(file=>{
  requireValue(file&&typeof file.name==='string'&&file.name.length>0&&file.name.length<=180&&!/[\/\\\x00-\x1f\x7f]/.test(file.name)&&Buffer.isBuffer(file.bytes),422,'INPUT_INVALID','업로드 파일의 이름과 내용을 확인해 주세요.');
  return {name:file.name,bytes:Buffer.from(file.bytes)};
 });
 const archives=copied.filter(file=>/\.zip$/i.test(file.name)||zipSignature(file.bytes));
 let result;
 if(archives.length){requireValue(copied.length===1&&archives.length===1,422,'BATCH_UPLOAD_INVALID','ZIP 한 개 또는 이미지 여러 장 중 하나로 올려 주세요.');result=await expandArchive(archives[0].bytes);}
 else{
  let total=0;
  result={pages:copied.map((file,index)=>{
   requireValue(imageName.test(file.name),422,'INPUT_INVALID','JPG, PNG, WebP 이미지를 확인해 주세요.');const header=image(file.bytes);total+=file.bytes.length;
   requireValue(total<=UPLOAD_LIMITS.totalBytes,413,'BATCH_BYTE_LIMIT','이미지 총용량은 160MiB까지 지원합니다.');return {key:'file:'+index,...file,mime:header.mime,width:header.width,height:header.height,sortName:file.name};
  }),ignoredFiles:[],archiveStats:null};
 }
 result.pages.sort((a,b)=>collator.compare(a.sortName,b.sortName)||(a.sortName<b.sortName?-1:a.sortName>b.sortName?1:0));
 return {...result,pages:result.pages.map(({sortName,...page})=>page)};
}
