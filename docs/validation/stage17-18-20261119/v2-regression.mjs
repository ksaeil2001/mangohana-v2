import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,mkdtempSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const read=f=>JSON.parse(readFileSync(path.join(root,f),'utf8'));
const old='docs/validation/stage15-integration-20261118/';
const historic={...read(old+'before.json').inputs,...read(old+'verified-inputs.json').updated};
const tests=readdirSync(path.join(root,'tests/v2')).filter(n=>n.endsWith('.test.mjs')&&!n.startsWith('stage16-')).sort().map(n=>'tests/v2/'+n);
// The only changed test inputs are the reviewed result-adapter check (embedded fixture)
// and the new metadata/rollback suites. Fail if any other fixture route has changed.
const reviewed=new Set(['tests/v2/result.test.mjs','tests/v2/stage17-release.test.mjs','tests/v2/stage18-operations.test.mjs']);
for(const f of [...tests,...Object.keys(historic).filter(f=>f.startsWith('tests/v2/')&&!f.endsWith('.test.mjs'))]){
  const sha=createHash('sha256').update(readFileSync(path.join(root,f))).digest('hex');
  if(!reviewed.has(f)&&historic[f]!==sha)throw Error('Recheck fixture scope before running '+f);
}
const flags=process.argv.slice(2);
if(flags.some(flag=>!['--engine-volume','--profile-probe'].includes(flag)))throw Error('Unknown regression option');
const testVolume=flags.includes('--engine-volume')?'E:/Dev/Outputs/MangohanaV2-20261111/tests':os.tmpdir();
const temp=mkdtempSync(path.join(testVolume,'mangohana-release-v2-')), owned=path.join(temp,'owned'), lease=path.join(temp,'lease');
mkdirSync(owned);mkdirSync(lease);
const env={...process.env,TEMP:temp,TMP:temp,MANGOHANA_OWNED_RUNTIME_TEST_DIR:owned,MANGOHANA_LEASE_TEST_DIR:lease,NO_COLOR:'1'};
const selected=flags.includes('--profile-probe')?['--test-name-pattern','default false keeps per-job cold lifecycle','tests/v2/engine-runtime-reuse.test.mjs']:tests;
const args=['--test','--test-reporter=tap','--test-concurrency=1',...selected];
console.log('V2_SYNTHETIC_PARTITION '+JSON.stringify({executable:process.execPath,args,temp,owned,lease,
  fixtures:'Stage15 verified signatures plus reviewed test-owned fixed bytes and new metadata-only/recovery tests',stage16:'separate original guard and name allowlists'}));
const run=spawnSync(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});
if(run.error)throw run.error;
process.exitCode=run.status??2;
