// Rendered source markup and actual client state with synthetic fetch/storage.
// No browser engine, real HTTP request, image upload or AI execution.
import test from 'node:test';import assert from 'node:assert/strict';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
import {transpileModule,ModuleKind,ScriptTarget,JsxEmit} from 'typescript';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),scope={projectId:'ui-work',pageId:'ui-page',regionId:'ui-region',source:'元の台詞です。',translation:'사용자가 수정한 대사'};
const scopeA='a'.repeat(64),scopeB='b'.repeat(64);
const pair={source:'名前',target:'이름'};
class MemoryStorage{map=new Map();get length(){return this.map.size;}key(index){return [...this.map.keys()][index]??null;}getItem(key){return this.map.get(key)??null;}setItem(key,value){this.map.set(key,value);}removeItem(key){this.map.delete(key);}}
const value={id:'saved-name',...pair};
const saved=status=>({projectId:scope.projectId,scopeId:scopeA,revision:1,profiles:[],terms:[{id:value.id,status,value,currentRevision:1,originalValue:value,history:[{revision:1,status,value}],proposals:[]}]});
const Shell=({title,children,busy})=>createElement('section',{role:'dialog','aria-label':title,'aria-busy':busy},children);
test('optional terminology dialog represents explicit review, unknown and conflict states without application claims',async t=>{
 const sourceFile=new URL('../components/studio-context-dialog.tsx',import.meta.url);assert.equal(await access(sourceFile).then(()=>true,()=>false),true,'optional saved terminology dialog must exist');
 const output=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/sites-context-ui-'+Date.now());await mkdir(output,{recursive:true});
 for(const [name,url]of [['studio-context',new URL('../lib/studio-context.ts',import.meta.url)],['studio-context-dialog',sourceFile]]){
  let compiled=transpileModule(await readFile(url,'utf8'),{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022,jsx:JsxEmit.ReactJSX}}).outputText;
  compiled=compiled.replaceAll('"@/lib/studio-context"','"./studio-context.mjs"').replaceAll("'@/lib/studio-context'",'"./studio-context.mjs"');
  for(const library of ['react/jsx-runtime','react'])compiled=compiled.replaceAll('"'+library+'"',JSON.stringify(pathToFileURL(require.resolve(library)).href)).replaceAll("'"+library+"'",JSON.stringify(pathToFileURL(require.resolve(library)).href));
  await writeFile(path.join(output,name+'.mjs'),compiled);
 }
 const {createStudioContextSession}=await import(pathToFileURL(path.join(output,'studio-context.mjs'))),{default:ContextDialog}=await import(pathToFileURL(path.join(output,'studio-context-dialog.mjs')));
 const render=session=>renderToStaticMarkup(createElement(ContextDialog,{scope,session,DialogShell:Shell,onClose:()=>{}}));
 const buttonDisabled=(html,label)=>new RegExp('<button[^>]*disabled=""[^>]*>'+label+'</button>').test(html);
 await t.test('manual saved pair has a separate exact confirmation action and conservative saved-only copy',async()=>{
  const session=createStudioContextSession(scope,{storage:new MemoryStorage(),fetcher:async()=>Response.json(saved('USER_MODIFIED'))});await session.load();session.setDraft(pair);const html=render(session);
  assert.match(html,/일본어 원문/);assert.match(html,/한국어 표기/);assert.match(html,/이 표기로 확정/);assert.equal(buttonDisabled(html,'이 표기로 확정'),false);
  assert.match(html,/이번 처리에 반영되는지는 결과에서 확인해 주세요/);assert.doesNotMatch(html,/자동.*적용|번역에 적용했|모델 선택/);
  assert.match(html,/名前/);assert.match(html,/이름/);await writeFile(path.join(output,'manual-review.html'),html);
 });
 await t.test('AI proposal and confirmed entries never expose a direct extra confirm action',async()=>{
  for(const status of ['AI_PROPOSED','USER_CONFIRMED']){const session=createStudioContextSession(scope,{storage:new MemoryStorage(),fetcher:async()=>Response.json(saved(status))});await session.load();session.setDraft(pair);const html=render(session);assert.doesNotMatch(html,/>이 표기로 확정<\/button>/);assert.match(html,status==='AI_PROPOSED'?/AI 제안/:/확정됨/);}
 });
 await t.test('unknown pending request displays its frozen pair and only an explicit recovery action',async()=>{
  const session=createStudioContextSession(scope,{storage:new MemoryStorage(),nonce:()=> 'unknown-operation',fetcher:async(_url,init={})=>init.method==='POST'?Promise.reject(new Error('lost')):Response.json({projectId:scope.projectId,scopeId:scopeA,revision:0,terms:[],profiles:[]})});
  await session.load();session.setDraft(pair);await session.save();const html=render(session);assert.match(html,/저장 여부 확인/);assert.match(html,/名前/);assert.match(html,/이름/);assert.equal(buttonDisabled(html,'표기 저장'),true);assert.doesNotMatch(html,/>이 표기로 확정<\/button>/);
 });
 await t.test('CAS conflict retains input values and offers scoped canonical reload before another save',async()=>{
  const session=createStudioContextSession(scope,{storage:new MemoryStorage(),nonce:()=> 'conflict-operation',fetcher:async(_url,init={})=>init.method==='POST'?Response.json({scopeId:scopeA,code:'CONTEXT_REVISION_CONFLICT'},{status:409}):Response.json({projectId:scope.projectId,scopeId:scopeA,revision:0,terms:[],profiles:[]})});
  await session.load();session.setDraft(pair);await session.save();const html=render(session);assert.match(html,/충돌/);assert.match(html,/최신 저장 내용 불러오기/);assert.match(html,/value="名前"/);assert.match(html,/value="이름"/);assert.equal(buttonDisabled(html,'표기 저장'),true);
 });
 await t.test('foreign and scope-less unknown requests stay visible but cannot be replayed into the current connection',async()=>{
  const storage=new MemoryStorage(),first=createStudioContextSession(scope,{storage,nonce:()=> 'old-scope',fetcher:async(_url,init={})=>init.method==='POST'?Promise.reject(new Error('lost')):Response.json({projectId:scope.projectId,scopeId:scopeA,revision:0,terms:[],profiles:[]})});
  await first.load();first.setDraft(pair);await first.save();first.dispose();
  const current=createStudioContextSession(scope,{storage,fetcher:async()=>Response.json({projectId:scope.projectId,scopeId:scopeB,revision:0,terms:[],profiles:[]})});await current.load();let html=render(current);assert.equal(buttonDisabled(html,'저장 여부 확인'),true);assert.match(html,/이전 접속|다른 접속/);assert.match(html,/名前/);assert.match(html,/이름/);
  const key=storage.key(0),legacy=JSON.parse(storage.getItem(key));delete legacy.scopeId;storage.setItem(key,JSON.stringify(legacy));current.syncPending();html=render(current);assert.equal(buttonDisabled(html,'저장 여부 확인'),true);assert.match(html,/연결 정보/);
 });
});
