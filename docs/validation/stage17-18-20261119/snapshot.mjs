import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = fileURLToPath(new URL('.', import.meta.url));
const phase = process.argv[2];
if (!['before','after'].includes(phase)) throw Error('Use before or after');
const hash = file => createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex');
const json = file => JSON.parse(readFileSync(path.resolve(root, file), 'utf8').replace(/^\uFEFF/, ''));
const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8', windowsHide:true, maxBuffer:32*1024*1024});
const prev = phase === 'after' ? json(path.join(out, 'before.json')) : null;
const pinned = json('docs/validation/stage15-integration-20261118/protected-before.json');
const files = pinned.files.map(({kind,path:file,sha256}) => ({kind, file, expected:sha256, observed:existsSync(file)?hash(file):null}));
const audit = 'C:/dev/Projects/_audits/MangoHana_00_20261111_225834/';
const roadmap = json(audit+'roadmap-full-stage-sections.json');
const raw = readFileSync(audit+'roadmap-input-preserved.md','utf8').replace(/\r\n/g,'\n').split('\n');
const sections = roadmap.stages.map(s => ({
  id:s.id,title:s.title,line:s.line,endLine:s.endLine,
  exact:raw.slice(s.line-1,s.endLine).join('\n').trimEnd()===s.fullMarkdown.trimEnd(),
}));
const tracked = git('ls-files','-m','-z').split('\0').filter(Boolean);
const existing = prev ? Object.keys(prev.localFiles) : [...new Set([...tracked,
  ...git('ls-files','--others','--exclude-standard','-z','--','apps/engine','apps/sites/lib','apps/sites/components','apps/sites/checks','packages/evaluation','tests/v2','docs/validation/stage16-06-20261119','docs/validation/stage15-integration-20261118','docs/validation/stage14r3-human-readability-closeout-20261118').split('\0').filter(Boolean),
  'docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md',
  'apps/sites/lib/studio-files.ts','apps/sites/lib/studio-engine.ts','apps/sites/lib/studio-state.ts',
  'apps/sites/lib/studio-model.ts','apps/sites/components/studio.tsx','apps/sites/app/globals.css',
])].sort();
const localFiles = Object.fromEntries(existing.map(file=>[file,existsSync(path.resolve(root,file))?hash(file):null]));
const result = {timeUtc:new Date().toISOString(),node:process.version,branch:git('branch','--show-current').trim(),head:git('rev-parse','HEAD').trim(),
  roadmapSha256:hash(audit+'roadmap-input-preserved.md'),sectionsSha256:hash(audit+'roadmap-full-stage-sections.json'),sections,
  files,historicalOutcomes:pinned.outcomes,permits:pinned.permits,localFiles,
  changedSinceStart:prev?existing.filter(f=>localFiles[f]!==prev.localFiles[f]):[],
  gitStatus:git('status','--short','--branch','--untracked-files=normal').trimEnd().split(/\r?\n/)};
writeFileSync(path.join(out,phase+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({head:result.head,roadmap:result.roadmapSha256,stages:sections.map(s=>s.id),sectionsMatch:sections.every(s=>s.exact),protected:files.length,matched:files.filter(f=>f.observed===f.expected).length,localFiles:existing.length,changed:result.changedSinceStart}));
