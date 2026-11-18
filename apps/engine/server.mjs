import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {expandUploads,UPLOAD_LIMITS} from './uploads.mjs';
import {REVIEW_COMMAND_FIELDS} from './translation-review-store.mjs';

export const SESSION_COOKIE = 'mangohana_engine_session';
const BODY_LIMIT = 8 * 1024 * 1024 + 64 * 1024;
const FILE_LIMIT = 8 * 1024 * 1024;
const MAX_PARTS = 200;
export const ENGINE_BODY_LIMITS=Object.freeze({single:BODY_LIMIT,batch:UPLOAD_LIMITS.totalBytes+128*1024,json:8*1024});
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const requireValue = (condition, status, code, message) => { if (!condition) throw failure(status, code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = new Set(['source_language', 'target_language', 'project_id', 'page_id', 'page_number', 'idempotency_key']);
const batchFields=new Set(['source_language','target_language','project_id','idempotency_key','manifest','current_page_id']);
const identifier=/^[A-Za-z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function exactOrigin(value) {
  let url; try { url = new URL(value); } catch { throw failure(503, 'SERVER_CONFIG_INVALID', '사이트 Origin 설정이 필요합니다.'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password, 503, 'SERVER_CONFIG_INVALID', '사이트 Origin 설정이 올바르지 않습니다.');
  return url;
}
function sessionToken(request) {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(SESSION_COOKIE + '='));
  const token = values.length === 1 ? values[0].slice(SESSION_COOKIE.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}
function session(request, response, secure) {
  let token = sessionToken(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    token = randomBytes(32).toString('base64url');
    response.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
  }
  return hash(token);
}
async function boundedBody(request, maximum=BODY_LIMIT) {
  const declared = request.headers['content-length'];
  requireValue(declared === undefined || /^\d+$/.test(declared) && Number(declared) <= maximum, 413, 'BODY_LIMIT', '업로드 요청이 크기 제한을 초과했습니다.');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; requireValue(size <= maximum, 413, 'BODY_LIMIT', '업로드 요청이 크기 제한을 초과했습니다.'); chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function multipart(request) {
  const contentType = request.headers['content-type'];
  requireValue(typeof contentType === 'string' && /^multipart\/form-data\s*;/i.test(contentType) && contentType.length <= 256, 415, 'CONTENT_TYPE_INVALID', 'multipart 파일 업로드가 필요합니다.');
  const bytes = await boundedBody(request); let data;
  try { data = await new Request('http://127.0.0.1/jobs', { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData(); }
  catch { throw failure(422, 'MULTIPART_INVALID', '업로드 파일과 필드를 읽지 못했습니다.'); }
  const entries = [...data.entries()];
  requireValue(entries.length <= MAX_PARTS, 413, 'PART_LIMIT', '업로드 필드 수가 제한을 초과했습니다.');
  const files = entries.filter(([name, value]) => name === 'file' && typeof value !== 'string');
  requireValue(files.length === 1 && entries.filter(([name]) => name === 'file').length === 1 && entries.every(([name, value]) => typeof value === 'string' || name === 'file'), 422, 'MULTIPART_INVALID', '이미지 파일 한 장을 올려 주세요.');
  const file = files[0][1]; requireValue(file.size > 0 && file.size <= FILE_LIMIT, 413, 'INPUT_LIMIT', '이미지는 8MiB 이하로 올려 주세요.');
  const values = {};
  for (const [name, value] of entries) {
    if (name === 'file') continue;
    requireValue(typeof value === 'string' && Buffer.byteLength(value) <= 1024, 422, 'FIELD_INVALID', '업로드 필드가 올바르지 않습니다.');
    if (name === 'owner') continue; // Browser values can never select the job owner.
    requireValue(fields.has(name) && !Object.hasOwn(values, name), 422, 'FIELD_INVALID', '중복되거나 지원하지 않는 업로드 필드입니다.');
    values[name] = value;
  }
  requireValue(['ja', 'auto'].includes(values.source_language ?? 'ja') && (values.target_language ?? 'ko') === 'ko' && /^[A-Za-z0-9._:-]{1,200}$/.test(values.idempotency_key ?? ''), 422, 'INPUT_INVALID', '일본어→한국어와 작업 요청 식별자를 확인해 주세요.');
  requireValue([values.project_id, values.page_id].every(value => value === undefined || /^[A-Za-z0-9_-]{1,128}$/.test(value)) &&
    (values.page_number===undefined||/^[1-9][0-9]{0,5}$/.test(values.page_number)&&Number(values.page_number)<=100000)&&
    file.name.length > 0 && file.name.length <= 180 && !/[\/\\\x00-\x1f\x7f]/.test(file.name), 422, 'INPUT_INVALID', '파일과 페이지 식별자를 확인해 주세요.');
  return { bytes: Buffer.from(await file.arrayBuffer()), name: file.name, sourceLanguage: values.source_language ?? 'ja',
    projectId: values.project_id, pageId: values.page_id, ...(values.page_number===undefined?{}:{pageNumber:Number(values.page_number)}), idempotencyKey: values.idempotency_key };
}

async function batchMultipart(request){
 const contentType=request.headers['content-type'];
 requireValue(typeof contentType==='string'&&/^multipart\/form-data\s*;/i.test(contentType)&&contentType.length<=256,415,'CONTENT_TYPE_INVALID','multipart 파일 업로드가 필요합니다.');
 const bytes=await boundedBody(request,ENGINE_BODY_LIMITS.batch);let data;
 try{data=await new Request('http://127.0.0.1/batches',{method:'POST',headers:{'content-type':contentType},body:bytes}).formData();}
 catch{throw failure(422,'MULTIPART_INVALID','배치의 파일과 필드를 읽지 못했습니다.');}
 const entries=[...data.entries()];requireValue(entries.length<=MAX_PARTS,413,'PART_LIMIT','업로드 필드 수가 제한을 초과했습니다.');
 const files=[],values={};
 for(const [name,value]of entries){
  if(typeof value!=='string'){
   requireValue(['file','files'].includes(name)&&value.size>0&&value.size<=UPLOAD_LIMITS.archiveBytes,422,'MULTIPART_INVALID','지원하는 파일 업로드를 확인해 주세요.');
   files.push({name:value.name,bytes:Buffer.from(await value.arrayBuffer())});continue;
  }
  requireValue(Buffer.byteLength(value)<=64*1024,422,'FIELD_INVALID','배치 필드가 너무 큽니다.');if(name==='owner')continue;
  requireValue(batchFields.has(name)&&!Object.hasOwn(values,name),422,'FIELD_INVALID','중복되거나 지원하지 않는 배치 필드입니다.');values[name]=value;
 }
 requireValue(identifier.test(values.project_id??'')&&/^[A-Za-z0-9._:-]{1,200}$/.test(values.idempotency_key??'')&&['ja','auto'].includes(values.source_language??'ja')&&(values.target_language??'ko')==='ko',422,'INPUT_INVALID','작품·언어·배치 식별자를 확인해 주세요.');
 const expanded=await expandUploads(files);let manifest;
 if(values.manifest!==undefined){
  try{manifest=JSON.parse(values.manifest);}catch{throw failure(422,'BATCH_MANIFEST_INVALID','페이지 연결 정보를 읽지 못했습니다.');}
  requireValue(Array.isArray(manifest)&&manifest.length===expanded.pages.length&&new Set(manifest.map(page=>page?.key)).size===manifest.length&&
   manifest.every(page=>page&&Object.keys(page).every(key=>['key','page_id','page_number'].includes(key))&&typeof page.key==='string'&&expanded.pages.some(file=>file.key===page.key)&&identifier.test(page.page_id??'')&&
    (page.page_number===undefined||Number.isSafeInteger(page.page_number)&&page.page_number>0&&page.page_number<=100000)),422,'BATCH_MANIFEST_INVALID','페이지 연결 식별자와 순서를 확인해 주세요.');
 }
 const pages=expanded.pages.map(page=>{const binding=manifest?.find(item=>item.key===page.key);return {...page,...(binding?{pageId:binding.page_id,...(binding.page_number===undefined?{}:{pageNumber:binding.page_number})}:{})};});
 return {projectId:values.project_id,idempotencyKey:values.idempotency_key,sourceLanguage:values.source_language??'ja',pages,
  ...(values.current_page_id===undefined?{}:{currentPageId:values.current_page_id}),ignoredFiles:expanded.ignoredFiles,archiveStats:expanded.archiveStats};
}
async function jsonBody(request,allowed,required,maximum=ENGINE_BODY_LIMITS.json){
 requireValue(/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??''),415,'CONTENT_TYPE_INVALID','JSON 요청이 필요합니다.');
 let value;try{value=JSON.parse((await boundedBody(request,maximum)).toString('utf8'));}catch(error){if(error.status)throw error;throw failure(422,'JSON_INVALID','요청 내용을 읽지 못했습니다.');}
 requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key)),422,'INPUT_INVALID','지원하는 요청 필드를 확인해 주세요.');return value;
}

/** Only the same-origin Sites proxy should expose this loopback server. */
export function createEngineServer({ store, contextStore, reviewStore, inspectImportedPage, imageController, typesettingController, layoutReview, readabilityReview, allowedOrigin }) {
  const site = exactOrigin(allowedOrigin);
  requireValue(store && ['health', 'submit', 'get', 'getResult'].every(name => typeof store[name] === 'function'), 503, 'SERVER_CONFIG_INVALID', '작업 저장소가 필요합니다.');
  const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  let acceptingBatch=false;
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16 * 1024 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('cross-origin-resource-policy', 'same-origin');
    try {
      const address = server.address();
      requireValue(address && typeof address !== 'string' && address.address === '127.0.0.1' && request.headers.host === `127.0.0.1:${address.port}`, 403, 'HOST_DENIED', '허용되지 않은 작업 서버 주소입니다.');
      const requestOrigin = request.headers.origin;
      requireValue(requestOrigin === undefined || requestOrigin === allowedOrigin, 403, 'ORIGIN_DENIED', '허용되지 않은 사이트입니다.');
      requireValue(request.method === 'GET' || request.method === 'POST', 405, 'METHOD_DENIED', '지원하지 않는 요청 방식입니다.');
      if (request.method === 'POST') requireValue(requestOrigin === allowedOrigin, 403, 'ORIGIN_REQUIRED', '사이트 Origin이 필요합니다.');
      requireValue(typeof request.url === 'string' && request.url.startsWith('/') && !request.url.startsWith('//') && !/[\\\x00-\x20]/.test(request.url), 400, 'PATH_INVALID', '요청 주소가 올바르지 않습니다.');
      const url = new URL(request.url, 'http://' + request.headers.host);
      requireValue(!url.search && !url.hash, 400, 'PATH_INVALID', '요청 주소에 쿼리를 사용할 수 없습니다.');
      const reviewMatch=/^\/translation-reviews\/([A-Za-z0-9_-]{1,128})(\/apply)?$/.exec(url.pathname);
      const reviewPage=/^\/translation-review-pages\/([a-f0-9]{64})$/.exec(url.pathname);
      const inspectPage=/^\/translation-review-pages\/([a-f0-9]{64})\/inspect-inputs$/.exec(url.pathname);
      const layoutAction=/^\/translation-review-pages\/([a-f0-9]{64})\/layout-review(?:\/(validate|save|approve|compare))?$/.exec(url.pathname);
      const readabilityAction=/^\/translation-review-pages\/([a-f0-9]{64})\/layout-readability$/.exec(url.pathname);
      const roiAction=/^\/translation-review-pages\/([a-f0-9]{64})\/layout-roi\/(validate|approve-roi|save|approve-layout)$/.exec(url.pathname);
      const imageAction=/^\/translation-review-pages\/([a-f0-9]{64})\/(image-preflight|image-permits)(?:\/([a-f0-9-]{36})(?:\/(execute|cancel))?)?$/.exec(url.pathname);
      const typesettingAction=/^\/translation-review-pages\/([a-f0-9]{64})\/(typesetting-source|typesetting-preflight|typesetting-permits)(?:\/([a-f0-9-]{36})(?:\/(execute|cancel))?)?$/.exec(url.pathname);
      if(typesettingAction)requireValue(!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','승인 번역을 저장한 브라우저 세션이 필요합니다.');
      if(imageAction)requireValue(!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','승인 번역을 저장한 브라우저 세션이 필요합니다.');
      if(layoutAction)requireValue(!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','승인 번역을 저장한 브라우저 세션이 필요합니다.');
      if(readabilityAction)requireValue(!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','승인 번역을 저장한 브라우저 세션이 필요합니다.');
      if(roiAction)requireValue(!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','현재 검수 브라우저 세션이 필요합니다.');
      if(inspectPage)requireValue(request.method==='POST'&&!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','저장한 번역을 현재 브라우저 세션에서 먼저 열어 주세요.');
      if(reviewMatch&&request.method==='POST')requireValue(!!sessionToken(request),403,'REVIEW_SESSION_REQUIRED','번역 검수 화면을 현재 세션에서 먼저 열어 주세요.');
      const owner = session(request, response, site.protocol === 'https:');
      if(roiAction){
        requireValue(request.method==='POST',405,'METHOD_DENIED','확장 후보 검토 요청 방식을 확인해 주세요.');
        requireValue(!!reviewStore&&!!layoutReview?.roiExpansion,503,'ROI_REVIEW_UNAVAILABLE','ROI 확장 검토 경로를 준비해 주세요.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','현재 검수 세션이 다릅니다.');
        const [,id,action]=roiAction,extra={validate:['choices'],'approve-roi':['choices','proposalSha256','standardReviewSha256','roiAcknowledged'],save:['receiptId','proposalSha256','saveAcknowledged'],'approve-layout':['planSha256','expectedStandardReviewSha256','reviewAcknowledged']},fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256','expectedLayoutRevision','requestKey',...extra[action]],body=await jsonBody(request,fields,fields,64*1024),controller=new AbortController(),abort=()=>{if(!response.writableEnded)controller.abort();};response.once('close',abort);
        try{return json(response,200,await layoutReview.roiExpansion[{'validate':'validate','approve-roi':'approveRoi','save':'save','approve-layout':'approveLayout'}[action]](owner,id,body,{signal:controller.signal}));}finally{response.removeListener('close',abort);}
      }
      if(readabilityAction){
        requireValue(request.method==='GET',405,'METHOD_DENIED','가독성 비교는 읽기 전용입니다.');
        requireValue(!!reviewStore&&!!readabilityReview,503,'READABILITY_UNAVAILABLE','가독성 비교 자료를 준비해 주세요.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','현재 브라우저 세션이 다릅니다.');
        const controller=new AbortController(),abort=()=>{if(!response.writableEnded)controller.abort();};response.once('close',abort);
        try{return json(response,200,await readabilityReview.get(owner,readabilityAction[1],{signal:controller.signal}));}finally{response.removeListener('close',abort);}
      }
      if(typesettingAction){
        requireValue(!!reviewStore&&!!typesettingController,503,'TYPESETTING_CONTROLLER_UNAVAILABLE','보존된 복원 결과의 식자 경로를 준비해 주세요.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','현재 검수 세션이 다릅니다.');
        const [,documentId,action,id,operation]=typesettingAction;
        if(action==='typesetting-source'){requireValue(!id&&request.method==='GET',405,'METHOD_DENIED','복원 출처는 조회만 할 수 있습니다.');return json(response,200,await typesettingController.inspectSource(owner,documentId));}
        if(action==='typesetting-preflight'){requireValue(!id&&request.method==='POST',405,'METHOD_DENIED','식자 실행 전 점검 요청을 확인해 주세요.');const fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256'];return json(response,200,await typesettingController.prepare(owner,documentId,await jsonBody(request,fields,fields)));}
        if(!id){requireValue(request.method==='POST',405,'METHOD_DENIED','별도 식자 실행 승인이 필요합니다.');const fields=['permitId','proposalSha256','executionAcknowledged','cleanedReuseAcknowledged'];return json(response,200,await typesettingController.approve(owner,documentId,await jsonBody(request,fields,fields)));}
        if(!operation){requireValue(request.method==='GET',405,'METHOD_DENIED','저장된 식자 실행 상태를 조회해 주세요.');return json(response,200,await typesettingController.get(owner,documentId,id));}
        requireValue(request.method==='POST',405,'METHOD_DENIED','식자 실행 또는 취소 요청을 확인해 주세요.');await jsonBody(request,[],[]);
        return json(response,operation==='execute'?202:200,operation==='execute'?await typesettingController.start(owner,documentId,{permitId:id}):await typesettingController.cancel(owner,documentId,id));
      }
      if(layoutAction){
        requireValue(!!reviewStore&&!!layoutReview,503,'LAYOUT_REVIEW_UNAVAILABLE','배치 검토 화면을 준비하지 못했습니다.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','현재 브라우저 세션이 다릅니다.');
        const [,id,action]=layoutAction;requireValue(request.method===(action?'POST':'GET'),405,'METHOD_DENIED','배치 검토 요청 방식을 확인해 주세요.');
        const abortController=new AbortController(),abort=()=>{if(!response.writableEnded)abortController.abort();};response.once('close',abort);
        try{if(!action)return json(response,200,await layoutReview.get(owner,id,{signal:abortController.signal}));
          const fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256','expectedLayoutRevision','requestKey',...(action==='approve'?['planSha256','reviewAcknowledged']:action==='compare'?['regionId']:['entries'])],body=await jsonBody(request,[...fields,...(action==='compare'?['referenceEntry']:action==='approve'?['expectedStandardReviewSha256']:[])],fields,64*1024);
          return json(response,200,await layoutReview[action](owner,id,body,{signal:abortController.signal}));
        }finally{response.removeListener('close',abort);}
      }
      if(imageAction){
        requireValue(!!reviewStore&&!!imageController,503,'IMAGE_CONTROLLER_UNAVAILABLE','한 페이지 실행 준비 경로를 열어 주세요.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','현재 브라우저 세션이 다릅니다.');
        const [,documentId,action,id,operation]=imageAction;
        if(action==='image-preflight'){
          requireValue(!id&&request.method==='POST',405,'METHOD_DENIED','실행 전 점검 요청을 확인해 주세요.');
          const fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256'];return json(response,200,await imageController.prepare(owner,documentId,await jsonBody(request,fields,fields)));
        }
        if(!id){requireValue(request.method==='POST',405,'METHOD_DENIED','별도 실행 승인 요청이 필요합니다.');const fields=['permitId','proposalSha256','executionAcknowledged'];return json(response,200,await imageController.approve(owner,documentId,await jsonBody(request,fields,fields)));}
        if(!operation){requireValue(request.method==='GET',405,'METHOD_DENIED','저장된 실행 상태를 조회해 주세요.');return json(response,200,await imageController.get(owner,documentId,id));}
        requireValue(request.method==='POST',405,'METHOD_DENIED','실행 또는 취소 요청을 확인해 주세요.');await jsonBody(request,[],[]);
        return json(response,operation==='execute'?202:200,operation==='execute'?await imageController.start(owner,documentId,{permitId:id}):await imageController.cancel(owner,documentId,id));
      }
      if(inspectPage){
        requireValue(!!reviewStore&&typeof inspectImportedPage==='function',503,'IMPORTED_PAGE_INSPECTOR_UNAVAILABLE','무추론 입력 점검기를 준비해 주세요.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','저장한 번역과 현재 브라우저 세션이 다릅니다.');
        const fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256'],body=await jsonBody(request,fields,fields);
        const controller=new AbortController(),abort=()=>{if(!response.writableEnded)controller.abort();};response.once('close',abort);
        try{return json(response,200,await reviewStore.withEngineInputs(owner,inspectPage[1],body,binding=>inspectImportedPage(binding,{signal:controller.signal})));}
        finally{response.removeListener('close',abort);}
      }
      if(reviewMatch||reviewPage){
        requireValue(!!reviewStore,503,'REVIEW_UNAVAILABLE','번역 검수 저장소를 준비하지 못했습니다.');
        if(reviewPage){requireValue(request.method==='GET',405,'METHOD_DENIED','저장한 번역은 조회만 할 수 있습니다.');return json(response,200,await reviewStore.get(owner,reviewPage[1]));}
        if(!reviewMatch[2]){requireValue(request.method==='GET',405,'METHOD_DENIED','검수 미리보기를 먼저 열어 주세요.');return json(response,200,await reviewStore.preview(owner,reviewMatch[1]));}
        requireValue(request.method==='POST',405,'METHOD_DENIED','번역 적용은 명시적 승인 요청이 필요합니다.');
        requireValue(request.headers['x-mangohana-review-scope']===reviewStore.scope(owner),409,'REVIEW_SESSION_MISMATCH','검수 화면을 연 세션과 현재 세션이 다릅니다.');
        const body=await jsonBody(request,REVIEW_COMMAND_FIELDS,REVIEW_COMMAND_FIELDS,64*1024);
        return json(response,200,await reviewStore.apply(owner,reviewMatch[1],body));
      }
      if(store.imageExecutionAuthorized===false&&request.method==='POST'&&/^\/(?:jobs|batches)(?:\/|$)/.test(url.pathname))throw failure(423,'IMAGE_EXECUTION_NOT_AUTHORIZED','이 시작 경로는 번역 저장 전용입니다. 이미지 실행은 별도 승인이 필요합니다.');
      if (request.method === 'GET' && url.pathname === '/health') {
        const health = await store.health(); return json(response, 200, { status: health.ready ? 'ok' : 'unavailable', ...health, formats: ['png', 'jpg', 'webp',...(typeof store.submitBatch==='function'?['zip']:[])], languages: ['auto', 'ja'], targetLanguage: 'ko',batchSupported:typeof store.submitBatch==='function' });
      }
      const contextMatch=/^\/projects\/([A-Za-z0-9_-]{1,128})\/context$/.exec(url.pathname);
      if(contextMatch&&contextStore){
        // This opaque namespace is an identity guard; the cookie still owns
        // authorization. A durable browser intent cannot migrate to a new owner.
        const scopeId=hash('mangohana-context-scope-v1\0'+owner+'\0'+contextMatch[1]);
        try{
        if(request.method==='GET')return json(response,200,{...await contextStore.get(owner,contextMatch[1]),scopeId});
        requireValue(request.headers['x-mangohana-context-scope']===scopeId,409,'CONTEXT_SCOPE_CHANGED','브라우저 세션과 보관한 용어 요청의 범위가 다릅니다. 이전 요청과 초안은 보존해 주세요.');
        const body=await jsonBody(request,['expected_revision','idempotency_key','changes'],['expected_revision','idempotency_key','changes']);
        // References to server jobs/reports are verified by internal integrations.
        // A browser may edit values and explicitly confirm them, but cannot forge
        // provenance or submit AI proposals through this user command route.
        requireValue(Array.isArray(body.changes)&&body.changes.every(change=>change&&typeof change==='object'&&!Array.isArray(change)&&!Object.hasOwn(change,'reference')),422,'CONTEXT_INPUT_INVALID','용어 변경 자료를 확인해 주세요.');
        return json(response,200,{...await contextStore.apply(owner,contextMatch[1],{expectedRevision:body.expected_revision,idempotencyKey:body.idempotency_key,changes:body.changes}),scopeId});
        }catch(error){if(error&&typeof error==='object')error.contextScopeId=scopeId;throw error;}
      }
      if (request.method === 'POST' && url.pathname === '/jobs') return json(response, 202, await store.submit({ ...await multipart(request), owner }));
      if(request.method==='POST'&&url.pathname==='/batches'){
        requireValue(typeof store.submitBatch==='function',503,'BATCH_UNAVAILABLE','배치 처리를 사용할 수 없습니다.');requireValue(!acceptingBatch,429,'BATCH_UPLOAD_BUSY','다른 배치 업로드를 저장하고 있습니다. 잠시 후 다시 시도해 주세요.');
        acceptingBatch=true;try{return json(response,202,await store.submitBatch({...await batchMultipart(request),owner}));}finally{acceptingBatch=false;}
      }
      if(request.method==='POST'&&url.pathname==='/batches/resolve'&&typeof store.resolveBatch==='function'){
        const body=await jsonBody(request,['project_id','idempotency_key'],['project_id','idempotency_key']);return json(response,200,await store.resolveBatch(owner,{projectId:body.project_id,idempotencyKey:body.idempotency_key}));
      }
      const batchMatch=/^\/batches\/([^/]+)$/.exec(url.pathname);
      if(request.method==='GET'&&batchMatch&&uuid.test(batchMatch[1])&&typeof store.getBatch==='function')return json(response,200,await store.getBatch(owner,batchMatch[1]));
      const priorityMatch=/^\/projects\/([A-Za-z0-9_-]{1,128})\/priority$/.exec(url.pathname);
      if(request.method==='POST'&&priorityMatch&&typeof store.prioritize==='function'){
        const body=await jsonBody(request,['page_id'],['page_id']);return json(response,200,await store.prioritize(owner,{projectId:priorityMatch[1],pageId:body.page_id}));
      }
      const retryMatch=/^\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
      if(request.method==='POST'&&retryMatch&&uuid.test(retryMatch[1])&&typeof store.retry==='function'){
        const body=await jsonBody(request,['idempotency_key'],['idempotency_key']);return json(response,202,await store.retry(owner,retryMatch[1],{idempotencyKey:body.idempotency_key}));
      }
      const cancelMatch=/^\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
      if(request.method==='POST'&&cancelMatch&&uuid.test(cancelMatch[1])&&typeof store.cancel==='function'){
        await jsonBody(request,[],[]);return json(response,202,await store.cancel(owner,cancelMatch[1]));
      }
      if (request.method === 'GET' && url.pathname === '/jobs' && typeof store.list === 'function') return json(response, 200, { jobs: await store.list(owner) });
      const match = /^\/jobs\/([^/]+)(\/result)?$/.exec(url.pathname);
      if (request.method === 'GET' && match && uuid.test(match[1])) {
        const job = await store.get(owner, match[1]);
        if (match[2]) { requireValue(job.status === 'completed', 409, 'RESULT_NOT_READY', '완료된 결과가 아직 없습니다.'); return json(response, 200, await store.getResult(owner, job.id)); }
        return json(response, 200, job.status === 'completed' ? { ...job, result: await store.getResult(owner, job.id) } : job);
      }
      throw failure(404, 'NOT_FOUND', '요청한 작업 기능을 찾을 수 없습니다.');
    } catch (error) {
      if (response.destroyed || response.headersSent) { response.destroy(); return; }
      const known = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 && /^[A-Z][A-Z0-9_]{1,64}$/.test(error?.code ?? '');
      json(response, known ? error.status : 503, { error: known ? error.message : '작업 서버 응답을 확인하지 못했습니다.', code: known ? error.code : 'SERVER_UNAVAILABLE',
        ...(/^[a-f0-9]{64}$/.test(error?.contextScopeId??'')?{scopeId:error.contextScopeId}:{}) });
    }
  });
  const originalListen = server.listen;
  server.listen = function (...args) {
    if (typeof args[0] === 'object' && args[0] !== null) {
      requireValue(!args[0].path && (args[0].host === undefined || args[0].host === '127.0.0.1'), 503, 'HOST_DENIED', '작업 서버는 127.0.0.1에서만 시작할 수 있습니다.');
      args[0] = { ...args[0], host: '127.0.0.1' };
    } else {
      requireValue(typeof args[0] === 'number' && (typeof args[1] !== 'string' || args[1] === '127.0.0.1'), 503, 'HOST_DENIED', '작업 서버는 127.0.0.1에서만 시작할 수 있습니다.');
      if (typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
    }
    return originalListen.apply(this, args);
  };
  return server;
}
