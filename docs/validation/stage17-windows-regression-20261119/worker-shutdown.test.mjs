import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const source=readFileSync(new URL('../../../scripts/v2/typesetting-only-worker.cjs',import.meta.url),'utf8');

async function runWorker(fail){
  const events=[],syntheticProcess={argv:['electron','worker','fixture']};
  const input={config:{profileRoot:'profile'},permit:{permitId:'test',executionGeneration:'example',executionMode:'TYPESETTING_ONLY'}};
  let latest;
  const modules={
    electron:{app:{commandLine:{appendSwitch(){}},setPath(){},on(){},async whenReady(){},
      quit(){events.push('orderly_quit')},exit(code){events.push('exit_'+code)}},protocol:{registerSchemesAsPrivileged(){}}},
    'node:fs':{readFileSync:()=>JSON.stringify(input),mkdirSync(){}},
    'node:fs/promises':{async writeFile(name){events.push(path.basename(name))}},
    'node:path':path,'node:crypto':{createHash,randomUUID},
    '../../packages/ai-engine/quality/typesetting-only-boundaries.cjs':{installTypesettingBoundaries:()=>({})},
    '../../packages/ai-engine/quality/typesetting-only-native.cjs':{createNativeTypesettingPorts:async()=>({})},
    '../../packages/ai-engine/quality/typesetting-only-pipeline.cjs':{executeTypesettingOnlyPipeline:async()=>{
      if(fail)throw Object.assign(Error('expected rejection'),{code:'UNAPPROVED'});
      return {pngBytes:Buffer.from('owned fixture'),cleanupConfirmed:true,report:{}};
    }},
    '../../packages/ai-engine/quality/imported-image-diagnostics.cjs':{
      async publishGateJson(_p,value){latest=value},async readGateJson(){return {...latest,allowed:true}},
      async writeWorkerFailure(){events.push('failure.json');if(fail==='journal')throw Error('journal unavailable')}}
  };
  const finish=vm.runInNewContext(source,{require:name=>{if(!Object.hasOwn(modules,name))throw Error('Unexpected dependency '+name);return modules[name]},
    process:syntheticProcess,AbortController,Buffer,setTimeout,clearTimeout});
  if(fail==='journal')await assert.rejects(finish,/journal unavailable/);else await finish;
  return events;
}
test('the worker preserves its existing successful exit after both output files are written',async()=>{
  assert.deepEqual(await runWorker(false),['candidate.png','result.json','exit_0']);
});
test('a rejected worker writes its failure before preserving the explicit nonzero exit',async()=>{
  assert.deepEqual(await runWorker(true),['failure.json','exit_1']);
});
test('a failed diagnostic write still exits unsuccessfully',async()=>{
  assert.deepEqual(await runWorker('journal'),['failure.json','exit_1']);
});
