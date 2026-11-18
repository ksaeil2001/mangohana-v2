// Deterministic comparisons and read-only historical evidence. No model execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';
import sharp from 'sharp';
import {outlinedFixture,oracleClean,measureFixture} from '../../tests/v2/stage10-mask-fixture.mjs';
import {compareImagePixels} from '../../packages/evaluation/offline/quality.mjs';
import {mutationCatalog,materializeCase} from '../../packages/evaluation/mutation/catalog.mjs';
import {inspectTranslationQuality} from '../../apps/desktop/src/shared/translation/translationQa.ts';
const {buildSourceTextMask}=await tsImport('../../packages/ai-engine/vendor/trio/src/shared/sourceTextMask.ts',import.meta.url);
const [audit,packet='visual-review']=process.argv.slice(2);if(!audit||!/^[-a-z0-9]+$/.test(packet))throw Error('Fresh audit directory and simple packet name required');
const out=path.resolve(audit,packet);await fs.mkdir(out,{recursive:false});
const sha=b=>createHash('sha256').update(b).digest('hex'),pins=[],artifacts=[];
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function input(p){const bytes=await fs.readFile(p);pins.push({path:p,sha256:sha(bytes),bytes:bytes.length});return bytes;}
async function save(name,bytes,extra={}){await fs.writeFile(path.join(out,name),bytes,{flag:'wx'});artifacts.push({path:name,sha256:sha(bytes),bytes:bytes.length,...extra});return name;}
const saveJson=async(name,j)=>save(name,Buffer.from(JSON.stringify(j,null,2)));
const rgbaPng=(pixels,width,height)=>sharp(Buffer.from(pixels),{raw:{width,height,channels:4}}).png().toBuffer();
const grayPng=(pixels,width,height)=>sharp(Buffer.from(pixels),{raw:{width,height,channels:1}}).png().toBuffer();
function overlay(pixels,mask){const r=Buffer.from(pixels);for(let i=0;i<mask.length;i++)if(mask[i]){r[i*4]=255;r[i*4+1]=Math.round(r[i*4+1]*.35);r[i*4+2]=Math.round(r[i*4+2]*.35);}return r;}
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function sheet(name,panels,{scale=1,columns=4}={}){
 const w=Math.max(...panels.map(p=>p.width))*scale,h=Math.max(...panels.map(p=>p.height))*scale,label=28;
 const composite=[];for(const [i,p]of panels.entries()){
  const x=i%columns*w,y=Math.floor(i/columns)*(h+label);
  const fontSize=Math.min(15,Math.max(8,Math.floor((w-16)/(p.label.length*.6))));
  composite.push({input:Buffer.from(`<svg width="${w}" height="${label}"><rect width="100%" height="100%" fill="white"/><text x="8" y="19" font-size="${fontSize}" fill="black">${escape(p.label)}</text></svg>`),left:x,top:y});
  composite.push({input:await sharp(p.bytes).resize(p.width*scale,p.height*scale,{kernel:'nearest'}).png().toBuffer(),left:x,top:y+label});
 }
 return save(name,await sharp({create:{width:w*columns,height:Math.ceil(panels.length/columns)*(h+label),channels:4,background:'white'}}).composite(composite).png().toBuffer(),{kind:'DERIVED_COMPARISON_NOT_ORIGINAL'});
}
const f=outlinedFixture(),source={width:f.width,height:f.height,pixels:f.source};
const baseline=buildSourceTextMask(source,f.regions),candidate=buildSourceTextMask(source,f.regions,{outlinePolicy:'bounded-component-v1'});
const baseClean=oracleClean(f,baseline.pixels),candidateClean=oracleClean(f,candidate.pixels);
const synthetic={scope:'DETERMINISTIC_SYNTHETIC_PIXEL_ORACLE_NOT_LAMA_NOT_HUMAN_GT',pageId:'synthetic-stage10-outline-01',width:f.width,height:f.height,regions:f.regions,
 fixed:{source:true,selection:true,normalized:true,protection:true,restoration:'SAME_EXACT_BACKGROUND_COMPOSITOR',resolution:true,evaluator:'stage10-fixture-v1'},
 baseline:measureFixture(f,baseline.pixels,baseClean),candidate:measureFixture(f,candidate.pixels,candidateClean),candidateDefaultAdopted:false,
 baselineMaskPixels:baseline.maskedPixels,candidateMaskPixels:candidate.maskedPixels,reviewRequiredRegions:{numerator:1,denominator:1},humanGroundTruthPages:0};
const panels=[];
for(const [name,label,pixels,gray]of [
 ['synthetic-source.png','Synthetic source',f.source,false],['synthetic-core-gt.png','Core truth',f.core,true],
 ['synthetic-outline-gt.png','White outline truth',f.outline,true],['synthetic-protection-gt.png','Protection truth',f.protection,true],
 ['synthetic-mask-A.png','A default mask',baseline.pixels,true],['synthetic-mask-candidate.png','Opt-in component mask',candidate.pixels,true],
 ['synthetic-cleaned-A-oracle.png','A known-background composite',baseClean,false],['synthetic-cleaned-candidate-oracle.png','Candidate known background',candidateClean,false]]){
 const bytes=await(gray?grayPng(pixels,f.width,f.height):rgbaPng(pixels,f.width,f.height));await save(name,bytes,{scope:'SYNTHETIC',coordinates:'page-pixels'});panels.push({bytes,label,width:f.width,height:f.height});
}
await sheet('synthetic-comparison.png',panels,{scale:4});
await save('synthetic-aa-gt.png',await grayPng(f.antialias,f.width,f.height));
const diff=Buffer.alloc(f.source.length,255);for(let i=0;i<diff.length;i+=4)for(let c=0;c<3;c++)diff[i+c]=Math.abs(baseClean[i+c]-candidateClean[i+c]);
await save('synthetic-cleaned-difference.png',await rgbaPng(diff,f.width,f.height));
await save('synthetic-selection.png',await sharp(await rgbaPng(f.source,f.width,f.height)).composite([{input:Buffer.from('<svg width="112" height="96"><rect x="22" y="20" width="36" height="48" fill="none" stroke="#00a050"/></svg>')}]).png().toBuffer());
await saveJson('synthetic-metrics.json',synthetic);
const semCase=mutationCatalog().find(c=>c.mutationId==='SEM-R03'),sem=materializeCase(semCase);
await saveJson('stage07-single-kana.json',{mutationId:semCase.mutationId,source:sem.mutant.source,translation:sem.mutant.translation,qa:inspectTranslationQuality({sourceText:sem.mutant.source,translatedText:sem.mutant.translation}),verdict:'MISSED',scope:'EXISTING_STRING_RULE_NOT_PIXEL_RESIDUE_DETECTOR',humanApproval:false});

const outputs='E:/Dev/Outputs/MangohanaV2-20261111',job=path.join(outputs,'one-page-2026-11-10T20-01-08.395Z-6efc5c11/jobs/81b6e9cf-ed3b-49da-b78a-2f4e598a3f19');
const historical={scope:'READ_ONLY_ARCHIVED_OUTPUTS_NOT_STAGE10_MODEL_EXECUTION',humanGroundTruthPages:0,newModelCalls:0,sourceResidue:null,whiteHalo:null,insideArtworkDamage:null,preservedSfxDamage:null,reason:'NO_INDEPENDENT_PIXEL_OR_HUMAN_GT'};
const historicalBytes={};for(const [key,file]of [['source','source.png'],['normalized','normalized.png'],['cleaned','cleaned.png'],['A','removal-mask.png']]){
 const p=path.join(job,file),bytes=await input(p);historicalBytes[key]=bytes;await save('historical-'+key+'.png',bytes,{scope:'EXACT_ARCHIVED_BYTES',origin:p});
}
const normalized=await sharp(historicalBytes.normalized).ensureAlpha().raw().toBuffer({resolveWithObject:true}),original=await sharp(historicalBytes.source).ensureAlpha().raw().toBuffer();
historical.width=normalized.info.width;historical.height=normalized.info.height;historical.sourceSha256=sha(historicalBytes.source);historical.normalizedSha256=sha(historicalBytes.normalized);historical.sameDecodedSourceAndNormalized=original.equals(normalized.data);
historical.defaultPixels=await compareImagePixels({source:historicalBytes.normalized,cleaned:historicalBytes.cleaned,removal:{bytes:historicalBytes.A,encoding:'studio_inverse_alpha'}});
const learnedRoot=path.join(outputs,'vision-text-mask-stdio-2026-11-10T20-54-05.027Z'),v3Root=path.join(outputs,'vision-v3-stdio-actual-three-20261110T221946556Z');
const bReport=JSON.parse(await input(path.join(learnedRoot,'verification.json'))),cReport=JSON.parse(await input(path.join(v3Root,'verification.json'))),b=bReport.results[0],c=cReport.results[0];
const candidateReports=[];
for(const [label,dir,report]of [['B',learnedRoot,b],['C',v3Root,c]]){
 const bytes=await input(path.join(dir,'001-mask-rgba.png')),gray=await input(path.join(dir,'001-mask-l.png'));
 if(sha(bytes)!==report.maskRgbaSha256||sha(gray)!==report.maskSha256||report.imageSha256!==historical.sourceSha256)throw Error('ARCHIVE_HASH_MISMATCH');
 historicalBytes[label]=bytes;await save('historical-mask-'+label+'.png',bytes,{scope:'ARCHIVED_CANDIDATE_NO_NEW_INFERENCE',algorithm:report.algorithm});
 const data=await sharp(bytes).ensureAlpha().raw().toBuffer(),mask=Uint8Array.from({length:data.length/4},(_,i)=>255-data[i*4+3]);
 await save('historical-overlay-'+label+'.png',await rgbaPng(overlay(normalized.data,mask),historical.width,historical.height));
 candidateReports.push({label,algorithm:report.algorithm,sourceImageSha256:report.imageSha256,sourceRegions:report.sourceRegions,width:report.width,height:report.height,maskSha256:sha(bytes),maskPixels:mask.filter(Boolean).length,qualityStatus:report.qualityStatus});
}
historical.archivedCandidates=candidateReports;
historical.archivedBCFixed={sameSourceBytes:b.imageSha256===c.imageSha256,sameRegions:JSON.stringify(b.sourceRegions)===JSON.stringify(c.sourceRegions),sameResolution:b.width===c.width&&b.height===c.height,sameModel:b.model.sha256===c.model.sha256,protectionGroundTruthAvailable:false,cleanedOutputForBAndCAvailable:false};
historical.fullABCControlledComparison=false;historical.abcReason='A_USED_DIFFERENT_OCR_SELECTION_AND_NORMALIZED_ENCODING; B_C_HAVE_NO_MATCHED_CLEANED_OR_HUMAN_PROTECTION_GT';
const radialDir=path.join(outputs,'vision-experimental-radial-lama-stage-20261110T212703195Z');
const radialReport=JSON.parse(await input(path.join(radialDir,'stage-result.json'))),radial=await input(path.join(radialDir,'stage-cleaned.png'));
if(radialReport.sourceSha256!==historical.normalizedSha256||radialReport.result.verification.cleanedSha256!==sha(radial))throw Error('ARCHIVED_CLEANED_BINDING_MISMATCH');
historical.archivedRadialRestoration={scope:'OLDER_EXPERIMENT_NOT_STAGE10_OR_V3_CLEANED',sourceSha256:radialReport.sourceSha256,maskSha256:radialReport.maskSha256,cleanedSha256:sha(radial),cleanupConfirmed:radialReport.result.verification.cleanupConfirmed,sourceReportSha256:sha(Buffer.from(await fs.readFile(path.join(radialDir,'stage-result.json'))))};
await save('historical-radial-cleaned.png',radial,{scope:'OLDER_LAMA_EXPERIMENT_NOT_STAGE10_CANDIDATE'});
const maskA=await sharp(historicalBytes.A).ensureAlpha().raw().toBuffer();
const maskADisplay=await grayPng(Uint8Array.from({length:maskA.length/4},(_,i)=>255-maskA[i*4+3]),historical.width,historical.height);
await save('historical-A-remove-gray.png',maskADisplay,{scope:'DERIVED_ALPHA_INVERSE_FOR_DISPLAY',remove:255,preserve:0});
const crops=[];for(const [i,r]of b.sourceRegions.entries()){
 const left=Math.max(0,Math.floor(r.bbox.x*historical.width)-16),top=Math.max(0,Math.floor(r.bbox.y*historical.height)-16);
 const rect={left,top,width:Math.min(historical.width-left,Math.ceil(r.bbox.width*historical.width)+32),height:Math.min(historical.height-top,Math.ceil(r.bbox.height*historical.height)+32)};
 const cropPanels=[];for(const [label,bytes]of [['Source',historicalBytes.normalized],['A removal=white',maskADisplay],['A cleaned (old)',historicalBytes.cleaned],['Radial (old)',radial]]){
  const part=await sharp(bytes).extract(rect).png().toBuffer();cropPanels.push({label,bytes:part,width:rect.width,height:rect.height});
 }
 const name='historical-region-'+String(i+1).padStart(2,'0')+'-comparison.png';await sheet(name,cropPanels);crops.push({id:r.id,rectPx:rect,file:name,sourceFrame:'normalized-page-pixels',humanReview:null});
}
await saveJson('historical-observations.json',historical);
await saveJson('human-review.json',{status:'HUMAN_GT_PENDING',humanReviewer:null,reviewedAt:null,syntheticHumanGroundTruth:false,actualHumanGroundTruthPages:0,crops,requiredAxes:['source core residue','white outline/AA','balloon border','character ink','preserved SFX','uncertain overlapping ink'],instruction:'Inspect cleaned images before typesetting. Older radial cleaned is historical, not the Stage10 candidate. Record exact page-pixel rectangles and uncertainty. No automatic approval.'});
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><title>Stage10 마스크 비교</title><style>body{font:16px system-ui;margin:28px;background:#f5f4f0;color:#222}img{max-width:100%;height:auto;background:white}article{background:white;padding:18px;margin:20px 0}a{color:#174e86}small{display:block}</style><h1>Stage10 마스크 비교 · 사람 검수 대기</h1><p>합성 픽셀 정답, 저장된 실제 이미지, 새 추론과 사람 검수를 구분합니다. 이 자료로 자동 승인하지 않습니다.</p><article><h2>결정적 합성 비교</h2><p>복원은 알려진 합성 배경 합성이며 LaMa가 아닙니다. 기본 마스크는 유지합니다.</p><img src="synthetic-comparison.png"><p><a href="synthetic-metrics.json">픽셀 분모·정답 출처</a> · <a href="synthetic-cleaned-difference.png">cleaned 차이</a> · <a href="synthetic-selection.png">선택 영역</a></p></article><h2>저장 실제 이미지 · 새 Stage10 출력 아님</h2><p>원문 잔상은 cleaned에서 확인합니다. 오른쪽은 과거 radial 실험이며 Stage10/v3 복원 후보가 아닙니다. 사람 정답과 실제 개선 효과는 미측정입니다.</p>${crops.map(r=>`<article><h3>${escape(r.id)}</h3><small>normalized pixel rect ${JSON.stringify(r.rectPx)}</small><img src="${r.file}"></article>`).join('')}<article><h2>기존 learned/v3 마스크</h2><p>B/C는 같은 저장 원본·ROI·모델의 과거 출력입니다. 보호 정답과 같은 조건의 cleaned가 없어 품질 우열을 매기지 않습니다.</p><a href="historical-overlay-B.png">B overlay</a> · <a href="historical-overlay-C.png">C overlay</a></article><p><a href="human-review.json">빈 사람 검수 양식</a> · <a href="historical-observations.json">실제 저장 증거/한계</a> · <a href="manifest.json">출처·해시</a></p></html>`;
await save('index.html',Buffer.from(html));
for(const pin of pins)if(sha(await fs.readFile(pin.path))!==pin.sha256)throw Error('HISTORICAL_INPUT_CHANGED');
await saveJson('manifest.json',{createdAt:new Date().toISOString(),generator:'scripts/v2/build-stage10-review.mjs',generatorSha256:sha(await fs.readFile(new URL(import.meta.url))),newModelCalls:0,syntheticMethod:'INTEGER_RASTER_PRIMITIVES_EXACT_BACKGROUND_COMPOSITE',sourcePins:pins,artifacts});
console.log(JSON.stringify({out,synthetic,archivedBCFixed:historical.archivedBCFixed,oldOutsideMaskChangedPixels:historical.defaultPixels.outsideMaskChangedPixels,humanGroundTruthPages:0,actualResidualQuality:'NOT_MEASURED'}));
