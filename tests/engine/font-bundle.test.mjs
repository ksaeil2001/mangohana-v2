import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {initializeProductionTypesetFontResource} from '../../packages/ai-engine/.build/compiled/src/main/productionTypesetFontResource.js';

test('the prepared engine bundle retains the signed Korean typesetting font',async()=>{
  const resources=path.resolve(fileURLToPath(new URL('../../packages/ai-engine/.build/resources/',import.meta.url)));
  const font=await initializeProductionTypesetFontResource(resources,{warn:()=>{}});
  assert.equal(font.enabled,true,'bundled signed Pretendard must pass the existing CMS and hash policy');
});
