'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {applyTranslationReview,loadTranslationReview,makeReviewCommand,type ReviewCommand,type ReviewDocument,type ReviewPreview} from '@/lib/studio-translation-review';

type ShellProps={title:string;eyebrow?:string;children:ReactNode;onClose:()=>void;wide?:boolean;busy?:boolean;descriptionId?:string};
const pendingKey=(scope:string)=>'trio-translation-review-pending-v1:'+scope;
export default function StudioTranslationReviewDialog({DialogShell,onClose}:{DialogShell:(props:ShellProps)=>ReactNode;onClose:()=>void}){
 const [preview,setPreview]=useState<ReviewPreview|null>(null),[saved,setSaved]=useState<ReviewDocument|null>(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[blocked,setBlocked]=useState(true);
 const pending=useRef<ReviewCommand|null>(null),sending=useRef(false);
 useEffect(()=>{
  const controller=new AbortController();
  loadTranslationReview(controller.signal).then(p=>{
   if(controller.signal.aborted)return;setPreview(p);setSaved(p.document);
   const raw=sessionStorage.getItem(pendingKey(p.sessionScope));if(!raw){setBlocked(false);return;}
   const command=JSON.parse(raw) as ReviewCommand;
   if(command.documentId!==p.target.documentId||!command.requestKey||!command.approvalToken)throw Error('보관한 번역 적용 요청이 현재 페이지와 다릅니다. 요청을 보존하고 저장 상태를 확인해 주세요.');
   if(p.document?.receipt.requestKey===command.requestKey){sessionStorage.removeItem(pendingKey(p.sessionScope));setBlocked(false);return;}
   pending.current=command;setBlocked(false);setError('이전 요청의 응답을 확인하지 못했어요. 아래 버튼으로 같은 요청의 저장 상태를 확인할 수 있어요.');
  }).catch(e=>{if(!controller.signal.aborted){setBlocked(true);setError('검수 자료나 보관한 적용 요청을 읽지 못해 새 승인을 중단했습니다. 기존 요청은 보존했습니다. '+(e instanceof Error?e.message:''));}});
  return()=>controller.abort();
 },[]);
 async function apply(){
  if(!preview||saved||blocked||sending.current)return;sending.current=true;setSaving(true);setError('');
  try{
   const command=pending.current??makeReviewCommand(preview);
   // Preserve the exact request before sending; a lost response cannot create a new approval.
   sessionStorage.setItem(pendingKey(preview.sessionScope),JSON.stringify(command));pending.current=command;
   const result=await applyTranslationReview(preview,command);setSaved(result.document);pending.current=null;
   try{sessionStorage.removeItem(pendingKey(preview.sessionScope));}catch{/* A server requery reconciles this receipt on reopen. */}
  }catch(e){setError(e instanceof Error?e.message:'번역 저장 여부를 확인하지 못했어요. 같은 요청을 보존했습니다.');}
  finally{sending.current=false;setSaving(false);}
 }
 return <DialogShell title="선택한 번역 저장" eyebrow="STAGE14-R3" wide busy={saving} descriptionId="translation-review-description" onClose={onClose}>
  <p id="translation-review-description" className="dialog-description">이미 검토한 13개 선택문을 그대로 저장합니다. 아래 내용을 한 번에 적용할 수 있어요.</p>
  <p>현재 브라우저의 익명 세션으로 저장합니다. 계정 인증은 연결되어 있지 않습니다.</p>
  <p>개발용 원본의 출처를 보존한 새 페이지 사본을 가져옵니다. 기존 작업실의 페이지와 번역은 보존됩니다.</p>
  <p role="note">2·6·7번의 의미 경고 4건을 유지합니다. 문구 채택은 경고가 객관적으로 해소됐다는 판정과 구분하며, 의미 정확도는 독립 검증되지 않았습니다. 번역 저장은 원문 제거·식자·PNG 생성을 승인하지 않습니다.</p>
  {error&&<p className="connection-error" role="alert">{error}</p>}
  {!preview&&!error&&<p role="status">보존한 번역과 현재 세션을 확인하는 중…</p>}
  {preview&&<>
   <details><summary>원본 페이지 보기</summary><img src={preview.sourceImage} alt="개발용 원본 페이지" style={{maxWidth:'100%',height:'auto'}}/></details>
   <ol style={{paddingLeft:24}}>{preview.regions.map(r=><li key={r.regionId} style={{marginBottom:18}}><strong>{r.order}번</strong><dl style={{display:'grid',gridTemplateColumns:'minmax(90px,1fr) minmax(0,4fr)',gap:'6px 12px',margin:8}}><dt>원문 관측</dt><dd style={{margin:0,whiteSpace:'pre-wrap'}}>{r.rawOcr}</dd><dt>원래 AI 번역</dt><dd style={{margin:0,whiteSpace:'pre-wrap'}}>{r.originalAiTranslation}</dd><dt>선택한 번역</dt><dd data-review-selected={r.regionId} style={{margin:0,whiteSpace:'pre-wrap',fontWeight:600}}>{r.selectedUserTranslation}</dd><dt>선택 출처</dt><dd style={{margin:0}}>{r.selectionOrigin==='USER_EDIT'?'직접 수정':r.selectionOrigin==='AI_SUGGESTION_ADOPTED'?'AI 제안 채택':'모델 후보 채택'}</dd></dl>{r.riskSignals.length>0&&<p>유지되는 경고: {r.riskSignals.map(s=>s.code).join(', ')}<br/>남은 불확실성: {r.remainingUncertainties}</p>}</li>)}</ol>
   {saved?<div role="status" data-review-saved><strong>13개 번역을 서버에 저장했습니다.</strong><p>편집 revision {saved.editRevision} · 익명 세션 승인<br/>이미지 처리 전 · 독립 의미 검증 미완료</p><p>저장 영수증 <code style={{overflowWrap:'anywhere'}}>{saved.receipt.eventSha256}</code></p><p>이 화면을 다시 열면 서버에 저장된 상태를 확인합니다.</p></div>:<button type="button" data-review-apply className="button primary full-width" disabled={saving||blocked} onClick={()=>void apply()}>{saving?'번역 저장 확인 중…':pending.current?'같은 요청으로 저장 상태 확인':'개발용 페이지 가져와 선택한 13개 번역 적용'}</button>}
  </>}
 </DialogShell>;
}
