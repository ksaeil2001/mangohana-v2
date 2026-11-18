import {useState} from 'react';
import {ArrowDownUp,CircleCheck,FileImage,FolderOpen,Grid2X2,ImagePlus,Plus,Search,Trash2,Undo2,Upload,X} from 'lucide-react';
import {browsePages,browseProjects,type CanvasLocation,type ProjectSort} from '@/lib/studio-browser';
import type {Project} from '@/lib/studio-model';

export function CanvasBrowserControls({location,sort,onSort,searchOpen,onSearch}:{location:CanvasLocation;sort:ProjectSort;onSort:(sort:ProjectSort)=>void;searchOpen:boolean;onSearch:()=>void}){
 return <div className="browser-path-controls">
  {location==='projects'&&<label className="browser-sort"><ArrowDownUp size={13}/><select aria-label="프로젝트 정렬" value={sort} onChange={event=>onSort(event.target.value as ProjectSort)}><option value="recent">최근 수정순</option><option value="name">이름순</option><option value="pages">페이지 많은순</option></select></label>}
  <button type="button" aria-label={searchOpen?'검색 닫기':'검색 열기'} aria-expanded={searchOpen} aria-controls="canvas-browser-search" onClick={onSearch}><Search size={15}/></button>
 </div>;
}

type CanvasBrowserProps={
 location:'projects'|'pages';projects:Project[];project:Project;query:string;onQuery:(query:string)=>void;sort:ProjectSort;searchOpen:boolean;
 ready:boolean;canNavigate:boolean;canCreate:boolean;newName:string;onNewName:(name:string)=>void;onCreate:()=>void;onImport:()=>void;onAddImages:()=>void;
 onOpenProject:(id:string)=>void;onSelectProject:(id:string,trigger:HTMLButtonElement)=>void;onOpenPage:(projectId:string,pageId:string)=>void;
 canDelete:boolean;canRestoreDeleted:boolean;onDelete:(id:string)=>void;deletedProjectName?:string;onUndoDelete:()=>void;
};
const dateLabel=(value:string)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'short',day:'numeric'}).format(new Date(value));

export default function CanvasBrowser({location,projects,project,query,onQuery,sort,searchOpen,ready,canNavigate,canCreate,newName,onNewName,onCreate,onImport,onAddImages,onOpenProject,onSelectProject,onOpenPage,canDelete,canRestoreDeleted,onDelete,deletedProjectName,onUndoDelete}:CanvasBrowserProps){
 const [creating,setCreating]=useState(false);
 const visibleProjects=browseProjects(projects,query,sort),visiblePages=browsePages(project.pages,query);
 return <section id="canvas-browser" className="canvas-browser" aria-labelledby="canvas-browser-heading" data-browser-view={location}>
  <div className="browser-content-toolbar">
   <h1 id="canvas-browser-heading" tabIndex={-1}>{location==='projects'?'모든 프로젝트':project.name}<span>{location==='projects'?`${projects.length}개`:`${project.pages.length}페이지`}</span></h1>
   <div className="browser-content-actions">{location==='projects'?<><button type="button" disabled={!canCreate} onClick={()=>setCreating(value=>!value)} aria-expanded={creating}><Plus size={14}/>새 프로젝트</button><button type="button" disabled={!canCreate} onClick={onImport}><Upload size={14}/>가져오기</button></>:<button type="button" disabled={!canCreate} onClick={onAddImages}><ImagePlus size={14}/>이미지·ZIP 추가</button>}</div>
  </div>
  {location==='projects'&&deletedProjectName&&<div className="browser-delete-undo" role="status" aria-atomic="true"><CircleCheck size={15} aria-hidden="true"/><span title={`‘${deletedProjectName}’ 프로젝트를 삭제했어요.`}>‘{deletedProjectName}’ 삭제됨</span><button type="button" disabled={!canRestoreDeleted} onClick={onUndoDelete} aria-describedby="browser-delete-note" title="새로고침 전까지 실행 취소할 수 있어요"><Undo2 size={13}/>실행 취소</button><small id="browser-delete-note" className="browser-delete-note">새로고침 전까지 취소할 수 있어요.</small></div>}
  {searchOpen&&<div id="canvas-browser-search" className="browser-search"><Search size={15}/><input autoFocus aria-label={location==='projects'?'프로젝트 검색':'페이지 검색'} placeholder={location==='projects'?'프로젝트 이름 검색':'파일 이름 또는 페이지 번호 검색'} value={query} onChange={event=>onQuery(event.target.value)}/>{query&&<button type="button" aria-label="검색어 지우기" onClick={()=>onQuery('')}><X size={14}/></button>}</div>}
  {location==='projects'&&creating&&<form className="browser-create-form" onSubmit={event=>{event.preventDefault();if(!newName.trim()||!canCreate)return;onCreate();setCreating(false);}}><input autoFocus aria-label="새 프로젝트 이름" placeholder="새 프로젝트 이름" maxLength={80} value={newName} disabled={!canCreate} onChange={event=>onNewName(event.target.value)}/><button type="submit" disabled={!newName.trim()||!canCreate}>만들기</button><button type="button" aria-label="프로젝트 생성 취소" onClick={()=>setCreating(false)}><X size={15}/></button></form>}
  {!ready?<p className="browser-empty" role="status">프로젝트 불러오는 중…</p>:location==='projects'?<div className="browser-project-list">{visibleProjects.map(item=><article className={`browser-project-row ${project.id===item.id?'selected':''}`} key={item.id} data-project-id={item.id}>
   <button type="button" className="browser-project-select" disabled={!canNavigate} aria-label={`${item.name} 프로젝트 선택`} aria-pressed={project.id===item.id} aria-controls="project-overview" onClick={event=>onSelectProject(item.id,event.currentTarget)}>
    <span className="browser-project-card-heading"><strong>{item.name}</strong><span className="browser-page-count"><FileImage size={13}/>{item.pages.length}개 파일</span><time dateTime={item.updatedAt}>{dateLabel(item.updatedAt)} 수정</time></span>
    <span className="browser-project-previews">{item.pages.slice(0,4).map((page,index)=><span key={page.id} className="browser-preview"><img src={page.cleanImage||page.image} alt="" loading="lazy" width={page.width} height={page.height}/><span>{String(index+1).padStart(2,'0')}</span></span>)}{!item.pages.length&&<span className="browser-empty-project"><FolderOpen size={25}/><span>이미지를 추가해 시작하세요</span></span>}{item.pages.length>4&&<span className="browser-more-pages">+{item.pages.length-4}<span>더 많은 이미지</span></span>}</span>
   </button>
   <div className="browser-project-card-actions"><button type="button" disabled={!canNavigate} aria-label={`${item.name} 모든 페이지 보기`} onClick={()=>onOpenProject(item.id)}><Grid2X2 size={13}/>모든 페이지 보기</button><button type="button" className="browser-delete-project" aria-label={`${item.name} 삭제`} title="프로젝트 삭제" disabled={!canDelete} onClick={()=>onDelete(item.id)}><Trash2 size={13}/><span>삭제</span></button></div>
  </article>)}{!visibleProjects.length&&<p className="browser-empty" role="status">{query?'검색한 프로젝트가 없어요.':'새 프로젝트를 만들어 시작하세요.'}</p>}</div>:<div className="browser-page-grid">{visiblePages.map(({page,index})=><button key={page.id} type="button" className="browser-page-card" data-page-id={page.id} disabled={!canNavigate} onClick={()=>onOpenPage(project.id,page.id)} aria-label={`${index+1}페이지 열기 · ${page.name}`}><div><img src={page.cleanImage||page.image} alt="" loading="lazy" width={page.width} height={page.height}/></div><span><b>{String(index+1).padStart(2,'0')}</b><span title={page.name}>{page.name}</span></span></button>)}{!visiblePages.length&&<div className="browser-empty" role="status"><FileImage size={30}/><p>{query?'검색한 페이지가 없어요.':'아직 페이지가 없어요.'}</p>{!query&&<button type="button" disabled={!canCreate} onClick={onAddImages}><Plus size={14}/>이미지·ZIP 추가</button>}</div>}</div>}
 </section>;
}
