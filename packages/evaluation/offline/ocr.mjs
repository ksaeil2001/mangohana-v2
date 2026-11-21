import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateAutomationQuality, stages } from '../../../apps/desktop/scripts/evaluate-automation-quality.mjs';
import { hash, requireValue } from './contract.mjs';
import { summarizeTextCoverage } from './text-coverage.mjs';

/** Stage02 is the sole implementation of IoU assignment, CER and micro CER. */
export async function evaluateOcrPages({runId,split,workspace,pages}) {
  requireValue(['dev','calibration'].includes(split),'INVALID_EVALUATION_SPLIT');
  await fs.mkdir(workspace,{recursive:false});
  const corpus={schemaVersion:1,datasetId:'stage06-'+split,pages:pages.map(p=>({id:p.pageId,workId:p.workId,duplicateGroupId:p.duplicateGroupId,
    usedForDevelopment:split === 'dev',split:'dev',source:p.source,groundTruth:p.groundTruth}))};
  const run={schemaVersion:1,runId,corpusSha256:hash(JSON.stringify(corpus)),codeIdentity:'stage06-adapter-reuses-stage02',models:{},pages:[]};
  for(let i=0;i<pages.length;i++) {
    const p=pages[i],entry={pageId:p.pageId,evidenceKind:p.evidenceKind === 'synthetic' ? 'fixture' : p.evidenceKind === 'cache_reuse' ? 'reused' : p.evidenceKind === 'not_run' ? 'not_run' : 'actual_component',
      stages:Object.fromEntries(stages.map(s=>[s,'not_run'])),durationMs:null,peakWorkingSetBytes:null,manualEdits:0,automaticRetries:0};
    if(p.finalOcr) {
      const bytes=Buffer.from(JSON.stringify(p.finalOcr)),file=path.join(workspace,`${i}.ocr.json`),provenanceFile=path.join(workspace,`${i}.provenance.json`);
      const provenance=Buffer.from(JSON.stringify({runId,sourceSha256:p.source.sha256,ocrSha256:hash(bytes)}));
      await fs.writeFile(file,bytes,{flag:'wx'});await fs.writeFile(provenanceFile,provenance,{flag:'wx'});
      entry.ocr={path:file,sha256:hash(bytes),provenance:{path:provenanceFile,sha256:hash(provenance)}};
    }
    run.pages.push(entry);
  }
  const report = await evaluateAutomationQuality(corpus, run, workspace);
  const textCoverage = pages.filter(page => page.textCoverageEvidence !== undefined).map(page => {
    const evidence = page.textCoverageEvidence;
    requireValue(evidence && typeof evidence === 'object' && [evidence.annotation, evidence.inventory]
      .every(value => !value || value.pageId === page.pageId && value.sourceSha256 === page.source.sha256),
      'TEXT_COVERAGE_COMPARISON_INVALID');
    const stage02Page = report.pages.find(row => row.pageId === page.pageId);
    return { pageId: page.pageId, evidenceKind: page.evidenceKind, ...summarizeTextCoverage({ ...evidence, stage02Page }) };
  });
  return textCoverage.length ? { ...report, textCoverage } : report;
}
