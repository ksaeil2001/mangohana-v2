import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const out=fileURLToPath(new URL('./minimal-host.json',import.meta.url));
const tmp=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-minimal-host-');
const system=process.env.SystemRoot, ps=path.join(system,'System32/WindowsPowerShell/v1.0/powershell.exe');
const env={SystemRoot:system,WINDIR:system,PATH:path.dirname(process.execPath),TEMP:tmp,TMP:tmp};
const source=`const entry=Date.now(),http=require('node:http');
http.createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/v1/models'){res.writeHead(404);return res.end();}
  if(req.headers.authorization!=='Bearer '+process.env.LLAMA_API_KEY){res.writeHead(401);return res.end('{}');}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({data:[{id:'minimal-local-fixture'}],entry,pid:process.pid}));
}).listen(Number(process.argv[1]),'127.0.0.1');`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const nodeRuns=[],shellRuns=[];
for(let i=0;i<20;i++){
  const lease=net.createServer();lease.listen(0,'127.0.0.1');await once(lease,'listening');
  const port=lease.address().port;await new Promise(done=>lease.close(done));
  const key=randomBytes(24).toString('hex');
  const launched=new Date().toISOString(),child=spawn(process.execPath,['-e',source,String(port)],{
    cwd:path.dirname(process.execPath),env:{...env,LLAMA_API_KEY:key},windowsHide:true,stdio:'ignore',
  });
  const closed=once(child,'close'),started=performance.now(),requests=[];
  let pair=false,entry=null;
  try{
    while(performance.now()-started<5000&&!pair){
      const begin=new Date().toISOString();
      try{
        const url='http://127.0.0.1:'+port+'/v1/models';
        const ok=await fetch(url,{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(1500)});
        const data=await ok.json();if(ok.status!==200||data.data?.[0]?.id!=='minimal-local-fixture'||data.pid!==child.pid)throw Error('model response mismatch');
        entry=data.entry;
        const denied=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(1500)});await denied.text();
        if(denied.status!==401)throw Error('missing unauthorized rejection');
        pair=true;requests.push({begin,complete:new Date().toISOString(),verified:true});
      }catch(error){
        requests.push({begin,complete:new Date().toISOString(),error:error.cause?.code??error.name});
        await new Promise(done=>setTimeout(done,200));
      }
    }
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  const elapsed=performance.now()-started,[code,signal]=await closed;
  nodeRuns.push({index:i,launched,pid:child.pid,entry,elapsedMs:elapsed,pair,requests,closed:new Date().toISOString(),code,signal});
  if(i%4===0){
    const requested=new Date().toISOString(),t=performance.now();
    const run=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Console]::Out.WriteLine([DateTime]::UtcNow.ToString('o'))"],{
      env,cwd:path.dirname(process.execPath),windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:4096,
    });
    shellRuns.push({requested,elapsedMs:performance.now()-t,firstStatementUtc:run.stdout?.trim()||null,code:run.status,signal:run.signal,error:run.error?.code});
  }
}
const result={scope:'Independent OS process and loopback control. No application modules or fixture filesystem operations in the Node child.',
  tmp,node:process.version,executableSha256:hash(fs.readFileSync(process.execPath)),inlineSourceSha256:hash(source),
  verifiedPairs:nodeRuns.filter(r=>r.pair).length,nodeRuns,shellRuns};
fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pairs:result.verifiedPairs,total:nodeRuns.length,powerShellMs:shellRuns.map(r=>Math.round(r.elapsedMs))}));
