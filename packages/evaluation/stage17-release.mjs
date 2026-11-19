import {createHash} from 'node:crypto';
import {copyFile, mkdtemp, readFile, rm, rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {contentSha256} from './dataset-contract.mjs';
import {digest} from './offline/contract.mjs';
import {assessStage16Acceptance} from './stage16-final-acceptance.mjs';

// These are independent receipts. A local browser run cannot stand in for a device or a human.
const requirements={
  targeted:'test',fullRegression:'test',desktopBrowser:'browser',supportedDevices:'device',security:'review',
  performance:'actual',modelRun:'actual',pngReview:'human',holdout:'actual',rollback:'rehearsal',
  monitoring:'review',localHosting:'review',deploymentApproval:'operator',
};

/** Trusted operator pins are supplied separately from the candidate's dossier. No deployment side effects. */
export function assessRelease(packet={},pins={}) {
  const candidate=packet.candidateSha256, current=digest(candidate)&&candidate===pins.candidateSha256;
  const blockers=new Set(current?[]:['CANDIDATE_VERSION_REQUIRED']);
  const inspection=packet.inspection;
  if(!current||inspection?.candidateSha256!==candidate||contentSha256(inspection)!==pins.inspectionSha256||
    !Array.isArray(inspection.openP0)||!Array.isArray(inspection.unmeasured))blockers.add('INSPECTION_REQUIRED');
  else {
    if(inspection.openP0.length)blockers.add('OPEN_P0');
    if(inspection.unmeasured.length)blockers.add('UNMEASURED_INDICATORS');
  }
  const acceptance=assessStage16Acceptance(packet.stage16,pins.stage16,'actual');
  const rows=Object.entries(requirements).map(([id,scope])=>{
    const records=Array.isArray(packet.checks)?packet.checks.filter(c=>c?.id===id):[];
    const [record]=records;
    let status='NOT_RUN',reason='EVIDENCE_REQUIRED';
    if(records.length){
      const bound=records.length===1&&current&&record.candidateSha256===candidate&&record.scope===scope&&
        digest(record.artifactSha256)&&contentSha256(record)===pins.checks?.[id];
      if(!bound){status='BLOCKED';reason='STALE_AMBIGUOUS_OR_WRONG_SCOPE';}
      else if(!['PASS','FAIL','NEEDS_REVIEW','NOT_RUN','BLOCKED'].includes(record.status)){status='BLOCKED';reason='INVALID_STATUS';}
      else {status=record.status;reason=status==='PASS'?null:status;}
    }
    if(id==='holdout'&&status==='PASS'&&(acceptance.status!=='acceptance_evidence_verified'||
      contentSha256(acceptance.artifactSha256)!==record.artifactSha256)){
      status='BLOCKED';reason='ACTUAL_STAGE16_REQUIRED';
    }
    if(status!=='PASS')blockers.add(id);
    return {id,scope,status,reason,artifactSha256:records.length===1?record.artifactSha256??null:null};
  });
  return {candidateSha256:candidate??null,status:blockers.size?'BLOCKED':'READY_FOR_RELEASE_REVIEW',deployAuthorized:false,
    rows,blockers:[...blockers],stage16:{status:acceptance.status,blockers:acceptance.blockers}};
}

const fileHash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
/** Exercise recovery in a new OS temporary directory without touching a live install or replacing either input. */
export async function rehearseRollback({previous,failed,previousSha256,candidateSha256}) {
  if(!digest(previousSha256)||!digest(candidateSha256)||previousSha256===candidateSha256||
    await fileHash(previous)!==previousSha256||await fileHash(failed)!==candidateSha256)throw Error('Rollback input hash mismatch');
  const dir=await mkdtemp(path.join(os.tmpdir(),'mangohana-rollback-')), restored=path.join(dir,'restored');
  try{
    await copyFile(previous,restored);
    const restoredSha256=await fileHash(restored);
    if(restoredSha256!==previousSha256)throw Error('Restored copy hash mismatch');
    return {scope:'rehearsal',status:'PASS',candidateSha256,previousSha256,restoredSha256,
      events:['candidate_failed','previous_verified','restored_copy_verified']};
  }finally{await rm(restored,{force:true});await rmdir(dir);}
}
