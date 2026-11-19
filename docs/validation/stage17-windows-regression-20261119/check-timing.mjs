import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('.',import.meta.url)),label=process.argv[2];
if(!/^[a-z][\w-]*$/.test(label))throw Error('Run label required');
const file=process.argv[3]??'joined.json';
if(!/^joined(?:-v\d+)?\.json$/.test(file))throw Error('Unexpected evidence name');
const {supervisors}=JSON.parse(fs.readFileSync(path.join(out,label,file)));
const {mode}=JSON.parse(fs.readFileSync(path.join(out,label,'command.json')));
const expected=['five','full'].includes(mode)?10:1;
const unmeasured=[],invalid=[];
for(const s of supervisors){
  if(!s.rootExitUtc){unmeasured.push(s.test);continue;}
  const times=[s.rootCreatedUtc,s.rootExitUtc,s.completionObservedUtc,s.supervisorExitedUtc].map(s=>Date.parse(s));
  if(times.some(t=>!Number.isFinite(t))||times[0]>times[1]||times[1]>times[2]+2||times[2]>times[3]+2||!s.sameIdentity||s.clean!==true||s.activeAfter!==0)invalid.push(s);
}
const pass=supervisors.length===expected&&!unmeasured.length&&!invalid.length;
console.log(JSON.stringify({pass,measured:supervisors.length-unmeasured.length,total:supervisors.length,expected,unmeasured,invalid}));
process.exitCode=pass?0:1;
