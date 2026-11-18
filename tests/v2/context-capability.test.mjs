// Public health must not promise terminology consumption from an absent flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './batch-fixture.mjs';
test('the job store exposes only an explicit boolean capability rather than inferring it from readiness',async t=>{
 const f=await fixture(t);assert.equal((await f.store.health()).savedContextSupported,false);
 f.engine.health=()=>({ready:true,savedContextSupported:'true'});assert.equal((await f.store.health()).savedContextSupported,false);
 f.engine.health=()=>({ready:true,savedContextSupported:true});assert.equal((await f.store.health()).savedContextSupported,true);
});
