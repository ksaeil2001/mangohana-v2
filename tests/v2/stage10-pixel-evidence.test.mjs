import test from 'node:test';
import assert from 'node:assert/strict';
import {outlinedFixture,oracleClean,measureFixture} from './stage10-mask-fixture.mjs';
import {mutationCatalog,materializeCase} from '../../packages/evaluation/mutation/catalog.mjs';
import {inspectTranslationQuality} from '../../apps/desktop/src/shared/translation/translationQa.ts';
const complete=f=>Uint8Array.from(f.core,(x,i)=>x||f.outline[i]||f.antialias[i]?255:0);
test('exact synthetic normal control has no residue or protected damage; preserved SFX is excluded from residue truth',()=>{
 const f=outlinedFixture(),mask=complete(f),r=measureFixture(f,mask,oracleClean(f,mask));assert.equal(r.residualPixels,0);assert.equal(r.protectedChangedPixels,0);assert.equal(r.outsideMaskChangedPixels,0);assert.equal(r.qualityApproval,false);
});
for(const [label,layer]of [['one source stroke','core'],['white halo','outline'],['gray AA','antialias']])test('exact oracle catches '+label+' left in cleaned image',()=>{
 const f=outlinedFixture(),mask=complete(f),cleaned=oracleClean(f,mask),i=f[layer].findIndex(Boolean);cleaned.set(f.source.subarray(i*4,i*4+4),i*4);assert.equal(measureFixture(f,mask,cleaned).residualPixels,1);
});
for(const [label,index]of [['balloon border',5*112+25],['adjacent character ink',48*112+57],['preserved SFX',22*112+88]])test('inside-mask '+label+' damage is detected even when outside changes are zero',()=>{
 const f=outlinedFixture(),mask=complete(f);mask[index]=255;const cleaned=oracleClean(f,mask);cleaned.set([210,210,210,255],index*4);const r=measureFixture(f,mask,cleaned);
 assert.equal(r.protectedChangedPixels,1);assert.equal(r.insideArtworkDamagePixels,1);assert.equal(r.outsideMaskChangedPixels,0);
});
test('an absent cleaned result remains unmeasured and a typeset overlay is rejected as the wrong comparison phase',()=>{
 const f=outlinedFixture(),mask=complete(f);assert.equal(measureFixture(f,mask,null).residualPixels,null);assert.equal(measureFixture(f,mask,null).status,'NOT_MEASURED');
 assert.throws(()=>measureFixture(f,mask,oracleClean(f,mask),{phase:'final-typeset'}),/TYPESETTING_OVERLAY/);
});
test('Stage07 SEM-R03 keeps its single-kana missed defect and does not become a pixel or human approval',()=>{
 const c=mutationCatalog().find(x=>x.mutationId==='SEM-R03'),r=materializeCase(c);assert.equal(r.mutant.translation,'고마워 あ');
 const qa=inspectTranslationQuality({sourceText:r.mutant.source,translatedText:r.mutant.translation,targetLanguage:'ko'});
 assert.equal(qa.passed,true);assert.equal(c.expectedDecision,'pass');
});
