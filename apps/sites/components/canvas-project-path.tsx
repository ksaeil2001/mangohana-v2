import {ChevronRight,Crop,FileImage,FolderClosed,LayoutGrid} from 'lucide-react';
import type {StudioPage} from '@/lib/studio-model';
import type {ReactNode} from 'react';
import type {CanvasLocation} from '@/lib/studio-browser';

type CanvasProjectPathProps={
 projectName:string;pageCount:number;pageIndex:number;page?:Pick<StudioPage,'name'|'width'|'height'>;
 location:CanvasLocation;hasProject:boolean;onOpenProjects:()=>void;onOpenPages:()=>void;onOpenEditor:()=>void;controls?:ReactNode;
};

export default function CanvasProjectPath({projectName,pageCount,pageIndex,page,location,hasProject,onOpenProjects,onOpenPages,onOpenEditor,controls}:CanvasProjectPathProps){
 return <header className="canvas-project-path" data-location={location}>
  <nav aria-label="프로젝트 경로">
   <ol>
    <li><button type="button" className={location==='projects'?'path-crumb active':'path-crumb'} aria-label="프로젝트" aria-current={location==='projects'?'page':undefined} aria-controls="canvas-browser" onClick={onOpenProjects}><FolderClosed size={14}/><span>프로젝트</span></button></li>
    {hasProject&&<><li className="path-project"><ChevronRight className="path-separator" size={13}/><button type="button" className={location==='pages'?'path-crumb active':'path-crumb'} title={projectName} aria-label={`${projectName} 모든 페이지 보기`} aria-current={location==='pages'?'page':undefined} aria-controls="canvas-browser" onClick={onOpenPages}><LayoutGrid size={13}/><span className="path-project-name">{projectName}</span><span className="path-page-count">({pageCount})</span></button></li>
    <li className="path-page"><ChevronRight className="path-separator" size={13}/><button type="button" className={`path-page-badge ${!page?'empty':''} ${location!=='editor'?'inactive':''}`} aria-current={location==='editor'&&page?'page':undefined} aria-label={page?`현재 페이지 ${pageIndex+1} · ${page.name}`:'이미지 없음'} aria-controls="canvas-editor" title={page?.name} disabled={!page} onClick={onOpenEditor}><FileImage size={13}/>{page?String(pageIndex+1).padStart(2,'0'):'이미지 없음'}</button></li></>}
   </ol>
  </nav>
  {location==='editor'&&page&&<span className="path-image-size" aria-label={`이미지 크기 ${page.width} × ${page.height}`}><Crop size={13}/><span>{page.width} × {page.height}</span></span>}
  {controls}
 </header>;
}
