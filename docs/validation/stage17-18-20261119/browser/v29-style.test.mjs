import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../../../',import.meta.url)),site=path.join(root,'apps/sites');
const postcss=createRequire(path.join(site,'package.json'))('postcss');
const mapping=JSON.parse(readFileSync(path.join(root,'docs/sites-source-v29.json'),'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
function declarations(css){
  const map=new Map();
  postcss.parse(css).walkDecls(d=>{
    const parents=[];
    for(let p=d.parent;p&&p.type!=='root';p=p.parent)parents.unshift(p.type==='atrule'?'@'+p.name+' '+p.params:p.selector);
    const key=JSON.stringify([...parents,d.prop]), values=map.get(key)??[];
    values.push(d.value+(d.important?' !important':''));map.set(key,values);
  });
  return map;
}
function compare(a,b){
  let identical=0,changed=0,missing=0;
  for(const [key,values] of a){
    if(!b.has(key))missing++;
    else if(JSON.stringify(b.get(key))===JSON.stringify(values))identical++;
    else changed++;
  }
  return {before:a.size,after:b.size,identical,changed,missing,added:[...b.keys()].filter(k=>!a.has(k)).length};
}
test('the Stage17 OCR controls extend the baseline stylesheet without losing existing declarations or v29 coverage',()=>{
  const file='app/globals.css', before=execFileSync('git',['show','HEAD:apps/sites/'+file],{cwd:root,encoding:'utf8'});
  const snapshot=JSON.parse(readFileSync(new URL('../before.json',import.meta.url),'utf8'));
  assert.equal(snapshot.gitStatus.some(s=>/^ M apps\/sites\/app\/globals\.css$/.test(s)),false);
  const original=readFileSync(path.join(mapping.preservedZipSource,file),'utf8'),current=readFileSync(path.join(site,file),'utf8');
  const v29=declarations(original),base=declarations(before),now=declarations(current);
  const oldComparison=compare(v29,base),currentComparison=compare(v29,now),change=compare(base,now);
  assert.equal(change.changed,0);assert.equal(change.missing,0);assert.ok(change.added>0);
  assert.equal(oldComparison.identical,currentComparison.identical);
  console.log('V29_CSS '+JSON.stringify({version:mapping.siteVersion,originalSha256:sha(original),headSha256:sha(before),currentSha256:sha(current),originalToHead:oldComparison,originalToCurrent:currentComparison,headToCurrent:change}));
});
