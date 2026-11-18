// Audit-only observer. Calls the product Canvas functions, never edits a source.
window.stage12Review = async function (input) {
  const api=window.Stage12Product, create=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
  const load=src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src;});
  const png=c=>c.toDataURL('image/png').split(',')[1];
  const w=input.width,h=input.height,clean=create(w,h),ctx=clean.getContext('2d'),mask=create(w,h),mc=mask.getContext('2d');
  let original,oracle=null;
  if(input.cleaned){ctx.drawImage(await load('data:image/png;base64,'+input.cleaned),0,0);original=input.original;}
  else {
    ctx.fillStyle='#b8b8b8';ctx.fillRect(0,0,w,h);mc.fillStyle='#000';mc.fillRect(0,0,w,h);
    const draw=(c,s)=>{c.beginPath();if(s.kind==='ellipse')c.ellipse(s.x,s.y,s.rx,s.ry,0,0,Math.PI*2);else if(s.kind==='polygon'){c.moveTo(...s.points[0]);for(const p of s.points.slice(1))c.lineTo(...p);c.closePath();}else c.roundRect(s.x,s.y,s.width,s.height,18);};
    for(const shape of input.shapes){draw(ctx,shape);ctx.fillStyle='white';ctx.fill();ctx.strokeStyle='#141414';ctx.lineWidth=3;ctx.stroke();draw(mc,shape);mc.fillStyle='white';mc.fill();}
    if(input.tail){ctx.beginPath();ctx.moveTo(...input.tail[0]);for(const p of input.tail.slice(1))ctx.lineTo(...p);ctx.closePath();ctx.fillStyle='white';ctx.fill();ctx.stroke();}
    // A face-like protected illustration and preserved SFX are known fixture ink.
    ctx.fillStyle='#333';ctx.fillRect(4,h-36,24,28);ctx.fillStyle='#000';ctx.font='12px sans-serif';ctx.fillText('SFX',w-30,h-8);
    const raw=mc.getImageData(0,0,w,h).data;oracle=new Uint8Array(w*h);
    for(let y=4;y<h-4;y++)for(let x=4;x<w-4;x++){let safe=true;for(const [dx,dy]of [[0,0],[-4,0],[4,0],[0,-4],[0,4],[-3,-3],[3,-3],[-3,3],[3,3]])if(raw[((y+dy)*w+x+dx)*4]<250){safe=false;break;}if(safe)oracle[y*w+x]=1;}
    const oc=create(w,h),o=oc.getContext('2d');o.drawImage(clean,0,0);o.fillStyle='#111';o.font='18px "Malgun Gothic"';o.textAlign='center';
    for(const l of input.lines){const b=l.typesetting.bbox;o.fillText('原文', (b.x+b.width/2)*w,(b.y+b.height/2)*h);}
    original=png(oc);
  }
  const cleaned=png(clean),started=performance.now();let result;
  try{result=await api.renderCandidate('data:image/png;base64,'+cleaned,input.lines,input.options??{});}catch(e){return {id:input.id,level:input.level,status:'BLOCKED',error:e.message,original,cleaned,durationMs:performance.now()-started,source:input.source,lines:input.lines};}
  const again=await api.renderCandidate('data:image/png;base64,'+cleaned,input.lines,input.options??{}),ink=create(w,h),ic=ink.getContext('2d'),lineInk=create(w,h),lic=lineInk.getContext('2d');
  const occupancy=new Uint8Array(w*h);let lineCollisionPixels=0;const observed=[];
  for(const l of input.lines){const r=result.layoutReport.find(r=>r.id===l.id),text=l.userTranslation??l.aiTranslation;
    const style={...l.typesetting,bbox:r.bbox,fontFamily:r.fontFamily,fontSizeRatio:r.fontSizeRatio,shape:r.bboxInferred?'rectangle':l.typesetting.shape??'ellipse'};
    const measured=api.measureCandidateFit(ic,text,style,w,h),layout=r.actualLayout??measured.layout;style.strokeWidth=r.paint?.strokeWidth??measured.strokeWidthPx;
    const line={...l,typesetting:style};
    api.renderTypesettingToCanvas(ic,[line],w,h,{textResolver:()=>text,layoutResolver:()=>layout});
    for(const placed of layout.lines){if(!placed.text.trim())continue;lic.clearRect(0,0,w,h);api.renderTypesettingToCanvas(lic,[line],w,h,{textResolver:()=>text,layoutResolver:()=>({...layout,lines:[placed]})});const a=lic.getImageData(0,0,w,h).data;let minX=w,minY=h,maxX=-1,maxY=-1;
      for(let p=0;p<w*h;p++)if(a[p*4+3]){if(occupancy[p])lineCollisionPixels++;occupancy[p]=1;const x=p%w,y=Math.floor(p/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
      observed.push({id:l.id,text:placed.text,inkBounds:maxX<0?null:{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1},font:style.fontFamily,fontSizePx:r.fontSizePx});
    }
  }
  const inkPixels=ic.getImageData(0,0,w,h).data,inkStats=api.inspectCandidateInk(inkPixels,w,h),suspect=create(w,h),sc=suspect.getContext('2d'),safe=create(w,h),safeCtx=safe.getContext('2d');
  sc.drawImage(clean,0,0);safeCtx.drawImage(clean,0,0);const sp=sc.getImageData(0,0,w,h),sf=safeCtx.getImageData(0,0,w,h);let outsideOracle=oracle?0:null;
  for(let p=0;p<w*h;p++){
    if(oracle?.[p]){sf.data[p*4]=Math.round(sf.data[p*4]*.7);sf.data[p*4+1]=Math.min(255,sf.data[p*4+1]*.8+45);sf.data[p*4+2]=Math.round(sf.data[p*4+2]*.75);}
    if(oracle&&!oracle[p]&&inkPixels[p*4+3]){outsideOracle++;sp.data.set([255,0,50,255],p*4);}
  }
  sc.putImageData(sp,0,0);safeCtx.putImageData(sf,0,0);safeCtx.strokeStyle='#1373d0';safeCtx.lineWidth=2;for(const r of result.layoutReport){const b=r.bbox;safeCtx.strokeRect(b.x*w,b.y*h,b.width*w,b.height*h);}
  const recomposed=create(w,h),rc=recomposed.getContext('2d');rc.drawImage(clean,0,0);rc.drawImage(ink,0,0);const actual=create(w,h),ac=actual.getContext('2d');ac.drawImage(await load('data:image/png;base64,'+result.pngBase64),0,0);
  const a=ac.getImageData(0,0,w,h).data,b=rc.getImageData(0,0,w,h).data;let recompositionDifferentPixels=0;for(let p=0;p<w*h;p++)if(a[p*4]!==b[p*4]||a[p*4+1]!==b[p*4+1]||a[p*4+2]!==b[p*4+2]||a[p*4+3]!==b[p*4+3])recompositionDifferentPixels++;
  return {id:input.id,level:input.level,status:'RENDERED',width:w,height:h,original,cleaned,result:result.pngBase64,ink:png(ink),safe:png(safe),suspects:png(suspect),layoutReport:result.layoutReport,
    metrics:{...inkStats,lineCollisionPixels,outsideOracleSafePixels:outsideOracle,recompositionDifferentPixels,deterministicPng:result.pngBase64===again.pngBase64},
    observed,durationMs:performance.now()-started,source:input.source,lines:input.lines,humanReview:'pending',realQuality:null};
};
void 0;
