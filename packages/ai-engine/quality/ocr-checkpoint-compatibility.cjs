'use strict';
// Read-only, explicitly audited code-version bridge. The Stage13 exact loader is unchanged.
const fs=require('node:fs/promises'),path=require('node:path'),{createReadStream}=require('node:fs'),{createHash}=require('node:crypto');
const {createCheckpointSession,fingerprintFiles,key}=require('./recovery-checkpoint.cjs');
const DEFAULT_POLICY=require('./ocr-compatibility-policy.json');
const VERSION='stage14r3-ocr-compatibility-v1',hex=/^[a-f0-9]{64}$/;
const currentSnapshots=new WeakMap();
const digest=b=>createHash('sha256').update(b).digest('hex');
const equal=(a,b)=>key(a)===key(b);
function must(ok,reason){if(!ok)throw Object.assign(Error('OCR 호환 검증을 통과하지 못했습니다: '+reason),{code:'OCR_COMPATIBILITY_REJECTED',reason});}
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
async function plain(file){const st=await fs.lstat(file);must(!st.isSymbolicLink()&&path.resolve(await fs.realpath(file))===path.resolve(file),'LINK_OR_ALIAS');return st;}
async function read(file,limit=16*1024*1024){const st=await plain(file);must(st.isFile()&&st.size>0&&st.size<=limit,'FILE_LIMIT');const handle=await fs.open(file,'r');try{const opened=await handle.stat(),bytes=await handle.readFile(),after=await handle.stat(),named=await fs.lstat(file);must(opened.ino===st.ino&&opened.dev===st.dev&&bytes.length===st.size&&after.size===opened.size&&after.mtimeMs===opened.mtimeMs&&named.ino===opened.ino&&named.dev===opened.dev&&!named.isSymbolicLink(),'FILE_CHANGED');return bytes;}finally{await handle.close();}}
async function hash(file){const before=await plain(file);must(before.isFile(),'NOT_A_FILE');const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);const after=await fs.lstat(file);must(!after.isSymbolicLink()&&before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'FILE_CHANGED');return h.digest('hex');}
function ocrSettings(c){return {mangaOcr:c.config.mangaOcr??null,refineConnectedOcr:c.config.refineConnectedOcr??false,ocrEnvironment:c.environmentIdentity,reuseOcrRuntime:c.reuseOcrRuntime};}
function ocrRoots(c){return [c.engineFile,c.config.python,c.config.regionDetectorWorker,c.config.regionDetectorModel,path.join(c.compiled,'src/main/productionOcrService.js'),c.resources,c.resourceRoot,c.config.mangaOcr?.assetsRoot,c.config.mangaOcr?.detectorModelPath,path.resolve(path.dirname(c.engineFile),'../../../../quality/ocr-refinement.cjs'),path.resolve(path.dirname(c.engineFile),'../../../../quality/region-selection.cjs')].filter(Boolean);}
async function computeOcrConfiguration(context){
 let snapshot;const settings=structuredClone(ocrSettings(context)),roots=ocrRoots(context),files=await fingerprintFiles(roots,{excludeFonts:true,capture:value=>{snapshot=value;}}),configuration=key({stage:'ocr',settings,files});
 currentSnapshots.set(context,{...snapshot,configuration,binding:key({roots,settings})});return configuration;
}

/** Same traversal/content/path formula as fingerprintFiles, retaining evidence rows.
 * Snapshot bytes are read under their ORIGINAL names; nothing is copied over current code. */
async function dependencyManifest(roots,snapshot=new Map(),fresh){
 const seen=new Map(),freshRows=new Map(fresh?.rows??[]),freshDirectories=new Map(fresh?.directories??[]),freshSources=new Map(fresh?.sources??[]);
 async function imports(original,source){for(const m of source.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)){let dep=path.resolve(path.dirname(original),m[1]);if(!path.extname(dep))dep+='.js';await visit(dep);}}
 async function visit(original){
  original=path.resolve(original);if(seen.has(original))return;
  if(!snapshot.has(original)&&freshDirectories.has(original)){for(const name of freshDirectories.get(original))await visit(path.join(original,name));return;}
  if(!snapshot.has(original)&&freshRows.has(original)){seen.set(original,freshRows.get(original));if(freshSources.has(original))await imports(original,freshSources.get(original));return;}
  const old=snapshot.get(original),actual=old?.copy??original;let st;
  try{st=await plain(actual);}catch(e){if(e.code==='ENOENT'){seen.set(original,null);return;}throw e;}
  if(st.isDirectory()){must(!old,'SNAPSHOT_DIRECTORY');for(const name of (await fs.readdir(actual)).sort())if(!/^font/i.test(name))await visit(path.join(original,name));return;}
  must(st.isFile(),'DEPENDENCY_FILE');const sha256=await hash(actual);if(old)must(sha256===old.sha256,'SNAPSHOT_HASH');seen.set(original,sha256);
  if(/\.[cm]?js$/.test(original)&&st.size<=4*1024*1024)await imports(original,(await read(actual,4*1024*1024)).toString('utf8'));
 }
 for(const root of roots)await visit(root);
 const rows=[...seen.entries()].sort(([a],[b])=>a.localeCompare(b));return {fingerprint:key(rows),rows};
}
function historicalContext(config,current){return {engineFile:path.resolve(config.repository,'scripts/sites-local/engine.cjs'),repositoryRoot:current.repositoryRoot,config,
 compiled:path.resolve(config.buildRoot),resources:path.resolve(config.resourcesPath),resourceRoot:path.join(path.resolve(config.installedLocalAppData),'Trio/resources'),
 environmentIdentity:{version:'ocr-private-home-v1',python:path.resolve(config.python),home:path.join(path.resolve(config.profileRoot),'ocr-home')},reuseOcrRuntime:config.reuseOcrRuntime===true};}
async function snapshots(evidence,repositoryRoot){
 const root=path.resolve(repositoryRoot),snapshotRoot=path.resolve(evidence.snapshotRoot);must((await plain(snapshotRoot)).isDirectory(),'SNAPSHOT_ROOT');
 const bytes=await read(evidence.snapshotManifestPath),manifest=JSON.parse(bytes.toString('utf8'));must(Array.isArray(manifest.files)&&manifest.files.length<=10000,'SNAPSHOT_MANIFEST');const map=new Map();
 for(const row of manifest.files){must(typeof row.path==='string'&&!path.isAbsolute(row.path)&&hex.test(row.sha256),'SNAPSHOT_ENTRY');const original=path.resolve(root,row.path),copy=path.resolve(snapshotRoot,row.path);must(inside(root,original)&&inside(snapshotRoot,copy)&&!map.has(original),'SNAPSHOT_SCOPE');map.set(original,{copy,sha256:row.sha256});}
 return {map,manifestSha256:digest(bytes)};
}
async function inspectEmptyHomeTree(home){
 const root=path.resolve(home),directories=[];must((await plain(root)).isDirectory(),'OCR_HOME');
 async function walk(dir){for(const name of (await fs.readdir(dir)).sort()){const file=path.join(dir,name),st=await plain(file);must(st.isDirectory(),'OCR_HOME_HAS_FILE');directories.push(path.relative(root,file));await walk(file);}}
 await walk(root);return directories.sort();
}
async function verifyHome(old,current){
 const a=path.resolve(old.environmentIdentity.home),b=path.resolve(current.environmentIdentity.home);must((await plain(a)).isDirectory()&&(await plain(b)).isDirectory(),'OCR_HOME');
 if(a===b)return {relocated:false,from:a,to:b};
 must(/^E:[\\/]/i.test(a)&&/^E:[\\/]/i.test(b)&&path.basename(a)==='ocr-home'&&path.basename(b)==='ocr-home','PRIVATE_E_HOME_REQUIRED');
  const oldTree=await inspectEmptyHomeTree(a),newTree=await inspectEmptyHomeTree(b);must(equal(oldTree,newTree),'OCR_HOME_DIRECTORY_LAYOUT_CHANGED');
  return {relocated:true,from:a,to:b,basis:'IDENTICAL_FILE_FREE_PRIVATE_E_HOME_TREES_SAME_PYTHON_AND_ENVIRONMENT_VERSION',directories:oldTree};
}
function comparableSettings(c){const s=structuredClone(ocrSettings(c));delete s.ocrEnvironment.home;return s;}
async function validateCapturedSnapshot(snapshot){
 let next=0;const rows=snapshot.anchors,directories=new Map(snapshot.directories);
 await Promise.all(Array.from({length:8},async()=>{while(next<rows.length){const [file,before]=rows[next++];let after;try{after=await fs.lstat(file);}catch(error){if(error.code==='ENOENT'&&before.missing)continue;throw error;}
  must(!before.missing&&!after.isSymbolicLink()&&after.ino===before.ino&&after.dev===before.dev&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.isDirectory()===before.directory,'CURRENT_DEPENDENCY_CHANGED');
  if(before.directory)must(equal((await fs.readdir(file)).sort().filter(name=>!/^font/i.test(name)),directories.get(file)),'CURRENT_DEPENDENCY_CHANGED');}}));
}

function createOcrCompatibilityAccess({policy=DEFAULT_POLICY}={}){
 // A policy is supplied by trusted code only; engine callers cannot supply one.
 const pinnedPolicy=structuredClone(policy);
 async function load({session,identity,context,scope,resumeFrom,sourceEvidence,signal}){
  signal?.throwIfAborted();const exact=await session.load('ocr',identity);if(exact)return {value:exact,compatibility:null};
  if(!sourceEvidence)return {value:null,compatibility:null};
  if(typeof sourceEvidence==='function')sourceEvidence=await sourceEvidence({scope:structuredClone(scope),identity:structuredClone(identity)});
  must(sourceEvidence&&typeof sourceEvidence==='object','SOURCE_EVIDENCE_REQUIRED');
  const p=pinnedPolicy;must(p.version===VERSION&&hex.test(p.legacyEngineSha256)&&hex.test(p.currentEngineSha256)&&hex.test(p.compatibilityModuleSha256),'AUDITED_POLICY_REQUIRED');
  must(await hash(__filename)===p.compatibilityModuleSha256,'COMPATIBILITY_IMPLEMENTATION_CHANGED');
  must(context&&scope&&resumeFrom&&hex.test(identity?.configuration),'CURRENT_IDENTITY_REQUIRED');
  const root=path.resolve(context.repositoryRoot);must(inside(root,path.resolve(context.engineFile))&&await hash(context.engineFile)===p.currentEngineSha256,'CURRENT_ENGINE_NOT_AUDITED');
  const snapshot=await snapshots(sourceEvidence,root),engineSnapshot=snapshot.map.get(path.resolve(context.engineFile));must(engineSnapshot&&await hash(engineSnapshot.copy)===p.legacyEngineSha256,'LEGACY_ENGINE_NOT_AUDITED');
  const configBytes=await read(sourceEvidence.creationConfigPath,1024*1024),creationConfig=JSON.parse(configBytes.toString('utf8')),old=historicalContext(creationConfig,context);
  must(path.resolve(old.engineFile)===path.resolve(context.engineFile)&&equal(ocrRoots(old),ocrRoots(context)),'OCR_RESOURCE_PATH_CHANGED');
  must(equal(comparableSettings(old),comparableSettings(context)),'OCR_SETTINGS_CHANGED');const home=await verifyHome(old,context);
  const directory=path.resolve(resumeFrom.directory),checkpointBytes=await read(path.join(directory,'checkpoint-ocr.json')),saved=JSON.parse(checkpointBytes.toString('utf8')),state=JSON.parse((await read(path.join(directory,'state.json'))).toString('utf8'));
  must(saved.version==='stage13-checkpoint-v1'&&saved.stage==='ocr'&&saved.jobId===resumeFrom.jobId&&state.id===resumeFrom.jobId,'ORIGINAL_JOB');
  must(Number.isSafeInteger(sourceEvidence.expectedGeneration)&&sourceEvidence.expectedGeneration>0&&state.sequence===sourceEvidence.expectedGeneration,'ORIGINAL_GENERATION');
  must(equal(saved.scope,scope)&&state.owner===scope.ownerScope&&state.projectId===scope.projectId&&state.pageId===scope.pageId&&state.sourceSha256===scope.sourceSha256&&state.sourceLanguage===scope.sourceLanguage&&(state.pageNumber??null)===scope.pageNumber,'ORIGINAL_SCOPE');
  must(equal(state.checkpoints?.ocr,resumeFrom.checkpoints?.ocr)&&digest(checkpointBytes)===resumeFrom.checkpoints?.ocr?.sha256,'ORIGINAL_RECEIPT');
  must(await hash(path.join(directory,'source.png'))===scope.sourceSha256&&await hash(path.join(directory,'normalized.png'))===scope.normalizedSha256,'SOURCE_IMAGE_HASH');
  let current=currentSnapshots.get(context);
  if(!current){await computeOcrConfiguration(context);current=currentSnapshots.get(context);}
  must(current.binding===key({roots:ocrRoots(context),settings:ocrSettings(context)})&&current.configuration===identity.configuration,'CURRENT_CONFIGURATION_CHANGED');
  const captured=current,previous=await dependencyManifest(ocrRoots(old),snapshot.map,current);current={rows:current.rows,fingerprint:key(current.rows)};
  const reconstructed=key({stage:'ocr',settings:ocrSettings(old),files:previous.fingerprint}),fresh=key({stage:'ocr',settings:ocrSettings(context),files:current.fingerprint});
  must(saved.identity?.configuration===reconstructed,'LEGACY_CONFIGURATION_RECONSTRUCTION');must(identity.configuration===fresh,'CURRENT_CONFIGURATION_CHANGED');
  const previousMap=new Map(previous.rows),currentMap=new Map(current.rows),allowed=new Map();
  must(Array.isArray(p.allowedNonOcrChanges),'POLICY_SHAPE');for(const row of p.allowedNonOcrChanges){must(typeof row.path==='string'&&!path.isAbsolute(row.path)&&hex.test(row.sha256),'POLICY_ENTRY');const file=path.resolve(root,row.path);must(inside(root,file)&&!allowed.has(file),'POLICY_SCOPE');allowed.set(file,row.sha256);}
  const changed=[];
  for(const file of [...new Set([...previousMap.keys(),...currentMap.keys()])].sort()){
   const before=previousMap.get(file)??null,after=currentMap.get(file)??null;if(before===after)continue;
   const engine=file===path.resolve(context.engineFile),policyMeta=file===path.resolve(root,p.policyRelativePath);
   must(engine||policyMeta||allowed.get(file)===after,'OCR_DEPENDENCY_CHANGED:'+path.relative(root,file));
   if(policyMeta)must(equal(JSON.parse((await read(file,1024*1024)).toString('utf8')),p),'POLICY_CHANGED');
   changed.push({path:path.relative(root,file),beforeSha256:before,currentSha256:after,basis:engine?'AUDITED_ENGINE_VERSION_PAIR':policyMeta?'EXPLICIT_VERSIONED_POLICY':'PINNED_NON_OCR_CODE'});
  }
  signal?.throwIfAborted();
  // Authenticate the ORIGINAL receipt/scope/assets through the unchanged loader.
  const original=createCheckpointSession({directory,jobId:'read-only-compatibility',scope,resumeFrom,signal});const value=await original.load('ocr',saved.identity);must(!!value,'ORIGINAL_LOADER_REJECTED');
  await validateCapturedSnapshot(captured);
  must(digest(await read(path.join(directory,'checkpoint-ocr.json')))===digest(checkpointBytes),'CHECKPOINT_CHANGED');
  const compatibility={version:VERSION,acceptedThrough:'EXPLICIT_AUDITED_CODE_COMPATIBILITY',originalJobId:saved.jobId,originalGeneration:state.sequence,originalCheckpointSha256:digest(checkpointBytes),originalIdentity:structuredClone(saved.identity),currentIdentity:structuredClone(identity),scope:structuredClone(scope),creationConfigSha256:digest(configBytes),snapshotManifestSha256:snapshot.manifestSha256,
   dependencyDifference:changed,ocrDependencyChanges:0,home,originalLoaderEvidence:original.evidence(),payloadSha256:digest(Buffer.from(JSON.stringify(value.payload))),legacyCheckpointRewritten:false,newCheckpointWritten:false,newInferenceCalls:0,policyVersion:VERSION,policySha256:key(p)};
  return {value,compatibility};
 }
 return Object.freeze({load});
}
module.exports={ocrSettings,ocrRoots,computeOcrConfiguration,createOcrCompatibilityAccess,dependencyManifest,inspectEmptyHomeTree};
