import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {createContextStore} from '../../apps/engine/context.mjs';
const owner=createHash('sha256').update('revision-read-fixture').digest('hex'),project='project';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'context-read-')),store=await createContextStore({root});t.after(()=>store.close());return {root,store,directory:path.join(root,createHash('sha256').update(owner+'\0'+project).digest('hex'))};}
test('read-only revision does not wait for a held guard and writes still wait',async t=>{
 const {store}=await fixture(t);let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const guard=store.withRevision(owner,project,0,async()=>{entered();await held;});await started;
 let committed=false;const write=store.apply(owner,project,{expectedRevision:0,idempotencyKey:'update',changes:[{type:'upsert_term',term:{id:'name',source:'原文',target:'번역'}}]}).then(r=>{committed=true;return r;});
 try{assert.equal(await store.readRevision(owner,project),0);assert.equal(committed,false);}finally{release();await guard;await write;}
 assert.equal(await store.readRevision(owner,project),1);await store.close();await assert.rejects(store.readRevision(owner,project),{code:'CONTEXT_STORE_CLOSED'});
});
for(const [name,file,code] of [['corrupt state','state.json','CONTEXT_CORRUPT'],['unresolved pending','.pending-00000000-0000-4000-8000-000000000000.json','CONTEXT_COMMIT_UNKNOWN']])test('read-only revision fails closed on '+name,async t=>{
 const {store,directory}=await fixture(t);await fs.mkdir(directory);const target=path.join(directory,file);await fs.writeFile(target,'broken');
 await assert.rejects(store.readRevision(owner,project),{code});assert.equal(await fs.readFile(target,'utf8'),'broken');
});
