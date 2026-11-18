window.stage12Gates=async function(onlyId){
 const api=window.Stage12Product,c=document.createElement('canvas');c.width=c.height=240;const ctx=c.getContext('2d');
 ctx.fillStyle='#999';ctx.fillRect(0,0,240,240);ctx.fillStyle='white';ctx.beginPath();ctx.ellipse(120,120,104,104,0,0,Math.PI*2);ctx.fill();
 const cleaned=c.toDataURL('image/png').split(',')[1];ctx.fillStyle='#000';for(let x=92;x<=140;x+=16){ctx.fillRect(x,100,7,32);ctx.fillRect(x-3,107,13,5);}
 const source=c.toDataURL('image/png').split(',')[1],identity={version:1,jobId:'synthetic-layout',pageNumber:2,sourceImageSha256:'a'.repeat(64),ocrSha256:'b'.repeat(64),coordinateSpace:'normalized-page-pixels',width:240,height:240};
 const ocr={pageNumber:2,warnings:[],nonSpeechText:[],speechBubbles:[{id:'a',readingOrder:1,type:'speech_bubble',text:'合成',language:'ja',confidence:1,notes:'synthetic',speakerCandidates:[],bbox:{x:.35,y:.35,width:.3,height:.3},polygon:[{x:.35,y:.35},{x:.65,y:.35},{x:.65,y:.65},{x:.35,y:.65}]}]};
 const setup=async()=>{api.invalidate();const p=await api.prepare({jobId:identity.jobId,ocr:structuredClone(ocr),width:240,height:240,sourcePngBase64:source,sourceLanguage:'ja',maskIdentity:identity});return {jobId:identity.jobId,cleanedPngBase64:cleaned,lines:p.lines.map(l=>({...l,aiTranslation:'한국어 시험'})),typesettingIdentity:{...identity,contract:'stage12-input-v1',sourceSha256:'c'.repeat(64),cleanedImageSha256:'d'.repeat(64),maskSha256:'e'.repeat(64),translationInputFingerprint:'f'.repeat(64),mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'}};};
 const images=[],results=[],check=async(id,fn,expected)=>{if(onlyId&&id!==onlyId)return;try{const r=await fn();if(r?.pngBase64)images.push({id,pngBase64:r.pngBase64});results.push({id,expected,actual:'returned',pass:expected==='returned',layoutStatuses:r?.layoutReport?.map(l=>l.fitStatus)??null});}catch(e){results.push({id,expected,actual:'rejected',error:e.message,pass:expected==='rejected'});}};
 for(const [id,mutate]of [
  ['wrong-page',i=>i.lines[0].pageNumber=1],['wrong-source',i=>i.lines[0].sourceText='別文'],['duplicate-id',i=>i.lines.push(structuredClone(i.lines[0]))],['stale-ocr-revision',i=>i.typesettingIdentity.ocrSha256='0'.repeat(64)],
  ['changed-source-lineage',i=>i.lines[0].sourceLineIds=['foreign']],['manual-confirmed-translation',i=>i.lines[0].userTranslation='사용자 확정'],['manual-confirmed-geometry',i=>i.lines[0].typesetting.bbox.x=.3],['ocr-confirmed-ownership',i=>i.lines[0].ocrEditStatus='user_confirmed'],
  ['mask-not-validated',i=>i.typesettingIdentity.maskReview='unapproved'],['no-cleaned-binding',i=>delete i.typesettingIdentity.cleanedImageSha256],['missing-translation',i=>delete i.lines[0].aiTranslation]
 ]){await check(id,async()=>{const i=await setup();mutate(i);return api.render(i);},'rejected');}
 await check('valid-draft-stays-pending',async()=>{const i=await setup(),r=await api.render(i);if(r.layoutReport.some(l=>l.qaStatus!=='pending'))throw Error('wrong review status');return r;},'returned');
 await check('invalidated-generation-no-late-png',async()=>{const i=await setup(),p=api.render(i);api.invalidate();return p;},'rejected');
 await check('concurrent-duplicate-render',async()=>{const i=await setup(),a=api.render(i);let error;try{await api.render(i);}catch(e){error=e;}await a;if(error)throw error;},'rejected');
 await check('wrong-cleaned-resolution',async()=>{const i=await setup(),other=document.createElement('canvas');other.width=240;other.height=220;i.cleanedPngBase64=other.toDataURL('image/png').split(',')[1];return api.render(i);},'rejected');
 await check('ocr-needs-review',async()=>{api.invalidate();const input=structuredClone(ocr);input.speechBubbles[0].ocrReview={status:'needs_review'};return api.prepare({jobId:identity.jobId,ocr:input,width:240,height:240,sourcePngBase64:source,sourceLanguage:'ja',maskIdentity:identity});},'rejected');
 const direct=(text,style)=>api.renderCandidate('data:image/png;base64,'+cleaned,[{id:'a',order:1,pageNumber:1,sourceText:'合成',dialogueType:'speech',aiTranslation:text,typesetting:{bbox:{x:.3,y:.3,width:.4,height:.4},writingMode:'horizontal-tb',...style}}]);
 await check('user-leading-trailing-hard-breaks',async()=>{const text='\n첫째\n\n둘째\n',r=await api.renderCandidate('data:image/png;base64,'+cleaned,[{id:'a',order:1,pageNumber:1,sourceText:'合成',userTranslation:text,typesetting:{bbox:{x:.3,y:.3,width:.4,height:.4},writingMode:'horizontal-tb',fontSizeRatio:10/96}}]);if(r.layoutReport[0].textEvidence?.sourceText!==text||r.layoutReport[0].actualLayout?.lines.length!==5)throw Error('user hard breaks changed');return r;},'returned');
 await check('missing-glyph',()=>direct('한글'+String.fromCodePoint(0x10ffff)),'rejected');
 await check('one-glyph-missing-only-at-render-size',async()=>{const proto=CanvasRenderingContext2D.prototype,a=proto.fillText,b=proto.strokeText;try{
  proto.fillText=function(t,...p){return a.call(this,/^bold 10px /.test(this.font)?t.replaceAll('나',''):t,...p);};
  proto.strokeText=function(t,...p){return b.call(this,/^bold 10px /.test(this.font)?t.replaceAll('나',''):t,...p);};
  return await direct('가나',{fontSizeRatio:10/96});
 }finally{proto.fillText=a;proto.strokeText=b;}},'rejected');
 await check('text-exists-but-no-glyph-ink',async()=>{const proto=CanvasRenderingContext2D.prototype,a=proto.fillText,b=proto.strokeText;try{proto.fillText=()=>{};proto.strokeText=()=>{};return await direct('한국어');}finally{proto.fillText=a;proto.strokeText=b;}},'rejected');
 await check('canvas-clipping',()=>direct('절대로이대사를잘라내면안됩니다',{bbox:{x:0,y:0,width:.1,height:.2},fontSizeRatio:.8}),'rejected');
 await check('too-small-manual-font',()=>direct('한국어',{fontSizeRatio:.01}),'rejected');
 await check('overlapping-dialogue-regions',async()=>{const a={id:'a',order:1,pageNumber:1,sourceText:'合成',aiTranslation:'한국어',typesetting:{bbox:{x:.3,y:.3,width:.4,height:.4},writingMode:'horizontal-tb'}},b={...a,id:'b',order:2};return api.renderCandidate('data:image/png;base64,'+cleaned,[a,b]);},'rejected');
 await check('font-load-rejection',async()=>{const load=document.fonts.load;try{document.fonts.load=async()=>{throw Error('synthetic font load failure');};return await direct('한글');}finally{document.fonts.load=load;}},'rejected');
 return {kind:'DETERMINISTIC_REAL_CANVAS_FAULT_INJECTION_NOT_HUMAN_GT',results,images,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,humanReview:'pending',actualAiExecutions:0};
};
void 0;
