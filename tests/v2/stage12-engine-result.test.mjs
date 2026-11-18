import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),api=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
test('rendered candidate cannot bypass the Main-owned image/OCR/translation identity by omission or mutation',()=>{
 assert.equal(typeof api.validateRendered,'function');
 const identity={contract:'stage12-input-v1',jobId:'job',ocrSha256:'a'.repeat(64),cleanedImageSha256:'b'.repeat(64)};
 const lines=[{id:'a'}],dimensions={width:10,height:20};
 const result={jobId:'job',...dimensions,typesettingIdentity:identity,layoutReport:[{id:'a',qaStatus:'pending',productionFontLoaded:true,glyphFontLoaded:true,reviewReasons:[]}]};
 assert.doesNotThrow(()=>api.validateRendered(result,'job',lines,dimensions,identity));
 for(const patch of [{typesettingIdentity:undefined},{typesettingIdentity:{...identity,ocrSha256:'0'.repeat(64)}},{jobId:'other'},{width:11},{layoutReport:[result.layoutReport[0],result.layoutReport[0]]}])assert.throws(()=>api.validateRendered({...result,...patch},'job',lines,dimensions,identity));
});
