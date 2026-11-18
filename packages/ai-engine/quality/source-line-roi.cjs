'use strict';

// Observation geometry, not glyph truth. Source identities never become the
// IDs of redetections. Shared by planning, refinement and dialogue selection.
const EPSILON=1e-6, COVERAGE=.75;
const rectangle=b=>[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
const pixels=(b,w,h)=>({x:b.x*w,y:b.y*h,width:b.width*w,height:b.height*h});
function bounds(points){const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};}
function area(polygon){let sum=0;for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length];sum+=a.x*b.y-b.x*a.y;}return Math.abs(sum)/2;}
function validQuad(q,w,h){
 if(!Array.isArray(q)||q.length!==4||q.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>w||p.y>h)||area(q)<=EPSILON)return false;
 let sign=0;for(let i=0;i<4;i++){const a=q[i],b=q[(i+1)%4],c=q[(i+2)%4],cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);if(Math.abs(cross)<=EPSILON)continue;const next=Math.sign(cross);if(sign&&sign!==next)return false;sign=next;}return !!sign;
}
function clip(polygon,box){let result=polygon;for(const [axis,edge,greater]of [['x',box.x,true],['x',box.x+box.width,false],['y',box.y,true],['y',box.y+box.height,false]]){const next=[];for(let i=0;i<result.length;i++){const a=result[i],b=result[(i+1)%result.length],ia=greater?a[axis]>=edge:a[axis]<=edge,ib=greater?b[axis]>=edge:b[axis]<=edge;if(ia)next.push(a);if(ia!==ib){const t=(edge-a[axis])/(b[axis]-a[axis]);next.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}}result=next;if(!result.length)break;}return result;}
const coverage=(q,b)=>area(clip(q,b))/area(q);
const intersects=(q,b)=>area(clip(q,b))>EPSILON;
function halfPlane(polygon,a,b,orientation,inside){const output=[],distance=p=>orientation*((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x));for(let i=0;i<polygon.length;i++){const p=polygon[i],q=polygon[(i+1)%polygon.length],dp=distance(p),dq=distance(q),ip=inside?dp>=0:dp<=0,iq=inside?dq>=0:dq<=0;if(ip)output.push(p);if(ip!==iq){const t=dp/(dp-dq);output.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}}return output;}
function subtractConvex(subject,cutter){let signed=0;for(let i=0;i<cutter.length;i++){const a=cutter[i],b=cutter[(i+1)%cutter.length];signed+=a.x*b.y-b.x*a.y;}const orientation=Math.sign(signed),outside=[];let inside=subject;for(let i=0;i<cutter.length&&inside.length;i++){const a=cutter[i],b=cutter[(i+1)%cutter.length],piece=halfPlane(inside,a,b,orientation,false);if(area(piece)>EPSILON)outside.push(piece);inside=halfPlane(inside,a,b,orientation,true);}return outside;}
function unionCoverage(expected,recognized){let remaining=[expected];for(const candidate of recognized){const envelope=bounds(candidate),next=[];for(const piece of remaining){if(!intersects(piece,envelope))next.push(piece);else next.push(...subtractConvex(piece,candidate));}if(next.length>4096)throw Object.assign(new Error('과도한 OCR polygon 분할입니다.'),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});remaining=next;if(!remaining.length)break;}return Math.max(0,Math.min(1,1-remaining.reduce((sum,p)=>sum+area(p),0)/area(expected)));}
const quadKey=q=>JSON.stringify(q.map(p=>[p.x,p.y]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]));
function uniqueQuads(quads){return new Set(quads.map(quadKey)).size===quads.length;}
function readingCompare(a,b,orientation){const x=bounds(a),y=bounds(b);return orientation==='vertical'?(y.x+y.width/2)-(x.x+x.width/2)||x.y-y.y:x.y-y.y||x.x-y.x;}

/** Caller validates the input frame/provenance. No assignment is made from a
 * parent envelope, string span, ROI enumeration or a hardcoded manuscript. */
function mapSourceLinesToRois({sourceDetectionIds,sourceQuadsPx,width,height,regions}){
 const rois=regions.filter(r=>r.kind==='text_bubble'&&r.confidence>=.5);
 return sourceDetectionIds.map((sourceDetectionId,i)=>{
  const sourceQuadPx=sourceQuadsPx[i],candidates=rois.map(r=>({roiId:r.id,coverage:coverage(sourceQuadPx,pixels(r.bbox,width,height))}));
  const roiIds=candidates.filter(c=>c.coverage>=COVERAGE-EPSILON).map(c=>c.roiId);
  return {sourceDetectionId,sourceQuadPx:structuredClone(sourceQuadPx),roiIds,status:roiIds.length===1?'unique':roiIds.length?'ambiguous':'unassigned',candidates};
 });
}

/** Original .75 union coverage remains the ordinary geometry guard. A second
 * relation detects margin contraction, but cannot approve it on geometry alone.
 * It requires a bijection, >=.90 redetection inside the original quad and >=.90
 * original reading-axis span. Caller must also check actual recognition text. */
function matchRedetections({sourceDetectionIds,sourceQuadsPx,redetectionIds,redetectedQuadsPx,orientation}){
 const sourceQuadCoverage=sourceQuadsPx.map((q,i)=>({sourceDetectionId:sourceDetectionIds[i],coverage:unionCoverage(q,redetectedQuadsPx)}));
 const lineCorrespondence=sourceQuadsPx.map((source,i)=>{
  const redetectionIdsForSource=redetectedQuadsPx.flatMap((red,j)=>unionCoverage(source,[red])>EPSILON?[redetectionIds[j]]:[]);
  return {sourceDetectionId:sourceDetectionIds[i],redetectionIds:redetectionIdsForSource};
 });
 // A legitimate merged detector box may include whitespace between source
 // lines; split boxes may cover only a fragment. Reject orphan observations
 // without requiring the merged whitespace to be source ink.
 const allNewAssigned=redetectedQuadsPx.every(red=>unionCoverage(red,sourceQuadsPx)>=COVERAGE-EPSILON||sourceQuadsPx.some(source=>unionCoverage(source,[red])>=COVERAGE-EPSILON));
 if(!uniqueQuads(redetectedQuadsPx)||!allNewAssigned||lineCorrespondence.some(x=>!x.redetectionIds.length))return {method:'invalid',sourceQuadCoverage,lineCorrespondence};
 if(sourceQuadCoverage.every(x=>x.coverage>=COVERAGE-EPSILON))return {method:'source_union_coverage_0.75',sourceQuadCoverage,lineCorrespondence};
 if(!['vertical','horizontal'].includes(orientation)||sourceQuadsPx.length!==redetectedQuadsPx.length)return {method:'invalid',sourceQuadCoverage,lineCorrespondence};
 const axis=orientation==='vertical'?'y':'x',size=orientation==='vertical'?'height':'width';
 const candidates=sourceQuadsPx.map(source=>redetectedQuadsPx.flatMap((red,j)=>{
  const a=bounds(source),b=bounds(red),axisCoverage=Math.max(0,Math.min(a[axis]+a[size],b[axis]+b[size])-Math.max(a[axis],b[axis]))/a[size];
  return unionCoverage(red,[source])>=.9-EPSILON&&axisCoverage>=.9-EPSILON?[j]:[];
 }));
 if(candidates.some(x=>x.length!==1)||new Set(candidates.flat()).size!==sourceQuadsPx.length)return {method:'invalid',sourceQuadCoverage,lineCorrespondence};
 return {method:'margin_correspondence',sourceQuadCoverage,lineCorrespondence:candidates.map((x,i)=>({sourceDetectionId:sourceDetectionIds[i],redetectionIds:[redetectionIds[x[0]]]}))};
}
module.exports={EPSILON,COVERAGE,rectangle,pixels,bounds,area,validQuad,coverage,intersects,unionCoverage,uniqueQuads,readingCompare,mapSourceLinesToRois,matchRedetections};
