import { digest, hash, identifier, keys, requireValue } from './offline/contract.mjs';

const invalid = 'INVALID_STAGE16_MATRIX';
const modelSlots = ['A', 'B'];
const variants = ['baseline', 'improved'];
const commonPins = ['sourceSha256', 'fontSha256', 'settingsSha256', 'contextSnapshotSha256'];
const sharedFields = ['workId', 'pageId', ...commonPins, 'intermediateSha256'];

function requireFields(record, fields) {
  keys(record, fields, invalid);
  requireValue(fields.every(field => Object.hasOwn(record, field)), invalid);
}

function validatePair(pins, labels, identicalCode) {
  requireFields(pins, labels);
  requireValue(labels.every(label => digest(pins[label])), invalid);
  requireValue(pins[labels[0]] !== pins[labels[1]], identicalCode);
}

/** Builds a single page's planned comparisons from version fingerprints supplied by the caller. */
export function createConditionMatrix(input) {
  requireFields(input, ['shared', 'models', 'processing']);
  const { shared, models, processing } = input;
  requireFields(shared, sharedFields);
  requireValue(identifier(shared.workId) && identifier(shared.pageId), invalid);
  requireValue(commonPins.every(field => digest(shared[field])), invalid);
  requireValue(shared.intermediateSha256 === null || digest(shared.intermediateSha256), invalid);
  validatePair(models, modelSlots, 'STAGE16_MODEL_PINS_IDENTICAL');
  validatePair(processing, variants, 'STAGE16_PROCESSING_PINS_IDENTICAL');

  const conditions = [];
  for (const model of modelSlots) {
    for (const variant of variants) {
      conditions.push({
        model, modelSha256: models[model],
        processing: variant, processingSha256: processing[variant],
      });
    }
  }
  // Hash the compact JSON in schema order, independent of input property order.
  const matrix = {
    schemaVersion: 1, kind: 'stage16-condition-matrix',
    shared: Object.fromEntries(sharedFields.map(field => [field, shared[field]])),
    conditions,
  };
  return { ...matrix, matrixSha256: hash(JSON.stringify(matrix)) };
}
