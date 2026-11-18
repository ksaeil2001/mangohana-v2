// Read-only compatibility probe. Executes only the product's configuration expression
// and checkpoint loader, never createEngine, OCR, translation, LaMa or a renderer.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),[audit,output]=process.argv.slice(2);
if(!audit||!output)throw Error('Explicit existing R3 audit and new report file required');
const root=process.cwd(),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
async function hash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
const {createCheckpointSession,fingerprintFiles,key}=require('../../packages/ai-engine/quality/recovery-checkpoint.cjs');
const {runtimeReuseFlags}=require('../../packages/ai-engine/quality/owned-runtime.cjs');
const manifest=await read(path.join(path.dirname(audit),'MangoHana_14R2_20261113_215800/evidence/saved-manifest.json'));
const directory=manifest.sourceDirectory,state=await read(path.join(directory,'state.json'));
const checkpointFile=path.join(directory,'checkpoint-ocr.json'),before=await fs.readFile(checkpointFile),saved=JSON.parse(before),configFile=path.join(path.dirname(path.dirname(directory)),'config.json'),config=await read(configFile);
if(sha(before)!==state.checkpoints?.ocr?.sha256)throw Error('CHECKPOINT_RECEIPT_MISMATCH');
const sourceSha256=await hash(path.join(directory,'source.png')),normalizedSha256=await hash(path.join(directory,'normalized.png'));
const scope={ownerScope:state.owner,projectId:state.projectId,pageId:state.pageId,sourceSha256,normalizedSha256,sourceLanguage:state.sourceLanguage,pageNumber:state.pageNumber??null};
const engineFile=path.join(root,'packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs'),engineSource=await fs.readFile(engineFile,'utf8'),engineSha256=sha(engineSource);
const baseline=await read(path.join(audit,'evidence/baseline.json')),beforeMap=new Map(baseline.files.map(f=>[path.resolve(root,f.path),{...f,copy:path.join(audit,'evidence/before',f.path)}]));
const previousSource=await fs.readFile(beforeMap.get(engineFile).copy,'utf8');
const inputs={__filename:engineFile,__dirname:path.dirname(engineFile),config,compiled:path.resolve(config.buildRoot),resources:path.resolve(config.resourcesPath),
 resourceRoot:path.join(path.resolve(config.installedLocalAppData),'Trio','resources'),reuse:runtimeReuseFlags(config),checkpointsEnabled:true,path,checkpointKey:key,
 ocrEnvironmentPolicy:{identity:{version:'ocr-private-home-v1',python:path.resolve(config.python),home:path.join(path.resolve(config.profileRoot),'ocr-home')}}};
// Validate existing paths without calling prepareOcrEnvironmentPolicy (which mkdirs HOME).
for(const p of [config.python,config.profileRoot,inputs.ocrEnvironmentPolicy.identity.home]){const st=await fs.lstat(p);if(st.isSymbolicLink()||path.resolve(await fs.realpath(p))!==path.resolve(p))throw Error('UNSAFE_CREATION_CONFIG_PATH');}
const captured=[];
async function compute(source,fingerprint){
 const expression=/const configuration=(async stage=>[\s\S]*?);\s*const saveCheckpoint=/.exec(source)?.[1];
 if(!expression)throw Error('CURRENT_CONFIGURATION_EXPRESSION_CHANGED');
 const fn=vm.runInNewContext('('+expression+')',{...inputs,fingerprintFiles:async(files,opts)=>{captured.push({files,opts});return fingerprint(files,opts);}}, {timeout:1000});
 return await fn('ocr');
}
const currentIdentity={configuration:await compute(engineSource,fingerprintFiles)};
// Reconstruct the pre-R3 source bytes under their ORIGINAL absolute names.
// This is a comparison only; it is never supplied as a current-engine cache identity.
const oldRead=async(file,...args)=>{
 const old=beforeMap.get(path.resolve(file));return fs.readFile(old?old.copy:file,...args);
};
const historicalFingerprint=vm.runInNewContext('('+fingerprintFiles.toString()+')',{
 path,fs:new Proxy(fs,{get:(target,name)=>name==='readFile'?oldRead:target[name]}),key,
 fileHash:async file=>{const old=beforeMap.get(path.resolve(file));return hash(old?old.copy:file);},
},{timeout:1000});
const reconstructedPreviousIdentity={configuration:await compute(previousSource,historicalFingerprint)};
function loader(){return createCheckpointSession({directory:path.dirname(path.resolve(output)),jobId:'stage14r3-current-readonly-probe',scope,resumeFrom:{directory,jobId:state.id,checkpoints:state.checkpoints}});}
const originalLoader=loader(),originalReplay=await originalLoader.load('ocr',saved.identity),currentLoader=loader(),currentReplay=await currentLoader.load('ocr',currentIdentity);
const input=await read(path.join(path.dirname(audit),'MangoHana_14R2_20261113_215800/evidence/saved/translation-input.json'));
const groups=saved.payload.extraction.speechBubbles;
const lineage=input.regions.map(r=>{const group=groups.find(g=>g.id===r.id);const sourceIds=group?.ocrRefinement?.sourceDetectionIds??group?.productionOcrProvenance?.sourceDetectionIds??[];return {regionId:r.id,sourceTextMatches:group?.text?.normalize('NFKC')===r.sourceText,sourceLineIdsMatch:JSON.stringify(sourceIds)===JSON.stringify(r.sourceLineIds),rawOcrText:group?.productionOcrProvenance?.recognition?.rawOcrText??null,refinement:group?.ocrRefinement??null,roiId:r.roiId,sourceLineIds:r.sourceLineIds};});
// Trace only local JS imports to identify which current source changes are in
// the product's transitive fingerprint. Non-source resource leaves stay explicit.
const seen=new Set();
async function trace(file){if(!file)return;file=path.resolve(file);if(seen.has(file))return;seen.add(file);let st;try{st=await fs.lstat(file);}catch{return;}
 if(st.isDirectory()){for(const n of (await fs.readdir(file)).sort())if(!/^font/i.test(n))await trace(path.join(file,n));}
 else if(/\.[cm]?js$/.test(file)&&st.size<=4*1024*1024){const code=await fs.readFile(file,'utf8');for(const m of code.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)){let dep=path.resolve(path.dirname(file),m[1]);if(!path.extname(dep))dep+='.js';await trace(dep);}}
}
for(const p of captured[0].files)await trace(p);
const sourceDependencyChanges=[],unbaselinedDependencies=[];
for(const file of [...seen].filter(p=>p.startsWith(root+path.sep)).sort()){
 const old=beforeMap.get(file);let st;try{st=await fs.stat(file);}catch{continue;}if(!st.isFile())continue;
 const actual=await hash(file);if(!old)unbaselinedDependencies.push({path:path.relative(root,file),currentSha256:actual,reason:'NOT_IN_SOURCE_BASELINE_NOT_CLAIMED_CHANGED'});else if(actual!==old.sha256)sourceDependencyChanges.push({path:path.relative(root,file),beforeSha256:old.sha256,currentSha256:actual});
}
const protectedFiles=[checkpointFile,configFile,path.join(directory,'source.png'),path.join(directory,'normalized.png'),path.join(directory,'state.json')];
// Config JSON formatting is irrelevant to identity; preserve its actual bytes separately.
const configBytes=await fs.readFile(configFile);
const result={version:'stage14r3-current-checkpoint-probe-v1',status:currentReplay?'CURRENT_ENGINE_OCR_REUSABLE':'CURRENT_ENGINE_OCR_REJECTED',mode:'NO_INFERENCE_READ_ONLY',
 sourceDirectory:directory,sourceConfig:configFile,sourceConfigSha256:sha(configBytes),checkpointSha256:sha(before),checkpointVersion:saved.version,createdAt:saved.createdAt,jobId:state.id,
 scope,scopeMatches:JSON.stringify(scope)===JSON.stringify(saved.scope),generation:{savedJobSequence:state.sequence,currentBrowserEditRevision:null,scopeDoesNotBindUserEditRevision:true},
 originalIdentity:saved.identity,reconstructedPreR3Identity:reconstructedPreviousIdentity,reconstructionMatchesOriginal:reconstructedPreviousIdentity.configuration===saved.identity.configuration,
 currentIdentity,currentConfigurationBasis:'CURRENT_ENGINE_EXPRESSION_WITH_UNCHANGED_CREATION_CONFIG_AND_SAME_PROFILE_READ_ONLY',
 originalIdentityReplay:{accepted:!!originalReplay,regions:originalReplay?.payload?.extraction?.speechBubbles?.length??0,evidence:originalLoader.evidence()},
 currentEngineReplay:{accepted:!!currentReplay,evidence:currentLoader.evidence(),differingFields:currentIdentity.configuration===saved.identity.configuration?[]:['identity.configuration','key(scope, identity)'],rejectingFunction:'createCheckpointSession.load',file:'packages/ai-engine/quality/recovery-checkpoint.cjs',condition:'saved.key !== key({scope,identity}) || key(saved.identity) !== key(identity)'},
 fingerprintFunction:'fingerprintFiles (transitive local JS imports, file bytes, absolute paths, OCR settings)',ocrSettings:{mangaOcr:config.mangaOcr??null,refineConnectedOcr:config.refineConnectedOcr??false,ocrEnvironment:inputs.ocrEnvironmentPolicy.identity,reuseOcrRuntime:inputs.reuse.ocr},
 engineSourceSha256:engineSha256,fingerprintInputs:captured[0].files,sourceDependencyChanges,unbaselinedDependencies,lineage,
 translationCodeAffectsOcr:sourceDependencyChanges.some(p=>/translation|korean-output/.test(p.path)),
 safeCompatibilityPathAvailable:!!currentReplay,minimumChangeIfRejected:'An explicitly versioned OCR-only dependency identity plus audited migration/compatibility proof would be required. Old configuration hashes cannot be rewritten. A new unique E profile also changes the HOME setting identity. No compatibility implementation or cache re-signing performed.',
 checkpointUnchanged:sha(await fs.readFile(checkpointFile))===sha(before),engineUnchangedDuringProbe:await hash(engineFile)===engineSha256,
 protectedFileHashes:await Promise.all(protectedFiles.map(async p=>({path:p,sha256:await hash(p)}))),newCheckpointWritten:false,newInferenceCalls:0,rendererCalls:0,configurationResigned:false};
if(!result.originalIdentityReplay.accepted||!result.checkpointUnchanged||!result.engineUnchangedDuringProbe||!lineage.every(r=>r.sourceTextMatches&&r.sourceLineIdsMatch))throw Error('CHECKPOINT_PROBE_INTEGRITY_FAILED');
await fs.writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({status:result.status,originalReplay:result.originalIdentityReplay.accepted,reconstructionMatchesOriginal:result.reconstructionMatchesOriginal,currentIdentity:result.currentIdentity,sourceDependencyChanges:sourceDependencyChanges.map(r=>r.path),scopeMatches:result.scopeMatches,lineageVerified:lineage.length,unchanged:result.checkpointUnchanged,newInferenceCalls:0}));
