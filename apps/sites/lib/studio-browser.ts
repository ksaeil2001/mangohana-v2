import type {Project,StudioPage} from './studio-model';

export type CanvasLocation='projects'|'pages'|'editor';
export type ProjectSort='recent'|'name'|'pages';

/** Filtering and sorting are display operations and never reorder the saved workspace. */
export function browseProjects(projects:readonly Project[],query:string,sort:ProjectSort):Project[]{
 const needle=query.trim().toLocaleLowerCase('ko-KR');
 return projects.filter(project=>project.name.toLocaleLowerCase('ko-KR').includes(needle)).sort((a,b)=>
  sort==='name'?a.name.localeCompare(b.name,'ko',{numeric:true}):sort==='pages'?b.pages.length-a.pages.length:Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
}

export function browsePages(pages:readonly StudioPage[],query:string):{page:StudioPage;index:number}[]{
 const needle=query.trim().toLocaleLowerCase('ko-KR');
 return pages.map((page,index)=>({page,index})).filter(({page,index})=>page.name.toLocaleLowerCase('ko-KR').includes(needle)||String(index+1)===needle);
}
