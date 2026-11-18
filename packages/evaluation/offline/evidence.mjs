import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { verifyDatasetFiles } from '../dataset-contract.mjs';
import { readContractAttachment } from '../../contracts/src/v2-common-contract.mjs';
import { VERSION, requireValue, keys, identifier, digest, hash, validateIdentity, identityFields } from './contract.mjs';

const kinds = ['source','normalized','raw_ocr','final_ocr','region_detection','region_selection','refinement_plan','bound_crops','crop_ocr','crop_image',
  'translations','removal_mask','protection_mask','cleaned','candidate','final_png','trio','engine_report','report','events','state','model_config','context','common','assessment','operations','export_receipt','legacy_review'];
const jsonKinds = kinds.filter(k=>!['source','normalized','removal_mask','protection_mask','cleaned','candidate','final_png','crop_image','events'].includes(k));
export async function readPinned(file, expected) {
  requireValue(digest(expected), 'INVALID_ASSET_PIN');
  const bytes = await fs.readFile(file).catch(()=>{ requireValue(false,'ASSET_NOT_READABLE'); });
  requireValue(bytes.length <= 256 * 1024 * 1024, 'ASSET_TOO_LARGE');
  requireValue(hash(bytes) === expected, 'ASSET_HASH_MISMATCH'); return bytes;
}
export function parseJson(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { requireValue(false,'INVALID_JSON_EVIDENCE'); } }
export async function containedPath(root, relative) {
  requireValue(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'ASSET_PATH_ESCAPE');
  const base = await fs.realpath(root).catch(()=>{requireValue(false,'ASSET_NOT_READABLE');});
  const file = await fs.realpath(path.resolve(base,relative)).catch(()=>{requireValue(false,'ASSET_NOT_READABLE');});
  const rel = path.relative(base,file);
  requireValue(rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel), 'ASSET_PATH_ESCAPE'); return file;
}
export function validateDescriptor(d) {
  keys(d,['schemaVersion','adapterVersion','runId','datasetVersion','datasetManifestSha256','split','pages']);
  requireValue(d.schemaVersion === 1 && d.adapterVersion === VERSION && identifier(d.runId) && d.datasetVersion === '0.2.1'
    && digest(d.datasetManifestSha256) && ['dev','calibration','holdout'].includes(d.split) && Array.isArray(d.pages), 'INVALID_EVIDENCE_DESCRIPTOR');
  const pageIds = new Set();
  for(const p of d.pages) {
    keys(p,['pageId','binding','evidenceKind','artifacts','declaredOutcome','commonArtifactId','assessmentArtifactId','operationsArtifactId','renderPath']);
    requireValue(identifier(p.pageId) && !pageIds.has(p.pageId), 'UNKNOWN_OR_DUPLICATE_PAGE'); pageIds.add(p.pageId);
    validateIdentity(p.binding);
    requireValue(['actual_product','component','cache_reuse','synthetic','not_run'].includes(p.evidenceKind) && Array.isArray(p.artifacts)
      && [null,'succeeded','failed','interrupted'].includes(p.declaredOutcome) && ['engine_png','canvas_after_user_edit','unknown'].includes(p.renderPath), 'INVALID_EVIDENCE_DESCRIPTOR');
    for(const key of ['commonArtifactId','assessmentArtifactId','operationsArtifactId']) requireValue(p[key] === null || identifier(p[key]),'INVALID_EVIDENCE_DESCRIPTOR');
    const ids = new Set(), uniqueKinds = new Set();
    for(const a of p.artifacts) {
      keys(a,['id','kind','path','sha256','origin','maskSemantics']);
      requireValue(identifier(a.id) && !ids.has(a.id), 'DUPLICATE_ARTIFACT_ID'); ids.add(a.id);
      requireValue(kinds.includes(a.kind) && digest(a.sha256) && typeof a.path === 'string', 'INVALID_ASSET_PIN');
      if (!['crop_ocr','crop_image'].includes(a.kind)) { requireValue(!uniqueKinds.has(a.kind),'DUPLICATE_ARTIFACT_KIND'); uniqueKinds.add(a.kind); }
      keys(a.origin,['runId','jobId','reused']);
      requireValue(a.origin.runId === d.runId && a.origin.jobId === p.binding.jobId, 'STALE_ARTIFACT');
      requireValue(typeof a.origin.reused === 'boolean' && (!a.origin.reused || p.evidenceKind === 'cache_reuse'),'INVALID_ARTIFACT_ORIGIN');
    }
    for(const key of ['commonArtifactId','assessmentArtifactId','operationsArtifactId']) requireValue(p[key] === null || ids.has(p[key]),'DANGLING_ARTIFACT_REFERENCE');
  }
  return d;
}
export async function loadOfflineEvidence({datasetPath,datasetSha256,evidencePath,evidenceSha256,evidenceRoot}) {
  const dataset = parseJson(await readPinned(datasetPath,datasetSha256));
  const descriptor = validateDescriptor(parseJson(await readPinned(evidencePath,evidenceSha256)));
  requireValue(descriptor.datasetManifestSha256 === datasetSha256 && descriptor.datasetVersion === dataset.datasetVersion
    && dataset.criteria.version === 'stage05-v1', 'DATASET_VERSION_MISMATCH');
  // Stage06 never opens final labels or executes a final campaign.
  requireValue(descriptor.split !== 'holdout', 'HOLDOUT_EVALUATION_NOT_AUTHORIZED_IN_STAGE06');
  let validation;
  try { validation = await verifyDatasetFiles(datasetPath); }
  catch(e) { requireValue(false, identifier(e.code) ? e.code : 'DATASET_VALIDATION_FAILED'); }
  const pages = [];
  for(const p of descriptor.pages) {
    const datasetPage = dataset.pages.find(x=>x.pageId === p.pageId);
    requireValue(datasetPage && datasetPage.workId === p.binding.workId, 'DATASET_PAGE_BINDING_MISMATCH');
    requireValue(datasetPage.split === descriptor.split, 'SPLIT_MISMATCH');
    const artifacts = new Map();
    for(const pin of p.artifacts) {
      const file = await containedPath(evidenceRoot,pin.path), bytes = await readPinned(file,pin.sha256);
      const entry = {...pin,file,bytes};
      if(jsonKinds.includes(pin.kind)) entry.json = parseJson(bytes);
      if(pin.kind === 'events') { try { entry.events=bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)); } catch { requireValue(false,'INVALID_RUNTIME_EVENTS'); } }
      if(['source','normalized','removal_mask','protection_mask','cleaned','candidate','final_png','crop_image'].includes(pin.kind)) {
        try { entry.image=await sharp(bytes).metadata(); await sharp(bytes).stats(); } catch { requireValue(false,'INVALID_IMAGE_EVIDENCE'); }
        requireValue(entry.image.width > 0 && entry.image.height > 0 && (entry.image.pages === undefined || entry.image.pages === 1),'INVALID_IMAGE_EVIDENCE');
        if(['candidate','final_png'].includes(pin.kind)) requireValue(entry.image.format === 'png','FINAL_IMAGE_NOT_PNG');
      }
      artifacts.set(pin.id,entry);
    }
    const get = kind => [...artifacts.values()].find(x=>x.kind === kind);
    requireValue(get('source') && get('normalized'), 'SOURCE_IMAGES_REQUIRED');
    requireValue([datasetPage.source,...datasetPage.variants].some(x=>x.sha256 === get('source').sha256), 'DATASET_SOURCE_MISMATCH');
    const state = get('state')?.json, report = get('report')?.json ?? get('engine_report')?.json;
    if(state) {
      requireValue(state.id === p.binding.jobId && state.owner === p.binding.ownerId && state.projectId === p.binding.projectId && state.pageId === p.binding.pageId,'STATE_BINDING_MISMATCH');
      for(const k of identityFields.slice(4)) if(state[k] !== undefined || p.binding[k] !== null && k !== 'workId') requireValue(state[k] === p.binding[k],'STATE_BINDING_MISMATCH');
      requireValue(state.sourceSha256 === get('source').sha256,'STATE_SOURCE_HASH_MISMATCH');
      if(state.reportSha256 !== undefined) requireValue(get('report')?.sha256 === state.reportSha256,'STATE_REPORT_HASH_MISMATCH');
    }
    if(report) {
      requireValue(report.jobId === p.binding.jobId,'REPORT_BINDING_MISMATCH');
      const aliases={original:'source',normalized:'normalized',mask:'removal_mask',cleaned:'cleaned',candidate:'candidate'};
      for(const [claim,kind] of Object.entries(aliases)) if(report.hashes?.[claim] !== undefined) requireValue(get(kind)?.sha256 === report.hashes[claim],'REPORT_IMAGE_HASH_MISMATCH');
    }
    const receipt=get('export_receipt')?.json,exported=get('final_png');
    if(receipt) requireValue(receipt.jobId===p.binding.jobId && receipt.sourceSha256===get('source').sha256 && exported?.sha256===receipt.exportSha256
      && exported.bytes.length===receipt.exportBytes && exported.image.width===receipt.width && exported.image.height===receipt.height,'EXPORT_RECEIPT_MISMATCH');
    const legacyReview=get('legacy_review')?.json;
    if(legacyReview) {
      requireValue(legacyReview.sourceSha256===get('source').sha256,'LEGACY_REVIEW_SOURCE_MISMATCH');
      if(legacyReview.exportSha256!==undefined)requireValue(exported?.sha256===legacyReview.exportSha256,'LEGACY_REVIEW_RESULT_MISMATCH');
    }
    if(get('trio')) {try {readContractAttachment(get('trio').json);}catch {requireValue(false,'TRIO_COMMON_ATTACHMENT_INVALID');}}
    const context=get('context')?.json;
    if(context) requireValue((context.workId === undefined || context.workId === p.binding.workId) && (context.owner ?? context.ownerId) === p.binding.ownerId && context.projectId === p.binding.projectId
      && (context.pageId === undefined || context.pageId === p.binding.pageId) && context.sourceSha256 === get('source').sha256,'CONTEXT_BINDING_MISMATCH');
    const annotationPath=await containedPath(path.dirname(datasetPath),datasetPage.annotation.path);
    const annotation=parseJson(await readPinned(annotationPath,datasetPage.annotation.sha256));
    pages.push({...p,datasetPage,annotation,artifacts,get,state,report});
  }
  return {dataset,descriptor,validation,pages,datasetSha256,evidenceSha256};
}
