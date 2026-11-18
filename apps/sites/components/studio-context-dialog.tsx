"use client";
import {useEffect,useId,useMemo,useSyncExternalStore,type ComponentType,type ReactNode} from 'react';
import {CONTEXT_INTENT_PREFIX,SAVED_CONTEXT_NOTICE,contextIntentBlocked,createStudioContextSession,matchingTerms,type ContextScope,type ContextStorage,type StudioContextSession} from '@/lib/studio-context';

type DialogShell=ComponentType<{title:string;descriptionId?:string;busy?:boolean;onClose:()=>void;children:ReactNode}>;
type Props={scope:ContextScope;DialogShell:DialogShell;onClose:()=>void;session?:StudioContextSession};
const statusLabel={AI_PROPOSED:'AI 제안 · 미확정',USER_MODIFIED:'사용자 저장 · 확정 전',USER_CONFIRMED:'확정됨'};
function durableStorage():ContextStorage|undefined{try{return typeof window==='undefined'?undefined:window.localStorage;}catch{return undefined;}}

export default function StudioContextDialog({scope,DialogShell,onClose,session:supplied}:Props){
 const {projectId,pageId,regionId,source,translation}=scope;
 // A new captured selection owns a new cancellation generation. It never writes page content.
 const session=useMemo(()=>supplied??createStudioContextSession({projectId,pageId,regionId,source,translation},{storage:durableStorage()}),[supplied,projectId,pageId,regionId,source,translation]);
 const state=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot),fieldId=useId();
 useEffect(()=>{
  session.activate();void session.load();
  const changed=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith(CONTEXT_INTENT_PREFIX+state.scope.projectId+':'))session.syncPending();};
  window.addEventListener('storage',changed);
  return()=>{window.removeEventListener('storage',changed);session.dispose();};
 },[session,state.scope.projectId]);
 const matches=matchingTerms(state),review=session.getReview();
 const disabled=state.status==='writing'||!!state.storageError||state.pending.length>0;
 const canSave=!!state.canonical&&state.canonical.scopeId===state.observedScopeId&&!state.scopeBlocked&&!state.busy&&!state.needsReload&&!disabled&&!!state.draft.source.trim()&&!!state.draft.target.trim();
 return <DialogShell title="인명·용어 표기 저장" descriptionId={fieldId+'-description'} busy={state.status==='writing'} onClose={onClose}>
  <p id={fieldId+'-description'} className="dialog-description">이 작품에 사용할 표기를 직접 저장하고, 내용을 확인한 뒤 확정해요. {SAVED_CONTEXT_NOTICE}</p>
  <p className="dialog-description">선택한 대사 원문: {state.scope.source||'인식한 원문이 없어요. 저장할 일본어 원문을 직접 입력해 주세요.'}</p>
  <form onSubmit={event=>{event.preventDefault();void session.save();}}>
   <div className="export-options">
    <div><label className="field-label" htmlFor={fieldId+'-source'}>일본어 원문</label><input id={fieldId+'-source'} className="form-input" required maxLength={200} autoComplete="off" disabled={disabled} value={state.draft.source} onChange={event=>session.setDraft({...session.getSnapshot().draft,source:event.currentTarget.value})}/></div>
    <div><label className="field-label" htmlFor={fieldId+'-target'}>한국어 표기</label><input id={fieldId+'-target'} className="form-input" required maxLength={200} autoComplete="off" disabled={disabled} value={state.draft.target} onChange={event=>session.setDraft({...session.getSnapshot().draft,target:event.currentTarget.value})}/></div>
   </div>
   <button type="submit" className="button primary full-width" disabled={!canSave}>표기 저장</button>
  </form>
  {state.status==='loading'&&<p className="dialog-description" role="status">저장한 표기를 불러오는 중이에요.</p>}
  {state.status==='writing'&&<p className="dialog-description" role="status">표기 요청의 저장 여부를 확인하는 중이에요.</p>}
  {state.error&&<p className="connection-error" role="alert">{state.error}</p>}
  {state.storageError&&<p className="connection-error" role="alert">{state.storageError}</p>}
  {state.notice&&<p className="dialog-description" role="status">{state.notice}</p>}
  {state.pending.map(intent=><div className="export-notice" key={intent.nonce}>
   <div><p>{!intent.scopeId?'이전에 보관한 요청의 연결 정보를 확인할 수 없어 다시 보내지 않아요. 원기록은 유지했어요.':contextIntentBlocked(state,intent)?'이전 접속에서 보낸 미확인 요청이라 여기서 다시 보내지 않아요. 원기록은 유지했어요.':'저장 여부를 확인하지 못한 요청이 있어요. 아래 표기로 보낸 같은 요청을 확인해 주세요.'}</p><p><strong>{intent.pair.source}</strong> → <strong>{intent.pair.target}</strong></p><button type="button" className="button secondary" disabled={state.busy||!!state.storageError||contextIntentBlocked(state,intent)} onClick={()=>void session.recover(intent.nonce)}>저장 여부 확인</button></div>
  </div>)}
  <button type="button" className="button secondary full-width" disabled={state.busy} onClick={()=>void session.load()}>최신 저장 내용 불러오기</button>
  {matches.slice(0,3).map(term=><div className="export-notice" key={term.id}><div>
   <p>마지막으로 확인한 표기 · {statusLabel[term.status]}</p><p><strong>{term.value.source}</strong> → <strong>{term.value.target}</strong></p>
   {term.value.condition&&Object.keys(term.value.condition).length>0?<p>조건이 있는 표기는 이 입력에서 변경하지 않아요.</p>:<button type="button" className="button secondary" disabled={disabled} onClick={()=>session.setDraft({source:term.value.source,target:term.value.target})}>저장된 표기로 입력</button>}
  </div></div>)}
  {review&&<div className="export-notice" aria-label="확정할 저장 표기"><div><p>현재 저장된 <strong>{review.source}</strong> → <strong>{review.target}</strong> 표기를 확인해 주세요.</p><button type="button" className="button secondary" disabled={state.busy} onClick={()=>void session.confirm(review)}>이 표기로 확정</button></div></div>}
 </DialogShell>;
}
