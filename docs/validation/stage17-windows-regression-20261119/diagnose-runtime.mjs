import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here=fileURLToPath(new URL('.',import.meta.url));
const root=path.resolve(here,'../../..');
const label=process.argv[2];
if(!/^provider-[a-z0-9-]+$/.test(label))throw Error('New diagnostic label required');
const directory=path.join(here,label);
const temp=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-provider-');
const owned=path.join(temp,'owned');
fs.mkdirSync(directory);fs.mkdirSync(owned);
const testFile='tests/v2/engine-runtime-reuse.test.mjs';
const fixture='tests/v2/fixtures/owned-engine-runtime.mjs';
const digest=file=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const old=JSON.parse(fs.readFileSync(path.join(here,'verified-five/sources.json'),'utf8'));
const response=process.argv[3]==='response'&&/^provider-response-\d+$/.test(label);
const expectedFixture=response?'1971c6915cf1852c4fbda01bb7a28f62da7e6b20606c0650de4c6ebfc0516cd6':old[fixture];
if(old[testFile]!==digest(testFile)||expectedFixture!==digest(fixture))throw Error('Expected exact fixture and test');
const wire=process.argv[3]==='wire';
const args=['--test','--test-concurrency=1','--test-reporter=tap','--require',path.join(here,'trace.cjs'),
  '--require',path.join(here,response?'response-phases.cjs':wire?'client-write.cjs':'fixture-phases.cjs')];
if(response){args.push(testFile);}
else if(['all','local','wire'].includes(process.argv[3])){
  const ocr='tests/v2/engine-ocr-refinement.test.mjs';
  if(digest(ocr)!==old[ocr])throw Error('Original OCR test required');
  args.push(ocr,testFile);
}else if(process.argv[3]==='journal'){
  args.push('--test-name-pattern','^(?:default false keeps per-job|Stage13 render-only retry|Stage12 refuses omitTypesettingIdentity|a warm OCR lazy restart|unconfirmed cached owner cleanup)',testFile);
}else{
  args.push('--test-name-pattern','^(?:selected reuse keeps independent|a warm OCR lazy restart|unconfirmed cached owner cleanup)',testFile);
}
const trace=path.join(directory,'trace');
fs.mkdirSync(trace);
const env={...process.env,TEMP:temp,TMP:temp,MANGOHANA_OWNED_RUNTIME_TEST_DIR:owned,
  STAGE17_TEST_TRACE:trace,STAGE17_FIXTURE_PHASES:path.join(directory,'children.json'),STAGE17_PROVIDER_MODE:process.argv[3]??'full',
  STAGE17_WIRE_PATH:path.join(directory,'wire.json'),...(response?{STAGE17_RESPONSE_TRACE:directory}:{})};
const started=new Date().toISOString();
const actual=spawnSync(process.execPath,args,{cwd:root,env,windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
if(actual.error)throw actual.error;
const tap=actual.stdout+actual.stderr;
fs.writeFileSync(path.join(directory,'tap.log'),tap,{flag:'wx'});
const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>
  [key,Number(tap.match(new RegExp('^# '+key+' (\\d+)\\s*$','m'))?.[1]??NaN)]));
const output={started,finished:new Date().toISOString(),node:process.version,executable:process.execPath,
  sourcePins:{[testFile]:digest(testFile),[fixture]:digest(fixture)},temp,args,counts,exitCode:actual.status,signal:actual.signal};
fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(output,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({label,counts,exitCode:actual.status}));
process.exitCode=actual.status??2;
