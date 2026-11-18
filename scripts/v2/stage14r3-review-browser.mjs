// Actual browser + synthetic reviewer input. Never authenticates a user or applies an engine job.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {renderReviewHtml,inspectReviewSubmission} from './stage14r3-review.mjs';
const [directory,label='browser']=process.argv.slice(2);if(!directory||!/^[-a-z0-9]+$/.test(label))throw Error('Explicit supplemental output directory and safe label required');
const packet=JSON.parse(await fs.readFile(path.join(directory,'Stage14R3_Human_Review_Packet.json'),'utf8'));
const html=renderReviewHtml(packet),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-r3-review-browser-'));
const server=http.createServer((req,res)=>{if(req.url!=='/review'){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;const errors=[],checks=[];
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));const url='http://127.0.0.1:'+server.address().port+'/review';await page.goto(url);
 const sections=page.locator('section[data-region]');assert.equal(await sections.count(),13);assert.equal(await page.locator('section select[data-field="decision"]').evaluateAll(xs=>xs.filter(x=>x.value!=='').length),0);
 assert.equal(await page.locator('input[type=checkbox]:checked').count(),0);assert.equal(await sections.locator('img').evaluateAll(xs=>xs.filter(x=>x.complete&&x.naturalWidth>0).length),13);
 for(const [i,r]of packet.regions.entries())assert.equal((await sections.nth(i).locator('.candidate').innerText()).trim(),r.translatedText);
 await page.screenshot({path:path.join(directory,'evidence/'+label+'-desktop.png')});checks.push('13 real candidates, 13 crops, no preselected decision or approval');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(directory,'evidence/'+label+'-mobile.png')});await page.setViewportSize({width:1280,height:900});checks.push('390px mobile layout has no horizontal overflow');
 const control=JSON.parse(await fs.readFile(path.join(directory,'Stage14R3_Human_Review_Template.json'),'utf8'));Object.assign(control.regions[0],{decision:'CORRECT_TRANSLATION',correctedTranslation:'합성'+String.fromCharCode(1)+'문장',selectedTranslation:'합성'+String.fromCharCode(1)+'문장',selectionOrigin:'USER_EDIT'});const controlFile=path.join(temp,'synthetic-control.json');await fs.writeFile(controlFile,JSON.stringify(control));await page.locator('#import').setInputFiles(controlFile);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('기존 입력을 보존'),{},{timeout:1500});assert.equal(await sections.nth(0).locator('[data-field="selectedTranslation"]').inputValue(),'');checks.push('control characters are rejected without changing the form');
 async function download(name){const wait=page.waitForEvent('download');await page.locator('#download').click();const download=await wait,file=path.join(temp,name);await download.saveAs(file);return {file,value:JSON.parse(await fs.readFile(file,'utf8'))};}
 const empty=await download('synthetic-empty.json');assert.equal(inspectReviewSubmission(packet,empty.value).completed,0);checks.push('empty export remains pending and R2-compatible');
 await page.locator('#reviewer').fill('synthetic-user-NOT_REAL_APPROVAL');await page.locator('#reviewScope').fill('합성 브라우저 왕복 검사 · 원문 의미를 판정하지 않음');await page.locator('#uncertainties').fill('합성 검사. 실제 사용자 검수·독립 평가 정답 없음.');
 for(let i=0;i<13;i++){
  const section=sections.nth(i);await section.locator('[data-field="decision"]').selectOption('ACCEPT_AS_IS');await section.locator('[data-field="rationale"]').fill('합성 입력/내보내기 동작 확인');await section.locator('[data-scope]').first().check();
  for(const group of await section.locator('[data-risk-code]').all()){await group.locator('[data-risk-decision]').selectOption('ACCEPT_THIS_SENTENCE');await group.locator('[data-risk-rationale]').fill('합성 경고 판정 기록 왕복만 확인. 실제 의미 검수 아님.');}
  await section.locator('[data-field="confirmedByHuman"]').check();
 }
 await sections.nth(0).locator('[data-adopt]').click();assert.equal(await sections.nth(0).locator('[data-field="confirmedByHuman"]').isChecked(),false);await sections.nth(0).locator('[data-field="confirmedByHuman"]').check();
 await sections.nth(5).locator('[data-field="selectedTranslation"]').fill('합성 사용자 수정문');assert.equal(await sections.nth(5).locator('[data-field="confirmedByHuman"]').isChecked(),false);await sections.nth(5).locator('[data-field="confirmedByHuman"]').check();
 await page.locator('#application').check();const complete=await download('synthetic-complete.json');assert.equal(inspectReviewSubmission(packet,complete.value).completed,13);assert.equal(complete.value.humanApprovalVerified,false);assert.equal(complete.value.stage14r3.executionAuthorized,false);assert.equal(complete.value.stage14r3.independentGroundTruthVerified,false);assert.equal(complete.value.regions[0].selectionOrigin,'AI_SUGGESTION_ADOPTED');assert.equal(complete.value.regions[5].selectionOrigin,'USER_EDIT');checks.push('synthetic complete export preserves AI adoption vs user edits, revisions and separate permissions');
 await page.reload();await page.locator('#import').setInputFiles(complete.file);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('다시 읽었습니다'));
 assert.equal(await sections.nth(5).locator('[data-field="selectedTranslation"]').inputValue(),'합성 사용자 수정문');const round=await download('synthetic-roundtrip.json');assert.equal(inspectReviewSubmission(packet,round.value).completed,13);
 const withoutTime=x=>{const v=structuredClone(x);delete v.submittedAt;return v;};assert.deepEqual(withoutTime(round.value),withoutTime(complete.value));checks.push('export → reload → re-import → re-export keeps all values/provenance/revisions/risk decisions');
 const bad=structuredClone(complete.value);bad.regions[12].regionId='foreign-region';const badFile=path.join(temp,'synthetic-invalid.json');await fs.writeFile(badFile,JSON.stringify(bad));await page.locator('#import').setInputFiles(badFile);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('기존 입력을 보존'));
 assert.equal(await sections.nth(5).locator('[data-field="selectedTranslation"]').inputValue(),'합성 사용자 수정문');assert.equal(await page.locator('#reviewer').inputValue(),complete.value.reviewer);checks.push('invalid import is rejected atomically and previous form values remain');
 assert.deepEqual(errors,[]);const receipt={status:'PASS',scope:'ACTUAL_CHROME_UI_WITH_SYNTHETIC_REVIEWER_NOT_HUMAN_APPROVAL',browser:browser.version(),checks,errors,temporary:temp,syntheticFiles:[empty.file,complete.file,round.file,badFile],realHumanReviews:0,productApplications:0,modelCalls:0};
 await fs.writeFile(path.join(directory,'evidence/'+label+'-receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify(receipt));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
