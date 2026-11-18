// Actual local --help check; no model argument, account environment or inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {ProcessOwner,secretlessEnvironment,collectProcess,waitBounded}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-runtime-help-'+new Date().toISOString().replaceAll(':','-');await fs.mkdir(output,{recursive:false});
const temporary=path.join(output,'temp');await fs.mkdir(temporary,{recursive:false});
const owner=new ProcessOwner(),started=performance.now();
let stdout='',stderr='',failure,record;
try{
 record=owner.spawn(config.llamaServer,['--help'],{cwd:path.dirname(config.llamaServer),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:secretlessEnvironment(config.llamaServer,temporary)});
 record.child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-16*1024);});
 stdout=(await waitBounded(collectProcess(record,{stdoutLimit:256*1024,stderrLimit:16*1024})(),30000,'RUNTIME_HELP_TIMEOUT')).toString('utf8');
 if(!['--load-mode','--no-host','--batch-size','--ubatch-size'].every(flag=>stdout.includes(flag))||!stdout.includes('none: no special loading mode'))throw new Error('REQUIRED_RUNTIME_OPTIONS_MISSING');
 if(/loading model tensors|load_tensors:/i.test(stdout+stderr))throw new Error('UNEXPECTED_MODEL_WEIGHT_LOADING');
}catch(error){failure=/^[A-Z_0-9]{1,80}$/.test(error?.message??'')?error.message:'RUNTIME_HELP_CHECK_FAILED';}
finally{try{await owner.cleanup();}catch{failure='CLEANUP_FAILED';}}
await fs.writeFile(path.join(output,'help.stdout.txt'),stdout,{flag:'wx'});await fs.writeFile(path.join(output,'help.stderr.txt'),stderr,{flag:'wx'});
const evidence={scope:'ACTUAL_NATIVE_HELP_CHECK_NO_MODEL_ARGUMENT_OR_AI_REQUEST',status:failure?'failed':'supported',failure,executable:config.llamaServer,args:['--help'],durationMs:Math.round(performance.now()-started),nativeHelpExecutions:1,modelHttpRequests:0,modelWeightLoadObserved:false,stdoutSha256:createHash('sha256').update(stdout).digest('hex'),cleanupConfirmed:[...owner.children.values()].every(child=>child.closed),processId:record?.child.pid};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(evidence,null,2),{flag:'wx'});console.log(JSON.stringify({output,...evidence}));if(failure||!evidence.cleanupConfirmed)process.exitCode=1;
