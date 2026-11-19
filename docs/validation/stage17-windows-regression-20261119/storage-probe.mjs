import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url), ts=require('typescript');
const out=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../../',import.meta.url));
const source=fs.readFileSync(path.join(root,'tests/v2/fixtures/owned-engine-runtime.mjs'),'utf8');
const ast=ts.createSourceFile('fixture.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), matches=[];
function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='fs.writeFile'&&node.arguments[0]?.getText(ast)==='server'&&ts.isNoSubstitutionTemplateLiteral(node.arguments[1]))matches.push(node.arguments[1].text);
  ts.forEachChild(node,visit);
}
visit(ast);if(matches.length!==1)throw Error('Expected the original synthetic server literal');
const ed=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-file-probe-'),cd=fs.mkdtempSync(path.join(os.tmpdir(),'mangohana-stage17-file-probe-'));
const varySource=process.argv[2]==='source',varyEntry=process.argv[2]==='entry',varyVolume=process.argv[2]==='volume',scripts={E:path.join(ed,'synthetic-server.cjs'),C:path.join(cd,'synthetic-server.cjs')};
const varyCanonical=process.argv[2]==='canonical',varyHandle=process.argv[2]==='handle';
const freshFixture=varyCanonical||varyHandle;
if(varyCanonical){
  const stable=path.join(out,'reference-provider');fs.mkdirSync(stable,{recursive:true});
  scripts.C=path.join(stable,'synthetic-server.cjs');
}
for(const file of Object.values(scripts)){
  if(!fs.existsSync(file))fs.writeFileSync(file,matches[0],{flag:'wx'});
  if(fs.readFileSync(file,'utf8')!==matches[0])throw Error('Unexpected synthetic source bytes');
}
const runs=[];
const order=freshFixture?['E','C','C','E','C','E','E','C','E','C','C','E']:['E','C','C','E','E','C','C','E'];
for(const [index,volume] of order.entries()){
  const diaryDir=path.join(freshFixture||varyEntry||varySource||volume==='E'?ed:cd,'arm-'+index);fs.mkdirSync(diaryDir);
  let script=scripts[varySource||varyVolume?volume:'E'];
  if(freshFixture){
    const fresh=path.join(diaryDir,'synthetic-server.cjs');fs.writeFileSync(fresh,matches[0],{flag:'wx'});
    script=varyHandle||volume==='E'?fresh:scripts.C;
  }
  const tempNet=net.createServer();tempNet.listen(0,'127.0.0.1');await once(tempNet,'listening');const port=tempNet.address().port;await new Promise(done=>tempNet.close(done));
  const diary=path.join(diaryDir,'synthetic-http.jsonl'), key='synthetic-timing-fixture',events=[],before=performance.now();
  const entry=varyEntry&&volume==='C'?['--input-type=commonjs','-e',matches[0],script]:[script];
  const osTemp=freshFixture?diaryDir:varyVolume&&volume==='C'?cd:ed;
  const child=spawn(process.execPath,['--require',path.join(out,'provider-probe.cjs'),...entry,String(port),'timing-fixture'],{cwd:freshFixture||varyEntry?path.dirname(process.execPath):osTemp,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:freshFixture?path.dirname(process.execPath):process.env.PATH,TEMP:osTemp,TMP:osTemp,SYNTHETIC_DIARY:diary,LLAMA_API_KEY:key,STAGE17_MODULE_TRACE:varyEntry||varyVolume||varyCanonical?'1':'0',STAGE17_MAIN_LOOKUP:varyCanonical?'1':'0',STAGE17_LIGHT_IO:varyHandle?'1':'0',STAGE17_REUSE_DIARY_FD:varyHandle&&volume==='C'?'1':'0'}});
  const closed=once(child,'close'),requested=new Date().toISOString();let stderr='';
  child.stderr.on('data',b=>{stderr+=b.toString()});
  const deadline=performance.now()+5000;let pair=false;
  try{
    while(performance.now()<deadline&&!pair){
      try{
        const start=performance.now(),url='http://127.0.0.1:'+port+'/v1/models';
        const ok=await fetch(url,{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(1500)});
        const data=await ok.json();if(!ok.ok||data.data?.[0]?.id!=='timing-fixture')throw Error('Wrong response');
        const denied=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(1500)});await denied.text();
        if(denied.status!==401)throw Error('Incorrect rejection');
        pair=true;events.push({kind:'verified_pair',elapsedMs:performance.now()-start,at:new Date().toISOString()});
      }catch(error){events.push({kind:'request_error',error:error.cause?.code??error.name,at:new Date().toISOString()});await new Promise(r=>setTimeout(r,200));}
    }
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;}
  const saved=varyHandle&&fs.existsSync(diary)?fs.readFileSync(diary,'utf8').trim().split(/\r?\n/).map(JSON.parse):[];
  const pairSaved=varyHandle?saved.some(v=>v.pid===child.pid&&v.path==='/v1/models'&&v.authorized===true)&&saved.some(v=>v.pid===child.pid&&v.path==='/v1/models'&&v.authorized===false):undefined;
  if(varyHandle&&pair&&!pairSaved)throw Error('Original authorization and rejection journal required');
  runs.push({index,volume:varyEntry||varyHandle?'E':volume,journal:varyHandle?(volume==='C'?'open-handle':'path'):undefined,pairSaved,entryType:varyEntry&&volume==='C'?'inline':'file',requested,elapsedMs:Math.round(performance.now()-before),pair,events,
    worker:stderr.trim().split(/\r?\n/).filter(l=>l.startsWith('{')).map(l=>JSON.parse(l))});
}
fs.writeFileSync(path.join(out,varyHandle?'handle-probe.json':varyCanonical?'canonical-probe.json':varyVolume?'volume-probe.json':varyEntry?'entry-probe.json':varySource?'source-probe.json':'storage-probe.json'),JSON.stringify({varySource,varyEntry,varyVolume,varyCanonical,varyHandle,fixtureSha256:createHash('sha256').update(matches[0]).digest('hex'),ed,cd,runs},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(runs.map(r=>({volume:r.volume,pair:r.pair,elapsedMs:r.elapsedMs,diaryMs:r.worker.filter(w=>w.phase==='diary_end').map(w=>Math.round(w.elapsedMs))}))));
