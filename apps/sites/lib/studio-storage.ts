import {restoreProject,type Project,type StudioPage} from './studio-model';
import {normalizeReadingState,type ReadingState} from './studio-reading';
// The retired local endpoint is inert v1 metadata; only online is used for requests.
export type SavedWorkspace={version:1;storageRevision?:number;projects:Project[];activeId:string;endpoints:{local:string;online:string};reading?:ReadingState};
type DehydratedWorkspace=SavedWorkspace&{assetLayout:2};
const ASSET_PREFIX='idb-asset:sha256:';
const IMAGE_FIELDS=['image','cleanImage','finalImage'] as const;
const assetKeyCache=new Map<string,string>();
const knownAssetsByDb=new WeakMap<object,Set<string>>();

function knownAssets():Set<string>{
 const idb=globalThis.indexedDB as object|undefined;
 if(!idb)return new Set<string>();
 let known=knownAssetsByDb.get(idb);
 if(!known){known=new Set<string>();knownAssetsByDb.set(idb,known);}
 return known;
}
function isAssetRef(value:unknown):value is string{return typeof value==='string'&&value.startsWith(ASSET_PREFIX);}
async function assetKeyForDataUrl(dataUrl:string):Promise<string>{
 const cached=assetKeyCache.get(dataUrl);
 if(cached)return cached;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(dataUrl));
 const hex=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
 const key=ASSET_PREFIX+hex;
 if(assetKeyCache.size>=1000){const first=assetKeyCache.keys().next().value;if(first!==undefined)assetKeyCache.delete(first);}
 assetKeyCache.set(dataUrl,key);
 return key;
}
function collectAssetRefs(workspace:{projects?:unknown[]}):Set<string>{
 const refs=new Set<string>();
 if(!Array.isArray(workspace.projects))return refs;
 for(const project of workspace.projects as Array<{pages?:Array<Record<string,unknown>>}>){
  if(!Array.isArray(project?.pages))continue;
  for(const page of project.pages){
   if(!page)continue;
   for(const field of IMAGE_FIELDS)if(isAssetRef(page[field]))refs.add(page[field] as string);
  }
 }
 return refs;
}
async function dehydrateWorkspace(value:SavedWorkspace):Promise<{metadata:DehydratedWorkspace;assets:Map<string,string>}>{
 const assets=new Map<string,string>();
 const projects:Project[]=await Promise.all(value.projects.map(async project=>({
  ...project,
  pages:await Promise.all(project.pages.map(async page=>{
   const next:StudioPage={...page};
   for(const field of IMAGE_FIELDS){
    const raw=page[field];
    if(typeof raw==='string'&&raw.startsWith('data:image/')){
     const key=await assetKeyForDataUrl(raw);
     assets.set(key,raw);
     next[field]=key;
    }
   }
   return next;
  }))
 })));
 return {metadata:{...value,projects,assetLayout:2},assets};
}
function hydrateWorkspace(stored:DehydratedWorkspace,assets:Map<string,string>):SavedWorkspace{
 const projects=stored.projects.map(project=>({
  ...project,
  pages:project.pages.map(page=>{
   const next:StudioPage={...page};
   for(const field of IMAGE_FIELDS){
    const ref=page[field];
    if(isAssetRef(ref)){
     const dataUrl=assets.get(ref);
     if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:image/'))throw new Error('저장된 이미지 자산을 찾지 못했어요. 기존 저장 내용은 보존돼요.');
     next[field]=dataUrl;
    }
   }
   return next;
  })
 }));
 const {assetLayout:_layout,...rest}=stored;
 return {...rest,projects};
}
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
  const request=indexedDB.open('trio-studio-v1',2);
  request.onupgradeneeded=()=>{
   knownAssets().clear();
   if(!request.result.objectStoreNames.contains('workspace'))request.result.createObjectStore('workspace');
   if(!request.result.objectStoreNames.contains('assets'))request.result.createObjectStore('assets');
  };
  request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(new Error('다른 탭에서 저장소를 사용하고 있어요. 잠시 후 다시 시도해 주세요.'));
 });
}
export async function readWorkspace():Promise<SavedWorkspace|undefined>{
 const db=await openDB();
 try{
  const hasAssets=db.objectStoreNames.contains('assets');
  const loaded=await new Promise<{stored:unknown;assets:Map<string,string>}>((resolve,reject)=>{
   const tx=db.transaction(hasAssets?['workspace','assets']:'workspace','readonly');
   const workspaceStore=tx.objectStore('workspace');
   const assetsStore=hasAssets?tx.objectStore('assets'):null;
   let stored:unknown;
   const assets=new Map<string,string>();
   const request=workspaceStore.get('current');
   request.onsuccess=()=>{
    stored=request.result;
    const candidate=stored as Partial<DehydratedWorkspace>|undefined;
    if(assetsStore&&candidate&&candidate.version===1&&candidate.assetLayout===2&&Array.isArray(candidate.projects)){
     for(const key of collectAssetRefs(candidate)){
      const assetReq=assetsStore.get(key);
      assetReq.onsuccess=()=>{if(typeof assetReq.result==='string')assets.set(key,assetReq.result);};
     }
    }
   };
   tx.oncomplete=()=>resolve({stored,assets});
   tx.onerror=()=>reject(tx.error);
   tx.onabort=()=>reject(tx.error);
  });
  if(loaded.stored===undefined)return undefined;
  const candidate=loaded.stored as Partial<DehydratedWorkspace>;
  if(candidate&&candidate.version===1&&candidate.assetLayout===2){
   const known=knownAssets();
   for(const [key,dataUrl] of loaded.assets){assetKeyCache.set(dataUrl,key);known.add(key);}
   return normalizeWorkspace(hydrateWorkspace(candidate as DehydratedWorkspace,loaded.assets));
  }
  return normalizeWorkspace(loaded.stored);
 }finally{db.close();}
}
export class WorkspaceConflictError extends Error {constructor(message:string){super(message);this.name='WorkspaceConflictError';}}
export function nextStorageRevision(current:unknown,expected:number):number {
 const stored=current as {version?:number;storageRevision?:number}|undefined;
 if(stored&&stored.version!==1)throw new WorkspaceConflictError('저장 버전이 바뀌었어요. 현재 편집을 백업한 뒤 다시 불러와 주세요.');
 const actual=stored?.storageRevision??0;
 if(!Number.isSafeInteger(actual)||actual<0||actual!==expected)throw new WorkspaceConflictError('다른 탭에서 작업을 저장했어요. 현재 편집을 백업한 뒤 새로고침해 주세요.');
 return actual+1;
}
function ensureAssetsStored(db:IDBDatabase,assets:Map<string,string>,keys:Iterable<string>):Promise<string[]>{
 const pending=[...keys];
 if(!pending.length)return Promise.resolve([]);
 return new Promise<string[]>((resolve,reject)=>{
  const tx=db.transaction('assets','readwrite'),store=tx.objectStore('assets'),confirmed:string[]=[];
  for(const key of pending){
   const check=store.getKey(key);
   check.onsuccess=()=>{
    if(check.result!==undefined){confirmed.push(key);return;}
    const dataUrl=assets.get(key);
    if(dataUrl!==undefined){
     const put=store.put(dataUrl,key);
     put.onsuccess=()=>{confirmed.push(key);};
    }
   };
  }
  tx.oncomplete=()=>resolve(confirmed);
  tx.onerror=()=>reject(tx.error);
  tx.onabort=()=>reject(tx.error);
 });
}
async function pruneUnusedAssets(db:IDBDatabase,known:Set<string>):Promise<void>{
 await new Promise<void>(resolve=>{
  const tx=db.transaction(['workspace','assets'],'readwrite');
  const workspaceStore=tx.objectStore('workspace'),assetsStore=tx.objectStore('assets');
  const currentReq=workspaceStore.get('current');
  currentReq.onsuccess=()=>{
   const current=currentReq.result as Partial<DehydratedWorkspace>|undefined;
   if(!current||current.assetLayout!==2)return;
   const keep=collectAssetRefs(current);
   const keysReq=assetsStore.getAllKeys();
   keysReq.onsuccess=()=>{
    for(const key of keysReq.result){
     if(typeof key==='string'&&!keep.has(key)){assetsStore.delete(key);known.delete(key);}
    }
   };
  };
  tx.oncomplete=()=>resolve();tx.onerror=()=>resolve();tx.onabort=()=>resolve();
 });
}
export async function saveWorkspace(value:SavedWorkspace,expectedRevision=value.storageRevision??0):Promise<number>{
 const {metadata,assets}=await dehydrateWorkspace(value);
 const known=knownAssets();
 const db=await openDB();
 try{
  // Copy missing assets before touching 'workspace.current' so an interrupted
  // migration or QuotaExceededError leaves the previous record intact.
  const toCheck=[...assets.keys()].filter(key=>!known.has(key));
  if(toCheck.length){
   const stored=await ensureAssetsStored(db,assets,toCheck);
   for(const key of stored)known.add(key);
  }
  const commitAttempt=()=>new Promise<{revision:number;missing:string[]}>((resolve,reject)=>{
   const hasAssets=db.objectStoreNames.contains('assets');
   const tx=db.transaction(hasAssets?['workspace','assets']:'workspace','readwrite');
   const store=tx.objectStore('workspace'),assetsStore=hasAssets?tx.objectStore('assets'):null;
   let revision=0,failure:unknown;
   const missing:string[]=[];
   const request=store.get('current');
   request.onsuccess=()=>{
    try{
     revision=nextStorageRevision(request.result,expectedRevision);
     if(assetsStore){
      const keys=[...assets.keys()];
      if(!keys.length){store.put({...metadata,storageRevision:revision},'current');return;}
      let remaining=keys.length;
      for(const key of keys){
       const check=assetsStore.getKey(key);
       check.onsuccess=()=>{
        if(check.result===undefined)missing.push(key);
        if(--remaining===0){
         if(missing.length){tx.abort();return;}
         store.put({...metadata,storageRevision:revision},'current');
        }
       };
      }
      return;
     }
     store.put({...value,storageRevision:revision},'current');
    }catch(error){failure=error;tx.abort();}
   };
   tx.oncomplete=()=>resolve({revision,missing});
   tx.onerror=()=>reject(failure||tx.error);
   tx.onabort=()=>{if(missing.length&&!failure)resolve({revision:0,missing});else reject(failure||tx.error);};
  });
  let committed=await commitAttempt();
  if(committed.missing.length){
   for(const key of committed.missing)known.delete(key);
   const stored=await ensureAssetsStored(db,assets,committed.missing);
   for(const key of stored)known.add(key);
   committed=await commitAttempt();
   if(committed.missing.length)throw new Error('이미지 자산을 저장하지 못했어요. 프로젝트를 내려받아 편집을 보관할 수 있어요.');
  }
  if([...known].some(key=>!assets.has(key)))await pruneUnusedAssets(db,known);
  return committed.revision;
 }finally{db.close();}
}
