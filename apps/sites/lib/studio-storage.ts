import {restoreProject,type Project} from './studio-model';
import {normalizeReadingState,type ReadingState} from './studio-reading';
// The retired local endpoint is inert v1 metadata; only online is used for requests.
export type SavedWorkspace={version:1;storageRevision?:number;projects:Project[];activeId:string;endpoints:{local:string;online:string};reading?:ReadingState};
export function sameWorkspaceSnapshot(a:SavedWorkspace,b:SavedWorkspace):boolean{return a.projects===b.projects&&a.activeId===b.activeId&&a.endpoints===b.endpoints&&a.reading===b.reading;}
export function flushWorkspaceSnapshot(writer:{schedule:(snapshot:SavedWorkspace)=>void;flush:()=>Promise<void>}|null,snapshot?:SavedWorkspace):Promise<void>{
 if(snapshot)writer?.schedule(snapshot);
 // A preceding empty flush may be settling in this event's microtask queue.
 // Start after it so a hidden page need not wait for the debounce timer.
 return Promise.resolve().then(()=>writer?.flush());
}
export function normalizeWorkspace(value:unknown):SavedWorkspace|undefined {
 if(value===undefined)return undefined;
 const saved=value as SavedWorkspace;
 if(!saved||saved.version!==1)throw new Error('지원하지 않는 저장 버전이에요. 기존 저장 내용은 덮어쓰지 않아요.');
 if(!Array.isArray(saved.projects)||!saved.endpoints||typeof saved.endpoints.local!=='string'||typeof saved.endpoints.online!=='string')throw new Error('저장된 작업실 정보를 읽지 못했어요. 기존 내용은 보존돼요.');
 if(saved.storageRevision!==undefined&&(!Number.isSafeInteger(saved.storageRevision)||saved.storageRevision<0))throw new Error("저장 리비전을 확인해 주세요.");
 const projects=saved.projects.map(restoreProject),ids=new Set(projects.map(p=>p.id));
 if(ids.size!==projects.length)throw new Error('저장된 프로젝트 ID가 중복돼요.');
 return {...saved,projects,activeId:ids.has(saved.activeId)?saved.activeId:projects[0]?.id||'',reading:normalizeReadingState(saved.reading,projects)};
}
function openDB():Promise<IDBDatabase>{
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open('trio-studio-v1',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('workspace');
  request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(new Error('다른 탭에서 저장소를 사용하고 있어요. 잠시 후 다시 시도해 주세요.'));
 });
}
export async function readWorkspace():Promise<SavedWorkspace|undefined>{
 const db=await openDB();
 const value=await new Promise<unknown>((resolve,reject)=>{
  const tx=db.transaction('workspace','readonly'),request=tx.objectStore('workspace').get('current');let result:unknown;
  request.onsuccess=()=>{result=request.result;};
  tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>{db.close();reject(tx.error);};tx.onabort=()=>{db.close();reject(tx.error);};
 });
 return normalizeWorkspace(value);
}
export class WorkspaceConflictError extends Error {constructor(message:string){super(message);this.name='WorkspaceConflictError';}}
export function nextStorageRevision(current:unknown,expected:number):number {
 const stored=current as {version?:number;storageRevision?:number}|undefined;
 if(stored&&stored.version!==1)throw new WorkspaceConflictError('저장 버전이 바뀌었어요. 현재 편집을 백업한 뒤 다시 불러와 주세요.');
 const actual=stored?.storageRevision??0;
 if(!Number.isSafeInteger(actual)||actual<0||actual!==expected)throw new WorkspaceConflictError('다른 탭에서 작업을 저장했어요. 현재 편집을 백업한 뒤 새로고침해 주세요.');
 return actual+1;
}
export async function saveWorkspace(value:SavedWorkspace,expectedRevision=value.storageRevision??0):Promise<number>{
 const db=await openDB();
 return new Promise<number>((resolve,reject)=>{
  const tx=db.transaction('workspace','readwrite'),store=tx.objectStore('workspace');let revision=0,failure:unknown;
  const request=store.get('current');
  request.onsuccess=()=>{try{revision=nextStorageRevision(request.result,expectedRevision);store.put({...value,storageRevision:revision},'current');}catch(error){failure=error;tx.abort();}};
  tx.oncomplete=()=>{db.close();resolve(revision);};tx.onerror=()=>{db.close();reject(failure||tx.error);};tx.onabort=()=>{db.close();reject(failure||tx.error);};
 });
}
