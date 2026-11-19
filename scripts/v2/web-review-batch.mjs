import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';
import review from '../../packages/ai-engine/quality/page-review-state.cjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const contract='mangohana-web-review-v1';
const mime={'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
async function optional(file){
  try{return await fs.readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;return null;}
}
async function atomic(file,data){
  const temp=file+'.'+randomUUID()+'.tmp',handle=await fs.open(temp,'wx',0o600);
  try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,file);
}
const safeId=value=>/^[a-zA-Z0-9_-]{1,100}$/.test(value)?'a-'+value:'u-'+sha(value);
async function sources(rows,root) {
  const result=[],ids=new Set(),positions=new Set(),files=new Set();
  for(const item of rows){
    if(Object.keys(item).sort().join(',')!=='id,index,source,work'||![item.work,item.id].every(s=>typeof s==='string'&&/^[\p{L}\p{N}_-]{1,80}$/u.test(s))||
      !Number.isSafeInteger(item.index)||item.index<1||item.index>100000||typeof item.source!=='string'||path.isAbsolute(item.source)||/^[A-Za-z]:/.test(item.source)||item.source.split(/[\\/]/).includes('..'))throw Error('원본 목록의 ID·순번·경로가 잘못되었습니다.');
    const file=await fs.realpath(path.join(root,item.source)),relative=path.relative(root,file),type=mime[path.extname(file).toLowerCase()];
    const position=JSON.stringify([item.work,item.index]),key=process.platform==='win32'?file.toLowerCase():file;
    const pageKey=JSON.stringify([item.work,item.id]);
    if(ids.has(pageKey)||positions.has(position)||files.has(key)||!type||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('원본 중복 또는 원본 폴더 밖의 파일입니다.');
    ids.add(pageKey);positions.add(position);files.add(key);
    const stat=await fs.stat(file);if(!stat.isFile()||!stat.size||stat.size>8*1024*1024)throw Error('원본 파일 크기가 허용 범위를 벗어났습니다.');
    result.push({...item,webId:safeId(item.id),file,type,name:path.basename(file),sha256:sha(await fs.readFile(file))});
  }
  if(!result.length)throw Error('원본 목록이 비어 있습니다.');
  return result;
}
async function withOutput(output,action){
  await fs.mkdir(output,{recursive:true});const real=await fs.realpath(output);
  const name='mangohana-'+sha(process.platform==='win32'?real.toLowerCase():real);
  const channel=process.platform==='win32'?'\\\\.\\pipe\\'+name:process.platform==='linux'?'\0'+name:path.join(os.tmpdir(),name+'.sock');
  const lock=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(channel,resolve);});
  try{return await action(real);}finally{await new Promise(resolve=>lock.close(resolve));}
}
export async function runWebBatch({rows,originals,output,siteOrigin,signal=new AbortController().signal,pollIntervalMs}) {
  const site=new URL(siteOrigin);
  if(!['http:','https:'].includes(site.protocol)||!['127.0.0.1','[::1]'].includes(site.hostname)||site.origin!==siteOrigin)
    throw Error('관리자 설정에서 loopback Sites 주소를 지정하세요.');
  const root=await fs.realpath(originals),inputs=await sources(rows,root);
  const {processProjectBatch}=await tsImport('../../apps/sites/lib/studio-batch-engine.ts',import.meta.url);
  return withOutput(output,async dir=>{
    const file=path.join(dir,'results.json'),sessionFile=path.join(dir,'.web-session');
    const old=await optional(file),identity=sha(JSON.stringify([site.origin,root,inputs.map(p=>[p.id,p.work,p.index,p.source,p.sha256])]));
    const state=old?JSON.parse(old):{contract,identity,total:inputs.length,ready:0,pages:inputs.map(p=>({
      page:p.id,work:p.work,index:p.index,source:p.source,webId:p.webId,sourceSha256:p.sha256,reviewState:'NOT_STARTED'}))};
    if(state.contract!==contract||state.identity!==identity||state.pages?.length!==inputs.length)throw Error('기존 출력의 실행 경로 또는 입력이 다릅니다.');
    if(!old && (await fs.readdir(dir)).length)throw Error('새 웹 실행은 빈 출력 폴더가 필요합니다.');
    const save=async()=>{state.ready=state.pages.filter(p=>p.reviewState==='CANDIDATE_READY'&&p.file).length;await atomic(file,JSON.stringify(state,null,2)+'\n');};
    if(!old)await save();
    let cookie=await optional(sessionFile);
    const isCookie=s=>/^mangohana_engine_session=[A-Za-z0-9_-]{43}$/.test(s??'');
    if(!cookie){
      if(state.pages.some(p=>p.intent||p.jobId))throw Error('기존 세션이 없어 작업 ID와 원장을 보존했습니다.');
      const resp=await fetch(site.origin+'/api/engine/health',{redirect:'error',signal});
      cookie=resp.headers.get('set-cookie')?.split(';')[0];await resp.arrayBuffer();
      if(!resp.ok||!isCookie(cookie))throw Error('Sites 엔진의 세션을 시작하지 못했습니다.');
      await fs.writeFile(sessionFile,cookie,{flag:'wx',mode:0o600});
    }
    if(!isCookie(cookie))throw Error('기존 엔진 세션이 잘못되었습니다.');
    for(const work of new Set(inputs.map(p=>p.work))){
      const group=inputs.filter(p=>p.work===work),byId=new Map(group.map(p=>[p.webId,p]));
      const ledger=new Map(state.pages.filter(p=>p.work===work).map(p=>[p.webId,p]));
      const pages=group.map(p=>({id:p.webId,name:p.name,image:'original:'+p.webId,blocks:[],enginePageNumber:p.index,
        jobId:ledger.get(p.webId).jobId,pendingBatch:ledger.get(p.webId).intent}));
      const request=async(url,init={})=>{
        if(typeof url!=='string')throw Error('잘못된 엔진 주소');
        if(url.startsWith('original:')){
          const p=byId.get(url.slice(9));if(!p)throw Error('원본 ID가 다릅니다.');
          const bytes=await fs.readFile(p.file);if(sha(bytes)!==p.sha256)throw Error('원본이 변경되었습니다.');
          return new Response(bytes,{headers:{'content-type':p.type}});
        }
        if(!url.startsWith('/api/engine/'))throw Error('현재 웹 제품 엔진에만 요청할 수 있습니다.');
        const headers=new Headers(init.headers);headers.set('cookie',cookie);headers.set('origin',site.origin);
        return fetch(site.origin+url,{...init,headers,redirect:'error'});
      };
      await processProjectBatch({id:safeId(work),pages},pages,'/api/engine','ja','ko',signal,{
        async onIntent(intent){for(const m of intent.members){const row=ledger.get(m.pageId);row.intent=intent;row.reviewState=intent.phase==='sending'?'RESULT_UNKNOWN':'NOT_STARTED';}await save();},
        async onJobs(bindings){for(const b of bindings){const row=ledger.get(b.pageId);row.jobId=b.jobId;delete row.intent;}await save();},
        async onObservation(id,job){const row=ledger.get(id);if(job.sourceSha256!==row.sourceSha256)throw Error('페이지 원본 지문이 다릅니다.');
          const outcome=job.reviewState??review.pageReviewState(job);
          row.reviewState=outcome==='CANDIDATE_READY'?'RUNNING':outcome;
          row.stage=job.stage;row.errorCode=job.errorCode??null;row.candidateSha256=job.candidateSha256??null;await save();},
        async onResult(id,result){const row=ledger.get(id),bytes=Buffer.from(result.finalImage?.split(',')[1]??'','base64');
          if(!bytes.length||sha(bytes)!==row.candidateSha256)throw Error('제품 PNG와 완료 영수증이 다릅니다.');
          const rel=path.join('pages',sha(JSON.stringify([work,id]))+'.png');await fs.mkdir(path.join(dir,'pages'),{recursive:true});
          try{await fs.writeFile(path.join(dir,rel),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||sha(await fs.readFile(path.join(dir,rel)))!==row.candidateSha256)throw e;}
          row.file=rel;row.reviewState='CANDIDATE_READY';delete row.error;await save();},
        onError(id,e,terminal){const row=ledger.get(id);row.error=e.message;if(!terminal&&row.reviewState==='RUNNING')row.reviewState='RESULT_UNKNOWN';},
        onStage(){}
      },{request,retrySaved:false,concurrency:1,pollIntervalMs});
      await save();
    }
    return state;
  });
}
