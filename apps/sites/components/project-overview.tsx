import {useEffect,useMemo,useState} from 'react';
import {FileImage,FolderOpen,Grid2X2} from 'lucide-react';
import {formatFileBytes,inlineImageBytes,isSampleImage,projectImageSummary} from '@/lib/studio-project-summary';
import type {Project} from '@/lib/studio-model';

export default function ProjectOverview({project,canNavigate,onOpenPage,onOpenPages}:{project:Project;canNavigate:boolean;onOpenPage:(id:string)=>void;onOpenPages:()=>void}){
 const [assetBytes,setAssetBytes]=useState<Record<string,number|null>>({});
 const summary=useMemo(()=>projectImageSummary(project.pages,assetBytes),[project.pages,assetBytes]);
 useEffect(()=>{
  const images=[...new Set(project.pages.map(page=>page.image).filter(image=>isSampleImage(image)&&assetBytes[image]===undefined))];
  if(!images.length)return;
  let current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  Promise.all(images.map(async image=>{
   try{const response=await fetch(image,{signal:controller.signal});if(!response.ok)throw new Error('Image unavailable');return [image,(await response.blob()).size] as const;}
   catch{return [image,null] as const;}
  })).then(entries=>{if(current)setAssetBytes(previous=>({...previous,...Object.fromEntries(entries)}));}).finally(()=>clearTimeout(timer));
  return()=>{current=false;clearTimeout(timer);controller.abort();};
 },[project.pages,assetBytes]);
 const pending=project.pages.some(page=>isSampleImage(page.image)&&assetBytes[page.image]===undefined);
 const sizeLabel=pending?'확인 중…':summary.unknownCount?summary.bytes?`${formatFileBytes(summary.bytes)}+`:'확인 불가':formatFileBytes(summary.bytes);
 return <section id="project-overview" className="project-overview" aria-labelledby="project-overview-heading" data-project-id={project.id}>
  <span className="project-overview-label"><FolderOpen size={13}/>선택한 프로젝트</span>
  <h2 id="project-overview-heading" tabIndex={-1} title={project.name}>{project.name}</h2>
  <dl className="project-overview-stats" aria-live="polite">
   <div><dt>파일 개수</dt><dd data-file-count={summary.fileCount}>{summary.fileCount}개</dd></div>
   <div><dt>파일 용량</dt><dd data-file-bytes={summary.unknownCount?'':summary.bytes} title={summary.unknownCount?'용량을 확인한 원본 이미지 합계':`원본 이미지 합계 ${summary.bytes.toLocaleString('ko-KR')} B`}>{sizeLabel}</dd></div>
  </dl>
  {!pending&&summary.unknownCount>0&&<p className="project-size-note">{summary.unknownCount}개 파일의 용량을 확인하지 못했어요.</p>}
  <div className="project-preview-heading"><h3>이미지 미리보기</h3><span>{summary.previews.length} / {summary.fileCount}</span></div>
  <div className="project-preview-grid">{summary.previews.map((page,index)=>{
   const size=inlineImageBytes(page.image)??assetBytes[page.image];
   return <button type="button" className="project-preview-tile" key={page.id} data-page-id={page.id} disabled={!canNavigate} onClick={()=>onOpenPage(page.id)} aria-label={`${index+1}페이지 열기 · ${page.name}`} title={`${page.name}${typeof size==='number'?` · ${formatFileBytes(size)}`:''}`}><img src={page.cleanImage||page.image} alt="" width={page.width} height={page.height} loading="lazy"/><span>{String(index+1).padStart(2,'0')}</span></button>;
  })}</div>
  {!summary.fileCount&&<div className="project-overview-empty"><FileImage size={27}/><p>이미지를 추가해 시작하세요</p><span>이미지·ZIP을 아래에 놓거나 추가하세요</span></div>}
  {summary.fileCount>0&&<button type="button" className="project-overview-open" disabled={!canNavigate} onClick={onOpenPages}><Grid2X2 size={13}/>모든 페이지 보기{summary.fileCount>12&&<span>+{summary.fileCount-12}</span>}</button>}
 </section>;
}
