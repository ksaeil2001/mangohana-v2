const light=process.env.STAGE17_LIGHT_IO==='1';
const dc=require('node:diagnostics_channel'),fs=require('node:fs'),net=light?null:require('node:net');
const localFile=process.env.STAGE17_LOCAL_PHASE_FILE;
let localHandle;
if(localFile){
  const path=require('node:path');
  if(path.dirname(localFile)!==path.join(__dirname,'provider-local')||!/^child-\d+\.jsonl$/.test(path.basename(localFile)))throw Error('Expected a test-owned local witness');
  localHandle=fs.openSync(localFile,'wx');
}
const emit=(phase,info={})=>{
  const line=JSON.stringify({phase,utc:new Date().toISOString(),...info});
  if(localHandle!==undefined)fs.writeSync(localHandle,line+'\n');
  else if(light)process._rawDebug(line);else process.stderr.write(line+'\n');
};
emit('node_entry');
if(process.env.STAGE17_MODULE_TRACE==='1'){
  const Module=require('node:module'),load=Module._load,compile=Module.prototype._compile;
  Module._load=function(id,...args){
    const observe=typeof id==='string'&&(id.endsWith('synthetic-server.cjs')||['node:http','node:fs','node:path'].includes(id));
    if(observe)emit('module_load_start',{id:id.endsWith('synthetic-server.cjs')?'fixture':id});
    try{return load.call(this,id,...args)}finally{if(observe)emit('module_load_end',{id:id.endsWith('synthetic-server.cjs')?'fixture':id})}
  };
  Module.prototype._compile=function(code,file,...args){
    if(file.endsWith('synthetic-server.cjs'))emit('source_compilation');
    return compile.call(this,code,file,...args);
  };
}
if(process.env.STAGE17_MAIN_LOOKUP==='1'){
  const Module=require('node:module'),find=Module._findPath,real=fs.realpathSync;
  Module._findPath=function(file,...args){
    if(typeof file!=='string'||!file.endsWith('synthetic-server.cjs'))return find.call(this,file,...args);
    const t=performance.now();emit('main_lookup_start');try{return find.call(this,file,...args)}
    finally{emit('main_lookup_end',{elapsedMs:performance.now()-t})}
  };
  const wrapped=function(file,...args){
    if(typeof file!=='string'||!file.endsWith('synthetic-server.cjs'))return real.call(this,file,...args);
    const t=performance.now();emit('main_realpath_start');try{return real.call(this,file,...args)}
    finally{emit('main_realpath_end',{elapsedMs:performance.now()-t})}
  };
  wrapped.native=real.native;fs.realpathSync=wrapped;
}
if(net){
  const listen=net.Server.prototype.listen;
  net.Server.prototype.listen=function(...args){emit('listen_called');this.once('listening',()=>emit('listening'));return listen.apply(this,args);};
}
dc.channel('http.server.request.start').subscribe(()=>emit('server_request_start'));
dc.channel('http.server.response.finish').subscribe(()=>emit('response_finished'));
const append=fs.appendFileSync;
let diaryHandle;
fs.appendFileSync=function(file,...args){if(file!==process.env.SYNTHETIC_DIARY)return append.call(this,file,...args);
  const at=performance.now();emit('diary_begin');
  try{
    if(process.env.STAGE17_REUSE_DIARY_FD!=='1')return append.call(this,file,...args);
    if(diaryHandle===undefined)diaryHandle=fs.openSync(file,'a');
    return append.call(this,diaryHandle,...args);
  }finally{emit('diary_end',{elapsedMs:performance.now()-at})}
};
const exists=fs.existsSync;
fs.existsSync=function(file){if(typeof file!=='string'||!file.endsWith('wrong-model'))return exists.call(this,file);
  const at=performance.now();emit('model_lookup_begin');try{return exists.call(this,file)}finally{emit('model_lookup_end',{elapsedMs:performance.now()-at})}
};
if(process.env.STAGE17_MAIN_LOOKUP==='1')emit('preloader_ready');
