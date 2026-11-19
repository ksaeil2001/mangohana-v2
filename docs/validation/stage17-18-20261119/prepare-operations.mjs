import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {contentSha256 as hash} from '../../../packages/evaluation/dataset-contract.mjs';

const out=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../../',import.meta.url));
const bytes=f=>readFileSync(path.join(out,f)),json=f=>JSON.parse(bytes(f)),sha=b=>createHash('sha256').update(b).digest('hex');
function save(name,value){
  const output=JSON.stringify(value,null,2)+'\n',file=path.join(out,name);
  if(existsSync(file)){if(readFileSync(file,'utf8')!==output)throw Error('Historical evidence changed: '+name);}
  else writeFileSync(file,output,{flag:'wx'});
}
const table=json('../stage16-06-20261119/condition-table.json'),index=json('../stage16-06-20261119/synthetic-index.json');
if(table.scope!=='synthetic'||hash(table)!==index.artifactSha256.conditionTable)throw Error('Stage16 saved table mismatch');
const arms={};
for(const processing of ['baseline','improved']){
  const cells=table.observations.cells.filter(c=>c.condition.processing===processing);
  const versions=new Set(cells.map(c=>c.condition.processingSha256));
  if(versions.size!==1||!cells.length)throw Error('Ambiguous processing version');
  const arm={scope:table.scope,kind:'product',experimentId:table.lockId,
    workloadSha256:hash(table.matrices.map(m=>m.shared)),candidateSha256:[...versions][0],planned:[],receipts:[]};
  for(const c of cells){
    if(c.jobs.length!==1)throw Error('The saved fixture must have one assigned job per cell');
    const [job]=c.jobs;
    arm.planned.push({id:job.jobId,unitId:JSON.stringify([c.workId,c.pageId,c.condition.model])});
    arm.receipts.push({id:job.jobId,model:c.condition.model,role:'product-provider',outcome:job.status,sha256:job.receiptSha256,
      tokens:null,elapsedMs:job.elapsedMs.value,currency:job.charge.currency,amount:job.charge.amount,confirmedSubtotalUsd:job.charge.confirmedSubtotal});
  }
  arms[processing]=arm;
}
save('usage-before.json',arms.baseline);save('usage-after.json',arms.improved);
if(process.argv[2]==='--usage-only')process.exit(0);
const cliRun=(file)=>{const r=json(file+'.json');if(sha(bytes(file+'.log'))!==r.logSha256)throw Error('Log hash mismatch: '+file);return r;};
const red=cliRun('roi-red'),green=cliRun('web-current'),full=cliRun('v2-current'),chrome=cliRun('browser-checkpoint');
if(red.exitCode===0||green.exitCode!==0||green.counts.fail||green.changedDuringRun.length||chrome.changedDuringRun.length||
  !Number.isInteger(full.exitCode)||full.changedDuringRun.length||!full.counts.tests||
  full.counts.tests!==full.counts.pass+full.counts.fail+full.counts.cancelled+full.counts.skipped+full.counts.todo)throw Error('Missing stable run');
const renderedRun=chrome.exitCode===0?'browser-checkpoint':'browser-offline-b';
const rendered=cliRun(renderedRun);
if(rendered.exitCode!==0||rendered.counts.pass!==1)throw Error('Missing edited PNG observation');
const browser=JSON.parse(bytes(renderedRun+'.log').toString().match(/STUDIO_BROWSER_EVIDENCE (\{[^\r\n]+\})/)[1]);
const files=['apps/sites/lib/studio-model.ts','apps/sites/lib/studio-state.ts','apps/sites/components/studio.tsx','apps/sites/app/globals.css'];
const previous=json(red.sources);
const changes=files.map(f=>({path:f,beforeSha256:previous[f],afterSha256:sha(readFileSync(path.join(root,f)))}));
if(changes.some(f=>!f.beforeSha256||f.beforeSha256===f.afterSha256))throw Error('Missing edit baseline');
const renderedSources=json(rendered.sources);
if(changes.some(f=>renderedSources[f.path]!==f.afterSha256))throw Error('Rendered OCR editor does not match the change record');
const version=key=>hash(Object.fromEntries(changes.map(f=>[f.path,f[key]])));
const baselineSha256=version('beforeSha256'),candidateSha256=version('afterSha256');
const check=(id,r,version)=>({id,scope:'synthetic',candidateSha256:version,status:r.exitCode===0?'PASS':'FAIL',command:[r.executable,...r.args].join(' '),exitCode:r.exitCode,logSha256:r.logSha256});
const change={scope:'synthetic',goal:{outcome:'Keep a local OCR box edit across save and later results',stopWhen:'Review this candidate once'},
  baselineSha256,candidateSha256,sourceWork:{id:'stage17-test-owned-page',sha256:browser.fixtureSha256,regionIds:['s17-ocr']},
  observation:'Editing an OCR region did not have its own saved coordinate field',firstWrongStage:'Studio editor',hypothesis:'An editor override can preserve the observed box and the layout box',fixedStage:'Studio editor',
  files:changes,beforeImageSha256:null,afterImageSha256:browser.downloadAfterSha256,
  checks:[check('red',red,baselineSha256),check('targeted',green,candidateSha256),
    {id:'newWork',scope:'actual',candidateSha256,status:'NOT_RUN',command:null,exitCode:null,logSha256:null},
    check('regression',full,candidateSha256)],
  renderedRun,axes:{source:'PASS',actualAI:'NOT_RUN',browser:chrome.exitCode===0?'PASS':'FAIL',human:'NOT_RUN'},priorCandidates:[],newKnowledge:true,
  budgetState:'unknown',review:'uncertain',unverified:['independent new manuscript','human review','actual cost',
    'region ID identifies the contract fixture; the browser used a fresh editor-generated ID','before-version PNG was not recorded'],
  measurements:{before:{elapsedMs:null,tokens:null,amountUsd:null},after:{elapsedMs:null,tokens:null,amountUsd:null}},
  problem:{id:'s17-editor-ocr-box',severity:'unrated',attempts:[],previousEscalations:0},
  handoff:{question:'Does the editable OCR box remain distinct on an independently provided new work?',
    diff:'apps/sites/lib/studio-model.ts and apps/sites/lib/studio-state.ts',evidence:['roi-red.log','web-current.json',renderedRun+'.log','v2-current.json']}};
save('change-record.json',change);
save('change-pins.json',{baselineSha256,recordSha256:hash(change)});
