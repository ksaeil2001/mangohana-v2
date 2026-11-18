// A read-only check using the browser's existing HttpOnly cookie. It never imports or saves.
export function GET(){
 return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>저장 번역·OCR 입력 확인</title>
<style>body{font:18px system-ui;max-width:760px;margin:70px auto;padding:24px;line-height:1.7;background:#f6f5f0;color:#20221e}button{font:inherit;padding:12px 20px}pre{white-space:pre-wrap}</style>
<h1>저장 번역·OCR 입력 확인</h1><p>저장한 13개 번역과 원래 OCR을 확인합니다. 이미지 실행 권한은 발급하지 않습니다.</p>
<p id="state" role="status">현재 브라우저의 저장 번역을 조회하고 있습니다.</p><button id="check" disabled>저장 번역·OCR 입력 점검</button><pre id="result"></pre>
<script type="module">
const state=document.querySelector('#state'),button=document.querySelector('#check'),result=document.querySelector('#result');let preview,saved;
async function json(url,options){const r=await fetch('/api/engine/'+url,{credentials:'same-origin',cache:'no-store',...options}),v=await r.json();if(!r.ok)throw Error(v.message||v.error||v.code||'저장 상태를 확인하지 못했습니다.');return v;}
try{preview=await json('translation-reviews/stage14r3');if(!preview.document)throw Error('이 브라우저 세션에는 승인한 번역이 없습니다. 승인했던 원래 브라우저에서 이 주소를 열어 주세요.');saved=(await json('translation-review-pages/'+preview.target.documentId)).document;state.textContent='현재 세션의 저장 번역 '+saved.regions.length+'개 · 편집 '+saved.editRevision+' / 문맥 '+saved.contextRevision+' · 익명 세션(계정 인증 없음)';button.disabled=false;}catch(e){state.textContent=e.message;}
button.onclick=async()=>{button.disabled=true;state.textContent='원본·승인·OCR 출처와 현재 엔진 입력을 점검하고 있습니다. 파일 검증에 몇 분 걸릴 수 있습니다.';try{const out=await json('translation-review-pages/'+saved.documentId+'/inspect-inputs',{method:'POST',headers:{'Content-Type':'application/json','X-Mangohana-Review-Scope':preview.sessionScope},body:JSON.stringify({expectedEditRevision:saved.editRevision,expectedContextRevision:saved.contextRevision,eventSha256:saved.receipt.eventSha256,selectedSetSha256:saved.receipt.selectedSetSha256})});state.textContent='입력 확인 완료 · 이미지 실행 권한 없음';result.textContent=JSON.stringify({status:out.status,OCR_REUSED:out.ocrRegions+'/13',USER_TRANSLATIONS_USABLE:out.userTranslationsUsable+'/13',IMAGE_EXECUTION_AUTHORIZED:out.executionAuthorized,authenticationLevel:out.authenticationLevel,semanticWarnings:out.lines.flatMap(l=>l.riskSignals).length,calls:out.calls,evidence:out.inspectionEvidence},null,2);}catch(e){state.textContent='입력 점검 중단: '+e.message;}finally{button.disabled=false;}};
</script></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
