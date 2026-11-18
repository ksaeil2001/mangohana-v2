// Integration check against the installed pinned native CLI. No inference request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
const require=createRequire(import.meta.url);
const {llamaArguments}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/translation-launch.cjs');
const config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));

test('the pinned llama runtime starts with authenticated production arguments', {timeout:105_000}, async()=>{
  const port=await new Promise((resolve,reject)=>{
    const server=createServer();server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});
  });
  const secret=randomBytes(32).toString('base64url');let output='',closed=false,exitCode;
  const started=performance.now();
  const child=spawn(config.llamaServer,llamaArguments(config,port),{
    cwd:path.dirname(config.llamaServer),windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(config.llamaServer),LLAMA_API_KEY:secret},
  });
  const done=new Promise(resolve=>{child.once('error',()=>{});child.once('close',code=>{closed=true;exitCode=code;resolve();});});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(output.length<1024*1024)output+=chunk;});
  try{
    const expires=Date.now()+90_000;let ready=false;
    while(Date.now()<expires&&!closed){
      try{
        const response=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(1000)});
        if(response.ok){
          const models=await response.json();assert.ok(models.data.some(model=>model.id===(config.modelAlias??'gemma4-e2b-local')));
          const unauthorized=await fetch(`http://127.0.0.1:${port}/v1/models`,{signal:AbortSignal.timeout(1000)});
          assert.ok([401,403].includes(unauthorized.status),'requests without the ephemeral key must be rejected');
          ready=true;break;
        }
      }catch(error){if(error.code==='ERR_ASSERTION')throw error;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.equal(ready,true,`runtime not ready; exit=${exitCode}; `+output.replaceAll(secret,'[redacted]').slice(-3000));
    console.log(JSON.stringify({runtimeStartMs:Math.round(performance.now()-started),authenticationVerified:true,inferenceRequests:0}));
  }finally{if(!closed)child.kill('SIGKILL');await done;}
});
