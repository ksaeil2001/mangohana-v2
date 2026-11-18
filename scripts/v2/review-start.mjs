// Translation storage only. Never start Electron, the existing job queue or any model.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {createTranslationReviewApplication} from '../../apps/engine/store.mjs';
import {createImportedPageInspector} from '../../apps/engine/imported-page-inspector.mjs';
import {createImportedPageController} from '../../apps/engine/imported-page-controller.mjs';
import {createStage14Preflight,STAGE14_IMAGE_OUTPUT_ROOT} from '../../apps/engine/imported-page-preflight.mjs';
import {createImportedPageRuntime,verifyImportedOutput} from '../../apps/engine/imported-page-runtime.mjs';
import {createTypesettingResumeSource} from '../../apps/engine/typesetting-resume-source.mjs';
import {createTypesettingOnlyController} from '../../apps/engine/typesetting-only-controller.mjs';
import {createTypesettingOnlyPreflight} from '../../apps/engine/typesetting-only-preflight.mjs';
import {createReadOnlyReadabilityReview} from '../../apps/engine/layout-readability-presentation.mjs';
import {createRoiExpansionService} from '../../apps/engine/layout-roi-service.mjs';
import {createTypesettingLayoutAdapter} from '../../apps/engine/typesetting-layout-adapter.mjs';
import {createLayoutSourceLoader} from '../../apps/engine/layout-review-source.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--config'&&path.isAbsolute(args[1])))throw Error('사용법: node scripts/v2/review-start.mjs [--config <기존 관리자 설정 절대 경로>]');
const config=JSON.parse(await fs.readFile(args[1]??'E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
if(!path.isAbsolute(config.dataRoot??'')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.siteOrigin??''))throw Error('기존 dataRoot와 loopback 사이트 Origin을 확인해 주세요.');
// Do not open a second context writer beside an older Electron host.
if(path.isAbsolute(config.runRoot??'')){
 let runtime;try{runtime=JSON.parse(await fs.readFile(path.join(config.runRoot,'runtime.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(runtime?.status==='listening'&&Number.isSafeInteger(runtime.pid)&&runtime.pid>0){let live=false;try{process.kill(runtime.pid,0);live=true;}catch(e){if(e.code!=='ESRCH')throw e;}if(live)throw Error('기존 망고하나 앱이 실행 중입니다. 종료한 뒤 번역 저장 전용 작업실을 열어 주세요.');}
}
const inspector=createImportedPageInspector();
const typesettingSource=createTypesettingResumeSource({permitRoot:path.join(config.dataRoot,'image-execution-permits'),outputRoot:STAGE14_IMAGE_OUTPUT_ROOT});
const comparisonOptions={packFile:path.join(root,'docs/validation/stage14r3-roi-approval-20261118/evidence/comparison-roi.json'),permitRoot:path.join(config.dataRoot,'image-execution-permits'),outputRoot:STAGE14_IMAGE_OUTPUT_ROOT,sourceResolver:typesettingSource};
const app=await createTranslationReviewApplication({dataRoot:config.dataRoot,allowedOrigin:config.siteOrigin,inspectImportedPage:inspector,
 roiExpansionFactory:({run,store,measureText})=>createRoiExpansionService({root:path.join(config.dataRoot,'layout-roi-approvals'),run,store,measureText,presentation:createReadOnlyReadabilityReview(comparisonOptions)}),
 readabilityReviewFactory:reviewStore=>createReadOnlyReadabilityReview({reviewStore,...comparisonOptions}),
 imageControllerFactory:reviewStore=>createImportedPageController({root:path.join(config.dataRoot,'image-execution-permits'),outputRoot:STAGE14_IMAGE_OUTPUT_ROOT,reviewStore,inspectInputs:inspector,
  preflight:createStage14Preflight(),runPipeline:createImportedPageRuntime(),verifyOutput:verifyImportedOutput}),
 typesettingControllerFactory:(reviewStore,roi)=>{const sourceResolver=createTypesettingResumeSource({permitRoot:path.join(config.dataRoot,'image-execution-permits'),outputRoot:STAGE14_IMAGE_OUTPUT_ROOT,layoutAdapter:createTypesettingLayoutAdapter({authorize:(b,c)=>roi.authorizeAdapter(b,c),loadSource:createLayoutSourceLoader()})});return createTypesettingOnlyController({root:path.join(config.dataRoot,'image-execution-permits'),outputRoot:STAGE14_IMAGE_OUTPUT_ROOT,reviewStore,sourceResolver,preflight:createTypesettingOnlyPreflight({sourceResolver}),runPipeline:createImportedPageRuntime({executionMode:'TYPESETTING_ONLY'}),verifyOutput:verifyImportedOutput});}});
let frontend,stopping=false;
async function stop(code=0){if(stopping)return;stopping=true;frontend?.kill();try{await app.close();}catch{code=1;}process.exitCode=code;}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
try{
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const port=app.server.address().port;
 frontend=spawn(process.execPath,[path.join(root,'apps/sites/scripts/run-framework.mjs'),'dev'],{cwd:path.join(root,'apps/sites'),windowsHide:true,stdio:'inherit',env:{...process.env,MANGOHANA_ENGINE_URL:'http://127.0.0.1:'+port}});
 frontend.once('error',e=>{console.error(e.message);void stop(1);});frontend.once('exit',code=>void stop(code??1));
 console.log('검수 작업실: '+config.siteOrigin+' · /review-image 에서 한 페이지 실행 준비 · 별도 사용자 승인 전 이미지 실행 권한 없음 · 계정 인증 NOT_AVAILABLE');
}catch(e){console.error(e.message);await stop(1);}
