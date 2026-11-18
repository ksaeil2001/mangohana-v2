import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ownedStopPath, ownsRuntime } from '../../apps/engine/lifecycle.mjs';
const first='f0000000-0000-4000-8000-000000000001';
const second='f0000000-0000-4000-8000-000000000002';

test('a launcher can stop only its own run without touching a shared STOP file',()=>{
  assert.notEqual(ownedStopPath('/tmp/mangohana',first),ownedStopPath('/tmp/mangohana',second));
  assert.equal(path.basename(ownedStopPath('/tmp/mangohana',first)),`STOP-${first}`);
  assert.throws(()=>ownedStopPath('/tmp/mangohana','../../other'));
});
test('old and competing runtime records cannot start this launcher frontend',()=>{
  const runtime={status:'listening',pid:123,runId:first};
  assert.equal(ownsRuntime(runtime,123,first),true);
  assert.equal(ownsRuntime(runtime,124,first),false);
  assert.equal(ownsRuntime(runtime,123,second),false);
  assert.equal(ownsRuntime({...runtime,status:'stopped'},123,first),false);
});
