import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {contentSha256} from '../../../packages/evaluation/dataset-contract.mjs';

const out=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../../',import.meta.url));
const raw=f=>readFileSync(path.join(root,f));
const sha=b=>createHash('sha256').update(b).digest('hex');
const basis='docs/validation/stage17-18-20261119/';
const metadata=f=>JSON.parse(raw(basis+f));
const sequence=['apps/engine/result.mjs','apps/engine/store.mjs','apps/engine/server.mjs','apps/engine/host.cjs',
  'apps/sites/app/page.tsx','apps/sites/app/globals.css','apps/sites/app/api/engine/[...path]/route.ts',
  'apps/sites/components/studio.tsx','apps/sites/lib/studio-model.ts','apps/sites/lib/studio-state.ts','apps/sites/lib/studio-engine.ts',
  'apps/sites/lib/studio-batch-engine.ts','apps/sites/lib/studio-files.ts','apps/sites/lib/studio-reading.ts',
  'apps/sites/lib/studio-storage.ts','packages/evaluation/stage16-final-acceptance.mjs','packages/evaluation/stage17-release.mjs'];
const sources=Object.fromEntries(sequence.map(f=>[f,sha(raw(f))]));
const candidateSha256=contentSha256(sources);
const checks=[];
const final=process.argv[2]==='--final';
function add(id,scope,status,file) {
  checks.push({id,scope,status,candidateSha256,artifactSha256:sha(raw(file)),file});
}
function verify(file,guarded=false,recordRegressionFailure=false){
  const receipt=metadata(file+'.json');
  const {tests,pass,fail,cancelled,skipped,todo}=receipt.counts;
  const completed=Number.isInteger(tests)&&tests>0&&tests===pass+fail+cancelled+skipped+todo;
  const passed=receipt.exitCode===0&&tests===pass;
  const failure=recordRegressionFailure&&receipt.exitCode>0&&(fail>0||cancelled>0);
  if(!completed||!(passed||failure)||receipt.signal||receipt.changedDuringRun.length||sha(raw(basis+file+'.log'))!==receipt.logSha256)throw Error('Incomplete run '+file);
  const pins=metadata(receipt.sources);
  if(guarded){
    if(!/^docs\/validation\/stage16-\d+-\d+\/run-allowed\.mjs$/.test(receipt.args[0]))throw Error('Missing Stage16 guard');
    for(const [name,value] of Object.entries(pins))if(/stage16-|dataset-contract|metadata-only/.test(name)&&sha(raw(name))!==value)throw Error('Stale '+name);
  }else{
    for(const [name,value] of Object.entries(sources))if(!(name in pins)||pins[name]!==value)throw Error('Stale '+name);
  }
  return {file:basis+file+'.json',sha256:sha(raw(basis+file+'.json')),logSha256:receipt.logSha256,exitCode:receipt.exitCode,counts:receipt.counts};
}
function run(id,scope,file,status='PASS'){
  verify(file);
  add(id,scope,status,basis+file+'.json');
}
if(final){
  run('targeted','test','domain-current');
  const desktop=verify('browser-checkpoint',false,true);
  add('desktopBrowser','browser',desktop.exitCode===0?'PASS':'FAIL',desktop.file);
  run('security','review','web-current','NEEDS_REVIEW');
  run('rollback','rehearsal','domain-current','NEEDS_REVIEW');
  const sets=[verify('v2-current',false,true),...['web-current','domain-current','v29-current'].map(k=>verify(k))];
  const guarded=['s16-focused-repeat','s16reg-verified','s16-first','s16-observations-confirmed','s16-blind-confirmed','s16-paired-confirmed'].map(k=>verify(k,true));
  const regression={candidateSha256,sets,guarded,coverage:'Current eligible V2 and all Studio checks. Stage16 uses the original name/metadata allowlists. Historical Legacy/PG was not rerun.'};
  writeFileSync(path.join(out,'release-regression.json'),JSON.stringify(regression,null,2)+'\n',{flag:'wx'});
  add('fullRegression','test',sets[0].exitCode===0?'NEEDS_REVIEW':'FAIL',basis+'release-regression.json');
  const first=metadata('release-decision.json');
  const events=['export-name-red','export-name-green','v2-engine-volume','v2-current','browser-current','browser-final','browser-ui-current','browser-checkpoint','native-current','entry-witness','web-current'].map(label=>{
    const evidence=metadata(label+'.json');
    if(sha(raw(basis+label+'.log'))!==evidence.logSha256)throw Error('Changed diagnostic '+label);
    return {file:basis+label+'.json',at:evidence.finished,exitCode:evidence.exitCode,counts:evidence.counts,logSha256:evidence.logSha256};
  }).sort((a,b)=>a.at.localeCompare(b.at));
  const history={scope:'local_candidate_review',previousReview:{candidateSha256:first.result.candidateSha256,status:first.result.status},
    candidateSha256,events,productionDeployment:null,productionMonitoring:null,operatorApproval:null};
  writeFileSync(path.join(out,'release-review-history.json'),JSON.stringify(history,null,2)+'\n',{flag:'wx'});
  add('monitoring','review','NEEDS_REVIEW',basis+'release-review-history.json');
}else{
  run('targeted','test','domain-verified');
  run('desktopBrowser','browser','browser-offline-b');
  run('security','review','web-all-local','NEEDS_REVIEW');
  run('rollback','rehearsal','domain-verified','NEEDS_REVIEW');
}
add('localHosting','review','PASS','docs/sites-source-v29.json');
const packet={candidateSha256,sources,checks,inspection:{candidateSha256,openP0:[],unmeasured:['new-work quality','runtime performance and cost','physical supported devices','production rollback and monitoring']}};
const pins={candidateSha256,inspectionSha256:contentSha256(packet.inspection),checks:Object.fromEntries(checks.map(row=>[row.id,contentSha256(row)]))};
const prefix=final?'release-final':'release';
for(const [file,value] of [[prefix+'-dossier.json',packet],[prefix+'-pins.json',pins]])writeFileSync(path.join(out,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
