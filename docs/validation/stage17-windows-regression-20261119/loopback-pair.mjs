import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const output=fileURLToPath(new URL('./loopback-pair.json',import.meta.url));
const tmp=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-memory-http-');
const system=process.env.SystemRoot;
const server=`const entry=Date.now(),events=[];let listening;
require('node:http').createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/v1/models'){res.writeHead(404);return res.end();}
  const id=req.headers['x-probe'],row={id,received:Date.now()};events.push(row);
  res.on('finish',()=>{row.finished=Date.now()});
  if(req.headers.authorization!=='Bearer '+process.env.LLAMA_API_KEY){res.writeHead(401);res.end('{}');}
  else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'minimal-local-fixture'}]}));}
  row.returned=Date.now();
}).listen(Number(process.argv[1]),'127.0.0.1',()=>{listening=Date.now();});
process.on('message',m=>{if(m==='measurement')process.send({entry,listening,events});});`;
async function request(kind, url, headers) {
  const signal=AbortSignal.timeout(1500);
  if(kind==='fetch'){
    const response=await fetch(url,{headers,signal,redirect:'error'});
    return {status:response.status,body:await response.text()};
  }
  return new Promise((resolve,reject)=>{
    const req=http.get(url,{headers,signal,agent:false},res=>{
      let body='';res.setEncoding('utf8');res.on('data',b=>{body+=b;});
      res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body}));
    });
    req.on('error',reject);
  });
}
async function check(kind,url,key){
  const started=performance.now(),calls=[];
  async function get(auth){
    const id=kind+'-'+(calls.length+1),row={id,auth,sent:Date.now()};calls.push(row);
    try{
      const r=await request(kind,url,{'x-probe':id,...(auth?{Authorization:'Bearer '+key}:{})});
      row.status=r.status;row.done=Date.now();
      return auth?r.status===200&&JSON.parse(r.body).data?.[0]?.id==='minimal-local-fixture':r.status===401;
    }catch(error){row.error=error.cause?.code??error.code??error.name;row.done=Date.now();return false;}
  }
  while(performance.now()-started<5000){
    if(await get(true)&&await get(false))return {pair:true,elapsedMs:performance.now()-started,calls};
    await new Promise(done=>setTimeout(done,200));
  }
  return {pair:false,elapsedMs:performance.now()-started,calls};
}
const rows=[];
for(let i=0;i<12;i++){
  const lease=net.createServer();lease.listen(0,'127.0.0.1');await once(lease,'listening');
  const port=lease.address().port;await new Promise(done=>lease.close(done));
  const key=randomBytes(24).toString('hex'),started=Date.now();
  const child=spawn(process.execPath,['-e',server,String(port)],{cwd:path.dirname(process.execPath),windowsHide:true,
    stdio:['ignore','ignore','ignore','ipc'],env:{SystemRoot:system,WINDIR:system,PATH:path.dirname(process.execPath),TEMP:tmp,TMP:tmp,LLAMA_API_KEY:key}});
  const closed=once(child,'close'),url='http://127.0.0.1:'+port+'/v1/models';
  const [fetchClient,httpClient]=await Promise.all([check('fetch',url,key),check('http',url,key)]);
  const witness=await new Promise(resolve=>{
    const timer=setTimeout(()=>resolve(null),1000);
    child.once('message',msg=>{clearTimeout(timer);resolve(msg);});
    child.send('measurement',err=>{if(err){clearTimeout(timer);resolve(null);}});
  });
  child.kill('SIGKILL');await closed;
  rows.push({index:i,pid:child.pid,started,fetch:fetchClient,http:httpClient,witness});
}
const result={scope:'Paired diagnostic only, independent memory-only loopback server with per-request timing and no application modules',rows};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({servers:rows.length,fetch:rows.filter(r=>r.fetch.pair).length,http:rows.filter(r=>r.http.pair).length,
  withWitnesses:rows.filter(r=>r.witness).length}));
