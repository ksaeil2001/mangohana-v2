// Reuse existing web checks in a fresh copy; never rewrite their previous .sites-runtime outputs.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {execFileSync,spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stage13-web-'));
const files=[...new Set(execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(f=>f.startsWith('apps/sites/')||f.startsWith('packages/ai-engine/vendor/trio/src/')||f.startsWith('packages/ai-engine/quality/')))];
for(const file of files){const dest=path.join(temporary,file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,file),dest);}
await fs.symlink(path.join(root,'node_modules'),path.join(temporary,'node_modules'),process.platform==='win32'?'junction':'dir');
await fs.symlink(path.join(root,'apps/sites/node_modules'),path.join(temporary,'apps/sites/node_modules'),process.platform==='win32'?'junction':'dir');
const selected=process.argv.slice(2);if(!selected.length||selected.some(n=>!/^[-a-z]+\.test\.mjs$/.test(n)))throw Error('Explicit web check filenames required');
console.log('ISOLATED_WEB_CHECK_ROOT='+temporary);
const child=spawn(process.execPath,['--test','--test-concurrency=1',...selected.map(n=>'apps/sites/checks/'+n)],{cwd:temporary,env:process.env,windowsHide:true,stdio:'inherit'});
const result=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',code=>resolve(code));});process.exitCode=result===0?0:1;
