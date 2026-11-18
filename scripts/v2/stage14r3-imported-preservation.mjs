// Read-only census. No credentials or cookie bytes are emitted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [mode,file]=process.argv.slice(2),hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
if(!['before','after'].includes(mode)||!file)throw Error('before|after <manifest> required');
if(mode==='before'){
 const rows=new Map();
 async function add(p){p=path.resolve(p);rows.set(p,await hash(p));}
 async function walk(p,imagesOnly=false){for(const e of await fs.readdir(p,{withFileTypes:true})){if(e.isSymbolicLink())continue;const q=path.join(p,e.name);if(e.isDirectory()){if(!['node_modules','.git','.next','dist','profile','ocr-home'].includes(e.name))await walk(q,imagesOnly);}else if(!imagesOnly||/\.(png|trio|ctp)$/i.test(e.name))await add(q);}}
 const descriptor=JSON.parse(await fs.readFile('apps/engine/stage14r3-review-source.json'));
 for(const v of Object.values(descriptor.files))await add(v.path);
 const base='E:/Dev/Outputs/MangohanaV2-20261111';
 await add(path.join(base,'engine-config.json'));await walk(path.join(base,'jobs/translation-reviews'));
 const saved=JSON.parse(await fs.readFile('../_audits/MangoHana_14R2_20261113_215800/evidence/saved-manifest.json'));
 await walk(saved.sourceDirectory);await add(path.join(path.dirname(path.dirname(saved.sourceDirectory)),'config.json'));
 await walk(base,true);
 const sources=new Map();
 for(const dir of ['apps/engine','packages/ai-engine/quality','scripts/v2','tests/v2']){for(const e of await fs.readdir(dir,{withFileTypes:true}))if(e.isFile()){const p=path.resolve(dir,e.name);sources.set(p,await hash(p));}}
 for(const p of ['packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs','apps/sites/app/api/engine/[...path]/route.ts'])sources.set(path.resolve(p),await hash(p));
 await fs.writeFile(file,JSON.stringify({protected:[...rows],sources:[...sources]},null,2),{flag:'wx'});console.log(JSON.stringify({protected:rows.size,sources:sources.size}));
}else{
 const before=JSON.parse(await fs.readFile(file)),changed=[],missing=[];
 for(const [p,h]of before.protected)try{if(await hash(p)!==h)changed.push(p);}catch(e){if(e.code==='ENOENT')missing.push(p);else throw e;}
 const sources=[];for(const [p,h]of before.sources)if(await hash(p)!==h)sources.push(p);
 const out={protected:before.protected.length,changed,missing,changedSources:sources,status:changed.length||missing.length?'FAILED':'PASS'};
 await fs.writeFile(file.replace(/\.json$/,'.after.json'),JSON.stringify(out,null,2),{flag:'wx'});console.log(JSON.stringify(out));if(out.status!=='PASS')process.exitCode=1;
}
