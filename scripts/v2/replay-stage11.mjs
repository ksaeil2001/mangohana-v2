// Re-evaluate saved strings and fixed Stage07 fixtures. Never run a model or edit a result.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {mutationCatalog,materializeCase} from '../../packages/evaluation/mutation/catalog.mjs';
const require=createRequire(import.meta.url),api=require('../../packages/ai-engine/quality/translation-contract.cjs');
const [audit,outputName='semantic-replay']=process.argv.slice(2);if(!path.isAbsolute(audit??'')||!/^[-a-z0-9]+$/.test(outputName))throw Error('absolute audit and safe output name required');
const digest=b=>createHash('sha256').update(b).digest('hex');
const compiled=await fs.mkdtemp(path.join(os.tmpdir(),'stage11-replay-ts-'));
execFileSync(process.execPath,['packages/ai-engine/node_modules/typescript/bin/tsc','-p','packages/ai-engine/tsconfig.json','--outDir',compiled],{windowsHide:true,stdio:'pipe'});
await fs.writeFile(path.join(compiled,'package.json'),'{"type":"module"}');
const {inspectTranslationQuality}=await import(pathToFileURL(path.join(compiled,'src/shared/translation/translationQa.js')).href);
const ts=require('../../packages/ai-engine/node_modules/typescript');
const historicalSource=await fs.readFile('apps/desktop/src/shared/translation/translationQa.ts','utf8');
const historicalFile=path.join(compiled,'stage07-qa.mjs');
await fs.writeFile(historicalFile,ts.transpileModule(historicalSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
const {inspectTranslationQuality:historicalQa}=await import(pathToFileURL(historicalFile).href);
const baseline=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
const evaluate=(source,translation)=>{
 const qa=inspectTranslationQuality({sourceText:source,translatedText:translation,dialogueType:'speech'});
 const risk=api.assessSemanticRisk({region:{sourceText:source,dialogueType:'speech',speaker:{name:null,confirmed:false}},translatedText:translation,qaReport:qa});
 return {ruleQa:qa,risk};
};
const synthetic=mutationCatalog().filter(c=>c.area==='semantic').map(c=>{
 const {mutant:value}=materializeCase(c);
 return {id:c.mutationId,label:c.label,truth:c.truth,oracleOrigin:c.oracleOrigin,source:value.source,translation:value.translation,historicalStage07RuleQa:historicalQa({sourceText:value.source,translatedText:value.translation}),baseline:inspectTranslationQuality({sourceText:value.source,translatedText:value.translation}),candidate:evaluate(value.source,value.translation),humanSemanticGt:false};
});
const saved=[];
for(const pin of baseline.protectedFiles.filter(r=>/translations\.json$/.test(r.path))){
 const bytes=await fs.readFile(pin.path);if(digest(bytes)!==pin.sha256)throw Error('saved translation pin mismatch');
 const value=JSON.parse(bytes);
 const rows=(value.lines??[]).map(line=>({id:line.id,source:line.sourceText,translation:line.aiTranslation,sourceLineIds:line.sourceLineIds??null,aiInterpretedSource:line.aiProposedSource??null,...evaluate(line.sourceText,line.aiTranslation)}));
 saved.push({path:pin.path,sha256:pin.sha256,rows,sourceBytesUnchanged:digest(await fs.readFile(pin.path))===pin.sha256,humanSemanticGt:false,scope:'SAVED_STRING_RISK_REPLAY_NOT_NEW_INFERENCE_OR_OCR_VERIFICATION'});
}
const defects=synthetic.filter(c=>c.truth==='defect'),controls=synthetic.filter(c=>c.truth==='normal');
const result={version:1,kind:'STAGE11_FIXED_SYNTHETIC_AND_SAVED_STRING_REPLAY',createdAt:new Date().toISOString(),synthetic,saved,
 summary:{syntheticDefects:defects.length,syntheticControls:controls.length,historicalStage07RuleQa100Defects:defects.filter(c=>c.historicalStage07RuleQa.score===100).length,preStage11VendorRuleQa100Defects:defects.filter(c=>c.baseline.score===100).length,defectsWithLimitedSignals:defects.filter(c=>c.candidate.risk.signals.length).length,defectsRoutedToSemanticReview:defects.filter(c=>c.candidate.risk.semanticReviewRequired).length,controlsWithSignals:controls.filter(c=>c.candidate.risk.signals.length).length,controlsDraftUsable:controls.filter(c=>c.candidate.risk.draftUsable).length,savedFiles:saved.length,savedLines:saved.reduce((n,s)=>n+s.rows.length,0),savedWithSignals:saved.flatMap(s=>s.rows).filter(r=>r.risk.signals.length).length},
 actualModelRuns:0,humanGtPages:0,realSemanticAccuracy:null,realSemanticImprovement:null,semanticSignalRecall:null,reason:'Warning heuristics and universal review routing do not constitute independent semantic error detection. Fixed synthetic meaning labels are not manga human GT.'};
await fs.writeFile(path.join(audit,'evidence',outputName+'.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result.summary));
