import {normalizeLocalOcr,normalizeLocalTranslation,type LocalOcrSettings,type LocalTranslationSettings} from './studio-local-translation';
export const DEFAULT_ENGINE_ENDPOINT = '/api/engine';
export type Mode = "online";
export type PageStatus = "ready" | "processing" | "paused" | "review" | "completed" | "failed";
export type IssueKind = "missing" | "overlap" | "linebreak" | "error";
export type TextBlock = {
  id: string; source: string; text: string; x: number; y: number; w: number; h: number;
  font: string; size: number; weight: number; align: "left" | "center" | "right";
  color: string; lineHeight: number; confidence?: number; fill: boolean;
};
export type PendingBatch={key:string;projectId:string;source:'ja'|'auto';target:'ko';phase:'prepared'|'sending';members:{pageId:string;pageNumber?:number;generation:number;sourceSha256:string;name:string}[]};
export type StudioPage = {
  id: string; name: string; image: string; cleanImage?: string; finalImage?: string; finalImageSignature?: string; width: number; height: number;
  blocks: TextBlock[]; status: PageStatus; error?: string; reviewed: boolean; jobId?: string; jobEndpoint?: string; requestId?: string; processed?: boolean; engineGeneration?: number;enginePageNumber?:number;pendingBatch?:PendingBatch;
};
export type Project = {
  id: string; name: string; chapter: string; source: string; target: string; mode: Mode;
  sample: boolean; pages: StudioPage[]; createdAt: string; updatedAt: string;
  localTranslation?:LocalTranslationSettings;
  localOcr?:LocalOcrSettings;
  history: { id: string; at: string; text: string; type: "edit" | "process" | "import" | "export" }[];
};
export type Issue = { id: string; kind: IssueKind; pageId: string; blockId?: string; title: string; description: string };
export const FONTS: Record<string, string> = {
  sans: '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  serif: '"Noto Serif CJK KR", "Batang", serif',
  rounded: '"Arial Rounded MT Bold", "Noto Sans KR", sans-serif',
};
export const FONT_NAMES: Record<string, string> = { sans: "기본 고딕", serif: "명조", rounded: "라운드 고딕" };
export const ISSUE_NAMES: Record<IssueKind, string> = { missing: "대사 누락", overlap: "텍스트 겹침", linebreak: "줄바꿈", error: "처리 오류" };
export const STATUS_NAMES: Record<PageStatus, string> = {ready:"처리 대기", processing:"처리 중", paused:"조회 중지", review:"검토 필요", completed:"검수 완료", failed:"처리 오류"};
export function uid() { return crypto.randomUUID(); }
export function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min,n)); }
export function makeBlock(patch: Partial<TextBlock> = {}): TextBlock {
  return {id:uid(),source:"",text:"새 번역문",x:35,y:35,w:25,h:15,font:"sans",size:32,weight:600,align:"center",color:"#202020",lineHeight:1.4,fill:false,...patch};
}
/** Fixed visual fields and layer order bind an engine bitmap to its editable content. */
export function blockVisualSignature(blocks:readonly TextBlock[]):string {
  return JSON.stringify({version:1,blocks:blocks.map(b=>[b.text,b.x,b.y,b.w,b.h,b.font,b.size,b.weight,b.align,b.color,b.lineHeight,b.fill])});
}
export function canUseFinalImage(page:StudioPage|undefined):page is StudioPage&{finalImage:string;finalImageSignature:string} {
  return !!page&&typeof page.finalImage==="string"&&/^data:image\/png;base64,/.test(page.finalImage)&&typeof page.finalImageSignature==="string"&&page.finalImageSignature===blockVisualSignature(page.blocks);
}
export function lineCount(b: TextBlock, width: number) {
  const available = Math.max(1, b.w / 100 * width - 12);
  let lines = 0;
  for (const paragraph of b.text.split("\n")) {
    let used = 0; lines++;
    for (const char of paragraph) {
      const unit = /[\u0000-\u00ff]/.test(char) ? (char === " " ? .3 : .56) : 1;
      if (used + unit * b.size > available && used > 0) {lines++; used=0;}
      used += unit * b.size;
    }
  }
  return lines;
}
export function getIssues(page: StudioPage): Issue[] {
  const issues: Issue[] = [];
  if (page.status === "failed") issues.push({id:page.id+"-error",kind:"error",pageId:page.id,title:"처리를 완료하지 못했어요",description:page.error || "엔진 연결과 처리 기록을 확인해 주세요."});
  for (const b of page.blocks) {
    if (!b.text.trim()) {
      issues.push({id:b.id+"-missing",kind:"missing",pageId:page.id,blockId:b.id,title:"번역문이 비어 있어요",description:"인식한 원문을 확인하고 이미지 위에서 입력해 주세요."});
    } else if (lineCount(b,page.width) * b.size * b.lineHeight > b.h/100 * page.height - 8) {
      issues.push({id:b.id+"-linebreak",kind:"linebreak",pageId:page.id,blockId:b.id,title:"말풍선에 문장이 꽉 차요",description:"글자 크기를 맞추거나 줄바꿈을 다듬어 주세요."});
    }
    for (const other of page.blocks) {
      if (b.id >= other.id) continue;
      const overlapX = Math.max(0,Math.min(b.x+b.w,other.x+other.w)-Math.max(b.x,other.x));
      const overlapY = Math.max(0,Math.min(b.y+b.h,other.y+other.h)-Math.max(b.y,other.y));
      if (overlapX*overlapY > Math.min(b.w*b.h,other.w*other.h)*.08) issues.push({id:b.id+other.id+"-overlap",kind:"overlap",pageId:page.id,blockId:other.id,title:"텍스트 영역이 겹쳐요",description:"겹친 영역으로 이동해 위치를 조절해 주세요."});
    }
  }
  return issues;
}
export function fitBlock(block: TextBlock, page: Pick<StudioPage,"width"|"height">): TextBlock {
  const b = {...block};
  while (b.size > 10 && lineCount(b,page.width)*b.size*b.lineHeight > b.h/100*page.height-12) b.size--;
  return b;
}
export function pageStatus(page: StudioPage): PageStatus {
  if (page.status === "processing" || page.status === "failed") return page.status;
  if (page.jobId || page.pendingBatch || page.status === "paused") return "paused";
  if (page.reviewed && getIssues(page).length === 0) return "completed";
  if (page.blocks.length || page.processed) return "review";
  return "ready";
}
export function emptyProject(name: string): Project {
  const now = new Date().toISOString();
  return {id:uid(),name,chapter:"Chapter 01",source:"ja",target:"ko",mode:"online",sample:false,pages:[],createdAt:now,updatedAt:now,history:[]};
}
export function sampleProject(): Project {
  const block = (id:string, patch:Partial<TextBlock>) => makeBlock({id,...patch});
  return {id:"trio-sample-journey",name:"별을 잇는 여행",chapter:"Chapter 01",source:"ja",target:"ko",mode:"online",sample:true,createdAt:"2026-11-09T09:00:00Z",updatedAt:"2026-11-09T09:00:00Z",history:[{id:"sample-history",at:"2026-11-09T09:00:00Z",text:"편집 체험용 샘플 4페이지 준비",type:"import"}],pages:[
    {id:"sample-p1",name:"001.png",image:"/samples/journey-01.png",width:1024,height:1536,status:"review",reviewed:false,blocks:[
      block("p1-b1",{source:"この街のどこかに、きっと答えがある。",text:"이 도시\n어딘가에,\n우리가 찾던\n답이 있을 거야.",x:73.5,y:13,w:22,h:24,size:28,confidence:.986}),
      block("p1-b2",{source:"僕らの物語は、ここから始まる。",text:"어쩌면 우리의\n이야기는 지금부터\n시작일지도 몰라.",x:5,y:85.5,w:23,h:10,size:44,confidence:.974}),
    ]},
    {id:"sample-p2",name:"002.png",image:"/samples/journey-02.svg",width:500,height:650,status:"review",reviewed:false,blocks:[
      block("p2-b1",{source:"光が見える。",text:"저 빛이\n보여?",x:67,y:8,w:23,h:20,size:19,confidence:.991}),
      block("p2-b2",{source:"あそこに行こう。",text:"저기로\n가 보자.",x:69,y:21,w:23,h:18,size:19,confidence:.963}),
    ]},
    {id:"sample-p3",name:"003.png",image:"/samples/journey-03.svg",width:500,height:650,status:"review",reviewed:false,blocks:[
      block("p3-b1",{source:"ずっと、この景色を探していた。",text:"",x:58,y:6,w:31,h:18,size:19,confidence:.942}),
      block("p3-b2",{source:"やっと会えたね。",text:"드디어\n만났네.",x:8,y:59,w:28,h:10,size:18,confidence:.99}),
    ]},
    {id:"sample-p4",name:"004.png",image:"/samples/journey-04.svg",width:500,height:650,status:"completed",reviewed:true,blocks:[
      block("p4-b1",{source:"新しい旅が始まる。",text:"새로운 여행이\n시작된다.",x:65,y:7,w:25,h:20,size:18,confidence:.997}),
      block("p4-b2",{source:"また、明日。",text:"내일 또 만나.",x:8,y:58,w:28,h:11,size:17,confidence:.993}),
    ]},
  ]};
}
/** Persisted project, page and remote job IDs share one compatibility contract. */
export function isStudioId(value:unknown): value is string {return typeof value==="string"&&value.trim().length>0&&value.length<=200;}
export function validatePendingBatch(value:unknown,projectId:string,pageId:string):PendingBatch {
 const batch=value as PendingBatch,ids=new Set<string>();
 if(!batch||!/^[0-9a-f]{64}$/.test(batch.key)||batch.projectId!==projectId||!['ja','auto'].includes(batch.source)||batch.target!=='ko'||!['prepared','sending'].includes(batch.phase)||!Array.isArray(batch.members)||!batch.members.length||batch.members.length>100)throw new Error('보관된 배치 접수 정보를 확인해 주세요.');
 for(const member of batch.members){if(!member||!isStudioId(member.pageId)||ids.has(member.pageId)||!Number.isSafeInteger(member.generation)||member.generation<0||!/^[0-9a-f]{64}$/.test(member.sourceSha256)||typeof member.name!=='string'||!member.name||member.name.length>180||(member.pageNumber!==undefined&&(!Number.isSafeInteger(member.pageNumber)||member.pageNumber<1||member.pageNumber>100000)))throw new Error('배치 페이지 연결 정보가 중복되거나 올바르지 않아요.');ids.add(member.pageId);}
 if(!ids.has(pageId))throw new Error('보관된 배치에 이 페이지의 연결 정보가 없어요.');
 return batch;
}
function validDate(value:unknown,fallback:string) {return typeof value==="string"&&Number.isFinite(Date.parse(value))?value:fallback;}
function normalizeProject(value:unknown,imported:boolean):Project {
  let p=value as Project;
  if(!p||typeof p.name!=="string"||!Array.isArray(p.pages)||(imported&&p.pages.length>200))throw new Error("Trio 프로젝트 파일을 확인해 주세요.");
  if(!imported&&!isStudioId(p.id))throw new Error("저장된 프로젝트 ID를 확인해 주세요.");
  const ids=new Set<string>();
  const pages=p.pages.map(raw=>{
    if(!raw||!isStudioId(raw.id)||ids.has(raw.id))throw new Error("페이지 ID가 없거나 중복돼요.");
    ids.add(raw.id);
    if(typeof raw.name!=="string"||!Number.isFinite(raw.width)||!Number.isFinite(raw.height)||raw.width<=0||raw.height<=0||raw.width*raw.height>40_000_000||!Array.isArray(raw.blocks))throw new Error("페이지 정보가 올바르지 않아요.");
    if(typeof raw.image!=="string"||!/^(data:image\/(png|jpeg|webp|gif|svg\+xml);base64,|\/samples\/journey-0[1-4]\.(png|svg)$)/.test(raw.image))throw new Error("프로젝트에 지원하지 않는 이미지 주소가 있어요.");
    if(raw.cleanImage&&(typeof raw.cleanImage!=="string"||!/^data:image\/(png|jpeg|webp);base64,/.test(raw.cleanImage)))throw new Error("복원 이미지 형식이 올바르지 않아요.");
    if(raw.finalImage!==undefined&&(typeof raw.finalImage!=="string"||!/^data:image\/(png|jpeg|webp);base64,/.test(raw.finalImage)))throw new Error("최종 이미지 형식이 올바르지 않아요.");
    if(raw.finalImageSignature!==undefined&&typeof raw.finalImageSignature!=="string")throw new Error("최종 이미지의 편집 기준 정보를 확인해 주세요.");
    if(raw.engineGeneration!==undefined&&(!Number.isSafeInteger(raw.engineGeneration)||raw.engineGeneration<0))throw new Error("저장된 처리 요청 세대를 확인해 주세요.");
    if(raw.enginePageNumber!==undefined&&(!Number.isSafeInteger(raw.enginePageNumber)||raw.enginePageNumber<1||raw.enginePageNumber>100000))throw new Error('저장된 서버 페이지 순서를 확인해 주세요.');
    // Project backups include manual regions; OCR's per-response limit is separate.
    const page:StudioPage={...raw,blocks:validateBlocks(raw.blocks,{preserveContent:true}),error:typeof raw.error==="string"?raw.error:undefined,processed:raw.processed===true||((raw.status==="review"||raw.status==="completed")&&!!raw.cleanImage),requestId:undefined};
    if(imported){page.jobId=undefined;page.jobEndpoint=undefined;page.pendingBatch=undefined;page.enginePageNumber=undefined;}
    else if(raw.jobId){
      if(!isStudioId(raw.jobId)||typeof raw.jobEndpoint!=="string")throw new Error("저장된 작업 ID와 엔진 주소를 확인해 주세요.");
      if(raw.jobEndpoint===DEFAULT_ENGINE_ENDPOINT)page.jobEndpoint=DEFAULT_ENGINE_ENDPOINT;
      else{
        let url:URL;try{url=new URL(raw.jobEndpoint);}catch{throw new Error("저장된 엔진 주소가 올바르지 않아요.");}
        // Retain legacy job references for backups; new local requests use the same-origin bridge.
        const local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
        if(url.username||url.password||url.search||url.hash||(url.protocol!=="https:"&&!(url.protocol==="http:"&&local)))throw new Error("저장된 엔진 주소가 올바르지 않아요.");
        page.jobEndpoint=url.href.replace(/\/$/,"");
      }
    }else{page.jobId=undefined;page.jobEndpoint=undefined;}
    if(!imported&&raw.pendingBatch)page.pendingBatch=validatePendingBatch(raw.pendingBatch,p.id,raw.id);
    page.reviewed=raw.reviewed===true&&getIssues({...page,status:"review",jobId:undefined}).length===0;
    if(!imported&&page.pendingBatch&&!page.jobId){page.status=raw.status==='failed'?'failed':'paused';page.error=page.error||'배치 접수 정보를 다시 확인해 주세요. 확인되기 전에는 새 작업을 만들지 않아요.';}
    else if(!imported&&raw.status==="processing"&&!page.jobId){page.status="failed";page.error="작업 ID를 받기 전에 연결이 끊겼어요. 엔진 기록을 확인한 뒤 재시도해 주세요.";}
    else if(!imported&&page.jobId)page.status=raw.status==="failed"?"failed":"paused";
    else page.status=raw.status==="failed"?"failed":page.reviewed?"completed":page.blocks.length||page.processed?"review":"ready";
    return page;
  });
  if(p.localTranslation!==undefined)p={...p,localTranslation:normalizeLocalTranslation(p.localTranslation)};
  if(p.localOcr!==undefined)p={...p,localOcr:normalizeLocalOcr(p.localOcr)};
  const now=new Date().toISOString();
  const history:Array<Project["history"][number]>=Array.isArray(p.history)?p.history.filter(h=>h&&typeof h.text==="string"&&typeof h.at==="string"&&Number.isFinite(Date.parse(h.at))).map((h,i)=>({...h,id:isStudioId(h.id)?h.id:`imported-history-${i}`,type:["edit","process","import","export"].includes(h.type)?h.type:"edit"})):[];
  // Restored and imported local projects keep their content but cannot restore local mode.
  return {...p,id:imported?uid():p.id,name:p.name.slice(0,80),chapter:typeof p.chapter==="string"?p.chapter:"Chapter 01",pages,source:["auto","ja","en","zh"].includes(p.source)?p.source:"auto",target:["ko","ja","en","zh"].includes(p.target)?p.target:"ko",sample:p.sample===true,mode:"online",history,createdAt:validDate(p.createdAt,now),updatedAt:imported?now:validDate(p.updatedAt,now)};
}
export function validateProject(value:unknown):Project {return normalizeProject(value,true);}
export function restoreProject(value:unknown):Project {return normalizeProject(value,false);}
export function validateBlocks(value: unknown,options:{preserveContent?:boolean}={}): TextBlock[] {
  if (!Array.isArray(value) || (!options.preserveContent&&value.length>1000)) throw new Error("텍스트 영역 데이터가 올바르지 않아요.");
  const seen=new Set<string>();
  return value.map((b:Partial<TextBlock>)=>{
    if (!b || ![b.x,b.y,b.w,b.h].every(n=>typeof n==="number" && Number.isFinite(n)) || typeof b.text!=="string") throw new Error("텍스트 좌표와 번역문을 확인해 주세요.");
    const id=typeof b.id==="string"&&b.id.trim().length>0?b.id:uid();
    if(seen.has(id))throw new Error("같은 ID의 텍스트 영역이 중복돼요.");
    seen.add(id);
    const x=clamp(b.x!,0,99), y=clamp(b.y!,0,99);
    return makeBlock({...b,fill:b.fill===true,id,source:typeof b.source==="string"?b.source:"",text:b.text,x,y,w:clamp(b.w!,1,100-x),h:clamp(b.h!,1,100-y),font:b.font && FONTS[b.font]?b.font:"sans",size:clamp(Number(b.size)||32,10,160),weight:[400,500,600,700,800].includes(b.weight!)?b.weight!:600,lineHeight:clamp(Number(b.lineHeight)||1.4,1,2.5),color:/^#[0-9a-f]{6}$/i.test(b.color||"")?b.color!:"#202020",align:["left","center","right"].includes(b.align!)?b.align!:"center",confidence:typeof b.confidence==="number"&&Number.isFinite(b.confidence)?clamp(b.confidence,0,1):undefined});
  });
}
