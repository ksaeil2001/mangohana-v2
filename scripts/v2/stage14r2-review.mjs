// Offline audit/review packet only. Never imports or starts the engine.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {parsePageTranslationResponse}=require('../../packages/ai-engine/quality/page-translation.cjs');
const {validateTranslationBatch,pagePromptData}=require('../../packages/ai-engine/quality/translation-contract.cjs');
const sha=x=>createHash('sha256').update(x).digest('hex');
const clone=x=>structuredClone(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const must=(ok,code='REVIEW_EVIDENCE_MISMATCH')=>{if(!ok)fail(code,'검토 자료의 원본·번역·영역 대응을 확인하세요.');};
const validText=s=>typeof s==='string'&&s.trim().length>0&&s.length<=4000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const decisions=['ACCEPT_AS_IS','CORRECT_TRANSLATION','OCR_CORRECTION_REQUIRED','NEEDS_MORE_CONTEXT','REJECT'];
const classes=['UNTRANSLATED_SOURCE_TEXT','INTENTIONALLY_PRESERVED_TERM','CHARACTER_NAME_OR_TITLE','TRANSLITERATION_OR_SCRIPT_POLICY','POSSIBLE_OCR_ERROR','POSSIBLE_FALSE_POSITIVE','INCONCLUSIVE'];
const packetHash=packet=>{const {packetSha256,...data}=packet;return sha(JSON.stringify(data));};

export function collectResidueReview({input,response,translations,ocr,gate,bindings,images=[],analysis={}}){
 const {fingerprint,...unsigned}=input;must(fingerprint===sha(JSON.stringify(unsigned)));
 for(const key of ['translationInputSha256','responseSha256','normalizedSha256'])must(/^[a-f0-9]{64}$/.test(bindings[key]??''));
 must(/^[a-f0-9]{64}$/.test(input.scope?.sourceSha256??''));
 const parsed=parsePageTranslationResponse(response,input.regions);
 must(translations.lines?.length===parsed.length&&translations.records?.length===parsed.length);
 for(const list of [translations.lines,translations.records])must(new Set(list.map(r=>r.id)).size===parsed.length&&list.every(r=>parsed.some(p=>p.id===r.id)));
 const results=parsed.map(p=>{
  const line=translations.lines.find(x=>x.id===p.id),record=translations.records.find(x=>x.id===p.id);
  must(line.sourceText===p.sourceText&&line.aiTranslation===p.translatedText);
  if(record.rawTranslatedText!==undefined)must(record.rawTranslatedText===p.rawTranslatedText);
  return {...p,qaReport:clone(record.qaReport)};
 });
 const validated=validateTranslationBatch({input,results}),prompt=pagePromptData(input);
 const flagged=validated.filter(r=>r.semantic.signals.some(s=>s.code==='SOURCE_LANGUAGE_RESIDUE'));
 const fromGate=gate.flagged?.filter(r=>(r.riskCodes??r.codes??[]).includes('SOURCE_LANGUAGE_RESIDUE')).map(r=>r.id);
 must(Array.isArray(fromGate)&&new Set(fromGate).size===fromGate.length&&same([...fromGate].sort(),flagged.map(r=>r.id).sort()));
 const raw=JSON.parse(response.choices[0].message.content);
 const contextRow=r=>({regionId:r.id,sourceText:r.sourceText,translation:parsed.find(p=>p.id===r.id).rawTranslatedText,status:'AI_PROPOSED_NOT_HUMAN_VERIFIED'});
 const regions=flagged.map(r=>{
  const region=input.regions.find(x=>x.id===r.id),group=ocr.speechBubbles?.find(x=>x.id===r.id),i=input.regions.indexOf(region);
  must(group?.text===region.sourceText);
  const candidate=analysis[r.id]??{classification:'INCONCLUSIVE',note:'추가 AI 분석 또는 사람 검토 필요'};must(classes.includes(candidate.classification));
  const text=raw.regions.find(x=>x.id===r.id).translation;
  const japaneseSpans=[...text.matchAll(/[\u3040-\u30ff]+/g)].map(m=>({text:m[0],startUtf16:m.index,endUtf16:m.index+m[0].length,codePoints:[...m[0]].map(c=>'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0'))}));
  return {pageId:input.scope.pageId,regionId:r.id,order:region.order,sourceText:region.sourceText,
   rawOcrText:group.productionOcrProvenance?.recognition?.rawOcrText??null,proposedSource:r.proposedSource,
   translatedText:text,parsedTranslatedText:r.translatedText,sourceTextSha256:sha(region.sourceText),translationSha256:sha(text),
   japaneseSpans,fullSentenceContainingJapanese:text,sourceImage:clone(images.find(x=>x.regionId===r.id)??null),bbox:clone(group.bbox??null),
   context:{previous:input.regions.slice(Math.max(0,i-2),i).map(contextRow),next:input.regions.slice(i+1,i+3).map(contextRow),verifiedPrevious:clone(input.context.previousVerified??[]),speaker:clone(region.speaker??{confirmed:false,name:null})},
   confirmedTerms:clone(prompt.terms.filter(t=>t.targetRegionIds.includes(r.id))),contextRevision:input.context.revision,
   qaReport:clone(r.qaReport),signals:clone(r.semantic.signals),detection:{function:'assessSemanticRisk',file:'packages/ai-engine/quality/translation-contract.cjs',condition:'/[\\u3040-\\u30ff]/.test(translatedText)',classification:'LIMITED_RULE_RISK_SIGNAL',confirmedError:false,severity:'warning',scope:'HIRAGANA_KATAKANA_BLOCK_NOT_ALL_JAPANESE'},
   analysis:{...clone(candidate),authority:'AI_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH'},
   humanReview:{status:'HUMAN_REVIEW_PENDING',decision:null,reviewer:null,correctedTranslation:null,confirmed:false},additionalModelInferenceRequiredForClassification:false};
 });
 const packet={schemaVersion:'stage14r2-residue-review-v1',status:'HUMAN_REVIEW_PENDING',scope:clone(input.scope),
  bindings:{...clone(bindings),sourceSha256:input.scope.sourceSha256,inputFingerprint:input.fingerprint,rawContentSha256:sha(response.choices[0].message.content)},
  allRegionIds:input.regions.map(r=>r.id),allResponses:input.regions.map(contextRow),regions,
  outputContract:{allRegionIdsValid:true,stage11StructuralValid:true,contentBytes:Buffer.byteLength(response.choices[0].message.content),reasoningBytes:Buffer.byteLength(response.choices[0].message.reasoning_content??''),finishReason:response.choices[0].finish_reason,usage:clone(response.usage??null)},
  policy:{automaticApproval:false,humanApprovalVerified:false,executionAuthorized:false,unflaggedIsNotSemanticApproval:true,reviewFormDoesNotApplyToEngine:true}};
 packet.packetSha256=packetHash(packet);return packet;
}

export function makeHumanReviewTemplate(packet){
 return {schemaVersion:'stage14r2-human-submission-v1',status:'HUMAN_REVIEW_PENDING',packetSha256:packet.packetSha256,
  pageId:packet.scope.pageId,projectId:packet.scope.projectId,owner:packet.scope.owner,sourceSha256:packet.scope.sourceSha256,bindings:clone(packet.bindings),
  reviewer:'',submittedAt:null,humanApprovalVerified:false,
  regions:packet.regions.map(r=>({pageId:r.pageId,regionId:r.regionId,sourceText:r.sourceText,translatedText:r.translatedText,sourceTextSha256:r.sourceTextSha256,translationSha256:r.translationSha256,
   decision:null,correctedTranslation:null,correctedOcr:null,rationale:'',confirmedByHuman:false}))};
}

// Validates file bindings and explicit entries, not the identity of a human.
// The caller still needs actual user-supplied human evidence and Stage13 CAS.
export function inspectHumanReview(packet,submission){
 const code='HUMAN_REVIEW_BINDING_INVALID';
 must(packet.packetSha256===packetHash(packet),code);
 must(submission?.schemaVersion==='stage14r2-human-submission-v1',code);
 must(['HUMAN_REVIEW_PENDING','HUMAN_SUBMISSION_UNVERIFIED'].includes(submission.status)&&submission.humanApprovalVerified===false,code);
 must(typeof submission.reviewer==='string'&&submission.reviewer.length<=200,code);
 must(submission.submittedAt===null||typeof submission.submittedAt==='string'&&Number.isFinite(Date.parse(submission.submittedAt)),code);
 const expected=makeHumanReviewTemplate(packet);
 for(const key of ['packetSha256','pageId','projectId','owner','sourceSha256','bindings'])must(same(submission[key],expected[key]),code);
 must(Array.isArray(submission.regions)&&submission.regions.length===expected.regions.length&&new Set(submission.regions.map(r=>r?.regionId)).size===expected.regions.length,code);
 const rows=expected.regions.map(bound=>{
  const row=submission.regions.find(r=>r?.regionId===bound.regionId);must(!!row,code);
  for(const key of ['pageId','regionId','sourceText','translatedText','sourceTextSha256','translationSha256'])must(row[key]===bound[key],code);
  must(row.decision===null||decisions.includes(row.decision),code);
  if(row.decision==='CORRECT_TRANSLATION'&&!validText(row.correctedTranslation))fail('HUMAN_REVIEW_CORRECTION_REQUIRED','확정할 한국어 수정문을 입력하세요.');
  if(row.decision==='OCR_CORRECTION_REQUIRED'&&!validText(row.correctedOcr))fail('HUMAN_REVIEW_CORRECTION_REQUIRED','OCR 수정 원문을 입력하세요.');
  must(row.correctedTranslation==null||row.decision==='CORRECT_TRANSLATION',code);must(row.correctedOcr==null||row.decision==='OCR_CORRECTION_REQUIRED',code);
  const filled=row.decision!==null&&row.confirmedByHuman===true&&validText(row.rationale)&&validText(submission.reviewer)&&typeof submission.submittedAt==='string'&&Number.isFinite(Date.parse(submission.submittedAt));
  return {...clone(row),complete:filled,route:!filled?'KEEP_PENDING':row.decision==='OCR_CORRECTION_REQUIRED'?'RETURN_TO_OCR_REVIEW':['NEEDS_MORE_CONTEXT','REJECT'].includes(row.decision)?'KEEP_BLOCKED':'REQUIRES_AUTHENTICATED_HUMAN_EVIDENCE_AND_STAGE13_APPLY'};
 });
 const status=rows.every(r=>r.complete)?'HUMAN_SUBMISSION_UNVERIFIED':'HUMAN_REVIEW_PENDING';
 must(submission.status===status,'HUMAN_REVIEW_STATE_INVALID');
 return {status,bindingValid:true,humanApprovalVerified:false,executionAuthorized:false,regions:rows};
}

const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scriptJson=x=>JSON.stringify(x).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const marked=s=>esc(s).replace(/[\u3040-\u30ff]+/g,x=>'<mark>'+x+'</mark>');
export function renderHumanReviewHtml(packet){
 const options=[['ACCEPT_AS_IS','현재 표현 허용'],['CORRECT_TRANSLATION','번역 수정 필요'],['OCR_CORRECTION_REQUIRED','OCR 수정 필요'],['NEEDS_MORE_CONTEXT','문맥 추가 필요'],['REJECT','사용 불가']];
 const context=rows=>rows.length?rows.map(r=>`<li><code>${esc(r.regionId)}</code><br>원문: ${esc(r.sourceText)}<br>미검수 AI: ${esc(r.translation)}</li>`).join(''):'<li>제공된 앞뒤 항목 없음</li>';
 return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Stage14-R2 사람 번역 검수</title><style>
 body{margin:0;background:#f1f4f6;color:#192b35;font:16px/1.7 system-ui,'Malgun Gothic',sans-serif}main{max-width:1100px;margin:auto;padding:24px}h1,h2{line-height:1.4}section{background:white;border:1px solid #cad6de;border-radius:12px;padding:22px;margin:22px 0}.state{background:#fff1bf;padding:12px;border-radius:8px}code{overflow-wrap:anywhere;font-size:13px}.grid{display:grid;grid-template-columns:minmax(200px,35%) 1fr;gap:24px}img{max-width:100%;height:auto;max-height:700px;object-fit:contain}mark{background:#ffe59a;color:#6b2500}label{display:block;margin-top:12px}textarea,select,input[type=text]{box-sizing:border-box;width:100%;padding:10px;font:inherit;border:1px solid #8ca4b5;border-radius:6px}textarea{min-height:85px}button{font:inherit;padding:12px 18px;cursor:pointer}details{margin:12px 0}summary{cursor:pointer}li{margin:10px 0}.note{color:#50616d}.sticky{position:sticky;bottom:0;background:#f1f4f6;padding:14px;border-top:1px solid #8ca4b5}a{color:#164d79} @media(max-width:700px){.grid{display:block}main{padding:12px}section{padding:15px}}
 </style></head><body><main><h1>일본어 잔류 4영역 · 사람 검수</h1><p class="state" id="state">HUMAN_REVIEW_PENDING — 실제 사람 승인 0개</p><p>원본·OCR·실제 모델 응답을 대조해 결정하세요. 노란색은 기존 규칙이 찾은 일본어 범위입니다. AI 분석과 QA 점수는 사람 정답이 아닙니다. 미선택 항목은 보류로 남습니다.</p><p>페이지 <code>${esc(packet.scope.pageId)}</code> · 원본 SHA <code>${esc(packet.scope.sourceSha256)}</code><br>검수 묶음 SHA <code>${esc(packet.packetSha256)}</code></p><p><a href="evidence/saved/source.png" target="_blank" rel="noopener">전체 원본 페이지 열기</a> · <a href="Stage14R2_Human_Review_Template.json" download>빈 JSON 양식</a></p><p>화자·호칭 확정값과 앞 페이지 사람 검수 문맥은 없습니다. 4번은 뒤의 ‘すごく分かりやすいよ’와 연결해 보세요. 경고가 없는 대사도 의미 합격은 아닙니다. 아래 전체 13개 후보를 확인할 수 있습니다.</p>
 <details><summary>전체 13개 OCR·미검수 번역 보기</summary><ol>${context(packet.allResponses)}</ol></details>
 <label>검수자 이름 또는 식별자 <input type="text" id="reviewer" autocomplete="off" placeholder="직접 입력"></label>
 ${packet.regions.map((r,i)=>`<section data-region="${esc(r.regionId)}"><h2>${i+1}. <code>${esc(r.regionId)}</code></h2><div class="grid"><div>${r.sourceImage?`<a href="${esc(r.sourceImage.image)}" target="_blank" rel="noopener"><img src="${esc(r.sourceImage.enlarged)}" alt="영역 ${i+1} 원본 말풍선 2배 확대"></a><p class="note">원본 PNG의 지정 영역. 2배 최근접 확대이며 아래 OCR로 고쳐 그리지 않았습니다.</p>`:'<p>확대 이미지 없음</p>'}</div><div><p><b>OCR 원문</b><br><span lang="ja">${esc(r.sourceText)}</span></p><p><b>실제 E2B 번역 칸의 값</b><br><span class="actual-translation">${marked(r.translatedText)}</span></p><p>검출 문자열: ${r.japaneseSpans.map(s=>'<code>'+esc(s.text)+'</code>').join(', ')}<br>기존 QA ${esc(r.qaReport?.score)}점 / passed=${esc(r.qaReport?.passed)}<br>확정 용어: ${r.confirmedTerms.length?esc(JSON.stringify(r.confirmedTerms)):'없음'}</p><p>원인: <code>${esc(r.detection.function)}</code>의 가나 범위 검사. 경고이며 confirmedError=false입니다.</p><p><b>AI 잠정 분석: ${esc(r.analysis.classification)}</b><br>${esc(r.analysis.note)}</p><p>${esc(r.analysis.humanQuestion)}</p></div></div><details open><summary>필요한 앞뒤 대사 · 모두 미검수 AI</summary><b>이전</b><ul>${context(r.context.previous)}</ul><b>이후</b><ul>${context(r.context.next)}</ul></details>
 <label>검토 결정 <select data-field="decision"><option value="">미선택 — 검토 보류</option>${options.map(([value,label])=>`<option value="${value}">${value}: ${label}</option>`).join('')}</select></label>
 <label>확정할 한국어 수정문 · 번역 수정 선택 시 필수<textarea data-field="correctedTranslation" placeholder="번역 수정 시 직접 입력"></textarea></label>
 <label>OCR 수정 원문 · OCR 수정 선택 시 필수<textarea data-field="correctedOcr" placeholder="원본 이미지를 보고 직접 입력"></textarea></label>
 <label>판단 근거·호칭 정책·필요한 추가 문맥<textarea data-field="rationale"></textarea></label><label><input type="checkbox" data-field="confirmedByHuman"> 원본과 문맥을 직접 확인하고 이 결정을 선택했습니다.</label></section>`).join('')}
 <p>입력값은 이 화면에서만 유지됩니다. 창을 닫기 전에 JSON을 내려받으세요. 내려받기는 원본 증거나 번역 후보를 수정하지 않습니다. 제출 파일의 원본 해시·영역 ID·수정문과 실제 사람 제출 여부를 별도로 확인한 뒤에만 기존 계약으로 반영할 수 있습니다.</p><div class="sticky"><button type="button" id="download">검수 결과를 별도 JSON으로 저장</button><p role="status" id="message"></p></div></main>
 <script type="application/json" id="template">${scriptJson(makeHumanReviewTemplate(packet))}</script><script>
 const template=JSON.parse(document.getElementById('template').textContent);
 document.getElementById('download').addEventListener('click',()=>{
  const out=structuredClone(template),message=document.getElementById('message');out.reviewer=document.getElementById('reviewer').value;out.submittedAt=new Date().toISOString();let complete=0;
  for(const [i,section] of [...document.querySelectorAll('section[data-region]')].entries()){
   const read=name=>section.querySelector('[data-field="'+name+'"]');const r=out.regions[i];r.decision=read('decision').value||null;r.rationale=read('rationale').value;r.confirmedByHuman=read('confirmedByHuman').checked;
   const tr=read('correctedTranslation').value,ocr=read('correctedOcr').value;
   if(r.decision==='CORRECT_TRANSLATION'&&!tr.trim()){message.textContent=(i+1)+'번 한국어 수정문을 입력하세요.';return;}
   if(r.decision==='OCR_CORRECTION_REQUIRED'&&!ocr.trim()){message.textContent=(i+1)+'번 OCR 수정 원문을 입력하세요.';return;}
   if(tr&&r.decision!=='CORRECT_TRANSLATION'||ocr&&r.decision!=='OCR_CORRECTION_REQUIRED'){message.textContent=(i+1)+'번 수정문과 검토 결정이 일치해야 합니다.';return;}
   r.correctedTranslation=r.decision==='CORRECT_TRANSLATION'?tr:null;r.correctedOcr=r.decision==='OCR_CORRECTION_REQUIRED'?ocr:null;
   if(r.decision&&r.rationale.trim()&&r.confirmedByHuman&&out.reviewer.trim())complete++;
  }
  out.status=complete===out.regions.length?'HUMAN_SUBMISSION_UNVERIFIED':'HUMAN_REVIEW_PENDING';out.humanApprovalVerified=false;
  const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='Stage14R2_Human_Review_Submission.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  document.getElementById('state').textContent=out.status+' — 입력 '+complete+'/'+out.regions.length+' (제출 여부·원본 결합 확인 전)';message.textContent='별도 JSON을 저장했습니다. 자동 승인·실행은 하지 않았습니다.';
 });
 </script></body></html>`;
}

// Explicit saved-file generation. The evidence directory is read only here.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [audit]=process.argv.slice(2);if(!audit)throw Error('Explicit audit directory required');
 const read=async n=>JSON.parse(await fs.readFile(path.join(audit,n),'utf8'));
 const saved=await read('evidence/saved-manifest.json'),s='evidence/saved/';
 for(const f of saved.files){const b=await fs.readFile(path.join(audit,f.copy));must(b.length===f.bytes&&sha(b)===f.sha256);}
 const get=n=>saved.files.find(f=>f.copy===s+n)?.sha256;
 const packet=collectResidueReview({input:await read(s+'translation-input.json'),response:(await read(s+'translation-response-page.json')).response,translations:await read(s+'translations.json'),ocr:await read(s+'ocr.json'),gate:await read(s+'stage14r-translation-gate.json'),
  bindings:{translationInputSha256:get('translation-input.json'),responseSha256:get('translation-response-page.json'),normalizedSha256:get('normalized.png')},images:saved.crops,analysis:await read('evidence/analysis-findings.json')});
 for(const [name,value]of [['Stage14R2_Four_Region_Review.json',JSON.stringify(packet,null,2)],['Stage14R2_Human_Review_Template.json',JSON.stringify(makeHumanReviewTemplate(packet),null,2)],['Stage14R2_Human_Review_Packet.html',renderHumanReviewHtml(packet)]])await fs.writeFile(path.join(audit,name),value,{flag:'wx'});
 console.log(JSON.stringify({status:packet.status,ids:packet.regions.map(r=>r.regionId),output:packet.outputContract,packetSha256:packet.packetSha256,actualModelCalls:0}));
}
