import {blockVisualSignature,getIssues,pageStatus,validatePendingBatch,type PendingBatch,type Project,type StudioPage,type TextBlock} from './studio-model';
import {normalizeReadingState,patchReadingPosition,readingSelection,type ReadingState,type ReadingPosition,type ReadingPatch} from './studio-reading';

export type PanelState={leftOpen:boolean;rightOpen:boolean;drawer:'pages'|'inspector'|null};
export type PanelEvent={type:'panel.set';panel:'left'|'right';open:boolean}|{type:'panel.toggle';panel:'left'|'right'}|{type:'drawer.open';drawer:Exclude<PanelState['drawer'],null>}|{type:'drawer.toggle';drawer:Exclude<PanelState['drawer'],null>}|{type:'drawer.close'};
/** Desktop preferences and the single temporary overlay have independent lifetimes. */
export function panelTransition(state:PanelState,event:PanelEvent):PanelState {
 if(event.type==='drawer.close')return state.drawer?{...state,drawer:null}:state;
 if(event.type==='drawer.open')return state.drawer===event.drawer?state:{...state,drawer:event.drawer};
 if(event.type==='drawer.toggle')return {...state,drawer:state.drawer===event.drawer?null:event.drawer};
 const key=event.panel==='left'?'leftOpen':'rightOpen';
 return {...state,[key]:event.type==='panel.toggle'?!state[key]:event.open,drawer:null};
}

export type HistoryState={past:Project[];future:Project[]};
export type DeletedProject={project:Project;index:number;wasActive:boolean;history?:HistoryState;reading?:ReadingPosition};
export type WorkspaceState={projects:Project[];activeId:string;histories:Record<string,HistoryState>;deletedProjects:DeletedProject[];reading:ReadingState};
export type WorkspaceEvent=
 |{type:'workspace.restore';projects:Project[];activeId:string;reading?:ReadingState}
 |{type:'reading.select';projectId:string;pageId:string}
 |{type:'reading.update';projectId:string;pageId:string;patch:ReadingPatch}
 |{type:'project.select';projectId:string}
 |{type:'project.delete';projectId:string}
 |{type:'project.restore-deleted'}
 |{type:'projects.replace';updater:(projects:Project[])=>Project[]}
 |{type:'project.update';projectId:string;updater:(project:Project)=>Project;history:'record'|'preserve'|'barrier';at:string;id:string;label?:string}
 |{type:'history.undo'|'history.redo';projectId:string;at?:string;id?:string}
 |{type:'history.checkpoint';projectId:string;before:Project}
 |{type:'history.block';projectId:string;target:BlockRestoreTarget;fields:'geometry'|'text'};
const EMPTY_HISTORY:HistoryState={past:[],future:[]};
export function createWorkspaceState(projects:Project[],activeId:string,reading?:ReadingState):WorkspaceState {
 return {projects,activeId:projects.some(p=>p.id===activeId)?activeId:projects[0]?.id||'',histories:{},deletedProjects:[],reading:normalizeReadingState(reading,projects)};
}
export function workspaceReducer(state:WorkspaceState,event:WorkspaceEvent):WorkspaceState {
 if(event.type==='workspace.restore')return createWorkspaceState(event.projects,event.activeId,event.reading);
 if(event.type==='reading.select'||event.type==='reading.update'){
  const project=state.projects.find(project=>project.id===event.projectId);if(!project)return state;
  const current=readingSelection(state.reading,project);if(!current)return state;
  if(event.type==='reading.update'&&current.pageId!==event.pageId)return state;
  const next=event.type==='reading.select'?readingSelection(state.reading,project,event.pageId):patchReadingPosition(current,event.patch);
  return next&&next!==current?{...state,reading:{...state.reading,[project.id]:next}}:state;
 }
 if(event.type==='project.select')return state.projects.some(p=>p.id===event.projectId)?{...state,activeId:event.projectId}:state;
 if(event.type==='projects.replace'){
  const projects=event.updater(state.projects);
  return {...state,projects,reading:normalizeReadingState(state.reading,projects),activeId:projects.some(p=>p.id===state.activeId)?state.activeId:projects[0]?.id||''};
 }
 if(event.type==='project.delete'){
  const index=state.projects.findIndex(project=>project.id===event.projectId);if(index<0)return state;
  const project=state.projects[index],wasActive=state.activeId===project.id;
  const projects=state.projects.filter(item=>item.id!==project.id),histories={...state.histories};delete histories[project.id];
  return {...state,projects,histories,reading:normalizeReadingState(state.reading,projects),activeId:wasActive?projects[Math.min(index,projects.length-1)]?.id||'':state.activeId,deletedProjects:[...state.deletedProjects,{project,index,wasActive,history:state.histories[project.id],reading:state.reading?.[project.id]}]};
 }
 if(event.type==='project.restore-deleted'){
  const deleted=state.deletedProjects.at(-1);if(!deleted||state.projects.some(project=>project.id===deleted.project.id))return state;
  const projects=[...state.projects];projects.splice(Math.min(deleted.index,projects.length),0,deleted.project);
  return {...state,projects,reading:normalizeReadingState({...state.reading,...(deleted.reading?{[deleted.project.id]:deleted.reading}:{})},projects),activeId:deleted.wasActive||!state.activeId?deleted.project.id:state.activeId,histories:deleted.history?{...state.histories,[deleted.project.id]:deleted.history}:state.histories,deletedProjects:state.deletedProjects.slice(0,-1)};
 }
 const current=state.projects.find(p=>p.id===event.projectId);if(!current)return state;
 const history=state.histories[event.projectId]||EMPTY_HISTORY;
 if(event.type==='history.block'){
  const page=current.pages.find(p=>p.id===event.target.pageId),block=page?.blocks.find(b=>b.id===event.target.block.id);
  const fields:Array<keyof TextBlock>=event.fields==='geometry'?['x','y','w','h']:['text'];
  if(!canEditPage(page)||!block)return state;
  const before=event.fields==='geometry'?restoreGeometry(current,event.target):restoreText(current,event.target);
  if(fields.every(key=>block[key]===event.target.block[key])){
   // A net-zero gesture may still have cleared a failure or legacy page flag.
   // Restore that metadata while retaining both undo and redo stacks.
   return before===current?state:{...state,projects:state.projects.map(p=>p.id===current.id?before:p)};
  }
  return {...state,histories:{...state.histories,[current.id]:{past:[...history.past.slice(-29),before],future:[]}}};
 }
 if(event.type==='history.checkpoint'){
  if(event.before.id!==current.id)return state;
  return {...state,histories:{...state.histories,[current.id]:{past:[...history.past.slice(-29),event.before],future:[]}}};
 }
 if(event.type==='history.undo'||event.type==='history.redo'){
  const undo=event.type==='history.undo',source=undo?history.past:history.future,next=source.at(-1);if(!next)return state;
  const updated=undo?{past:history.past.slice(0,-1),future:[...history.future.slice(-29),current]}:{past:[...history.past.slice(-29),current],future:history.future.slice(0,-1)};
  // Document snapshots cannot undo events that already happened (for example a download).
  const entry=event.at&&event.id?{id:event.id,at:event.at,text:undo?'되돌리기':'다시 실행',type:'edit' as const}:undefined;
  const restored={...next,history:entry?[...current.history,entry]:current.history,updatedAt:event.at||next.updatedAt};
  const projects=state.projects.map(p=>p.id===current.id?restored:p);
  return {...state,projects,reading:normalizeReadingState(state.reading,projects),histories:{...state.histories,[current.id]:updated}};
 }
 if(event.type!=='project.update')return state;
 const candidate=event.updater(current);if(candidate.id!==current.id)return state;
 if(candidate===current&&!event.label)return state;
 const next={...candidate,updatedAt:event.at,history:event.label?[...candidate.history,{id:event.id,at:event.at,text:event.label,type:'edit' as const}]:candidate.history};
 const nextHistory=event.history==='record'?{past:[...history.past.slice(-29),current],future:[]}:event.history==='barrier'?EMPTY_HISTORY:history;
 const projects=state.projects.map(p=>p.id===current.id?next:p);
 return {...state,projects,reading:normalizeReadingState(state.reading,projects),histories:{...state.histories,[current.id]:nextHistory}};
}

export type ActivityState={kind:'idle'}|
 {kind:'importing';id:string;projectId:string;pageId?:string;format:'images'|'project'|'ocr'}|
 {kind:'exporting';id:string;projectId:string;pageId?:string;format:'png'|'zip'|'project'}|
 {kind:'processing';id:string;projectId:string;pageId?:string;stage?:string;stopRequested?:boolean};
export type ActiveOperation=Exclude<ActivityState,{kind:'idle'}>;
export type ActivityEvent={type:'start';operation:ActiveOperation}|{type:'finish';id:string}|{type:'stop';id:string}|{type:'stage';id:string;pageId:string;stage:string};
export function activityTransition(state:ActivityState,event:ActivityEvent):ActivityState {
 if(event.type==='start')return state.kind==='idle'?event.operation:state;
 if(state.kind==='idle'||state.id!==event.id)return state;
 if(event.type==='finish')return {kind:'idle'};
 if(state.kind!=='processing')return state;
 if(event.type==='stop')return {...state,stopRequested:true};
 if(event.type==='stage')return {...state,stage:event.stage,pageId:event.pageId};
 return state;
}

export type ConnectionState={phase:'idle'}|{phase:'testing'|'ok'|'failed';id:string;endpoint:string};
export type ConnectionEvent={type:'reset'}|{type:'start'|'failure'|'success';id:string;endpoint:string};
export function connectionTransition(state:ConnectionState,event:ConnectionEvent):ConnectionState {
 if(event.type==='reset')return {phase:'idle'};
 if(event.type==='start')return {phase:'testing',id:event.id,endpoint:event.endpoint};
 if(state.phase!=='testing'||state.id!==event.id||state.endpoint!==event.endpoint)return state;
 return {...state,phase:event.type==='success'?'ok':'failed'};
}
export function connectionIsReady(state:ConnectionState,endpoint:string) {
 return state.phase==='ok'&&state.endpoint===endpoint.trim().replace(/\/$/,'');
}

export type PageEvent={type:'start';requestId:string}|{type:'job';requestId:string;jobId:string;endpoint:string;pageNumber?:number}|{type:'batch';requestId:string;intent:PendingBatch}|
 {type:'result';requestId:string;result:Pick<StudioPage,'blocks'|'cleanImage'|'finalImage'|'finalImageSignature'|'engineReview'>}|
 {type:'failure';requestId:string;error:string;terminal:boolean;retryableJob?:boolean}|{type:'pause';requestId:string;error?:string}|{type:'continue-editing'};
// Runtime tickets never become persisted editor revisions or cross-project cache values.
const pageInputs=new WeakMap<StudioPage,{image:string;content:string;generation:number;manual:boolean}>();
const pageContent=(page:StudioPage)=>JSON.stringify([page.width,page.height,page.blocks,page.cleanImage,page.finalImage,page.reviewed]);
export function canApplyPageResult(page:StudioPage){const ticket=pageInputs.get(page);return !!ticket&&!ticket.manual&&ticket.image===page.image&&ticket.content===pageContent(page)&&ticket.generation===(page.engineGeneration??0);}
export function transitionPage(page:StudioPage,event:PageEvent):StudioPage {
 if(event.type==='continue-editing')return {...page,status:page.blocks.length||page.processed?'review':'ready',reviewed:false,jobId:undefined,jobEndpoint:undefined,pendingBatch:undefined,requestId:undefined,error:undefined};
 if(event.type==='start'){
  if(page.status==='processing'&&page.requestId&&page.requestId!==event.requestId)return page;
  if(page.status==='processing'&&page.requestId===event.requestId)return page;
  const next={...page,status:'processing' as const,requestId:event.requestId,error:undefined};
  pageInputs.set(next,{image:page.image,content:pageContent(page),generation:page.engineGeneration??0,manual:page.reviewed||page.blocks.some(b=>b.userSourceBox!==undefined)||page.blocks.length>0&&page.finalImageSignature!==blockVisualSignature(page.blocks)});return next;
 }
 if(page.requestId!==event.requestId)return page;
 if(event.type==='batch'||event.type==='job'){
  const next=event.type==='batch'?{...page,pendingBatch:event.intent}:{...page,jobId:event.jobId,jobEndpoint:event.endpoint,...(event.pageNumber?{enginePageNumber:event.pageNumber}:{})};
  const ticket=pageInputs.get(page);if(ticket)pageInputs.set(next,ticket);return next;
 }
 if(event.type==='result'){
  if(!canApplyPageResult(page))return {...page,status:'review',requestId:undefined,error:'최신 사용자 수정과 확정값을 보존했어요. 이전 AI 후보는 적용하지 않았어요.'};
  return {...page,...event.result,engineReview:event.result.engineReview,status:'review',reviewed:false,processed:true,jobId:undefined,jobEndpoint:undefined,pendingBatch:undefined,requestId:undefined,error:undefined};
 }
 if(event.type==='failure')return {...page,status:'failed',requestId:undefined,error:event.error,...(event.terminal&&!event.retryableJob?{jobId:undefined,jobEndpoint:undefined}:{})};
 if(event.type==='pause'){
  const stopped={...page,requestId:undefined,status:'review' as const,...(event.error?{error:event.error}:{})};
  return {...stopped,status:page.jobId||page.pendingBatch?'paused':pageStatus(stopped)};
 }
 return page;
}
export function canEditPage(page:StudioPage|undefined) {return !!page&&!page.jobId&&!page.pendingBatch&&page.status!=='processing'&&page.status!=='paused';}

export function moveStudioPage(project:Project,pageId:string,direction:-1|1):Project {
 const from=project.pages.findIndex(page=>page.id===pageId), to=from+direction;
 if(from<0||to<0||to>=project.pages.length||!project.pages.every(canEditPage))return project;
 const pages=[...project.pages];
 [pages[from],pages[to]]=[pages[to],pages[from]];
 return {...project,pages};
}
/** Validate the entire receipt before attaching any ID; manual content stays on its existing objects. */
export function bindProjectBatch(project:Project,baseline:StudioPage[],requestId:string,change:{intent?:PendingBatch;bindings?:readonly {pageId:string;jobId:string;pageNumber?:number;batchKey?:string;generation?:number;sourceSha256?:string}[];pollPageIds:readonly string[]}):Project {
 const bindings=change.bindings||[],ids=change.intent?change.intent.members.map(member=>member.pageId):bindings.map(binding=>binding.pageId),poll=new Set(change.pollPageIds);
 if(new Set(ids).size!==ids.length||new Set(bindings.map(binding=>binding.jobId)).size!==bindings.length)throw new Error('배치 페이지 연결 정보가 중복됐어요.');
 const affected=new Set<string>();
 for(const id of ids){
  const current=project.pages.find(page=>page.id===id),expected=baseline.find(page=>page.id===id);
  if(!current||!expected){if(poll.has(id))throw new Error('배치 접수 뒤 원문 페이지가 변경됐어요.');continue;}
  const binding=bindings.find(binding=>binding.pageId===id);
  if(binding?.batchKey){
   const member=current.pendingBatch?.members.find(member=>member.pageId===id);
   if(current.pendingBatch?.key!==binding.batchKey||(current.engineGeneration??0)!==binding.generation||member?.generation!==binding.generation||member?.sourceSha256!==binding.sourceSha256){if(poll.has(id))throw new Error('이전 배치에서 분리한 페이지의 수정 내용을 보존했어요.');continue;}
  }
  if(current.processed===true&&!poll.has(id))continue;
  if(current.image!==expected.image||(current.engineGeneration??0)!==(expected.engineGeneration??0)||blockVisualSignature(current.blocks)!==blockVisualSignature(expected.blocks)||current.blocks.some((block,index)=>block.source!==expected.blocks[index]?.source)||(current.requestId&&current.requestId!==requestId))throw new Error('이전 배치 응답이 사용자 수정과 다른 페이지를 덮지 않도록 중지했어요.');
  if(change.intent)validatePendingBatch(change.intent,project.id,id);affected.add(id);
 }
 if(!affected.size)return project;
 return {...project,pages:project.pages.map(page=>{
  if(!affected.has(page.id))return page;
  let next=transitionPage(page,{type:'start',requestId});
  if(change.intent)next=transitionPage(next,{type:'batch',requestId,intent:change.intent});
  const binding=bindings.find(binding=>binding.pageId===page.id);
  if(binding)next=transitionPage(next,{type:'job',requestId,jobId:binding.jobId,endpoint:'/api/engine',pageNumber:binding.pageNumber});
  return poll.has(page.id)?next:transitionPage(next,{type:'pause',requestId});
 })};
}
/** Copy typography in one project edit without changing dialogue, regions or pending jobs. */
export function applyTextStyle(project:Project,sourcePageId:string,sourceBlockId:string,scope:'page'|'all'):Project {
 const sourcePage=project.pages.find(page=>page.id===sourcePageId);
 if(!canEditPage(sourcePage))return project;
 const source=sourcePage?.blocks.find(block=>block.id===sourceBlockId);if(!source)return project;
 const {font,size,weight,align,color,lineHeight}=source,style={font,size,weight,align,color,lineHeight};
 const keys=Object.keys(style) as Array<keyof typeof style>;let changed=false;
 const pages=project.pages.map(page=>{
  if((scope==='page'&&page.id!==sourcePageId)||!canEditPage(page))return page;
  let pageChanged=false;
  const blocks=page.blocks.map(block=>{
   if(keys.every(key=>block[key]===style[key]))return block;
   changed=true;pageChanged=true;return {...block,...style};
  });
  return pageChanged?{...page,blocks,status:blocks.length||page.processed?'review' as const:'ready' as const,reviewed:false,error:undefined}:page;
 });
 return changed?{...project,pages}:project;
}
export function canReviewPage(page:StudioPage|undefined) {return !!page&&canEditPage(page)&&(page.blocks.length>0||page.processed===true)&&getIssues(page).length===0;}
export function getRunTargets(project:Project,scope:'all'|'current',pageId?:string) {
 return scope==='current'?project.pages.filter(p=>p.id===pageId):project.pages.filter(page=>page.processed!==true||page.jobId||page.pendingBatch);
}

export type BlockRestoreTarget={pageId:string;block:TextBlock;reviewed:boolean;status:StudioPage['status'];beforePage?:StudioPage};
function restoreFields(project:Project,target:BlockRestoreTarget,keys:Array<keyof TextBlock>):Project {
 let changed=false;
 const pages=project.pages.map(page=>{
  if(page.id!==target.pageId||!canEditPage(page)||!page.blocks.some(block=>block.id===target.block.id))return page;
  const baseline=target.beforePage;
  const unchanged=!!baseline&&page.blocks.length===baseline.blocks.length&&page.cleanImage===baseline.cleanImage&&page.blocks.every((block,index)=>{
   const old=baseline.blocks[index];if(block.id!==target.block.id)return block===old;
   return Object.keys(block).every(key=>keys.includes(key as keyof TextBlock)||block[key as keyof TextBlock]===old[key as keyof TextBlock]);
  });
  const reviewed=unchanged?target.reviewed:false,status=unchanged?target.status:'review',error=unchanged?baseline?.error:page.error;
  let blockChanged=false;
  const blocks=page.blocks.map(block=>{
   if(block.id!==target.block.id||keys.every(key=>block[key]===target.block[key]))return block;
   blockChanged=true;const replacement={...block};for(const key of keys)Object.assign(replacement,{[key]:target.block[key]});return replacement;
  });
  if(!blockChanged&&page.reviewed===reviewed&&page.status===status&&page.error===error)return page;
  changed=true;return {...page,reviewed,status,error,blocks:blockChanged?blocks:page.blocks};
 });
 return changed?{...project,pages}:project;
}
export function restoreGeometry(project:Project,target:BlockRestoreTarget){return restoreFields(project,target,['x','y','w','h']);}
export function restoreText(project:Project,target:BlockRestoreTarget){return restoreFields(project,target,['text']);}

/** Settle this project's pending geometry before taking a text-session baseline. */
export function createTextEditTarget(project:Project,pageId:string,blockId:string,geometry?:BlockRestoreTarget):BlockRestoreTarget|undefined {
 const settled=geometry?restoreGeometry(project,geometry):project;
 const page=settled.pages.find(p=>p.id===pageId);if(!page||!canEditPage(page))return;
 const block=page.blocks.find(b=>b.id===blockId);if(!block)return;
 return {pageId,block,reviewed:page.reviewed,status:page.status,beforePage:page};
}
