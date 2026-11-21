'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:net');
const { BrowserWindow, session, nativeImage, app } = require('electron');
const { createRunMetrics } = require('./run-metrics.cjs');
const { llamaArguments, llamaStartupMs, pageTemplateFile } = require('./translation-launch.cjs');
const { selectDialogueRegions } = require('../../../../quality/region-selection.cjs');
const { buildPageTranslationRequest, parsePageTranslation, parsePageTranslationResponse } = require('../../../../quality/page-translation.cjs');
const { buildTranslationInput, linePromptData, regionResponseFormat, validateTranslationBatch, assertDraftPredicates } = require('../../../../quality/translation-contract.cjs');
const { assertKoreanOutputBatch } = require('../../../../quality/korean-output.cjs');
const {productOnnx,extractionFromOnnx,onnxTranslationTargets,translationRequest,translatedPage} = require('../../../../quality/product-onnx.cjs');
const { verifyLearnedMask, verifySourceTextMask, protectedOcrRegions, inspectRestorationInk } = require('../../../../quality/mask-evidence.cjs');
const { runtimeReuseFlags, createOwnedRuntimeCache } = require('../../../../quality/owned-runtime.cjs');
const { createOcrFailureDiagnostic } = require('../../../../quality/ocr-diagnostic.cjs');
const { prepareOcrEnvironmentPolicy } = require('../../../../quality/ocr-environment.cjs');
const { createCheckpointSession, fingerprintFiles, key: checkpointKey } = require('../../../../quality/recovery-checkpoint.cjs');
const { resolveEngineReview, requireReviewedOcr, assertReviewedRisks } = require('../../../../quality/human-translation-review.cjs');
const { inspectSubmission, applyHumanTranslationReview } = require('../../../../quality/human-translation-review.cjs');
const { computeOcrConfiguration, createOcrCompatibilityAccess } = require('../../../../quality/ocr-checkpoint-compatibility.cjs');
const { inspectImportedPageInputs } = require('../../../../quality/imported-page-input.cjs');
const { planOcrRefinement, bindOcrRefinementCrops, applyOcrRefinement } = require('../../../../quality/ocr-refinement.cjs');
const {
  LIMITS, failure, assertActive, imageHeader, secretlessEnvironment, acquireHooks,
  deadline, waitBounded, ProcessOwner, collectProcess, authEnvironmentName, boundedResponse, parseLamaResponse,
} = require('./engine-boundaries.cjs');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const absolute = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw failure('CONFIG_PATH', `${label} 절대 경로가 필요합니다.`);
  return path.resolve(value);
};

/** Electron main 전용. 모델을 설치하거나 기존 포트·설정·프로젝트를 사용하지 않는다. */
async function createEngine(options) {
  const { repository, buildRoot, resourcesPath, profileRoot } = options;
  const config = options.config ?? options; // host.cjs의 평면 로컬 설정도 같은 계약으로 수용한다.
  const root = absolute(repository, 'repository'), compiled = absolute(buildRoot, 'buildRoot');
  const resources = absolute(resourcesPath, 'resourcesPath'), profile = absolute(profileRoot, 'profileRoot');
  const rendererPath = absolute(config.rendererBundle ?? options.rendererBundle ?? path.join(compiled, 'renderer.js'), 'rendererBundle');
  const resourceRoot = path.join(absolute(config.installedLocalAppData ?? 'C:/Users/ksaei/AppData/Local', 'installedLocalAppData'), 'Trio', 'resources');
  const lamaBridge = path.join(root, 'scripts', 'sites-local', 'lama-stdio.py');
  const releaseHooks = acquireHooks();
  let closed = false, blocked, active, closePromise, font, ocr, registry, payloadApi, qaApi, rendererSource, ocrCache, translationCache, ocrEnvironmentPolicy;
  let reuse = { ocr: false, translation: false }, onnx;
  let state = '파일 준비 확인 중입니다.';

  const load = (relative) => import(pathToFileURL(path.join(compiled, 'src', relative)).href);
  try {
    if (!app.isReady()) throw failure('APP_NOT_READY', 'app.whenReady() 이후 엔진을 생성해야 합니다.');
    reuse = runtimeReuseFlags(config);
    onnx = productOnnx(config);
    if (onnx) {
      if (reuse.ocr || reuse.translation || config.refineConnectedOcr || config.mangaOcr)
        throw failure('CONFIG_PATH','ONNX 프로필과 native OCR 재인식·런타임 재사용 설정을 함께 사용할 수 없습니다.');
      await onnx.preflight();
    } else llamaArguments(config,0);
    if(config.pageContextTranslation!==undefined&&typeof config.pageContextTranslation!=='boolean')throw failure('CONFIG_PATH','페이지 문맥 번역 설정은 boolean이어야 합니다.');
    llamaStartupMs(config);
    await fs.mkdir(path.join(profile, 'engine-temp'), { recursive: true });
    if (Boolean(config.regionDetectorWorker) !== Boolean(config.regionDetectorModel)) throw failure('CONFIG_PATH', '영역 탐지 실행기와 모델 경로가 함께 필요합니다.');
    if (config.refineConnectedOcr !== undefined && typeof config.refineConnectedOcr !== 'boolean' || config.refineConnectedOcr && !config.regionDetectorWorker) throw failure('CONFIG_PATH', '연결 대사 재인식은 boolean 설정과 학습 영역 탐지가 필요합니다.');
    if (Boolean(config.textMaskWorker) !== Boolean(config.textMaskModel) || config.textMaskWorker && !config.regionDetectorWorker && !onnx) throw failure('CONFIG_PATH', '학습 마스크에는 픽셀 모델·실행기와 대사 영역 탐지가 모두 필요합니다.');
    if(config.textMaskAlgorithm!==undefined&&(!config.textMaskWorker||!['dual-context-consensus-v1','source-ink-radial-halo-v3-experimental'].includes(config.textMaskAlgorithm)))throw failure('CONFIG_PATH','지원하는 학습 마스크 알고리즘과 실행기를 확인하세요.');
    if (config.pageContextTranslation && !config.mmproj && !onnx) throw failure('CONFIG_PATH', '페이지 그림 번역에는 대응하는 그림 인코더가 필요합니다.');
    for (const key of [...(onnx ? [] : ['llamaServer','gemmaModel']), 'python', 'lamaWorker', 'lamaModel', 'lamaTileWrapper', ...(!onnx && config.regionDetectorWorker ? ['regionDetectorWorker','regionDetectorModel'] : []), ...(config.textMaskWorker ? ['textMaskWorker','textMaskModel'] : []), ...(!onnx && config.mmproj ? ['mmproj'] : [])]) {
      const name = absolute(config[key], key);
      if (!(await fs.stat(name)).isFile()) throw failure('RESOURCE_MISSING', `${key} 파일이 준비되지 않았습니다.`);
    }
    ocrEnvironmentPolicy = await prepareOcrEnvironmentPolicy({ pythonExecutable: config.python, profileRoot: profile });
    rendererSource = (await boundedFile(rendererPath, 4 * 1024 * 1024)).toString('utf8');
    const [ocrModule, fontModule, registryModule, adapterModule, payloadModule, qaModule] = await Promise.all([
      load('main/productionOcrService.js'), load('main/productionTypesetFontResource.js'),
      load('main/translation/translationEngineRegistry.js'), load('main/translation/adapters/localAiAdapter.js'),
      load('shared/translation/translationPayload.js'),
      load('shared/translation/translationQa.js'),
    ]);
    font = await fontModule.initializeProductionTypesetFontResource(resources, { warn: () => {} });
    if (!font.enabled) throw failure('FONT_UNAVAILABLE', '서명된 제품 한글 글꼴을 검증하지 못했습니다.');
    const createOcr = () => ocrModule.createProductionOcrService({
      resourcesPath: resources, initialResourceRoot: resourceRoot,
      ...(config.mangaOcr ? { mangaOcr: config.mangaOcr } : {}),
    });
    if (!onnx) ocr = createOcr();
    if (reuse.ocr) ocrCache = createOwnedRuntimeCache({
      kind: 'ocr', createOwner: () => new ProcessOwner(), create: createOcr,
      prepare: async (service, { signal, context }) => {
        const stop = () => service.close(); signal.addEventListener('abort', stop, { once: true });
        try { await checkOcrStatus(service, signal, context.runtimeEvent); }
        finally { signal.removeEventListener('abort', stop); }
      },
      destroy: service => service.close(), cleanupMs: LIMITS.cleanupMs,
    });
    if (reuse.translation) translationCache = createOwnedRuntimeCache({
      kind: 'translation', createOwner: () => new ProcessOwner(),
      create: ({ owner, signal, context }) => startTranslationServer(config, profile, owner, signal, context.runtimeEvent),
      validate: (server, { context }) => server.checkReady(context.signal),
      destroy: server => server.close(), cleanupMs: LIMITS.cleanupMs,
    });
    registry = registryModule.createTranslationEngineRegistry([adapterModule.createLocalAiTranslationAdapter()]);
    payloadApi = payloadModule;
    qaApi = qaModule;
    state = '파일·서명 글꼴 준비 완료. 모델 적재는 작업 실행 시 시작합니다.';
  } catch (error) {
    blocked = error?.code === 'FONT_UNAVAILABLE' || error?.code === 'APP_NOT_READY' || error?.code === 'CONFIG_PATH'
      ? error.message : '엔진의 모델 경로·컴파일 결과·리소스 파일을 확인하지 못했습니다.';
  }

  function health() {
    return { ready: !closed && !blocked && !active, message: closed ? '엔진이 종료되었습니다.' : blocked ?? state,
      providerProfile:onnx?'onnx-cpu':'native',modelLoading:'ON_JOB',savedContextSupported:!closed&&!blocked };
  }

  async function inspectImage(bytes, mime) {
    // HTTP 서버가 입력 8MiB를 검사한다. 같은 API로 최대 32MiB 결과도 확인한다.
    const header = imageHeader(bytes, mime, LIMITS.outputBytes);
    const decoded = await decodeSource(bytes, header);
    return decoded.getSize();
  }

  const ocrContext=()=>({engineFile:__filename,repositoryRoot:path.resolve(root,'../../../..'),config,compiled,resources,resourceRoot,
    environmentIdentity:ocrEnvironmentPolicy.identity,reuseOcrRuntime:reuse.ocr});
  const ocrCompatibilityAccess=createOcrCompatibilityAccess();
  const ocrConfiguration=context=>onnx?onnx.configuration('ocr',__filename):computeOcrConfiguration(context);
  async function readOcrCheckpoint(args,checkpoint,identity,scope,signal,context=ocrContext()){
    if(args.resolveOcrCompatibility!==undefined&&typeof args.resolveOcrCompatibility!=='function')throw failure('OCR_COMPATIBILITY_REJECTED','호환 출처는 신뢰된 controller 함수로만 전달할 수 있습니다.');
    if(onnx)return {value:await checkpoint.load('ocr',identity),compatibility:null};
    return ocrCompatibilityAccess.load({session:checkpoint,identity,context,scope,resumeFrom:args.resumeFrom,sourceEvidence:args.resolveOcrCompatibility,signal});
  }

  /** Input verification only. No renderer, model/worker, output image or checkpoint save. */
  async function inspectInputReadiness(args){
    if(!health().ready)throw failure('ENGINE_UNAVAILABLE',health().message);
    const signal=args.signal;assertActive(signal);
    const original=await boundedFile(absolute(args.inputPath,'inputPath'),LIMITS.inputBytes),header=imageHeader(original);
    // Compute the same normalized identity in memory; no PNG file is created.
    const normalized=(await decodeSource(original,header)).toPNG(),scope={ownerScope:args.ownerScope,projectId:args.projectId,pageId:args.pageId,
      sourceSha256:sha(original),normalizedSha256:sha(normalized),sourceLanguage:args.sourceLanguage??'auto',pageNumber:args.pageNumber??null};
    const context=ocrContext(),identity={configuration:await ocrConfiguration(context)};
    const session=createCheckpointSession({directory:args.resumeFrom?.directory??path.dirname(args.inputPath),jobId:'read-only-input-inspection',scope,resumeFrom:args.resumeFrom,signal});
    const ocr=await readOcrCheckpoint(args,session,identity,scope,signal,context);
    const out={status:'OCR_CHECKPOINT_REQUIRED',scope,currentOcrIdentity:identity,exactLoader:session.evidence(),ocrCompatibility:ocr.compatibility,
      ocrReusable:!!ocr.value,approvedTranslationsUsable:false,normalizationInMemoryOnly:true,newImageFiles:0,newCheckpointWritten:false,
      actualCalls:{ocr:0,gemma:0,lama:0,renderer:0},maskAndRendererValidation:'NOT_RUN',executionAuthorized:false};
    if(!ocr.value)return out;
    const extraction=ocr.value.payload.extraction;validateExtraction(extraction);
    if(ocr.value.payload.regionSelection?.decisions?.some(d=>d.action==='needs_review')||ocr.value.payload.ocrRefinement?.reviews?.length)throw failure('OCR_REVIEW_REQUIRED','OCR 필수 검토가 남아 있습니다.');
    const lines=[...extraction.speechBubbles].sort((a,b)=>a.readingOrder-b.readingOrder).map(g=>({id:g.id,sourceText:g.text,order:g.readingOrder,pageNumber:extraction.pageNumber,ocrEditStatus:'ai_proposed',
      sourceLineIds:structuredClone(g.ocrRefinement?.sourceDetectionIds??g.productionOcrProvenance?.sourceDetectionIds??[])}));
    validateDrafts(lines,extraction);out.ocrRegions=lines.length;out.status='OCR_REUSABLE_REVIEW_AUTHORITY_REQUIRED';
    if(args.reviewDraft){
      const draft=inspectSubmission(args.reviewDraft.packet,args.reviewDraft.submission);
      out.reviewDraft={status:draft.status,completed:draft.completed,selected:draft.regions.filter(r=>r.selectedTranslation!==null).length,applicationRequested:args.reviewDraft.submission.stage14r3.applicationApprovalRequested};
      out.status=draft.completed===lines.length?'REVIEW_AUTHORITY_REQUIRED':'HUMAN_REVIEW_PENDING';
    }
    if(args.resolveTranslationReview){
      const snapshot={...scope,candidateSetSha256:args.reviewCandidateSetSha256,editRevision:args.userEditRevision,processingGeneration:args.processingGeneration,contextRevision:args.translationContext?.glossaryRevision??null};
      const bundle=await args.resolveTranslationReview({phase:'readiness-only',snapshot:structuredClone(snapshot)});
      for(const k of ['ownerScope','projectId','pageId','pageNumber','sourceSha256','normalizedSha256','candidateSetSha256','editRevision','processingGeneration','contextRevision'])if(bundle?.current?.[k]!==snapshot[k])throw failure('HUMAN_REVIEW_REVISION_CONFLICT','현재 사용자 편집 상태가 검수 입력과 다릅니다.');
      const reviewed=applyHumanTranslationReview({...bundle,lines});out.status='INPUTS_READY_EXECUTION_NOT_AUTHORIZED';out.approvedTranslationsUsable=true;
      out.translationReceipt=reviewed.receipt;out.selectedLines=reviewed.lines;
    }
    assertActive(signal);return out;
  }

  // A separate server-only, read-only entry. Never normalize, run a job or issue a permit.
  async function inspectImportedPageReadiness({binding,source,signal}){
    if(!health().ready)throw failure('ENGINE_UNAVAILABLE',health().message);
    const context=ocrContext(),currentIdentity={configuration:await ocrConfiguration(context)};
    return inspectImportedPageInputs({binding,source,signal,readCurrentOcr:async({scope,resumeFrom})=>{
      const checkpoint=createCheckpointSession({directory:source.directory,jobId:'read-only-imported-input',scope,resumeFrom,signal});
      const out=await readOcrCheckpoint({resumeFrom,resolveOcrCompatibility:async()=>source.compatibilityEvidence},checkpoint,currentIdentity,scope,signal,context);
      return {...out,currentIdentity};
    }});
  }

  async function cacheContext(kind, args, signal, runtimeEvent) {
    const files = kind === 'translation' ? [config.llamaServer, config.gemmaModel, config.mmproj, pageTemplateFile(config)].filter(Boolean) : [config.python];
    const stamps = await Promise.all(files.map(async name => {
      const stat = await fs.stat(name); if (!stat.isFile()) throw failure('RESOURCE_MISSING', '런타임 파일을 확인하지 못했습니다.');
      return { path: name, size: stat.size, mtimeMs: stat.mtimeMs };
    }));
    return { ownerScope: args.ownerScope, projectId: args.projectId, signal, runtimeEvent,
      configuration: { root, compiled, resources, resourceRoot, profile, stamps,
        ...(kind === 'ocr' ? { mangaOcr: config.mangaOcr ?? null, ocrEnvironment: ocrEnvironmentPolicy.identity } : { modelAlias: config.modelAlias ?? 'gemma4-e2b-local',
          llamaArguments: llamaArguments(config, 0), pageContextTranslation: config.pageContextTranslation === true }) } };
  }

  async function checkOcrStatus(service, signal, runtimeEvent) {
    const started = performance.now(); await runtimeEvent('ocr_status_start');
    const status = await service.getStatus();
    await runtimeEvent('ocr_status_complete', { durationMs: Math.round(performance.now() - started), ready: status.ready });
    assertActive(signal); if (!status.ready) throw failure('OCR_UNAVAILABLE', status.message);
  }

  async function executeJob(args, controller, owner) {
    const { jobId, signal: _callerSignal, onProgress } = args;
    const signal = controller.signal;
    const metrics = createRunMetrics();
    const inputPath = absolute(args.inputPath, 'inputPath'), output = absolute(args.outputDirectory, 'outputDirectory');
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw failure('JOB_ID', '작업 ID가 올바르지 않습니다.');
    const sourceLanguage = args.sourceLanguage ?? 'auto';
    if (!['auto', 'ja', 'en'].includes(sourceLanguage)) throw failure('SOURCE_LANGUAGE', '지원하지 않는 원문 언어입니다.');
    const stat = await fs.lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('OUTPUT_DIRECTORY', '서버가 생성한 작업 출력 폴더가 필요합니다.');
    const progress = async (stage, message, value) => {
      assertActive(signal);
      metrics.enter(stage);
      await fs.appendFile(path.join(output, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage, progress: value, elapsedMs: metrics.snapshot().elapsedMs }) + '\n');
      state = message;
      await onProgress?.({ stage, message, progress: value });
      assertActive(signal);
    };
    const runtimeEvent = (phase, details = {}) => fs.appendFile(path.join(output, 'runtime-events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), phase, ...details }) + '\n');
    let window, translationServer, bridgeRecord;
    const reportPath = path.join(output, 'engine-report.json');
    try {
      assertActive(signal);
      const original = await boundedFile(inputPath, LIMITS.inputBytes);
      const header = imageHeader(original);
      const normalized = (await decodeSource(original, header)).toPNG();
      const dimensions = imageHeader(normalized, 'image/png', LIMITS.outputBytes);
      const originalHash = sha(original), normalizedHash = sha(normalized);
      // Only an administrator-supplied function can select this route. HTTP JSON
      // does not expose it. The controller owns authentication, current revision
      // and the separate single-run execution approval; a review file cannot.
      const reviewed=Object.hasOwn(args,'resolveTranslationReview');
      const reviewSnapshot={ownerScope:args.ownerScope,projectId:args.projectId,pageId:args.pageId,pageNumber:args.pageNumber??null,
        sourceSha256:originalHash,normalizedSha256:normalizedHash,candidateSetSha256:args.reviewCandidateSetSha256,
        editRevision:args.userEditRevision,processingGeneration:args.processingGeneration,contextRevision:args.translationContext?.glossaryRevision??null,outputDirectory:output};
      let humanReview=reviewed?await resolveEngineReview({resolve:args.resolveTranslationReview,snapshot:reviewSnapshot,phase:'preflight'}):null;
      await fs.writeFile(path.join(output, 'normalized.png'), normalized, { flag: 'wx' });
      const ocrScope={ownerScope:args.ownerScope,projectId:args.projectId,pageId:args.pageId,sourceSha256:originalHash,normalizedSha256:normalizedHash,sourceLanguage,pageNumber:args.pageNumber??null};
      const checkpoint=createCheckpointSession({directory:output,jobId,signal,onCheckpoint:args.onCheckpoint,resumeFrom:args.resumeFrom,scope:ocrScope});
      const checkpointsEnabled=typeof args.onCheckpoint==='function'||!!args.resumeFrom;
      const jobOcrContext=ocrContext();
      const configuration=async stage=>!checkpointsEnabled?null:stage==='ocr'?ocrConfiguration(jobOcrContext):stage==='translation'&&onnx?onnx.configuration(stage,__filename):checkpointKey({stage,settings:stage==='ocr'?{
        mangaOcr:config.mangaOcr??null,refineConnectedOcr:config.refineConnectedOcr??false,ocrEnvironment:ocrEnvironmentPolicy.identity,reuseOcrRuntime:reuse.ocr,
      }:stage==='translation'?{modelAlias:config.modelAlias??'gemma4-e2b-local',arguments:llamaArguments(config,0),pageContextTranslation:config.pageContextTranslation===true,reuseTranslationServer:reuse.translation}:{},
        files:await fingerprintFiles(stage==='ocr'?[__filename,config.python,config.regionDetectorWorker,config.regionDetectorModel,
          path.join(compiled,'src/main/productionOcrService.js'),resources,resourceRoot,config.mangaOcr?.assetsRoot,config.mangaOcr?.detectorModelPath,
          path.resolve(__dirname,'../../../../quality/ocr-refinement.cjs'),path.resolve(__dirname,'../../../../quality/region-selection.cjs')]:stage==='translation'?
          [__filename,config.llamaServer,config.gemmaModel,config.mmproj,pageTemplateFile(config),path.join(compiled,'src/main/translation/translationEngineRegistry.js'),path.join(compiled,'src/main/translation/adapters/localAiAdapter.js'),path.join(compiled,'src/shared/translation/translationPayload.js'),path.join(compiled,'src/shared/translation/translationQa.js'),path.resolve(__dirname,'../../../../quality/translation-contract.cjs'),path.resolve(__dirname,'../../../../quality/page-translation.cjs')]:
          [__filename,config.python,config.lamaWorker,config.lamaModel,config.lamaTileWrapper,lamaBridge],{excludeFonts:stage==='ocr'})});
      const saveCheckpoint=async(stage,identity,payload,assets)=>{
        if(checkpointsEnabled&&identity.configuration!==await configuration(stage))throw failure('CHECKPOINT_INVALID','실행 중 중간 결과의 모델·코드·설정 출처가 변경되었습니다.');
        await checkpoint.save(stage,identity,payload,assets);
      };
      const ocrIdentity={configuration:await configuration('ocr')},ocrRead=await readOcrCheckpoint(args,checkpoint,ocrIdentity,ocrScope,signal,jobOcrContext),savedOcr=ocrRead.value;
      requireReviewedOcr(reviewed,savedOcr); // Never turn a reviewed run into new OCR inference.
      // The optional refinement needs learned ROIs before entering the OCR
      // lifetime. Its worker belongs to the job and never inherits OCR HOME or
      // the retained OCR owner's no-spawn policy. The default order is unchanged.
      const detectRegions = () => deadline(signal, 30_000, 'REGION_DETECTOR_TIMEOUT', async detectorSignal => {
        const record = owner.spawn(config.python, ['-I','-B',config.regionDetectorWorker,'--model',config.regionDetectorModel], {
          cwd: path.dirname(config.python), windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'],
          env: secretlessEnvironment(config.python, path.join(profile, 'engine-temp')),
        });
        const cancel = () => { void owner.terminate(record, true).catch(() => {}); };
        const collect = collectProcess(record, { stdoutLimit: 2 * 1024 * 1024 });
        detectorSignal.addEventListener('abort', cancel, { once: true });
        try {
          record.child.stdin.end(JSON.stringify({ version: 1, imagePngBase64: normalized.toString('base64') }) + '\n');
          const result = JSON.parse((await collect()).toString('utf8'));
          if (result.version !== 1 || result.ok !== true || result.imageSha256 !== normalizedHash || result.width !== dimensions.width || result.height !== dimensions.height || result.executionProvider !== 'CPUExecutionProvider' || result.model?.sha256 !== '5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79') throw failure('REGION_DETECTOR_RESULT', '말풍선 탐지 결과와 현재 원고가 일치하지 않습니다.');
          return result;
        } finally { detectorSignal.removeEventListener('abort', cancel); if (!record.closed) await owner.terminate(record, true); }
      });
      let rawExtraction, ocrRefinement, regionSelection, regionDetection,extraction,preSelectionExtraction;
      const preserveOnnxOcr = async (bytes, ocrSourceJobId) => {
        await fs.writeFile(path.join(output, 'onnx-ocr.json'), bytes, { flag: 'wx' });
        await args.onTextInventory?.({ normalizedSha256: normalizedHash, ocrSourceJobId, configuration: ocrIdentity.configuration });
      };
      if(savedOcr){
        ({rawExtraction,ocrRefinement,regionSelection,regionDetection,extraction,preSelectionExtraction}=savedOcr.payload);
        validateExtraction(extraction);
        if (onnx) {
          const bytes = savedOcr.assets['onnx-ocr.json'];
          await preserveOnnxOcr(bytes, JSON.parse(bytes.toString('utf8')).data.page);
        }
      }
      else {
      if (config.refineConnectedOcr) {
        regionDetection = await detectRegions();
        await fs.writeFile(path.join(output, 'region-detection.json'), JSON.stringify(regionDetection, null, 2), { flag: 'wx' });
      }
      await progress('ocr', '기존 OCR로 원문과 읽기 순서를 인식합니다.', 5);
      extraction = await deadline(signal, LIMITS.ocrMs, 'OCR_TIMEOUT', async (ocrSignal) => {
        if (onnx) {
          const request={jobId,pageNumber:args.pageNumber??1,sourceSha256:normalizedHash,normalized:path.join(output,'normalized.png'),width:dimensions.width,height:dimensions.height};
          await runtimeEvent('onnx_ocr_start');
          const reply=await onnx.execute('ocr',request,owner,ocrSignal,path.join(profile,'engine-temp'));
          if (reply.data.failure) await fs.writeFile(path.join(output, 'onnx-ocr.json'), JSON.stringify(reply), { flag: 'wx' });
          else await preserveOnnxOcr(JSON.stringify(reply), jobId);
          const detected=extractionFromOnnx(reply.data,request);
          regionDetection=detected.detection;
          await runtimeEvent('onnx_ocr_complete',{regions:detected.extraction.speechBubbles.length});
          return detected.extraction;
        }
        return await owner.run(async () => {
        const recognize = async (service, lease) => {
          const recognitionStarted = performance.now(); await runtimeEvent('ocr_recognition_start');
          let result;
          try {
            result = await service.execute({ imageBytes: normalized, pageNumber: args.pageNumber ?? 1, signal: ocrSignal });
            validateExtraction(result);
          } catch (error) {
            try { await runtimeEvent('ocr_failure_diagnostic', createOcrFailureDiagnostic(error, { compiledRoot: compiled })); } catch { /* Keep the original OCR fault if its diagnostic sink fails. */ }
            throw error;
          }
          await runtimeEvent('ocr_recognition_complete', { durationMs: Math.round(performance.now() - recognitionStarted), speechRegions: result.speechBubbles?.length ?? null });
          if (config.refineConnectedOcr) {
            rawExtraction = structuredClone(result);
            await fs.writeFile(path.join(output, 'raw-ocr.json'), JSON.stringify(rawExtraction, null, 2), { flag: 'wx' });
            const refined = await refineConnectedExtraction({ service, rawExtraction, normalized, normalizedHash, originalHash,
              dimensions, detection: regionDetection, output, owner: lease?.owner ?? owner, signal: ocrSignal, runtimeEvent, compiledRoot: compiled });
            ocrRefinement = refined.evidence;
            return refined.extraction;
          }
          return result;
        };
        if (ocrCache) return await ocrCache.use(await cacheContext('ocr', args, ocrSignal, runtimeEvent), recognize);
        await runtimeEvent('ocr_runtime_cache', { mode: 'disabled' });
        const stop = () => ocr.close();
        ocrSignal.addEventListener('abort', stop, { once: true });
        try {
          return await owner.run(async () => {
            await checkOcrStatus(ocr, ocrSignal, runtimeEvent);
            return await recognize(ocr);
          }, undefined, ocrSignal);
        } finally {
          ocrSignal.removeEventListener('abort', stop);
          ocr.close();
          // 서비스의 close()는 동기 함수다. 실제 Python close를 기다린다.
          await owner.cleanup();
        }
        }, undefined, ocrSignal, undefined, ocrEnvironmentPolicy);
      });
      validateExtraction(extraction);
      rawExtraction ??= structuredClone(extraction);
      // Protect unselected text from the extraction that actually enters
      // selection. Keeping the old connected parent here would protect the
      // entire parent envelope and block all newly recognized child masks.
      preSelectionExtraction = structuredClone(extraction);
      if (config.regionDetectorWorker || onnx) {
        if (!config.refineConnectedOcr) await fs.writeFile(path.join(output, 'raw-ocr.json'), JSON.stringify(rawExtraction, null, 2), { flag: 'wx' });
        regionDetection ??= await detectRegions();
        const selected = selectDialogueRegions(extraction, regionDetection);
        extraction = selected.extraction; regionSelection = selected.selection;
        await fs.writeFile(path.join(output, 'region-selection.json'), JSON.stringify({ detection: regionDetection, selection: regionSelection }, null, 2), { flag: 'wx' });
        // The public result has no lossless representation for untranslated,
        // uncertain dialogue. Retain a review packet before any erasure/model
        // cost; do not return a deceptively complete, partially translated PNG.
        if (regionSelection.needsReviewRegions) {
          await fs.writeFile(path.join(output, 'ocr-review.json'), JSON.stringify({version:1,status:'needs_review',reason:'UNRESOLVED_OCR_OR_ROI',sourceSha256:originalHash,sourceImageSha256:normalizedHash,extraction:preSelectionExtraction,selection:regionSelection},null,2), {flag:'wx'});
          throw failure('OCR_REVIEW_REQUIRED', '대사 글줄 또는 말풍선 대응을 확인해야 합니다. 원문·재인식 후보를 보존했으며 번역·원문 제거 전에 중단했습니다.');
        }
      }
      }
      const textOnly = !extraction.speechBubbles.length;
      const preservedIds = new Set((regionSelection?.decisions ?? []).filter(decision => decision.action === 'preserve').map(decision => decision.id));
      const noteTargets = onnx && !reviewed && !args.translateStage && typeof args.onTextNotes === 'function'
        ? onnxTranslationTargets(preSelectionExtraction.speechBubbles.filter(group => preservedIds.has(group.id))) : [];
      const noteRegionIds = noteTargets.map(target => target.id);
      if (textOnly && !noteTargets.length) {
        throw failure('NO_TRANSLATABLE_REGIONS', '확실한 대사를 찾지 못했습니다. 원본과 말풍선 밖 원문을 보존했습니다.');
      }
      await fs.writeFile(path.join(output, 'ocr.json'), JSON.stringify(extraction, null, 2), { flag: 'wx' });
      if(!ocrRead.compatibility)await saveCheckpoint('ocr',ocrIdentity,{rawExtraction,ocrRefinement,regionSelection,regionDetection,extraction,preSelectionExtraction},onnx?['onnx-ocr.json']:[]);
      const translationScope = { owner: args.ownerScope, projectId: args.projectId, pageId: args.pageId,
        pageNumber: args.pageNumber ?? null, sourceSha256: originalHash };
      let translationRequestInFlight=false;
      const translateOnnxPage = async (input, targets, translationSignal) => {
        const request = translationRequest(input, targets), requestId = randomUUID(), started = Date.now();
        if (noteRegionIds.length) {
          request.purpose = textOnly ? 'text_notes' : 'image_and_text_notes';
          request.noteRegionIds = noteRegionIds;
          for (const cue of request.context.scene) if (preservedIds.has(cue.id)) cue.role = 'translation_note';
        }
        await fs.writeFile(path.join(output, 'onnx-request.json'), JSON.stringify(request), { flag: 'wx' });
        await runtimeEvent('onnx_translation_start', { requestId });
        const reply = await onnx.execute('translate', request, owner, translationSignal, path.join(profile, 'engine-temp'),
          () => { translationRequestInFlight = true; });
        const responseBytes = Buffer.from(JSON.stringify(reply));
        await fs.writeFile(path.join(output, 'onnx-response.json'), responseBytes, { flag: 'wx' });
        translationRequestInFlight = false;
        const result = translatedPage(reply, targets, qaApi.inspectTranslationQuality, { requestId, durationMs: Date.now() - started,
          modelAlias: 'Qwen3-4B-Instruct-2507-ONNX-q4', sourceImageSha256: normalizedHash, responseSha256: sha(responseBytes),
          ...(input.context.snapshotSha256 ? { contextSnapshotSha256: input.context.snapshotSha256 } : {}) }, input);
        await runtimeEvent('onnx_translation_complete', { requestId, regions: result.records.length });
        return result;
      };
      if (textOnly) {
        const input = buildTranslationInput({ lines: noteTargets, extraction: preSelectionExtraction,
          context: args.translationContext, scope: translationScope });
        await fs.writeFile(path.join(output, 'translation-input.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
        await progress('translate', '원본을 보존하며 번역 주석을 만듭니다.', 25);
        try {
          const translated = await deadline(signal, LIMITS.translationMs, 'TRANSLATION_TIMEOUT',
            translationSignal => translateOnnxPage(input, noteTargets, translationSignal));
          assertKoreanOutputBatch(validateTranslationBatch({ input, results: translated.pending }));
          await args.onTextNotes(translated.request);
        } catch (error) {
          if (translationRequestInFlight && error.code !== 'CLEANUP_FAILED') throw failure('RESULT_UNKNOWN', '번역 주석의 응답을 확인하지 못했습니다.');
          throw error;
        }
        return { textOnly: true };
      }
      window = await createRenderer(font, rendererSource, signal);
      const preparationStarted = performance.now();
      // A job is an immutable source incarnation. Bind its renderer mask to the
      // exact selected OCR generation as well as the normalized image frame.
      const maskIdentity = { version: 1, jobId, pageNumber: extraction.pageNumber,
        sourceImageSha256: normalizedHash, ocrSha256: sha(JSON.stringify(extraction)),
        coordinateSpace: 'normalized-page-pixels', width: dimensions.width, height: dimensions.height };
      const prepared = await deadline(signal, LIMITS.renderMs, 'MASK_TIMEOUT', (renderSignal) => rendererCall(window, 'prepare', {
        jobId, ocr: extraction, width: dimensions.width, height: dimensions.height,
        sourcePngBase64: normalized.toString('base64'), sourceLanguage, maskIdentity,
      }, renderSignal));
      await runtimeEvent('renderer_prepare_complete', { durationMs: Math.round(performance.now() - preparationStarted) });
      if (prepared?.jobId !== jobId) throw failure('STALE_RESULT', '이전 작업의 OCR 후보가 반환되었습니다.');
      const lines = validateDrafts(prepared.lines, extraction);
      for (const line of lines) {
        const group=extraction.speechBubbles.find(g=>g.id===line.id);
        line.sourceLineIds=structuredClone(group.ocrRefinement?.sourceDetectionIds??group.productionOcrProvenance?.sourceDetectionIds??group.inventoryLineIds??[]);
      }
      if(reviewed)humanReview=await resolveEngineReview({resolve:args.resolveTranslationReview,snapshot:reviewSnapshot,lines,phase:'prepared-source',previousReceipt:humanReview.receipt});
      let mask = decodeBase64(prepared.mask?.maskPngBase64, LIMITS.outputBytes);
      decode(mask, imageHeader(mask, 'image/png', LIMITS.outputBytes));
      if (!(prepared.mask?.maskedPixels > 0)) throw failure('EMPTY_MASK', '제거할 실제 마스크 픽셀이 없습니다.');
      let expectedMaskPixels = prepared.mask.maskedPixels;
      let learnedMask;
      if (config.textMaskWorker) {
        const ids = [...new Set(regionSelection.decisions.filter(item => item.action === 'translate').map(item => item.detectorRegionId))];
        const regions = ids.map(id => {
          const detected = regionDetection.regions.find(region => region.id === id && region.kind === 'text_bubble');
          if (!detected) throw failure('TEXT_MASK_INVALID', '제거할 확정 대사 영역을 찾지 못했습니다.');
          return { id, bbox: detected.bbox };
        });
        const reply = await deadline(signal, 30_000, 'TEXT_MASK_TIMEOUT', maskSignal => runImageWorker(config, config.textMaskWorker, config.textMaskModel,
          { version: 1, imagePngBase64: normalized.toString('base64'), regions }, owner, maskSignal, path.join(profile, 'engine-temp')));
        const rgba = decodeBase64(reply.maskRgbaPngBase64, LIMITS.outputBytes), grayBytes = decodeBase64(reply.maskPngBase64, LIMITS.outputBytes);
        const request = { imageSha256: normalizedHash, width: dimensions.width, height: dimensions.height, regions };
        const protection = verifyLearnedMask({ reply, request, bytes: rgba, grayBytes,
          expectedAlgorithm:config.textMaskAlgorithm??'dual-context-consensus-v1',
          bitmap: decode(rgba, imageHeader(rgba, 'image/png', LIMITS.outputBytes)).toBitmap(),
          grayBitmap: decode(grayBytes, imageHeader(grayBytes, 'image/png', LIMITS.outputBytes)).toBitmap(),
          protectedRegions: protectedOcrRegions(preSelectionExtraction, regionSelection) });
        const { maskPngBase64: _gray, maskRgbaPngBase64: _rgba, ...evidence } = reply;
        learnedMask = { ...evidence, protection, regions: reply.regions.map(region => ({ ...region,
          sourceDialogueIds: regionSelection.decisions.filter(item => item.action === 'translate' && item.detectorRegionId === region.id).map(item => item.id) })) };
        await fs.writeFile(path.join(output, 'removal-mask-legacy.png'), mask, { flag: 'wx' });
        await fs.writeFile(path.join(output, 'removal-mask-learned-gray.png'), grayBytes, { flag: 'wx' });
        await fs.writeFile(path.join(output, 'learned-mask-evidence.json'), JSON.stringify(learnedMask, null, 2), { flag: 'wx' });
        mask = rgba;
        expectedMaskPixels = protection.maskedPixels;
      }
      const sourceMaskEvidence = verifySourceTextMask({ bytes: mask,
        bitmap: decode(mask, imageHeader(mask, 'image/png', LIMITS.outputBytes)).toBitmap(),
        identity: prepared.mask?.identity, expectedIdentity: maskIdentity, expectedPixels: expectedMaskPixels,
        allowedRegions: extraction.speechBubbles.map(region => ({ id: region.id, bbox: region.bbox,
          paddingPx: Math.ceil(Math.min(region.bbox.width * dimensions.width, region.bbox.height * dimensions.height) * 0.5) + 5 })),
        protectedRegions: protectedOcrRegions(preSelectionExtraction, regionSelection ?? {
          decisions: extraction.speechBubbles.map(region => ({ id: region.id, action: 'translate' })) }) });
      await fs.writeFile(path.join(output, 'source-mask-evidence.json'), JSON.stringify(sourceMaskEvidence, null, 2), { flag: 'wx' });
      await fs.writeFile(path.join(output, 'removal-mask.png'), mask, { flag: 'wx' });
      const records = [], translationRequests = [];
      await progress('translate', '전용 로컬 번역 모델을 준비합니다.', 25);
      // Snapshot source/context once. Earlier AI candidates must never become
      // authoritative context for later lines in this same job.
      const translationInput=buildTranslationInput({lines,extraction,selection:regionSelection,context:args.translationContext,scope:translationScope});
      const requestTargets = noteTargets.length ? [...lines, ...noteTargets].sort((a, b) => a.order - b.order) : lines;
      const requestInput = noteTargets.length ? buildTranslationInput({ lines: requestTargets, extraction: preSelectionExtraction,
        context: args.translationContext, scope: translationScope }) : translationInput;
      await fs.writeFile(path.join(output,'translation-input.json'),JSON.stringify(translationInput,null,2),{flag:'wx'});
      const pendingTranslations=[];
      let stage15Receipt;
      const translationIdentity=reviewed || args.translateStage ? null : {configuration:await configuration('translation'),translationInputFingerprint:requestInput.fingerprint};
      const savedTranslation=reviewed || args.translateStage ? null : await checkpoint.load('translation',translationIdentity);
      try {
      if(reviewed){
        humanReview=await resolveEngineReview({resolve:args.resolveTranslationReview,snapshot:reviewSnapshot,lines,phase:'translation',previousReceipt:humanReview.receipt});
        for(const [i,line]of lines.entries()){
          const selected=humanReview.lines[i],qaReport=qaApi.inspectTranslationQuality({sourceText:line.sourceText,translatedText:selected.userTranslation,dialogueType:line.dialogueType});
          pendingTranslations.push({id:line.id,sourceText:line.sourceText,proposedSource:line.sourceText,translatedText:selected.userTranslation,rawTranslatedText:selected.userTranslation,qaReport});
          records.push({id:line.id,engine:'human_review',usedExactTm:false,modelHttpRequests:0,durationMs:0,qaReport,
            candidateOrigin:humanReview.receipt.selections.find(r=>r.regionId===line.id).origin,rawModelTranslation:selected.aiTranslation,
            humanReviewReceiptSha256:humanReview.receipt.receiptSha256});
        }
      } else if (args.translateStage) {
        const {rows,receipt} = await args.translateStage({sourceSha256:originalHash, normalizedSha256:normalizedHash, ocrSha256:maskIdentity.ocrSha256,
          lines, translationInput},LIMITS.translationMs);
        stage15Receipt = receipt;
        const requestId = receipt.publication.executionId, fingerprint = receipt.publication.inputFingerprint;
        for (const [i,line] of lines.entries()) {
          const proposed = rows[i], qaReport = qaApi.inspectTranslationQuality({sourceText:line.sourceText,translatedText:proposed.translatedText,dialogueType:line.dialogueType});
          if (qaReport.issues.some(issue => issue.type === 'NUMBER_MISMATCH' && issue.severity === 'error'))
            throw failure('TRANSLATION_NUMBER_MISMATCH','현재 대사의 숫자가 보존되지 않았습니다.');
          pendingTranslations.push({...proposed,qaReport});
          records.push({id:line.id,requestId,requestScope:'page',engine:'stage15_synthetic',usedExactTm:false,
            modelHttpRequests:0,responseIdentity:'validated_page_json_ids',requestedContextFingerprint:fingerprint,returnedContextFingerprint:fingerprint,qaReport});
        }
        translationRequests.push({requestId, scope:'page',regionIds:rows.map(r=>r.id),httpRequests:0,contextFingerprint:fingerprint,
          contextSnapshotSha256:args.translationContext?.snapshotSha256,imageSha256:normalizedHash,usedImageContext:false});
      } else {
      if(savedTranslation){
        pendingTranslations.push(...savedTranslation.payload.pendingTranslations);records.push(...savedTranslation.payload.records);translationRequests.push(...savedTranslation.payload.translationRequests);
        if(onnx) for(const [file,bytes] of Object.entries(savedTranslation.assets)) await fs.writeFile(path.join(output,file),bytes,{flag:'wx'});
        if (noteTargets.length) await args.onTextNotes(translationRequests[0]);
      }
      else {
      await deadline(signal, LIMITS.translationMs, 'TRANSLATION_TIMEOUT', async (translationSignal) => {
        if (onnx) {
          const result = await translateOnnxPage(requestInput, requestTargets, translationSignal);
          if (noteTargets.length) {
            assertKoreanOutputBatch(validateTranslationBatch({ input: requestInput, results: result.pending }));
            await args.onTextNotes(result.request);
            result.request.regionIds = lines.map(line => line.id);
            result.request.noteRegionIds = noteRegionIds;
          }
          pendingTranslations.push(...result.pending.filter(row => !preservedIds.has(row.id)));
          records.push(...result.records.filter(row => !preservedIds.has(row.id)));
          translationRequests.push(result.request);
          return;
        }
        const translate = async translationServer => {
        if (config.pageContextTranslation && config.mmproj) {
          await progress('translate', '페이지 그림과 전체 대사 문맥을 함께 번역합니다.', 35);
          const context = structuredClone(args.translationContext ?? {});
          const requestId = randomUUID(), started = Date.now(); let modelHttpRequests = 0;
          const request = { model: config.modelAlias ?? 'gemma4-e2b-local',
            ...(reuse.translation ? { cache_prompt: false } : {}),
            ...buildPageTranslationRequest({ lines, imageDataUrl: 'data:image/png;base64,' + normalized.toString('base64'), translationInput }),
            chat_template_kwargs: { enable_thinking: false } };
          const body = JSON.stringify(request), fingerprint = sha(Buffer.from(body));
          await fs.writeFile(path.join(output,'translation-request-page.json'),JSON.stringify({requestId,promptVersion:translationInput.promptVersions.page,requestFingerprint:fingerprint,system:request.messages[0].content,data:JSON.parse(request.messages[1].content[0].text.split('\n').slice(1).join('\n')),imageSha256:normalizedHash,options:{model:request.model,temperature:request.temperature,max_tokens:request.max_tokens,reasoning_budget_tokens:request.reasoning_budget_tokens,chat_template_kwargs:request.chat_template_kwargs,response_format:request.response_format}},null,2),{flag:'wx'});
          const response = await owner.run(() => fetch(translationServer.origin + '/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            signal: AbortSignal.any([translationSignal, AbortSignal.timeout(120_000)]),
          }), { ...translationServer.auth, onRequest: () => { modelHttpRequests++; translationRequestInFlight=true; }, onResponse:()=>{translationRequestInFlight=false;} }, translationSignal);
          if (!response.ok) throw failure('TRANSLATION_RESULT', '페이지 문맥 번역 요청을 처리하지 못했습니다.');
          const result = await response.json();
          await fs.writeFile(path.join(output,'translation-response-page.json'),JSON.stringify({requestId,promptVersion:translationInput.promptVersions.page,requestFingerprint:fingerprint,response:result},null,2),{flag:'wx'});
          const translated = parsePageTranslationResponse(result, lines);
          if (sha(Buffer.from(body)) !== fingerprint || modelHttpRequests !== 1) throw failure('TRANSLATION_ID', '페이지 번역 요청 지문 또는 호출 수가 일치하지 않습니다.');
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index], proposed = translated[index];
            const qaReport = qaApi.inspectTranslationQuality({ sourceText: line.sourceText, translatedText: proposed.translatedText, dialogueType: line.dialogueType });
            if (qaReport.issues.some(issue => issue.type === 'NUMBER_MISMATCH' && issue.severity === 'error')) throw failure('TRANSLATION_NUMBER_MISMATCH', '현재 대사의 숫자가 보존되지 않았습니다.');
            pendingTranslations.push({...proposed,qaReport});
            records.push({ id: line.id, requestId, requestScope: 'page', engine: 'local_ai', usedExactTm: false,
              promptVersion:translationInput.promptVersions.page,translationInputFingerprint:translationInput.fingerprint,
              requestedContextFingerprint: fingerprint, returnedContextFingerprint: fingerprint,
              responseIdentity: 'validated_page_json_ids', qaReport, modelHttpRequests: index === 0 ? modelHttpRequests : 0,
              durationMs: Date.now() - started, rawTranslatedText: proposed.rawTranslatedText, normalizations: proposed.normalizations, uncertain: proposed.uncertain });
          }
          const tokenUsage = result.usage;
          translationRequests.push({ requestId, scope: 'page', regionIds: lines.map(line => line.id), httpRequests: modelHttpRequests,
            ...(context.snapshotSha256 ? {contextSnapshotSha256:context.snapshotSha256} : {}),
            contextFingerprint: fingerprint, usedImageContext: true, imageSha256: normalizedHash, modelAlias: request.model,
            durationMs: Date.now() - started, usage: tokenUsage && ['prompt_tokens','completion_tokens','total_tokens'].every(key => Number.isInteger(tokenUsage[key]) && tokenUsage[key] >= 0) ? tokenUsage : null,
            glossaryRevision: Number.isInteger(context.glossaryRevision) ? context.glossaryRevision : null });
        } else {
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          await progress('translate', `한국어 번역 후보를 만듭니다. (${index + 1}/${lines.length})`, 30 + Math.floor(30 * index / lines.length));
          const promptData=linePromptData(translationInput,line.id),{excluded,...modelData}=promptData;
          const sourceLines=translationInput.regions.map(r=>({...r,speaker:r.speaker.confirmed?r.speaker.name:undefined}));
          const payload = payloadApi.buildTranslationContextPayload({ dialogueLines: sourceLines, targetLineId: line.id,v2SafeContext:true });
          payload.stage11={promptVersion:translationInput.promptVersions.text,data:modelData,responseFormat:regionResponseFormat([line])};
          const fingerprint = payloadApi.computeTranslationPayloadFingerprint(payload), requestId = randomUUID(), started = Date.now();
          await fs.writeFile(path.join(output,'translation-request-'+String(index+1).padStart(3,'0')+'.json'),JSON.stringify({requestId,promptVersion:translationInput.promptVersions.text,requestFingerprint:fingerprint,payload,excluded},null,2),{flag:'wx'});
          let modelHttpRequests = 0;
          if (payload.source.id !== line.id) throw failure('TRANSLATION_ID', '번역 요청 영역 ID가 일치하지 않습니다.');
          const result = await deadline(translationSignal, LIMITS.translationItemMs, 'TRANSLATION_ITEM_TIMEOUT', (itemSignal) => owner.run(() => registry.executeTranslation(payload, {
            engineType: 'local_ai', localAiRuntime: 'custom', localAiEndpoint: translationServer.origin,
            localAiModel: config.modelAlias ?? 'gemma4-e2b-local', signal: itemSignal,skipQaInspection:true,
          }), { ...translationServer.auth, onRequest: () => { modelHttpRequests++; translationRequestInFlight=true; }, onResponse:()=>{translationRequestInFlight=false;} }, itemSignal));
          assertActive(translationSignal);
          if (payloadApi.computeTranslationPayloadFingerprint(payload) !== fingerprint ||
              result?.contextFingerprint !== undefined && result.contextFingerprint !== fingerprint ||
              result?.id !== undefined && result.id !== line.id ||
              result?.targetLineId !== undefined && result.targetLineId !== line.id) {
            throw failure('TRANSLATION_ID', '번역 영역 ID 또는 요청 문맥이 변경되었습니다.');
          }
          if (result?.engine !== 'local_ai' || result.usedExactTm || typeof result.translatedText !== 'string' ||
              !result.translatedText.trim() || modelHttpRequests!==1) {
            throw failure('TRANSLATION_RESULT', '실제 로컬 번역 또는 QA 응답이 누락되었습니다.');
          }
          await fs.writeFile(path.join(output,'translation-response-'+String(index+1).padStart(3,'0')+'.json'),JSON.stringify({requestId,id:line.id,promptVersion:translationInput.promptVersions.text,requestFingerprint:fingerprint,excluded,response:result.translatedText},null,2),{flag:'wx'});
          const proposed=parsePageTranslation(result.translatedText,[line])[0];
          const speaker=translationInput.regions[index].speaker;
          const profile=speaker.confirmed?translationInput.context.profiles.find(p=>[p.name,...p.aliases].includes(speaker.name)):undefined;
          const qaReport=qaApi.inspectTranslationQuality({sourceText:line.sourceText,translatedText:proposed.translatedText,dialogueType:line.dialogueType,speakerProfile:profile});
          if (qaReport.issues.some(issue => issue.type === 'NUMBER_MISMATCH' && issue.severity === 'error')) {
            throw failure('TRANSLATION_NUMBER_MISMATCH', '현재 영역의 숫자가 보존되지 않아 후보 생성을 중단했습니다.');
          }
          pendingTranslations.push({...proposed,qaReport});
          records.push({ id: line.id, requestId, engine: 'local_ai', usedExactTm: false,
            promptVersion:translationInput.promptVersions.text,translationInputFingerprint:translationInput.fingerprint,
            requestedContextFingerprint: fingerprint, returnedContextFingerprint: payloadApi.computeTranslationPayloadFingerprint(payload),
            responseIdentity: 'validated_single_region_json_id', qaReport, rawTranslatedText:proposed.rawTranslatedText,uncertain:proposed.uncertain,normalizations:proposed.normalizations,modelHttpRequests, durationMs: Date.now() - started });
        }
        }
        };
        if (translationCache) return await translationCache.use(await cacheContext('translation', args, translationSignal, runtimeEvent), translate);
        await runtimeEvent('translation_runtime_cache', { mode: 'disabled' });
        translationServer = await startTranslationServer(config, profile, owner, translationSignal, runtimeEvent);
        return await translate(translationServer);
      });
      }
      }
      const validated=validateTranslationBatch({input:translationInput,results:pendingTranslations});
      assertKoreanOutputBatch(validated);
      if(reviewed)assertReviewedRisks(humanReview.receipt,validated);
      else assertDraftPredicates(validated);
      // Commit AI candidates only after the entire response set is validated.
      for(let i=0;i<lines.length;i++){
        lines[i].aiTranslation=reviewed?humanReview.lines[i].aiTranslation:validated[i].translatedText;lines[i].aiProposedSource=validated[i].proposedSource;
        if(reviewed)lines[i].userTranslation=humanReview.lines[i].userTranslation;
        records[i].semantic=validated[i].semantic;
      }
      if(!reviewed && !stage15Receipt)await saveCheckpoint('translation',translationIdentity,{pendingTranslations,records,translationRequests},onnx?['onnx-request.json','onnx-response.json']:[]);
      if(reviewed)await fs.writeFile(path.join(output,'human-translation-review.json'),JSON.stringify(humanReview.receipt,null,2),{flag:'wx'});
      } catch(error) {
        if(translationRequestInFlight&&error.code!=='CLEANUP_FAILED'&&(onnx||!signal.aborted))error=failure('RESULT_UNKNOWN','번역 실행에 대한 응답을 확인하지 못했습니다.');
        const expectedIds = lines.map(row => row.id);
        const receivedCandidateIds = Array.isArray(error.receivedCandidateIds) && error.semanticReview
          ? expectedIds.filter(id => error.receivedCandidateIds.includes(id)) : pendingTranslations.map(row => row.id);
        const review={version:1,status:error.code==='RESULT_UNKNOWN'?'result_unknown':'needs_review',reason:error.code??'TRANSLATION_RESPONSE_INVALID',outputCompliance:error.outputCompliance??null,...(error.semanticReview?{semanticReview:error.semanticReview}:{}),translationInputFingerprint:translationInput.fingerprint,receivedCandidateIds,expectedIds,partialApplied:false,automaticRetry:false,semanticAccuracy:null,humanSemanticVerified:null};
        try{await fs.writeFile(path.join(output,'translation-review.json'),JSON.stringify(review,null,2),{flag:'wx'});}
        catch(writeError){if(error.code!=='RESULT_UNKNOWN')throw writeError;}
        throw error;
      }
      await translationServer?.close();
      translationServer = undefined;
      await fs.writeFile(path.join(output, 'translations.json'), JSON.stringify({ lines, records, ...(translationRequests.length ? { requests: translationRequests } : {}) }, null, 2), { flag: 'wx' });
      if (records.length !== lines.length || new Set(records.map((record) => record.id)).size !== lines.length) {
        throw failure('TRANSLATION_MISSING', '일부 영역의 번역 결과가 누락되었습니다.');
      }
      await progress('inpaint', '원본을 보존하며 LaMa로 원문 영역을 복원합니다.', 65);
      if(reviewed)await resolveEngineReview({resolve:args.resolveTranslationReview,snapshot:reviewSnapshot,lines,phase:'before-lama',previousReceipt:humanReview.receipt});
      const cleanedIdentity={configuration:await configuration('cleaned'),maskSha256:sha(mask)},savedCleaned=await checkpoint.load('cleaned',cleanedIdentity);
      const inpainting = savedCleaned?{bytes:savedCleaned.assets['cleaned.png'],verification:savedCleaned.payload.verification}:await deadline(signal, LIMITS.lamaMs, 'INPAINT_TIMEOUT', async (lamaSignal) => {
        const record = owner.spawn(config.python, ['-I', '-B', lamaBridge, '--python', config.python,
          '--worker', config.lamaWorker, '--model', config.lamaModel, '--tile-wrapper', config.lamaTileWrapper, '--log-dir', output], {
          cwd: path.dirname(config.python), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: secretlessEnvironment(config.python, path.join(profile, 'engine-temp')),
        });
        bridgeRecord = record;
        let stopPromise;
        const cancel = () => {
          if (stopPromise) return;
          // 먼저 취소를 전달해 기존 bridge가 자신이 만든 worker를 kill/wait하게 한다.
          record.child.stdin.end('{"cancel":true}\n');
          stopPromise = waitBounded(record.done, LIMITS.cleanupMs).catch(() => owner.terminate(record, true));
          stopPromise.catch(() => {}); // 아래 finally에서 반드시 확인한다.
        };
        const collect = collectProcess(record, { stdoutLimit: 4 * Math.ceil(LIMITS.outputBytes / 3) + 8192, onOverflow: cancel });
        lamaSignal.addEventListener('abort', cancel, { once: true });
        try {
          assertActive(lamaSignal);
          record.child.stdin.write(JSON.stringify({ image: normalized.toString('base64'), mask: mask.toString('base64') }) + '\n');
          const raw = await collect();
          const result = parseLamaResponse(raw, lamaSignal);
          await fs.writeFile(path.join(output, 'lama-response.json'), JSON.stringify({
            version: result?.version, ok: result?.ok === true,
            error: /^[a-z_]{1,80}$/.test(result?.error ?? '') ? result.error : undefined,
            cleanupConfirmed: result?.cleanupConfirmed ?? result?.verification?.cleanupConfirmed,
          }, null, 2), { flag: 'wx' });
          if (result?.version !== 1 || result.ok !== true || result.verification?.cleanupConfirmed !== true ||
              result.width !== dimensions.width || result.height !== dimensions.height ||
              result.verification.normalizedImageSha256 !== normalizedHash || result.verification.maskSha256 !== sha(mask)) {
            throw failure('INPAINT_RESPONSE', 'LaMa 결과의 무결성 또는 종료를 확인하지 못했습니다.');
          }
          const bytes = decodeBase64(result.imagePngBase64, LIMITS.outputBytes);
          if (result.verification.cleanedSha256 !== sha(bytes)) throw failure('INPAINT_RESPONSE', 'LaMa 결과 해시가 일치하지 않습니다.');
          return { bytes, verification: result.verification };
        } finally {
          lamaSignal.removeEventListener('abort', cancel);
          if (stopPromise) await stopPromise;
          if (!record.closed) await owner.terminate(record, true);
        }
      });
      bridgeRecord = undefined;
      // Pillow 검증에 더해 Electron 디코딩으로 mask 밖 RGB와 전체 alpha를 실측한다.
      const restorationPixels = comparePixels(normalized, inpainting.bytes, mask, dimensions, extraction.speechBubbles);
      if (restorationPixels.outsideMaskChangedPixels || restorationPixels.alphaChangedPixels) {
        throw failure('INPAINT_PIXELS', '복원 결과가 마스크 밖 픽셀 또는 투명도를 변경했습니다.');
      }
      // 번역을 고정한 배치 회귀를 모델 재호출 없이 재현할 수 있도록 파생 원본을 보존한다.
      await fs.writeFile(path.join(output, 'cleaned.png'), inpainting.bytes, { flag: 'wx' });
      if ((restorationPixels.maskedDarkPixels && !restorationPixels.changedDarkPixels) || restorationPixels.unchangedDarkRegionIds.length) {
        await fs.writeFile(path.join(output,'restoration-review.json'),JSON.stringify({reason:'SOURCE_RESIDUE_SUSPECTED',pixels:restorationPixels,residualJapanese:'NOT_MEASURED'}),{flag:'wx'});
        throw failure('SOURCE_RESIDUE_SUSPECTED','제거 마스크 안의 어두운 원본 획이 그대로 남아 복원 검토가 필요합니다.');
      }
      await saveCheckpoint('cleaned',cleanedIdentity,{verification:inpainting.verification},['cleaned.png']);
      await progress('typeset', '검토 전 한국어 식자 후보 PNG를 합성합니다.', 85);
      if(reviewed)humanReview=await resolveEngineReview({resolve:args.resolveTranslationReview,snapshot:reviewSnapshot,lines,phase:'before-render',previousReceipt:humanReview.receipt});
      // Explicit rendering projection only: retain both the actual AI candidate
      // and the user's selected text in lines/receipt. The existing renderer's
      // candidate text field receives the selected text, with source/ROI guards unchanged.
      const renderLines=reviewed?humanReview.renderLines:lines;
      const typesettingIdentity = { ...maskIdentity, contract: 'stage12-input-v1', sourceSha256: originalHash,
        cleanedImageSha256: sha(inpainting.bytes), maskSha256: sha(mask), translationInputFingerprint: translationInput.fingerprint,
        workId: args.projectId ?? null, pageId: args.pageId ?? null, ownerScope: args.ownerScope ?? null,
        translationContextRevision: translationInput.context.revision, fontResourceIdentity: 'Pretendard Std Variable@1.3.9',
        mode: 'unreviewed_candidate', maskReview: 'candidate_validated_not_human_approved' };
      const backgroundContext = reviewed ? undefined : {
        sourcePngBase64: normalized.toString('base64'), maskPngBase64: mask.toString('base64'),
        sourceSha256: normalizedHash, maskSha256: typesettingIdentity.maskSha256,
        cleanedSha256: typesettingIdentity.cleanedImageSha256, allowedBoxes: [], nonWhiteFallback: true, widenSharedBalloon: true,
      };
      const rendered = await deadline(signal, LIMITS.renderMs, 'TYPESET_TIMEOUT', (renderSignal) => rendererCall(window, 'render', {
        jobId, cleanedPngBase64: inpainting.bytes.toString('base64'), lines:renderLines, typesettingIdentity, backgroundContext, returnStructuredFailure:true,
      }, renderSignal));
      if(rendered?.jobId===jobId&&['MANUAL_LAYOUT_REQUIRED','FONT_OR_GLYPH_ERROR'].includes(rendered.failure?.code)){
        const details=rendered.failure.layoutDiagnostics;
        const regionId=renderLines.find(line=>line.id===details?.rejectedRegion)?.id??null;
        const reasonCodes=Array.isArray(details?.reasonCodes)?details.reasonCodes.filter(code=>typeof code==='string'&&/^[A-Z_0-9]{1,100}$/.test(code)).slice(0,25):[];
        await fs.writeFile(path.join(output,'typesetting-review.json'),JSON.stringify({rendererCode:rendered.failure.code,regionId,reasonCodes,typesettingIdentity}),{flag:'wx'});
        throw failure('PARTIAL_TYPESETTING','원위치 식자와 글리프를 확인할 수 없어 수동 검토가 필요합니다.');
      }
      validateRendered(rendered, jobId, renderLines, dimensions, typesettingIdentity);
      for (const layout of rendered.layoutReport) {
        const region = translationInput.regions.find(r => r.id === layout.id), record = records.find(r => r.id === layout.id);
        layout.inputProvenance = { regionId: layout.id, roiId: region.roiId, sourceLineIds: region.sourceLineIds,
          translationRequestId: record.requestId ?? null, translationReview: record.semantic ?? null,
          speaker: region.speaker, userConfirmed: reviewed, ...(reviewed?{humanReviewReceiptSha256:humanReview.receipt.receiptSha256}:{}), fontResourceIdentity: typesettingIdentity.fontResourceIdentity };
      }
      const pngBytes = decodeBase64(rendered.pngBase64, LIMITS.outputBytes);
      const candidatePixels = comparePixels(normalized, pngBytes, mask, dimensions);
      if (candidatePixels.alphaChangedPixels) throw failure('TYPESET_ALPHA', '후보 합성이 원본 투명도를 변경했습니다.');
      if (sha(await boundedFile(inputPath, LIMITS.inputBytes)) !== originalHash) throw failure('SOURCE_CHANGED', '실행 중 원본 파일이 변경되었습니다.');
      const warnings = [...extraction.warnings];
      if (regionSelection?.preservedRegions) warnings.push(`말풍선 밖 또는 불확실한 원문 ${regionSelection.preservedRegions}개를 그대로 보존했습니다. 효과음·설명문 구분 검토가 필요합니다.`);
      warnings.push('AI OCR·번역·식자 후보입니다. 사용자 승인 및 의미·원문 잔여·그림 보존·가독성 검토가 필요합니다.');
      if(reviewed)warnings.push('사용자가 검토·선택한 번역문을 적용했습니다. 수동 개입 결과이며 독립 평가 정답·자동 번역 품질 합격이 아닙니다.');
      warnings.push('최종 이미지의 원문 잔여는 재측정하지 않았습니다.');
      if (learnedMask) warnings.push('학습 픽셀 마스크 후보입니다. 말풍선 테두리와 원문 잔여의 실제 검토가 필요합니다.');
      else for (const region of prepared.mask.regions) for (const reason of region.reviewReasons) warnings.push(`원문 제거: ${reason}`);
      for (const record of records) for (const issue of record.qaReport.issues) warnings.push(`번역 ${record.id}: ${issue.message}`);
      for(const record of records)for(const risk of record.semantic?.signals??[])warnings.push(`번역 ${record.id}: ${risk.code} — 사람 의미 검토 필요`);
      for (const layout of rendered.layoutReport) for (const reason of layout.reviewReasons) warnings.push(`식자 ${layout.id}: ${reason}`);
      const report = {
        version: 1, jobId, evidenceKind: 'LOCAL_ENGINE_CANDIDATE', qaStatus: 'pending', finalStatus: 'manual_review',
        userApproved: false, manualCorrections: reviewed?lines.length:0, sourceLanguage,
        ...(reviewed?{humanTranslationReview:humanReview.receipt}:{}),
        ...(stage15Receipt ? {stage15:stage15Receipt} : {}),
        image: { width: dimensions.width, height: dimensions.height, originalMime: header.mime },
        hashes: { original: originalHash, normalized: normalizedHash, mask: sha(mask), cleaned: sha(inpainting.bytes), candidate: sha(pngBytes) },
        originalPreserved: true, ocr: extraction, lines, translations: records,
        recovery:{...checkpoint.evidence(),...(ocrRead.compatibility?{reusedStages:[...new Set([...checkpoint.evidence().reusedStages,'ocr'])],ocrCompatibility:ocrRead.compatibility}:{})},
        translationInput:{version:translationInput.version,fingerprint:translationInput.fingerprint,promptVersions:translationInput.promptVersions,contextRevision:translationInput.context.revision,excluded:translationInput.context.excluded},
        ...(args.translationContext?.snapshotSha256 ? {translationContext:{snapshotSha256:args.translationContext.snapshotSha256,
          glossaryRevision:args.translationContext.glossaryRevision??null,consumed:true}} : {}),
        ...(translationRequests.length ? { translationRequests } : {}),
        ...(regionSelection ? { rawOcr: rawExtraction, regionSelection, regionDetection } : {}),
        ...(ocrRefinement ? { ocrRefinement, preSelectionOcr: preSelectionExtraction } : {}),
        removalMask: learnedMask ? { maskedPixels: learnedMask.protection.maskedPixels, kind: learnedMask.maskKind, algorithm: learnedMask.algorithm,
          regions: learnedMask.regions, protection: learnedMask.protection, qualityStatus: 'REQUIRES_REVIEW' } : { maskedPixels: prepared.mask.maskedPixels, regions: prepared.mask.regions },
        inpainting: { ...inpainting.verification, pixels: restorationPixels },
        typesetting: { layoutReport: rendered.layoutReport, inputIdentity: rendered.typesettingIdentity ?? null, pixelsComparedWithNormalizedSource: candidatePixels,
          outsideMaskChangesIncludeCandidateText: true },
        quality: { translation: records.map(({ id, qaReport,semantic }) => ({ id, qaReport,semantic })),
          residualSourceText: 'not_measured', semanticReview: 'pending', artworkReview: 'pending', readabilityReview: 'pending' },
        deadlines: { ocrMs: LIMITS.ocrMs, translationMs: LIMITS.translationMs, translationItemMs: LIMITS.translationItemMs,
          existingLocalAiClientTimeoutMs: 30_000, llamaStartupMs: llamaStartupMs(config), inpaintingMs: LIMITS.lamaMs, typesettingMs: LIMITS.renderMs },
        warnings,
      };
      await progress('typeset', '후보 무결성 검사와 실행 기록을 마무리합니다.', 99);
      report.measurements = metrics.snapshot();
      if(reviewed)await resolveEngineReview({resolve:args.resolveTranslationReview,snapshot:reviewSnapshot,lines,phase:'before-result',previousReceipt:humanReview.receipt});
      assertActive(signal);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', encoding: 'utf8' });
      assertActive(signal);
      return { pngBytes, report };
    } finally {
      // 한 cleanup 실패가 나머지 생성 자산의 종료 확인을 건너뛰지 않게 한다.
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => { if (window && !window.isDestroyed()) window.destroy(); }),
        Promise.resolve().then(() => translationServer?.close()),
        Promise.resolve().then(() => bridgeRecord && !bridgeRecord.closed ? owner.terminate(bridgeRecord, true) : undefined),
        Promise.resolve().then(() => ocr?.close()),
      ]);
      cleanup.push(...await Promise.allSettled([owner.cleanup()]));
      if (cleanup.some((result) => result.status === 'rejected')) throw failure('CLEANUP_FAILED', '생성한 작업의 종료 확인에 실패했습니다. 다음 작업을 차단합니다.');
      // A cancelled report is retained as evidence; only the store can publish completion.
    }
  }

  async function run(args) {
    if (!health().ready) throw failure('ENGINE_UNAVAILABLE', health().message);
    const controller = new AbortController(), owner = new ProcessOwner();
    const abort = () => controller.abort();
    if (args.signal?.aborted) abort(); else args.signal?.addEventListener('abort', abort, { once: true });
    const current = { controller, settled: undefined };
    active = current;
    current.settled = (async () => {
      try {
        const result = await executeJob(args, controller, owner);
        assertActive(controller.signal);
        return result;
      } catch (error) {
        if (error?.code === 'CLEANUP_FAILED' || error?.code === 'RUNTIME_LEASE_BLOCKED' || ocrCache?.status().blocked || translationCache?.status().blocked) {
          blocked = '생성한 프로세스의 종료 확인에 실패했습니다. 엔진을 다시 시작해야 합니다.';
          throw failure('CLEANUP_FAILED', blocked);
        }
        if (error?.code === 'RESULT_UNKNOWN') throw failure('RESULT_UNKNOWN','번역 시도의 효과 또는 정산이 미확정입니다.');
        assertActive(controller.signal);
        if (args.translateStage && ['CANCELLED','STAGE15_ADMISSION_DENIED','AUTHORITY_MISMATCH','AUTHORITY_EXPIRED','PROVIDER_PIN_MISMATCH',
          'FALLBACK_CONSUMED','FALLBACK_INELIGIBLE','REVIEW_REVISION_CONFLICT','STAGE15_PROVENANCE_INVALID','STAGE15_TRANSLATION_BLOCKED',
          'STAGE15_BATCH_AUTHORITY_MISMATCH','STAGE15_BATCH_BUDGET_EXHAUSTED','STAGE15_BATCH_QUOTE_EXCEEDED',
          'STAGE15_BATCH_FALLBACK_CONSUMED','STAGE15_BATCH_EVIDENCE_MISSING'].includes(error?.code))
          throw failure(error.code,'승인 또는 번역 검사 근거를 확인해 주세요.');
        // 외부 모델 응답·예외 문자열에 비밀정보가 섞일 수 있어 고정 문구만 반환한다.
        const known = new Set(['IMAGE_BYTES', 'IMAGE_LIMIT', 'IMAGE_FORMAT', 'IMAGE_MIME', 'INVALID_IMAGE', 'ANIMATED_IMAGE',
          'OCR_TIMEOUT', 'OCR_INCOMPLETE', 'OCR_EMPTY', 'PROCESS_RESTART_REQUIRED', 'OCR_REFINEMENT_INVALID', 'OCR_REFINEMENT_AMBIGUOUS', 'OCR_REFINEMENT_STALE', 'OCR_REFINEMENT_RESPONSE_INVALID', 'TRANSLATION_ID', 'TRANSLATION_RESULT', 'TRANSLATION_MISSING',
          'TRANSLATION_TIMEOUT', 'TRANSLATION_ITEM_TIMEOUT', 'TRANSLATION_PROVIDER_UNAVAILABLE', 'LLM_AUTH_UNSUPPORTED', 'LLM_HELP_TIMEOUT', 'LLM_PORT', 'LLM_START_TIMEOUT', 'LLM_START_FAILED',
          'INPAINT_TIMEOUT', 'INPAINT_RESPONSE', 'INPAINT_PIXELS', 'SOURCE_RESIDUE_SUSPECTED', 'TYPESET_TIMEOUT', 'TYPESET_ALPHA', 'TYPESET_RESULT','PARTIAL_TYPESETTING',
          'SOURCE_CHANGED', 'STALE_RESULT', 'CHECKPOINT_INVALID', 'OCR_COMPATIBILITY_REJECTED', 'HUMAN_REVIEW_AUTHORITY_REQUIRED','HUMAN_REVIEW_BINDING_INVALID','HUMAN_REVIEW_REVISION_CONFLICT','HUMAN_REVIEW_EXECUTION_REQUIRED','HUMAN_REVIEW_OCR_CHECKPOINT_REQUIRED','HUMAN_REVIEW_RISK_UNRESOLVED', 'ENGINE_UNAVAILABLE', 'OCR_UNAVAILABLE', 'OUTPUT_EXISTS', 'TRANSLATION_NUMBER_MISMATCH',
          'TRANSLATION_IDENTITY_INVALID','TRANSLATION_CONTEXT_INVALID','TRANSLATION_CONTEXT_STALE','TRANSLATION_RESPONSE_INVALID','TRANSLATION_INPUT_LIMIT',
          'REGION_DETECTOR_TIMEOUT', 'REGION_DETECTOR_RESULT', 'REGION_SELECTION_INVALID', 'OCR_REVIEW_REQUIRED', 'NO_TRANSLATABLE_REGIONS', 'PAGE_TRANSLATION_INVALID', 'TEXT_MASK_INVALID', 'TEXT_MASK_TIMEOUT']);
        throw known.has(error?.code) ? error : failure('ENGINE_FAILED', '이미지 처리에 실패했습니다. OCR·번역·복원·식자 준비 상태를 확인하세요.');
      } finally {
        args.signal?.removeEventListener('abort', abort);
        if (active === current) active = undefined;
        if (!blocked) state = '파일·서명 글꼴 준비 완료. 모델은 다음 작업에서 시작합니다.';
      }
    })();
    return await current.settled;
  }

  async function close() {
    closePromise ??= (async () => {
      closed = true;
      const current = active;
      current?.controller.abort();
      const failures = [];
      if (current) await current.settled.catch(error => { if (error?.code === 'CLEANUP_FAILED') failures.push(error); });
      try { ocr?.close(); } catch (error) { failures.push(error); }
      const caches = await Promise.allSettled([ocrCache?.close(), translationCache?.close()]);
      if (failures.length || caches.some(result => result.status === 'rejected')) {
        blocked = '보유 런타임의 종료를 확인하지 못했습니다. 엔진을 다시 시작해야 합니다.';
        throw failure('CLEANUP_FAILED', blocked);
      }
      releaseHooks();
    })();
    return await closePromise;
  }
  return Object.freeze({ health, inspectImage, inspectInputReadiness, inspectImportedPageReadiness, run, close });
}

async function boundedFile(filePath, limit) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw failure('IMAGE_BYTES', '파일 크기가 허용 범위를 벗어났습니다.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw failure('SOURCE_CHANGED', '파일이 읽는 도중 변경되었습니다.');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

async function decodeSource(bytes, header) {
  try {return decode(bytes,header);} catch(error) {
    if(header.mime!=='image/webp' || error.code!=='INVALID_IMAGE')throw error;
    // The validated, single-frame input can outlive Electron's installed WebP decoder.
    // Keep source bytes untouched and return to the same normalized native-image pipeline.
    try {
      const {data,info}=await require('sharp')(bytes,{limitInputPixels:LIMITS.pixels,failOn:'error'}).ensureAlpha().png().toBuffer({resolveWithObject:true});
      if(info.width!==header.width || info.height!==header.height)throw error;
      return decode(data,{width:header.width,height:header.height,mime:'image/png'});
    } catch {throw error;}
  }
}
function decode(bytes, dimensions) {
  const header = imageHeader(bytes, undefined, LIMITS.outputBytes);
  if (header.width !== dimensions.width || header.height !== dimensions.height) throw failure('INVALID_IMAGE', '이미지 헤더 크기가 요청과 다릅니다.');
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== dimensions.width || size.height !== dimensions.height) {
    throw failure('INVALID_IMAGE', '이미지 디코딩 또는 크기 검증에 실패했습니다.');
  }
  return image;
}

function decodeBase64(value, limit) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || value.length > 4 * Math.ceil(limit / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw failure('INVALID_IMAGE', '이미지 응답의 인코딩이 올바르지 않습니다.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) throw failure('IMAGE_BYTES', '이미지 응답이 허용 크기를 초과했습니다.');
  return bytes;
}

function validateExtraction(extraction) {
  if (!extraction || !Array.isArray(extraction.speechBubbles) || !extraction.speechBubbles.length) throw failure('OCR_EMPTY', '인식된 원문 영역이 없습니다.');
  if (!Array.isArray(extraction.warnings) || extraction.warnings.some((warning) => typeof warning !== 'string' ||
      /^OCR_REGION_(CROP|RECOGNITION)_(FAILED|EMPTY):/.test(warning))) {
    throw failure('OCR_INCOMPLETE', '일부 원문 영역을 인식하지 못해 후보 생성을 중단했습니다.');
  }
  const ids = new Set();
  for (const candidate of extraction.speechBubbles) {
    if (typeof candidate.id !== 'string' || !candidate.id || ids.has(candidate.id) || !candidate.text?.trim()) throw failure('OCR_INCOMPLETE', 'OCR 영역 ID 또는 원문이 누락·중복되었습니다.');
    ids.add(candidate.id);
  }
}

/** Re-recognize connected bubbles inside the existing, already verified OCR
 * service lifetime. Every crop is an additional actual execute call; none is a
 * parent-string guess. No crop is allowed to lazily restart a native process. */
async function refineConnectedExtraction({service,rawExtraction,normalized,normalizedHash,originalHash,dimensions,detection,output,owner,signal,runtimeEvent,compiledRoot}) {
  const plan = planOcrRefinement({ ...dimensions, sourceSha256: originalHash, sourceImageSha256: normalizedHash, extraction: rawExtraction, detection });
  const directory = path.join(output, 'ocr-refinement');
  try { await fs.mkdir(directory); } catch (error) { if (error.code === 'EEXIST') throw failure('OUTPUT_EXISTS', '기존 재인식 증거를 덮어쓰지 않습니다.'); throw error; }
  const writeJson = async (name, value) => { const bytes = Buffer.from(JSON.stringify(value, null, 2)); await fs.writeFile(path.join(directory, name), bytes, {flag:'wx'}); return sha(bytes); };
  const planSha256 = await writeJson('plan.json', plan);
  const ledger = await fs.open(path.join(directory, 'execution.jsonl'), 'wx');
  const entry = (phase, details = {}) => ledger.appendFile(JSON.stringify({ at: new Date().toISOString(), phase, ...details }) + '\n');
  const planned = plan.groups.flatMap(group => group.crops), files = new Map(), actualCrops = [];
  let additionalOcrCalls = 0, cropSource;
  try {
    await entry('full_page_completed', { sourceSha256: originalHash, sourceImageSha256: normalizedHash, rawOcrSha256: sha(Buffer.from(JSON.stringify(rawExtraction, null, 2))), plannedCrops: planned.length });
    cropSource = planned.length ? decode(normalized, dimensions) : undefined;
    let cropBytes = 0;
    for (let index = 0; index < planned.length; index++) {
      assertActive(signal);
      const crop = planned[index], nativeCrop = cropSource.crop(crop.rectPx), shape = nativeCrop.getSize();
      if (nativeCrop.isEmpty() || shape.width !== crop.rectPx.width || shape.height !== crop.rectPx.height) throw failure('OCR_REFINEMENT_INVALID', '실제 재인식 crop 크기가 계획과 다릅니다.');
      const bytes = nativeCrop.toPNG();
      cropBytes += bytes.length;
      if (cropBytes > LIMITS.outputBytes) throw failure('OCR_REFINEMENT_INVALID', '재인식 crop의 합계 크기가 허용 범위를 넘었습니다.');
      const stem = 'crop-' + String(index + 1).padStart(3, '0'), pngFile = 'ocr-refinement/' + stem + '.png', rawOcrFile = 'ocr-refinement/' + stem + '.raw-ocr.json';
      await fs.writeFile(path.join(directory, stem + '.png'), bytes, {flag:'wx'});
      files.set(crop.cropId, {pngFile, rawOcrFile, stem});
      actualCrops.push({cropId:crop.cropId,pngBytes:bytes});
    }
    cropSource = undefined;
    const bound = bindOcrRefinementCrops({plan,sourceImageSha256:normalizedHash,crops:actualCrops});
    actualCrops.length = 0;
    const bindingSha256 = await writeJson('bound-crops.json', bound);
    const alive = record => !record.closed && !record.error && record.child?.exitCode === null && record.child?.signalCode === null && !record.child.killed;
    const captured = [...owner.children.values()].filter(alive);
    const assertRuntime = () => { assertActive(signal); if (!captured.length || captured.some(record => owner.children.get(record.child) !== record || !alive(record))) throw failure('PROCESS_RESTART_REQUIRED', '재인식 중 OCR 자식의 재시작은 다음 명시 작업에서 검증합니다.'); };
    let spawnDenied = false;
    const noSpawn = {allowSpawn:false,onSpawnDenied:()=>{spawnDenied=true;}};
    const results = [], crops = [];
    for (const ticket of bound.crops) {
      assertRuntime();
      const file = files.get(ticket.cropId), bytes = await boundedFile(path.join(directory, file.stem + '.png'), LIMITS.outputBytes);
      if (sha(bytes) !== ticket.cropSha256) throw failure('SOURCE_CHANGED', '실제 재인식 crop이 변경되었습니다.');
      const started = performance.now();
      additionalOcrCalls++;
      await entry('crop_started', { cropId:ticket.cropId,parentId:ticket.parentId,roiId:ticket.roiId,cropSha256:ticket.cropSha256,additionalOcrCalls,retainedPids:captured.map(record=>record.child.pid) });
      await runtimeEvent('ocr_refinement_crop_start', {cropId:ticket.cropId,parentId:ticket.parentId,roiId:ticket.roiId});
      let result;
      try {
        result = await owner.run(() => service.execute({imageBytes:bytes,pageNumber:rawExtraction.pageNumber,signal}), undefined, signal, noSpawn);
        if (spawnDenied) throw failure('PROCESS_RESTART_REQUIRED', '재인식 중 새로운 OCR 자식 생성은 허용하지 않습니다.');
        assertRuntime();
      } catch (error) {
        try { await runtimeEvent('ocr_failure_diagnostic', {...createOcrFailureDiagnostic(error, {compiledRoot}),scope:'refinement',cropId:ticket.cropId}); } catch { /* Keep the actual OCR error. */ }
        throw error;
      }
      const rawOcrSha256 = await writeJson(file.stem + '.raw-ocr.json', result);
      await entry('crop_returned', {cropId:ticket.cropId,cropSha256:ticket.cropSha256,rawOcrSha256,durationMs:Math.round(performance.now()-started)});
      // Stop known partial/empty recognition before spending another crop call.
      try { validateExtraction(result); } catch { throw failure('OCR_REFINEMENT_RESPONSE_INVALID', '재인식 crop의 원문 인식이 완료되지 않았습니다.'); }
      if (result.speechBubbles.length !== 1 || !Array.isArray(result.nonSpeechText) || result.nonSpeechText.length) throw failure('OCR_REFINEMENT_RESPONSE_INVALID', '재인식 crop이 하나의 대사로 확인되지 않았습니다.');
      results.push({cropId:ticket.cropId,parentId:ticket.parentId,roiId:ticket.roiId,sourceSha256:originalHash,sourceImageSha256:normalizedHash,cropSha256:ticket.cropSha256,result});
      crops.push({...ticket,pngFile:file.pngFile,rawOcrFile:file.rawOcrFile,rawOcrSha256,durationMs:Math.round(performance.now()-started)});
      await runtimeEvent('ocr_refinement_crop_complete', {cropId:ticket.cropId,durationMs:Math.round(performance.now()-started),speechRegions:result.speechBubbles.length});
    }
    const applied = applyOcrRefinement({extraction:rawExtraction,plan:bound,cropResults:results});
    const replacements = new Map(applied.replacements.map(group => [group.parentId, group.children]));
    const reviews = new Map(applied.reviews.map(review => [review.parentId, review]));
    const orders = new Set();
    for (const group of rawExtraction.speechBubbles) {
      if (!Number.isInteger(group.readingOrder) || group.readingOrder < 1 || orders.has(group.readingOrder)) throw failure('OCR_REFINEMENT_INVALID', '원본 OCR 읽기 순서를 확인하지 못했습니다.');
      orders.add(group.readingOrder);
    }
    const projected = [...rawExtraction.speechBubbles].sort((a,b)=>a.readingOrder-b.readingOrder).flatMap(group => structuredClone(replacements.get(group.id) ?? [group]));
    for(const group of projected)if(reviews.has(group.id))group.ocrReview=structuredClone(reviews.get(group.id));
    projected.forEach((group,index)=>{group.readingOrder=index+1;});
    const extraction = {...structuredClone(rawExtraction),speechBubbles:projected,warnings:[...rawExtraction.warnings,...results.flatMap(r=>r.result.warnings),...(applied.replacements.length?['OCR_REFINEMENT_GLYPH_REVIEW_PENDING: 검출 대응과 OCR 인식문 일치는 실제 문자 완전 보존의 사람 검수 결과가 아닙니다.']:[])]};
    validateExtraction(extraction);
    const refinedBytes = Buffer.from(JSON.stringify(extraction, null, 2));
    await fs.writeFile(path.join(output, 'refined-ocr.json'), refinedBytes, {flag:'wx'});
    const evidence = {version:1,scope:'ACTUAL_CROP_OCR_REFINEMENT_CANDIDATE',qaStatus:'pending',sourceSha256:originalHash,sourceImageSha256:normalizedHash,originalSha256:originalHash,sourceFrame:plan.sourceFrame,hashSemantics:'original_upload_and_normalized_png_v1',reviews:applied.reviews,
      rawOcrFile:'raw-ocr.json',rawOcrSha256:sha(Buffer.from(JSON.stringify(rawExtraction,null,2))),refinedOcrFile:'refined-ocr.json',refinedOcrSha256:sha(refinedBytes),planSha256,bindingSha256,
      additionalOcrCalls,fullPageOcrCalls:1,parentCount:plan.groups.length,childCount:applied.replacements.reduce((sum,g)=>sum+g.children.length,0),
      orderProjection:'raw_parent_order_then_geometric_children_on_clone',replacements:applied.replacements.map(group=>({parentId:group.parentId,childIds:group.children.map(child=>child.id)})),crops};
    await writeJson('evidence.json', evidence);
    await entry('refinement_applied', {additionalOcrCalls,refinedOcrSha256:evidence.refinedOcrSha256,parentCount:evidence.parentCount,childCount:evidence.childCount});
    await runtimeEvent('ocr_refinement_complete', {additionalOcrCalls,parentCount:evidence.parentCount,childCount:evidence.childCount});
    return {extraction,evidence};
  } catch (error) {
    try { await entry('refinement_failed', {additionalOcrCalls,code:/^[A-Z_]{1,80}$/.test(error?.code??'')?error.code:'RUNTIME_FAILED'}); } catch { /* Preserve the original fault. */ }
    throw error;
  } finally { cropSource=undefined;actualCrops.length=0;await ledger.close(); }
}

function validateDrafts(lines, extraction) {
  if (!Array.isArray(lines) || lines.length !== extraction.speechBubbles.length) throw failure('OCR_INCOMPLETE', 'OCR 후보 영역이 누락되었습니다.');
  const byId = new Map(extraction.speechBubbles.map((bubble) => [bubble.id, bubble]));
  const ids = new Set();
  for (const line of lines) {
    if (!byId.has(line.id) || ids.has(line.id) || line.sourceText !== byId.get(line.id).text ||
        line.ocrEditStatus !== 'ai_proposed' || line.userTranslation !== undefined || line.aiTranslation !== undefined) {
      throw failure('OCR_INCOMPLETE', 'OCR 원문·영역 대응 또는 AI 제안 소유권이 변경되었습니다.');
    }
    ids.add(line.id);
  }
  return lines;
}

function validateRendered(result, jobId, lines, dimensions, expectedIdentity) {
  if (result?.jobId !== jobId || result.width !== dimensions.width || result.height !== dimensions.height ||
      !Array.isArray(result.layoutReport) || result.layoutReport.length !== lines.length) throw failure('STALE_RESULT', '후보 식자 작업 ID 또는 이미지 크기가 일치하지 않습니다.');
  if (expectedIdentity && JSON.stringify(result.typesettingIdentity) !== JSON.stringify(expectedIdentity)) throw failure('STALE_RESULT', '식자 입력의 이미지·마스크·번역 세대가 변경되었습니다.');
  const ids = new Set();
  for (const layout of result.layoutReport) {
    if (!lines.some((line) => line.id === layout.id) || ids.has(layout.id) || layout.qaStatus !== 'pending' ||
        layout.productionFontLoaded !== true || layout.glyphFontLoaded !== true || !Array.isArray(layout.reviewReasons)) {
      throw failure('TYPESET_RESULT', '식자 영역·글꼴 또는 검토 상태 검증에 실패했습니다.');
    }
    ids.add(layout.id);
  }
}

async function runImageWorker(config, worker, model, payload, owner, signal, temporary) {
  const record = owner.spawn(config.python, ['-I', '-B', worker, '--model', model], {
    cwd: path.dirname(config.python), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: secretlessEnvironment(config.python, temporary),
  });
  const cancel = () => { void owner.terminate(record, true).catch(() => {}); };
  const collect = collectProcess(record, { stdoutLimit: 8 * 1024 * 1024 });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    assertActive(signal);
    record.child.stdin.end(JSON.stringify(payload) + '\n');
    return JSON.parse((await collect()).toString('utf8'));
  } finally { signal.removeEventListener('abort', cancel); if (!record.closed) await owner.terminate(record, true); }
}

function comparePixels(sourceBytes, resultBytes, maskBytes, dimensions, regions) {
  const source = decode(sourceBytes, dimensions).toBitmap(), result = decode(resultBytes, dimensions).toBitmap();
  const mask = decode(maskBytes, dimensions).toBitmap();
  if (source.length !== dimensions.width * dimensions.height * 4 || source.length !== result.length || source.length !== mask.length) {
    throw failure('INVALID_IMAGE', '디코딩된 픽셀 버퍼 크기가 일치하지 않습니다.');
  }
  let changedPixels = 0, outsideMaskChangedPixels = 0, alphaChangedPixels = 0, maskedPixels = 0;
  let maskedDarkPixels = 0, changedDarkPixels = 0;
  for (let offset = 0; offset < source.length; offset += 4) {
    const alpha = mask[offset + 3];
    if (alpha !== 0 && alpha !== 255) throw failure('INVALID_IMAGE', '마스크 alpha가 이진값이 아닙니다.');
    if (alpha === 0) maskedPixels++;
    const dark = alpha===0 && source[offset+3]===255 && Math.max(source[offset],source[offset+1],source[offset+2])<96;
    if(dark)maskedDarkPixels++;
    if (source[offset + 3] !== result[offset + 3]) alphaChangedPixels++;
    if (source[offset] !== result[offset] || source[offset + 1] !== result[offset + 1] || source[offset + 2] !== result[offset + 2] || source[offset + 3] !== result[offset + 3]) {
      changedPixels++;
      if(dark)changedDarkPixels++;
      if (alpha !== 0) outsideMaskChangedPixels++;
    }
  }
  const ink = regions && inspectRestorationInk({ source, result, mask, ...dimensions, regions });
  return { measured: true, decodedPixels: dimensions.width * dimensions.height, maskedPixels, changedPixels, outsideMaskChangedPixels, alphaChangedPixels, maskedDarkPixels, changedDarkPixels,
    ...(ink ? { unchangedDarkRegionIds: ink.unchangedRegionIds, unchangedDarkSourceLines: ink.unchangedSourceLines } : {}) };
}

async function createRenderer(font, bundle, signal) {
  const isolated = session.fromPartition(`sites-candidate-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.protocol.handle('trio-resource', font.handleProtocolRequest);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:') && details.url !== 'trio-resource://font/pretendard-variable.ttf' });
  });
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
    session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
    backgroundThrottling: false, devTools: false,
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const abort = () => window.destroy();
  signal.addEventListener('abort', abort, { once: true });
  window.once('closed', () => { signal.removeEventListener('abort', abort); isolated.protocol.unhandle('trio-resource'); });
  try {
    assertActive(signal);
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src trio-resource:; script-src \'unsafe-eval\'">'));
    await window.webContents.executeJavaScript(bundle, true);
    const ready = await window.webContents.executeJavaScript('typeof window.SitesCandidate?.prepare === "function" && typeof window.SitesCandidate?.render === "function"');
    assertActive(signal);
    if (!ready) throw failure('RENDERER_BUNDLE', '후보 식자 번들을 불러오지 못했습니다.');
    return window;
  } catch (error) { window.destroy(); throw error; }
}

async function rendererCall(window, method, value, signal) {
  const abort = () => window.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    assertActive(signal);
    if (window.isDestroyed()) throw failure('STALE_RESULT', '후보 작업 창이 종료되었습니다.');
    const result = await window.webContents.executeJavaScript(`window.SitesCandidate.${method}(${JSON.stringify(value)})`, true);
    assertActive(signal);
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}

async function ephemeralPort(signal) {
  assertActive(signal);
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(failure('LLM_PORT', '전용 로컬 번역 포트를 확보하지 못했습니다.')));
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function verifyTranslationServer(origin, secret, modelAlias, signal) {
  const response = await boundedResponse(await fetch(`${origin}/v1/models`, {
    headers: { Authorization: `Bearer ${secret}` }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
  }), LIMITS.llmResponseBytes);
  if (!response.ok) return false;
  const models = await response.json();
  if (!models?.data?.some(model => model.id === modelAlias)) throw failure('LLM_MODEL_ID', '전용 서버의 모델 ID가 요청과 다릅니다.');
  const unauthorized = await boundedResponse(await fetch(`${origin}/v1/models`, {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
  }), LIMITS.llmResponseBytes);
  if (unauthorized.status !== 401 && unauthorized.status !== 403) throw failure('LLM_AUTH_UNSUPPORTED', '전용 번역 서버가 내부 인증을 적용하지 않았습니다.');
  assertActive(signal); return true;
}

async function startTranslationServer(config, profile, owner, signal, runtimeEvent = async () => {}) {
  const temporary = path.join(profile, 'engine-temp');
  const helpStarted = performance.now();
  await runtimeEvent('llama_help_start');
  const help = owner.spawn(config.llamaServer, ['--help'], { cwd: path.dirname(config.llamaServer), windowsHide: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], env: secretlessEnvironment(config.llamaServer, temporary) });
  const collect = collectProcess(help, { stdoutLimit: 1024 * 1024, stderrLimit: 1024 * 1024, includeStderr: true });
  let helpText;
  const abortHelp = () => help.child.kill('SIGKILL');
  signal.addEventListener('abort', abortHelp, { once: true });
  try {
    helpText = await waitBounded(collect(), LIMITS.llamaHelpMs, 'LLM_HELP_TIMEOUT');
  } finally { signal.removeEventListener('abort', abortHelp); if (!help.closed) await owner.terminate(help); }
  assertActive(signal);
  const authEnv = authEnvironmentName(helpText.toString('utf8'));
  await runtimeEvent('llama_help_ready', { durationMs: Math.round(performance.now() - helpStarted) });
  const secret = randomBytes(32).toString('base64url'), port = await ephemeralPort(signal), origin = `http://127.0.0.1:${port}`;
  assertActive(signal);
  const env = secretlessEnvironment(config.llamaServer, temporary);
  env[authEnv] = secret;
  const loadStarted = performance.now();
  await runtimeEvent('llama_load_start');
  const record = owner.spawn(config.llamaServer, llamaArguments(config, port), {
    cwd: path.dirname(config.llamaServer), windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'], env,
  });
  delete env[authEnv];
  const modelAlias = config.modelAlias ?? 'gemma4-e2b-local';
  const checkReady = async healthSignal => !record.closed && !record.error && !record.child.killed &&
    record.child.exitCode === null && record.child.signalCode === null &&
    await verifyTranslationServer(origin, secret, modelAlias, healthSignal);
  let closing;
  const close = () => closing ??= owner.terminate(record);
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const expires = Date.now() + llamaStartupMs(config);
    while (Date.now() < expires) {
      assertActive(signal);
      if (record.closed || record.error) throw failure('LLM_START_FAILED', '전용 로컬 번역 서버를 기동하지 못했습니다.');
      try {
        if (await checkReady(signal)) {
          await runtimeEvent('llama_load_ready', { durationMs: Math.round(performance.now() - loadStarted), authenticationVerified: true });
          return { origin, auth: { origin, secret }, checkReady, close: async () => { signal.removeEventListener('abort', abort); await close(); } };
        }
      } catch (error) {
        if (['LLM_MODEL_ID', 'LLM_AUTH_UNSUPPORTED', 'LLM_RESPONSE_LIMIT'].includes(error?.code)) throw error;
        assertActive(signal); // 적재 중 연결 실패만 제한 시간 안에서 기다린다.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw failure('LLM_START_TIMEOUT', '전용 로컬 번역 모델 적재 시간이 초과되었습니다.');
  } catch (error) {
    await runtimeEvent('llama_load_failed', { code: /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'LLM_START_FAILED', exitCode: record.closed ? record.code : null });
    signal.removeEventListener('abort', abort);
    await close();
    throw error;
  }
}

module.exports = { createEngine, createRenderer, rendererCall, validateRendered };
