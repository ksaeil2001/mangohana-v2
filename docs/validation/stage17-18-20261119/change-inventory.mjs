import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const dir=fileURLToPath(new URL('.',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const before=JSON.parse(readFileSync(path.join(dir,'before.json')));
const after=JSON.parse(readFileSync(path.join(dir,'after.json')));
const modified=[...after.changedSinceStart,'tests/v2/result.test.mjs'];
const created=['apps/sites/checks/stage17-studio.test.mjs','apps/sites/checks/stage17-export-name.test.mjs',
  'packages/evaluation/stage17-release.mjs','packages/evaluation/stage18-operations.mjs',
  'scripts/v2/review-release.mjs','scripts/v2/review-change.mjs',
  'tests/v2/stage17-release.test.mjs','tests/v2/stage18-operations.test.mjs',
  'docs/superpowers/plans/2026-11-19-mangohana-v2-stage17-18.md','docs/superpowers/handoffs/2026-11-19-stage17-handoff.md',
  'docs/superpowers/handoffs/2026-11-19-stage18-handoff.md','docs/validation/2026-11-19-v2-stage17-18.md'];
const rows=modified.map(file=>{
  const snapped=Object.hasOwn(before.localFiles,file);
  if(!snapped&&before.gitStatus.some(s=>s.endsWith(' '+file)))throw Error('Initial file is dirty and unpinned '+file);
  const prior=snapped?before.localFiles[file]:sha(execFileSync('git',['show',before.head+':'+file],{cwd:root}));
  return {file,change:'modified',beforeSha256:prior,beforeSource:snapped?'workspace snapshot':'clean tracked HEAD blob',afterSha256:sha(readFileSync(path.join(root,file)))};
});
for(const file of created)rows.push({file,change:'added',beforeSha256:null,afterSha256:sha(readFileSync(path.join(root,file)))});
const evidence={head:after.head,branch:after.branch,checkedBaselineFiles:Object.keys(before.localFiles).length,
  baselineFilesChanged:after.changedSinceStart,baselineFilesWithSameDigest:Object.keys(before.localFiles).length-after.changedSinceStart.length,
  initialStatusRows:before.gitStatus.length-1,finalStatusRows:after.gitStatus.length-1,rows,
  evidenceDirectory:'docs/validation/stage17-18-20261119',evidenceFiles:'Command receipts carry individual input and log digests.'};
writeFileSync(path.join(dir,'change-inventory.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
