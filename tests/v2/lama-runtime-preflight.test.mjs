import test from 'node:test';import assert from 'node:assert/strict';
let api={};try{api=await import('../../apps/engine/lama-runtime-preflight.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('LaMa readiness imports its existing runtime dependencies without constructing a model session',async()=>{
 assert.equal(typeof api.probeLamaRuntime,'function','missing LaMa dependency preflight');let calls=0;
 const result=await api.probeLamaRuntime({python:process.execPath},{executeFile:async(exe,args,options)=>{calls++;assert.equal(exe,process.execPath);assert.deepEqual(args.slice(0,3),['-I','-B','-c']);assert.ok(!options.env.OPENAI_API_KEY);assert.ok(!args[3].includes('InferenceSession('));return {stdout:JSON.stringify({python:'3.11.9',onnxruntime:'1.23.2',numpy:'2.2.6',pillow:'11.2.1',providers:['CPUExecutionProvider']})};}});
 assert.equal(calls,1);assert.equal(result.status,'AVAILABLE_IMPORT_ONLY');assert.equal(result.modelLoaded,false);assert.equal(result.inferenceCalled,false);
});
for(const [name,invoke]of [['missing dependency',async()=>{throw Error('import failed');}],['no CPU provider',async()=>({stdout:JSON.stringify({python:'3.11.9',onnxruntime:'1.23',numpy:'2.2',pillow:'11.2',providers:[]})})],['invalid response',async()=>({stdout:'not json'})]])test('LaMa preflight blocks '+name,async()=>{assert.equal(typeof api.probeLamaRuntime,'function');await assert.rejects(api.probeLamaRuntime({python:process.execPath},{executeFile:invoke}),{code:'LAMA_RUNTIME_UNAVAILABLE'});});
