// Audit the exact additive engine delta before pinning its version. Not a checkpoint migration.
import fs from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
const destination='docs/validation/stage14r3-imported-adapter-20261115/evidence',hash=b=>createHash('sha256').update(b).digest('hex');
const before=JSON.parse(await fs.readFile(path.join(destination,'source-before.json'))),census=JSON.parse(await fs.readFile(path.join(destination,'preservation.json')));
const file='packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs',old=before.find(row=>row.path===file).source.replace(/\r\n/g,'\n'),current=(await fs.readFile(file,'utf8')).replace(/\r\n/g,'\n');
const begin=current.indexOf('  // A separate server-only, read-only entry.'),end=current.indexOf('  async function cacheContext',begin);
if(begin<0||end<0)throw Error('AUDIT_EXPECTED_ADDITIVE_INSPECTION_SEAM');
const removed=current.slice(begin,end),stripped=(current.slice(0,begin)+current.slice(end))
 .replace("const { inspectImportedPageInputs } = require('../../../../quality/imported-page-input.cjs');\n",'')
 .replace('inspectInputReadiness, inspectImportedPageReadiness, run','inspectInputReadiness, run');
if(stripped!==old)throw Error('EXISTING_ENGINE_PROGRAM_CHANGED_REQUIRES_NEW_AUDIT');
const preserved=[];
for(const name of ['recovery-checkpoint.cjs','ocr-checkpoint-compatibility.cjs','human-translation-review.cjs','ocr-refinement.cjs','region-selection.cjs','source-line-roi.cjs','mask-evidence.cjs']){
 const p=path.resolve('packages/ai-engine/quality',name),row=census.sources.find(([f])=>f.toLowerCase()===p.toLowerCase()),sha256=hash(await fs.readFile(p));
 if(!row||row[1]!==sha256)throw Error('OWNING_CONTRACT_CHANGED: '+name);preserved.push({path:p,sha256,unchanged:true});
}
const added='packages/ai-engine/quality/imported-page-input.cjs',policyPath='packages/ai-engine/quality/ocr-compatibility-policy.json',policy=JSON.parse(await fs.readFile(policyPath));
const audit={status:'PASS_ADDITIVE_INPUT_INSPECTION_ONLY',engineBeforeSha256:before.find(row=>row.path===file).sha256,engineCurrentSha256:hash(await fs.readFile(file)),
 existingEngineProgramTextUnchangedAfterRemovingAuditedAddition:true,additiveFunction:removed,addedModuleSha256:hash(await fs.readFile(added)),preserved,
 basis:'Manual review plus exact removal comparison: only a read-only imported-page entry, import and public method exposure are added. Existing OCR acquisition, refinement, 75% source-line/ROI selection, checkpoint identity/load/save, image execution, mask and renderer paths are text-identical. New module reads original signed-import bindings, strict original checkpoints, current compatibility, immutable images and original mapping; it cannot run OCR, translate, inpaint, render, save checkpoints or issue a permit.',
 tests:'imported-page-input.test.mjs plus existing stage14r3-ocr-compatibility/Stage09/10/13 tests; current-engine/browser check remains required'};
await fs.writeFile(path.join(destination,'ocr-version-audit.json'),JSON.stringify(audit,null,2));
if(process.argv.includes('--apply')){
 policy.currentEngineSha256=audit.engineCurrentSha256;
 policy.allowedNonOcrChanges=policy.allowedNonOcrChanges.filter(row=>row.path!==added);policy.allowedNonOcrChanges.push({path:added,sha256:audit.addedModuleSha256});
 policy.justification+=' Imported-page input inspection version: exact removal comparison preserves every existing engine statement; added method and dependency are separately pinned and audited in docs/validation/stage14r3-imported-adapter-20261115/evidence/ocr-version-audit.json. Original and imported owner/revision/generation remain separate. Original strict loader and current compatibility policy both apply; no identity, receipt, fingerprint, checkpoint or source ownership is rewritten.';
 await fs.writeFile(policyPath,JSON.stringify(policy,null,2)+'\n');
}
console.log(JSON.stringify({status:audit.status,owningContractsUnchanged:preserved.length,engineSha256:audit.engineCurrentSha256,policyUpdated:process.argv.includes('--apply')}));
