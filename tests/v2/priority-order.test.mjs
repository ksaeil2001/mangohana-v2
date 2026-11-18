import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobStore} from '../../apps/engine/store.mjs';
import {fixture,png,alice,deferred,until} from './batch-fixture.mjs';

for(const scenario of [{current:'page-one',restart:false},{current:'legacy-one',restart:true}])test(`mixed legacy and numbered pages have stable current/next priority (${scenario.current}, restart=${scenario.restart})`,async t=>{
 const gate=deferred(),f=await fixture(t,{gate}),ids=[];
 await f.store.submit({owner:alice,idempotencyKey:'blocker',bytes:png,name:'blocker.png',projectId:'other-project',pageId:'blocker'});
 await f.started.promise;
 const ten=await f.submitBatch({idempotencyKey:'ten',pages:[{key:'file:0',name:'10.png',bytes:png,pageId:'page-ten',pageNumber:10}]});ids.push(ten.pages[0].jobId);
 const legacyOne=await f.store.submit({owner:alice,idempotencyKey:'legacy-one',bytes:png,name:'legacy-one.png',projectId:'project-one',pageId:'legacy-one'});ids.push(legacyOne.id);
 const first=await f.submitBatch({idempotencyKey:'first',pages:[1,2].map(number=>({key:'file:'+number,name:number+'.png',bytes:png,pageId:number===1?'page-one':'page-two',pageNumber:number}))});ids.push(...first.pages.map(page=>page.jobId));
 const legacyTwo=await f.store.submit({owner:alice,idempotencyKey:'legacy-two',bytes:png,name:'legacy-two.png',projectId:'project-one',pageId:'legacy-two'});ids.push(legacyTwo.id);
 assert.equal(legacyOne.pageNumber,null);assert.equal(legacyTwo.pageNumber,null);
 await f.store.prioritize(alice,{projectId:'project-one',pageId:scenario.current});
 if(scenario.restart){await f.store.close();f.store=await createJobStore({root:f.root,engine:f.engine});}
 gate.resolve();await until(()=>Promise.all(ids.map(id=>f.store.get(alice,id))),jobs=>jobs.every(job=>job.status==='completed'));
 const expected=scenario.current==='page-one'?['page-one','page-two','page-ten','legacy-one','legacy-two']:['legacy-one','legacy-two','page-ten','page-one','page-two'];
 assert.deepEqual(f.runs.filter(input=>input.projectId==='project-one').map(input=>input.pageId),expected);
 assert.equal((await f.store.get(alice,legacyOne.id)).pageNumber,null,'priority must not invent a number for a legacy page');
 assert.equal((await f.store.get(alice,legacyTwo.id)).pageNumber,null);
});
