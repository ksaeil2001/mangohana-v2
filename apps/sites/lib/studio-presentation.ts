import type {Project,StudioPage} from './studio-model';

export type PageActivity='ready'|'processing'|'paused'|'editable'|'failed';
export const PAGE_ACTIVITY_NAMES:Record<PageActivity,string>={ready:'처리 대기',processing:'처리 중',paused:'조회 중지',editable:'편집 가능',failed:'처리 오류'};

/** Only operational state is presented; content quality is judged on the canvas by the user. */
export function pageActivity(page:StudioPage):PageActivity {
 if(page.status==='processing')return 'processing';
 if(page.status==='failed')return 'failed';
 if(page.jobId||page.status==='paused')return 'paused';
 return page.blocks.length||page.processed||page.cleanImage?'editable':'ready';
}
export function canExportPage(page:StudioPage){return !['failed','processing','paused'].includes(pageActivity(page));}

export type ExportFormat='png'|'zip'|'project';
/** UI affordances and the execution boundary use the same eligibility rules. */
export function exportAvailability(format:ExportFormat,project:Project,page:StudioPage|undefined):{allowed:boolean;reason?:string} {
 if(format==='project')return {allowed:true};
 if(format==='zip')return project.pages.some(canExportPage)?{allowed:true}:{allowed:false,reason:'내보낼 페이지가 없어요. 조회를 재개하거나 이전 결과로 편집을 계속해 주세요.'};
 if(!page)return {allowed:false,reason:'먼저 페이지를 추가하거나 선택해 주세요.'};
 return canExportPage(page)?{allowed:true}:{allowed:false,reason:'현재 페이지의 조회를 재개하거나 이전 결과로 편집을 선택한 뒤 PNG로 내려받아 주세요.'};
}
