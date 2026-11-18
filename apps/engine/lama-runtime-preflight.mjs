import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{secretlessEnvironment}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs'),execute=promisify(execFile);
// Import only. Never load LaMa/ONNX graphs, images, worker modules or inference sessions.
const probe=`import sys, json, platform
platform.system()
def deny(event, args):
    if event.startswith('socket.') or event in ('subprocess.Popen', 'os.system', 'os.posix_spawn', 'os.fork', 'os.exec'):
        raise RuntimeError('OFFLINE_IMPORT_ONLY')
sys.addaudithook(deny)
import onnxruntime as ort
import numpy as np
import PIL
print(json.dumps({'python':sys.version.split()[0], 'onnxruntime':ort.__version__, 'numpy':np.__version__, 'pillow':PIL.__version__, 'providers':ort.get_available_providers()}))
`;
export async function probeLamaRuntime({python},{executeFile=execute}={}){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stage14-lama-import-'));
 try{
  const {stdout}=await executeFile(python,['-I','-B','-c',probe],{env:secretlessEnvironment(python,temporary),windowsHide:true,shell:false,timeout:30000,maxBuffer:64*1024}),result=JSON.parse(stdout);
  if(!['python','onnxruntime','numpy','pillow'].every(k=>typeof result[k]==='string'&&/^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(result[k]))||!Array.isArray(result.providers)||!result.providers.includes('CPUExecutionProvider'))throw Error('LAMA_RUNTIME_UNAVAILABLE');
  return {status:'AVAILABLE_IMPORT_ONLY',...result,modelLoaded:false,inferenceCalled:false,lamaWorkerStarted:false};
 }catch{throw Object.assign(Error('기존 LaMa Python의 NumPy·Pillow·ONNX Runtime CPU 제공자를 확인하지 못했습니다.'),{code:'LAMA_RUNTIME_UNAVAILABLE'});
 }finally{try{await fs.rmdir(temporary);}catch(e){if(e.code!=='ENOTEMPTY')throw e;/* Preserve unexpected import artifacts; never recursively delete. */}}
}
