// Installed-model integration check: no image and no inference request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
const resources=JSON.parse(await fs.readFile(new URL('../../scripts/v2/resources.json',import.meta.url),'utf8'));

test('the prepared LaMa path satisfies the unchanged worker name, checksum and CPU metadata contract',{timeout:90_000},async()=>{
 const item=resources.resources.find(item=>item.id==='lama-fp32');
 assert.equal(path.resolve(resources.roots[item.root],item.fileName),path.resolve(config.lamaModel));
 const code="import importlib.util,sys; spec=importlib.util.spec_from_file_location('lama_resource_check',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.install_offline_guards(); m.verify_model(sys.argv[2]); session=m.create_session(sys.argv[2]); print('LAMA_CPU_RESOURCE_VERIFIED')";
 const result=await new Promise((resolve,reject)=>{
  let output='';const child=spawn(config.python,['-I','-B','-c',code,config.lamaWorker,config.lamaModel],{windowsHide:true,cwd:path.dirname(config.python),stdio:['ignore','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(config.python)}});
  const timer=setTimeout(()=>child.kill('SIGKILL'),80_000);
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{if(output.length<65536)output+=data;});
  child.once('error',reject);child.once('close',exit=>{clearTimeout(timer);resolve({exit,output});});
 });
 assert.equal(result.exit,0,result.output);assert.match(result.output,/LAMA_CPU_RESOURCE_VERIFIED/);
});
