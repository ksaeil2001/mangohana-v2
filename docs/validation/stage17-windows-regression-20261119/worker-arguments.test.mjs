import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as job from '../../../scripts/v2/warm-job.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const exe=path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe');
const worker=path.join(root,'scripts/v2/typesetting-only-worker.cjs');
const args=[worker,path.resolve('E:/Dev/Outputs/test-only-worker-argument'),'--disable-gpu'];

test('the known Windows typesetting runtime omits V8 page pooling at process startup',()=>{
  const original=[...args];
  assert.deepEqual(job.windowsWorkerArguments(exe,args,'42.9.3'),[...args,'--js-flags=--no-memory-pool']);
  assert.deepEqual(args,original);
});
test('corrected versions, other executables and other entry scripts retain the same arguments',()=>{
  for(const version of ['42.10.0','43.5.0','unknown'])assert.equal(job.windowsWorkerArguments(exe,args,version),args);
  assert.equal(job.windowsWorkerArguments(path.join(root,'other','electron.exe'),args,'42.9.3'),args);
  for(const entry of [path.join(root,'apps/engine/verify-warm.cjs'),path.join(root,'other/typesetting-only-worker.cjs'),worker+'-other']){
    const other=[entry,...args.slice(1)];assert.equal(job.windowsWorkerArguments(exe,other,'42.9.3'),other);
  }
  for(const tail of [['--js-flags=--max-old-space-size=192'],['--js-flags','--max-old-space-size=192'],['--','literal']]){
    const explicit=[...args,...tail];assert.equal(job.windowsWorkerArguments(exe,explicit,'42.9.3'),explicit);
  }
});
