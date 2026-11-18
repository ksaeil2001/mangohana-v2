import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{createCheckpointSession,fingerprintFiles,key}=require('../../packages/ai-engine/quality/recovery-checkpoint.cjs');
const {ocrRoots,ocrSettings,computeOcrConfiguration,createOcrCompatibilityAccess,inspectEmptyHomeTree}=require('../../packages/ai-engine/quality/ocr-checkpoint-compatibility.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-r3-compat-')),snapshot=path.join(root,'before'),jobs=path.join(root,'old-job'),profile=path.join(root,'profile');
 for(const d of [snapshot,jobs,path.join(profile,'ocr-home'),path.join(root,'compiled/src/main'),path.join(root,'resources'),path.join(root,'installed/Trio/resources')])await fs.mkdir(d,{recursive:true});
 const engineRelative='packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs',engineDir=path.dirname(engineRelative),ocrRelative=path.join(engineDir,'ocr.js'),translationRelative=path.join(engineDir,'translation.js');
 const originalCode="require('./ocr.js');require('./translation.js'); // audited old engine\n",currentCode="require('./ocr.js');require('./translation.js'); // audited translation-only version\n";
 const values={[engineRelative]:originalCode,[ocrRelative]:'module.exports=75;',[translationRelative]:'module.exports="old";','python.exe':'synthetic-python','detector.py':'synthetic-detector','model.bin':'synthetic-model','compiled/src/main/productionOcrService.js':'module.exports={};'};
 for(const [p,b]of Object.entries(values)){await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),b);}
 const config={repository:path.join(root,'packages/ai-engine/vendor/trio'),buildRoot:path.join(root,'compiled'),resourcesPath:path.join(root,'resources'),installedLocalAppData:path.join(root,'installed'),profileRoot:profile,python:path.join(root,'python.exe'),regionDetectorWorker:path.join(root,'detector.py'),regionDetectorModel:path.join(root,'model.bin'),refineConnectedOcr:true,reuseOcrRuntime:false};
 const context={engineFile:path.join(root,engineRelative),repositoryRoot:root,config,compiled:config.buildRoot,resources:config.resourcesPath,resourceRoot:path.join(config.installedLocalAppData,'Trio/resources'),environmentIdentity:{version:'ocr-private-home-v1',python:config.python,home:path.join(profile,'ocr-home')},reuseOcrRuntime:false};
 const legacyConfiguration=key({stage:'ocr',settings:ocrSettings(context),files:await fingerprintFiles(ocrRoots(context),{excludeFonts:true})});
 const manifest={files:[]};for(const p of [engineRelative,ocrRelative,translationRelative]){await fs.mkdir(path.dirname(path.join(snapshot,p)),{recursive:true});await fs.copyFile(path.join(root,p),path.join(snapshot,p));manifest.files.push({path:p,sha256:hash(await fs.readFile(path.join(root,p)))});}
 const snapshotManifestPath=path.join(root,'snapshot.json');await fs.writeFile(snapshotManifestPath,JSON.stringify(manifest));const creationConfigPath=path.join(root,'creation-config.json');await fs.writeFile(creationConfigPath,JSON.stringify(config));
 const source=Buffer.from('synthetic original image bytes'),normalized=Buffer.from('synthetic normalized image bytes'),scope={ownerScope:'a'.repeat(64),projectId:'project',pageId:'page',sourceSha256:hash(source),normalizedSha256:hash(normalized),sourceLanguage:'ja',pageNumber:1};
 await fs.writeFile(path.join(jobs,'source.png'),source);await fs.writeFile(path.join(jobs,'normalized.png'),normalized);
 const checkpoints={},writer=createCheckpointSession({directory:jobs,jobId:'original-job',scope,onCheckpoint:r=>{checkpoints[r.stage]=r;}});
 const payload={extraction:{speechBubbles:[{id:'original-region',text:'原文',productionOcrProvenance:{sourceDetectionIds:['det-1']}}]}};await writer.save('ocr',{configuration:legacyConfiguration},payload,['normalized.png']);
 const state={id:'original-job',sequence:2,owner:scope.ownerScope,projectId:scope.projectId,pageId:scope.pageId,pageNumber:1,sourceLanguage:'ja',sourceSha256:scope.sourceSha256,checkpoints};await fs.writeFile(path.join(jobs,'state.json'),JSON.stringify(state));
 await fs.writeFile(context.engineFile,currentCode);await fs.writeFile(path.join(root,translationRelative),'module.exports="new";');
 const policy={version:'stage14r3-ocr-compatibility-v1',legacyEngineSha256:hash(originalCode),currentEngineSha256:hash(currentCode),compatibilityModuleSha256:hash(await fs.readFile(new URL('../../packages/ai-engine/quality/ocr-checkpoint-compatibility.cjs',import.meta.url))),policyRelativePath:'policy.json',allowedNonOcrChanges:[{path:translationRelative,sha256:hash(await fs.readFile(path.join(root,translationRelative)))}],justification:'Synthetic audited code version pair; OCR program unchanged'};
 const resumeFrom={directory:jobs,jobId:state.id,checkpoints},sourceEvidence={snapshotRoot:snapshot,snapshotManifestPath,creationConfigPath,expectedGeneration:2};
 const makeSession=()=>createCheckpointSession({directory:root,jobId:'new-job',scope,resumeFrom});
 const load=async()=>createOcrCompatibilityAccess({policy}).load({session:makeSession(),identity:{configuration:await computeOcrConfiguration(context)},context,scope,resumeFrom,sourceEvidence});
 return {root,snapshot,jobs,context,scope,resumeFrom,sourceEvidence,policy,payload,makeSession,load,state,ocrRelative,translationRelative};
}
test('an explicit audited compatibility path reuses original OCR without rewriting or saving its fingerprint',async()=>{
 const f=await fixture(),file=path.join(f.jobs,'checkpoint-ocr.json'),before=await fs.readFile(file),identity={configuration:await computeOcrConfiguration(f.context)};
 assert.equal(await f.makeSession().load('ocr',identity),null);const out=await f.load();assert.deepEqual(out.value.payload,f.payload);assert.equal(out.compatibility.version,'stage14r3-ocr-compatibility-v1');assert.equal(out.compatibility.legacyCheckpointRewritten,false);assert.equal(out.compatibility.newInferenceCalls,0);assert.deepEqual(await fs.readFile(file),before);
});
test('normal configuration calculation keeps the actual production fingerprint formula',async()=>{
 const f=await fixture();assert.equal(await computeOcrConfiguration(f.context),key({stage:'ocr',settings:ocrSettings(f.context),files:await fingerprintFiles(ocrRoots(f.context),{excludeFonts:true})}));
});
test('an exact current cache hit requires no compatibility policy or snapshot',async()=>{
 const f=await fixture(),dir=path.join(f.root,'current');await fs.mkdir(dir);const identity={configuration:await computeOcrConfiguration(f.context)},receipts={};await createCheckpointSession({directory:dir,jobId:'current',scope:f.scope,onCheckpoint:r=>{receipts[r.stage]=r;}}).save('ocr',identity,{current:true});
 const session=createCheckpointSession({directory:f.root,jobId:'next',scope:f.scope,resumeFrom:{directory:dir,jobId:'current',checkpoints:receipts}});const out=await createOcrCompatibilityAccess({policy:f.policy}).load({session,identity});assert.equal(out.value.payload.current,true);assert.equal(out.compatibility,null);
});
for(const [label,mutate]of [
 ['wrong owner',f=>{f.scope.ownerScope='b'.repeat(64);}],['wrong source',f=>{f.scope.sourceSha256='b'.repeat(64);}],['wrong normalized image',f=>{f.scope.normalizedSha256='b'.repeat(64);}],['wrong page',f=>{f.scope.pageId='other';}],['wrong generation',f=>{f.sourceEvidence.expectedGeneration=3;}],
 ['old snapshot bytes',async f=>{await fs.appendFile(path.join(f.snapshot,f.ocrRelative),' tampered');}],['changed OCR code',async f=>{await fs.writeFile(path.join(f.root,f.ocrRelative),'module.exports=74;');}],['changed model',async f=>{await fs.writeFile(f.context.config.regionDetectorModel,'different model');}],['changed worker',async f=>{await fs.writeFile(f.context.config.regionDetectorWorker,'different worker');}],
 ['OCR setting',f=>{f.context.config.refineConnectedOcr=false;}],['runtime reuse setting',f=>{f.context.reuseOcrRuntime=true;}],['unaudited engine source',async f=>{await fs.appendFile(f.context.engineFile,' unexpected');}],['unaudited translation source',async f=>{await fs.appendFile(path.join(f.root,f.translationRelative),' unexpected');}],
 ['checkpoint receipt',f=>{f.resumeFrom.checkpoints.ocr.sha256='b'.repeat(64);}],['checkpoint bytes',async f=>{await fs.appendFile(path.join(f.jobs,'checkpoint-ocr.json'),' corrupt');}],['source bytes',async f=>{await fs.writeFile(path.join(f.jobs,'source.png'),'different original');}],['normalized asset',async f=>{await fs.writeFile(path.join(f.jobs,'normalized.png'),'different normalized');}],
])test('compatibility refuses '+label+' and preserves the named original checkpoint',async()=>{
 const f=await fixture();await mutate(f);const file=path.join(f.jobs,'checkpoint-ocr.json'),before=await fs.readFile(file);await assert.rejects(f.load());assert.deepEqual(await fs.readFile(file),before);
});
test('a supplied current identity cannot substitute for freshly computed current dependencies',async()=>{
 const f=await fixture();await assert.rejects(createOcrCompatibilityAccess({policy:f.policy}).load({session:f.makeSession(),identity:{configuration:'f'.repeat(64)},context:f.context,scope:f.scope,resumeFrom:f.resumeFrom,sourceEvidence:f.sourceEvidence}));
});
test('lack of opt-in evidence is a miss, never fabricated compatibility or automatic inference',async()=>{
 const f=await fixture();const out=await createOcrCompatibilityAccess({policy:f.policy}).load({session:f.makeSession(),identity:{configuration:await computeOcrConfiguration(f.context)}});assert.equal(out.value,null);assert.equal(out.compatibility,null);
});
test('private HOME equivalence records nested empty directories and rejects every file',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r3-empty-home-'));await fs.mkdir(path.join(root,'.cache/paddle'),{recursive:true});const before=await inspectEmptyHomeTree(root);assert.deepEqual(before,['.cache',path.join('.cache','paddle')]);
 await fs.writeFile(path.join(root,'.cache/settings.json'),'{}');await assert.rejects(inspectEmptyHomeTree(root));
});
test('capturing a freshly hashed immutable dependency snapshot does not change the fingerprint',async()=>{
 const f=await fixture();let captured;const actual=await fingerprintFiles(ocrRoots(f.context),{excludeFonts:true,capture:value=>{captured=value;}});
 assert.ok(captured);assert.equal(key(captured.rows),actual);assert.equal(captured.sources.find(([p])=>p===f.context.engineFile)[1],await fs.readFile(f.context.engineFile,'utf8'));assert.ok(captured.directories.some(([p])=>p===f.context.resources));
});
test('a model changed after identity capture cannot reuse a stale in-memory snapshot',async()=>{
 const f=await fixture(),identity={configuration:await computeOcrConfiguration(f.context)};await fs.writeFile(f.context.config.regionDetectorModel,'model changed after capture');
 await assert.rejects(createOcrCompatibilityAccess({policy:f.policy}).load({session:f.makeSession(),identity,context:f.context,scope:f.scope,resumeFrom:f.resumeFrom,sourceEvidence:f.sourceEvidence}));
});
test('adding a resource after identity capture invalidates the captured directory layout',async()=>{
 const f=await fixture(),identity={configuration:await computeOcrConfiguration(f.context)};await fs.writeFile(path.join(f.context.resources,'unexpected-model.bin'),'new resource');
 await assert.rejects(createOcrCompatibilityAccess({policy:f.policy}).load({session:f.makeSession(),identity,context:f.context,scope:f.scope,resumeFrom:f.resumeFrom,sourceEvidence:f.sourceEvidence}),e=>e.code==='OCR_COMPATIBILITY_REJECTED'&&e.reason==='CURRENT_DEPENDENCY_CHANGED');
});
