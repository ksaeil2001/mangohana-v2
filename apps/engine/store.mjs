import { createHash, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, lstat, realpath, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reportToStudioResult } from './result.mjs';
import recoveryPolicy from '../../packages/ai-engine/quality/recovery-policy.cjs';
import pageReview from '../../packages/ai-engine/quality/page-review-state.cjs';
const {MAX_ATTEMPTS,classifyFailure}=recoveryPolicy;

export const JOB_LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, outputBytes: 32 * 1024 * 1024,
  reportBytes: 16 * 1024 * 1024, jobs: 200, side: 8000, pixels: 12_000_000 });
export const BATCH_LIMITS = Object.freeze({ pages: 100, bytes: 160 * 1024 * 1024, batches: 200 });
/** Aggregate a verified report's request evidence without counting shared region copies. */
export function usageFromReport(report,processingMs) {
  if(report?.recovery?.reusedStages?.includes('translation'))return {processingMs,localModelRequests:0,modelRequestMs:0,tokenUsage:null,
    engineMeasuredMs:Number.isFinite(report?.measurements?.elapsedMs)?report.measurements.elapsedMs:null,monetaryCost:null,reusedFromJobId:report.recovery.fromJobId};
  const translations=Array.isArray(report?.translations)?report.translations:[],requests=report?.translationRequests??[];
  const byRequest=new Map(),shared=new Set(),units=[];
  let ledgerKnown=Array.isArray(requests);
  if(ledgerKnown)for(const request of requests){
    if(request?.scope!=='page'||typeof request.requestId!=='string'||!request.requestId||byRequest.has(request.requestId)){ledgerKnown=false;break;}
    byRequest.set(request.requestId,request);
  }
  for(const record of translations){
    if(record?.requestScope==='page'){
      if(shared.has(record.requestId))continue;shared.add(record.requestId);
      const request=byRequest.get(record.requestId);
      if(!request){ledgerKnown=false;continue;}
      units.push({calls:request.transport==='onnx-cpu'?request.localGenerations:request.httpRequests,durationMs:request.durationMs,tokens:request.usage});
    }else if(record&&record.requestScope===undefined){
      // Legacy region reports prove calls and elapsed time, but have no token ledger contract.
      units.push({calls:record.modelHttpRequests,durationMs:record.durationMs,tokens:null});
    }else ledgerKnown=false;
  }
  if(byRequest.size!==shared.size)ledgerKnown=false;
  const count=value=>Number.isSafeInteger(value)&&value>=0,time=value=>Number.isFinite(value)&&value>=0;
  function sumKnown(read,valid){
    if(!ledgerKnown||!units.length)return null;
    let total=0;for(const unit of units){const value=read(unit);if(!valid(value)||!valid(total+=value))return null;}
    return total;
  }
  const tokenKeys=['prompt_tokens','completion_tokens','total_tokens'];
  const tokensKnown=ledgerKnown&&units.length>0&&units.every(({tokens})=>tokens&&tokenKeys.every(key=>count(tokens[key]))&&tokens.total_tokens===tokens.prompt_tokens+tokens.completion_tokens);
  let tokenUsage=null;
  if(tokensKnown){
    const totals=tokenKeys.map(key=>sumKnown(unit=>unit.tokens[key],count));
    if(totals.every(value=>value!==null))tokenUsage={promptTokens:totals[0],completionTokens:totals[1],totalTokens:totals[2]};
  }
  return {processingMs,localModelRequests:sumKnown(unit=>unit.calls,count),modelRequestMs:sumKnown(unit=>unit.durationMs,time),tokenUsage,
    engineMeasuredMs:Number.isFinite(report?.measurements?.elapsedMs)?report.measurements.elapsedMs:null,monetaryCost:null};
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const keyPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const requireValue = (condition, status, code, message) => { if (!condition) throw failure(status, code, message); };
const ownedRoots = new Set();
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sourceExtensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const pageNames=new Intl.Collator('en',{numeric:true,sensitivity:'variant'});
const requestNamespace=state=>state.requestNamespace??(state.batchId&&!state.retryOf?'batch-page':'public');
const requestKey=(owner,key,namespace='public')=>namespace+':'+owner+':'+key;
function compareProjectPages(a,b) {
  const first=a.state,second=b.state,firstNumbered=first.pageNumber!==undefined,secondNumbered=second.pageNumber!==undefined;
  // Known absolute numbers precede legacy pages; never mix number and sequence comparisons.
  if(firstNumbered!==secondNumbered)return firstNumbered?-1:1;
  return (firstNumbered?first.pageNumber-second.pageNumber:0)||first.sequence-second.sequence||
    (first.id<second.id?-1:first.id>second.id?1:0);
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw failure(422, 'INVALID_IMAGE', 'JPG, PNG, WebP 정지 이미지를 확인해 주세요.');
}
function validDimensions(size) {
  return size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0 &&
    size.width <= JOB_LIMITS.side && size.height <= JOB_LIMITS.side && size.width * size.height <= JOB_LIMITS.pixels;
}
async function regularDirectory(directory) {
  const info = await lstat(directory);
  requireValue(info.isDirectory() && !info.isSymbolicLink() && equalPath(await realpath(directory), directory), 503, 'STORE_UNAVAILABLE', '작업 저장소를 확인하지 못했습니다.');
}
async function boundedFile(file, maximum) {
  const before = await lstat(file);
  requireValue(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum && equalPath(await realpath(file), file), 502, 'OUTPUT_INVALID', '작업 파일의 무결성을 확인하지 못했습니다.');
  const handle = await open(file, 'r');
  try {
    const current = await handle.stat();
    requireValue(current.dev === before.dev && current.ino === before.ino && current.size === before.size, 502, 'OUTPUT_INVALID', '작업 파일이 변경되었습니다.');
    const bytes = await handle.readFile(); const after = await handle.stat(); const named = await lstat(file);
    requireValue(bytes.length === before.size && after.size === before.size && after.mtimeMs === current.mtimeMs &&
      !named.isSymbolicLink() && named.ino === current.ino && named.dev === current.dev, 502, 'OUTPUT_INVALID', '작업 파일이 변경되었습니다.');
    return bytes;
  } finally { await handle.close(); }
}
export async function atomicState(directory, value, fileName = 'state.json', beforeInstall) {
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  const destination = path.join(directory,fileName);
  if (!beforeInstall) return rename(temporary,destination);
  try {
    beforeInstall();
    renameSync(temporary,destination);
  } catch (error) {
    await rm(temporary, {force:true});
    throw error;
  }
}
/** Translation-only storage never enters the job queue or invokes engine.run. */
export async function createTranslationReviewStore(options) {
  const {createReviewStore} = await import('./translation-review-store.mjs');
  return createReviewStore(options);
}
export async function loadStage14ReviewCatalog(id) {
  const {loadSavedTranslationReview} = await import('./saved-translation-review.mjs');
  return loadSavedTranslationReview(id);
}
export async function createTranslationReviewApplication(options) {
  const {createReviewApplication} = await import('./translation-review-application.mjs');
  return createReviewApplication(options);
}
function publicJob(record) {
  const state = record.state;
  return { id: state.id, status: state.status, reviewState: pageReview.pageReviewState(state), stage: state.stage, progress: state.progress, message: state.message,
    fileName: state.name, width: state.width, height: state.height, projectId: state.projectId, pageId: state.pageId,
    sourceLanguage: state.sourceLanguage, sourceSha256: state.sourceSha256, createdAt: state.createdAt, updatedAt: state.updatedAt,
    pageNumber: state.pageNumber ?? null, batchId: state.batchId ?? null, retryOf: state.retryOf ?? null, usage: state.usage ?? null,
    error: state.error ?? null, errorCode: state.errorCode ?? null, warnings: [...(state.warnings ?? [])],
    processingGeneration:state.sequence,resultRevision:state.resultReceipt?.revision??null,candidateSha256:state.status==='completed'?state.resultReceipt?.candidateSha256??null:null,recovery:state.recovery??null,
    ...(state.stage15Attempts ? {stage15Attempts:structuredClone(state.stage15Attempts)} : {}),
    cancellation:state.cancelRequestedAt?{requestedAt:state.cancelRequestedAt,confirmedAt:state.cancelledAt??null}:null,
    reviewStatus: state.recovery?.type==='needs_review'?'needs_review':'unreviewed', downloadAvailable: state.status === 'completed' };
}
function validateStoredState(state, id) {
  requireValue(state && state.version === 1 && state.id === id && uuid.test(id) && typeof state.owner==='string'&&shaPattern.test(state.owner) && typeof state.idempotencyKey==='string'&&keyPattern.test(state.idempotencyKey) &&
    shaPattern.test(state.fingerprint) && shaPattern.test(state.sourceSha256) && ['queued', 'running', 'completed', 'failed','cancelled','result_unknown'].includes(state.status) &&
    (state.stage15 === undefined || state.stage15 === true) &&
    (state.status !== 'result_unknown' || state.stage15 === true || (state.errorCode==='RESULT_UNKNOWN'&&state.recovery?.manuallyRetryable===false)) &&
    ['ja', 'auto'].includes(state.sourceLanguage) && Object.hasOwn(sourceExtensions, state.mime) && validDimensions(state) &&
    [state.projectId,state.pageId].every(value=>value===null||typeof value==='string'&&idPattern.test(value)) &&
    Number.isSafeInteger(state.sequence) && state.sequence > 0 && typeof state.name === 'string' && state.name.length <= 180 &&
    Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)) &&
    (state.pageNumber === undefined || Number.isSafeInteger(state.pageNumber) && state.pageNumber > 0 && state.pageNumber <= 100000) &&
    (state.contextPageNumber === undefined || state.contextPageNumber===null || Number.isSafeInteger(state.contextPageNumber)&&state.contextPageNumber>0&&state.contextPageNumber<=100000) &&
    (state.batchId === undefined || uuid.test(state.batchId)) && (state.retryOf === undefined || uuid.test(state.retryOf)) &&
    (state.requestNamespace === undefined || ['public','batch-page'].includes(state.requestNamespace)) &&
    (state.retryJobId === undefined || uuid.test(state.retryJobId)), 503, 'STORE_CORRUPT', '이전 작업 기록을 확인하지 못했습니다.');
}

function preparedInput(input) {
  requireValue(input && typeof input.owner==='string'&&shaPattern.test(input.owner) && typeof input.idempotencyKey==='string'&&keyPattern.test(input.idempotencyKey), 422, 'INPUT_INVALID', '작업 요청 식별자를 확인해 주세요.');
  requireValue(Buffer.isBuffer(input.bytes) && input.bytes.length > 0 && input.bytes.length <= JOB_LIMITS.inputBytes, 413, 'INPUT_LIMIT', '이미지는 8MiB 이하로 올려 주세요.');
  requireValue(typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 180 && !/[\/\\\x00-\x1f\x7f]/.test(input.name) && !['.', '..'].includes(input.name), 422, 'NAME_INVALID', '파일 이름이 올바르지 않습니다.');
  const sourceLanguage = input.sourceLanguage ?? 'ja', projectId = input.projectId ?? null, pageId = input.pageId ?? null;
  requireValue(['ja', 'auto'].includes(sourceLanguage) && [projectId, pageId].every(value => value === null || typeof value === 'string' && idPattern.test(value)) &&
    (input.pageNumber === undefined || Number.isSafeInteger(input.pageNumber) && input.pageNumber > 0 && input.pageNumber <= 100000), 422, 'INPUT_INVALID', '지원하는 언어와 페이지 식별자를 확인해 주세요.');
  const bytes = Buffer.from(input.bytes), sourceSha256 = sha(bytes), mime = imageMime(bytes);
  const metadata = { owner: input.owner, idempotencyKey: input.idempotencyKey, name: input.name, projectId, pageId, sourceLanguage,
    ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }) };
  return { bytes, sourceSha256, mime, metadata, fingerprint: sha(JSON.stringify({ ...metadata, sourceSha256 })) };
}

function validateBatchState(state, id) {
  requireValue(state?.version === 1 && state.id === id && uuid.test(id) && typeof state.owner==='string'&&shaPattern.test(state.owner) && typeof state.idempotencyKey==='string'&&keyPattern.test(state.idempotencyKey) && shaPattern.test(state.fingerprint) &&
    typeof state.projectId==='string'&&idPattern.test(state.projectId) && ['ja', 'auto'].includes(state.sourceLanguage) && ['preparing', 'accepted', 'failed'].includes(state.status) &&
    (state.stage15ContextRevision === undefined || Number.isSafeInteger(state.stage15ContextRevision) && state.stage15ContextRevision >= 0) &&
    Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)) && Array.isArray(state.pages) && state.pages.length > 0 && state.pages.length <= BATCH_LIMITS.pages &&
    new Set(state.pages.map(page => page?.key)).size === state.pages.length && new Set(state.pages.map(page => page?.pageId)).size === state.pages.length &&
    state.pages.every(page => page&&typeof page.key === 'string' && page.key.length <= 400 && uuid.test(page.jobId) && typeof page.pageId==='string'&&idPattern.test(page.pageId) &&
      Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 && page.pageNumber <= 100000 && shaPattern.test(page.sourceSha256)),
    503, 'STORE_CORRUPT', '이전 배치 기록을 확인하지 못했습니다.');
  requireValue(state.priority===undefined||state.priority.owner===state.owner&&state.priority.projectId===state.projectId&&idPattern.test(state.priority.pageId)&&
    state.pages.some(page=>page.pageId===state.priority.pageId)&&Number.isFinite(Date.parse(state.priority.updatedAt)),503,'STORE_CORRUPT','배치 읽기 순서를 확인하지 못했습니다.');
}

/** Server-owned durable jobs. Queue entries contain metadata and disk paths, never upload buffers. */
export async function createJobStore({ root, engine, contextStore, stage15, readBatchUsage }) {
  requireValue(typeof root === 'string' && path.isAbsolute(root) && engine && ['health', 'inspectImage', 'run', 'close'].every(name => typeof engine[name] === 'function'), 503, 'STORE_CONFIG_INVALID', '작업 서버 설정을 확인해 주세요.');
  requireValue(contextStore===undefined||contextStore&&['get','apply','snapshot'].every(name=>typeof contextStore[name]==='function'),503,'STORE_CONFIG_INVALID','작품 문맥 저장소 설정을 확인해 주세요.');
  const directory = path.resolve(root), rootKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
  requireValue(directory !== path.parse(directory).root && !ownedRoots.has(rootKey), 503, 'STORE_IN_USE', '이미 사용 중인 작업 저장소입니다.');
  ownedRoots.add(rootKey);
  const records = new Map(), requests = new Map(), queue = [], batches = new Map(), batchRequests = new Map(), priorities = new Map();
  const batchDirectory = path.join(directory, 'batches');
  let sequence = 0, closed = false, runtimeBlocked=false, active = null, pending = null, wakeScheduled = false, closePromise, mutations = Promise.resolve();
  const serial = action => { const operation = mutations.then(action); mutations = operation.catch(() => {}); return operation; };
  const persist = record => { record.state.updatedAt = new Date().toISOString(); return atomicState(record.directory, record.state); };
  const persistBatch = record => { record.state.updatedAt = new Date().toISOString(); return atomicState(record.directory, record.state); };
  const priorityKey = (owner, projectId) => owner + ':' + projectId;
  function available(){requireValue(!runtimeBlocked,503,'RUNTIME_LEASE_BLOCKED','프로세스 정리를 확인하지 못해 새 작업을 차단했습니다.');requireValue(!closed,503,'SERVER_CLOSING','작업 서버가 종료 중입니다.');}
  function currentPage(record){const s=record.state;return !s.projectId||!s.pageId||![...records.values()].some(r=>r.state.owner===s.owner&&r.state.projectId===s.projectId&&r.state.pageId===s.pageId&&r.state.sequence>s.sequence&&committed(r));}
  function attempt(record){let count=1,seen=new Set();while(record.state.retryOf){requireValue(!seen.has(record.state.id),503,'STORE_CORRUPT','재시도 연결을 확인해 주세요.');seen.add(record.state.id);record=records.get(record.state.retryOf);requireValue(record,503,'STORE_CORRUPT','재시도 원본이 없습니다.');count++;}return count;}
  function rememberPriority(value) {
    const key = priorityKey(value.owner, value.projectId), current = priorities.get(key);
    if (!current || value.updatedAt >= current.updatedAt) priorities.set(key, value);
  }
  function latest(record) {
    const seen = new Set();
    while (record?.state.retryJobId) {
      requireValue(!seen.has(record.state.id), 503, 'STORE_CORRUPT', '재시도 연결을 확인하지 못했습니다.'); seen.add(record.state.id);
      const next = records.get(record.state.retryJobId);
      if (!next || next.state.owner !== record.state.owner || next.state.projectId !== record.state.projectId || next.state.pageId !== record.state.pageId ||
        next.state.retryOf !== record.state.id || next.state.sourceSha256 !== record.state.sourceSha256) break;
      record = next;
    }
    return record;
  }
  function committed(record, seen = new Set(), explicitRetry = false) {
    if (seen.has(record.state.id)) return false; seen.add(record.state.id);
    if (record.state.retryOf) {
      const previous = records.get(record.state.retryOf);
      return Boolean(previous && previous.state.owner === record.state.owner && previous.state.retryJobId === record.state.id &&
        previous.state.projectId === record.state.projectId && previous.state.pageId === record.state.pageId &&
        previous.state.sourceSha256 === record.state.sourceSha256 && committed(previous, seen, true));
    }
    if (!record.state.batchId) return true;
    const batch = batches.get(record.state.batchId)?.state;
    return explicitRetry || batch?.status === 'accepted' && batch.owner === record.state.owner && batch.pages.some(page => page.jobId === record.state.id);
  }
  function applyPriorities() {
    for (const priority of priorities.values()) {
      const indexes = [], items = [];
      queue.forEach((record, index) => { if (record.state.owner === priority.owner && record.state.projectId === priority.projectId) { indexes.push(index); items.push(record); } });
      const project = [...new Map([...records.values()].filter(record => record.state.owner === priority.owner && record.state.projectId === priority.projectId && committed(record))
        .map(record=>[record.state.pageId,latest(record)])).values()].sort(compareProjectPages);
      const start=project.findIndex(record=>record.state.pageId===priority.pageId),firstIds=start<0?[]:project.slice(start,start+3).map(record=>record.state.pageId);
      const rank=record=>firstIds.includes(record.state.pageId)?firstIds.indexOf(record.state.pageId):3;
      items.sort((a,b) => rank(a)-rank(b) || a.state.sequence-b.state.sequence);
      indexes.forEach((index, offset) => { queue[index] = items[offset]; });
    }
  }
  async function batchView(record) {
    const state = record.state;
    const pages = state.pages.map(page => {
      const job = latest(records.get(page.jobId));
      return { ...page, jobId: job?.state.id ?? page.jobId, job: job ? publicJob(job) : null,
        status: job?.state.status ?? 'failed', reviewState: job ? pageReview.pageReviewState(job.state) : 'FAILED',
        errorCode: job?.state.errorCode ?? (job ? null : 'BATCH_INCOMPLETE') };
    });
    const completedPages = pages.filter(page => page.status === 'completed').length, failedPages = pages.filter(page => ['failed','cancelled'].includes(page.status)).length;
    const unknownPages = pages.filter(page => page.status === 'result_unknown').length;
    const cancelledPages = pages.filter(page => page.status === 'cancelled').length;
    const status = state.status !== 'accepted' ? 'failed' : completedPages === pages.length ? 'completed'
      : unknownPages === pages.length ? 'result_unknown' : completedPages + failedPages + unknownPages === pages.length ? (completedPages || unknownPages ? 'partial' : 'failed')
      : pages.some(page => page.status === 'running') ? 'running' : 'queued';
    let accounting, usageErrorCode;
    if (state.stage15ContextRevision !== undefined) {
      // A corrupt or unavailable journal blocks accounting, not access to sibling job receipts.
      try { accounting = await readBatchUsage(state,pages); }
      catch { usageErrorCode = 'STAGE15_BATCH_EVIDENCE_UNAVAILABLE'; }
      for (const p of pages) {
        p.reused = Boolean(p.job && p.job.batchId !== state.id);
        p.providerUsage = p.reused ? null : accounting?.byJob.get(p.jobId) ?? null;
      }
    }
    return { id: state.id, projectId: state.projectId, sourceLanguage: state.sourceLanguage, status, totalPages: pages.length, completedPages, failedPages, unknownPages, cancelledPages,
      ...(state.stage15ContextRevision !== undefined ? {usage:accounting?.usage ?? null,...(usageErrorCode?{usageErrorCode}:{})} : {}),
      createdAt: state.createdAt, updatedAt: pages.reduce((latest,page)=>page.job?.updatedAt>latest?page.job.updatedAt:latest,state.updatedAt), ignoredFiles: state.ignoredFiles ?? [], pages };
  }
  function recordFor(prepared, dimensions, extra = {}) {
    const id = randomUUID(), now = new Date().toISOString();
    return { directory: path.join(directory,id), bytes: prepared.bytes, state: { version:1, id, ...prepared.metadata, requestNamespace:'public',sequence:++sequence,
      mime:prepared.mime, ...dimensions, sourceSha256:prepared.sourceSha256, fingerprint:prepared.fingerprint,
      status:'queued',stage:'queued',progress:0,message:'서버에서 처리를 기다리고 있습니다.',createdAt:now,updatedAt:now,warnings:[], ...extra } };
  }
  async function writeRecord(record) {
    await mkdir(record.directory,{mode:0o700});
    await writeFile(path.join(record.directory,'source'+sourceExtensions[record.state.mime]),record.bytes,{flag:'wx',mode:0o600});
    await persist(record); delete record.bytes;
  }
  function register(record) {
    const key=requestKey(record.state.owner,record.state.idempotencyKey,requestNamespace(record.state)),prior=requests.get(key);
    requireValue(!prior||prior.state.id===record.state.id,409,'IDEMPOTENCY_CONFLICT','이미 사용 중인 작업 요청 식별자입니다.');
    records.set(record.state.id,record);requests.set(key,record);
  }
  async function markRetryUnknown(record) {
    const files=await readdir(record.directory);
    record.state.retryExecutionObserved=record.state.retryExecutionObserved===true||record.state.status!=='queued'||record.state.progress>0||
      files.some(name=>['normalized.png','ocr.json','translations.json','progress.jsonl','candidate.png','report.json','engine-report.json'].includes(name));
    record.state.status='queued';record.state.stage='retry_acceptance_unknown';record.state.errorCode='RETRY_COMMIT_UNKNOWN';
    record.state.message=record.state.error='재시도 수락 여부를 확인하지 못했습니다. 기록을 보존하고 자동 실행하지 않습니다.';
    await persist(record);
  }
  async function admitRetry(record) {
    if(!committed(record)){
      const previous=records.get(record.state.retryOf);
      requireValue(previous&&previous.state.owner===record.state.owner&&previous.state.projectId===record.state.projectId&&previous.state.pageId===record.state.pageId&&
        previous.state.sourceSha256===record.state.sourceSha256&&(!previous.state.retryJobId||previous.state.retryJobId===record.state.id),409,'RETRY_CONFLICT','재시도 원본과 연결을 확인해 주세요.');
      const files=await readdir(record.directory);
      requireValue(record.state.status==='queued'&&record.state.progress===0&&record.state.retryExecutionObserved!==true&&
        !files.some(name=>['normalized.png','ocr.json','translations.json','progress.jsonl','candidate.png','report.json','engine-report.json'].includes(name)),503,'RETRY_COMMIT_UNKNOWN','이전 실행 여부가 불명확해 자동으로 다시 실행하지 않습니다.');
      for(const value of [previous,record]){
        const bytes=await boundedFile(path.join(value.directory,'source'+sourceExtensions[value.state.mime]),JOB_LIMITS.inputBytes);
        requireValue(sha(bytes)===record.state.sourceSha256,409,'SOURCE_INTEGRITY_FAILED','보존한 재시도 원본의 무결성이 맞지 않습니다.');
      }
      // The link is the admission commit. Never publish an unpersisted link in memory.
      const linked={directory:previous.directory,state:{...previous.state,retryJobId:record.state.id}};
      try{await persist(linked);previous.state=linked.state;}
      catch{
        try{await markRetryUnknown(record);}catch{}
        throw failure(503,'RETRY_COMMIT_UNKNOWN','재시도 수락 여부를 확인하지 못했습니다. 같은 요청 식별자로 기록을 확인해 주세요.');
      }
    }
    if(record.state.status==='queued'){
      record.state.stage='queued';record.state.message='서버에서 처리를 기다리고 있습니다.';delete record.state.error;delete record.state.errorCode;
      if(!queue.includes(record)&&active!==record)queue.push(record);applyPriorities();schedule();
    }
    return publicJob(record);
  }
  function owned(owner, id) {
    const record = records.get(id);
    requireValue(shaPattern.test(owner ?? '') && record?.state.owner === owner, 404, 'JOB_NOT_FOUND', '이 사용자에게 속한 작업을 찾을 수 없습니다.'); return record;
  }
  async function markFailed(record, code, message) {
    record.state.status = 'failed'; record.state.stage = 'failed'; record.state.errorCode = code; record.state.error = message;
    record.state.message = message; await persist(record);
  }
  async function inspect(bytes, mime, size) {
    const dimensions = await engine.inspectImage(bytes, mime);
    requireValue(validDimensions(dimensions) && (!size || dimensions.width === size.width && dimensions.height === size.height), 502, 'OUTPUT_INVALID', '이미지 크기와 실제 파일이 일치하지 않습니다.');
    return dimensions;
  }
  async function verify(record) {
    await regularDirectory(record.directory);
    const state = record.state;
    if (state.stage15 && !stage15) throw failure(503,'STAGE15_VERIFIER_UNAVAILABLE','이 번역의 서명을 검증할 host가 필요합니다.');
    const source = await boundedFile(path.join(record.directory, 'source' + sourceExtensions[state.mime]), JOB_LIMITS.inputBytes);
    requireValue(sha(source) === state.sourceSha256 && imageMime(source) === state.mime, 502, 'OUTPUT_INVALID', '원본 파일이 입력 기록과 일치하지 않습니다.');
    await inspect(source, state.mime, state);
    const reportBytes = await boundedFile(path.join(record.directory, 'report.json'), JOB_LIMITS.reportBytes);
    requireValue(sha(reportBytes) === state.reportSha256, 502, 'OUTPUT_INVALID', '실행 보고서가 저장 기록과 일치하지 않습니다.');
    const report = JSON.parse(reportBytes.toString('utf8'));
    if(state.contextSha256!==undefined){
      const bytes=await boundedFile(path.join(record.directory,'translation-context.json'),1024*1024);
      requireValue(shaPattern.test(state.contextSha256)&&sha(bytes)===state.contextSha256,502,'OUTPUT_INVALID','번역 문맥 파일이 실행 기록과 다릅니다.');
      const context=JSON.parse(bytes.toString('utf8')),receipt=report.translationContext;
      // Batch admission may assign a number to a legacy page after dispatch.
      // Keep the number actually used for context separate from its later order.
      const dispatchNumber=Object.hasOwn(state,'contextPageNumber')?state.contextPageNumber:context.pageNumber===null?null:state.pageNumber??null;
      requireValue(context.version===1&&context.owner===state.owner&&context.projectId===state.projectId&&context.sourceSha256===state.sourceSha256&&context.pageNumber===dispatchNumber&&
        receipt?.snapshotSha256===state.contextSha256&&receipt.glossaryRevision===context.glossaryRevision&&typeof receipt.consumed==='boolean',502,'OUTPUT_INVALID','실행 보고서와 저장한 번역 문맥이 일치하지 않습니다.');
      if(receipt.consumed)requireValue(Array.isArray(report.translationRequests)&&report.translationRequests.length>0&&report.translationRequests.every(request=>request.scope==='page'&&request.contextSnapshotSha256===state.contextSha256),502,'OUTPUT_INVALID','문맥을 사용한 페이지 요청의 증거가 없습니다.');
    }
    requireValue(report?.version === 1 && report.evidenceKind === 'LOCAL_ENGINE_CANDIDATE' && report.jobId === state.id && report.originalPreserved === true &&
      report.sourceLanguage === state.sourceLanguage && report.image?.width === state.width && report.image?.height === state.height && report.image?.originalMime === state.mime &&
      report.hashes && ['original', 'normalized', 'cleaned', 'candidate', 'mask'].every(key => shaPattern.test(report.hashes[key])) &&
      report.hashes.original === state.sourceSha256, 502, 'OUTPUT_INVALID', '원본과 작업에 대응하는 실행 증거가 없습니다.');
    if(state.resultReceipt!==undefined){const receipt=state.resultReceipt;requireValue(receipt?.jobId===state.id&&receipt.processingGeneration===state.sequence&&receipt.sourceSha256===state.sourceSha256&&
      receipt.reportSha256===state.reportSha256&&receipt.candidateSha256===report.hashes.candidate&&receipt.revision===1,502,'OUTPUT_INVALID','완료 영수증과 저장 결과가 다릅니다.');}
    for(const [stage,receipt]of Object.entries(state.checkpoints??{})){
      requireValue(['ocr','translation','cleaned'].includes(stage)&&receipt?.stage===stage&&shaPattern.test(receipt.sha256),502,'OUTPUT_INVALID','중간 결과 영수증이 올바르지 않습니다.');
      const bytes=await boundedFile(path.join(record.directory,'checkpoint-'+stage+'.json'),16*1024*1024),checkpoint=JSON.parse(bytes.toString('utf8'));
      requireValue(sha(bytes)===receipt.sha256&&checkpoint.version==='stage13-checkpoint-v1'&&checkpoint.jobId===state.id&&checkpoint.stage===stage&&checkpoint.scope?.ownerScope===state.owner&&
        checkpoint.scope.projectId===state.projectId&&checkpoint.scope.pageId===state.pageId&&checkpoint.scope.sourceSha256===state.sourceSha256&&checkpoint.scope.normalizedSha256===report.hashes.normalized,502,'OUTPUT_INVALID','중간 결과의 소유권·원본 또는 영수증이 다릅니다.');
    }
    if(report.recovery?.reusedStages?.includes('translation'))requireValue(state.retryOf===report.recovery.fromJobId&&state.checkpoints?.translation,502,'OUTPUT_INVALID','재사용한 번역의 실제 실행 출처를 확인하지 못했습니다.');
    const buffers = {};
    for (const [kind, file] of [['normalized', 'normalized.png'], ['cleaned', 'cleaned.png'], ['candidate', 'candidate.png'], ['mask', 'removal-mask.png']]) {
      const bytes = await boundedFile(path.join(record.directory, file), JOB_LIMITS.outputBytes);
      requireValue(imageMime(bytes) === 'image/png' && sha(bytes) === report.hashes[kind], 502, 'OUTPUT_INVALID', '실행 증거와 실제 결과 파일이 일치하지 않습니다.');
      await inspect(bytes, 'image/png', state); buffers[kind] = bytes;
    }
    // Hashes alone cannot establish that OCR, translation and actual font/layout
    // evidence describe the same regions. Apply the public result contract before
    // either publishing completion or restoring/serving a previously completed job.
    let result;
    try {
      requireValue(Boolean(report.stage15) === (state.stage15 === true), 502, 'OUTPUT_INVALID', '번역 실행 출처가 다릅니다.');
      const verifiedStage15 = state.stage15 ? stage15.verifyReport(report,state) : undefined;
      let verifiedOnnx;
      if(report.translationRequests?.some(r=>r.transport==='onnx-cpu')){
        const requestBytes=await boundedFile(path.join(record.directory,'onnx-request.json'),256*1024);
        const responseBytes=await boundedFile(path.join(record.directory,'onnx-response.json'),8*1024*1024);
        const request=JSON.parse(requestBytes),reply=JSON.parse(responseBytes);
        verifiedOnnx={requestSha256:sha(requestBytes),responseSha256:sha(responseBytes)};
        requireValue(reply.requestSha256===verifiedOnnx.requestSha256 && reply.data?.generation?.eos===true &&
          reply.data.revision===report.translationRequests[0].providerRevision &&
          request.lines.length===report.lines.length && reply.data.lines.length===report.lines.length &&
          report.lines.every((line,i)=>request.lines[i].id===line.id && request.lines[i].source===line.sourceText &&
            reply.data.lines[i].id===line.id && reply.data.lines[i].source===line.sourceText && reply.data.lines[i].ko===line.aiTranslation &&
            reply.data.lines[i].flags?.length===0),502,'OUTPUT_INVALID','ONNX 원문·번역·식자 대응이 다릅니다.');
      }
      result = reportToStudioResult(report, { cleanedPng: buffers.cleaned, candidatePng: buffers.candidate, verifiedStage15, verifiedOnnx });
    }
    catch (error) { if(error.code==='PARTIAL_TYPESETTING')throw error; throw failure(502, 'OUTPUT_INVALID', '대사·번역·식자의 영역과 글꼴 증거가 일치하지 않습니다.'); }
    return { report, result };
  }
  async function checkedCompletion(record) {
    try { return await verify(record); }
    catch (error) { if (error.code === 'STAGE15_VERIFIER_UNAVAILABLE') throw error;
      await serial(() => markFailed(record, 'INTEGRITY_FAILED', '저장한 결과의 무결성을 확인하지 못했습니다. 원본은 보존했습니다.'));
      throw failure(409, 'INTEGRITY_FAILED', '저장한 결과를 확인해 주세요.'); }
  }
  async function captureTranslationContext(record){
    const state=record.state,dispatchNumber=state.pageNumber??null;
    if(!contextStore||!state.projectId)return undefined;
    const saved=await contextStore.snapshot(state.owner,state.projectId),previousPages=[],previousContext=[],excludedPriorPages=[];
    // A page with two independent source/result histories or an ambiguous
    // absolute number supplies no narrative context until the user resolves it.
    const byPage=new Map();
    for(const candidate of records.values()){
      const value=candidate.state;
      if(value.retryOf||value.owner!==state.owner||value.projectId!==state.projectId||!value.pageId||value.pageId===state.pageId||!committed(candidate))continue;
      const entries=byPage.get(value.pageId)??[];entries.push(latest(candidate));byPage.set(value.pageId,entries);
    }
    const eligible=[...byPage.values()].filter(entries=>entries.length===1).map(entries=>entries[0]).filter(candidate=>candidate.state.status==='completed'&&
      dispatchNumber!==null&&candidate.state.pageNumber!==undefined&&candidate.state.pageNumber<dispatchNumber);
    const numberCounts=new Map();for(const candidate of eligible)numberCounts.set(candidate.state.pageNumber,(numberCounts.get(candidate.state.pageNumber)??0)+1);
    const prior=eligible.filter(candidate=>numberCounts.get(candidate.state.pageNumber)===1).sort(compareProjectPages).slice(-4);
    for(const candidate of prior){
      let verified;
      try{
        verified=state.stage15 ? await verify(candidate) : await checkedCompletion(candidate);
        if(state.stage15){
          requireValue(verified.report.stage15?.binding.contextRevision===saved.glossaryRevision,409,'CONTEXT_REEVALUATION_REQUIRED','이전 페이지의 번역 문맥이 다릅니다.');
          stage15.assertApplicable(verified.report.stage15);
        }
      }catch(error){excludedPriorPages.push({jobId:candidate.state.id,reason:error.code ?? 'INTEGRITY_FAILED'});continue;}
      const value=candidate.state;
      previousPages.push({jobId:value.id,pageId:value.pageId,pageNumber:value.pageNumber,sourceSha256:value.sourceSha256,reportSha256:value.reportSha256,status:'AI_PROPOSED'});
      for(const line of [...verified.report.lines].sort((a,b)=>(a.order??0)-(b.order??0))){
        if(typeof line.sourceText!=='string'||typeof line.aiTranslation!=='string'||!line.sourceText.trim()||!line.aiTranslation.trim())continue;
        previousContext.push({source:line.sourceText.slice(0,500),translation:line.aiTranslation.slice(0,700),status:'AI_PROPOSED',sourceJobId:value.id,regionId:line.id,pageId:value.pageId,pageNumber:value.pageNumber,owner:state.owner,projectId:state.projectId,sourceSha256:value.sourceSha256,reportSha256:value.reportSha256});
      }
    }
    const conditional=term=>term.condition&&Object.keys(term.condition).length>0;
    const context={version:1,contextPolicyVersion:'stage11-context-v1',owner:state.owner,projectId:state.projectId,pageId:state.pageId,pageNumber:dispatchNumber,sourceSha256:state.sourceSha256,
      glossaryRevision:saved.glossaryRevision,glossaryContentSha256:saved.contentSha256,glossary:saved.terms.filter(term=>!conditional(term)),
      conditionalGlossary:saved.terms.filter(conditional),profiles:saved.profiles??[],
      deferredConditionalTermIds:saved.terms.filter(conditional).map(term=>term.id),previousPages,previousContext:previousContext.slice(-200),excludedPriorPages};
    const bytes=Buffer.from(JSON.stringify(context));
    requireValue(bytes.length<=1024*1024,413,'CONTEXT_LIMIT','번역 문맥의 크기를 확인해 주세요.');
    await writeFile(path.join(record.directory,'translation-context.json'),bytes,{flag:'wx',mode:0o600});
    state.contextSha256=sha(bytes);state.contextPageNumber=dispatchNumber;await serial(()=>persist(record));
    return {...context,snapshotSha256:state.contextSha256};
  }
  async function execute(record) {
    const state = record.state, controller = new AbortController(); record.controller = controller;
    const started = performance.now();
    try {
      const inputPath = path.join(record.directory, 'source' + sourceExtensions[state.mime]);
      requireValue(sha(await boundedFile(inputPath, JOB_LIMITS.inputBytes)) === state.sourceSha256, 502, 'OUTPUT_INVALID', '원본 파일이 입력 기록과 다릅니다.');
      const translationContext=await captureTranslationContext(record);controller.signal.throwIfAborted();
      const previous=state.retryOf?records.get(state.retryOf):undefined;
      let assertPublication;
      const isCurrent = () => !closed && record.state === state && state.status === 'running' && !state.cancelRequestedAt && currentPage(record);
      const withFence = install => contextStore.withRevision(state.owner,state.projectId,translationContext.glossaryRevision,async () => {
        requireValue(isCurrent() && sha(await boundedFile(inputPath,JOB_LIMITS.inputBytes)) === state.sourceSha256,
          409, 'STALE_RESULT', '원본 또는 현재 페이지가 변경되었습니다.');
        return install();
      });
      const batch = state.batchId ? batches.get(state.batchId)?.state : null;
      if (state.stage15 || stage15) {
        requireValue(stage15 && state.stage15 && !previous && translationContext && state.pageId && state.pageNumber,
          409,'STAGE15_ADMISSION_DENIED','승인된 페이지 번역 범위를 확인해 주세요.');
        if (state.batchId) requireValue(batch?.status === 'accepted' && batch.owner === state.owner && batch.projectId === state.projectId &&
          batch.stage15ContextRevision === translationContext.glossaryRevision && batch.pages.some(p => p.jobId === state.id &&
            p.pageId === state.pageId && p.pageNumber === state.pageNumber && p.sourceSha256 === state.sourceSha256),
          409,'STALE_RESULT','접수한 배치의 페이지 또는 작품 문맥이 변경되었습니다.');
      }
      const value = await engine.run({ jobId: state.id, inputPath, outputDirectory: record.directory, sourceLanguage: state.sourceLanguage,
        ...(state.stage15 ? {translateStage:(stage,timeoutMs) => stage15.translate({scope:{ownerScope:{kind:'session',id:state.owner}, projectId:state.projectId,
          pageId:state.pageId,pageNumber:state.pageNumber,requestId:state.id,generation:state.sequence,editRevision:0,layoutRevision:0,
          contextRevision:translationContext.glossaryRevision,sourceSha256:state.sourceSha256,mode:'FULL_IMAGE',
          ...(batch ? {batchId:batch.id,batchManifestSha256:batch.fingerprint} : {})}, signal:controller.signal, timeoutMs,
          isCurrent, withFence, knownBatchAttempts:()=>batch?.pages.flatMap(p=>{
            const peer=records.get(p.jobId)?.state;
            return peer?.batchId===batch.id ? peer.stage15Attempts ?? [] : [];
          }) ?? [], onPublication:assertCurrent => { assertPublication = assertCurrent; },
          onObservation:attempts => serial(async () => {
            state.stage15Attempts = attempts;
            try { await persist(record); } catch { throw failure(503,'RESULT_UNKNOWN','번역 시도 기록의 저장 여부가 미확정입니다.'); }
          })},stage)} : {}),
        ...(previous?.state.checkpoints?{resumeFrom:{directory:previous.directory,jobId:previous.state.id,checkpoints:structuredClone(previous.state.checkpoints)}}:{}),
        onCheckpoint:receipt=>serial(async()=>{
          controller.signal.throwIfAborted();requireValue(record.state===state&&state.status==='running'&&['ocr','translation','cleaned'].includes(receipt?.stage)&&shaPattern.test(receipt.sha256),502,'OUTPUT_INVALID','중간 결과 영수증을 확인하지 못했습니다.');
          state.checkpoints={...state.checkpoints,[receipt.stage]:structuredClone(receipt)};await persist(record);
        }),
        ...(translationContext?{translationContext}:{}),
        projectId: state.projectId, pageId: state.pageId, pageNumber: translationContext?translationContext.pageNumber:state.pageNumber ?? null, ownerScope: state.owner, signal: controller.signal,
        onProgress: update => serial(async () => {
          if (closed || controller.signal.aborted || record.state!==state || state.status !== 'running' || state.cancelRequestedAt) return;
          requireValue(update && typeof update.stage === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(update.stage) && Number.isFinite(update.progress), 502, 'PROGRESS_INVALID', '진행 상태가 올바르지 않습니다.');
          state.stage = update.stage; state.progress = Math.max(state.progress, Math.min(99, Math.max(0, update.progress)));
          state.message = typeof update.message === 'string' ? update.message.slice(0, 300) : '페이지를 처리하고 있습니다.'; await persist(record);
        }) });
      controller.signal.throwIfAborted();
      requireValue(Buffer.isBuffer(value?.pngBytes) && value.pngBytes.length > 0 && value.pngBytes.length <= JOB_LIMITS.outputBytes && value.report,
        502, 'OUTPUT_INVALID', '처리 결과와 실행 보고서를 확인하지 못했습니다.');
      if(translationContext){
        let latestRevision=null;try{latestRevision=(await contextStore.snapshot(state.owner,state.projectId)).glossaryRevision;}catch{/* An unknown revision remains unknown, never a silent match. */}
        value.report=structuredClone(value.report);
        value.report.translationContextRevalidation={status:latestRevision===null?'CONTEXT_FRESHNESS_UNKNOWN':latestRevision===translationContext.glossaryRevision?'CONTEXT_REVISION_UNCHANGED':'CONTEXT_REEVALUATION_REQUIRED',consumedRevision:translationContext.glossaryRevision,latestRevisionAtCompletion:latestRevision,automaticRetry:false};
        if(latestRevision!==translationContext.glossaryRevision)value.report.warnings=[...(value.report.warnings??[]),'번역 중 작품 문맥이 바뀌었거나 최신 상태를 확인하지 못했습니다. 기존 문맥 후보를 보존했으며 새 문맥의 재검토가 필요합니다.'];
      }
      const reportBytes = Buffer.from(JSON.stringify(value.report));
      requireValue(reportBytes.length <= JOB_LIMITS.reportBytes, 502, 'OUTPUT_INVALID', '실행 보고서의 크기가 제한을 초과했습니다.');
      await writeFile(path.join(record.directory, 'candidate.png'), value.pngBytes, { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(record.directory, 'report.json'), reportBytes, { flag: 'wx', mode: 0o600 });
      state.reportSha256 = sha(reportBytes);
      const verified = await verify(record); controller.signal.throwIfAborted();
      await serial(async () => {
        controller.signal.throwIfAborted();requireValue(record.state===state&&state.status==='running'&&!state.cancelRequestedAt,409,'STALE_RESULT','이전 작업의 완료 요청입니다.');
        const next={...state,status:'completed',stage:'completed',progress:100,message:'미검수 자동 처리 후보를 준비했습니다.',
          usage:usageFromReport(verified.report,Math.round(performance.now()-started)),
          warnings:Array.isArray(verified.report.warnings)?verified.report.warnings.filter(v=>typeof v==='string').slice(0,50).map(v=>v.slice(0,300)):[],
          resultReceipt:{revision:1,jobId:state.id,processingGeneration:state.sequence,sourceSha256:state.sourceSha256,reportSha256:state.reportSha256,candidateSha256:verified.report.hashes.candidate}};
        if (state.stage15) {
          requireValue(typeof assertPublication === 'function', 409, 'STALE_RESULT', '번역 게시 근거를 확인하지 못했습니다.');
          next.updatedAt = new Date().toISOString();
          await withFence(() => atomicState(record.directory,next,'state.json',assertPublication));
        } else await persist({directory:record.directory,state:next});
        record.state=next;
      });
    } catch (error) {
      state.usage = { processingMs: Math.round(performance.now()-started), localModelRequests:null, modelRequestMs:null, tokenUsage:null, engineMeasuredMs:null, monetaryCost:null };
      await serial(async()=>{
        if (error.code === 'RESULT_UNKNOWN') {
          Object.assign(state,{status:'result_unknown',stage:'result_unknown',errorCode:'RESULT_UNKNOWN',message:'번역 실행 결과 또는 정산을 확인하지 못했습니다.',
            recovery:{code:'RESULT_UNKNOWN',type:'unsafe_to_repeat',automaticRetry:false,manuallyRetryable:false,monetaryCost:null}});
          if (state.batchId && state.stage15Attempts?.some(a=>a.resourceReleaseUnconfirmed)) {
            state.recovery.type='cleanup_unknown';state.stage='cleanup_unconfirmed';runtimeBlocked=true;
          }
          await persist(record);return;
        }
        const recovery=classifyFailure(error);
        if (state.stage15 && recovery.code === 'PROCESSING_FAILED' && /^STAGE15_|^(AUTHORITY_MISMATCH|AUTHORITY_EXPIRED|PROVIDER_PIN_MISMATCH|FALLBACK_CONSUMED|FALLBACK_INELIGIBLE|REVIEW_REVISION_CONFLICT)$/.test(error.code)) {
          Object.assign(recovery,{code:error.code,manuallyRetryable:false});
        }
        record.state.recovery={...recovery,attempt:attempt(record),failedStage:state.stage};
        if(recovery.type==='cleanup_unknown')runtimeBlocked=true;
        if((state.cancelRequestedAt || (state.stage15 && error.code === 'CANCELLED')) && recovery.type!=='cleanup_unknown'){
          record.state.recovery={...classifyFailure({code:'CANCELLED'}),attempt:attempt(record),failedStage:state.stage};
          record.state.status='cancelled';record.state.stage='cancelled';record.state.cancelledAt=new Date().toISOString();record.state.errorCode='CANCELLED';record.state.message='작업 중단과 자원 반환을 확인했습니다.';await persist(record);
        }else{
          const code=controller.signal.aborted&&recovery.type!=='cleanup_unknown'?'INTERRUPTED':recovery.code;
          await markFailed(record,code,'처리를 완료하지 못했습니다. 원본과 실행 기록은 보존했으며 자동으로 다시 실행하지 않습니다.');
          record.state.stage=recovery.stage;await persist(record);
        }
      });
    } finally { delete record.controller; }
  }
  function schedule() {
    if (closed || runtimeBlocked || pending || wakeScheduled || !queue.length) return;
    wakeScheduled = true;
    setImmediate(() => {
      wakeScheduled = false; if (closed || runtimeBlocked || pending) return;
      pending = (async () => {
        while (!closed && !runtimeBlocked && queue.length) {
          const record = await serial(async () => {
            if (closed) return null;
            const next = queue.shift(); if (!next || next.state.status !== 'queued') return null;
            active = next; next.state.status = 'running'; next.state.stage = 'preparing'; await persist(next); return next;
          });
          if (record) { try { await execute(record); } finally { active = null; } }
        }
      })().catch(() => { closed = true; }).finally(() => { pending = null; schedule(); });
    });
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await regularDirectory(directory);
    let batchEntries=[];
    try{await regularDirectory(batchDirectory);batchEntries=await readdir(batchDirectory,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    for (const entry of batchEntries) {
      if (!uuid.test(entry.name)) continue;
      requireValue(entry.isDirectory()&&!entry.isSymbolicLink(),503,'STORE_CORRUPT','배치 저장소를 확인하지 못했습니다.');
      const location=path.join(batchDirectory,entry.name);await regularDirectory(location);
      let state;try{state=JSON.parse((await boundedFile(path.join(location,'state.json'),256*1024)).toString('utf8'));}
      catch(error){if(error.code==='ENOENT')continue;throw failure(503,'STORE_CORRUPT','배치 기록을 읽지 못했습니다.');}
      validateBatchState(state,entry.name);const key=state.owner+':'+state.idempotencyKey;
      requireValue(!batchRequests.has(key)&&batches.size<BATCH_LIMITS.batches,503,'STORE_CORRUPT','배치 요청 기록이 중복되거나 한도를 초과했습니다.');
      const record={directory:location,state};batches.set(state.id,record);batchRequests.set(key,record);
      if(state.priority)rememberPriority(state.priority);
    }
    try {
      const saved=JSON.parse((await boundedFile(path.join(directory,'reading-priorities.json'),256*1024)).toString('utf8'));
      requireValue(saved.version===1&&Array.isArray(saved.entries)&&saved.entries.length<=JOB_LIMITS.jobs,503,'STORE_CORRUPT','읽기 순서를 확인하지 못했습니다.');
      for(const entry of saved.entries){requireValue(shaPattern.test(entry.owner)&&idPattern.test(entry.projectId)&&idPattern.test(entry.pageId)&&Number.isFinite(Date.parse(entry.updatedAt)),503,'STORE_CORRUPT','읽기 순서를 확인하지 못했습니다.');rememberPriority(entry);}
    }catch(error){if(error.code!=='ENOENT')throw error;}
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!uuid.test(entry.name)) continue;
      requireValue(entry.isDirectory() && !entry.isSymbolicLink(), 503, 'STORE_CORRUPT', '작업 디렉터리를 확인하지 못했습니다.');
      const jobDirectory = path.join(directory, entry.name); await regularDirectory(jobDirectory);
      let state;
      try { state = JSON.parse((await boundedFile(path.join(jobDirectory, 'state.json'), 128 * 1024)).toString('utf8')); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw failure(503, 'STORE_CORRUPT', '이전 작업 기록을 확인하지 못했습니다.'); }
      validateStoredState(state, entry.name);
      const key = requestKey(state.owner,state.idempotencyKey,requestNamespace(state));
      requireValue(!requests.has(key) && records.size < JOB_LIMITS.jobs, 503, 'STORE_CORRUPT', '중복되거나 초과된 작업 기록을 확인해 주세요.');
      const record = { state, directory: jobDirectory }; records.set(state.id, record); requests.set(key, record); sequence = Math.max(sequence, state.sequence);
    }
    for(const batch of batches.values()){
      let missing=false;
      for(const page of batch.state.pages){
        const record=records.get(page.jobId);if(!record){missing=true;continue;}
        requireValue(record.state.owner===batch.state.owner&&record.state.projectId===batch.state.projectId&&record.state.pageId===page.pageId&&record.state.sourceSha256===page.sourceSha256&&
          (record.state.pageNumber===undefined||record.state.pageNumber===page.pageNumber),503,'STORE_CORRUPT','배치와 페이지 소유권 또는 원본 연결이 다릅니다.');
      }
      if(missing&&batch.state.status==='accepted'){batch.state.status='failed';await persistBatch(batch);}
    }
    for(const record of records.values()){
      const state=record.state;
      if(state.recovery?.type==='cleanup_unknown')runtimeBlocked=true;
      if(!committed(record)){
        if(state.retryOf)await markRetryUnknown(record);
        else await markFailed(record,'BATCH_INCOMPLETE','배치 수락이 완료되지 않았습니다. 원본을 보존하고 자동 실행하지 않습니다.');
        continue;
      }
      if(state.status==='queued'&&state.stage==='retry_acceptance_unknown'){state.stage='queued';state.message='서버에서 처리를 기다리고 있습니다.';delete state.error;delete state.errorCode;}
      if(state.status==='running'){
        if(state.stage15){
          Object.assign(state,{status:'result_unknown',stage:'cleanup_unconfirmed',errorCode:'RESULT_UNKNOWN',message:'중단된 번역 시도의 실행 결과와 정리를 확인하지 못했습니다.',
            recovery:{...classifyFailure({code:'CLEANUP_FAILED'}),code:'RESULT_UNKNOWN'}});
          runtimeBlocked=true;await persist(record);
        } else if(state.cancelRequestedAt){state.recovery=classifyFailure({code:'CLEANUP_FAILED'});state.stage='cleanup_unconfirmed';state.status='failed';state.errorCode='CLEANUP_FAILED';runtimeBlocked=true;await persist(record);}
        else {state.recovery=classifyFailure({code:'CLEANUP_FAILED'});runtimeBlocked=true;await markFailed(record,'INTERRUPTED','서버 재시작으로 이전 실행과 자원 정리를 확인하지 못했습니다. 자동으로 다시 실행하지 않습니다.');state.stage='cleanup_unconfirmed';await persist(record);}
      }
      if(state.status==='completed'){try{await verify(record);}catch(error){if(error.code!=='STAGE15_VERIFIER_UNAVAILABLE')await markFailed(record,'INTEGRITY_FAILED','저장한 결과의 무결성을 확인하지 못했습니다. 원본은 보존했습니다.');}}
      if(state.status==='queued')queue.push(record);
    }
    for(const record of batches.values())if(record.state.status==='preparing'){record.state.status='failed';await persistBatch(record);}
    queue.sort((a, b) => a.state.sequence - b.state.sequence); applyPriorities(); schedule();
  } catch (error) { ownedRoots.delete(rootKey); throw error; }
  return Object.freeze({
    async health() {
      let raw; try { raw = await engine.health(); } catch { raw = { ready: false }; }
      return { ready: !closed && !runtimeBlocked && (raw.ready === true || Boolean(active)), engineReady: !closed && !runtimeBlocked && raw.ready === true, running: Boolean(active), queued: queue.length,
        ...(['native','onnx-cpu'].includes(raw.providerProfile)?{providerProfile:raw.providerProfile,modelLoading:raw.modelLoading}:{}),
        savedContextSupported:!closed&&raw.savedContextSupported===true };
    },
    async submit(input) {
      const prepared=preparedInput(input),{metadata,fingerprint,bytes,mime}=prepared;
      return serial(async () => {
        available();
        const key = requestKey(metadata.owner,metadata.idempotencyKey), prior = requests.get(key);
        if (prior) { requireValue(prior.state.fingerprint === fingerprint, 409, 'IDEMPOTENCY_CONFLICT', '같은 작업 요청의 입력이 변경되었습니다.'); return publicJob(prior); }
        if(metadata.projectId&&metadata.pageId){
          const unresolved=[...records.values()].find(({state})=>state.owner===metadata.owner&&state.projectId===metadata.projectId&&
            state.pageId===metadata.pageId&&pageReview.pageReviewState(state)==='RESULT_UNKNOWN');
          if(unresolved){
            requireValue(unresolved.state.sourceSha256===prepared.sourceSha256&&unresolved.state.sourceLanguage===metadata.sourceLanguage,409,'PAGE_SOURCE_CONFLICT','미확정 페이지의 입력이 달라졌습니다.');
            return publicJob(unresolved);
          }
        }
        requireValue(records.size < JOB_LIMITS.jobs, 429, 'JOB_LIMIT', '보관할 수 있는 작업 수를 초과했습니다.');
        let dimensions; try { dimensions = await inspect(bytes, mime); } catch { throw failure(422, 'INVALID_IMAGE', '이미지 파일의 완전성과 크기를 확인해 주세요.'); }
        const record=recordFor(prepared,dimensions,stage15?{stage15:true}:{});await writeRecord(record);register(record);queue.push(record);applyPriorities();schedule();return publicJob(record);
      });
    },
    async submitBatch(input) {
      requireValue(input&&typeof input.owner==='string'&&shaPattern.test(input.owner)&&typeof input.idempotencyKey==='string'&&keyPattern.test(input.idempotencyKey)&&typeof input.projectId==='string'&&idPattern.test(input.projectId)&&['ja','auto'].includes(input.sourceLanguage??'ja'),422,'INPUT_INVALID','배치 요청 식별자와 작품을 확인해 주세요.');
      requireValue(Array.isArray(input.pages)&&input.pages.length>0&&input.pages.length<=BATCH_LIMITS.pages,413,'BATCH_PAGE_LIMIT','배치는 1~100페이지까지 지원합니다.');
      requireValue(input.pages.reduce((sum,page)=>sum+(Buffer.isBuffer(page?.bytes)?page.bytes.length:BATCH_LIMITS.bytes+1),0)<=BATCH_LIMITS.bytes,413,'BATCH_BYTE_LIMIT','배치 이미지 총용량은 160MiB까지 지원합니다.');
      const owner=input.owner,projectId=input.projectId,sourceLanguage=input.sourceLanguage??'ja';
      const keys=new Set(),pageIds=new Set(),numbers=new Set();
      const prepared=input.pages.map((page,index)=>{
        requireValue(page&&typeof page==='object'&&!Array.isArray(page),422,'BATCH_MANIFEST_INVALID','배치 페이지 정보를 확인해 주세요.');
        const key=page.key??'file:'+index;
        requireValue(typeof key==='string'&&key.length>0&&key.length<=400&&!/[\x00-\x1f\x7f]/.test(key)&&!keys.has(key),422,'BATCH_MANIFEST_INVALID','배치 파일 식별자가 없거나 중복됩니다.');keys.add(key);
        requireValue(page.pageId===undefined||idPattern.test(page.pageId)&&!pageIds.has(page.pageId),422,'BATCH_MANIFEST_INVALID','페이지 식별자가 중복됩니다.');if(page.pageId!==undefined)pageIds.add(page.pageId);
        requireValue(page.pageNumber===undefined||Number.isSafeInteger(page.pageNumber)&&page.pageNumber>0&&page.pageNumber<=100000&&!numbers.has(page.pageNumber),422,'BATCH_MANIFEST_INVALID','페이지 순서가 중복되거나 올바르지 않습니다.');if(page.pageNumber!==undefined)numbers.add(page.pageNumber);
        return {key,requestedPageId:page.pageId,requestedPageNumber:page.pageNumber,...preparedInput({owner,projectId,sourceLanguage,name:page.name,bytes:page.bytes,pageId:page.pageId,pageNumber:page.pageNumber,idempotencyKey:'batch:'+sha(input.idempotencyKey+'\0'+key)})};
      });
      const absoluteOrder=prepared.every(page=>page.requestedPageNumber!==undefined);
      prepared.sort((a,b)=>absoluteOrder?a.requestedPageNumber-b.requestedPageNumber:pageNames.compare(a.metadata.name,b.metadata.name));
      requireValue(input.currentPageId===undefined||idPattern.test(input.currentPageId)&&pageIds.has(input.currentPageId),422,'BATCH_MANIFEST_INVALID','현재 읽는 페이지가 배치에 없습니다.');
      const fingerprint=sha(JSON.stringify({owner,idempotencyKey:input.idempotencyKey,projectId,sourceLanguage,
        pages:prepared.map(page=>({key:page.key,name:page.metadata.name,pageId:page.requestedPageId??null,pageNumber:page.requestedPageNumber??null,sourceSha256:page.sourceSha256}))}));
      return serial(async()=>{
        const key=owner+':'+input.idempotencyKey,prior=batchRequests.get(key);
        if(prior){requireValue(prior.state.fingerprint===fingerprint,409,'IDEMPOTENCY_CONFLICT','같은 배치 요청의 입력이 변경되었습니다.');return batchView(prior);}
        available();
        requireValue(batches.size<BATCH_LIMITS.batches,429,'BATCH_LIMIT','보관할 수 있는 배치 수를 초과했습니다.');
        // Decode every page before persisting or admitting any new work.
        for(const page of prepared){try{page.dimensions=await inspect(page.bytes,page.mime);}catch{throw failure(422,'INVALID_IMAGE','배치의 이미지 완전성·프레임·크기를 확인해 주세요.');}}
        const id=randomUUID(),newRecords=[],pages=[],numberUpgrades=[];
        const batchContext = stage15 ? await contextStore.snapshot(owner,projectId) : null;
        let nextNumber=Math.max(0,...[...records.values()].filter(record=>record.state.owner===owner&&record.state.projectId===projectId).map(record=>record.state.pageNumber??0));
        for(const page of prepared){
          let existing=page.requestedPageId?[...records.values()].filter(record=>record.state.owner===owner&&record.state.projectId===projectId&&record.state.pageId===page.requestedPageId&&committed(record)).sort((a,b)=>b.state.sequence-a.state.sequence)[0]:undefined;
          if(existing){existing=latest(existing);requireValue(existing.state.sourceSha256===page.sourceSha256,409,'PAGE_SOURCE_CONFLICT','기존 페이지의 원본이 다릅니다. 새 페이지로 추가해 주세요.');
            requireValue(page.requestedPageNumber===undefined||existing.state.pageNumber===undefined||existing.state.pageNumber===page.requestedPageNumber,409,'PAGE_NUMBER_CONFLICT','기존 페이지의 순서가 다릅니다.');
            if(batchContext)requireValue(existing.state.status==='completed',409,'STAGE15_PAGE_ALREADY_BOUND','이 페이지의 기존 배치와 시도 기록을 확인해 주세요.');
            if(existing.state.status==='completed'){
              let verified;
              try{verified=await verify(existing);}catch(error){
                if(error.code==='STAGE15_VERIFIER_UNAVAILABLE')throw error;
                if(batchContext)throw failure(409,'STAGE15_REUSE_UNVERIFIED','이전 페이지의 결과를 확인할 수 없어 새 배치에서의 재사용을 보류했습니다.');
                await markFailed(existing,'INTEGRITY_FAILED','저장한 결과의 무결성을 확인하지 못했습니다. 원본은 보존했습니다.');
              }
              if(verified && batchContext){
                requireValue(existing.state.stage15 && verified.report.stage15?.binding.contextRevision===batchContext.glossaryRevision,
                  409,'CONTEXT_REEVALUATION_REQUIRED','저장한 후보의 승인과 현재 문맥을 확인해 주세요.');
                stage15.assertApplicable(verified.report.stage15);
              }
            }
          }
          const number=existing?.state.pageNumber??page.requestedPageNumber??++nextNumber;
          requireValue(Number.isSafeInteger(number)&&number>0&&number<=100000,422,'PAGE_NUMBER_LIMIT','작품의 지원 페이지 번호 한도를 초과했습니다.');
          requireValue(![...records.values()].some(record=>record.state.owner===owner&&record.state.projectId===projectId&&record.state.pageNumber===number&&record.state.pageId!==(page.requestedPageId??null))&&
            !pages.some(value=>value.pageNumber===number),409,'PAGE_NUMBER_CONFLICT','같은 작품에 페이지 순서가 중복됩니다.');
          nextNumber=Math.max(nextNumber,number);
          let record=existing;
          if(!record){page.metadata={...page.metadata,pageId:page.requestedPageId??randomUUID(),pageNumber:number};page.fingerprint=sha(JSON.stringify({...page.metadata,sourceSha256:page.sourceSha256}));record=recordFor(page,page.dimensions,{batchId:id,requestNamespace:'batch-page',...(stage15?{stage15:true}:{})});newRecords.push(record);}
          else if(record.state.pageNumber===undefined)numberUpgrades.push({record,number});
          pages.push({key:page.key,name:page.metadata.name,pageId:record.state.pageId,pageNumber:number,jobId:record.state.id,sourceSha256:page.sourceSha256});
        }
        requireValue(records.size+newRecords.length<=JOB_LIMITS.jobs,429,'JOB_LIMIT','보관할 수 있는 작업 수를 초과했습니다.');
        const now=new Date().toISOString(),priority=input.currentPageId?{owner,projectId,pageId:input.currentPageId,updatedAt:now}:undefined;
        const batch={directory:path.join(batchDirectory,id),state:{version:1,id,owner,idempotencyKey:input.idempotencyKey,fingerprint,projectId,sourceLanguage,status:'preparing',pages,createdAt:now,updatedAt:now,
      ignoredFiles:Array.isArray(input.ignoredFiles)?input.ignoredFiles.filter(value=>typeof value?.name==='string'&&value.name.length<=400&&value.reason==='macos_metadata').slice(0,300):[],
      archiveStats:input.archiveStats??null,...(batchContext?{stage15ContextRevision:batchContext.glossaryRevision}:{}),...(priority?{priority}:{})}};
        await mkdir(batchDirectory,{recursive:true,mode:0o700});await regularDirectory(batchDirectory);
        await mkdir(batch.directory,{mode:0o700});await persistBatch(batch);batches.set(id,batch);batchRequests.set(key,batch);
        try{
          for(const record of newRecords)await writeRecord(record);
          for(const value of numberUpgrades){value.record.state.pageNumber=value.number;await persist(value.record);}
          batch.state.status='accepted';await persistBatch(batch);
        }catch{
          batch.state.status='failed';try{await persistBatch(batch);}catch{}
          throw failure(503,'BATCH_ACCEPT_FAILED','배치 저장을 완료하지 못했습니다. 보존한 원본을 자동 처리하지 않습니다. 같은 요청으로 기록을 확인해 주세요.');
        }
        for(const record of newRecords){register(record);queue.push(record);}
        if(priority)rememberPriority(priority);applyPriorities();schedule();return batchView(batch);
      });
    },
    async getBatch(owner,id) {
      await mutations;const batch=batches.get(id);requireValue(shaPattern.test(owner??'')&&batch?.state.owner===owner,404,'BATCH_NOT_FOUND','이 사용자에게 속한 배치를 찾을 수 없습니다.');return batchView(batch);
    },
    async resolveBatch(owner,{projectId,idempotencyKey}={}) {
      requireValue(typeof owner==='string'&&shaPattern.test(owner)&&typeof projectId==='string'&&idPattern.test(projectId)&&typeof idempotencyKey==='string'&&keyPattern.test(idempotencyKey),422,'INPUT_INVALID','확인할 작품과 배치 식별자를 확인해 주세요.');
      await mutations;const batch=batchRequests.get(owner+':'+idempotencyKey);
      requireValue(batch?.state.projectId===projectId,404,'BATCH_UNKNOWN','수락한 배치를 아직 확인할 수 없습니다.');
      requireValue(batch.state.status==='accepted',409,'BATCH_NOT_COMMITTED','배치 수락이 완료되지 않았습니다. 원본과 기존 작업 기록을 보존했습니다.');
      return batchView(batch);
    },
    async prioritize(owner,{projectId,pageId}={}) {
      requireValue(shaPattern.test(owner??'')&&idPattern.test(projectId??'')&&idPattern.test(pageId??''),422,'INPUT_INVALID','읽기 페이지를 확인해 주세요.');
      return serial(async()=>{
        requireValue(!closed,503,'SERVER_CLOSING','작업 서버가 종료 중입니다.');
        requireValue([...records.values()].some(record=>record.state.owner===owner&&record.state.projectId===projectId&&record.state.pageId===pageId&&committed(record)),404,'PAGE_NOT_FOUND','이 작품에서 읽을 페이지를 찾을 수 없습니다.');
        const value={owner,projectId,pageId,updatedAt:new Date().toISOString()},saved=new Map(priorities);saved.set(priorityKey(owner,projectId),value);
        await atomicState(directory,{version:1,entries:[...saved.values()]},'reading-priorities.json');rememberPriority(value);applyPriorities();return {projectId,pageId};
      });
    },
    async retry(owner,id,{idempotencyKey}={}) {
      requireValue(shaPattern.test(owner??'')&&keyPattern.test(idempotencyKey??''),422,'INPUT_INVALID','재시도 식별자를 확인해 주세요.');
      return serial(async()=>{
        available();const original=owned(owner,id),key=requestKey(owner,idempotencyKey),prior=requests.get(key);
        const requestFingerprint=sha(JSON.stringify({retryRequestOf:id,owner,idempotencyKey}));
        if(prior){requireValue(prior.state.fingerprint===requestFingerprint,409,'IDEMPOTENCY_CONFLICT','같은 재시도 요청의 대상이 다릅니다.');return prior.state.retryOf&&!committed(prior)?admitRetry(prior):publicJob(prior);}
        const previous=latest(original);
        if(previous.state.status==='result_unknown'||previous.state.stage15 && previous.state.status==='failed')
          throw failure(409,'RETRY_UNSAFE','이 번역의 기존 시도와 승인 범위를 확인해 주세요.');
        requireValue(![...records.values()].some(record=>record.state.retryOf===previous.state.id&&!committed(record)),503,'RETRY_COMMIT_UNKNOWN','수락 여부를 확인하지 못한 재시도가 있습니다. 이전 요청 식별자로 확인해 주세요.');
        if(previous.state.status!=='failed'){
          if(previous.state.status==='completed'){try{await verify(previous);}catch(error){if(error.code==='STAGE15_VERIFIER_UNAVAILABLE')throw error;await markFailed(previous,'INTEGRITY_FAILED','저장한 결과의 무결성을 확인하지 못했습니다. 원본은 보존했습니다.');}}
          if(previous.state.status!=='failed')return publicJob(previous);
        }
        requireValue(attempt(previous)<MAX_ATTEMPTS,409,'RETRY_BUDGET_EXHAUSTED','동일 작업의 재시도 한도를 사용했습니다. 원인과 입력을 검토해 주세요.');
        requireValue(classifyFailure({code:previous.state.errorCode}).manuallyRetryable,409,'RETRY_UNSAFE','원본·권한·자원 또는 실행 여부 확인이 먼저 필요합니다.');
        requireValue(records.size<JOB_LIMITS.jobs,429,'JOB_LIMIT','보관할 수 있는 작업 수를 초과했습니다.');
        const source=await boundedFile(path.join(previous.directory,'source'+sourceExtensions[previous.state.mime]),JOB_LIMITS.inputBytes);
        requireValue(sha(source)===previous.state.sourceSha256,409,'SOURCE_INTEGRITY_FAILED','보존한 원본의 무결성이 맞지 않아 다시 실행하지 않습니다.');
        const prepared=preparedInput({owner,idempotencyKey,bytes:source,name:previous.state.name,sourceLanguage:previous.state.sourceLanguage,projectId:previous.state.projectId,pageId:previous.state.pageId,
          ...(previous.state.pageNumber===undefined?{}:{pageNumber:previous.state.pageNumber})});
        const dimensions=await inspect(source,previous.state.mime);prepared.fingerprint=requestFingerprint;
        const record=recordFor(prepared,dimensions,{retryOf:previous.state.id,retryRequestOf:id,...(previous.state.batchId?{batchId:previous.state.batchId}:{})});
        await writeRecord(record);register(record);return admitRetry(record);
      });
    },
    async get(owner, id) {
      // Terminal metadata must not be visible before its atomic JSON write has
      // settled; callers can reconnect immediately after receiving this view.
      await mutations;
      const record = owned(owner, id);
      if (record.state.status === 'completed') { try { await checkedCompletion(record); } catch (error) { if(error.code==='STAGE15_VERIFIER_UNAVAILABLE')throw error; } }
      return publicJob(record);
    },
    async list(owner) {
      requireValue(shaPattern.test(owner ?? ''), 401, 'AUTH_REQUIRED', '사용자 세션이 필요합니다.');
      return Promise.all([...records.values()].filter(record => record.state.owner === owner).sort((a, b) => a.state.sequence - b.state.sequence).map(record => this.get(owner, record.state.id)));
    },
    async cancel(owner,id){
      return serial(async()=>{
        const record=owned(owner,id),state=record.state;if(['completed','failed','cancelled','result_unknown'].includes(state.status)||state.cancelRequestedAt)return publicJob(record);
        state.cancelRequestedAt=new Date().toISOString();state.stage='cancel_requested';state.message='작업 중단과 자원 반환을 확인하고 있습니다.';await persist(record);
        if(state.status==='queued'){const index=queue.indexOf(record);if(index>=0)queue.splice(index,1);state.status='cancelled';state.stage='cancelled';state.cancelledAt=new Date().toISOString();state.errorCode='CANCELLED';await persist(record);}
        else record.controller?.abort(Object.assign(new Error('Cancelled'),{code:'CANCELLED'}));
        return publicJob(record);
      });
    },
    async getResult(owner, id,{expectedGeneration}={}) {
      await mutations;
      const record = owned(owner, id); requireValue(record.state.status === 'completed', 409, 'RESULT_NOT_READY', '완료된 결과가 아직 없습니다.');
      const verified=await checkedCompletion(record);
      if(record.state.stage15)stage15.assertApplicable(verified.report.stage15);
      if(record.state.contextSha256!==undefined){
        const context=JSON.parse((await boundedFile(path.join(record.directory,'translation-context.json'),1024*1024)).toString('utf8'));
        let current;try{current=await contextStore.snapshot(owner,record.state.projectId);}catch{throw failure(409,'CONTEXT_FRESHNESS_UNKNOWN','최신 작품 문맥을 확인하지 못했습니다. 후보와 기존 결과는 보존했습니다.');}
        requireValue(current.glossaryRevision===context.glossaryRevision&&current.contentSha256===context.glossaryContentSha256,409,'CONTEXT_REEVALUATION_REQUIRED','작품 문맥이 변경되어 이전 후보의 적용을 중지했습니다.');
      }
      requireValue(currentPage(record)&&(expectedGeneration===undefined||expectedGeneration===record.state.sequence),409,'STALE_RESULT','현재 페이지 세대와 다른 후보입니다. 이전 정상 결과는 보존했습니다.');
      return verified.result;
    },
    close() {
      return closePromise ??= (async () => {
        closed = true; await mutations; active?.controller?.abort(new Error('Server interrupted'));
        const results = await Promise.allSettled([Promise.resolve().then(() => engine.close()), pending]);
        await mutations;
        const failures = results.filter(value => value.status === 'rejected').map(value => value.reason);
        if (failures.length) throw new AggregateError(failures, 'ENGINE_CLOSE_UNCONFIRMED');
        ownedRoots.delete(rootKey);
      })();
    },
  });
}
