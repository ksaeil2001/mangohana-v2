export type ReadingView='preview'|'original'|'compare';
export type ReadingAnchor={x:number;y:number};
export type ReadingPosition={pageId:string;zoom:number;view:ReadingView;anchor:ReadingAnchor};
export type ReadingState=Record<string,ReadingPosition>;
type ReadingProject={id:string;pages:readonly {id:string}[]};
export type ReadingPatch={zoom?:number|((value:number)=>number);view?:ReadingView;anchor?:ReadingAnchor};
type ViewportSize={scrollWidth:number;scrollHeight:number;clientWidth:number;clientHeight:number};
type Viewport=ViewportSize&{scrollTo:(target:{left:number;top:number})=>void};
export type ReadingTicket=Readonly<{key:string;revision:number}>;
const between=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const finite=(value:number)=>Number.isFinite(value)?Math.max(0,value):0;
const fraction=(value:number)=>Math.round(Math.min(1,Math.max(0,value))*1_000_000)/1_000_000;
export function defaultReadingPosition(pageId:string):ReadingPosition{return {pageId,zoom:1,view:'preview',anchor:{x:.5,y:0}};}
export function normalizeReadingPosition(value:unknown,project:ReadingProject):ReadingPosition|undefined {
 const position=value as ReadingPosition;
 if(!position||typeof position.pageId!=='string'||!project.pages.some(page=>page.id===position.pageId)||!between(position.zoom,.4,3)||!['preview','original','compare'].includes(position.view)||!position.anchor||!between(position.anchor.x,0,1)||!between(position.anchor.y,0,1))return;
 return position;
}
/** Only live project/page references are retained; document data is never changed. */
export function normalizeReadingState(value:unknown,projects:readonly ReadingProject[]):ReadingState {
 const candidate=value&&typeof value==='object'&&!Array.isArray(value)?value as ReadingState:{};
 const entries=projects.flatMap(project=>{
  const position=normalizeReadingPosition(Object.hasOwn(candidate,project.id)?candidate[project.id]:undefined,project)|| (project.pages[0]?defaultReadingPosition(project.pages[0].id):undefined);
  return position?[[project.id,position] as const]:[];
 });
 if(Object.keys(candidate).length===entries.length&&entries.every(([id,position])=>candidate[id]===position))return candidate;
 return Object.fromEntries(entries);
}
export function readingSelection(state:ReadingState|undefined,project:ReadingProject,pageId?:string):ReadingPosition|undefined {
 const current=normalizeReadingPosition(state&&Object.hasOwn(state,project.id)?state[project.id]:undefined,project);
 if(pageId&&project.pages.some(page=>page.id===pageId))return current?.pageId===pageId?current:defaultReadingPosition(pageId);
 return current||(project.pages[0]?defaultReadingPosition(project.pages[0].id):undefined);
}
export function patchReadingPosition(position:ReadingPosition,patch:ReadingPatch):ReadingPosition {
 const proposed=typeof patch.zoom==='function'?patch.zoom(position.zoom):patch.zoom;
 const zoom=typeof proposed==='number'&&Number.isFinite(proposed)?Math.min(3,Math.max(.4,proposed)):position.zoom;
 const view=patch.view&&['preview','original','compare'].includes(patch.view)?patch.view:position.view;
 const anchor=patch.anchor&&between(patch.anchor.x,0,1)&&between(patch.anchor.y,0,1)?{x:fraction(patch.anchor.x),y:fraction(patch.anchor.y)}:position.anchor;
 if(zoom===position.zoom&&view===position.view&&anchor.x===position.anchor.x&&anchor.y===position.anchor.y)return position;
 return {...position,zoom,view,anchor};
}
/** Relative viewport centre, rather than device-specific scroll pixels. */
export function captureReadingAnchor(viewport:ViewportSize&{scrollLeft:number;scrollTop:number}):ReadingAnchor {
 return {x:viewport.scrollWidth>0?fraction((finite(viewport.scrollLeft)+finite(viewport.clientWidth)/2)/viewport.scrollWidth):.5,
  y:viewport.scrollHeight>0?fraction((finite(viewport.scrollTop)+finite(viewport.clientHeight)/2)/viewport.scrollHeight):0};
}
export function readingScrollTarget(anchor:ReadingAnchor,viewport:ViewportSize):{left:number;top:number} {
 return {left:Math.min(Math.max(0,finite(viewport.scrollWidth)-finite(viewport.clientWidth)),Math.max(0,anchor.x*finite(viewport.scrollWidth)-finite(viewport.clientWidth)/2)),
  top:Math.min(Math.max(0,finite(viewport.scrollHeight)-finite(viewport.clientHeight)),Math.max(0,anchor.y*finite(viewport.scrollHeight)-finite(viewport.clientHeight)/2))};
}
/** A stale animation frame may not move a later user gesture or another page. */
export class ReadingViewportSession {
 private key='';private revision=0;
 activate(key:string):ReadingTicket {if(key!==this.key){this.key=key;this.revision++;}return {key:this.key,revision:this.revision};}
 interact(key:string){if(key===this.key)this.revision++;}
 restore(ticket:ReadingTicket,viewport:Viewport,anchor:ReadingAnchor):boolean {
  if(ticket.key!==this.key||ticket.revision!==this.revision)return false;
  viewport.scrollTo(readingScrollTarget(anchor,viewport));return true;
 }
}
