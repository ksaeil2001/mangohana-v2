// Build the standard product IIFE; preserve the old generated bundle first.
import fs from 'node:fs/promises';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const [audit,name='product-renderer']=process.argv.slice(2);if(!path.isAbsolute(audit??'')||!/^[-a-z0-9]+$/.test(name))throw Error('absolute fresh audit required');
const root=process.cwd(),engine=path.join(root,'packages/ai-engine'),installed=path.join(engine,'.build/renderer.js'),out=path.join(audit,'evidence',name);await fs.mkdir(out,{recursive:false});
const sha=b=>createHash('sha256').update(b).digest('hex'),before=await fs.readFile(installed);await fs.writeFile(path.join(out,'renderer-before.js'),before,{flag:'wx'});
const require=createRequire(path.join(engine,'package.json')),{build}=await import(pathToFileURL(require.resolve('vite')).href);
const commonjsOptions={include:[/node_modules/,/quality[\\/](?:background-layout|korean-utterance|korean-typesetting-standard)\.cjs$/]};
await build({configFile:false,root:path.join(engine,'vendor/trio'),logLevel:'warn',build:{commonjsOptions,emptyOutDir:false,minify:false,outDir:out,lib:{entry:path.join(engine,'vendor/trio/scripts/sites-local/renderer.ts'),name:'SitesCandidate',formats:['iife'],fileName:()=> 'renderer.js'}}});
const after=await fs.readFile(path.join(out,'renderer.js')),sandbox={};vm.runInNewContext(after.toString(),sandbox,{timeout:3000});
if(!['prepare','render','invalidate'].every(k=>typeof sandbox.SitesCandidate?.[k]==='function'))throw Error('product exports missing');
if(sha(await fs.readFile(installed))!==sha(before))throw Error('installed bundle changed concurrently');
const measureInstalled=path.join(engine,'.build/layout-measurement.js');let measureBefore=null;try{const b=await fs.readFile(measureInstalled);measureBefore=sha(b);await fs.writeFile(path.join(out,'layout-measurement-before.js'),b,{flag:'wx'});}catch(e){if(e.code!=='ENOENT')throw e;}
await build({configFile:false,root:path.join(engine,'vendor/trio'),logLevel:'warn',build:{commonjsOptions,emptyOutDir:false,minify:false,outDir:out,lib:{entry:path.join(engine,'vendor/trio/src/renderer/layoutMeasurement.ts'),name:'LayoutTextMeasurement',formats:['iife'],fileName:()=> 'layout-measurement.js'}}});
const measureAfter=await fs.readFile(path.join(out,'layout-measurement.js')),measureSandbox={};vm.runInNewContext(measureAfter.toString(),measureSandbox,{timeout:3000});if(typeof measureSandbox.LayoutTextMeasurement?.measureEntries!=='function')throw Error('measurement export missing');
const geometryInstalled=path.join(engine,'.build/layout-source-geometry.cjs');let geometryBefore=null;
try{const b=await fs.readFile(geometryInstalled);geometryBefore=sha(b);await fs.writeFile(path.join(out,'layout-source-geometry-before.cjs'),b,{flag:'wx'});}catch(e){if(e.code!=='ENOENT')throw e;}
await build({configFile:false,root:path.join(engine,'vendor/trio'),logLevel:'warn',build:{commonjsOptions,emptyOutDir:false,minify:false,outDir:out,lib:{entry:path.join(engine,'vendor/trio/src/renderer/layoutSourceGeometry.ts'),formats:['cjs'],fileName:()=> 'layout-source-geometry.cjs'}}});
const geometryAfter=await fs.readFile(path.join(out,'layout-source-geometry.cjs'));if(typeof require(path.join(out,'layout-source-geometry.cjs')).inferCandidateBox!=='function')throw Error('source geometry export missing');
await fs.copyFile(path.join(out,'layout-source-geometry.cjs'),geometryInstalled);
await fs.copyFile(path.join(out,'renderer.js'),installed);await fs.copyFile(path.join(out,'layout-measurement.js'),measureInstalled);
const result={kind:'STANDARD_SITES_CANDIDATE_BUILD_AND_INSTALL_NOT_DEPLOYMENT',installed,beforeSha256:sha(before),afterSha256:sha(after),installedSha256:sha(await fs.readFile(installed)),bytes:after.length,backup:`evidence/${name}/renderer-before.js`,fontAndResourcesCopied:false,configurationChanged:false};
result.measurement={installed:measureInstalled,beforeSha256:measureBefore,afterSha256:sha(measureAfter),actualImageExecution:false};
result.sourceGeometry={installed:geometryInstalled,beforeSha256:geometryBefore,afterSha256:sha(geometryAfter),modelCalls:0};await fs.writeFile(path.join(out,'installation.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
