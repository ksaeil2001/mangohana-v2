import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {createHash,randomUUID} from 'node:crypto';import {createWarmJob} from '../../scripts/v2/warm-job.mjs';
const repository=process.cwd(),require=createRequire(path.join(repository,'packages/ai-engine/package.json')),sharp=require('sharp'),sha=b=>createHash('sha256').update(b).digest('hex');
test('real Stage12 font and painter verify synthetic colored, manual and legacy white layouts, rejecting artwork/mask violations',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'background-native-')),runId='background-synthetic-'+randomUUID(),control=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests',runId);await fs.mkdir(control);
 const {build}=await import(pathToFileURL(require.resolve('vite')).href),sitesRenderer=path.join(repository,'packages/ai-engine/vendor/trio/scripts/sites-local/renderer.ts');await build({configFile:false,root:repository,logLevel:'silent',plugins:[{name:'synthetic-prepared-state-only',transform(code,id){if(path.resolve(id)===sitesRenderer)return code+'\nexport function seedSyntheticPrepared(data){activeJobId=data.jobId;preparedIdentity=data.identity;preparedLines=structuredClone(data.lines);preparedIds=data.lines.map(l=>l.id);protectedBoxes=[];return true;}';}}],build:{commonjsOptions:{include:[/node_modules/,/quality[\\/](?:background-layout|korean-utterance)\.cjs$/]},emptyOutDir:false,minify:false,outDir:root,lib:{entry:path.join(repository,'tests/v2/fixtures/background-renderer-entry.ts'),name:'SyntheticBackground',formats:['iife'],fileName:()=> 'synthetic.js'}}});
 const width=320,height=240,bbox={x:.3,y:.25,width:.3,height:.45},cases=[];
 const bitmap=color=>{const b=Buffer.alloc(width*height*4);for(let i=0;i<b.length;i+=4)b.set([...color,255],i);return b;};
 for(const name of ['gray','blue','manual-safe','texture','protected-change','manual-edge','closed-white','closed-inset','closed-inset-oversize',
  'gray-auto-inset','gray-auto-shallow','gray-auto-texture','gray-auto-center-line','gray-auto-too-long','gray-auto-protected']){
  const color=name==='blue'?[25,50,100]:[180,180,180],cleaned=bitmap(color),source=bitmap(color),mask=bitmap([255,255,255]);
  if(name.startsWith('closed-')){const right=name==='closed-white'?270:150,bottom=name==='closed-white'?220:180;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const rgb=x>=40&&x<right&&y>=20&&y<bottom?[255,255,255]:[0,0,0],at=(y*width+x)*4;cleaned.set([...rgb,255],at);source.set([...rgb,255],at);}}
  for(let y=80;y<86;y++)for(let x=105;x<112;x++){source.set([0,0,0,255],(y*width+x)*4);mask[(y*width+x)*4+3]=0;}
  if(name==='texture')for(let y=55;y<165;y++)for(let x=95;x<195;x++)if(x%4===0){const at=(y*width+x)*4;source.set([90,90,90,255],at);cleaned.set([90,90,90,255],at);mask[at+3]=255;}
  if(name.startsWith('gray-auto-'))for(let y=56;y<170;y++)for(let x=92;x<198;x++){
   const dark=name==='gray-auto-texture'?x%7<2:name==='gray-auto-center-line'?y>=108&&y<120:
    name==='gray-auto-shallow'?y>=81&&y<91||y>=137&&y<147:y>=145&&y<156;
   if(dark){const at=(y*width+x)*4;source.set([85,85,85,255],at);cleaned.set([85,85,85,255],at);mask[at+3]=255;}
  }
  if(name.startsWith('manual')){const x=name==='manual-edge'?144:184;for(let y=50;y<180;y++){const at=(y*width+x)*4;source.set([20,20,20,255],at);cleaned.set([20,20,20,255],at);mask[at+3]=255;}}
  if(name==='protected-change')cleaned[0]--;
  const caseBbox=name.startsWith('closed-inset')?{x:39/width,y:30/height,width:112/width,height:145/height}:bbox;
  const encode=b=>sharp(b,{raw:{width,height,channels:4}}).png().toBuffer(),s=await encode(source),c=await encode(cleaned),m=await encode(mask),text=name.startsWith('manual')?'합성':['closed-inset-oversize','gray-auto-too-long'].includes(name)?'가'.repeat(60):name==='gray-auto-shallow'?'아싸~!':'합성 배경',lines=[{id:'synthetic-region',order:1,pageNumber:1,sourceText:'synthetic source',aiTranslation:text,ocrEditStatus:'ai_proposed',typesetting:{bbox:caseBbox,writingMode:'horizontal-tb'}}],manualEntries=name.startsWith('manual')?[{id:lines[0].id,bbox:caseBbox,fontSizePx:20,lineHeight:1.5,text}]:[];
  cases.push({name,cleaned:c.toString('base64'),lines,options:{expectedDimensions:{width,height},
    ...(name==='gray-auto-protected'?{protectedBoxes:[{x:140/width,y:102/height,width:18/width,height:20/height}]}:{}),
    backgroundContext:{sourcePngBase64:s.toString('base64'),maskPngBase64:m.toString('base64'),sourceSha256:sha(s),cleanedSha256:sha(c),maskSha256:sha(m),allowedBoxes:[{id:lines[0].id,bbox:{x:.1,y:.1,width:.8,height:.8}}],manualEntries,...(manualEntries.length?{manualApprovalSha256:'d'.repeat(64)}:{}),...(name.startsWith('gray-auto-')?{nonWhiteFallback:true}:{})}}});
 }
 const shallow = cases.find(row => row.name === 'gray-auto-shallow');
 const [grayLine] = shallow.lines;
 const narrowGrayBbox = { ...grayLine.typesetting.bbox, x: 126 / width, width: 68 / width };
 const fixedGray = { ...shallow, lines: [{ ...grayLine, typesetting: { ...grayLine.typesetting, bbox: narrowGrayBbox } }] };
 const openGray = { ...shallow.options, backgroundContext: { ...shallow.options.backgroundContext, allowedBoxes: [] } };
 cases.push({ ...fixedGray, name: 'gray-auto-grow-fixed' });
 cases.push({ ...fixedGray, name: 'gray-auto-grow', options: openGray });
 cases.push({ ...fixedGray, name: 'gray-auto-grow-protected', options: {
   ...openGray, protectedBoxes: [{ x: 110 / width, y: 108 / height, width: 10 / width, height: 10 / height }],
 } });
 {
  const source=bitmap([0,0,0]),cleaned=bitmap([0,0,0]),mask=bitmap([255,255,255]);
  for(let y=20;y<220;y++)for(let x=40;x<270;x++){source.set([255,255,255,255],(y*width+x)*4);cleaned.set([255,255,255,255],(y*width+x)*4);}
  for(let y=80;y<86;y++)for(let x=105;x<112;x++){source.set([0,0,0,255],(y*width+x)*4);mask[(y*width+x)*4+3]=0;}
  const encode=b=>sharp(b,{raw:{width,height,channels:4}}).png().toBuffer(),s=await encode(source),c=await encode(cleaned),m=await encode(mask),lines=[
   {id:'shared-a',order:1,pageNumber:1,sourceText:'source a',aiTranslation:'합성 배경',ocrEditStatus:'ai_proposed',typesetting:{bbox:{x:39/width,y:40/height,width:101/width,height:120/height},writingMode:'horizontal-tb'}},
   {id:'shared-b',order:2,pageNumber:1,sourceText:'source b',aiTranslation:'네!',ocrEditStatus:'ai_proposed',typesetting:{bbox:{x:180/width,y:60/height,width:60/width,height:100/height},writingMode:'horizontal-tb'}}
  ];
  cases.push({name:'shared-inset',cleaned:c.toString('base64'),lines,options:{expectedDimensions:{width,height},backgroundContext:{sourcePngBase64:s.toString('base64'),maskPngBase64:m.toString('base64'),sourceSha256:sha(s),cleanedSha256:sha(c),maskSha256:sha(m),allowedBoxes:lines.map(l=>({id:l.id,bbox:l.typesetting.bbox})),manualEntries:[]}}});
  const narrow = [
    { ...lines[0], aiTranslation: '기다려줘!', typesetting: {
      ...lines[0].typesetting, bbox: { x: 85 / width, y: 60 / height, width: 32 / width, height: 112 / height },
    } },
    { ...lines[1], typesetting: { ...lines[1].typesetting, bbox: { x: 142 / width, y: 60 / height, width: 48 / width, height: 100 / height } } },
  ];
  const autoSource = Buffer.from(source), autoCleaned = Buffer.from(cleaned);
  for (let y = 20; y < 220; y++) for (let x = 40; x < 270; x++) {
    if (x >= 52 && x < 218) continue;
    const at = (y * width + x) * 4;
    autoSource.set([0, 0, 0, 255], at);
    autoCleaned.set([0, 0, 0, 255], at);
  }
  const autoSourcePng = await encode(autoSource), autoCleanedPng = await encode(autoCleaned);
  for (const name of ['shared-auto-before', 'shared-auto-after', 'shared-auto-protected', 'shared-auto-search-edge',
    'shared-auto-wrap-before', 'shared-auto-wrap-after', 'shared-auto-grow-before', 'shared-auto-grow-after']) {
    const sourcePng = name === 'shared-auto-search-edge' ? s : autoSourcePng;
    const cleanedPng = name === 'shared-auto-search-edge' ? c : autoCleanedPng;
    const text = name.startsWith('shared-auto-grow-') ? '나도 조금 더 같이 갈래' : name.startsWith('shared-auto-wrap-') ? '같이 가자' : narrow[0].aiTranslation;
    const caseLines = [{ ...narrow[0], aiTranslation: text }, narrow[1]];
    cases.push({ name, cleaned: cleanedPng.toString('base64'), lines: caseLines, options: {
      expectedDimensions: { width, height },
      backgroundContext: { sourcePngBase64: sourcePng.toString('base64'), maskPngBase64: m.toString('base64'), sourceSha256: sha(sourcePng),
        cleanedSha256: sha(cleanedPng), maskSha256: sha(m), allowedBoxes: [], nonWhiteFallback: true,
        ...(name.endsWith('-before') ? {} : { widenSharedBalloon: true }) },
      ...(name === 'shared-auto-protected' ? { protectedBoxes: [{ x: 54 / width, y: 85 / height, width: 8 / width, height: 30 / height }] } : {}),
    } });
  }
  // Three intact words still take three rows in either box. The extra
  // horizontal room should be spent on larger type at the same reading order.
  const sameRows = cases.find(row => row.name === 'shared-auto-after');
  const sameRowLines = [
    { ...narrow[0], aiTranslation: '조그만 발걸음 소중해', typesetting: {
      ...narrow[0].typesetting, bbox: { x: 75 / width, y: 57 / height, width: 52 / width, height: 122 / height },
    } }, narrow[1],
  ];
  for (const widen of [false, true]) {
    cases.push({ ...sameRows, name: 'shared-auto-same-rows-' + widen, lines: sameRowLines,
      options: { ...sameRows.options, backgroundContext: { ...sameRows.options.backgroundContext, widenSharedBalloon: widen } } });
  }
 }
 {
  // The full-height inset is narrow, but a whole horizontal utterance fits
  // across the rounded shoulders at the same center. Compare the actual PNG.
  const cleaned = bitmap([0, 0, 0]);
  for (let y = 20; y < 220; y++) {
    const halfWidth = Math.floor(74 * Math.sqrt(1 - ((y - 120) / 100) ** 2));
    for (let x = 160 - halfWidth; x < 160 + halfWidth; x++) cleaned.set([255, 255, 255, 255], (y * width + x) * 4);
  }
  const png = await sharp(cleaned, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const solidMask = await sharp(bitmap([255, 255, 255]), { raw: { width, height, channels: 4 } }).png().toBuffer();
  const bbox = { x: 138 / width, y: 60 / height, width: 44 / width, height: 120 / height };
  const lines = [{ id: 'solo', order: 1, pageNumber: 1, sourceText: 'source', aiTranslation: '따뜻하다~',
    ocrEditStatus: 'ai_proposed', typesetting: { bbox, writingMode: 'horizontal-tb' } }];
  for (const name of ['solo-band-auto', 'solo-band-fixed', 'solo-band-protected']) {
    const allowedBoxes = name === 'solo-band-fixed' ? [{ id: 'solo', bbox: { x: 0, y: 0, width: 1, height: 1 } }] : [];
    cases.push({ name, cleaned: png.toString('base64'), lines, options: { expectedDimensions: { width, height },
      backgroundContext: { sourcePngBase64: png.toString('base64'), maskPngBase64: solidMask.toString('base64'),
        sourceSha256: sha(png), cleanedSha256: sha(png), maskSha256: sha(solidMask), allowedBoxes, nonWhiteFallback: true },
      ...(name === 'solo-band-protected' ? { protectedBoxes: [{ x: 101 / width, y: 116 / height, width: 4 / width, height: 8 / height }] } : {}) } });
  }
  for (const [name, source, text] of [
    ['solo-request-fixed', 'solo-band-fixed', '기다려도 돼?'],
    ['solo-request-auto', 'solo-band-auto', '기다려도 돼?'],
    ['solo-request-hard-break', 'solo-band-auto', '기다려도\n돼?'],
    ['solo-title-auto', 'solo-band-auto', '아... 고마워 미나 씨...'],
    ['solo-title-authored', 'solo-band-auto', '아... 고마워 미나\n씨...'],
  ]) {
    const example = cases.find(item => item.name === source);
    cases.push({ ...example, name, lines: [{ ...lines[0], aiTranslation: text }] });
  }
  const title = cases.find(item => item.name === 'solo-title-auto');
  // The normal box starts at 108px. Keep one source-art pixel in the extra
  // horizontal strip used by the shorter three-line box.
  cases.push({ ...title, name: 'solo-title-protected', options: { ...title.options,
    protectedBoxes: [{ x: 107 / width, y: 116 / height, width: 1 / width, height: 8 / height }] } });
 }
 for (const name of ['erased-band', 'erased-band-white-center', 'erased-band-no-ink', 'erased-band-one-dot', 'erased-band-protected','erased-band-tone','erased-band-tone-mark','erased-band-tone-protected']) {
  const cleaned = bitmap([180, 180, 180]), mask = bitmap([255, 255, 255]);
  const bbox = { x: 80 / width, y: 35 / height, width: 160 / width, height: 170 / height };
  for (let y = 30; y < 210; y++) for (let x = 75; x < 245; x++) {
    const stripe = name.startsWith('erased-band-tone') && (y<155 || y>=181) ? [215,214,212] : [208,207,205];
    const color = y >= 145 && y < 194 ? stripe : x % 6 < 3 ? [98, 98, 98] : [165, 165, 165];
    const white = name === 'erased-band-white-center' && x >= 150 && x < 170 && y >= 106 && y < 134;
    cleaned.set(white ? [255, 255, 255, 255] : [...color, 255], (y * width + x) * 4);
  }
  if(name==='erased-band-tone-mark')cleaned.set([0,0,0,255],(184*width+150)*4);
  const source = Buffer.from(cleaned);
  const starts = name === 'erased-band-one-dot' ? [150] : [110, 145, 180];
  const glyphY = name === 'erased-band-no-ink' ? 78 : 156;
  for (const start of starts) for (let y = glyphY; y < glyphY + (name === 'erased-band-one-dot' ? 5 : 20); y++) for (let x = start; x < start + 5; x++) {
    const at = (y * width + x) * 4;
    source.set([12, 12, 12, 255], at);
    mask[at + 3] = 0;
  }
  const encode = data => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const [s, c, m] = await Promise.all([source, cleaned, mask].map(encode));
  const lines = [{ id: 'translucent', order: 1, pageNumber: 1, sourceText: 'source', aiTranslation: '이제야 왔네!',
    ocrEditStatus: 'ai_proposed', typesetting: { bbox, writingMode: 'horizontal-tb' } }];
  cases.push({ name, cleaned: c.toString('base64'), lines, options: { expectedDimensions: { width, height },
    ...(name === 'erased-band-protected' ? { protectedBoxes: [{ x: 150 / width, y: 153 / height, width: 22 / width, height: 29 / height }] } : {}),
    ...(name === 'erased-band-tone-protected' ? {protectedBoxes:[{x:150/width,y:184/height,width:1/width,height:1/height}]} : {}),
    backgroundContext: { sourcePngBase64: s.toString('base64'), maskPngBase64: m.toString('base64'), sourceSha256: sha(s),
      cleanedSha256: sha(c), maskSha256: sha(m), allowedBoxes: [], nonWhiteFallback: true } } });
 }
 await fs.writeFile(path.join(root,'input.json'),JSON.stringify({kind:'SYNTHETIC_BACKGROUND_RENDERER_TEST',width,height,cases,bundle:path.join(root,'synthetic.js'),productionBundle:path.join(repository,'packages/ai-engine/.build/renderer.js'),config:{buildRoot:path.join(repository,'packages/ai-engine/.build/compiled'),resourcesPath:path.join(repository,'packages/ai-engine/.build/resources')}}),{flag:'wx'});
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));Object.assign(env,{TEMP:root,TMP:root,LOCALAPPDATA:process.env.LOCALAPPDATA??root,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
 let job,log='';try{job=await createWarmJob({directory:control,runId,executable:path.join(repository,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(repository,'tests/v2/fixtures/background-renderer-worker.cjs'),root,'--disable-gpu'],cwd:repository,env,maxLifetimeMs:90000,onStdout:b=>{log+=b;},onStderr:b=>{log+=b;}});await job.resume();const completion=await job.completion;await fs.writeFile(path.join(root,'controller.json'),JSON.stringify(completion,null,2));await fs.writeFile(path.join(root,'runtime.log'),log);
  const result=JSON.parse(await fs.readFile(path.join(root,'result.json')));t.diagnostic('SYNTHETIC_BACKGROUND_EVIDENCE='+root);assert.equal(completion.kernelCleanupConfirmed,true);assert.equal(completion.activeProcessesAfter,0);assert.equal(completion.rootExitCode,0);
  for(const name of ['gray','blue','manual-safe','closed-white','closed-inset'])assert.equal(result.results.find(r=>r.name===name)?.ok,true,JSON.stringify(result.results));
  for(const name of ['texture','protected-change','manual-edge','closed-inset-oversize'])assert.equal(result.results.find(r=>r.name===name)?.ok,false,JSON.stringify(result.results));
  const inset=result.results.find(r=>r.name==='closed-inset');assert.equal(inset.basis,'CLOSED_WHITE_COMPONENT_INSET_RECTANGLE');assert.ok(inset.manualFont>12);assert.deepEqual(inset.bbox,{x:45/width,y:30/height,width:100/width,height:145/height});
  assert.equal(result.results.find(r=>r.name==='blue').color,'#ffffff');assert.equal(result.results.find(r=>r.name==='gray').basis,'UNIFORM_BACKGROUND_INSET_RECTANGLE');assert.equal(result.results.find(r=>r.name==='manual-safe').basis,'USER_REVIEWED_PROTECTED_ROI_RECTANGLE');assert.equal(result.results.find(r=>r.name==='closed-white').basis,'CLOSED_WHITE_COMPONENT_INSET_RECTANGLE');assert.equal(result.structuredFailure.failure.code,'MANUAL_LAYOUT_REQUIRED');assert.equal(result.structuredFailure.failure.layoutDiagnostics.rejectedRegion,'synthetic-region');assert.ok(result.structuredFailure.failure.layoutDiagnostics.reasonCodes.includes('BACKGROUND_NOT_UNIFORM'));assert.equal(result.actualModels,0);assert.equal(result.actualPage,false);assert.ok(!(await fs.readdir(root)).some(n=>/\.png$/i.test(n)));
  assert.equal(result.results.find(r=>r.name==='shared-inset').ok,true);
  assert.equal(result.results.find(r=>r.name==='shared-inset').independentPixels.changedOutsideVerifiedAreas,0);
  const grayInset = result.results.find(row => row.name === 'gray-auto-inset');
  assert.equal(grayInset?.ok, true, JSON.stringify(grayInset));
  assert.equal(grayInset.changedOutsideBoxes, 0);
  const grayRegion = grayInset.regions[0];
  assert.equal(grayRegion.basis, 'UNIFORM_BACKGROUND_INSET_RECTANGLE');
  assert.ok(grayRegion.safe && grayRegion.complete && !grayRegion.missingGlyphs && grayRegion.fontSizePx >= 13);
  assert.ok(grayRegion.bbox.x >= bbox.x && grayRegion.bbox.y >= bbox.y);
  assert.ok(grayRegion.bbox.x + grayRegion.bbox.width <= bbox.x + bbox.width + 1e-12);
  const anchorY = bbox.y + bbox.height / 2;
  assert.ok(grayRegion.bbox.y < anchorY && grayRegion.bbox.y + grayRegion.bbox.height > anchorY);
  assert.ok(grayRegion.bbox.y + grayRegion.bbox.height < 145 / height);
  const shallowGray = result.results.find(row => row.name === 'gray-auto-shallow');
  assert.equal(shallowGray?.ok, true, JSON.stringify(shallowGray));
  assert.equal(shallowGray.changedOutsideBoxes, 0);
  assert.equal(shallowGray.regions[0].lineCount, 1);
  assert.ok(shallowGray.regions[0].fontSizePx >= 22, JSON.stringify(shallowGray.regions[0]));
  const fixedGrow = result.results.find(row => row.name === 'gray-auto-grow-fixed');
  const grownGray = result.results.find(row => row.name === 'gray-auto-grow');
  assert.equal(fixedGrow?.ok, true, JSON.stringify(fixedGrow));
  assert.equal(grownGray?.ok, true, JSON.stringify(grownGray));
  assert.ok(grownGray.regions[0].fontSizePx > fixedGrow.regions[0].fontSizePx, JSON.stringify(grownGray));
  assert.ok(grownGray.regions[0].bbox.width > fixedGrow.regions[0].bbox.width);
  assert.equal(grownGray.regions[0].lineCount, 1);
  assert.ok(grownGray.regions[0].safe && grownGray.regions[0].complete && !grownGray.regions[0].missingGlyphs);
  assert.equal(grownGray.changedOutsideBoxes, 0);
  const protectedGrow = result.results.find(row => row.name === 'gray-auto-grow-protected');
  assert.equal(protectedGrow?.ok, true, JSON.stringify(protectedGrow));
  assert.deepEqual(protectedGrow.regions, fixedGrow.regions);
  for (const name of ['gray-auto-texture', 'gray-auto-center-line', 'gray-auto-too-long', 'gray-auto-protected']) {
    const blocked = result.results.find(row => row.name === name);
    assert.equal(blocked?.code, 'MANUAL_LAYOUT_REQUIRED', JSON.stringify(blocked));
  }
  const sharedBefore = result.results.find(row => row.name === 'shared-auto-before');
  const sharedAfter = result.results.find(row => row.name === 'shared-auto-after');
  const sharedProtected = result.results.find(row => row.name === 'shared-auto-protected');
  assert.equal(sharedBefore?.ok, false);
  assert.equal(sharedBefore?.code, 'MANUAL_LAYOUT_REQUIRED');
  assert.equal(sharedAfter?.ok, true, JSON.stringify(sharedAfter));
  assert.equal(sharedAfter.changedOutsideBoxes, 0);
  assert.deepEqual(sharedAfter.regions.map(region => [region.id, region.text]), [['shared-a', '기다려줘!'], ['shared-b', '네!']]);
  assert.ok(sharedAfter.regions[0].fontSizePx >= 13 && sharedAfter.regions[0].bbox.x + sharedAfter.regions[0].bbox.width < 129.5 / width);
  assert.ok(sharedAfter.regions[1].bbox.x > 129.5 / width);
  const shorterBefore = sharedBefore.measurements.find(region => region.id === 'shared-b');
  assert.ok(shorterBefore?.fontSizePx >= 13, 'the other line already fits before widening');
  assert.equal(sharedAfter.regions[1].fontSizePx, shorterBefore.fontSizePx);
  assert.deepEqual(sharedAfter.regions[1].bbox, shorterBefore.bbox);
  for (const region of sharedAfter.regions) assert.ok(region.complete && region.safe && !region.missingGlyphs);
  assert.equal(sharedProtected?.ok, false);
  assert.equal(sharedProtected?.code, 'MANUAL_LAYOUT_REQUIRED');
  assert.equal(result.results.find(row => row.name === 'shared-auto-search-edge')?.ok, false);
  const wrapBefore = result.results.find(row => row.name === 'shared-auto-wrap-before');
  const wrapAfter = result.results.find(row => row.name === 'shared-auto-wrap-after');
  assert.equal(wrapBefore?.ok, true, JSON.stringify(wrapBefore));
  assert.equal(wrapAfter?.ok, true, JSON.stringify(wrapAfter));
  assert.equal(wrapBefore.regions[0].lineCount, 2);
  assert.equal(wrapAfter.regions[0].lineCount, 1);
  assert.equal(wrapAfter.regions[0].fontSizePx, wrapBefore.regions[0].fontSizePx);
  assert.equal(wrapAfter.changedOutsideBoxes, 0);
  const growBefore = result.results.find(row => row.name === 'shared-auto-grow-before');
  const growAfter = result.results.find(row => row.name === 'shared-auto-grow-after');
  assert.equal(growBefore?.ok, true, JSON.stringify(growBefore));
  assert.equal(growAfter?.ok, true, JSON.stringify(growAfter));
  assert.ok(growAfter.regions[0].fontSizePx > growBefore.regions[0].fontSizePx, JSON.stringify(growAfter));
  assert.ok(growAfter.regions[0].lineCount < growBefore.regions[0].lineCount && growAfter.regions[0].lineCount > 1);
  assert.ok(growAfter.regions[0].safe && growAfter.regions[0].complete && !growAfter.regions[0].missingGlyphs);
  assert.deepEqual(growAfter.regions[1], growBefore.regions[1]);
  assert.equal(growAfter.changedOutsideBoxes, 0);
  const sameRowsBefore = result.results.find(row => row.name === 'shared-auto-same-rows-false');
  const sameRowsAfter = result.results.find(row => row.name === 'shared-auto-same-rows-true');
  assert.ok(sameRowsBefore?.ok && sameRowsAfter?.ok, JSON.stringify([sameRowsBefore, sameRowsAfter]));
  assert.equal(sameRowsBefore.regions[0].lineCount, 3);
  assert.equal(sameRowsAfter.regions[0].lineCount, 3);
  assert.ok(sameRowsAfter.regions[0].fontSizePx > sameRowsBefore.regions[0].fontSizePx, JSON.stringify(sameRowsAfter));
  assert.deepEqual(sameRowsAfter.regions[1], sameRowsBefore.regions[1]);
  assert.ok(sameRowsAfter.regions[0].safe && sameRowsAfter.regions[0].complete);
  assert.equal(sameRowsAfter.changedOutsideBoxes, 0);
  const solo = result.results.find(row => row.name === 'solo-band-auto');
  const fixedSolo = result.results.find(row => row.name === 'solo-band-fixed');
  const protectedSolo = result.results.find(row => row.name === 'solo-band-protected');
  assert.ok(solo?.ok && fixedSolo?.ok && protectedSolo?.ok, JSON.stringify([solo, fixedSolo, protectedSolo]));
  const [singleLine] = solo.regions;
  assert.ok(singleLine.fontSizePx > fixedSolo.regions[0].fontSizePx, JSON.stringify([solo, fixedSolo]));
  assert.equal(singleLine.lineCount, 1);
  assert.equal(singleLine.text, '따뜻하다~');
  assert.ok(singleLine.safe && singleLine.complete && singleLine.missingGlyphs === 0);
  const center = box => [(box.x + box.width / 2) * width, (box.y + box.height / 2) * height];
  assert.ok(center(singleLine.bbox).every((v, i) => Math.abs(v - center(fixedSolo.regions[0].bbox)[i]) <= 1));
  assert.deepEqual(protectedSolo.regions, fixedSolo.regions);
  assert.equal(solo.changedOutsideBoxes, 0);
  const requestBefore = result.results.find(row => row.name === 'solo-request-fixed');
  const requestAfter = result.results.find(row => row.name === 'solo-request-auto');
  const intentionalBreak = result.results.find(row => row.name === 'solo-request-hard-break');
  assert.ok(requestBefore?.ok && requestAfter?.ok && intentionalBreak?.ok, JSON.stringify([requestBefore, requestAfter, intentionalBreak]));
  assert.equal(requestBefore.regions[0].lineCount, 2);
  assert.equal(requestAfter.regions[0].lineCount, 1, JSON.stringify(requestAfter));
  assert.ok(requestAfter.regions[0].fontSizePx >= requestBefore.regions[0].fontSizePx * .7);
  assert.ok(requestAfter.regions[0].safe && requestAfter.regions[0].complete);
  assert.equal(requestAfter.changedOutsideBoxes, 0);
  assert.equal(intentionalBreak.regions[0].lineCount, 2);
  const title = result.results.find(row => row.name === 'solo-title-auto');
  const titleProtected = result.results.find(row => row.name === 'solo-title-protected');
  const titleAuthored = result.results.find(row => row.name === 'solo-title-authored');
  assert.ok(title?.ok && titleProtected?.ok && titleAuthored?.ok, JSON.stringify([title, titleProtected, titleAuthored]));
  assert.ok(title.regions[0].lines.some(text => text.includes('미나 씨...')), JSON.stringify(title));
  assert.ok(title.regions[0].fontSizePx > titleProtected.regions[0].fontSizePx, JSON.stringify([title, titleProtected]));
  assert.equal(titleAuthored.regions[0].lines.at(-1), '씨...');
  for (const row of [title, titleProtected, titleAuthored]) {
    assert.ok(row.regions[0].safe && row.regions[0].complete);
    assert.equal(row.changedOutsideBoxes, 0);
  }
  for (const name of ['erased-band', 'erased-band-white-center']) {
    const row = result.results.find(sample => sample.name === name);
    assert.equal(row?.ok, true, JSON.stringify(row));
    const [region] = row.regions;
    assert.equal(region.basis, 'UNIFORM_BACKGROUND_INSET_RECTANGLE');
    assert.ok(region.safe && region.complete && region.missingGlyphs === 0 && region.fontSizePx >= 13);
    assert.ok(region.bbox.y * height >= 145 && (region.bbox.y + region.bbox.height) * height <= 194);
    assert.equal(row.changedOutsideBoxes, 0);
  }
  for (const name of ['erased-band-no-ink', 'erased-band-one-dot', 'erased-band-protected']) {
    const row = result.results.find(sample => sample.name === name);
    assert.equal(row?.code, 'MANUAL_LAYOUT_REQUIRED', JSON.stringify(row));
  }
  const tone=result.results.find(row=>row.name==='erased-band-tone'), markedTone=result.results.find(row=>row.name==='erased-band-tone-mark');
  for(const row of [tone,markedTone]){
    assert.equal(row?.ok,true,JSON.stringify(row));assert.equal(row.changedOutsideBoxes,0);
    assert.ok(row.regions[0].safe && row.regions[0].complete);
  }
  assert.ok(tone.regions[0].bbox.height*height>26);
  assert.ok((markedTone.regions[0].bbox.y+markedTone.regions[0].bbox.height)*height<=184+1e-6);
  assert.equal(result.results.find(row=>row.name==='erased-band-tone-protected')?.code,'MANUAL_LAYOUT_REQUIRED');
  assert.equal(result.aggregateFailure?.regions?.length,2,'a rejected first region must not discard the independent second region measurement');
  assert.equal(result.aggregateFailure.regions.find(r=>r.id==='synthetic-region').background.reasonCodes[0],'BACKGROUND_NOT_UNIFORM');
  assert.ok(result.aggregateFailure.regions.find(r=>r.id==='synthetic-second').fontSizePx>12);
  assert.equal(result.aggregateFailure.regions.find(r=>r.id==='synthetic-region').fontSizePx,null);
  assert.equal(result.aggregateFailure.regions.find(r=>r.id==='synthetic-second').raster,null);
 }finally{if(job&&!job.closed)await job.stop();}
});
