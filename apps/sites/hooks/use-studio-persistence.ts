'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {AutosaveQueue,type SaveStatus} from '@/lib/studio-persistence';
import {readWorkspace,saveWorkspace,sameWorkspaceSnapshot,flushWorkspaceSnapshot,type SavedWorkspace} from '@/lib/studio-storage';
export type HydrationState={phase:'loading'}|{phase:'ready'}|{phase:'recovery';error:string};
export function useStudioPersistence(value:SavedWorkspace,onRestore:(saved:SavedWorkspace)=>void,notify:(message:string,error?:boolean)=>void){
 const [hydration,setHydration]=useState<HydrationState>({phase:'loading'});
 const [save,setSave]=useState<SaveStatus>({phase:'idle',revision:0,savedRevision:0});
 const [attempt,setAttempt]=useState(0);
 const queue=useRef<AutosaveQueue<SavedWorkspace>|null>(null);
 const baseline=useRef<SavedWorkspace|null>(null);
 const savedSnapshot=useRef<SavedWorkspace|null>(null);
 useEffect(()=>{
  const flush=()=>{if(document.visibilityState==='hidden')void queue.current?.flush().catch(()=>{});};
  document.addEventListener('visibilitychange',flush);return()=>document.removeEventListener('visibilitychange',flush);
 },[]);
 useEffect(()=>{
  let live=true,writer:AutosaveQueue<SavedWorkspace>|undefined;setHydration({phase:'loading'});
  const previous=queue.current;queue.current=null;
  // A retiring writer keeps its own expected revision; it cannot adopt a later read's revision.
  const load=async()=>{
   if(previous){try{await previous.flush();}finally{previous.close();}}
   const saved=await readWorkspace();if(!live)return;
   let expectedRevision=saved?.storageRevision??0,reportedError:string|undefined;
   writer=new AutosaveQueue<SavedWorkspace>(async snapshot=>{
    expectedRevision=await saveWorkspace(snapshot,expectedRevision);
    if(live&&queue.current===writer)savedSnapshot.current=snapshot;
   },state=>{if(!live||queue.current!==writer)return;setSave(state);if(state.phase==='error'&&state.error!==reportedError)notify('저장하지 못했어요. 프로젝트를 내려받아 편집을 보관할 수 있어요.',true);reportedError=state.phase==='error'?state.error:undefined;});
   queue.current=writer;baseline.current=saved||null;savedSnapshot.current=saved||null;
   if(saved){onRestore(saved);setSave({phase:'saved',revision:0,savedRevision:0});}
   setHydration({phase:'ready'});
  };
  load().catch(error=>{if(!live)return;const message=error instanceof Error?error.message:'저장된 작업을 읽지 못했어요.';setHydration({phase:'recovery',error:message});notify(message,true);});
  return()=>{live=false;writer?.close();};
 },[attempt,onRestore,notify]);
 useEffect(()=>{
  if(hydration.phase!=='ready')return;const restored=baseline.current;
  if(restored&&sameWorkspaceSnapshot(value,restored))return;
  baseline.current=null;queue.current?.schedule(value);
 },[value,hydration.phase]);
 const retryRead=useCallback(()=>setAttempt(n=>n+1),[]);
 const retrySave=useCallback(()=>{void queue.current?.flush().catch(()=>{});},[]);
 const flush=useCallback((snapshot?:SavedWorkspace)=>flushWorkspaceSnapshot(queue.current,snapshot),[]);
 const snapshot=savedSnapshot.current;
 const clean=!!snapshot&&sameWorkspaceSnapshot(snapshot,value);
 const visibleSave:SaveStatus=!clean&&save.phase==='saved'?{...save,phase:'pending'}:save;
 return {hydration,save:visibleSave,retryRead,retrySave,flush};
}
