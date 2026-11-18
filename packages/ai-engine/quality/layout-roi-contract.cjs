'use strict';
// Authority is checked by the server's signed layout/ROI ledgers. Native input
// reaches this contract only inside a newly signed TYPESETTING_ONLY Permit.
const {createHash}=require('node:crypto');
const roiDigest=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),same=(a,b)=>roiDigest(a)===roiDigest(b);
const must=v=>{if(!v)throw Object.assign(Error('ROI_EXECUTION_AUTHORITY_INVALID'),{code:'ROI_EXECUTION_AUTHORITY_INVALID'});};
const layoutPlanDigest=(sourceReviewFingerprint,entries,roi)=>roiDigest({sourceReviewFingerprint,entries,...(roi?{roiReceiptSha256:roi.receiptSha256}:{})});
function createRoiPixelVerifier(pixels,width,height){
 const {overlaps,footprintFits}=require('./background-layout.cjs'),labels=new Int32Array(width*height),queue=new Int32Array(width*height),components=new Map();let next=0;
 const white=i=>pixels[i*4+3]>=250&&Math.min(pixels[i*4],pixels[i*4+1],pixels[i*4+2])>=240;
 function component(box){const sx=Math.min(width-1,Math.floor((box.x+box.width/2)*width)),sy=Math.min(height-1,Math.floor((box.y+box.height/2)*height)),seed=sy*width+sx;if(!white(seed))return null;let id=labels[seed];if(id)return components.get(id);id=++next;let count=1,left=width,top=height,right=0,bottom=0,closed=true;queue[0]=seed;labels[seed]=id;
  for(let head=0;head<count;head++){const i=queue[head],x=i%width,y=Math.floor(i/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);if(x===0||y===0||x===width-1||y===height-1)closed=false;for(const n of[x?i-1:-1,x+1<width?i+1:-1,y?i-width:-1,y+1<height?i+width:-1])if(n>=0&&!labels[n]&&white(n)){labels[n]=id;queue[count++]=n;}}
  const w=right-left+1,h=bottom-top+1,mask=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(labels[(top+y)*width+left+x]===id)mask[y*w+x]=1;const result={closed,area:count,interior:{left,top,width:w,height:h,mask}};components.set(id,result);return result;
 }
 return (region,entry,inkBounds)=>{if(!overlaps(entry.bbox,region.allowedBbox??region.bbox))return {verified:false,code:'ROI_EXPANSION_DISCONNECTED_FROM_SOURCE'};if(!region.closedWhite)return {verified:true,basis:'OVERLAPPING_SOURCE_ROI_AND_MANUAL_PROTECTED_PIXEL_CONTRACT'};const c=component(region.bbox);return c?.closed&&footprintFits(c.interior,inkBounds)?{verified:true,basis:'SAME_ACTUAL_CLOSED_WHITE_COMPONENT',area:c.area}:{verified:false,code:'ROI_EXPANSION_OTHER_BALLOON_OR_OPEN_COMPONENT'};};
}
function approvedRoiRegions(layout,regions,proof){
 const r=layout?.roiExpansion;if(!r)return regions;
 const a=proof?.layoutAdapter;
 must(r.version===1&&r.kind==='APPROVED_ROI_EXPANSION'&&['receiptSha256','proposalSha256','baseLayoutPlanSha256','cleanedSha256','sourceReviewFingerprint','entriesSha256','wholePlanSha256'].every(k=>hex(r[k]))&&Number.isSafeInteger(r.baseLayoutRevision)&&layout.layoutRevision===r.baseLayoutRevision+2);
 must(a&&a.roiReceiptSha256===r.receiptSha256&&a.proposalSha256===r.proposalSha256&&a.entriesSha256===r.entriesSha256&&a.wholePlanSha256===r.wholePlanSha256&&proof.cleanedSha256===r.cleanedSha256&&roiDigest(layout.entries)===r.entriesSha256&&layout.sourceReviewFingerprint===r.sourceReviewFingerprint&&a.layoutReviewSha256===roiDigest(layout));
 must(Array.isArray(r.regions)&&new Set(r.regions.map(v=>v.id)).size===r.regions.length);
 for(const v of r.regions){const original=regions.find(o=>o.id===v.id),e=layout.entries.find(o=>o.id===v.id);must(original&&e&&same(original.allowedBbox??original.bbox,v.originalAllowedBbox)&&same(e.bbox,v.approvedBbox));}
 return regions.map(v=>{const approval=r.regions.find(o=>o.id===v.id);return approval?{...v,allowedBbox:{...approval.approvedBbox}}:v;});
}
module.exports={roiDigest,layoutPlanDigest,approvedRoiRegions,createRoiPixelVerifier};
