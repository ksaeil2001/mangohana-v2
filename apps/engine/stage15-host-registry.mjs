import fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac, timingSafeEqual} from 'node:crypto';
import {createStage15AttemptExecutor, mayExecuteStage15Fallback} from './stage15-attempt-executor.mjs';
import {usdUnits} from './stage15-batch-accounting.mjs';
import {digest, regularDirectory} from './image-permit-store.mjs';
import {readBounded} from './translation-review-store.mjs';
import checkpoint from '../../packages/ai-engine/quality/recovery-checkpoint.cjs';
import page from '../../packages/ai-engine/quality/page-translation.cjs';

const {key} = checkpoint;
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const check = {checkId: 'page-translation', version: 'stage15-inspection-v1'};
const same = (a, b) => key(a ?? null) === key(b ?? null);
const demand = (ok, code) => { if (!ok) throw Object.assign(new Error(code), {code}); };

function translationInputs(stage) {
  const ancestors = [];
  let parents = [];
  for (const [name, sha256] of [['SOURCE', stage.sourceSha256], ['NORMALIZED', stage.normalizedSha256], ['OCR', stage.ocrSha256]]) {
    demand(hex(sha256), 'STALE_RESULT');
    const artifact = {artifactId: name, sha256};
    ancestors.push({id:name, stage:name, regionId:null, inputsSha256:key(parents), parents, artifact});
    parents = [{nodeId:name, ...artifact}];
  }
  const inputs = {lines:stage.lines, translationInput:stage.translationInput};
  const node = {id:'TRANSLATE', stage:'TRANSLATE', regionId:null, parents, inputsSha256:key(inputs)};
  return {ancestors, inputs, node, regionIds:stage.lines.map(line => line.id)};
}

// Only the host supplies this port, the current server grant, the resource quote and the
// receipt key. No JSON configuration or HTTP field can register a provider.
export async function createStage15HostRegistry(root, ports) {
  const {providers, receiptKey, readGrant, currentRuntime, admission} = ports;
  demand(Array.isArray(providers) && providers.length > 0 && providers.every(p => p.transport === 'SYNTHETIC' && p.port?.synthetic === true) &&
    Buffer.isBuffer(receiptKey) && receiptKey.length === 32 && [readGrant,currentRuntime,admission].every(f => typeof f === 'function'),
  'STAGE15_HOST_CONFIG_INVALID');
  const secret = Buffer.from(receiptKey);
  const mac = receipt => createHmac('sha256',secret).update(key(receipt)).digest();
  await fs.mkdir(root, {recursive:true, mode:0o700});
  await regularDirectory(root);

  function verifyReport(report, state) {
    const {signature, ...receipt} = report.stage15 ?? {};
    const b = receipt.binding;
    demand(hex(signature) && timingSafeEqual(Buffer.from(signature,'hex'),mac(receipt)) &&
      receipt.kind === 'SYNTHETIC_TRANSLATION_PUBLICATION' && b?.requestId === state.id && b.ownerScope.id === state.owner &&
      b.projectId === state.projectId && b.pageId === state.pageId && b.pageNumber === state.pageNumber && b.generation === state.sequence &&
      b.batchId === state.batchId && b.sourceSha256 === state.sourceSha256 && receipt.normalizedSha256 === report.hashes?.normalized &&
      receipt.ocrSha256 === digest(Buffer.from(JSON.stringify(report.ocr))) &&
      receipt.translationInputFingerprint === report.translationInput?.fingerprint &&
      receipt.rowsSha256 === key(report.lines.map(({id,sourceText,aiProposedSource,aiTranslation}) => ({id,sourceText,aiProposedSource,aiTranslation}))),
    'STAGE15_PROVENANCE_INVALID');
    return receipt;
  }

  function assertApplicable(receipt) {
    const grant = readGrant(structuredClone(receipt.binding));
    if (!grant || !same(grant.runtime,currentRuntime()) || Date.now() >= grant.expiresAt || key(grant) !== receipt.grantSha256)
      throw Object.assign(new Error('현재 승인 또는 실행 버전이 번역 게시 영수증과 다릅니다.'), {code:'STALE_RESULT',status:409});
  }

  async function translate(job, stage) {
    demand(job.scope.mode === 'FULL_IMAGE' && stage.sourceSha256 === job.scope.sourceSha256, 'STALE_RESULT');
    const {ancestors, inputs, node, regionIds} = translationInputs(stage);
    const binding = {...job.scope, inputDigest:key({ancestors, node, regionIds})};
    const grant = structuredClone(readGrant(structuredClone(binding)));
    demand(grant?.verified === true && same(grant.binding,binding) && grant.transport === 'SYNTHETIC' &&
      grant.stage === 'TRANSLATE' && typeof grant.runtime?.head === 'string' && /^[0-9a-f]{40,64}$/.test(grant.runtime.head) &&
      hex(grant.runtime.codeSha256) && Number.isFinite(grant.expiresAt), 'STAGE15_ADMISSION_DENIED');
    let spent = '0';
    function permitted(command) {
      const alternate = command.action === 'EXECUTE_FALLBACK';
      const provider = alternate ? grant.alternate : grant.primary;
      try {
        return job.isCurrent() && !job.signal.aborted && same(readGrant(structuredClone(binding)), grant) &&
          same(grant.runtime, currentRuntime()) && Date.now() < grant.expiresAt &&
          same(binding,command.input.binding) && same(command.provider,provider) && (!alternate || grant.maxFallbacks === 1);
      } catch { return false; }
    }
    const executor = await createStage15AttemptExecutor({root, providers, providerNow:ports.providerNow, knownBatchAttempts:job.knownBatchAttempts,
      withFence: (command, install, transition) => job.withFence(() => {
      if (transition === 'reserve' || transition === 'dispatch-intent') {
        const quote = admission(structuredClone(command.provider));
        demand(quote?.available === true && usdUnits(command.action === 'EXECUTE_FALLBACK' ? spent : '0') +
          usdUnits(quote.maximumCostUsd) <= usdUnits(grant.maximumCostUsd), 'STAGE15_ADMISSION_DENIED');
        if (command.batchBudget) demand(usdUnits(quote.maximumCostUsd) <= usdUnits(command.batchBudget.quoteUsd),'STAGE15_ADMISSION_DENIED');
      }
      return install();
    }),
      currentAuthority: (_id, command) => ({
        verified: permitted(command), cancelled: job.signal.aborted, binding, runAuthorityId: grant.id,
        executionRequestSha256:key(command), expiresAt:grant.expiresAt,
        requiredChecks:[check, ...(grant.requiredChecks ?? []).filter(c => !same(c,check))], softApprovals:grant.softApprovals ?? [],
      })});
    const deadlineMs = (ports.providerNow ? ports.providerNow() : performance.now()) + job.timeoutMs;
    const history = [];
    async function run(provider, previousExecutionId) {
      const slot = previousExecutionId ? 'fallback' : 'primary';
      const executionId = binding.requestId + '-' + slot;
      const command = {action:previousExecutionId ? 'EXECUTE_FALLBACK' : 'EXECUTE_STAGE', requestKey:executionId,
        lineageId:grant.lineageId, runAuthorityId:grant.id, provider,
        input:{executionId, binding, inputs, node, regionIds}, ancestors, ...(previousExecutionId ? {previousExecutionId} : {})};
      if (binding.batchId) {
        const quote = admission(structuredClone(provider));
        demand(grant.batch && quote?.available === true,'STAGE15_ADMISSION_DENIED');
        command.batchBudget = {policy:structuredClone(grant.batch),quoteUsd:quote.maximumCostUsd};
      }
      demand(!job.signal.aborted && permitted(command), 'STAGE15_ADMISSION_DENIED');
      let result = await executor.execute(command, {signal:job.signal, deadlineMs});
      const uncertain = result.status === 'RESULT_UNKNOWN';
      if (uncertain && !(binding.batchId && result.resourceReleaseUnconfirmed) && !job.signal.aborted && !result.blockedReasons.length)
        result = await executor.recover(executionId, {signal:job.signal, deadlineMs});
      history.push({executionId, provider, execution:result.execution, status:result.status, lookupStatus:result.lookupStatus,
        blockedReasons:result.blockedReasons, cancelled:result.cancelled,resourceReleaseUnconfirmed:result.resourceReleaseUnconfirmed});
      await job.onObservation(history.map(({executionId,provider,execution,status,lookupStatus,blockedReasons,cancelled,resourceReleaseUnconfirmed}) =>
        ({executionId,providerId:provider.providerId,state:execution.state,started:execution.started,usageConfirmed:execution.usageConfirmed,
          costUsd:execution.costUsd,errorCode:execution.errorCode,status,lookupStatus,blockedReasons,cancelled,resourceReleaseUnconfirmed})));
      demand(result.status !== 'RESULT_UNKNOWN' && !(binding.batchId && result.resourceReleaseUnconfirmed),'RESULT_UNKNOWN');
      demand(!result.cancelled && !job.signal.aborted && result.execution.state !== 'CANCELLED','CANCELLED');
      demand(!result.blockedReasons.includes('STAGE15_BATCH_QUOTE_EXCEEDED'),'STAGE15_BATCH_QUOTE_EXCEEDED');
      demand(!result.blockedReasons.length,'STALE_RESULT');
      if (result.execution.usageConfirmed)
        demand(usdUnits(spent) + usdUnits(result.execution.costUsd) <= usdUnits(grant.maximumCostUsd),'STAGE15_ADMISSION_DENIED');
      return {result, uncertain, command};
    }
    let attempt = await run(grant.primary);
    if (!attempt.uncertain && mayExecuteStage15Fallback(attempt.result) && grant.alternate && grant.maxFallbacks === 1) {
      spent = attempt.result.execution.costUsd;
      attempt = await run(grant.alternate, attempt.command.input.executionId);
    }
    const {result, command} = attempt;
    demand(result.status === 'SUCCEEDED' && result.publication, 'STAGE15_TRANSLATION_BLOCKED');
    const bytes = await readBounded(path.join(root, result.candidate.file), 32*1024*1024);
    demand(digest(bytes) === result.publication.artifact.sha256, 'STAGE15_PROVENANCE_INVALID');
    const rows = page.parsePageTranslationResponse(JSON.parse(bytes),stage.lines);
    const receipt = {kind:'SYNTHETIC_TRANSLATION_PUBLICATION', binding, authorityId:grant.id, lineageId:grant.lineageId,
      grantSha256:key(grant), runtime:grant.runtime, normalizedSha256:stage.normalizedSha256, ocrSha256:stage.ocrSha256,
      translationInputFingerprint:stage.translationInput.fingerprint, attempts:history, publication:result.publication,
      rowsSha256:key(rows.map(({id,sourceText,proposedSource,translatedText}) => ({id,sourceText,aiProposedSource:proposedSource,aiTranslation:translatedText})))};
    const assertCurrent = () => demand(permitted(command), 'STALE_RESULT');
    assertCurrent();
    job.onPublication(assertCurrent);
    return {rows, receipt:{...receipt, signature:mac(receipt).toString('hex')}};
  }
  return {translate, verifyReport, assertApplicable};
}
