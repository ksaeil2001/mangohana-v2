import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=fileURLToPath(new URL('.',import.meta.url)),old=path.join(out,'../stage17-18-20261119');
const [label,mode,traceFlag]=process.argv.slice(2);
if(!/^[a-z][a-z0-9-]+$/.test(label)||!['five','full','exit','entry'].includes(mode)||!['trace','normal'].includes(traceFlag))throw Error('Use a new label, five/full/exit/entry and trace/normal');
const sha=b=>createHash('sha256').update(b).digest('hex'),digest=f=>sha(fs.readFileSync(f)),read=f=>JSON.parse(fs.readFileSync(f));
const previous=read(path.join(old,'v2-current.json')),pins=read(path.join(old,previous.sources));
if(sha(fs.readFileSync(path.join(old,'v2-current.log')))!==previous.logSha256)throw Error('Full historic TAP hash differs');
const eligible=fs.readdirSync(path.join(root,'tests/v2')).filter(n=>n.endsWith('.test.mjs')&&!n.startsWith('stage16-')).sort().map(n=>'tests/v2/'+n);
const original=JSON.parse(fs.readFileSync(path.join(old,'v2-current.log'),'utf8').split(/\r?\n/)[0].replace(/^V2_SYNTHETIC_PARTITION /,'')).args.filter(n=>n.startsWith('tests/v2/'));
if(JSON.stringify(eligible)!==JSON.stringify(original))throw Error('Review changed test inventory');
const diaryFixture='tests/v2/fixtures/owned-engine-runtime.mjs';
const originalDiary='d612c3d056ba6e40259758c5d59bfde663bdbe69e791766654a5f88038bed213';
const reviewedDiary='1971c6915cf1852c4fbda01bb7a28f62da7e6b20606c0650de4c6ebfc0516cd6';
const journalRun=/^(journal|quiet)-(five|full|missing|native)$/.test(label);
if(journalRun&&pins[diaryFixture]!==originalDiary)throw Error('Original diary baseline changed');
for(const file of [...eligible,...Object.keys(pins).filter(n=>n.startsWith('tests/v2/fixtures/'))]){
  const expected=journalRun&&file===diaryFixture?reviewedDiary:pins[file];
  if(digest(path.join(root,file))!==expected)throw Error('Fixture or assertion differs from its reviewed pin: '+file);
}
const five=['engine-ocr-refinement','engine-runtime-reuse','imported-font-bootstrap','typesetting-only-native','warm-electron-entry'].map(n=>'tests/v2/'+n+'.test.mjs');
const tests=mode==='full'?eligible:mode==='five'?five:[mode==='entry'?five[4]:five[3]];
const dir=path.join(out,label);
fs.mkdirSync(dir);
const tmp=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-windows-'+label+'-');
const env={...process.env,TEMP:tmp,TMP:tmp,NO_COLOR:'1'};
for(const [key,name] of Object.entries({MANGOHANA_OWNED_RUNTIME_TEST_DIR:'owned',MANGOHANA_LEASE_TEST_DIR:'lease',MANGOHANA_ENTRY_TEST_DIR:'entry'})){
  env[key]=path.join(tmp,name);fs.mkdirSync(env[key]);
}
const args=['--test','--test-reporter=tap','--test-concurrency=1'];
if(traceFlag==='trace'){
  env.STAGE17_TEST_TRACE=path.join(dir,'trace');fs.mkdirSync(env.STAGE17_TEST_TRACE);
  args.push('--require',path.join(out,'trace.cjs'));
}
if(mode==='exit')args.push('--test-name-pattern','^dedicated no-model worker renders thirteen synthetic regions and retains non-final candidate before publication$');
if(mode==='entry')args.push('--test-name-pattern','^real Electron CLI with a deliberately missing plan emits startup_failed and exits 1 promptly$');
args.push(...tests);
const sourceFiles=new Set([...Object.keys(pins).filter(k=>fs.existsSync(path.resolve(root,k))),
  'packages/ai-engine/package.json','packages/ai-engine/package-lock.json','packages/ai-engine/node_modules/electron/package.json',
  'packages/ai-engine/node_modules/electron/dist/version','packages/ai-engine/node_modules/electron/dist/electron.exe',
  'scripts/v2/warm-job.ps1','scripts/v2/typesetting-only-worker.cjs','scripts/v2/warm-job.mjs','apps/engine/verify-warm.cjs',
  'packages/ai-engine/quality/typesetting-only-native.cjs','packages/ai-engine/quality/typesetting-only-pipeline.cjs',
  'packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs','packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs',
  path.relative(root,fileURLToPath(import.meta.url)),path.relative(root,path.join(out,'trace.cjs'))]);
const capture=()=>Object.fromEntries([...sourceFiles].sort().map(f=>[f,digest(path.resolve(root,f))]));
const before=capture();
fs.writeFileSync(path.join(dir,'sources.json'),JSON.stringify(before,null,2)+'\n');
const started=new Date().toISOString(),log=fs.openSync(path.join(dir,'tap.log'),'wx');
const command={mode,traceFlag,started,tmp,executable:process.execPath,executableSha256:digest(process.execPath),node:process.version,args,
  branch:execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fixtureRoots:{owned:env.MANGOHANA_OWNED_RUNTIME_TEST_DIR,lease:env.MANGOHANA_LEASE_TEST_DIR,entry:env.MANGOHANA_ENTRY_TEST_DIR}};
fs.writeFileSync(path.join(dir,'command.json'),JSON.stringify(command,null,2)+'\n');
const coverage=[],startedMono=performance.now();
let prior;
function pulse(){
  const cpus=os.cpus().map(c=>c.times),idle=cpus.reduce((n,c)=>n+c.idle,0),total=cpus.reduce((n,c)=>n+Object.values(c).reduce((a,b)=>a+b,0),0);
  coverage.push({utc:new Date().toISOString(),elapsedMs:Math.round(performance.now()-startedMono),freeMiB:Math.round(os.freemem()/1048576),
    cpuBusyPercent:prior&&total>prior.total?Math.round(100*(1-(idle-prior.idle)/(total-prior.total))):null});prior={total,idle};
}
pulse();const interval=setInterval(pulse,2000);
const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});
const {code,signal}=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
clearInterval(interval);pulse();fs.closeSync(log);
const actual=fs.readFileSync(path.join(dir,'tap.log'),'utf8'),counts={};
for(const name of ['tests','pass','fail','cancelled','skipped','todo'])counts[name]=Number(actual.match(new RegExp('^# '+name+' (\\d+)\\s*$','m'))?.[1]??NaN);
const after=capture(),changed=Object.keys(before).filter(f=>before[f]!==after[f]);
const result={...command,finished:new Date().toISOString(),code,signal,counts,changed,logSha256:sha(actual),sourcesSha256:digest(path.join(dir,'sources.json')),
  failures:actual.split(/\r?\n/).filter(l=>l.startsWith('not ok '))};
fs.writeFileSync(path.join(dir,'host-samples.json'),JSON.stringify(coverage)+'\n');
fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({label,code,counts,changed,failures:result.failures}));
process.exitCode=code===0&&Object.values(counts).every(Number.isFinite)&&counts.pass===counts.tests&&counts.tests>0&&!changed.length?0:1;
