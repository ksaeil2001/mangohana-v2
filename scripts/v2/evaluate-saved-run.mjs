import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateOfflineRun } from '../../packages/evaluation/offline/evaluator.mjs';
import { identifier } from '../../packages/evaluation/offline/contract.mjs';

// Only explicit offline inputs. No provider selection, runtime publish or model launch.
const args=process.argv.slice(2),flags=['--dataset','--dataset-sha','--evidence','--evidence-sha','--evidence-root','--workspace','--output'];
try {
  const values=new Map();
  if(args.length!==flags.length*2)throw {code:'INVALID_ARGUMENTS'};
  for(let i=0;i<args.length;i+=2) {if(!flags.includes(args[i]) || values.has(args[i]) || !args[i+1] || args[i+1].startsWith('--'))throw {code:'INVALID_ARGUMENTS'};values.set(args[i],args[i+1]);}
  const output=path.resolve(values.get('--output'));
  if(await fs.stat(output).then(()=>true,()=>false))throw {code:'OUTPUT_ALREADY_EXISTS'};
  const report=await evaluateOfflineRun({datasetPath:values.get('--dataset'),datasetSha256:values.get('--dataset-sha'),evidencePath:values.get('--evidence'),evidenceSha256:values.get('--evidence-sha'),evidenceRoot:values.get('--evidence-root'),workspace:values.get('--workspace')});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({validation:'passed',scope:report.adapterVerificationScope,states:report.states,pages:report.summary.pages}));
} catch(e) {
  const code=identifier(e.code)?e.code:'OFFLINE_EVALUATION_FAILED';
  console.error(JSON.stringify({validation:'failed',code}));process.exitCode=1;
}
