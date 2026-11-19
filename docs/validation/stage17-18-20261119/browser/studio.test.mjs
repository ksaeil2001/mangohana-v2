import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const site=fileURLToPath(new URL('../../../../apps/sites/',import.meta.url));
const local=createRequire(path.join(site,'package.json'));
const {build}=local('esbuild'),{zipSync}=local('fflate');
const hash=b=>createHash('sha256').update(b).digest('hex');
const origin='https://studio.invalid';
const buildResult=await build({absWorkingDir:site,stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';import './app/globals.css';createRoot(document.getElementById('root')).render(React.createElement(Home));`,resolveDir:site},
  tsconfig:path.join(site,'tsconfig.json'),bundle:true,write:false,outfile:'studio.js',format:'iife',jsx:'automatic',
  alias:{tailwindcss:path.join(site,'node_modules/tailwindcss/index.css')},define:{'process.env.NODE_ENV':'"production"'},metafile:true});
const resources=new Map(buildResult.outputFiles.map(file=>['/'+path.basename(file.path),file.contents]));
async function preserveFixture(bytes){
  const file=new URL('./'+hash(bytes)+'.png',import.meta.url);
  try{await writeFile(file,bytes,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;assert.deepEqual(await readFile(file),bytes);}
}
const ownedInputs={};
for(const name of Object.keys(buildResult.metafile.inputs).filter(f=>f!=='<stdin>'&&!f.includes('node_modules'))){
  ownedInputs[name]=hash(await readFile(path.resolve(site,name)));
}
console.log('BUNDLED_INPUTS '+JSON.stringify(ownedInputs));
const shell='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio.css"><div id="root"></div><script src="/studio.js"></script></html>';

test('offline desktop Studio imports, edits, reorders and reopens the same PNG through TRIO; the narrow viewport opens its drawer',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,args:['--disable-background-networking','--disable-sync','--disable-component-update']});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1,offline:true,serviceWorkers:'block',acceptDownloads:true});
    const blocked=[],errors=[];
    // Every document, script, stylesheet and sample response is fulfilled from test memory.
    // There is no HTTP listener, upstream, engine, or existing browser profile.
    await context.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.origin===origin&&u.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:shell});
      if(u.origin===origin&&resources.has(u.pathname))return route.fulfill({contentType:u.pathname.endsWith('.css')?'text/css':'application/javascript',body:Buffer.from(resources.get(u.pathname))});
      if(u.origin===origin&&u.pathname.startsWith('/samples/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="white"/></svg>'});
      blocked.push(u.pathname);return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(6500);
    page.on('pageerror',err=>errors.push(err.message));
    await page.goto(origin);
    await page.waitForSelector('.save-state.saved');
    const png=Buffer.from(await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=384;c.height=576;
      const ctx=c.getContext('2d');ctx.fillStyle='#fafafa';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#222';ctx.fillRect(8,8,12,12);
      return c.toDataURL('image/png').split(',')[1];
    }),'base64');
    await preserveFixture(png);
    const fixture=name=>({name,mimeType:'image/png',buffer:png});
    async function upload(input,count){
      const uploader=page.locator('#page-upload-button');
      try{
        await page.waitForSelector('main[data-workspace-state="ready"][data-operation="idle"] #page-upload-button:enabled');
        const [chooser]=await Promise.all([page.waitForEvent('filechooser'),uploader.click()]);
        await chooser.setFiles(input);
        await page.waitForFunction(n=>document.querySelectorAll('.page-card').length===n&&document.querySelector('main')?.dataset.operation==='idle',count);
        console.log('UPLOADED_PAGES '+count);
      }
      catch(error){console.error('UPLOAD_STATE',JSON.stringify(await page.evaluate(()=>({shell:{...document.querySelector('main').dataset},names:[...document.querySelectorAll('.page-card')].map(b=>b.ariaLabel),notices:[...document.querySelectorAll('[role=alert],.toast')].map(n=>n.textContent)}))));throw error;}
    }
    await upload(fixture('one.png'),1);
    await upload([fixture('two.png'),fixture('three.png')],3);
    await upload({name:'four.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'chapter/four.png':png}))},4);
    const selectFour=()=>page.getByRole('button',{name:/^\d+페이지 · four\.png$/}).click();
    await selectFour();await page.getByRole('button',{name:'현재 페이지 4 · four.png'}).waitFor();
    await page.getByRole('button',{name:'선택한 페이지를 앞으로'}).click();
    await page.getByRole('button',{name:'3페이지 · four.png'}).waitFor();
    await page.getByRole('button',{name:'텍스트 추가 · T'}).click();
    const edit=page.getByRole('textbox',{name:/직접 편집/});await edit.fill('말');await edit.press('Control+Enter');
    await page.locator('.text-block').dblclick();await edit.fill('빛');await edit.press('Control+Enter');
    await page.locator('#font-select').selectOption('serif');await page.locator('#font-size').fill('18');await page.locator('#font-weight').selectOption('700');
    await page.getByRole('button',{name:'왼쪽 정렬'}).click();await page.locator('#text-color').fill('#203040');
    await page.locator('#line-height').focus();await page.locator('#line-height').press('ArrowRight');
    await page.getByRole('button',{name:'OCR 영역 표시 · O'}).click();
    assert.equal(await page.locator('.text-block.ocr-visible').count(),1);
    await page.getByRole('tab',{name:'원본',exact:true}).click();await page.locator('.ocr-only.ocr-visible').click();
    const roi=page.getByRole('form',{name:'OCR 영역 수정'});
    await roi.getByLabel('왼쪽').fill('20');await roi.getByRole('button',{name:'OCR 영역 저장'}).click();
    await page.waitForFunction(()=>document.querySelector('.ocr-only')?.style.left==='20%');
    await page.getByRole('tab',{name:'미리보기',exact:true}).click();
    for(let i=0;i<7;i++)await page.getByRole('button',{name:'확대',exact:true}).click();
    const stage=page.locator('.canvas-stage');
    await stage.hover();const beforeWheel=await stage.evaluate(el=>el.scrollTop);
    await page.mouse.wheel(0,190);
    await page.waitForFunction(before=>document.querySelector('.canvas-stage').scrollTop>before+15,beforeWheel);
    const zoom=await page.locator('.zoom-number').innerText();
    await page.waitForFunction(()=>document.querySelector('.save-state.saved'));
    // Wait for the application's debounced reading snapshot, independent of render timing.
    await page.waitForFunction(before=>new Promise(resolve=>{
      const req=indexedDB.open('trio-studio-v1');req.onsuccess=()=>{const db=req.result,read=db.transaction('workspace').objectStore('workspace').get('current');
        read.onsuccess=()=>{const w=read.result,el=document.querySelector('.canvas-stage'),anchor=w?.reading?.[w.activeId]?.anchor;
          const storedTop=anchor?.y*el.scrollHeight-el.clientHeight/2;
          resolve(el.scrollTop>before+15&&Math.abs(storedTop-el.scrollTop)<1);db.close();};};
    }),beforeWheel);
    const scroll=await stage.evaluate(el=>el.scrollTop);
    console.log('PERSISTED_SCROLL '+JSON.stringify({beforeWheel,scroll,zoom}));
    await page.reload();await page.getByRole('button',{name:'현재 페이지 3 · four.png'}).waitFor();
    try{await page.waitForFunction(y=>Math.abs(document.querySelector('.canvas-stage').scrollTop-y)<=5,scroll);}
    catch(error){console.error('RESTORE_MISMATCH',JSON.stringify({expected:scroll,observed:await stage.evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight})),zoom:await page.locator('.zoom-number').innerText()}));throw error;}
    assert.equal(await page.locator('.zoom-number').innerText(),zoom);
    async function download(format){
      await page.keyboard.press('Control+s');
      const dialog=page.getByRole('dialog',{name:'이야기를 가져가세요'});await dialog.locator('label').filter({has:page.locator('input[value="'+format+'"]')}).click();
      const downloaded=page.waitForEvent('download');await dialog.getByRole('button',{name:'다운로드',exact:true}).click();
      const d=await downloaded;const bytes=await readFile(await d.path());await dialog.waitFor({state:'hidden'});return bytes;
    }
    const first=await download('png');await preserveFixture(first);
    const backup=await download('project'), project=JSON.parse(backup).project;
    assert.deepEqual(project.pages.map(p=>p.name),['one.png','two.png','four.png','three.png']);
    const [b]=project.pages[2].blocks;assert.deepEqual([b.text,b.font,b.size,b.weight,b.align,b.color],['빛','serif',18,700,'left','#203040']);assert.ok(b.lineHeight>1.4);
    assert.equal(b.userSourceBox.x,20);assert.notEqual(b.x,b.userSourceBox.x);
    await page.locator('input[accept=".trio,.json"]').setInputFiles({name:'reopen.trio',mimeType:'application/json',buffer:backup});
    await page.waitForSelector('.canvas-project-path[data-location=pages]');
    await selectFour();const second=await download('png');
    assert.ok(first.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')));assert.notEqual(hash(first),hash(png));assert.equal(hash(first),hash(second));
    await page.setViewportSize({width:390,height:844});await page.locator('#page-panel-toggle').click();
    await page.getByRole('dialog',{name:'프로젝트와 페이지'}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    console.log('STUDIO_BROWSER_EVIDENCE '+JSON.stringify({browser:browser.version(),node:process.version,transport:'offline_route_fulfill_no_server',fixtureSha256:hash(png),downloadBeforeSha256:hash(first),downloadAfterSha256:hash(second),trioSha256:hash(backup),scroll,zoom,viewports:[[1440,960],[390,844]],blocked,errors}));
  }finally{await browser.close();}
});
