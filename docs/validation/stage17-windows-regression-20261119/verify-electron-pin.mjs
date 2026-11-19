import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../packages/ai-engine/',import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const inspectArchive=process.argv[2]==='previous-archive',previous=inspectArchive||process.argv[2]==='previous';
const name=previous?'42.9.3':'42.10.0',moduleRoot=path.join(root,'node_modules/electron'),lock=read(path.join(root,'package-lock.json')).packages;
const versions={declared:read(path.join(root,'package.json')).dependencies.electron,
  lockSpec:lock[''].dependencies.electron,locked:lock['node_modules/electron'].version,
  installed:read(path.join(moduleRoot,'package.json')).version,binary:fs.readFileSync(path.join(moduleRoot,'dist/version'),'utf8').trim()};
if(!inspectArchive&&Object.values(versions).some(v=>v!==name)){
  console.log(JSON.stringify({pass:false,versions,reason:'Runtime lacks the Windows shutdown backport in 42.10.0'}));process.exit(1);
}
const artifact=read(new URL(previous?'./electron-previous-archive.json':'./electron-archive.json',import.meta.url)),yauzl=createRequire(path.join(root,'package.json'))('yauzl');
const hash=async stream=>{const h=createHash('sha256');for await(const bytes of stream)h.update(bytes);return h.digest('hex')};
const fromZip=await new Promise((resolve,reject)=>yauzl.open(artifact.cachePath,{lazyEntries:true},(err,zip)=>{
  if(err)return reject(err);
  zip.on('error',reject);zip.on('end',()=>reject(Error('Missing electron.exe')));
  zip.on('entry',entry=>{
    if(entry.fileName!=='electron.exe'){zip.readEntry();return}
    zip.openReadStream(entry,(err,stream)=>{if(err){zip.close();reject(err);return}hash(stream).then(resolve,reject).finally(()=>zip.close())});
  });
  zip.readEntry();
}));
const originalHash=read(new URL('./electron-before.json',import.meta.url)).files.find(f=>f.file.endsWith('/electron.exe')).sha256;
if(inspectArchive){console.log(JSON.stringify({pass:fromZip===originalHash,fromZip,originalHash}));process.exit(fromZip===originalHash?0:1)}
const installedSha256=await hash(fs.createReadStream(path.join(moduleRoot,'dist/electron.exe')));
const pass=fromZip===installedSha256&&(!previous||originalHash===fromZip)&&artifact.packageIntegrity===lock['node_modules/electron'].integrity&&
  lock['node_modules/electron'].resolved==='https://registry.npmjs.org/electron/-/electron-'+name+'.tgz';
console.log(JSON.stringify({pass,versions,installedSha256,officialExeSha256:fromZip,archiveSha256:artifact.archiveSha256}));
process.exitCode=pass?0:1;
