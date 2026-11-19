// Collect lifecycle facts only from the five named test processes. Native event listeners are left in place.
const fs=require('node:fs'),path=require('node:path'),dc=require('node:diagnostics_channel');
const testFile=path.basename(process.argv[1]||'');
const selected=new Set(['engine-ocr-refinement','engine-runtime-reuse','imported-font-bootstrap','typesetting-only-native','warm-electron-entry'].map(n=>n+'.test.mjs'));
if(selected.has(testFile)&&process.env.NODE_TEST_CONTEXT&&process.env.STAGE17_TEST_TRACE){
  const {beforeEach,afterEach}=require('node:test'),events=[];
  let current=null,seq=0;
  const record=(event,data={})=>events.push({utc:new Date().toISOString(),monoMs:performance.now(),event,test:current,...data});
  record('test_process_start',{pid:process.pid,source:testFile});
  beforeEach(t=>{current=t.name;record('test_start')});
  afterEach(()=>record('test_body_finished'));
  const probes=new WeakMap();
  let nextProbe=0;
  dc.channel('undici:request:create').subscribe(({request})=>{
    if(request?.path!=='/v1/models'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(request.origin)))return;
    const probe=++nextProbe;
    probes.set(request,{probe,test:current});
    record('models_request',{probe,origin:String(request.origin)});
  });
  for(const [event,channel] of [['models_headers','undici:request:headers'],['models_complete','undici:request:trailers'],['models_error','undici:request:error']]){
    dc.channel(channel).subscribe(({request,response,error})=>{
      const known=probes.get(request);
      if(known)record(event,{...known,status:response?.statusCode,code:error?.code??error?.name});
    });
  }
  const channel=dc.tracingChannel('child_process.spawn');
  channel.start.subscribe(({process:child,options})=>{
    const serial=++seq,args=options.args||[],exe=path.basename(options.file||'').toLowerCase();
    const role=args.some(x=>String(x).endsWith('warm-job.ps1'))?'job_supervisor':exe==='node.exe'?args.some(x=>String(x).endsWith('.cjs')||String(x).endsWith('.mjs'))?'node_fixture_script':'node_fixture_inline':exe;
    const provider=args.find(p=>typeof p==='string'&&path.basename(p)==='synthetic-server.cjs');
    const fixtureLeaf=provider&&path.dirname(path.dirname(provider))===process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR?path.basename(path.dirname(provider)):undefined;
    const idx=args.indexOf('-ControlRoot'),folder=idx>=0?args[idx+1]:null;
    const control=folder&&/^E:[\\/]Dev[\\/]Outputs[\\/]MangohanaV2-20261111[\\/]tests[\\/]/i.test(folder)?folder:null;
    const test=current;
    record('spawn_requested',{serial,role,control,test});
    child.once('spawn',()=>{
      record('spawn_returned',{serial,role,pid:child.pid,test,fixtureLeaf});
      if(role!=='job_supervisor')return;
      let pending='';
      child.stdout?.on('data',bytes=>{
        pending+=bytes.toString('utf8');let at;
        while((at=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,at).trimEnd();pending=pending.slice(at+1);
          if(!line.startsWith('MANGOHANA_WARM_JOB_V1 '))continue;
          try{const e=JSON.parse(line.slice('MANGOHANA_WARM_JOB_V1 '.length));
            record('supervisor_'+e.phase,{serial,test,runId:e.runId,rootPid:e.rootPid,creation:e.rootCreationTime100ns,
              rootExitCode:e.rootExitCode,clean:e.kernelCleanupConfirmed,reason:e.reason,failure:e.failure,nativeElapsedMs:e.elapsedMs});
          }catch{}
        }
        if(pending.length>262144)pending='';
      });
    });
    child.once('exit',(code,signal)=>record('process_exit',{serial,role,pid:child.pid,test,code,signal}));
    child.once('close',(code,signal)=>record('pipes_closed',{serial,role,pid:child.pid,test,code,signal}));
  });
  process.on('exit',code=>{
    record('test_process_exit',{code});
    fs.writeFileSync(path.join(process.env.STAGE17_TEST_TRACE,testFile+'.'+process.pid+'.json'),JSON.stringify(events)+'\n',{flag:'wx'});
  });
}
