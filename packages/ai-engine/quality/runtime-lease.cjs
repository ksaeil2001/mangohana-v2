'use strict';

function leaseError(code,message,cause){
 const error=new Error(message,cause===undefined?undefined:{cause});
 error.name='RuntimeLeaseError';error.code=code;return error;
}
function cancellation(message){const error=new Error(message);error.name='AbortError';return error;}

/**
 * A single-borrower ownership boundary, independent of process/model implementations.
 * create must either transfer a complete value or finish its own partial cleanup before rejecting.
 * A factory unable to confirm that cleanup must reject with error.cleanupUncertain=true.
 * destroy fulfillment confirms release; false, rejection, or an unsettled deadline is uncertain.
 * validate must return true to certify health. Its exceptions mean unhealthy, never healthy.
 */
function createRuntimeLeasePool({create,validate,destroy,cleanupMs=6000}={}){
 if(typeof create!=='function'||typeof validate!=='function'||typeof destroy!=='function')throw new TypeError('create, validate and destroy callbacks are required');
 if(!Number.isFinite(cleanupMs)||cleanupMs<=0||cleanupMs>2147483647)throw new TypeError('cleanupMs must be a positive bounded duration');
 let active,resident,blockedError,closedRequested=false,closePromise,pendingCount=0;
 const records=new Set(),leases=new Set();

 function block(cause){
  if(!blockedError)blockedError=leaseError('RUNTIME_LEASE_BLOCKED','Runtime release or pending work could not be confirmed; create a new pool after owner recovery',cause);
  return blockedError;
 }
 function status(){
  return Object.freeze({
   state:blockedError?'blocked':closedRequested?(active||pendingCount?'closing':'closed'):active?'busy':resident?'ready':'idle',
   active:!!active,phase:active?.phase||null,identity:active?.identity??resident?.identity??null,
   retained:!!resident,owned:records.size,pending:pendingCount,blocked:!!blockedError,closed:closedRequested,
  });
 }
 // Every callback outcome is observed, including those settling after a caller's cleanup deadline.
 function track(lease,promise){
  const outcome=Promise.resolve(promise).then(value=>({ok:true,value}),error=>({ok:false,error}));
  lease.work.add(outcome);pendingCount++;
  outcome.then(()=>{lease.work.delete(outcome);pendingCount--;});return outcome;
 }
 function destroyRecord(lease,record){
  if(record.destroyPromise)return record.destroyPromise;
  lease.cleanupStartedAt??=Date.now();
  record.destroyPromise=track(lease,Promise.resolve().then(()=>destroy(record.value)).then(result=>{
   if(result===false)throw new Error('destroy returned unconfirmed release');
   record.released=true;records.delete(record);
  }).catch(error=>{throw block(error);}));
  return record.destroyPromise;
 }
 function makeLease(identity,signal){
  const lease={identity,phase:'creating',work:new Set(),controller:new AbortController(),cancelled:false};
  lease.cancelPromise=new Promise(resolve=>{lease.cancelledResolve=resolve;});
  lease.finished=new Promise(resolve=>{lease.finish=resolve;});
  lease.cancel=reason=>{
   if(lease.cancelled)return;
   lease.cancelled=true;lease.cancelReason=reason??cancellation('Runtime use aborted');
   lease.cleanupStartedAt??=Date.now();lease.controller.abort(lease.cancelReason);lease.cancelledResolve();
   if(lease.record)destroyRecord(lease,lease.record);
  };
  if(signal){const abort=()=>lease.cancel(signal.reason);signal.addEventListener('abort',abort,{once:true});lease.unsubscribe=()=>signal.removeEventListener('abort',abort);if(signal.aborted)abort();}
  leases.add(lease);return lease;
 }
 function checkStopped(lease){
  if(lease.cancelled)throw lease.cancelReason;
  if(blockedError)throw blockedError;
 }
 async function step(lease,outcome){
  const result=await Promise.race([outcome,lease.cancelPromise.then(()=>({cancelled:true}))]);
  checkStopped(lease);
  if(!result.ok)throw result.error;return result.value;
 }
 function boundedCleanup(lease,promise){
  lease.cleanupStartedAt??=Date.now();
  const remaining=Math.max(0,cleanupMs-(Date.now()-lease.cleanupStartedAt));
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(block(new Error('cleanup or late callback drain deadline exceeded'))),remaining);
   promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
 }
 function cleanup(lease){
  if(lease.cleanupPromise)return lease.cleanupPromise;
  lease.phase='cleaning';lease.cleanupStartedAt??=Date.now();
  if(lease.record)destroyRecord(lease,lease.record);
  const drain=(async()=>{
   // A late create adds its destroy outcome before its own tracked outcome settles.
   while(lease.work.size)await Promise.all([...lease.work]);
   if(lease.record&&!lease.record.released)throw block(new Error('runtime release remained unconfirmed'));
   if(blockedError)throw blockedError;
  })();
  lease.cleanupDrain=drain;
  drain.then(()=>leases.delete(lease),()=>leases.delete(lease));
  lease.cleanupPromise=boundedCleanup(lease,drain);return lease.cleanupPromise;
 }
 async function disposeForReplacement(lease){
  lease.phase='cleaning';
  await boundedCleanup(lease,destroyRecord(lease,lease.record).then(outcome=>{if(!outcome.ok)throw outcome.error;}));
  lease.record=undefined;lease.cleanupStartedAt=undefined;checkStopped(lease);
 }
 async function healthy(lease,record){
  lease.phase='validating';
  try{return await step(lease,track(lease,Promise.resolve().then(()=>validate(record.value))))===true;}
  catch(error){checkStopped(lease);return false;}
 }
 function beginCreate(lease){
  lease.phase='creating';
  return track(lease,Promise.resolve().then(()=>{
   checkStopped(lease);return create({identity:lease.identity,signal:lease.controller.signal});
  }).then(value=>{
   const record={identity:lease.identity,value,released:false};records.add(record);lease.record=record;
   if(lease.cancelled||closedRequested||blockedError)destroyRecord(lease,record);
   return record;
  }).catch(error=>{if(error?.cleanupUncertain===true)throw block(error);throw error;}));
 }
 async function run(lease,operation){
  try{
   checkStopped(lease);
   if(resident){
    lease.record=resident;resident=undefined;
    if(lease.record.identity!==lease.identity||!await healthy(lease,lease.record))await disposeForReplacement(lease);
   }
   if(!lease.record){
    await step(lease,beginCreate(lease));
    if(!await healthy(lease,lease.record))throw leaseError('RUNTIME_LEASE_UNHEALTHY','Factory returned an unhealthy runtime');
   }
   checkStopped(lease);lease.phase='using';
   const result=await step(lease,track(lease,Promise.resolve().then(()=>{checkStopped(lease);return operation(lease.record.value);})));
   if(!await healthy(lease,lease.record))await disposeForReplacement(lease);
   checkStopped(lease);
   if(lease.record){resident=lease.record;lease.record=undefined;}
   return result;
  }catch(error){
   const original=lease.cancelled?lease.cancelReason:error;
   await cleanup(lease);throw original;
  }finally{
   lease.unsubscribe?.();if(active===lease)active=undefined;
   if(!lease.cleanupDrain)leases.delete(lease);lease.finish();
  }
 }
 function use({identity,signal}={},operation){
  if(blockedError)return Promise.reject(blockedError);
  if(closedRequested)return Promise.reject(leaseError('RUNTIME_LEASE_CLOSED','Runtime lease pool is closed'));
  if(active)return Promise.reject(leaseError('RUNTIME_LEASE_BUSY','A runtime lease is already active'));
  if(typeof identity!=='string'||!identity.length||typeof operation!=='function')return Promise.reject(new TypeError('A stable nonempty identity and operation callback are required'));
  if(signal&&(!(signal instanceof AbortSignal)))return Promise.reject(new TypeError('signal must be an AbortSignal'));
  if(signal?.aborted)return Promise.reject(signal.reason??cancellation('Runtime use aborted'));
  const lease=makeLease(identity,signal);active=lease;return run(lease,operation);
 }
 function close(){
  if(closePromise)return closePromise;
  closedRequested=true;const current=active;current?.cancel(cancellation('Runtime lease pool is closing'));
  closePromise=(async()=>{
   if(current)await current.finished;
   if(resident){
    const lease=makeLease(resident.identity);lease.record=resident;resident=undefined;
    try{await cleanup(lease);}finally{lease.finish();}
   }
   if(blockedError)throw blockedError;
   return status();
  })();
  return closePromise;
 }
 return Object.freeze({use,close,status});
}

module.exports={createRuntimeLeasePool};
