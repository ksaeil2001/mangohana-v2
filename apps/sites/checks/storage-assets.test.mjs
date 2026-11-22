import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';

const dir=new URL('../.sites-runtime/storage-asset-checks/',import.meta.url);
await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-storage']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 const output=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"');
 await writeFile(new URL(name+'.mjs',dir),output);
}
const model=await import(new URL('studio-model.mjs',dir));
const storage=await import(new URL('studio-storage.mjs',dir));

function createFakeIndexedDB({initialVersion=0,initialStores={}}={}){
 const stores=new Map(Object.entries(initialStores).map(([name,entries])=>[name,new Map(Object.entries(entries))]));
 let version=initialVersion;
 const stats={assetPuts:0,assetReads:0,workspacePuts:0,workspaceReads:0,lastWorkspaceValue:undefined,failAssetPutAfter:Infinity};
 const makeReq=executor=>{
  const req={result:undefined,error:null,onsuccess:null,onerror:null};
  queueMicrotask(()=>{try{req.result=executor();req.onsuccess?.();}catch(error){req.error=error;req.onerror?.();}});
  return req;
 };
 const createTx=(storeNames,mode)=>{
  const names=Array.isArray(storeNames)?storeNames:[storeNames];
  const tx={oncomplete:null,onerror:null,onabort:null,error:null,aborted:false,pending:0,snapshots:new Map()};
  for(const name of names){const current=stores.get(name);if(current)tx.snapshots.set(name,new Map(current));}
  const finish=()=>{
   if(tx.aborted||tx.error)return;
   if(tx.pending===0)queueMicrotask(()=>{if(!tx.aborted&&!tx.error)tx.oncomplete?.();});
  };
  const runReq=(storeName,fn)=>{
   tx.pending++;
   const req={result:undefined,error:null,onsuccess:null,onerror:null};
   queueMicrotask(()=>{
    if(tx.aborted){tx.pending--;return;}
    try{
     req.result=fn(stores.get(storeName));
     req.onsuccess?.();
     tx.pending--;
     finish();
    }catch(error){
     tx.pending--;
     req.error=error;
     tx.error=error;
     for(const [name,snap] of tx.snapshots)stores.set(name,snap);
     req.onerror?.();
     tx.onerror?.();
    }
   });
   return req;
  };
  tx.abort=()=>{
   if(tx.aborted)return;
   tx.aborted=true;
   for(const [name,snap] of tx.snapshots)stores.set(name,snap);
   queueMicrotask(()=>tx.onabort?.());
  };
  tx.objectStore=name=>{
   if(!names.includes(name))throw new Error('Store not in transaction: '+name);
   return {
    get:key=>runReq(name,s=>{if(name==='assets')stats.assetReads++;if(name==='workspace')stats.workspaceReads++;return structuredClone(s.get(key));}),
    getKey:key=>runReq(name,s=>s.has(key)?key:undefined),
    getAllKeys:()=>runReq(name,s=>[...s.keys()]),
    put:(value,key)=>runReq(name,s=>{
     if(mode!=='readwrite')throw new Error('Readonly transaction');
     if(name==='assets'){
      if(stats.assetPuts>=stats.failAssetPutAfter)throw Object.assign(new Error('Quota exceeded'),{name:'QuotaExceededError'});
      stats.assetPuts++;
     }
     if(name==='workspace'){stats.workspacePuts++;stats.lastWorkspaceValue=structuredClone(value);}
     s.set(key,structuredClone(value));
     return key;
    }),
    delete:key=>runReq(name,s=>{if(mode!=='readwrite')throw new Error('Readonly transaction');s.delete(key);})
   };
  };
  return tx;
 };
 const dbHandle=()=>({
  get objectStoreNames(){return {contains:name=>stores.has(name)};},
  createObjectStore(name){if(!stores.has(name))stores.set(name,new Map());return {};},
  transaction:(names,mode='readonly')=>createTx(names,mode),
  close(){},
  onversionchange:null
 });
 const fake={
  open(name,requestedVersion=1){
   const req={result:undefined,error:null,onupgradeneeded:null,onsuccess:null,onerror:null,onblocked:null};
   queueMicrotask(()=>{
    const db=dbHandle();
    req.result=db;
    if(requestedVersion>version){
     version=requestedVersion;
     req.onupgradeneeded?.();
    }
    req.onsuccess?.();
   });
   return req;
  }
 };
 return {indexedDB:fake,stores,stats};
}

function projectWithImages(count=30){
 const p=model.emptyProject('대용량 테스트');
 p.id='proj-30';
 p.pages=Array.from({length:count},(_,i)=>({
  id:`page-${i+1}`,
  name:`${String(i+1).padStart(3,'0')}.png`,
  image:'data:image/png;base64,'+Buffer.from(`orig-image-${i+1}`).toString('base64'),
  cleanImage:'data:image/png;base64,'+Buffer.from(`clean-image-${i+1}`).toString('base64'),
  width:1000,height:1400,status:'review',reviewed:false,
  blocks:[model.makeBlock({id:`b-${i+1}`,text:`초기 대사 ${i+1}`})]
 }));
 return p;
}

test('editing text 10 times on a 30-page project writes image assets 0 times after initial save',async()=>{
 const fake=createFakeIndexedDB();
 const oldIdb=globalThis.indexedDB;
 globalThis.indexedDB=fake.indexedDB;
 try{
  const p=projectWithImages(30);
  let snapshot={version:1,projects:[p],activeId:p.id,endpoints:{local:'http://127.0.0.1:8000',online:'/api/engine'}};
  let rev=await storage.saveWorkspace(snapshot,0);
  assert.equal(rev,1);
  assert.equal(fake.stats.assetPuts,60); // 30 original + 30 cleanImage
  assert.equal(JSON.stringify(fake.stats.lastWorkspaceValue).includes('data:image/'),false);

  const putsBeforeEdits=fake.stats.assetPuts;
  for(let edit=1;edit<=10;edit++){
   const editedProjects=[{
    ...snapshot.projects[0],
    pages:snapshot.projects[0].pages.map((pg,idx)=>idx===0?{...pg,blocks:[{...pg.blocks[0],text:`수정 ${edit}`}]}:pg)
   }];
   snapshot={...snapshot,storageRevision:rev,projects:editedProjects};
   rev=await storage.saveWorkspace(snapshot,rev);
  }
  assert.equal(rev,11);
  assert.equal(fake.stats.assetPuts,putsBeforeEdits);
  assert.equal(fake.stats.assetReads,0);

  const reloaded=await storage.readWorkspace();
  assert.equal(reloaded.storageRevision,11);
  assert.equal(reloaded.projects[0].pages[0].blocks[0].text,'수정 10');
  assert.equal(reloaded.projects[0].pages[29].image,p.pages[29].image);
  assert.equal(reloaded.projects[0].pages[29].cleanImage,p.pages[29].cleanImage);
 }finally{
  if(oldIdb===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIdb;
 }
});

test('v1 inline workspace migrates safely and preserves v1 intact on QuotaExceededError',async()=>{
 const p=projectWithImages(3);
 const legacyRecord={version:1,storageRevision:4,projects:[p],activeId:p.id,endpoints:{local:'http://127.0.0.1:8000',online:'/api/engine'}};
 const fake=createFakeIndexedDB({initialVersion:1,initialStores:{workspace:{current:legacyRecord}}});
 const oldIdb=globalThis.indexedDB;
 globalThis.indexedDB=fake.indexedDB;
 try{
  const readLegacy=await storage.readWorkspace();
  assert.equal(readLegacy.storageRevision,4);
  assert.equal(readLegacy.projects[0].pages[2].image,p.pages[2].image);

  // Fail midway during asset copy -> legacy v1 'current' must remain intact!
  fake.stats.failAssetPutAfter=2;
  const edited={...readLegacy,projects:[{...p,pages:p.pages.map((pg,idx)=>idx===0?{...pg,blocks:[{...pg.blocks[0],text:'전환 중 수정'}]}:pg)}]};
  await assert.rejects(storage.saveWorkspace(edited,4),/Quota/);
  const stillLegacy=await storage.readWorkspace();
  assert.equal(stillLegacy.storageRevision,4);
  assert.equal(stillLegacy.projects[0].pages[0].blocks[0].text,'초기 대사 1');
  assert.equal(stillLegacy.projects[0].pages[2].image,p.pages[2].image);

  // Allow completion -> upgrades cleanly to revision 5 with assetLayout: 2
  fake.stats.failAssetPutAfter=Infinity;
  const nextRev=await storage.saveWorkspace(edited,4);
  assert.equal(nextRev,5);
  assert.equal(fake.stores.get('workspace').get('current').assetLayout,2);
  const migrated=await storage.readWorkspace();
  assert.equal(migrated.storageRevision,5);
  assert.equal(migrated.projects[0].pages[0].blocks[0].text,'전환 중 수정');
  assert.equal(migrated.projects[0].pages[2].image,p.pages[2].image);
 }finally{
  if(oldIdb===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIdb;
 }
});

test('deleting a page prunes unreferenced assets while stale tab revision still throws conflict',async()=>{
 const fake=createFakeIndexedDB();
 const oldIdb=globalThis.indexedDB;
 globalThis.indexedDB=fake.indexedDB;
 try{
  const p=projectWithImages(2);
  const base={version:1,projects:[p],activeId:p.id,endpoints:{local:'http://127.0.0.1:8000',online:'/api/engine'}};
  const rev1=await storage.saveWorkspace(base,0);
  assert.equal(fake.stores.get('assets').size,4);

  const removedPage2={...base,projects:[{...p,pages:[p.pages[0]]}]};
  const rev2=await storage.saveWorkspace(removedPage2,rev1);
  assert.equal(rev2,2);
  assert.equal(fake.stores.get('assets').size,2);

  await assert.rejects(storage.saveWorkspace(base,rev1),error=>error.name==='WorkspaceConflictError');
 }finally{
  if(oldIdb===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=oldIdb;
 }
});
