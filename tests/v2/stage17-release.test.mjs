import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {contentSha256} from '../../packages/evaluation/dataset-contract.mjs';

const api=await import('../../packages/evaluation/stage17-release.mjs').catch(error=>{
  if(error.code!=='ERR_MODULE_NOT_FOUND'||!error.message.includes('stage17-release.mjs'))throw error;
  return {};
});
const candidate='c'.repeat(64), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const required={targeted:'test',fullRegression:'test',desktopBrowser:'browser',supportedDevices:'device',security:'review',
  performance:'actual',modelRun:'actual',pngReview:'human',holdout:'actual',rollback:'rehearsal',monitoring:'review',localHosting:'review',deploymentApproval:'operator'};
function fixture(){
  const checks=Object.entries(required).map(([id,scope])=>({id,scope,candidateSha256:candidate,status:'PASS',artifactSha256:hash(id)}));
  const inspection={candidateSha256:candidate,openP0:[],unmeasured:[]};
  return {packet:{candidateSha256:candidate,checks,inspection},pins:{candidateSha256:candidate,checks:Object.fromEntries(checks.map(c=>[c.id,contentSha256(c)])),inspectionSha256:contentSha256(inspection)}};
}
test('an empty release dossier has an explicit row for each gate and never opens shipping',()=>{
  const r=api.assessRelease({},{});assert.equal(r.status,'BLOCKED');assert.equal(r.rows.length,Object.keys(required).length);
  assert.ok(r.rows.every(row=>row.status==='NOT_RUN'));assert.equal(r.deployAuthorized,false);
});
test('current local passes preserve the actual Stage16 blockers and never promote synthetic holdout evidence',()=>{
  const {packet,pins}=fixture(),r=api.assessRelease(packet,pins);
  assert.equal(r.rows.find(x=>x.id==='targeted').status,'PASS');
  assert.equal(r.rows.find(x=>x.id==='holdout').status,'BLOCKED');
  assert.ok(r.stage16.blockers.includes('UNUSED_HOLDOUT_REQUIRED'));assert.equal(r.deployAuthorized,false);
  const h=packet.checks.find(x=>x.id==='holdout');h.scope='synthetic';pins.checks.holdout=contentSha256(h);
  assert.notEqual(api.assessRelease(packet,pins).rows.find(x=>x.id==='holdout').status,'PASS');
});
test('failures, stale pins, duplicate checks, wrong scope and unmeasured quality stay visible',()=>{
  const {packet,pins}=fixture();
  const by=id=>packet.checks.find(x=>x.id===id);
  by('modelRun').scope='synthetic';pins.checks.modelRun=contentSha256(by('modelRun'));
  by('desktopBrowser').candidateSha256='d'.repeat(64);pins.checks.desktopBrowser=contentSha256(by('desktopBrowser'));
  by('fullRegression').artifactSha256=hash('changed');
  by('security').status='FAIL';pins.checks.security=contentSha256(by('security'));
  packet.checks.push({...by('rollback')});
  packet.inspection.openP0=['loss'];packet.inspection.unmeasured=['performance'];pins.inspectionSha256=contentSha256(packet.inspection);
  const r=api.assessRelease(packet,pins),rows=Object.fromEntries(r.rows.map(row=>[row.id,row.status]));
  assert.deepEqual([rows.modelRun,rows.desktopBrowser,rows.fullRegression,rows.security,rows.rollback],['BLOCKED','BLOCKED','BLOCKED','FAIL','BLOCKED']);
  assert.ok(r.blockers.includes('OPEN_P0'));assert.ok(r.blockers.includes('UNMEASURED_INDICATORS'));
});
test('rollback rehearsal restores pinned bytes to a fresh location and leaves both artifacts intact',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mangohana-release-fixture-')),previous=path.join(dir,'previous.txt'),failed=path.join(dir,'failed.txt');
  try{
    await writeFile(previous,'known-good');await writeFile(failed,'candidate');
    const r=await api.rehearseRollback({previous,failed,previousSha256:hash('known-good'),candidateSha256:hash('candidate')});
    assert.equal(r.status,'PASS');assert.equal(r.scope,'rehearsal');assert.equal(r.restoredSha256,hash('known-good'));
    assert.deepEqual(r.events,['candidate_failed','previous_verified','restored_copy_verified']);
    await assert.rejects(api.rehearseRollback({previous,failed,previousSha256:hash('stale'),candidateSha256:hash('candidate')}),/hash/i);
    assert.equal(await readFile(failed,'utf8'),'candidate');assert.equal(await readFile(previous,'utf8'),'known-good');
  }finally{await rm(previous,{force:true});await rm(failed,{force:true});await import('node:fs/promises').then(fs=>fs.rmdir(dir));}
});
