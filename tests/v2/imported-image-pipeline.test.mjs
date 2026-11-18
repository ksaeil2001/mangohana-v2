import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);let api={};try{api=require('../../packages/ai-engine/quality/imported-image-pipeline.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function fixture(){
 const phases=[],calls=[],lines=Array.from({length:13},(_,i)=>({id:'r'+i,sourceText:'原文',order:i+1,pageNumber:1,userTranslation:'사용자 선택 '+i,aiTranslation:'원래 AI '+i,riskSignals:i===0?[{code:'RISK'}]:[]}));
 const inputs={status:'IMPORTED_PAGE_INPUTS_READY',lines,ocrRegions:13,userTranslationsUsable:13,current:{ownerScope:'owner',projectId:'project',pageId:'page',pageNumber:1,editRevision:1,contextRevision:0},source:{processingGeneration:2},application:{selectedSetSha256:'selected'}};
 const permit={permitId:'permit',executionGeneration:'new-generation',approvedPages:['page'],maximumExecutions:1,binding:{ownerScope:'owner',projectId:'project',pageId:'page',pageNumber:1,editRevision:1,contextRevision:0,selectedSetSha256:'selected'}};
 const signal=new AbortController().signal;
 const ports={verifyInputs:async()=>{calls.push('inputs');return {width:16,height:16};},prepare:async()=>{calls.push('prepare');return lines.map(({userTranslation,aiTranslation,riskSignals,...l})=>l);},
  inpaint:async()=>{calls.push('lama');return {bytes:Buffer.from('cleaned'),verification:{cleanupConfirmed:true}};},
  render:async({renderLines})=>{calls.push('render');assert.deepEqual(renderLines.map(l=>l.aiTranslation),lines.map(l=>l.userTranslation));assert.ok(renderLines.every(l=>l.userTranslation===undefined));return {pngBytes:Buffer.from('synthetic result'),layouts:[],identity:{}};},
  persistCleaned:async()=>({kind:'SYNTHETIC_CLEANED_DIAGNOSTIC'}),persistLayouts:async()=>({kind:'SYNTHETIC_LAYOUT_DIAGNOSTIC'}),inspectBackgrounds:async()=>({version:4,stage:'before-typeset-backgrounds',regions:lines.map(l=>({id:l.id,order:l.order,backgroundStatus:'SAFE_PIXELS_VERIFIED',textFitStatus:'PENDING',finalRasterStatus:'PENDING'})),blocked:0}),
  validate:async()=>{calls.push('validate');},cleanup:async()=>{calls.push('cleanup');}};
 return {inputs,permit,signal,phases,calls,ports,revalidate:async phase=>{phases.push(phase);}};
}
test('pipeline uses only selected thirteen texts and retains AI and warnings in receipt report',async()=>{
 assert.equal(typeof api.executeImportedImagePipeline,'function','missing permitted image pipeline');const f=fixture(),before=JSON.stringify(f.inputs),out=await api.executeImportedImagePipeline(f,f.ports);
 assert.deepEqual(f.calls,['inputs','prepare','lama','render','validate','cleanup']);assert.equal(JSON.stringify(f.inputs),before);assert.deepEqual(out.report.lines,f.inputs.lines);assert.equal(out.report.sourceProcessingGeneration,2);assert.equal(out.report.executionGeneration,'new-generation');assert.equal(out.report.actualCalls.ocr,0);assert.equal(out.report.actualCalls.gemma,0);assert.equal(out.cleanupConfirmed,true);
 assert.ok(f.phases.includes('before-lama'));assert.ok(f.phases.includes('after-lama'));assert.ok(f.phases.includes('before-typeset'));assert.ok(f.phases.includes('after-typeset'));
});
for(const failure of ['inputs','prepare','lama','render','validate'])test('pipeline stops on '+failure+' error, cleans up and never infers OCR or Gemma',async()=>{
 assert.equal(typeof api.executeImportedImagePipeline,'function');const f=fixture(),name={inputs:'verifyInputs',prepare:'prepare',lama:'inpaint',render:'render',validate:'validate'}[failure];f.ports[name]=async()=>{throw Object.assign(Error('injected'),{code:'INJECTED'});};await assert.rejects(api.executeImportedImagePipeline(f,f.ports),{code:'INJECTED'});assert.equal(f.calls.at(-1),'cleanup');
});
test('missing permit or a rejected live gate blocks LaMa and typeset',async()=>{
 assert.equal(typeof api.executeImportedImagePipeline,'function');const f=fixture();await assert.rejects(api.executeImportedImagePipeline({...f,permit:null},f.ports));assert.ok(!f.calls.includes('lama'));f.revalidate=async()=>{throw Error('no approval');};await assert.rejects(api.executeImportedImagePipeline(f,f.ports));assert.ok(!f.calls.includes('lama'));
});
test('verified cleaned evidence is committed before a later layout rejection and failure retains call counts',async()=>{
 const f=fixture();f.ports.persistCleaned=async()=>{f.calls.push('save-cleaned');return{kind:'DIAGNOSTIC',directory:'synthetic-only'};};
 f.ports.render=async()=>{f.calls.push('render');throw Object.assign(Error('blocked'),{code:'MANUAL_LAYOUT_REQUIRED',layoutDiagnostics:{version:3,regions:[{id:'r0',fontSizePx:null}]}});};
 f.ports.persistLayouts=async({diagnostics})=>{if(diagnostics.stage==='before-typeset-backgrounds'){assert.equal(diagnostics.regions.length,13);f.calls.push('save-backgrounds');return{kind:'BACKGROUND_DIAGNOSTIC'};}assert.equal(diagnostics.regions[0].fontSizePx,null);f.calls.push('save-layout');return{kind:'LAYOUT_DIAGNOSTIC'};};
 let error;try{await api.executeImportedImagePipeline(f,f.ports);}catch(e){error=e;}
 assert.deepEqual(f.calls,['inputs','prepare','lama','save-cleaned','save-backgrounds','render','save-layout','cleanup']);assert.equal(error.code,'MANUAL_LAYOUT_REQUIRED');assert.equal(error.diagnosticArtifacts.cleaned.kind,'DIAGNOSTIC');assert.equal(error.diagnosticArtifacts.background.kind,'BACKGROUND_DIAGNOSTIC');assert.equal(error.actualCalls.lama,1);assert.equal(error.actualCalls.ocr,0);
});
test('cancellation after cleaned capture retains that artifact and never starts typeset',async()=>{
 const f=fixture(),c=new AbortController();f.signal=c.signal;f.revalidate=async phase=>{if(phase==='before-background-inspection')c.abort();};let error;try{await api.executeImportedImagePipeline(f,f.ports);}catch(e){error=e;}assert.equal(error.name,'AbortError');assert.equal(error.diagnosticArtifacts.cleaned.kind,'SYNTHETIC_CLEANED_DIAGNOSTIC');assert.equal(error.actualCalls.renderer,0);assert.equal(error.cleanupConfirmed,true);
});
test('incomplete or duplicate background diagnostics cannot authorize typeset',async()=>{
 const f=fixture();f.ports.inspectBackgrounds=async()=>({version:4,regions:f.inputs.lines.map(()=>({id:'r0',backgroundStatus:'SAFE_PIXELS_VERIFIED'})),blocked:0});await assert.rejects(api.executeImportedImagePipeline(f,f.ports),{code:'BACKGROUND_DIAGNOSTICS_INVALID'});assert.ok(!f.calls.includes('render'));
});
test('cleaned evidence write failure prevents typesetting and keeps cleanup/error evidence',async()=>{
 const f=fixture();f.ports.persistCleaned=async()=>{throw Object.assign(Error('disk'),{code:'ENOSPC'});};await assert.rejects(api.executeImportedImagePipeline(f,f.ports),{code:'ENOSPC'});assert.ok(!f.calls.includes('render'));assert.equal(f.calls.at(-1),'cleanup');
});
for(const missing of ['persistCleaned','persistLayouts','inspectBackgrounds'])test('missing mandatory diagnostic port '+missing+' blocks before LaMa',async()=>{
 const f=fixture();f.ports.persistCleaned=async()=>({});f.ports.persistLayouts=async()=>({});f.ports.inspectBackgrounds=async()=>({version:4,stage:'before-typeset-backgrounds',regions:[],blocked:0});delete f.ports[missing];
 await assert.rejects(api.executeImportedImagePipeline(f,f.ports),{code:'DIAGNOSTIC_PORTS_REQUIRED'});assert.ok(!f.calls.includes('lama'));assert.equal(f.calls.at(-1),'cleanup');
});
test('all thirteen actual backgrounds are saved before typeset and one blocker retains every region',async()=>{
 const f=fixture(),regions=f.inputs.lines.map(l=>({id:l.id,order:l.order,backgroundStatus:l.order===4?'MANUAL_LAYOUT_REQUIRED':'SAFE_PIXELS_VERIFIED',finalRasterStatus:'PENDING'}));
 f.ports.persistCleaned=async()=>({kind:'CLEANED'});f.ports.inspectBackgrounds=async()=>({version:4,stage:'before-typeset-backgrounds',regions,blocked:1});f.ports.persistLayouts=async({diagnostics})=>{assert.deepEqual(diagnostics.regions,regions);f.calls.push('save-backgrounds');return {kind:'LAYOUT_DIAGNOSTIC'};};
 let e;try{await api.executeImportedImagePipeline(f,f.ports);}catch(error){e=error;}assert.equal(e?.code,'MANUAL_LAYOUT_REQUIRED');assert.equal(e.actualCalls.renderer,0);assert.equal(e.layoutDiagnostics.regions.length,13);assert.equal(e.diagnosticArtifacts.background.kind,'LAYOUT_DIAGNOSTIC');assert.ok(!f.calls.includes('render'));assert.equal(f.calls.filter(x=>x==='save-backgrounds').length,1);
});
