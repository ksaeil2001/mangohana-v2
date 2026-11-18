// Offline real Electron Canvas runner. Uses the existing signed font resource.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const {app,protocol}=require('electron');
protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const [audit,buildName,runName,mode='probe',gateFilter]=process.argv.slice(2);
let window;
(async()=>{
 if(!path.isAbsolute(audit??'')||![buildName,runName].every(n=>/^[-a-z0-9]+$/.test(n??'')))throw Error('fresh explicit audit paths required');
 app.setPath('userData',await fs.mkdtemp(path.join(os.tmpdir(),'stage12-electron-')));
 await app.whenReady();
 const root=process.cwd(),out=path.join(audit,'evidence',runName);await fs.mkdir(out,{recursive:false});
 const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(root,'packages/ai-engine/.build/compiled/src/main/productionTypesetFontResource.js')).href);
 const font=await initializeProductionTypesetFontResource(path.join(root,'packages/ai-engine/.build/resources'));
 if(!font.enabled)throw Error('signed installed font unavailable');
 const {createRenderer}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
 const installed=buildName==='installed';
 const bundle=await fs.readFile(installed?path.join(root,'packages/ai-engine/.build/renderer.js'):path.join(audit,'evidence',buildName,'renderer.js'),'utf8');
 const fontRequests=[];
 window=await createRenderer({...font,handleProtocolRequest:async r=>{fontRequests.push(r.url);return font.handleProtocolRequest(r);}},bundle+(installed?'':'\nwindow.SitesCandidate=window.Stage12Product; void 0;'),new AbortController().signal);
 if(installed)await window.webContents.executeJavaScript('window.Stage12Product=window.SitesCandidate; void 0;',true);
 const browserMessages=[];window.webContents.on('console-message',(_event,...args)=>browserMessages.push(args));
 if(mode==='gates'){
  await window.webContents.executeJavaScript(await fs.readFile(path.join(root,'scripts/v2/stage12-gates-browser.js'),'utf8'),true);
  const result=await window.webContents.executeJavaScript('window.stage12Gates('+JSON.stringify(gateFilter??null)+')',true);
  result.artifacts=[];for(const image of result.images??[]){const file=image.id+'.png';await fs.writeFile(path.join(out,file),Buffer.from(image.pngBase64,'base64'),{flag:'wx'});result.artifacts.push(file);}delete result.images;
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({...result,fontRequests,browserMessages},null,2),{flag:'wx'});
  console.log(JSON.stringify(result));window.destroy();app.exit(result.failed?1:0);return;
 }
 if(mode==='review'){
  const {reviewFixtures}=await import('./stage12-review-fixtures.mjs'),fixtures=await reviewFixtures(audit),results=[];
  await window.webContents.executeJavaScript(await fs.readFile(path.join(root,'scripts/v2/stage12-review-browser.js'),'utf8'),true);
  for(const fixture of fixtures){
   const result=await window.webContents.executeJavaScript('window.stage12Review('+JSON.stringify(fixture)+')',true);
   const files={};for(const key of ['original','cleaned','result','ink','safe','suspects'])if(typeof result[key]==='string'){const name=fixture.id+'-'+key+'.png';await fs.writeFile(path.join(out,name),Buffer.from(result[key],'base64'),{flag:'wx'});files[key]=name;delete result[key];}
   results.push({...result,files});console.log(JSON.stringify({id:result.id,status:result.status,error:result.error,metrics:result.metrics,durationMs:result.durationMs}));
  }
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({kind:'ACTUAL_PRODUCT_RENDERER_VISUAL_COMPARISON',buildName,results,fontRequests,browserMessages,processMetrics:app.getAppMetrics(),mainMemory:process.memoryUsage(),humanReview:'pending',actualAiExecutions:0},null,2),{flag:'wx'});
  window.destroy();app.quit();return;
 }
 const result=await window.webContents.executeJavaScript(`(async()=>{
 const api=window.Stage12Product, canvas=document.createElement('canvas');canvas.width=480;canvas.height=600;
 const c=canvas.getContext('2d');c.fillStyle='#aaa';c.fillRect(0,0,480,600);c.fillStyle='white';c.beginPath();c.ellipse(240,300,180,230,0,0,Math.PI*2);c.fill();
 const background=canvas.toDataURL('image/png'),base={id:'a',order:1,pageNumber:1,sourceText:'synthetic',sourceLanguage:'ja',dialogueType:'speech',ocrEditStatus:'ai_proposed',parseConfidence:1,parseWarnings:[],typesetting:{bbox:{x:.43,y:.35,width:.14,height:.3},writingMode:'horizontal-tb'}};
 const trials=[];
 for(const [id,text] of [['normal','한국어 전체 문자를 보존합니다.'],['tofu','한글'+String.fromCodePoint(0x10ffff)],['manual-break','첫째\\n\\n둘째']]){
  try{const start=performance.now(),r=await api.renderCandidate(background,[{...base,aiTranslation:text}]);trials.push({id,status:'rendered',durationMs:performance.now()-start,...r});}catch(e){trials.push({id,status:'blocked',error:e.message});}
 }
 let fontProbe;try{const f=new FontFace('Stage12FontProbe','url(trio-resource://font/pretendard-variable.ttf)');await f.load();document.fonts.add(f);fontProbe={status:f.status,check:document.fonts.check('16px Stage12FontProbe','한글')};}catch(e){fontProbe={error:e.message};}
 return {kind:'ACTUAL_PRODUCT_CANVAS_PROBE',trials,version:navigator.userAgent,fontProbe,fontCheck:document.fonts.check('16px Pretendard','한글'),humanReview:'pending'};
 })()`,true);
 for(const t of result.trials)if(t.pngBase64){await fs.writeFile(path.join(out,t.id+'.png'),Buffer.from(t.pngBase64,'base64'),{flag:'wx'});delete t.pngBase64;}
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({...result,fontRequests,browserMessages,processMetrics:app.getAppMetrics(),mainMemory:process.memoryUsage()},null,2),{flag:'wx'});
 console.log(JSON.stringify({out,trials:result.trials.map(t=>({id:t.id,status:t.status,error:t.error}))}));
 window.destroy();app.quit();
})().catch(e=>{console.error(e.stack);if(window&&!window.isDestroyed())window.destroy();app.exit(1);});
