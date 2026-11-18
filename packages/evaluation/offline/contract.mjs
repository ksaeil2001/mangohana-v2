import { createHash } from 'node:crypto';

export const VERSION = 'stage06-v1';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const identifier = x => typeof x === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(x);
export const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const equal = (a,b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(x) { return Array.isArray(x) ? x.map(sorted) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])) : x; }
// Public failures contain fixed codes only, never paths, OCR, prompts or causes.
export function requireValue(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
export function keys(x, allowed, code = 'INVALID_EVIDENCE_DESCRIPTOR') {
  requireValue(object(x) && Object.keys(x).every(k=>allowed.includes(k)), code);
}
export const unknown = (reason, unit = 'count') => ({ value: null, unit, reason });
export function measured(value, unit = 'count') {
  requireValue(Number.isFinite(value) && value >= 0, 'INVALID_MEASUREMENT'); return { value, unit, reason: null };
}
export function ratio(numerator, denominator, reason = 'EMPTY_DENOMINATOR') {
  requireValue((numerator === null || Number.isFinite(numerator) && numerator >= 0) && (denominator === null || Number.isFinite(denominator) && denominator >= 0), 'INVALID_DENOMINATOR');
  return { numerator, denominator, value: numerator !== null && denominator > 0 ? numerator / denominator : null,
    reason: numerator !== null && denominator > 0 ? null : reason };
}
export function measurement(x) {
  keys(x, ['value','unit','reason'], 'INVALID_MEASUREMENT');
  requireValue(typeof x.unit === 'string' && (x.value === null ? identifier(x.reason) : Number.isFinite(x.value) && x.value >= 0 && x.reason === null), 'INVALID_MEASUREMENT');
  return x;
}
export const identityFields = ['ownerId','projectId','pageId','jobId','workId','sourceRevision','editRevision','contextRevision','processingGeneration','storageRevision'];
export function validateIdentity(x) {
  keys(x, identityFields); requireValue(identityFields.every(k=>Object.hasOwn(x,k)), 'INVALID_IDENTITY');
  for (const k of identityFields.slice(0,5)) requireValue(identifier(x[k]), 'INVALID_IDENTITY');
  for (const k of identityFields.slice(5)) requireValue(x[k] === null || Number.isSafeInteger(x[k]) && x[k] >= 0, 'INVALID_IDENTITY');
  return x;
}
export const SEMANTIC_ERRORS = ['omission','addition','polarity_reversal','quantity_number','name','honorific_register','speaker',
  'meaning_compression','tense_aspect_action','context','glossary','sfx_misclassification','unreadable_uncertain'];
export const IMAGE_ERRORS = ['source_residue','white_halo','preserved_sfx_damage','removal_mask_error','protection_intrusion',
  'outside_mask_change','inside_artwork_damage','bubble_border_damage','visual_defect'];
export const TYPESETTING_ERRORS = ['translation_render_id','missing_text','missing_glyph','safe_area','overflow','clipping','minimum_size',
  'long_korean','vertical_rotated','user_edit_rerender'];
export const SEVERITIES = ['critical','major','minor','uncertain'];
export const RENDER_PATHS = ['engine_png','canvas_after_user_edit','unknown'];
