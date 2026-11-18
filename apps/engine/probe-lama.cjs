// Administrator stage probe: replays the actual OCR mask, then the real LaMa worker.
// Does not alter the failed job or report it as a completed pipeline.
const {app,protocol}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const config=require(process.argv[2]);
const failedJob=process.argv[3];
const output=path.join(config.runRoot,'lama-stage-'+new Date().toISOString().replaceAll(':','-'));
require('node:fs').mkdirSync(output,{recursive:false});
for(const key of ['userData','sessionData','temp']){const p=path.join(output,key);require('node:fs').mkdirSync(p);app.setPath(key,p);}
protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.on('window-all-closed',()=>{});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let window;
async function main(){
 await app.whenReady();
 const source=await fs.readFile(path.join(failedJob,'normalized.png'));
 const ocr=JSON.parse(await fs.readFile(path.join(failedJob,'ocr.json'),'utf8'));
 const state=JSON.parse(await fs.readFile(path.join(failedJob,'state.json'),'utf8'));
 const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(config.buildRoot,'src/main/productionTypesetFontResource.js')).href);
 const font=await initializeProductionTypesetFontResource(config.resourcesPath,{warn:()=>{}});
 if(!font.enabled)throw new Error('FONT_UNAVAILABLE');
 const {createRenderer,rendererCall}=require(path.join(config.repository,'scripts/sites-local/engine.cjs'));
 const signal=AbortSignal.timeout(30_000);
 window=await createRenderer(font,await fs.readFile(config.rendererBundle,'utf8'),signal);
 if(process.argv[4]==='--font-only'){
  const result=await window.webContents.executeJavaScript(`(async()=>{try{const face=await new FontFace('Pretendard','url(trio-resource://font/pretendard-variable.ttf)').load();document.fonts.add(face);return {loaded:face.status,checked:document.fonts.check('16px "Pretendard"','한글')};}catch(error){return {loaded:false,name:error.name,message:error.message};}})()`);
  await fs.writeFile(path.join(output,'font-face.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,fontFace:result}));window.destroy();app.exit(0);return;
 }
 const prepared=await rendererCall(window,'prepare',{jobId:randomUUID(),ocr,width:state.width,height:state.height,sourcePngBase64:source.toString('base64'),sourceLanguage:'ja'},signal);
 const mask=Buffer.from(prepared.mask.maskPngBase64,'base64');
 await fs.writeFile(path.join(output,'removal-mask.png'),mask,{flag:'wx'});
 await fs.writeFile(path.join(output,'mask-report.json'),JSON.stringify({...prepared.mask,maskPngBase64:undefined,scope:'ACTUAL_OCR_REPLAY',sourceJob:failedJob,sourceSha256:sha(source),maskSha256:sha(mask)},null,2),{flag:'wx'});
 if(process.argv[4]==='--typeset-only'){
  const translated=JSON.parse(await fs.readFile(path.join(failedJob,'translations.json'),'utf8'));
  if(translated.lines.length!==prepared.lines.length||translated.lines.some((line,i)=>line.id!==prepared.lines[i].id||line.sourceText!==prepared.lines[i].sourceText||line.userTranslation!==undefined))throw new Error('TRANSLATION_ID');
  const cleaned=await fs.readFile(path.join(failedJob,'cleaned.png'));
  const result=await rendererCall(window,'render',{jobId:prepared.jobId,cleanedPngBase64:cleaned.toString('base64'),lines:translated.lines},AbortSignal.timeout(30_000));
  await fs.writeFile(path.join(output,'candidate.png'),Buffer.from(result.pngBase64,'base64'),{flag:'wx'});
  await fs.writeFile(path.join(output,'layout.json'),JSON.stringify({...result,pngBase64:undefined,scope:'TYPESET_STAGE_ONLY'},null,2),{flag:'wx'});
  console.log(JSON.stringify({output,typesetStageOnly:true,regions:result.layoutReport.length}));window.destroy();app.exit(0);return;
 }
 window.destroy();window=undefined;
 const {secretlessEnvironment}=require(path.join(config.repository,'scripts/sites-local/engine-boundaries.cjs'));
 const child=spawn(config.python,['-I','-B',path.join(config.repository,'scripts/sites-local/lama-stdio.py'),'--python',config.python,'--worker',config.lamaWorker,'--model',config.lamaModel,'--tile-wrapper',config.lamaTileWrapper,'--log-dir',output],{cwd:path.dirname(config.python),windowsHide:true,stdio:['pipe','pipe','pipe'],env:secretlessEnvironment(config.python,path.join(output,'temp'))});
 let raw='',stderrBytes=0;
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
 const timer=setTimeout(()=>child.kill('SIGKILL'),100_000);
 child.stderr.on('data',data=>{stderrBytes+=data.length;});
 const response=new Promise((resolve,reject)=>{
  child.stdout.on('data',data=>{raw+=data;if(raw.length>48*1024*1024){child.kill();reject(new Error('OUTPUT_LIMIT'));}else if(raw.includes('\n'))resolve();});
  child.once('close',()=>raw.includes('\n')?resolve():reject(new Error('NO_RESPONSE')));
 });
 child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({image:source.toString('base64'),mask:mask.toString('base64')})+'\n');
 try{
  await response;const result=JSON.parse(raw.trim());
  if(result.ok&&result.imagePngBase64)await fs.writeFile(path.join(output,'cleaned.png'),Buffer.from(result.imagePngBase64,'base64'),{flag:'wx'});
  delete result.imagePngBase64;
  await fs.writeFile(path.join(output,'response.json'),JSON.stringify({...result,stderrBytes,scope:'LAMA_STAGE_ONLY'},null,2),{flag:'wx'});
  console.log(JSON.stringify({output,...result,stderrBytes}));
 }finally{clearTimeout(timer);child.stdin.end();await done;}
 app.exit(0);
}
main().catch(error=>{window?.destroy();console.error(error);app.exit(1);});
