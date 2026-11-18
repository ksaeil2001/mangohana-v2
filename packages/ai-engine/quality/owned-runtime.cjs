'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {createRuntimeLeasePool}=require('./runtime-lease.cjs');
const fail=(code,message)=>Object.assign(new Error(message),{code});

function runtimeReuseFlags(config={}){
 for(const key of ['reuseOcrRuntime','reuseTranslationServer'])if(config[key]!==undefined&&typeof config[key]!=='boolean')throw fail('CONFIG_PATH','런타임 재사용 옵션은 boolean이어야 합니다.');
 return Object.freeze({ocr:config.reuseOcrRuntime===true,translation:config.reuseTranslationServer===true});
}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])]));
 return value;
}
function runtimeCacheIdentity({kind,ownerScope,projectId,configuration={}}){
 if(!['ocr','translation'].includes(kind))throw fail('CONFIG_PATH','런타임 종류가 올바르지 않습니다.');
 if(typeof ownerScope!=='string'||!/^[0-9a-f]{64}$/.test(ownerScope)||typeof projectId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(projectId))return null;
 return createHash('sha256').update(JSON.stringify(canonical({kind,ownerScope,projectId,configuration}))).digest('hex');
}
function alive(record){return !record.closed&&!record.error&&record.child?.exitCode===null&&record.child?.signalCode===null&&!record.child.killed;}
const liveRecords=owner=>[...owner.children.values()].filter(alive);
const capturedAlive=value=>value.records.length>0&&value.records.every(record=>value.owner.children.get(record.child)===record&&alive(record));

/** Owns one separate engine owner; job owners and request context never become retained cache values. */
function createOwnedRuntimeCache({kind,createOwner,create,prepare,validate,destroy,cleanupMs=6000}){
 if(!['ocr','translation'].includes(kind)||typeof createOwner!=='function'||typeof create!=='function'||typeof destroy!=='function')throw new TypeError('Owned runtime kind and callbacks are required');
 let borrow,busy=false,generation=0;
 async function release(value){
  const failures=[];
  if(value.runtime!==undefined)try{if(await destroy(value.runtime)===false)failures.push(new Error('service release unconfirmed'));}catch(error){failures.push(error);}
  try{if(await value.owner?.cleanup()===false)failures.push(new Error('owner release unconfirmed'));}catch(error){failures.push(error);}
  if(failures.length)throw fail('CLEANUP_FAILED','독립 런타임의 실제 종료를 확인하지 못했습니다.');
 }
 const pool=createRuntimeLeasePool({cleanupMs,
  create:async({signal})=>{
   const context=borrow,owner=createOwner(),value={owner,runtime:undefined,eligible:context.eligible,cacheKey:context.cacheKey,generation:++generation,completed:false,records:[],denied:false};
   value.policy={allowSpawn:true,onSpawnDenied:()=>{value.denied=true;}};
   try{
    value.runtime=await owner.run(()=>create({owner,signal,context}),undefined,signal,value.policy);
    signal.throwIfAborted();
    if(prepare)await owner.run(()=>prepare(value.runtime,{owner,signal,context}),undefined,signal,value.policy);
    signal.throwIfAborted();return value;
   }catch(error){
    try{await release(value);}catch{const uncertain=fail('CLEANUP_FAILED','생성 중인 독립 런타임의 종료를 확인하지 못했습니다.');uncertain.cleanupUncertain=true;throw uncertain;}
    throw error;
   }
  },
  validate:async value=>{
   if(value.denied||value.completed&&(!value.eligible||!capturedAlive(value)))return false;
   return validate?await validate(value.runtime,{owner:value.owner,context:borrow})===true:true;
  },
  destroy:release,
 });
 async function use(context,operation){
  if(busy)throw fail('RUNTIME_LEASE_BUSY','독립 런타임이 이미 사용 중입니다.');
  const cacheKey=runtimeCacheIdentity({...context,kind}),eligible=cacheKey!==null;
  busy=true;borrow={...context,cacheKey,eligible};
  try{return await pool.use({identity:cacheKey??'isolated:'+randomUUID(),signal:context.signal},async value=>{
   const warm=value.completed;
   await context.runtimeEvent?.(kind+'_runtime_cache',{mode:eligible?(warm?'warm':'cold'):'ineligible',generation:value.generation,identity:cacheKey,pool:pool.status()});
   let result;
   try{result=await value.owner.run(()=>operation(value.runtime,{owner:value.owner,policy:value.policy,warm}),undefined,context.signal,value.policy);}
   catch(error){if(value.denied)throw fail('PROCESS_RESTART_REQUIRED','보유 OCR/번역 런타임의 재시작은 다음 명시 작업에서 검증합니다.');throw error;}
   if(value.denied||warm&&!capturedAlive(value))throw fail('PROCESS_RESTART_REQUIRED','보유한 런타임 자식이 종료되어 현재 작업을 중단했습니다.');
   if(!warm){value.records=liveRecords(value.owner);value.completed=true;value.policy.allowSpawn=false;}
   await context.runtimeEvent?.(kind+'_runtime_cache_complete',{mode:warm?'warm':'cold',generation:value.generation,capturedChildren:value.records.length,eligible,identity:cacheKey,pool:pool.status()});
   return result;
  });}catch(error){
   try{await context.runtimeEvent?.(kind+'_runtime_cache_failed',{code:/^[A-Z_]{1,80}$/.test(error?.code??'')?error.code:'RUNTIME_FAILED',pool:pool.status()});}catch{/* Preserve the original runtime failure if its evidence sink also failed. */}
   throw error;
  }finally{borrow=undefined;busy=false;}
 }
 return Object.freeze({use,close:()=>pool.close(),status:()=>pool.status()});
}
module.exports={runtimeReuseFlags,runtimeCacheIdentity,createOwnedRuntimeCache};
