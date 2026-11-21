const IMAGE_LIMIT=8*1024*1024;
const REQUEST_LIMIT=IMAGE_LIMIT+64*1024;
const BATCH_LIMIT=160*1024*1024+128*1024,JSON_LIMIT=8*1024;
const IDENTIFIER=/^[A-Za-z0-9_-]{1,128}$/;
type RouteContext={params:Promise<{path:string[]}>|{path:string[]}};

function error(status:number,message:string,allow?:string){
 return Response.json({error:message},{status,headers:{'Cache-Control':'no-store',...(allow?{Allow:allow}:{})}});
}
async function upstreamOrigin():Promise<string|undefined>{
 let configured=process.env.MANGOHANA_ENGINE_URL||'';
 try{
  const {env}=await import('cloudflare:workers');
  const binding=(env as {MANGOHANA_ENGINE_URL?:unknown}).MANGOHANA_ENGINE_URL;
  if(typeof binding==='string')configured=binding;
 }catch{/* The standalone Node test runtime uses its server environment. */}
 const match=/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(configured);
 if(!match||Number(match[1])<1||Number(match[1])>65535)return undefined;
 return new URL(configured).origin;
}
async function readBody(request:Request,maximum=REQUEST_LIMIT):Promise<Uint8Array>{
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum))throw new RangeError('Request too large');
 const chunks:Uint8Array[]=[];let size=0;
 const reader=request.body?.getReader();
 if(!reader)return new Uint8Array();
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>maximum){await reader.cancel();throw new RangeError('Request too large');}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return bytes;
}
async function proxyEngine(request:Request,context:RouteContext):Promise<Response>{
 const url=new URL(request.url),origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
 if((origin!==null&&origin!==url.origin)||(site!==null&&site!=='same-origin')||(request.method!=='GET'&&origin!==url.origin))return error(403,'같은 작업실에서 요청해 주세요.');
 const path=(await context.params)?.path;
 if(url.search||!Array.isArray(path)||path.some(part=>typeof part!=='string'))return error(400,'지원하지 않는 엔진 경로예요.');
 let actualPath:string[];
 try{actualPath=url.pathname.startsWith('/api/engine/')?url.pathname.slice('/api/engine/'.length).split('/').map(decodeURIComponent):[];}catch{return error(400,'지원하지 않는 엔진 경로예요.');}
 if(actualPath.length!==path.length||actualPath.some((part,index)=>part!==path[index]))return error(400,'지원하지 않는 엔진 경로예요.');
 const health=path.length===1&&path[0]==='health';
 const create=path.length===1&&path[0]==='jobs';
 const job=path.length===2&&path[0]==='jobs'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(path[1]);
 const textInventory=path.length===3&&path[0]==='jobs'&&IDENTIFIER.test(path[1])&&path[2]==='text-inventory';
 const batchCreate=path.length===1&&path[0]==='batches';
 const resolve=path.length===2&&path[0]==='batches'&&path[1]==='resolve';
 const batch=path.length===2&&path[0]==='batches'&&path[1]!=='resolve'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(path[1]);
 const priority=path.length===3&&path[0]==='projects'&&IDENTIFIER.test(path[1])&&path[2]==='priority';
 const projectContext=path.length===3&&path[0]==='projects'&&IDENTIFIER.test(path[1])&&path[2]==='context';
 const retry=path.length===3&&path[0]==='jobs'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(path[1])&&path[2]==='retry';
 const cancel=path.length===3&&path[0]==='jobs'&&IDENTIFIER.test(path[1])&&path[2]==='cancel';
 const review=path.length===2&&path[0]==='translation-reviews'&&path[1]==='stage14r3';
 const reviewApply=path.length===3&&path[0]==='translation-reviews'&&path[1]==='stage14r3'&&path[2]==='apply';
 const reviewPage=path.length===2&&path[0]==='translation-review-pages'&&/^[a-f0-9]{64}$/.test(path[1]);
 const inspectPage=path.length===3&&path[0]==='translation-review-pages'&&/^[a-f0-9]{64}$/.test(path[1])&&path[2]==='inspect-inputs';
 const imagePage=path[0]==='translation-review-pages'&&/^[a-f0-9]{64}$/.test(path[1]||'');
 const typesettingSource=imagePage&&path.length===3&&path[2]==='typesetting-source';
 const typesetting=imagePage&&['typesetting-preflight','typesetting-permits'].includes(path[2]);
 const imagePreflight=imagePage&&path.length===3&&['image-preflight','typesetting-preflight'].includes(path[2]);
 const imageApprove=imagePage&&path.length===3&&['image-permits','typesetting-permits'].includes(path[2]);
 const imagePermit=imagePage&&['image-permits','typesetting-permits'].includes(path[2])&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path[3]||'');
 const imageStatus=imagePermit&&path.length===4;
 const imageOperation=imagePermit&&path.length===5&&['execute','cancel'].includes(path[4]);
 const imageRoute=typesettingSource||imagePreflight||imageApprove||imageStatus||imageOperation;
 const layoutPage=imagePage&&path[2]==='layout-review'&&path.length===3;
 const layoutOperation=imagePage&&path[2]==='layout-review'&&path.length===4&&['validate','save','approve','compare'].includes(path[3]);
 const layoutReadability=imagePage&&path.length===3&&path[2]==='layout-readability';
 const layoutRoi=imagePage&&path.length===4&&path[2]==='layout-roi'&&['validate','approve-roi','save','approve-layout'].includes(path[3]);
 const layoutRoute=layoutPage||layoutOperation||layoutReadability||layoutRoi;
 if(!health&&!create&&!job&&!textInventory&&!batchCreate&&!batch&&!resolve&&!priority&&!retry&&!cancel&&!projectContext&&!review&&!reviewApply&&!reviewPage&&!inspectPage&&!imageRoute&&!layoutRoute)return error(400,'지원하지 않는 엔진 경로예요.');
 if(projectContext&&!['GET','POST'].includes(request.method))return error(405,'지원하지 않는 요청 방식이에요.','GET, POST');
 const method=projectContext?request.method:create||batchCreate||resolve||priority||retry||cancel||reviewApply||inspectPage||imagePreflight||imageApprove||imageOperation||layoutOperation||layoutRoi?'POST':'GET';
 if(request.method!==method)return error(405,'지원하지 않는 요청 방식이에요.',method);
 const upstream=await upstreamOrigin();
 if(!upstream)return error(503,'로컬 처리 엔진을 준비해 주세요.');
 const headers=new Headers({Accept:'application/json'});
 if(origin!==null)headers.set('Origin',origin);
 const cookie=request.headers.get('cookie');if(cookie)headers.set('Cookie',cookie);
 let body:ArrayBuffer|undefined;
 if(imageRoute||layoutRoute){const scope=request.headers.get('x-mangohana-review-scope');if(!scope||!/^[a-f0-9]{64}$/.test(scope))return error(400,'현재 검수 세션을 먼저 열어 주세요.');headers.set('X-Mangohana-Review-Scope',scope);}
 if(layoutRoi){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return error(400,'JSON 요청 형식을 확인해 주세요.');
  try{const bytes=await readBody(request,64*1024),v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),action=path[3],extra:Record<string,string[]>={validate:['choices'],'approve-roi':['choices','proposalSha256','standardReviewSha256','roiAcknowledged'],save:['receiptId','proposalSha256','saveAcknowledged'],'approve-layout':['planSha256','expectedStandardReviewSha256','reviewAcknowledged']},fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256','expectedLayoutRevision','requestKey',...extra[action]];
   if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k))||!['expectedEditRevision','expectedContextRevision','expectedLayoutRevision'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0)||!['eventSha256','selectedSetSha256'].every(k=>/^[a-f0-9]{64}$/.test(v[k]??''))||typeof v.requestKey!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(v.requestKey))return error(400,'현재 승인·revision 결속을 확인해 주세요.');
   if(action==='validate'||action==='approve-roi'){if(!Array.isArray(v.choices)||v.choices.length!==13||new Set(v.choices.map((c:{id:string})=>c?.id)).size!==13||v.choices.some((c:{id:string;kind:string})=>!c||Object.keys(c).length!==2||Object.keys(c).some(k=>!['id','kind'].includes(k))||typeof c.id!=='string'||!c.id.length||c.id.length>256||!['current','A','B','C'].includes(c.kind)))return error(400,'정확한 13개 후보를 선택해 주세요.');}
   const hashes=action==='approve-roi'?['proposalSha256','standardReviewSha256']:action==='save'?['receiptId','proposalSha256']:action==='approve-layout'?['planSha256','expectedStandardReviewSha256']:[];
   if(hashes.some(k=>!/^[a-f0-9]{64}$/.test(v[k]??''))||action==='approve-roi'&&v.roiAcknowledged!==true||action==='save'&&v.saveAcknowledged!==true||action==='approve-layout'&&v.reviewAcknowledged!==true)return error(400,'이 조합에 한정된 명시적 검토 동의가 필요합니다.');
   body=bytes.buffer as ArrayBuffer;headers.set('Content-Type','application/json');
  }catch(cause){return error(cause instanceof RangeError?413:400,'확장 후보 요청을 읽지 못했어요.');}
 }
 if(layoutOperation){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return error(400,'JSON 요청 형식을 확인해 주세요.');
  try{
   const bytes=await readBody(request,64*1024),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),approve=path[3]==='approve',compare=path[3]==='compare';
   const fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256','expectedLayoutRevision','requestKey',...(approve?['planSha256','reviewAcknowledged',...(Object.hasOwn(value??{},'expectedStandardReviewSha256')?['expectedStandardReviewSha256']:[])]:compare?['regionId',...(Object.hasOwn(value??{},'referenceEntry')?['referenceEntry']:[])]:['entries'])];
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k))||!['expectedEditRevision','expectedContextRevision','expectedLayoutRevision'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0)||!['eventSha256','selectedSetSha256'].every(k=>/^[a-f0-9]{64}$/.test(value[k]??''))||typeof value.requestKey!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestKey))return error(400,'배치 수정 revision을 확인해 주세요.');
   if(approve){if(value.reviewAcknowledged!==true||!/^[a-f0-9]{64}$/.test(value.planSha256??'')||Object.hasOwn(value,'expectedStandardReviewSha256')&&!/^[a-f0-9]{64}$/.test(value.expectedStandardReviewSha256??''))return error(400,'배치 검토 동의가 필요합니다.');}
   else if(compare){if(typeof value.regionId!=='string'||!value.regionId.length||value.regionId.length>256||/[\x00-\x1f\x7f]/.test(value.regionId))return error(400,'비교할 영역을 확인해 주세요.');if(Object.hasOwn(value,'referenceEntry')){const e=value.referenceEntry,keys=['id','bbox','fontSizePx','lineHeight','text'];if(!e||Object.keys(e).length!==keys.length||Object.keys(e).some(k=>!keys.includes(k))||e.id!==value.regionId||typeof e.text!=='string'||e.text.length>4000||!Number.isInteger(e.fontSizePx)||e.fontSizePx<=12||e.fontSizePx>256||!Number.isFinite(e.lineHeight)||e.lineHeight<1.25||e.lineHeight>3||!e.bbox||Object.keys(e.bbox).length!==4||!['x','y','width','height'].every(k=>Number.isFinite(e.bbox[k])))return error(400,'미저장 비교 기준을 확인해 주세요.');}}
   else{
    if(!Array.isArray(value.entries)||!value.entries.length||value.entries.length>128)return error(400,'배치 영역을 확인해 주세요.');
    for(const e of value.entries){const keys=['id','bbox','fontSizePx','lineHeight','text'];if(!e||Object.keys(e).length!==keys.length||Object.keys(e).some(k=>!keys.includes(k))||typeof e.id!=='string'||typeof e.text!=='string'||e.text.length>4000||!Number.isInteger(e.fontSizePx)||e.fontSizePx<=12||e.fontSizePx>256||!Number.isFinite(e.lineHeight)||e.lineHeight<1.25||e.lineHeight>3||!e.bbox||Object.keys(e.bbox).length!==4||!['x','y','width','height'].every(k=>Number.isFinite(e.bbox[k])))return error(400,'위치·크기·줄바꿈 수정값을 확인해 주세요.');}
   }
   body=bytes.buffer as ArrayBuffer;headers.set('Content-Type','application/json');
  }catch(cause){return error(cause instanceof RangeError?413:400,'배치 요청을 읽지 못했어요.');}
 }
 if(inspectPage||imagePreflight){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return error(400,'JSON 요청 형식을 확인해 주세요.');
  const scope=request.headers.get('x-mangohana-review-scope');if(!scope||!/^[a-f0-9]{64}$/.test(scope))return error(400,'현재 검수 세션을 먼저 열어 주세요.');
  try{
   const bytes=await readBody(request,JSON_LIMIT),value=JSON.parse(new TextDecoder().decode(bytes)),fields=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256'];
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4||Object.keys(value).some(k=>!fields.includes(k))||!Number.isSafeInteger(value.expectedEditRevision)||value.expectedEditRevision<0||!Number.isSafeInteger(value.expectedContextRevision)||value.expectedContextRevision<0||!['eventSha256','selectedSetSha256'].every(k=>typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k])))return error(400,'현재 저장 번역과 페이지 정보를 확인해 주세요.');
   body=bytes.buffer as ArrayBuffer;headers.set('Content-Type','application/json');headers.set('X-Mangohana-Review-Scope',scope);
  }catch(cause){return error(cause instanceof RangeError?413:400,'입력 점검 요청을 읽지 못했어요.');}
 }
 if(imageApprove||imageOperation){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return error(400,'JSON 요청 형식을 확인해 주세요.');
  try{const bytes=await readBody(request,8192),value=JSON.parse(new TextDecoder().decode(bytes)),fields=imageApprove?['permitId','proposalSha256','executionAcknowledged',...(typesetting?['cleanedReuseAcknowledged']:[])]:[];
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k))||imageApprove&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.permitId??'')||!/^[a-f0-9]{64}$/.test(value.proposalSha256??'')||value.executionAcknowledged!==true||typesetting&&value.cleanedReuseAcknowledged!==true))return error(400,'한 페이지·한 번 실행 승인 정보를 확인해 주세요.');
   body=bytes.buffer as ArrayBuffer;headers.set('Content-Type','application/json');
  }catch(cause){return error(cause instanceof RangeError?413:400,'이미지 실행 요청을 읽지 못했어요.');}
 }
 if(reviewApply){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return error(400,'JSON 요청 형식을 확인해 주세요.');
  const scope=request.headers.get('x-mangohana-review-scope');if(!scope||!/^[a-f0-9]{64}$/.test(scope))return error(400,'현재 검수 세션을 먼저 열어 주세요.');
  try{
   const bytes=await readBody(request,64*1024),value=JSON.parse(new TextDecoder().decode(bytes));
   const fields=['documentId','approvalToken','requestKey','expectedEditRevision','expectedContextRevision','sourceSha256','normalizedSha256','candidateSetSha256','selectedSetSha256','importAcknowledged','riskAcknowledged','regions'];
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||!Array.isArray(value.regions)||value.regions.length!==13||new Set(value.regions.map((r:{regionId?:unknown})=>r?.regionId)).size!==13||value.regions.some((r:{regionId?:unknown;selectedTranslation?:unknown})=>!r||Object.keys(r).length!==2||typeof r.regionId!=='string'||typeof r.selectedTranslation!=='string')||!Number.isSafeInteger(value.expectedEditRevision)||value.expectedEditRevision<0||!Number.isSafeInteger(value.expectedContextRevision)||value.expectedContextRevision<0)return error(400,'13개 선택과 현재 페이지 정보를 확인해 주세요.');
   body=bytes.buffer as ArrayBuffer;headers.set('Content-Type','application/json');headers.set('X-Mangohana-Review-Scope',scope);
  }catch(cause){return error(cause instanceof RangeError?413:400,'번역 적용 요청을 읽지 못했어요.');}
 }
 if(create||batchCreate){
  const contentType=request.headers.get('content-type')||'';
  if(!/^multipart\/form-data\s*;\s*boundary=(?:"[\x21-\x7e]{1,70}"|[^\s;"\x00-\x20\x7f]{1,70})\s*$/i.test(contentType))return error(400,'이미지 업로드 형식을 확인해 주세요.');
  try{
   const bytes=await readBody(request,batchCreate?BATCH_LIMIT:REQUEST_LIMIT);body=bytes.buffer as ArrayBuffer;
   const form=await new Request(url,{method:'POST',headers:{'Content-Type':contentType},body}).formData();
   if(batchCreate){
    const files=[...form.entries()].filter(([key])=>key==='file'||key==='files').map(([,value])=>value);
    if(!files.length||files.length>100||files.some(file=>!(file instanceof Blob)||!file.size))return error(400,'배치에 처리할 이미지를 선택해 주세요.');
    if(files.some(file=>{const value=file as File;return value.size>(/\.zip$/i.test(value.name)?80*1024*1024:IMAGE_LIMIT);})||files.reduce((sum,file)=>sum+(file as File).size,0)>160*1024*1024)return error(413,'배치 이미지의 크기를 확인해 주세요.');
    const fields=['source_language','target_language','project_id','idempotency_key','manifest','current_page_id'],required=fields.filter(field=>field!=='current_page_id');
    if([...form.keys()].some(key=>key!=='file'&&key!=='files'&&!fields.includes(key))||required.some(key=>form.getAll(key).length!==1||typeof form.get(key)!=='string')||form.getAll('current_page_id').length>1)return error(400,'배치 요청 정보를 확인해 주세요.');
    if(!IDENTIFIER.test(String(form.get('project_id')))||!['ja','auto'].includes(String(form.get('source_language')))||form.get('target_language')!=='ko'||!/^[A-Za-z0-9._:-]{1,200}$/.test(String(form.get('idempotency_key')))||(form.has('current_page_id')&&!IDENTIFIER.test(String(form.get('current_page_id')))))return error(400,'배치 식별자와 언어 정보를 확인해 주세요.');
    const raw=form.get('manifest');if(typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>64*1024)return error(400,'배치 페이지 연결 정보를 확인해 주세요.');
    let manifest;try{manifest=JSON.parse(raw);}catch{return error(400,'배치 페이지 연결 정보를 확인해 주세요.');}
    if(!Array.isArray(manifest)||!manifest.length||manifest.length>100||new Set(manifest.map(value=>value?.key)).size!==manifest.length||new Set(manifest.map(value=>value?.page_id)).size!==manifest.length||manifest.some(value=>!value||Object.keys(value).some(key=>!['key','page_id','page_number'].includes(key))||typeof value.key!=='string'||!value.key||value.key.length>1024||!IDENTIFIER.test(value.page_id)||(value.page_number!==undefined&&(!Number.isSafeInteger(value.page_number)||value.page_number<1||value.page_number>100000))))return error(400,'배치 페이지 연결 정보가 중복되거나 올바르지 않아요.');
    const hasZip=files.some(file=>/\.zip$/i.test((file as File).name));
    if(!hasZip&&(manifest.length!==files.length||manifest.some(value=>!/^file:\d+$/.test(value.key)||Number(value.key.slice(5))>=files.length)))return error(400,'파일과 페이지 연결 개수가 달라요.');
   }else{
   const files=form.getAll('file'),file=files[0];
   if(files.length!==1||!(file instanceof Blob)||file.size===0)return error(400,'이미지 한 장을 선택해 주세요.');
   if(file.size>IMAGE_LIMIT)return error(413,'이미지는 한 장당 8MiB까지 처리할 수 있어요.');
   const fields=['source_language','target_language','project_id','page_id','idempotency_key'];
   if([...form.keys()].some(key=>key!=='file'&&!fields.includes(key))||fields.some(key=>form.getAll(key).length!==1||typeof form.get(key)!=='string'||!(form.get(key) as string).length||(form.get(key) as string).length>200))return error(400,'처리 요청 정보를 확인해 주세요.');
   if(!/^[A-Za-z0-9._:-]{1,200}$/.test(form.get('idempotency_key') as string))return error(400,'처리 요청 식별자를 확인해 주세요.');
   }
   headers.set('Content-Type',contentType);
  }catch(cause){return cause instanceof RangeError?error(413,'이미지 업로드 크기를 확인해 주세요.'):error(400,'이미지 업로드를 읽지 못했어요.');}
 }
 if(resolve||priority||retry||cancel||projectContext&&method==='POST'){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return error(400,'JSON 요청 형식을 확인해 주세요.');
  try{
   const bytes=await readBody(request,JSON_LIMIT);let value;
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return error(400,'JSON 요청을 확인해 주세요.');}
   if(projectContext){
    const scopeId=request.headers.get('x-mangohana-context-scope');
    if(!scopeId||!(/^[a-f0-9]{64}$/.test(scopeId)))return error(400,'저장한 용어 요청의 브라우저 세션을 다시 확인해 주세요.');
    headers.set('X-Mangohana-Context-Scope',scopeId);
    const fields=['expected_revision','idempotency_key','changes'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||
      !Number.isSafeInteger(value.expected_revision)||value.expected_revision<0||typeof value.idempotency_key!=='string'||!/^[A-Za-z0-9._:-]{1,200}$/.test(value.idempotency_key)||
      !Array.isArray(value.changes)||!value.changes.length||value.changes.length>100)return error(400,'작품 용어 변경 내용을 확인해 주세요.');
    for(const change of value.changes){
     if(!change||typeof change!=='object'||Array.isArray(change)||typeof change.type!=='string')return error(400,'작품 용어 변경 내용을 확인해 주세요.');
     const kind=change.type.endsWith('_term')?'term':change.type.endsWith('_profile')?'profile':null;
     const keys=kind&&change.type==='upsert_'+kind?['type',kind]:kind&&change.type==='confirm_'+kind?['type','id','expectedEntryRevision']:[];
     if(!keys.length||Object.keys(change).length!==keys.length||Object.keys(change).some(key=>!keys.includes(key)))return error(400,'지원하는 용어 수정·확정 요청을 확인해 주세요.');
    }
   }else{
   const fields=cancel?[]:resolve?['project_id','idempotency_key']:priority?['page_id']:['idempotency_key'];
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>typeof value[key]!=='string'))return error(400,'지원하는 요청 필드를 확인해 주세요.');
   if((resolve&&!IDENTIFIER.test(value.project_id))||(priority&&!IDENTIFIER.test(value.page_id))||(!priority&&!cancel&&!/^[A-Za-z0-9._:-]{1,200}$/.test(value.idempotency_key)))return error(400,'요청 식별자를 확인해 주세요.');
   }
   body=bytes.buffer as ArrayBuffer;headers.set('Content-Type','application/json');
  }catch(cause){return cause instanceof RangeError?error(413,'JSON 요청 크기를 확인해 주세요.'):error(400,'JSON 요청을 읽지 못했어요.');}
 }
 try{
  const target=upstream+'/'+path.map(encodeURIComponent).join('/');
  const response=await fetch(target,{method,headers,body,redirect:'manual',signal:AbortSignal.any([request.signal,AbortSignal.timeout(inspectPage||typesettingSource||imagePreflight||imageApprove||imageOperation&&path[4]==='execute'?20*60*1000:health?8000:batchCreate?120000:create||retry?30000:15000)])});
  if(response.status>=300&&response.status<400){await response.body?.cancel();return error(502,'엔진이 지원하지 않는 경로를 응답했어요.');}
  const outgoing=new Headers({'Content-Type':response.headers.get('Content-Type')||'application/json','Cache-Control':'no-store'});
  for(const value of response.headers.getSetCookie())outgoing.append('Set-Cookie',value);
  return new Response(response.body,{status:response.status,headers:outgoing});
 }catch{return error(502,'로컬 처리 엔진에 연결하지 못했어요. 저장한 작업으로 다시 조회할 수 있어요.');}
}

export const dynamic='force-dynamic';
export const GET=proxyEngine;
export const POST=proxyEngine;
export const PUT=proxyEngine;
export const PATCH=proxyEngine;
export const DELETE=proxyEngine;
export const OPTIONS=proxyEngine;
export const HEAD=proxyEngine;
