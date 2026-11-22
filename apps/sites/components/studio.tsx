"use client";
import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useReducer,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {AlignCenter,AlignLeft,AlignRight,ArrowDownToLine,ArrowLeft,ArrowUpRight,Check,ChevronDown,ChevronLeft,ChevronRight,CircleCheck,Copy,Download,FileArchive,FileImage,FolderOpen,ImagePlus,Info,Keyboard,Layers,LoaderCircle,Maximize,Minus,MousePointer2,Paintbrush,Pipette,Plus,Redo2,Sparkles,SquareDashed,Trash2,Type,Undo2,Upload,WandSparkles,X,AlertTriangle} from 'lucide-react';
import {approvePageCandidate,pageReviewState,readEngineOutcome,canUseFinalImage,unchangedFinalCrops,clamp,emptyProject,measuredLetteringIds,FONT_NAMES,FONTS,getIssues,makeBlock,ocrBox,sampleProject,uid,validateProject,type CoverStroke,type PendingBatch,type Project,type StudioPage,type TextBlock} from '@/lib/studio-model';
import {canExportPage,exportAvailability,pageActivity,type ExportFormat} from '@/lib/studio-presentation';
import {resolveStudioShortcut} from '@/lib/studio-shortcuts';
import {type SavedWorkspace} from '@/lib/studio-storage';
import {useStudioPersistence} from '@/hooks/use-studio-persistence';
import {activityTransition,applyTextStyle,bindProjectBatch,canApplyPageResult,canEditPage,createTextEditTarget,createWorkspaceState,getRunTargets,moveStudioPage,panelTransition,restoreGeometry,restoreText,transitionPage,workspaceReducer,type ActiveOperation,type ActivityEvent,type ActivityState,type PageEvent,type BlockRestoreTarget} from '@/lib/studio-state';
import CanvasProjectPath from '@/components/canvas-project-path';
import CanvasBrowser,{CanvasBrowserControls} from '@/components/canvas-browser';
import ProjectOverview from '@/components/project-overview';
import type {CanvasLocation,ProjectSort} from '@/lib/studio-browser';
import StudioContextDialog from '@/components/studio-context-dialog';
import StudioTranslationReviewDialog from '@/components/studio-translation-review-dialog';
import StudioTextInventory from '@/components/studio-text-inventory';
import type {ContextScope} from '@/lib/studio-context';
import {DEFAULT_ENGINE_ENDPOINT,localStudioEndpoint,processPage,readPartialDraft,RETIRED_JOB_NOTICE,TerminalJobError} from '@/lib/studio-engine';
import {download,downloadPages,extractImages,fileDataURL,fileToPage,fitStudioBlock,loadImage,measureManualPreview,renderPage} from '@/lib/studio-files';
import {captureReadingAnchor,readingSelection,ReadingViewportSession,type ReadingAnchor,type ReadingPatch,type ReadingView} from '@/lib/studio-reading';
import {BatchPendingError,getBatchRunTargets,processProjectBatch,requestPagePriority,type BatchJobBinding} from '@/lib/studio-batch-engine';
type Modal='download'|'shortcuts'|'translation-review'|{kind:'delete-project';projectId:string}|{kind:'context';scope:ContextScope}|null;
type View=ReadingView;
function IconButton({children,label,onClick,active,disabled,expanded,controls,className=''}:{children:ReactNode;label:string;onClick?:()=>void;active?:boolean;disabled?:boolean;expanded?:boolean;controls?:string;className?:string}){
 return <button type="button" title={label} aria-label={label} aria-pressed={active} aria-expanded={expanded} aria-controls={controls} onClick={onClick} disabled={disabled} className={`icon-button ${active?'active':''} ${className}`}>{children}</button>;
}
function Dialog({title,eyebrow,children,onClose,wide=false,busy=false,descriptionId}:{title:string;eyebrow?:string;children:ReactNode;onClose:()=>void;wide?:boolean;busy?:boolean;descriptionId?:string}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
 return <dialog ref={ref} className={`dialog ${wide?'wide':''}`} onCancel={e=>{e.preventDefault();if(!busy)onClose();}} onClick={e=>{if(e.target===e.currentTarget&&!busy)onClose();}} aria-label={title} aria-describedby={descriptionId} aria-busy={busy}><div className="dialog-inner"><header className="dialog-header"><div>{eyebrow&&<span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><IconButton label="닫기" disabled={busy} onClick={onClose}><X size={19}/></IconButton></header>{children}</div></dialog>;
}
function errorText(error:unknown){return error instanceof Error?error.message:'작업을 완료하지 못했어요. 다시 시도해 주세요.';}

function ManualLettering({block,pageWidth,pageHeight,scale,outline,onMeasure}:{block:TextBlock;pageWidth:number;pageHeight:number;scale:number;outline?:CSSProperties;onMeasure:(id:string,fits:boolean)=>void}) {
 const [layout,setLayout]=useState<{block:TextBlock;width:number;lines:string[]}|null>(null);
 useEffect(()=>{
   if(!block.text)return;
   const ctx=document.createElement('canvas').getContext('2d');
   if(!ctx)return;
   let active=true;
   measureManualPreview(ctx,block,{width:pageWidth,height:pageHeight}).then(({lines,fits})=>{
     if(active){setLayout({block,width:pageWidth,lines:lines.map(line=>line.text)});onMeasure(block.id,fits);}
   }).catch(()=>{if(active)setLayout(null);});
   return ()=>{active=false;};
 },[block,pageWidth,pageHeight,onMeasure]);
 const lines=layout?.block===block && layout.width===pageWidth ? layout.lines : undefined;
 const vertical=block.writingMode==="vertical-rl";
 const pad=Math.max(0,(6+(block.strokeWidth??0))*scale-1);
 return <div className={`block-text ${block.text?'':'missing-text'} ${vertical?'is-vertical':''}`}
   style={{...outline,...(vertical?{writingMode:'vertical-rl',textOrientation:'upright',paddingBlock:pad}:{paddingInline:pad}),whiteSpace:lines?'pre':'pre-wrap',wordBreak:'keep-all'}}>
   {lines?.join('\n')??(block.text||'번역문 추가')}
 </div>;
}

export default function Studio(){
 const [workspace,dispatch]=useReducer(workspaceReducer,undefined,()=>createWorkspaceState([sampleProject()],'trio-sample-journey'));
 const {projects,activeId}=workspace;
 const placeholderProject=useMemo(()=>emptyProject('새 프로젝트'),[]);
 const workspaceRef=useRef(workspace);workspaceRef.current=workspace;
 const setProjects=useCallback((updater:(projects:Project[])=>Project[])=>dispatch({type:'projects.replace',updater}),[]);
 const [selectedId,setSelectedId]=useState<string|null>('p1-b1');
 const [editingId,setEditingId]=useState<string|null>(null);
 const [canvasLocation,setCanvasLocation]=useState<CanvasLocation>('editor');
 const [showOCR,setShowOCR]=useState(false);
 const [modal,setModalState]=useState<Modal>(null);
 const modalName=modal&&typeof modal==='object'?modal.kind:modal;
 const [typographyOpen,setTypographyOpen]=useState(true);
 const [stageSize,setStageSize]=useState({width:700,height:700});
 const [toast,setToast]=useState<{text:string;error?:boolean}|null>(null);
 const [endpoints,setEndpoints]=useState({local:'',online:DEFAULT_ENGINE_ENDPOINT});
 const [newProjectName,setNewProjectName]=useState('');
 const [projectSearch,setProjectSearch]=useState('');
 const [pageSearch,setPageSearch]=useState('');
 const [projectSort,setProjectSort]=useState<ProjectSort>('recent');
 const [browserSearchOpen,setBrowserSearchOpen]=useState(false);
 const [activity,setActivity]=useState<ActivityState>({kind:'idle'});
 const activityRef=useRef<ActivityState>({kind:'idle'});
 const [dragOver,setDragOver]=useState(false);
 const [pageDragOver,setPageDragOver]=useState(false);
 const [exportFormat,setExportFormat]=useState<ExportFormat>('png');
 const [panels,sendPanel]=useReducer(panelTransition,{leftOpen:true,rightOpen:true,drawer:null});
 const {leftOpen,rightOpen,drawer}=panels;
 const [compactPanels,setCompactPanels]=useState(false);
 const leftVisible=compactPanels?drawer==='pages':leftOpen,rightVisible=compactPanels?drawer==='inspector':rightOpen;
 const drawerTriggerRef=useRef<HTMLButtonElement|null>(null);
 const [scopeMenu,setScopeMenu]=useState(false);
 const [runScope,setRunScope]=useState<'all'|'current'>('all');
 const [showDevReview,setShowDevReview]=useState(false);
 const [batchProgress,setBatchProgress]=useState<{projectId:string;total:number;done:number;failed:number;pageName:string}|null>(null);
 const [tool,setTool]=useState<'select'|'brush'>('select');
 const [brushColor,setBrushColor]=useState('#ffffff');
 const [brushSize,setBrushSize]=useState(20);
 const [pipetteActive,setPipetteActive]=useState(false);
 const [draftStroke,setDraftStroke]=useState<CoverStroke|null>(null);
 const brushRef=useRef<{stroke:CoverStroke;pageId:string}|null>(null);
 const samplerCacheRef=useRef<{src:string;canvas:HTMLCanvasElement;ctx:CanvasRenderingContext2D}|null>(null);
 const inspectorTextRef=useRef<{projectId:string;target:BlockRestoreTarget;changed:boolean}|null>(null);
 const fileInput=useRef<HTMLInputElement>(null),projectInput=useRef<HTMLInputElement>(null);
 const stageRef=useRef<HTMLDivElement>(null),editableRef=useRef<HTMLDivElement>(null),runMenuRef=useRef<HTMLDivElement>(null),controllerRef=useRef<AbortController|null>(null);
 const viewportSession=useRef<ReadingViewportSession|null>(null);if(viewportSession.current===null){viewportSession.current=new ReadingViewportSession();}
 const viewportContext=useRef({ready:false,editor:false,projectId:'',pageId:''});
 const latestAnchor=useRef<{key:string;anchor:ReadingAnchor}|null>(null),restoringViewport=useRef<string|null>(null);
 const pendingReading=useRef<{projectId:string;pageId:string;anchor:ReadingAnchor}|null>(null),readingTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const editingRef=useRef<{projectId:string;target:BlockRestoreTarget;changed:boolean}|null>(null);
 const navigationRevision=useRef(0);
 const previousCanvasLocation=useRef(canvasLocation);
 const dragRef=useRef<{x:number;y:number;block:TextBlock;project:Project;pageId:string;scale:number;resize:boolean;moved:boolean}|null>(null);
 const activeProject=projects.find(p=>p.id===activeId),hasActiveProject=!!activeProject;
 const project=activeProject||placeholderProject;
 const reading=readingSelection(workspace.reading,project);
 const pageId=reading?.pageId||'',zoom=reading?.zoom??1,view=reading?.view??'preview';
 const deleteTarget=modal&&typeof modal==='object'&&modal.kind==='delete-project'?projects.find(item=>item.id===modal.projectId):undefined;
 const contextScope=modal&&typeof modal==='object'&&modal.kind==='context'?modal.scope:undefined;
 const lastDeletedProject=workspace.deletedProjects.at(-1);
 const page=project.pages.find(p=>p.id===pageId)||project.pages[0];
 const letteringClipId=useId();
 const letterCrops=useMemo(()=>page && (editingId || !canUseFinalImage(page)) ? unchangedFinalCrops(page,editingId) : undefined,[page,editingId]);
 const cropPath=useMemo(()=>page && letterCrops && Array.from(letterCrops.values(),r=>
   `M${r.left/page.width} ${r.top/page.height}h${r.width/page.width}v${r.height/page.height}h${-r.width/page.width}z`).join(' '),[letterCrops,page]);
 const textInventoryJobId=page?.status==='processing'?undefined:
  page?.jobEndpoint===DEFAULT_ENGINE_ENDPOINT?page.jobId:page?.textInventoryJobId;
 const retiredJob=!!page?.jobId&&!localStudioEndpoint(page);
 const [manualFits,setManualFits]=useState<{page:StudioPage;blocks:Map<string,boolean>}|null>(null);
 const recordManualFit=useCallback((id:string,fits:boolean)=>{
   if(!page)return;
   setManualFits(current=>{
     if(current?.page===page && current.blocks.get(id)===fits)return current;
     const blocks=new Map(current?.page===page ? current.blocks : []);
     blocks.set(id,fits);return {page,blocks};
   });
 },[page]);
 const issues=useMemo(()=>page?getIssues(page,manualFits?.page===page?manualFits.blocks:undefined):[],[page,manualFits]);
 const effects=page?.engineReview?.soundEffects;
 const selected=canvasLocation==='editor'?page?.blocks.find(b=>b.id===selectedId):undefined;
 const pageIndex=page?project.pages.findIndex(p=>p.id===page.id):0;
 const scale=page?Math.min((stageSize.width-(view==='compare'?96:84))/(page.width*(view==='compare'?2:1)),(stageSize.height-64)/page.height)*zoom:1;
 const safeScale=Math.max(.05,scale);
 const notify=useCallback((text:string,error=false)=>setToast({text,error}),[]);
 const restore=useCallback((saved:SavedWorkspace)=>{clearTimeout(readingTimer.current);pendingReading.current=null;latestAnchor.current=null;restoringViewport.current=null;dispatch({type:'workspace.restore',projects:saved.projects,activeId:saved.activeId,reading:saved.reading});setSelectedId(null);if(!saved.projects.length)setCanvasLocation('projects');setEndpoints({...saved.endpoints,online:saved.endpoints.online.trim()?saved.endpoints.online:DEFAULT_ENGINE_ENDPOINT});},[]);
 const savedValue=useMemo<SavedWorkspace>(()=>({version:1,projects,activeId,endpoints,reading:workspace.reading}),[projects,activeId,endpoints,workspace.reading]);
 const savedValueRef=useRef(savedValue);
 useLayoutEffect(()=>{savedValueRef.current=savedValue;},[savedValue]);
 const persistence=useStudioPersistence(savedValue,restore,notify);
 const {flush:flushPersistence}=persistence;
 const ready=persistence.hydration.phase==='ready',loaded=persistence.hydration.phase!=='loading';
 useLayoutEffect(()=>{viewportContext.current={ready,editor:canvasLocation==='editor',projectId:project.id,pageId:page?.id||''};},[ready,canvasLocation,project.id,page?.id]);
 const saveState=persistence.hydration.phase==='loading'?'loading':persistence.hydration.phase==='recovery'?'recovery':persistence.save.phase==='error'?'error':persistence.save.phase==='saved'?'saved':'saving';
 const running=activity.kind==='processing',uploading=activity.kind==='importing',exporting=activity.kind==='exporting',busy=activity.kind!=='idle';
 const canManageProjects=ready&&!busy,canMutate=canManageProjects&&hasActiveProject,canExport=loaded&&!busy&&hasActiveProject,canDeleteProjects=canManageProjects&&!(persistence.save.phase==='error'&&persistence.save.conflict),canEditCurrent=canvasLocation==='editor'&&canMutate&&canEditPage(page);
 const fitTarget=useRef<{page:StudioPage;block:TextBlock}|null>(null);
 useLayoutEffect(()=>{fitTarget.current=canEditCurrent && selected && page ? {page,block:selected} : null;return ()=>{fitTarget.current=null;};},[canEditCurrent,selected,page]);
 const canStoreContext=canEditCurrent&&!project.sample&&project.target==='ko'&&['ja','auto'].includes(project.source)&&/^[A-Za-z0-9_-]{1,128}$/.test(project.id)&&!!selected;
 const contextSelectionMatches=!!contextScope&&ready&&canvasLocation==='editor'&&project.id===contextScope.projectId&&page?.id===contextScope.pageId&&selected?.id===contextScope.regionId&&selected.source===contextScope.source&&selected.text===contextScope.translation;
 useEffect(()=>{if(contextScope&&!contextSelectionMatches)setModalState(null);},[contextScope,contextSelectionMatches]);
 const exportState=exportAvailability(exportFormat,project,page);
 const processingStage=activity.kind==='processing'?activity.stage||'엔진 연결 중':'';
 const history=workspace.histories[activeId],undoCount=history?.past.length||0,redoCount=history?.future.length||0;
 const commitPendingReading=useCallback(()=>{
  clearTimeout(readingTimer.current);const pending=pendingReading.current;pendingReading.current=null;
  if(pending)dispatch({type:'reading.update',projectId:pending.projectId,pageId:pending.pageId,patch:{anchor:pending.anchor}});
  return pending;
 },[]);
 const captureViewportReading=useCallback((immediate=true)=>{
  const context=viewportContext.current,element=stageRef.current;
  if(!context.ready||!context.editor||!context.pageId||!element||element.clientWidth<=0||element.clientHeight<=0)return;
  const key=JSON.stringify([context.projectId,context.pageId]);if(!immediate&&restoringViewport.current===key)return;
  const anchor=captureReadingAnchor(element);viewportSession.current?.activate(key);viewportSession.current?.interact(key);
  latestAnchor.current={key,anchor};pendingReading.current={projectId:context.projectId,pageId:context.pageId,anchor};
  if(immediate)return commitPendingReading();
  clearTimeout(readingTimer.current);readingTimer.current=setTimeout(commitPendingReading,100);
 },[commitPendingReading]);
 const readingInteraction=useCallback(()=>{const context=viewportContext.current;if(context.editor&&context.pageId){const key=JSON.stringify([context.projectId,context.pageId]);viewportSession.current?.interact(key);restoringViewport.current=null;}},[]);
 function updateReading(patch:ReadingPatch){if(!ready||!page)return;if(patch.anchor)latestAnchor.current={key:JSON.stringify([project.id,page.id]),anchor:patch.anchor};dispatch({type:'reading.update',projectId:project.id,pageId:page.id,patch});}
 function setZoom(value:number|((current:number)=>number)){captureViewportReading();updateReading({zoom:value});}
 function setView(value:View){captureViewportReading();updateReading({view:value});}
 function setPageId(id:string,projectId=project.id){captureViewportReading();dispatch({type:'reading.select',projectId,pageId:id});}
 function fitReadingViewport(){captureViewportReading();updateReading({zoom:1,anchor:{x:.5,y:0}});stageRef.current?.scrollTo({left:0,top:0});}
 const flushLatestReading=useCallback(()=>{
  if(!viewportContext.current.ready)return;
  const pending=captureViewportReading()||commitPendingReading(),current=workspaceRef.current;
  const next=pending?workspaceReducer(current,{type:'reading.update',projectId:pending.projectId,pageId:pending.pageId,patch:{anchor:pending.anchor}}):current;
  void flushPersistence({...savedValueRef.current,projects:next.projects,activeId:next.activeId,reading:next.reading}).catch(()=>{});
 },[captureViewportReading,commitPendingReading,flushPersistence]);
 useEffect(()=>{
  const hidden=()=>{if(document.visibilityState==='hidden')flushLatestReading();};
  document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',flushLatestReading);
  return()=>{clearTimeout(readingTimer.current);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',flushLatestReading);};
 },[flushLatestReading]);
 useLayoutEffect(()=>{
  const context=viewportContext.current;if(!context.ready||!context.editor||!context.pageId)return;
  const element=stageRef.current;if(!element)return;
  const current=workspaceRef.current,owner=current.projects.find(item=>item.id===context.projectId);
  const stored=owner?readingSelection(current.reading,owner,context.pageId):undefined;
  const key=JSON.stringify([context.projectId,context.pageId]),ticket=viewportSession.current!.activate(key);
  const anchor=latestAnchor.current?.key===key?latestAnchor.current.anchor:stored?.anchor||{x:.5,y:0};
  latestAnchor.current={key,anchor};restoringViewport.current=key;
  viewportSession.current!.restore(ticket,element,anchor);
  const frame=requestAnimationFrame(()=>{viewportSession.current?.restore(ticket,element,anchor);if(restoringViewport.current===key)restoringViewport.current=null;});
  return()=>{cancelAnimationFrame(frame);if(restoringViewport.current===key)restoringViewport.current=null;};
 },[ready,canvasLocation,project.id,page?.id,page?.width,page?.height,page?.image,page?.cleanImage,page?.finalImage,zoom,view,stageSize.width,stageSize.height]);
 useEffect(()=>{
  if(!ready||project.sample||!page?.id||!page.jobId)return;
  const controller=new AbortController();void requestPagePriority(project.id,page.id,controller.signal).catch(()=>{});
  return()=>controller.abort();
 },[ready,project.id,project.sample,page?.id,page?.jobId]);
 function sendActivity(event:ActivityEvent){const next=activityTransition(activityRef.current,event);activityRef.current=next;setActivity(next);return next;}
 function beginActivity(operation:ActiveOperation){if((!ready&&!(operation.kind==='exporting'&&loaded))||activityRef.current.kind!=='idle'){notify('진행 중인 작업이 끝난 뒤 다시 시도해 주세요.');return false;}setDragOver(false);setPageDragOver(false);finishEditing();cancelDrag();sendActivity({type:'start',operation});return true;}
 function closeDrawer(restoreFocus=true){setScopeMenu(false);sendPanel({type:'drawer.close'});if(restoreFocus)requestAnimationFrame(()=>drawerTriggerRef.current?.focus());}
 function toggleDrawer(next:'pages'|'inspector',trigger:HTMLButtonElement){finishEditing();cancelDrag();setScopeMenu(false);drawerTriggerRef.current=trigger;sendPanel({type:'drawer.toggle',drawer:next});}
 function togglePanel(side:'left'|'right',trigger:HTMLButtonElement){
  if(compactPanels){toggleDrawer(side==='left'?'pages':'inspector',trigger);return;}
  finishEditing();cancelDrag();setScopeMenu(false);sendPanel({type:'panel.toggle',panel:side});
 }
 function chooseCanvasView(next:View){navigationRevision.current++;finishEditing();cancelDrag();setCanvasLocation('editor');setView(next);if(next==='original'){setTool('select');setPipetteActive(false);}else setZoom(1);if(compactPanels)closeDrawer();}
 function chooseCanvasSelection(){navigationRevision.current++;finishEditing();cancelDrag();brushRef.current=null;setDraftStroke(null);setPipetteActive(false);setTool('select');setCanvasLocation('editor');if(compactPanels)closeDrawer();}
 function chooseBrushTool(){if(!canEditCurrent||view==='original')return;navigationRevision.current++;finishEditing();cancelDrag();setSelectedId(null);setPipetteActive(false);setTool('brush');setCanvasLocation('editor');if(compactPanels)closeDrawer();}
 function toggleCanvasOCR(){navigationRevision.current++;setCanvasLocation('editor');setShowOCR(value=>!value);if(compactPanels)closeDrawer();}
 function dropFiles(event:React.DragEvent<HTMLElement>){
  event.preventDefault();event.stopPropagation();setDragOver(false);setPageDragOver(false);if(canMutate)void importFiles(event.dataTransfer.files);
 }
 function showStorageRecovery(trigger:HTMLButtonElement){if(window.matchMedia('(max-width:760px)').matches)toggleDrawer('pages',trigger);else sendPanel({type:'panel.set',panel:'left',open:true});}
 function openContextDialog(){
  if(!canStoreContext||!selected||!page)return;
  const scope:ContextScope={projectId:project.id,pageId:page.id,regionId:selected.id,source:selected.source,translation:selected.text};
  if(editableRef.current&&editingRef.current?.target.block.id===selected.id){scope.translation=editableRef.current.innerText.replace(/\r/g,'').replace(/\n$/,'');commitText(editableRef.current,selected);}
  setModal({kind:'context',scope:Object.freeze(scope)});
 }
 function setModal(next:Modal){
  if(activityRef.current.kind==='exporting'&&next!=='download')return;
  if(next){finishEditing();cancelDrag();}
  closeDrawer(false);setScopeMenu(false);setModalState(next);
 }
 useEffect(()=>{const viewport=window.matchMedia('(max-width:760px)');setCompactPanels(viewport.matches);const change=()=>{setCompactPanels(viewport.matches);setScopeMenu(false);sendPanel({type:'drawer.close'});};viewport.addEventListener('change',change);return()=>viewport.removeEventListener('change',change);},[]);
 useEffect(()=>{setShowDevReview(new URLSearchParams(window.location.search).get('devReview')==='1');},[]);
 useEffect(()=>{const preventFileNavigation=(event:DragEvent)=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();};window.addEventListener('dragover',preventFileNavigation);window.addEventListener('drop',preventFileNavigation);return()=>{window.removeEventListener('dragover',preventFileNavigation);window.removeEventListener('drop',preventFileNavigation);};},[]);
 useEffect(()=>{if(drawer)document.getElementById(drawer==='pages'?'page-panel':'inspector-panel')?.querySelector<HTMLButtonElement>('button')?.focus();},[drawer]);
 useEffect(()=>()=>{controllerRef.current?.abort();},[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),5500);return()=>clearTimeout(timer);},[toast]);
 useEffect(()=>{const element=stageRef.current;if(!element)return;const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;setStageSize({width:rect.width,height:rect.height});});observer.observe(element);return()=>observer.disconnect();},[leftOpen,rightOpen,canvasLocation]);
 useEffect(()=>{
  const selectingCard=canvasLocation==='projects'&&previousCanvasLocation.current==='projects';
  previousCanvasLocation.current=canvasLocation;
  if(selectingCard)return;
  setBrowserSearchOpen(false);
  if(canvasLocation==='editor')stageRef.current?.focus();
  else{document.getElementById('canvas-browser')?.scrollTo({top:0});document.getElementById('canvas-browser-heading')?.focus();}
 },[canvasLocation,activeId]);
 useEffect(()=>{if(!editingId||!editableRef.current)return;const element=editableRef.current;element.focus();const range=document.createRange();range.selectNodeContents(element);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);},[editingId]);
 useEffect(()=>{if(!scopeMenu)return;const dismiss=(event:PointerEvent)=>{if(!runMenuRef.current?.contains(event.target as Node))setScopeMenu(false);};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss);},[scopeMenu]);
 const commitProject=useCallback((projectId:string,updater:(project:Project)=>Project,label?:string,mode:'record'|'preserve'|'barrier'='record')=>{dispatch({type:'project.update',projectId,updater,label,history:mode,at:new Date().toISOString(),id:uid()});},[]);
 const updateProject=useCallback((updater:(project:Project)=>Project,label?:string,record=true)=>{if(!ready||activityRef.current.kind!=='idle')return;commitProject(activeId,updater,label,record?'record':'preserve');},[activeId,ready,commitProject]);
 function updatePage(updater:(page:StudioPage)=>StudioPage,label?:string,record=true){
  if(!page||!canEditCurrent)return;const id=page.id;
  updateProject(p=>({...p,pages:p.pages.map(pg=>{if(pg.id!==id||!canEditPage(pg))return pg;const next=updater(pg);return next.blocks!==pg.blocks?{...next,status:next.blocks.length||next.processed?'review' as const:'ready' as const,reviewed:false,error:undefined}:next;})}),label,record);
 }
 function patchBlock(patch:Partial<TextBlock>,label='텍스트 스타일'){if(!selected||!canEditCurrent)return;updatePage(p=>({...p,blocks:p.blocks.map(b=>b.id===selected.id?{...b,...patch}:b)}),label==='텍스트 스타일'?`${page.name} · 텍스트 스타일 수정`:label);}
 async function fitSelected() {
  const target=fitTarget.current;
  if(!page || !selected || target?.page!==page || target.block!==selected)return;
  try {
   const size=measuredLetteringIds(page).has(selected.id) ? selected.size : await fitStudioBlock(selected,page);
   if(fitTarget.current!==target || activityRef.current.kind!=='idle')return;
   if(size===selected.size){notify('현재 글자 크기로 말풍선 안에 들어가요.');return;}
   patchBlock({size},page.name+' · 말풍선에 글자 맞춤');
  }catch(error){if(fitTarget.current===target)notify(errorText(error),true);}
 }
 const undo=useCallback(()=>{if(!ready||activityRef.current.kind!=='idle')return;finishEditing();cancelDrag();dispatch({type:'history.undo',projectId:activeId,at:new Date().toISOString(),id:uid()});setEditingId(null);},[activeId,ready]);
 const redo=useCallback(()=>{if(!ready||activityRef.current.kind!=='idle')return;finishEditing();cancelDrag();dispatch({type:'history.redo',projectId:activeId,at:new Date().toISOString(),id:uid()});setEditingId(null);},[activeId,ready]);
 function selectPage(id:string,blockId?:string,force=false){
  if(!force&&(!ready||activityRef.current.kind==='importing'||activityRef.current.kind==='exporting'))return;
  if(!force)navigationRevision.current++;closeDrawer(false);finishEditing();cancelDrag();const next=project.pages.find(p=>p.id===id);setPageId(id);setSelectedId(blockId||next?.blocks[0]?.id||null);setEditingId(null);setCanvasLocation('editor');
 }
 function navigatePage(direction:-1|1){const next=project.pages[pageIndex+direction];if(next)selectPage(next.id);}
 function selectProject(id:string,force=false,destination:CanvasLocation='editor'){
  if(!force&&(!ready||activityRef.current.kind==='importing'||activityRef.current.kind==='exporting'))return;
  if(!force)navigationRevision.current++;captureViewportReading();closeDrawer(false);finishEditing();cancelDrag();dispatch({type:'project.select',projectId:id});setSelectedId(null);setEditingId(null);setPageSearch('');setCanvasLocation(destination);setModal(null);
 }
 function selectProjectCard(id:string,trigger:HTMLButtonElement){
  if(!ready||activityRef.current.kind==='importing'||activityRef.current.kind==='exporting'||!workspaceRef.current.projects.some(item=>item.id===id))return;
  selectProject(id,false,'projects');
  drawerTriggerRef.current=trigger;
  if(window.matchMedia('(max-width:760px)').matches)sendPanel({type:'drawer.open',drawer:'pages'});
  else sendPanel({type:'panel.set',panel:'left',open:true});
  requestAnimationFrame(()=>document.getElementById('project-overview-heading')?.focus());
 }
 function showCanvasLocation(next:CanvasLocation){
  if(activityRef.current.kind==='exporting')return;
  navigationRevision.current++;captureViewportReading();finishEditing();cancelDrag();closeDrawer(false);setModal(null);setCanvasLocation(next);
 }
 function openProjectPage(projectId:string,nextPageId:string){
  if(!ready||uploading||exporting)return;
  if(projectId===activeId)selectPage(nextPageId);
  else{selectProject(projectId);setPageId(nextPageId,projectId);}
 }
 function createProject(){
  if(!newProjectName.trim()||!canManageProjects)return;
  const created=emptyProject(newProjectName.trim().slice(0,80));setProjects(items=>[...items,created]);selectProject(created.id,false,'pages');setNewProjectName('');notify('새 프로젝트를 만들었어요. 이미지를 추가해 시작하세요.');
 }
 function requestProjectDeletion(id:string){
  if(!canDeleteProjects||activityRef.current.kind!=='idle'||!workspaceRef.current.projects.some(item=>item.id===id))return;
  setModal({kind:'delete-project',projectId:id});
 }
 function confirmProjectDeletion(){
  if(!deleteTarget||!canDeleteProjects||activityRef.current.kind!=='idle')return;
  navigationRevision.current++;captureViewportReading();finishEditing();cancelDrag();
  dispatch({type:'project.delete',projectId:deleteTarget.id});
  if(deleteTarget.id===activeId){setSelectedId(null);setEditingId(null);setPageSearch('');}
  setModal(null);setCanvasLocation('projects');requestAnimationFrame(()=>document.getElementById('canvas-browser-heading')?.focus());
 }
 function undoProjectDeletion(){
  const deleted=workspaceRef.current.deletedProjects.at(-1);if(!deleted||!canManageProjects||activityRef.current.kind!=='idle')return;
  if(workspaceRef.current.projects.some(item=>item.id===deleted.project.id)){notify('같은 ID의 프로젝트가 있어 복원하지 않았어요.',true);return;}
  navigationRevision.current++;finishEditing();cancelDrag();dispatch({type:'project.restore-deleted'});
  if(deleted.wasActive||!activeId){setSelectedId(null);setEditingId(null);setPageSearch('');}
  setCanvasLocation('projects');requestAnimationFrame(()=>document.getElementById('canvas-browser-heading')?.focus());
 }
 function addText(){if(!page||!canEditCurrent)return;const block=makeBlock({size:Math.max(18,Math.round(page.width*.032))});updatePage(p=>({...p,blocks:[...p.blocks,block]}),`${page.name} · 텍스트 영역 추가`);setSelectedId(block.id);beginEditing(block,{...page,blocks:[...page.blocks,block]});setView('preview');}
 useEffect(()=>{
  function key(event:KeyboardEvent){
   const target=event.target as HTMLElement;
   const command=resolveStudioShortcut(event,{ready,busy:activityRef.current.kind!=='idle',hasPage:!!page,modal:modal!==null,drawer:drawer!==null,scopeMenu,editable:!!target?.closest('input,textarea,select,[contenteditable],dialog'),browsing:canvasLocation!=='editor'});
   if(!command)return;
   if(command!=='cycle-drawer'&&command!=='next-page'&&command!=='previous-page')event.preventDefault();
   switch(command){
    case 'consume':return;
    case 'download':if(editableRef.current&&selected)commitText(editableRef.current,selected);setModal('download');return;
    case 'close-scope':setScopeMenu(false);return;
    case 'close-drawer':closeDrawer();return;
    case 'cycle-drawer':{
     const panel=document.getElementById(drawer==='pages'?'page-panel':'inspector-panel');const items=Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||[]).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}return;
    }
    case 'undo':undo();return;
    case 'redo':redo();return;
    case 'shortcuts':setModal('shortcuts');return;
    case 'select':chooseCanvasSelection();return;
    case 'brush':chooseBrushTool();return;
    case 'add-text':addText();return;
    case 'toggle-ocr':setShowOCR(value=>!value);return;
    case 'clear-selection':cancelDrag();brushRef.current=null;setDraftStroke(null);setPipetteActive(false);if(tool==='brush')setTool('select');setSelectedId(null);setEditingId(null);return;
    case 'next-page':if(project.pages[pageIndex+1]){event.preventDefault();navigatePage(1);}return;
    case 'previous-page':if(project.pages[pageIndex-1]){event.preventDefault();navigatePage(-1);}return;
   }
  }
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 });
 async function importFiles(list:FileList|File[]|null){
  if(!list?.length)return;const operation:ActiveOperation={kind:'importing',id:uid(),projectId:project.id,format:'images'};
  if(!beginActivity(operation))return;const target=project,followRevision=navigationRevision.current;
  try{
   const files=await extractImages(Array.from(list));if((target.sample?0:target.pages.length)+files.length>200)throw new Error('프로젝트 한 개는 최대 200페이지까지 지원해요.');
   const pages:StudioPage[]=[];for(const file of files)pages.push(await fileToPage(file));
   if(target.sample){const created=emptyProject('새 만화 프로젝트');created.pages=pages;created.history=[{id:uid(),at:new Date().toISOString(),text:`이미지 ${pages.length}페이지 추가`,type:'import'}];setProjects(p=>[...p,created]);if(navigationRevision.current===followRevision){selectProject(created.id,true,canvasLocation==='editor'?'editor':'pages');setPageId(pages[0].id);}notify(`${pages.length}페이지로 새 프로젝트를 만들었어요.`);}
   else{commitProject(target.id,p=>({...p,pages:[...p.pages,...pages]}),`${pages.length}페이지 추가`,'barrier');if(workspaceRef.current.activeId===target.id&&navigationRevision.current===followRevision){setPageId(pages[0].id);setSelectedId(null);setEditingId(null);}notify(`${pages.length}페이지를 추가했어요. 처리 엔진을 연결하거나 텍스트를 직접 추가하세요.`);}
  }catch(error){notify(errorText(error),true);}finally{sendActivity({type:'finish',id:operation.id});if(fileInput.current)fileInput.current.value='';}
 }
 async function importProject(file:File|undefined){
  if(!file)return;const operation:ActiveOperation={kind:'importing',id:uid(),projectId:project.id,format:'project'};if(!beginActivity(operation))return;const followRevision=navigationRevision.current;
  try{if(file.size>220*1024*1024)throw new Error('프로젝트 파일은 220MB 이하여야 해요.');const data=JSON.parse(await file.text());if(data.format&&data.format!=='trio-studio-v1')throw new Error('지원하지 않는 프로젝트 파일 버전이에요.');const imported=validateProject(data.project||data);setProjects(p=>[...p,imported]);if(navigationRevision.current===followRevision)selectProject(imported.id,true,'pages');notify('프로젝트를 불러왔어요.');}
  catch(error){notify(errorText(error),true);}finally{sendActivity({type:'finish',id:operation.id});if(projectInput.current)projectInput.current.value='';}
 }
 async function run(scope:'all'|'current'='all'){
  if(!project.pages.length||!canMutate||activityRef.current.kind!=='idle')return;
  if(project.sample){notify('샘플은 편집용이에요. 새 프로젝트에 이미지를 추가해 처리해 주세요.');return;}
  const targets=getRunTargets(project,scope,page?.id);if(!targets.length)return;
  const retired=targets.find(target=>!localStudioEndpoint(target));
  if(retired){selectPage(retired.id);notify(`${retired.name} · ${RETIRED_JOB_NOTICE}`,true);return;}
  const endpoint=DEFAULT_ENGINE_ENDPOINT;
  const operation:ActiveOperation={kind:'processing',id:uid(),projectId:project.id};if(!beginActivity(operation))return;
  const controller=new AbortController();controllerRef.current=controller;const targetProject=project;let success=0,failed=0,stopped=0;
  const pageNameById=new Map(targets.map(item=>[item.id,item.name]));
  setBatchProgress({projectId:targetProject.id,total:targets.length,done:0,failed:0,pageName:targets[0]?.name||''});
  const syncBatchProgress=(activeId?:string)=>setBatchProgress(current=>current?{...current,done:success,failed,pageName:activeId?(pageNameById.get(activeId)??current.pageName):current.pageName}:current);
  const observed=new Map<string,StudioPage['engineOutcome']>();
  const settled=new Set<string>(),pendingKnown=new Set(targets.filter(page=>page.jobId||page.pendingBatch).map(page=>page.id));
  const pageEvent=(id:string,event:PageEvent,label?:string)=>{
   const current=workspaceRef.current.projects.find(p=>p.id===targetProject.id)?.pages.find(pg=>pg.id===id);
   const accepted=event.type!=='result'||!!current&&current.requestId===event.requestId&&canApplyPageResult(current);
   commitProject(targetProject.id,p=>({...p,pages:p.pages.map(pg=>{if(pg.id!==id)return pg;const next=transitionPage(pg,event);return next!==pg&&((event.type==='result'&&accepted)||(event.type==='failure'&&event.terminal&&!event.retryableJob))?{...next,engineGeneration:(pg.engineGeneration??0)+1}:next;})}),label,'barrier');return accepted;
  };
  const storeReceipt=async(change:{intent?:PendingBatch;bindings?:BatchJobBinding[]})=>{
   const event={type:'project.update' as const,projectId:targetProject.id,updater:(current:Project)=>bindProjectBatch(current,targetProject.pages,operation.id,{...change,pollPageIds:targets.map(page=>page.id)}),history:'barrier' as const,at:new Date().toISOString(),id:uid()};
   // Concurrent retry receipts must reach the reducer before capturing one complete durable snapshot.
   flushSync(()=>dispatch(event));
   const current=workspaceRef.current;
   await flushPersistence({...savedValueRef.current,projects:current.projects,activeId:current.activeId,reading:current.reading});
   for(const id of change.intent?.members.map(member=>member.pageId)||change.bindings?.map(binding=>binding.pageId)||[])pendingKnown.add(id);
  };
  try{
   const batchTargets=getBatchRunTargets(targets,scope,endpoint),batchIds=new Set(batchTargets.map(page=>page.id));
   if(batchTargets.length){
    for(const target of batchTargets)pageEvent(target.id,{type:'start',requestId:operation.id});
    await processProjectBatch(targetProject,batchTargets,DEFAULT_ENGINE_ENDPOINT,targetProject.source,targetProject.target,controller.signal,{
     onIntent:intent=>storeReceipt({intent}),onJobs:bindings=>storeReceipt({bindings}),
     onObservation:(id,job)=>{observed.set(id,readEngineOutcome(job.reviewState));},
     onStage:(id,stage)=>{sendActivity({type:'stage',id:operation.id,pageId:id,stage});syncBatchProgress(id);},
     onResult:(id,result)=>{settled.add(id);if(pageEvent(id,{type:'result',requestId:operation.id,result},'OCR·번역 결과 수신'))success++;else stopped++;syncBatchProgress(id);},
     onError:(id,error,terminal,retryableJob)=>{settled.add(id);if(error instanceof BatchPendingError)stopped++;else failed++;pageEvent(id,error instanceof BatchPendingError?{type:'pause',requestId:operation.id,error:errorText(error),outcome:observed.get(id)??'RESULT_UNKNOWN'}:{type:'failure',requestId:operation.id,error:errorText(error),terminal,retryableJob,outcome:observed.get(id)},errorText(error));syncBatchProgress(id);},
    },{currentPageId:()=>workspaceRef.current.reading?.[targetProject.id]?.pageId});
   }
   for(const target of targets.filter(page=>!batchIds.has(page.id))){
    if(controller.signal.aborted)break;const base=endpoint;
    pageEvent(target.id,{type:'start',requestId:operation.id});sendActivity({type:'stage',id:operation.id,pageId:target.id,stage:target.jobId?'저장한 작업 조회':'엔진 연결 중'});syncBatchProgress(target.id);
    // Background pages can finish while the reader stays on the chosen page.
    try{
      const result=await processPage(target,base,targetProject.source,targetProject.target,controller.signal,id=>storeReceipt({bindings:[{pageId:target.id,jobId:id}]}),stage=>{sendActivity({type:'stage',id:operation.id,pageId:target.id,stage});syncBatchProgress(target.id);},{projectId:targetProject.id});
     if(controller.signal.aborted){pageEvent(target.id,{type:'pause',requestId:operation.id});stopped++;break;}
     if(pageEvent(target.id,{type:'result',requestId:operation.id,result},`${target.name} · OCR·번역 결과 수신`))success++;else stopped++;settled.add(target.id);syncBatchProgress(target.id);
    }catch(error){
     if(controller.signal.aborted){pageEvent(target.id,{type:'pause',requestId:operation.id},`${target.name} · 상태 조회 중지 (엔진 작업 취소 아님)`);stopped++;break;}
     pageEvent(target.id,error instanceof TerminalJobError&&error.outcome==='RESULT_UNKNOWN'?{type:'pause',requestId:operation.id,error:errorText(error),outcome:error.outcome}:{type:'failure',requestId:operation.id,error:errorText(error),terminal:error instanceof TerminalJobError&&error.terminal,retryableJob:error instanceof TerminalJobError&&error.retryableJob,outcome:error instanceof TerminalJobError?error.outcome:undefined},`${target.name} · ${errorText(error)}`);failed++;settled.add(target.id);syncBatchProgress(target.id);
    }
   }
  }catch(error){
   for(const target of targets){if(settled.has(target.id))continue;if(controller.signal.aborted||pendingKnown.has(target.id)){pageEvent(target.id,{type:'pause',requestId:operation.id,error:controller.signal.aborted?undefined:errorText(error)});stopped++;}else{pageEvent(target.id,{type:'failure',requestId:operation.id,error:errorText(error),terminal:false});failed++;}}
  }finally{
   setBatchProgress(null);
   sendActivity({type:'finish',id:operation.id});if(controllerRef.current===controller)controllerRef.current=null;
   notify(controller.signal.aborted?`조회 중지 · 완료 ${success}, 오류 ${failed}, 대기 ${targets.length-success-failed}. 엔진 작업은 취소하지 않았어요.`:`처리 결과 · 완료 ${success}, 오류 ${failed}${stopped?`, 조회 대기 ${stopped}`:''}. ${failed?'오류 페이지에서 재시도할 수 있어요.':stopped?'보관한 접수 정보로 조회를 재개할 수 있어요.':'캔버스에서 결과를 직접 확인해 주세요.'}`,failed>0);
  }
 }
 function stopRun(){const current=activityRef.current;if(current.kind!=='processing')return;sendActivity({type:'stop',id:current.id});controllerRef.current?.abort();}
  function continueEditing(){if(!page||!canMutate)return;commitProject(project.id,p=>({...p,pages:p.pages.map(pg=>pg.id===page.id?{...transitionPage(pg,{type:'continue-editing'}),engineGeneration:(pg.engineGeneration??0)+1}:pg)}),`${page.name} · 이전 결과로 편집 계속 (엔진 작업 취소 아님)`,'barrier');notify('이전 결과로 편집을 계속해요. 엔진 작업은 취소하지 않았어요.');}
  async function loadPartialDraft(){
   if(!page||!page.jobId||!canMutate||retiredJob)return;
   const targetProjectId=project.id,targetPageId=page.id,targetPageName=page.name,targetJobId=page.jobId;
   const operation:ActiveOperation={kind:'processing',id:uid(),projectId:targetProjectId,pageId:targetPageId,stage:'부분 처리 초안 불러오는 중'};
   if(!beginActivity(operation))return;
   const controller=new AbortController();controllerRef.current=controller;
   try{
    const draft=await readPartialDraft(targetJobId,controller.signal);
    if(controller.signal.aborted)return;
    commitProject(targetProjectId,p=>({...p,pages:p.pages.map(pg=>{
     if(pg.id!==targetPageId||pg.jobId!==targetJobId)return pg;
     return {...pg,cleanImage:draft.cleanImage,finalImage:undefined,finalImageSignature:undefined,blocks:draft.blocks,
      engineReview:draft.engineReview,status:'review' as const,reviewed:false,processed:true,
      jobId:undefined,batchId:undefined,jobEndpoint:undefined,pendingBatch:undefined,requestId:undefined,
      error:undefined,engineOutcome:undefined,textInventoryJobId:targetJobId,engineGeneration:(pg.engineGeneration??0)+1};
    })}),`${targetPageName} · 원문 제거·번역 초안 불러와 수동 식자`,'barrier');
    setSelectedId(draft.rejectedRegionId??draft.blocks[0]?.id??null);
    setView('preview');
    notify(draft.rejectedRegionId?`원문 제거 이미지와 번역 ${draft.blocks.length}개를 불러왔어요. 수동 확인 영역(${draft.rejectedRegionId})을 조정해 주세요.`:`원문 제거 이미지와 번역 ${draft.blocks.length}개를 불러왔어요. 캔버스에서 식자를 조정해 주세요.`);
   }catch(error){notify(errorText(error),true);}
   finally{sendActivity({type:'finish',id:operation.id});if(controllerRef.current===controller)controllerRef.current=null;}
  }
 async function exportResult(){
  const allowed=exportAvailability(exportFormat,project,page);if(!allowed.allowed){notify(allowed.reason!,true);return;}
  const format=exportFormat,target=project,targetPage=page;const operation:ActiveOperation={kind:'exporting',id:uid(),projectId:target.id,pageId:targetPage?.id,format};if(!beginActivity(operation))return;
  try{
   if(format==='png'&&targetPage)download(await renderPage(targetPage),targetPage.name.replace(/\.[^.]+$/,'')+'-trio.png');
   if(format==='zip'){const pages=target.pages.filter(canExportPage);if(!pages.length)throw new Error('내보낼 완료 결과가 없어요. 먼저 상태를 확인해 주세요.');await downloadPages(pages,target.name);}
   if(format==='project'){const copy={...target,pages:await Promise.all(target.pages.map(async pg=>({...pg,image:pg.image.startsWith('/samples/')?await fileDataURL(await(await fetch(pg.image)).blob()):pg.image})))};download(new Blob([JSON.stringify({format:'trio-studio-v1',project:copy})],{type:'application/json'}),target.name+'.trio');}
   const entry={id:uid(),at:new Date().toISOString(),text:format==='project'?'프로젝트 백업 다운로드 요청':`${format.toUpperCase()} 결과 다운로드 요청`,type:'export' as const};commitProject(target.id,p=>({...p,history:[...p.history,entry]}),undefined,'preserve');
   sendActivity({type:'finish',id:operation.id});setModal(null);notify('다운로드를 요청했어요. 브라우저의 다운로드 목록에서 확인하세요.');
  }catch(error){notify(errorText(error),true);}finally{sendActivity({type:'finish',id:operation.id});}
 }
 function startDrag(event:React.PointerEvent<HTMLElement>,block:TextBlock,resize=false){
  if(!canEditCurrent||editingId===block.id||view==='original'||event.button!==0)return;event.stopPropagation();setSelectedId(block.id);dragRef.current={x:event.clientX,y:event.clientY,block,project,pageId:page.id,scale:safeScale,resize,moved:false};event.currentTarget.setPointerCapture(event.pointerId);
 }
 function moveDrag(event:React.PointerEvent<HTMLElement>){
  const gesture=dragRef.current;if(!gesture)return;const target=gesture.project.pages.find(pg=>pg.id===gesture.pageId)!;
  const dx=(event.clientX-gesture.x)/(target.width*gesture.scale)*100,dy=(event.clientY-gesture.y)/(target.height*gesture.scale)*100;if(Math.abs(dx)+Math.abs(dy)<.15&&!gesture.moved)return;gesture.moved=true;
  const block=gesture.block,patch=gesture.resize?{w:clamp(block.w+dx,3,100-block.x),h:clamp(block.h+dy,3,100-block.y)}:{x:clamp(block.x+dx,0,100-block.w),y:clamp(block.y+dy,0,100-block.h)};
  commitProject(gesture.project.id,p=>({...p,pages:p.pages.map(pg=>pg.id===gesture.pageId?{...pg,status:'review',reviewed:false,error:undefined,blocks:pg.blocks.map(b=>b.id===block.id?{...b,...patch}:b)}:pg)}),undefined,'preserve');
 }
 function endDrag(){const gesture=dragRef.current;if(!gesture)return;dragRef.current=null;if(gesture.moved){const baseline=gesture.project.pages.find(pg=>pg.id===gesture.pageId)!;dispatch({type:'history.block',projectId:gesture.project.id,fields:'geometry',target:{pageId:gesture.pageId,block:gesture.block,reviewed:baseline.reviewed,status:baseline.status,beforePage:baseline}});}}
 function cancelDrag(){const gesture=dragRef.current;dragRef.current=null;if(!gesture?.moved)return;const baseline=gesture.project.pages.find(pg=>pg.id===gesture.pageId)!;commitProject(gesture.project.id,p=>restoreGeometry(p,{pageId:gesture.pageId,block:gesture.block,reviewed:baseline.reviewed,status:baseline.status,beforePage:baseline}),undefined,'preserve');}
 function beginEditing(block:TextBlock,sourcePage=page){
  if(!sourcePage||!canMutate||!canEditPage(sourcePage))return;
  const gesture=dragRef.current,baseline=gesture?.project.pages.find(p=>p.id===gesture.pageId);
  const geometry=gesture?.moved&&gesture.project.id===project.id&&baseline?{pageId:gesture.pageId,block:gesture.block,reviewed:baseline.reviewed,status:baseline.status,beforePage:baseline}:undefined;
  const target=createTextEditTarget({...project,pages:project.pages.map(p=>p.id===sourcePage.id?sourcePage:p)},sourcePage.id,block.id,geometry);if(!target)return;
  closeDrawer(false);finishEditing();cancelDrag();editingRef.current={projectId:project.id,target,changed:false};setEditingId(target.block.id);
 }
 function recordDraft(element:HTMLDivElement){
  const session=editingRef.current;if(!session||!ready||activityRef.current.kind!=='idle')return;
  const text=element.innerText.replace(/\r/g,'').replace(/\n$/,'');const changed=text!==session.target.block.text;session.changed=changed;
  commitProject(session.projectId,p=>changed?({...p,pages:p.pages.map(pg=>pg.id===session.target.pageId&&canEditPage(pg)?{...pg,status:'review',reviewed:false,error:undefined,blocks:pg.blocks.map(b=>b.id===session.target.block.id?{...b,text}:b)}:pg)}):restoreText(p,session.target),undefined,'preserve');
 }
 function commitInspectorText(){
  const session=inspectorTextRef.current;if(!session)return;inspectorTextRef.current=null;
  if(session.changed){dispatch({type:'history.block',projectId:session.projectId,fields:'text',target:session.target});commitProject(session.projectId,p=>p,`${session.target.beforePage?.name||'페이지'} · 번역문 직접 수정`,'preserve');}
 }
 function finishEditing(){
  commitInspectorText();
  const session=editingRef.current;if(!session)return;editingRef.current=null;
  if(session.changed){dispatch({type:'history.block',projectId:session.projectId,fields:'text',target:session.target});commitProject(session.projectId,p=>p,`${session.target.beforePage?.name||'페이지'} · 번역문 직접 수정`,'preserve');}
  setEditingId(null);
 }
 function patchStroke(width:number,color?:string){
  if(!selected||!page||!canEditCurrent)return;
  if(!Number.isFinite(width)||width<=0){patchBlock({strokeWidth:undefined,strokeColor:undefined},`${page.name} · 글자 외곽선 해제`);return;}
  const nextColor=color||selected.strokeColor||(selected.color?.toLowerCase()==='#ffffff'?'#000000':'#ffffff');
  patchBlock({strokeWidth:clamp(Math.round(width*2)/2,.5,8),strokeColor:nextColor},`${page.name} · 글자 외곽선 수정`);
 }
 function cancelEditing(){
  const session=editingRef.current;if(!session)return;editingRef.current=null;
  if(session.changed)commitProject(session.projectId,p=>restoreText(p,session.target),undefined,'preserve');setEditingId(null);
 }
 function commitText(element:HTMLDivElement,block:TextBlock){if(editingRef.current?.target.block.id!==block.id)return;recordDraft(element);finishEditing();}
 function applyStyle(scope:'page'|'all'){
  if(!selected||!page||!canEditCurrent||activityRef.current.kind!=='idle')return;
  const sourcePageId=page.id,sourceBlockId=selected.id;
  const targets=project.pages.filter(p=>(scope==='all'||p.id===sourcePageId)&&p.blocks.length>0);
  const applied=targets.filter(canEditPage).length,skipped=targets.length-applied;
  finishEditing();cancelDrag();
  if(applyTextStyle(project,sourcePageId,sourceBlockId,scope)===project){notify('이미 같은 스타일이 적용되어 있어요.');return;}
  updateProject(p=>applyTextStyle(p,sourcePageId,sourceBlockId,scope),scope==='all'?'모든 페이지에 스타일 적용':`${page.name} · 페이지 전체 스타일 적용`);
  notify(scope==='all'?`${applied}개 페이지의 텍스트에 스타일을 적용했어요.${skipped?` 편집할 수 없는 ${skipped}개 페이지는 제외했어요.`:''}`:'이 페이지의 모든 텍스트에 적용했어요.');
 }
 function openProjectBackup(){setExportFormat('project');setModal('download');}
 async function sampleBrushColor(pctX:number,pctY:number){
  if(!page)return;
  const src=page.cleanImage||page.image;
  try{
   let cached=samplerCacheRef.current;
   if(!cached||cached.src!==src){
    const img=await loadImage(src);
    const canvas=document.createElement('canvas');canvas.width=img.naturalWidth||page.width;canvas.height=img.naturalHeight||page.height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)return;
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    cached={src,canvas,ctx};samplerCacheRef.current=cached;
   }
   const px=clamp(Math.floor(pctX/100*cached.canvas.width),0,cached.canvas.width-1);
   const py=clamp(Math.floor(pctY/100*cached.canvas.height),0,cached.canvas.height-1);
   const d=cached.ctx.getImageData(px,py,1,1).data;
   const hex='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
   setBrushColor(hex);setPipetteActive(false);notify(`배경색 ${hex.toUpperCase()}를 추출했어요.`);
  }catch{notify('배경색을 추출하지 못했어요.',true);}
 }
 function brushPointFromEvent(event:React.PointerEvent<HTMLDivElement>){
  const rect=event.currentTarget.getBoundingClientRect();
  return {x:clamp((event.clientX-rect.left)/Math.max(1,rect.width)*100,0,100),y:clamp((event.clientY-rect.top)/Math.max(1,rect.height)*100,0,100)};
 }
 function onBrushPointerDown(event:React.PointerEvent<HTMLDivElement>){
  if(!page||!canEditCurrent||tool!=='brush'||event.button!==0)return;
  event.preventDefault();event.stopPropagation();
  const pt=brushPointFromEvent(event);
  if(pipetteActive){void sampleBrushColor(pt.x,pt.y);return;}
  event.currentTarget.setPointerCapture(event.pointerId);
  const stroke:CoverStroke={id:uid(),color:brushColor,size:brushSize,points:[pt]};
  brushRef.current={stroke,pageId:page.id};setDraftStroke(stroke);
 }
 function onBrushPointerMove(event:React.PointerEvent<HTMLDivElement>){
  const active=brushRef.current;if(!active||!page||active.pageId!==page.id)return;
  const pt=brushPointFromEvent(event),last=active.stroke.points.at(-1);
  if(last&&Math.hypot(pt.x-last.x,pt.y-last.y)<0.22)return;
  if(active.stroke.points.length>=4999)return;
  active.stroke={...active.stroke,points:[...active.stroke.points,pt]};
  setDraftStroke(active.stroke);
 }
 function commitBrushStroke(event:React.PointerEvent<HTMLDivElement>){
  const active=brushRef.current;if(!active)return;
  brushRef.current=null;setDraftStroke(null);
  if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  if(!page||active.pageId!==page.id||!canEditCurrent)return;
  const stroke=active.stroke;
  updatePage(p=>({...p,coverStrokes:[...(p.coverStrokes??[]),stroke],reviewed:false}),`${page.name} · 덮개 브러시`);
 }
 function cancelBrushStroke(){brushRef.current=null;setDraftStroke(null);}
 function clearCoverStrokes(){if(!page||!canEditCurrent||!page.coverStrokes?.length)return;updatePage(p=>({...p,coverStrokes:undefined,reviewed:false}),`${page.name} · 덮개 브러시 지우기`);notify('이 페이지의 덮개 브러시를 모두 지웠어요.');}
 function renderStrokeElement(stroke:CoverStroke,width:number,height:number){
  if(!stroke.points.length)return null;
  if(stroke.points.length===1){const p0=stroke.points[0]!;return <circle key={stroke.id} cx={p0.x/100*width} cy={p0.y/100*height} r={stroke.size/2} fill={stroke.color}/>;}
  const d=stroke.points.map((pt,i)=>`${i===0?'M':'L'}${(pt.x/100*width).toFixed(1)} ${(pt.y/100*height).toFixed(1)}`).join(' ');
  return <path key={stroke.id} d={d} fill="none" stroke={stroke.color} strokeWidth={stroke.size} strokeLinecap="round" strokeLinejoin="round"/>;
 }
   function renderCanvas(original=false){if(!page)return null;const showFinal=!original&&!editingId&&canUseFinalImage(page);const activeDraft=draftStroke&&brushRef.current?.pageId===page.id?draftStroke:null;const strokes=!original?[...(page.coverStrokes??[]),...(activeDraft?[activeDraft]:[])]:[];return <div className={`manga-frame ${original?"is-original":""}`} style={{width:page.width*safeScale,height:page.height*safeScale}}>
     {!original&&!showFinal&&cropPath ? <>
       <svg width="0" height="0" aria-hidden="true" focusable="false" style={{position:'absolute'}}><defs>
         <clipPath id={letteringClipId} clipPathUnits="objectBoundingBox"><path d={cropPath}/></clipPath>
         <clipPath id={letteringClipId+'-clean'} clipPathUnits="objectBoundingBox"><path clipRule="evenodd" d={`M0 0h1v1H0z ${cropPath}`}/></clipPath>
       </defs></svg>
       <img className="manga-image" src={page.cleanImage} alt="" draggable={false} style={{clipPath:`url(#${letteringClipId}-clean)`}}/>
       <img className="manga-image" src={page.finalImage} alt={page.name+' 식자 미리보기'} draggable={false} style={{position:'absolute',inset:0,clipPath:`url(#${letteringClipId})`}}/>
     </> : <img className="manga-image" src={original?page.image:showFinal?page.finalImage:(page.cleanImage||page.image)} alt={`${page.name} ${original?"원본":"식자 미리보기"}`} draggable={false}/>}
     {strokes.length>0&&<svg className="cover-strokes-svg" viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none" aria-hidden="true">{strokes.map(s=>renderStrokeElement(s,page.width,page.height))}</svg>}
     {(!original||showOCR)&&page.blocks.map((b,index)=>{const active=b.id===selectedId&&(!original||showOCR), rect=original?ocrBox(b):b, vertical=b.writingMode==="vertical-rl";const outline:CSSProperties|undefined=b.strokeWidth && b.strokeColor ? {WebkitTextStroke:(2*b.strokeWidth*safeScale)+"px "+b.strokeColor,paintOrder:"stroke fill"} : undefined;return <div key={b.id} data-block-id={b.id} data-selected={active} role="group" tabIndex={original&&!showOCR?-1:0} aria-label={`텍스트 영역 ${index+1}`} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(original){if(showOCR&&e.key==="Enter"){e.preventDefault();setSelectedId(b.id);}return;}if(e.key==="Enter"&&canEditCurrent){e.preventDefault();setSelectedId(b.id);beginEditing(b);}}} className={`text-block ${active?"selected":""} ${showOCR?"ocr-visible":""} ${editingId===b.id?"editing":""} ${original?"ocr-only":""} ${vertical?"is-vertical":""}`} style={{left:rect.x+"%",top:rect.y+"%",width:rect.w+"%",height:rect.h+"%",background:!original&&!showFinal&&!letterCrops?.has(b.id)&&b.fill?"#fff":undefined,fontSize:b.size*safeScale,fontWeight:b.weight,lineHeight:b.lineHeight,fontFamily:FONTS[b.font],color:b.color,textAlign:b.align} as CSSProperties} onClick={e=>{e.stopPropagation();if(!original||showOCR){setSelectedId(b.id);}}} onDoubleClick={e=>{e.stopPropagation();if(!original&&canEditCurrent){setSelectedId(b.id);beginEditing(b);}}} onPointerDown={e=>{if(!original&&tool==='select')startDrag(e,b);}} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
      {(active||showOCR)&&<span className="block-label">{original?"OCR":"T"} {String(index+1).padStart(2,"0")}{showOCR&&b.confidence!==undefined?` · ${(b.confidence*100).toFixed(1)}%`:""}</span>}
       {!original&&(editingId===b.id?<div key={b.id+"-edit"} ref={editableRef} contentEditable="plaintext-only" onInput={e=>recordDraft(e.currentTarget)} suppressContentEditableWarning className={`block-text editable ${vertical?"is-vertical":""}`} style={{...outline,wordBreak:"keep-all",...(vertical?{writingMode:"vertical-rl",textOrientation:"upright",paddingBlock:Math.max(0,(6+(b.strokeWidth??0))*safeScale-1)}:{paddingInline:Math.max(0,(6+(b.strokeWidth??0))*safeScale-1)})}} role="textbox" aria-label={`번역문 ${index+1} 직접 편집`} onPointerDown={e=>e.stopPropagation()} onBlur={e=>commitText(e.currentTarget,b)} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==="Escape"){e.preventDefault();e.stopPropagation();cancelEditing();}if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();e.currentTarget.blur();}}}>{editingRef.current?.target.block.id===b.id?editingRef.current.target.block.text:b.text}</div>:(showFinal||letterCrops?.has(b.id)?<div className="block-text" style={{opacity:0}}>{b.text||"번역문 추가"}</div>:<ManualLettering block={b} pageWidth={page.width} pageHeight={page.height} onMeasure={recordManualFit} scale={safeScale} outline={outline}/>))}
      {active&&!original&&editingId!==b.id&&tool==='select'&&<><span className="handle tl"/><span className="handle tr"/><span className="handle bl"/><span className="handle br" onPointerDown={e=>{e.stopPropagation();startDrag(e,b,true);}}/></>}

    </div>;})}
    {!original&&tool==='brush'&&canEditCurrent&&<div className={`brush-surface ${pipetteActive?"is-pipette":""}`} role="application" aria-label={pipetteActive?"배경색 스포이드":"덮개 브러시 캔버스"} onPointerDown={onBrushPointerDown} onPointerMove={onBrushPointerMove} onPointerUp={commitBrushStroke} onPointerCancel={cancelBrushStroke} onClick={e=>e.stopPropagation()}/>}
    {view==="compare"&&<span className="compare-caption">{original?"원본":"식자 결과"}</span>}
  </div>;}

  return <main className={`studio-shell ${!loaded?"loading-workspace":""}`} aria-busy={!loaded||busy} data-workspace-state={persistence.hydration.phase} data-operation={activity.kind} data-operation-id={activity.kind==='idle'?'':activity.id} data-operation-project-id={activity.kind==='idle'?'':activity.projectId} data-operation-page-id={activity.kind==='idle'?'':activity.pageId||''} data-stop-requested={activity.kind==='processing'&&!!activity.stopRequested} data-modal={modalName||'closed'} data-deleted-project-count={workspace.deletedProjects.length} data-inspector-view="text" data-canvas-location={canvasLocation} data-save-conflict={persistence.save.phase==='error'&&!!persistence.save.conflict} data-save-state={saveState} data-project-id={activeId} data-page-id={page?.id||""} data-page-state={page?pageActivity(page):"empty"} data-mode={project.mode} data-view={view} data-tool={tool} data-drawer={drawer||"closed"} data-editor-state={editingId?"editing":"idle"} data-undo-count={undoCount} data-redo-count={redoCount} data-panel-layout={compactPanels?"overlay":"docked"}>
    <input ref={fileInput} type="file" accept=".zip,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple hidden onChange={e=>importFiles(e.target.files)}/>
    <input ref={projectInput} type="file" accept=".trio,.json" hidden onChange={e=>importProject(e.target.files?.[0])}/>
    <div className={`workspace ${!leftOpen?"left-collapsed":""} ${!rightOpen?"right-collapsed":""}`}>
      {drawer&&<button className="panel-scrim" data-drawer={drawer} aria-label="열린 패널 닫기" tabIndex={-1} onClick={()=>closeDrawer()}/>}
      <aside id="page-panel" data-project-id={activeId} className={`page-panel ${drawer==="pages"?"mobile-open":""}`} role={drawer==="pages"?"dialog":undefined} aria-modal={drawer==="pages"?true:undefined} aria-label="프로젝트와 페이지" inert={drawer!==null&&drawer!=="pages"}>
        <button id="page-panel-toggle" type="button" className="panel-edge-toggle panel-toggle-left" aria-label={leftVisible?"페이지 패널 접기":"페이지 패널 펼치기"} title={leftVisible?"페이지 패널 접기":"페이지 패널 펼치기"} aria-controls="page-panel-content" aria-expanded={leftVisible} onClick={e=>togglePanel('left',e.currentTarget)}>{leftVisible?<ChevronLeft size={15}/>:<ChevronRight size={15}/>}</button>
        <div id="page-panel-content" className="panel-content" inert={!leftVisible}>
    {persistence.hydration.phase==="recovery"&&<section className="storage-recovery-banner" role="alert"><AlertTriangle size={17}/><div><strong>기존 작업을 보호하기 위해 자동 저장을 멈췄어요.</strong><span>{persistence.hydration.error}</span></div><button onClick={persistence.retryRead}>다시 불러오기</button><button onClick={openProjectBackup}>현재 프로젝트 백업</button></section>}
    {ready&&persistence.save.phase==="error"&&<section className="storage-recovery-banner" role="alert"><AlertTriangle size={17}/><div><strong>아직 저장하지 못한 변경사항이 있어요.</strong><span>{persistence.save.conflict?"다른 탭의 저장 내용은 보호했어요. 현재 창에서 수정한 프로젝트를 각각 백업한 뒤 새로고침해 주세요.":"현재 편집은 보관 중이에요. 다시 저장하거나 프로젝트를 내려받아 주세요."}</span></div>{!persistence.save.conflict&&<button onClick={persistence.retrySave}>다시 저장</button>}<button onClick={openProjectBackup}>프로젝트 백업</button></section>}
        {canvasLocation==='projects'&&hasActiveProject?<ProjectOverview project={project} canNavigate={ready&&!uploading&&!exporting} onOpenPage={id=>selectPage(id)} onOpenPages={()=>showCanvasLocation('pages')}/>:<><section className="sidebar-canvas-controls" aria-label="캔버스 도구">
          <div className="sidebar-view-controls"><div className="view-tabs" role="tablist" aria-label="미리보기 방식"><button role="tab" disabled={!hasActiveProject} aria-selected={view==="preview"} className={view==="preview"?"active":""} onClick={()=>chooseCanvasView("preview")}>미리보기</button><button role="tab" disabled={!hasActiveProject} aria-selected={view==="original"} className={view==="original"?"active":""} onClick={()=>chooseCanvasView("original")}>원본</button><button role="tab" disabled={!hasActiveProject} aria-selected={view==="compare"} className={view==="compare"?"active":""} onClick={()=>chooseCanvasView("compare")}>비교</button></div><IconButton label="OCR 영역 표시 · O" disabled={!hasActiveProject} active={showOCR} onClick={toggleCanvasOCR}><SquareDashed size={15}/></IconButton></div>
          {showDevReview&&<button type="button" className="button secondary full-width" disabled={!canManageProjects} onClick={()=>setModal('translation-review')}>선택 번역 13개 저장</button>}
          <div className="sidebar-tool-row" role="group" aria-label="편집 도구"><IconButton label="선택 · V" disabled={!hasActiveProject} active={tool==='select'} onClick={chooseCanvasSelection}><MousePointer2 size={16}/></IconButton><IconButton label="덮개 브러시 · B" disabled={!canEditCurrent||view==='original'} active={tool==='brush'} onClick={chooseBrushTool}><Paintbrush size={16}/></IconButton><IconButton label="텍스트 추가 · T" disabled={!canEditCurrent} onClick={()=>{setTool('select');setPipetteActive(false);addText();}}><Type size={17}/></IconButton><IconButton label="되돌리기 · Ctrl+Z" onClick={()=>{undo();if(compactPanels)closeDrawer();}} disabled={!undoCount||!canMutate||canvasLocation!=='editor'}><Undo2 size={16}/></IconButton><IconButton label="다시 실행 · Ctrl+Shift+Z" onClick={()=>{redo();if(compactPanels)closeDrawer();}} disabled={!redoCount||!canMutate||canvasLocation!=='editor'}><Redo2 size={16}/></IconButton><IconButton label="단축키 안내" onClick={()=>setModal("shortcuts")}><Keyboard size={16}/></IconButton></div>
        </section>
        <div className="panel-heading"><h2><Layers size={13}/>페이지 <span className="count">{project.pages.length.toString().padStart(2,"0")}</span></h2>
          {page&&project.pages.length>1&&<div role="group" aria-label="선택한 페이지 순서">{([-1,1] as const).map(step=><IconButton key={step} label={step===-1?'선택한 페이지를 앞으로':'선택한 페이지를 뒤로'}
            disabled={!canMutate||!project.pages[pageIndex+step]||!project.pages.every(canEditPage)} onClick={()=>{finishEditing();cancelDrag();updateProject(p=>moveStudioPage(p,page.id,step),page.name+' · 순서 변경');}}>
            {step===-1?<ChevronLeft size={15}/>:<ChevronRight size={15}/>}</IconButton>)}</div>}
        </div>
        <div className="page-list">{project.pages.map((p,index)=>{const st=pageActivity(p),approved=p.reviewed&&p.status==='completed',partial=p.engineOutcome==='PARTIAL',badge=st==='processing'?'처리중':st==='failed'?(partial?'부분':'오류'):st==='paused'?'대기':approved?'완료':p.processed||p.blocks.length?'검토':'';return <button key={p.id} type="button" data-page-id={p.id} data-page-state={st} aria-busy={st==='processing'} aria-label={`${index+1}페이지 · ${p.name}${badge?` · ${badge}`:''}`} aria-current={page?.id===p.id?"page":undefined} disabled={!ready||uploading||exporting} className={`page-card ${page?.id===p.id?"selected":""}`} onClick={()=>selectPage(p.id)}><img className="page-preview-image" src={p.cleanImage||p.image} alt="" loading="lazy" width={p.width} height={p.height}/><span className="page-card-num" aria-hidden="true">{String(index+1).padStart(2,"0")}</span>{badge&&<span className={`page-card-badge state-${st}${partial?' is-partial':''}${approved?' is-approved':''}`} aria-hidden="true">{badge}</span>}</button>;})}
        {!project.pages.length&&<div id="page-list-empty" className="empty-pages" tabIndex={-1}><FileImage size={28}/>{hasActiveProject&&<strong className="empty-project-name" title={project.name}>{project.name}</strong>}<p>첫 페이지를 추가해 주세요.</p><span>JPG, PNG, WebP · ZIP</span></div>}
        </div>
        </>}
        <div className={`page-upload-zone ${pageDragOver?'drag-active':''}`} data-upload-state={uploading?'importing':pageDragOver?'dragging':'idle'} onDragOver={e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=canMutate?'copy':'none';setPageDragOver(canMutate);}} onDragLeave={e=>{if(!(e.relatedTarget instanceof Node)||!e.currentTarget.contains(e.relatedTarget))setPageDragOver(false);}} onDrop={dropFiles}><button id="page-upload-button" className="drop-small" disabled={!canMutate} onClick={()=>fileInput.current?.click()} aria-label="페이지 추가" aria-describedby="page-upload-hint">{uploading?<LoaderCircle size={17} className="spin"/>:<Plus size={18}/>}<span><strong>{uploading?'페이지 추가 중…':'페이지 추가'}</strong><small id="page-upload-hint">이미지·ZIP을 놓거나 클릭하세요</small></span></button></div>
        <div className="sidebar-footer"><span className={`save-state ${saveState}`} role="status" aria-live="polite"><span/>{saveState==="saved"?"모든 변경사항 저장됨":saveState==="saving"?"저장 중…":saveState==="loading"?"프로젝트 불러오는 중…":saveState==="recovery"?"기존 저장 내용 보호 중":"자동 저장 실패"}</span></div>
        </div>
      </aside>

      <section className="canvas-workspace" aria-label="번역 작업 캔버스" inert={drawer!==null}>
        <CanvasProjectPath projectName={project.name} pageCount={project.pages.length} pageIndex={pageIndex} page={page} location={canvasLocation} hasProject={hasActiveProject} onOpenProjects={()=>showCanvasLocation('projects')} onOpenPages={()=>showCanvasLocation('pages')} onOpenEditor={()=>showCanvasLocation('editor')} controls={canvasLocation!=='editor'&&<CanvasBrowserControls location={canvasLocation} sort={projectSort} onSort={setProjectSort} searchOpen={browserSearchOpen||!!(canvasLocation==='projects'?projectSearch:pageSearch)} onSearch={()=>{if(browserSearchOpen||(canvasLocation==='projects'?projectSearch:pageSearch)){setBrowserSearchOpen(false);canvasLocation==='projects'?setProjectSearch(''):setPageSearch('');}else setBrowserSearchOpen(true);}}/>}/>
        {(persistence.hydration.phase==="recovery"||persistence.save.phase==="error")&&<div className="canvas-storage-alert" role="alert"><AlertTriangle size={15}/><span>{persistence.hydration.phase==="recovery"?"저장 내용을 불러오지 못했어요.":"아직 저장하지 못한 변경사항이 있어요."}</span><button onClick={e=>showStorageRecovery(e.currentTarget)}>저장 복구 열기</button></div>}
        {canvasLocation!=='editor'?<CanvasBrowser key={canvasLocation} location={canvasLocation} projects={projects} project={project} query={canvasLocation==='projects'?projectSearch:pageSearch} onQuery={canvasLocation==='projects'?setProjectSearch:setPageSearch} sort={projectSort} searchOpen={browserSearchOpen||!!(canvasLocation==='projects'?projectSearch:pageSearch)} ready={ready} canNavigate={ready&&!uploading&&!exporting} canCreate={canManageProjects} newName={newProjectName} onNewName={setNewProjectName} onCreate={createProject} onImport={()=>projectInput.current?.click()} onAddImages={()=>fileInput.current?.click()} onOpenProject={id=>selectProject(id,false,'pages')} onSelectProject={selectProjectCard} onOpenPage={openProjectPage} canDelete={canDeleteProjects} canRestoreDeleted={canManageProjects} onDelete={requestProjectDeletion} deletedProjectName={lastDeletedProject?.project.name} onUndoDelete={undoProjectDeletion}/>:<>
        <div id="canvas-editor" className="canvas-body">{page&&canMutate&&(page.jobId||page.pendingBatch||pageActivity(page)==="paused"||pageActivity(page)==="failed")&&<div className="paused-notice" role="status"><Info size={14}/><div><strong>{retiredJob?"이전 연결의 작업이 보관되어 있어요":page.engineOutcome==="PARTIAL"&&page.jobId?"원문 제거·번역이 끝난 초안을 수동 식자로 이어받을 수 있어요":page.jobId?"저장한 작업을 다시 조회할 수 있어요":page.pendingBatch?"이전 접수 정보를 확인할 수 있어요":"이전 내용은 그대로 보관했어요"}</strong><span>{retiredJob?RETIRED_JOB_NOTICE:page.error||"조회 중지는 엔진 작업을 취소하지 않아요."}</span></div>{!retiredJob&&page.engineOutcome==="PARTIAL"&&page.jobId&&<button onClick={()=>void loadPartialDraft()}>원문 제거·번역 초안 불러오기</button>}{!retiredJob&&<button onClick={()=>run("current")}>{page.jobId?(page.status==="failed"?"실패 페이지 재시도":"조회 재개"):page.pendingBatch?"접수 확인":"다시 처리"}</button>}<button onClick={continueEditing}>이전 결과로 편집</button></div>}
          <div ref={stageRef} tabIndex={-1} className={`canvas-stage ${dragOver?"drag-over":""}`} onScroll={()=>captureViewportReading(false)} onWheel={readingInteraction} onPointerDown={readingInteraction} onKeyDown={readingInteraction} onClick={()=>{if(!editingId)setSelectedId(null);}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect=canMutate?'copy':'none';setDragOver(canMutate);}} onDragLeave={e=>{if(!(e.relatedTarget instanceof Node)||!e.currentTarget.contains(e.relatedTarget))setDragOver(false);}} onDrop={dropFiles}>
            {page?<><div className={`canvas-pages ${view==="compare"?"comparing":""}`} style={{minWidth:page.width*safeScale*(view==="compare"?2:1)+(view==="compare"?70:80),minHeight:page.height*safeScale+64,"--canvas-art-width":`${page.width*safeScale*(view==="compare"?2:1)+(view==="compare"?20:0)}px`} as CSSProperties}><button type="button" className="canvas-margin-nav canvas-margin-previous" data-canvas-margin="previous" aria-label="이전 이미지" disabled={!ready||uploading||exporting||!project.pages[pageIndex-1]} onClick={e=>{e.stopPropagation();navigatePage(-1);}}></button>{view==="compare"&&renderCanvas(true)}{renderCanvas(view==="original")}<button type="button" className="canvas-margin-nav canvas-margin-next" data-canvas-margin="next" aria-label="다음 이미지" disabled={!ready||uploading||exporting||!project.pages[pageIndex+1]} onClick={e=>{e.stopPropagation();navigatePage(1);}}></button></div>{running&&activity.projectId===project.id&&<div className="processing-banner batch-progress-banner" role="status" aria-live="polite"><div className="batch-progress-row"><LoaderCircle size={15} className="spin"/><span>{batchProgress&&batchProgress.total>1?`처리 중 · ${batchProgress.done}/${batchProgress.total}페이지${batchProgress.failed?` (오류 ${batchProgress.failed})`:''} · ${batchProgress.pageName?`${batchProgress.pageName} · `:''}${processingStage||"엔진 연결 중"}`:`${processingStage||"엔진 연결 중"} · ${batchProgress?.pageName||page.name}`}</span></div>{batchProgress&&batchProgress.total>1&&<div className="batch-progress-track" aria-hidden="true"><span style={{width:`${Math.min(100,Math.round(((batchProgress.done+batchProgress.failed)/batchProgress.total)*100))}%`}}/></div>}</div>}</>:<div className="empty-canvas"><span className="empty-art"><ImagePlus size={42} strokeWidth={1.1}/><i><FileArchive size={20}/></i></span><span className="eyebrow">YOUR NEXT STORY</span><h1>어떤 이야기를 옮겨볼까요?</h1><p>이미지 한 장부터 ZIP 한 권까지.<br/>파일을 여기에 놓고 작업을 시작하세요.</p><button className="button primary" onClick={()=>fileInput.current?.click()} disabled={!canMutate}><Plus size={16}/>{uploading?"파일을 준비하는 중…":"파일 선택"}</button><small>이미지 8MiB/장 · 한 번에 100페이지</small></div>}
            {dragOver&&<div className="drop-overlay"><Upload size={38}/><h2>여기에 파일을 놓아 주세요</h2><p>이미지 또는 이미지가 담긴 ZIP</p></div>}
          </div>
          {page&&<>{editingId&&<div className="canvas-bottom-hint">입력 중에도 자동 저장돼요 · 편집 완료 <kbd>Ctrl ↵</kbd></div>}{tool==='brush'&&view!=='original'&&canEditCurrent&&<div className="brush-toolbar" role="toolbar" aria-label="덮개 브러시 도구"><label className="brush-color-pick" title="브러시 색"><input type="color" aria-label="브러시 색" value={brushColor} onChange={e=>{setBrushColor(e.target.value);setPipetteActive(false);}}/><span style={{background:brushColor}}/></label><button type="button" className={`brush-swatch ${brushColor.toLowerCase()==='#ffffff'?'active':''}`} title="흰색" aria-label="흰색" style={{background:'#ffffff'}} onClick={()=>{setBrushColor('#ffffff');setPipetteActive(false);}}/><button type="button" className={`brush-swatch ${brushColor.toLowerCase()==='#000000'?'active':''}`} title="검정" aria-label="검정" style={{background:'#000000'}} onClick={()=>{setBrushColor('#000000');setPipetteActive(false);}}/><button type="button" className={`brush-btn ${pipetteActive?'active':''}`} aria-pressed={pipetteActive} onClick={()=>setPipetteActive(v=>!v)} title="이미지에서 배경색 추출"><Pipette size={13}/><span>스포이드</span></button><label className="brush-size-control"><span>크기</span><input type="range" aria-label="브러시 크기" min={4} max={80} step={2} value={brushSize} onChange={e=>setBrushSize(Number(e.target.value))}/><em>{brushSize}px</em></label><button type="button" className="brush-btn" disabled={!page.coverStrokes?.length} onClick={clearCoverStrokes} title="이 페이지 브러시 모두 지우기"><Trash2 size={13}/><span>지우기</span></button><button type="button" className="brush-btn primary" onClick={chooseCanvasSelection}>완료</button></div>}<div className="zoom-control"><IconButton label="축소" onClick={()=>setZoom(z=>clamp(z-.15,.4,3))}><Minus size={15}/></IconButton><button className="zoom-number" title="화면에 맞춤" onClick={fitReadingViewport}>{Math.round(safeScale*100)}<span>%</span></button><IconButton label="확대" onClick={()=>setZoom(z=>clamp(z+.15,.4,3))}><Plus size={15}/></IconButton><span/><IconButton label="화면에 맞춤" onClick={fitReadingViewport}><Maximize size={14}/></IconButton></div></>}
        </div>
        <div className="canvas-page-navigation"><div className="page-navigation"><IconButton label="이전 페이지" disabled={!project.pages[pageIndex-1]||uploading||exporting} onClick={()=>navigatePage(-1)}><ChevronLeft size={14}/></IconButton><span>{page?String(pageIndex+1).padStart(2,"0"):"00"}<em> / {String(project.pages.length).padStart(2,"0")}</em></span><IconButton label="다음 페이지" disabled={!project.pages[pageIndex+1]||uploading||exporting} onClick={()=>navigatePage(1)}><ChevronRight size={14}/></IconButton></div></div>
        </>}
      </section>

      <aside id="inspector-panel" className={`inspector-panel ${drawer==="inspector"?"mobile-open":""}`} role={drawer==="inspector"?"dialog":undefined} aria-modal={drawer==="inspector"?true:undefined} aria-label="처리와 편집 도구" inert={drawer!==null&&drawer!=="inspector"}>
        <button id="inspector-panel-toggle" type="button" className="panel-edge-toggle panel-toggle-right" aria-label={rightVisible?"편집 패널 접기":"편집 패널 펼치기"} title={rightVisible?"편집 패널 접기":"편집 패널 펼치기"} aria-controls="inspector-panel-content" aria-expanded={rightVisible} onClick={e=>togglePanel('right',e.currentTarget)}>{rightVisible?<ChevronRight size={15}/>:<ChevronLeft size={15}/>}</button>
        <div id="inspector-panel-content" className="panel-content" inert={!rightVisible}>
        <section className="processing-controls" aria-label="처리와 다운로드"><div className="processing-actions">{(!project.sample||running)&&<div className="run-group" ref={runMenuRef}><button className="button primary" disabled={running?(activity.kind==='processing'&&!!activity.stopRequested):(!page||!canMutate)} onClick={()=>{setScopeMenu(false);running?stopRun():run(runScope);}}>{running?<LoaderCircle size={15} className="spin"/>:<Sparkles size={15}/>}<span>{running?(activity.kind==="processing"&&activity.stopRequested?"중지 중…":"조회 중지"):runScope==="all"?"전체 처리":"현재 페이지 처리"}</span></button><button className="run-current" aria-label="처리 범위 선택" aria-expanded={scopeMenu} title="처리 범위 선택" disabled={!page||!canMutate} onClick={()=>setScopeMenu(v=>!v)}><ChevronDown size={15}/></button>{scopeMenu&&<div className="run-menu"><button onClick={()=>{setRunScope("all");setScopeMenu(false);}}><Layers size={14}/>전체 페이지{runScope==="all"&&<Check size={13}/>}</button><button onClick={()=>{setRunScope("current");setScopeMenu(false);}}><FileImage size={14}/>현재 페이지{runScope==="current"&&<Check size={13}/>}</button></div>}</div>}<button className="button secondary" disabled={!canExport} onClick={()=>{if(!page)setExportFormat('project');setModal("download");}} title="다운로드"><Download size={14}/><span>다운로드</span></button></div></section>
        <div className="inspector-scroll">
            {showOCR&&selected&&page&&<form key={JSON.stringify([page.id,selected.id,ocrBox(selected)])} className="inspector-section ocr-box-editor" aria-label="OCR 영역 수정" onSubmit={e=>{
              e.preventDefault();
              const fields=new FormData(e.currentTarget);
              const box={x:Number(fields.get('x')),y:Number(fields.get('y')),w:Number(fields.get('w')),h:Number(fields.get('h'))};
              if(box.x+box.w>100.0001||box.y+box.h>100.0001){notify('OCR 영역이 페이지를 벗어나요.',true);return;}
              patchBlock({userSourceBox:box},page.name+' · OCR 영역 수정');
            }}>
              <fieldset disabled={!canEditCurrent}><legend>원본의 OCR 영역 (%)</legend><div className="field-grid">
                {([['x','왼쪽'],['y','위쪽'],['w','너비'],['h','높이']] as const).map(([key,label])=><label key={key}>{label}<input name={key} type="number" required min={key==='w'||key==='h'?0.000001:0} max={100} step="any" defaultValue={ocrBox(selected)[key]} /></label>)}
              </div><button type="submit" className="button secondary">OCR 영역 저장</button>
              {selected.userSourceBox&&<button type="button" onClick={()=>patchBlock({userSourceBox:undefined},page.name+' · OCR 영역 복원')}>기존 좌표로 복원</button>}
              </fieldset>
            </form>}
            {page&&(issues.length>0||page.status==='review'||effects)&&<details className="inspector-section" data-review-status={page.reviewed?'reviewed':issues.length||page.status==='review'?'needs_review':'recorded'}>
              <summary>{page.reviewed?'사용자 검수 완료':issues.length?`검토 필요 · 경고 ${issues.length}개`:page.status==='review'?'검토 필요':'효과음 처리 기록'}</summary>
              {effects&&<p>효과음 처리 대상 · 원문 보존 {effects.preserved}개 · 번역 식자 {effects.translated}개</p>}
              {issues.length>0&&<ul>{issues.map((issue,i)=><li key={i}>{issue.blockId?<button type="button" onClick={()=>{setSelectedId(issue.blockId!);setCanvasLocation('editor');closeDrawer();}}>{issue.title}</button>:issue.title}</li>)}</ul>}
              {pageReviewState(page)==='CANDIDATE_READY'&&<button type="button" disabled={!canEditCurrent||issues.some(issue=>issue.kind!=='engine')} onClick={()=>updatePage(approvePageCandidate,page.name+' · 사용자가 원문·번역·식자 검수 완료')}>원문·번역·식자 확인 후 검수 완료</button>}
            </details>}
            {page&&textInventoryJobId&&<StudioTextInventory key={textInventoryJobId} jobId={textInventoryJobId} image={page.image}/>}
            {page&&selected&&<section className="inspector-section dialogue-section" aria-label="선택한 대사 내용">
              <div className="section-title"><h3><span>대사 내용</span><span className="tiny-caps" aria-hidden="true">DIALOGUE</span></h3><span className="dialogue-index">#{String(page.blocks.findIndex(b=>b.id===selected.id)+1).padStart(2,"0")}</span></div>
              <div className="dialogue-field">
                <div className="dialogue-field-header"><span className="field-label">원문 (OCR)</span>{selected.source&&<IconButton label="원문 복사" onClick={()=>void navigator.clipboard?.writeText(selected.source).then(()=>notify('원문을 복사했어요.')).catch(()=>notify('원문을 복사하지 못했어요.',true))}><Copy size={12}/></IconButton>}</div>
                <p className={`dialogue-source-box ${selected.source?'':'is-empty'}`}>{selected.source||'직접 추가한 텍스트 영역이에요.'}</p>
              </div>
              <div className="dialogue-field">
                <label className="field-label" htmlFor="inspector-translation">번역문</label>
                <textarea id="inspector-translation" className="dialogue-textarea" rows={3} disabled={!canEditCurrent} placeholder="번역문을 입력하세요" value={selected.text}
                  onFocus={()=>{if(!page||!selected||!canEditCurrent)return;const target=createTextEditTarget(project,page.id,selected.id);if(target)inspectorTextRef.current={projectId:project.id,target,changed:false};}}
                  onChange={e=>{if(!page||!selected||!canEditCurrent)return;const value=e.target.value;if(inspectorTextRef.current?.target.block.id===selected.id){inspectorTextRef.current.changed=value!==inspectorTextRef.current.target.block.text;commitProject(project.id,p=>({...p,pages:p.pages.map(pg=>pg.id===page.id&&canEditPage(pg)?{...pg,status:'review',reviewed:false,error:undefined,blocks:pg.blocks.map(b=>b.id===selected.id?{...b,text:value}:b)}:pg)}),undefined,'preserve');}else{patchBlock({text:value},`${page.name} · 번역문 수정`);}}}
                  onBlur={commitInspectorText}/>
              </div>
            </section>}
            <section className="inspector-section typography-section" data-expanded={typographyOpen}><div className="section-title typography-title"><h3><button type="button" className="typography-disclosure" aria-label={typographyOpen?"글꼴 스타일 접기":"글꼴 스타일 펼치기"} aria-expanded={typographyOpen} aria-controls="typography-controls" onClick={()=>setTypographyOpen(open=>!open)}><ChevronDown size={14} aria-hidden="true"/><span>글꼴 스타일</span><span className="tiny-caps" aria-hidden="true">TYPOGRAPHY</span></button></h3>{selected&&<IconButton label="선택한 텍스트 삭제" disabled={!canEditCurrent} onClick={()=>{updatePage(p=>({...p,blocks:p.blocks.filter(b=>b.id!==selected.id),reviewed:false}),`${page.name} · 텍스트 삭제`);setSelectedId(null);}}><Trash2 size={14}/></IconButton>}</div><fieldset id="typography-controls" className="style-fieldset" hidden={!typographyOpen} disabled={!selected||!canEditCurrent}><label className="field-label" htmlFor="font-select">글꼴</label><select id="font-select" className="form-select font-select" value={selected?.font||"sans"} onChange={e=>patchBlock({font:e.target.value})}>{Object.entries(FONT_NAMES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select><div className="field-grid"><div><label className="field-label" htmlFor="font-size">크기</label><div className="number-field"><Type size={13}/><input id="font-size" aria-label="글자 크기" type="number" min={10} max={160} value={selected?.size||32} onChange={e=>patchBlock({size:clamp(Number(e.target.value)||10,10,160)})}/><span>px</span></div></div><div><label className="field-label" htmlFor="font-weight">굵기</label><select id="font-weight" className="form-select" value={selected?.weight||600} onChange={e=>patchBlock({weight:Number(e.target.value)})}><option value={400}>Regular</option><option value={500}>Medium</option><option value={600}>Semi Bold</option><option value={700}>Bold</option><option value={800}>Extra Bold</option></select></div></div>
              <div className="writing-mode-row"><span className="field-label">글쓰기 방향</span><div className="writing-mode-toggle" role="group" aria-label="글쓰기 방향"><button type="button" aria-pressed={selected?.writingMode!=="vertical-rl"} className={selected?.writingMode!=="vertical-rl"?"active":""} onClick={()=>patchBlock({writingMode:undefined},`${page?.name||'페이지'} · 가로쓰기 전환`)}>가로쓰기</button><button type="button" aria-pressed={selected?.writingMode==="vertical-rl"} className={selected?.writingMode==="vertical-rl"?"active":""} onClick={()=>patchBlock({writingMode:"vertical-rl"},`${page?.name||'페이지'} · 세로쓰기 전환`)}>세로쓰기</button></div></div>
              <div className="field-grid alignment-color"><div><label className="field-label">정렬</label><div className="alignment-control">{(["left","center","right"] as const).map((a,i)=>{const Icon=[AlignLeft,AlignCenter,AlignRight][i];return <button key={a} title={["왼쪽 정렬","가운데 정렬","오른쪽 정렬"][i]} aria-label={["왼쪽 정렬","가운데 정렬","오른쪽 정렬"][i]} aria-pressed={selected?.align===a} className={selected?.align===a?"active":""} onClick={()=>patchBlock({align:a})}><Icon size={15}/></button>;})}</div></div><div><label className="field-label" htmlFor="text-color">색상</label><div className="color-field"><input id="text-color" type="color" value={selected?.color||"#202020"} onChange={e=>patchBlock({color:e.target.value})}/><span>{(selected?.color||"#202020").slice(1).toUpperCase()}</span><ChevronDown size={11}/></div></div></div>
              <div className="field-grid stroke-controls"><div><label className="field-label" htmlFor="stroke-width">외곽선 두께</label><div className="number-field"><input id="stroke-width" aria-label="외곽선 두께" type="number" min={0} max={8} step={.5} value={selected?.strokeWidth??0} onChange={e=>patchStroke(Number(e.target.value))}/><span>px</span></div></div><div><label className="field-label" htmlFor="stroke-color">외곽선 색</label><div className={`color-field ${!(selected?.strokeWidth&&selected.strokeWidth>0)?'is-disabled':''}`}><input id="stroke-color" type="color" disabled={!(selected?.strokeWidth&&selected.strokeWidth>0)} value={selected?.strokeColor||(selected?.color?.toLowerCase()==='#ffffff'?'#000000':'#ffffff')} onChange={e=>patchStroke(selected?.strokeWidth||1.5,e.target.value)}/><span>{(selected?.strokeColor||(selected?.color?.toLowerCase()==='#ffffff'?'#000000':'#ffffff')).slice(1).toUpperCase()}</span><ChevronDown size={11}/></div></div></div>
              <div className="line-height-label"><label className="field-label" htmlFor="line-height">줄 간격</label><span>{(selected?.lineHeight||1.4).toFixed(2)}</span></div><input id="line-height" className="range-input" type="range" min={1} max={2.5} step={.05} value={selected?.lineHeight||1.4} onChange={e=>patchBlock({lineHeight:Number(e.target.value)})}/><div className="range-labels"><span>촘촘하게</span><span>여유롭게</span></div>
              <button className="fit-button" disabled={!selected||!canEditCurrent} onClick={()=>void fitSelected()}><WandSparkles size={14}/>말풍선에 글자 맞춤<ArrowUpRight size={13}/></button><label className="checkbox-row"><input type="checkbox" checked={selected?.fill||false} onChange={e=>patchBlock({fill:e.target.checked})}/>텍스트 영역을 흰색으로 채우기</label>
            </fieldset></section><fieldset disabled={!selected||!canEditCurrent} className="style-fieldset"><section className="inspector-section apply-section" aria-label="스타일 적용 범위"><button type="button" className="apply-style" onClick={()=>applyStyle('page')}><Copy size={13}/><span>이 페이지에 스타일 적용</span></button><button type="button" className="apply-style" onClick={()=>applyStyle('all')}><Layers size={13}/><span>모든 페이지에 스타일 적용</span></button>{selected&&!project.sample&&<button type="button" className="apply-style" disabled={!canStoreContext} onClick={openContextDialog}><Type size={13}/><span>인명·용어 표기 저장</span></button>}</section></fieldset>
        </div>
        <div className="manual-canvas-note"><MousePointer2 size={13}/><span>캔버스에서 직접 확인하고 수정하세요.</span></div>
        </div>
      </aside>
    </div>

    {toast&&<div className={`toast ${toast.error?"error":""}`} role="status">{toast.error?<AlertTriangle size={17}/>:<CircleCheck size={17}/>}<span>{toast.text}</span><button onClick={()=>setToast(null)} aria-label="알림 닫기"><X size={15}/></button></div>}
    {contextScope&&contextSelectionMatches&&<StudioContextDialog scope={contextScope} DialogShell={Dialog} onClose={()=>setModal(null)}/>}
    {modal==='translation-review'&&<StudioTranslationReviewDialog DialogShell={Dialog} onClose={()=>setModal(null)}/>}





    {deleteTarget&&<Dialog title="프로젝트를 삭제할까요?" descriptionId="delete-project-description" onClose={()=>setModal(null)}><div className="delete-project-summary"><Trash2 size={23}/><div><strong>{deleteTarget.name}</strong><span>{deleteTarget.pages.length}페이지 · 이미지와 편집 내용</span></div></div><p id="delete-project-description" className="dialog-description">이 프로젝트를 목록에서 삭제해요. 현재 창에서 실행 취소할 수 있으며, 새로고침하면 취소할 수 없어요.</p><div className="delete-project-actions"><button type="button" autoFocus className="button secondary" onClick={()=>setModal(null)}>취소</button><button type="button" className="button danger" disabled={!canDeleteProjects} onClick={confirmProjectDeletion}><Trash2 size={14}/>프로젝트 삭제</button></div></Dialog>}

    {modal==="download"&&<Dialog title="이야기를 가져가세요" eyebrow="READY WHEN YOU ARE" busy={exporting} onClose={()=>!exporting&&setModal(null)}><p className="dialog-description">식자한 이미지부터 이어서 작업할 프로젝트까지.</p><div className="export-options">{[{id:"png",icon:FileImage,title:"현재 페이지 · PNG",description:page?`${page.name} · 원본 해상도 ${page.width} × ${page.height}`:"선택한 페이지"},{id:"zip",icon:FileArchive,title:"모든 페이지 · ZIP",description:`처리 오류·진행 중 페이지를 제외한 ${project.pages.filter(canExportPage).length}페이지`},{id:"project",icon:FolderOpen,title:"프로젝트 · TRIO",description:"이미지·번역문·스타일·처리 기록을 함께 보관"}].map(o=><label key={o.id} className={`export-option ${exportFormat===o.id?"active":""}`}><input type="radio" disabled={exporting||!exportAvailability(o.id as ExportFormat,project,page).allowed} name="export-format" value={o.id} checked={exportFormat===o.id} onChange={()=>setExportFormat(o.id as ExportFormat)}/><o.icon size={23}/><span><strong>{o.title}</strong><small>{o.description}</small></span><span className="radio-dot"/></label>)}</div>{exportFormat!=="project"&&<div className="export-notice"><Info size={15}/><p>캔버스에 보이는 번역문과 스타일로 이미지를 만들어요.{project.sample&&" 편집 체험용 샘플이에요."}{!project.sample&&" 원문 제거는 연결한 엔진의 복원 결과를 사용해요."}</p></div>}{!exportState.allowed&&<p className="connection-error" role="status">{exportState.reason} 프로젝트 TRIO로 현재 작업을 백업할 수 있어요.</p>}<button className="button primary full-width" disabled={!canExport||!exportState.allowed} onClick={exportResult}>{exporting?<LoaderCircle size={16} className="spin"/>:<ArrowDownToLine size={16}/>} {exporting?"파일을 만드는 중…":"다운로드"}</button></Dialog>}

    {modal==="shortcuts"&&<Dialog title="손에 익으면, 더 가볍게" eyebrow="KEYBOARD SHORTCUTS" onClose={()=>setModal(null)}><div className="shortcut-list">{[["선택 도구","V"],["덮개 브러시","B"],["텍스트 추가","T"],["OCR 영역 보기","O"],["이전 · 다음 페이지","←  →"],["되돌리기","Ctrl / ⌘ + Z"],["다시 실행","Ctrl / ⌘ + Shift + Z"],["다운로드 열기","Ctrl / ⌘ + S"],["텍스트 편집 완료","Ctrl / ⌘ + Enter"],["선택 해제 · 편집 취소","Esc"]].map(([label,key])=><div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div><div className="dialog-footnote"><MousePointer2 size={14}/>번역문을 더블클릭하면 이미지 위에서 바로 수정할 수 있어요.</div></Dialog>}
  </main>;
}
