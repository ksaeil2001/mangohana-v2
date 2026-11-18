'use strict';
// Proposal/measurement only. No authority, IO, rendering, model or state mutation.
const {inside,overlaps,validBox}=require('./background-layout.cjs');
const POLICY='READABILITY_PROPOSAL_V1';
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:null;};
function assessDisplayReadability(candidate,{width,height,availableArea,peerFontSizes=[],intent='UNSPECIFIED'}={}){
 const {fontSizePx:font,bbox,inkBounds:ink,lines=[]}=candidate,area=availableArea??bbox?.width*width*bbox?.height*height;
 const scenarios={native:1,desktopFit1200x800:Math.min(1200/width,800/height),mobile390:390/width,mobile390Zoom3:390/width*3};
 const views=Object.fromEntries(Object.entries(scenarios).map(([name,scale])=>[name,{scale,fontCssPx:font*scale,zoomOrScrollRequired:name==='native'||name.endsWith('Zoom3')}]));
 const blockArea=ink?ink.width*ink.height:null,occupancy=blockArea!==null&&area>0?blockArea/area:null,peer=median(peerFontSizes),warnings=[];
 // Experimental viewing warnings, not new hard font minima or image-quality PASS.
 if(views.desktopFit1200x800.fontCssPx<10||views.mobile390.fontCssPx<8)warnings.push('SMALL_AT_PAGE_FIT');
 if(peer&&font/peer<.75)warnings.push('SMALL_RELATIVE_TO_PEERS');
 if(occupancy!==null&&occupancy<.12)warnings.push('SPARSE_BALLOON');
 if(occupancy!==null&&occupancy>.65)warnings.push('DENSE_BALLOON');
 if(lines.length>=4)warnings.push('MULTILINE_HUMAN_REVIEW');
 return {policy:POLICY,views,inkBlockArea:blockArea,availableArea:area??null,inkBlockFraction:occupancy,peerMedianPx:peer,peerRatio:peer?font/peer:null,
  margins:ink&&bbox?{left:ink.x-bbox.x*width,right:(bbox.x+bbox.width)*width-ink.x-ink.width,top:ink.y-bbox.y*height,bottom:(bbox.y+bbox.height)*height-ink.y-ink.height}:null,
  warnings,hardViolations:[],relativeSizeDecision:intent==='QUIET_REVIEW'?'HUMAN_INTENT_REVIEW':'COMPARE_WITH_SCENE',humanQuality:'PENDING',automaticApprovalAllowed:false};
}
function checkProposalCollisions(entries){const out=[];for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)if(overlaps(entries[i].bbox,entries[j].bbox))out.push({code:'PROPOSED_DIALOGUE_BOX_COLLISION',ids:[entries[i].id,entries[j].id]});return out;}
function rankReadableCandidates(candidates,{currentFontSizePx,targetFontSizePx}){
 const cost=c=>(c.standard.readability.penalty??0)+(c.display.warnings.includes('SPARSE_BALLOON')?20:0)+Math.abs(Math.log(c.entry.fontSizePx/targetFontSizePx))*50;
 // This is a proposal preference, never a new hard minimum or approval verdict.
 return [...candidates].sort((a,b)=>Number(a.entry.fontSizePx<currentFontSizePx)-Number(b.entry.fontSizePx<currentFontSizePx)||cost(a)-cost(b)||a.geometryDrift-b.geometryDrift);
}
function discoverReadabilityGeometry({pixels,width:W,height:H,region,otherBoxes=[],safetyPlane,marginPx=6,maximumBoxes=18}){
 if(!validBox(region?.bbox)||!validBox(region?.allowedBbox??region.bbox)||!Number.isInteger(W)||!Number.isInteger(H)||W*H>12_000_000||!Number.isInteger(marginPx)||marginPx<3)throw Error('READABILITY_GEOMETRY_INPUT_INVALID');
 const s=region.bbox,cx=(s.x+s.width/2)*W,cy=(s.y+s.height/2)*H,seedX=Math.floor(cx),seedY=Math.floor(cy);
 let left=0,top=0,w=W,h=H,plane;
 if(safetyPlane){({left,top,width:w,height:h}=safetyPlane);plane=safetyPlane.mask;if(!plane||plane.length!==w*h||left<0||top<0||left+w>W||top+h>H)throw Error('READABILITY_SAFETY_PLANE_INVALID');}
 else{if(!pixels||pixels.length!==W*H*4)throw Error('READABILITY_PIXELS_REQUIRED');plane=new Uint8Array(W*H);for(let i=0;i<plane.length;i++){const p=i*4;plane[i]=pixels[p+3]>=250&&Math.min(pixels[p],pixels[p+1],pixels[p+2])>=240?1:0;}}
 const seed=(seedY-top)*w+seedX-left,empty={policy:POLICY,closedWhite:false,boxes:[],authorizedForExecution:false};if(seedX<left||seedY<top||seedX>=left+w||seedY>=top+h||!plane[seed])return empty;
 const seen=new Uint8Array(w*h),queue=new Int32Array(w*h);let end=1;queue[0]=seed;seen[seed]=1;let x0=w,y0=h,x1=0,y1=0,touches=false;
 for(let i=0;i<end;i++){const v=queue[i],x=v%w,y=Math.floor(v/w);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);touches||=x===0||y===0||x===w-1||y===h-1;
  for(const u of[x>0?v-1:-1,x+1<w?v+1:-1,y>0?v-w:-1,y+1<h?v+w:-1])if(u>=0&&!seen[u]&&plane[u]){seen[u]=1;queue[end++]=u;}}
 if(!safetyPlane&&touches)return {...empty,reason:'WHITE_COMPONENT_OPEN_TO_FRAME',componentArea:end};
 const cw=x1-x0+1,ch=y1-y0+1,px0=left+x0,py0=top+y0,stride=cw+1,prefix=new Int32Array((cw+1)*(ch+1));
 for(let y=0;y<ch;y++){let row=0;for(let x=0;x<cw;x++){row+=seen[(y+y0)*w+x+x0]?0:1;prefix[(y+1)*stride+x+1]=prefix[y*stride+x+1]+row;}}
 const blocked=(l,t,r,b)=>{l-=px0;t-=py0;r-=px0;b-=py0;if(l<0||t<0||r>cw||b>ch)return true;return prefix[b*stride+r]-prefix[t*stride+r]-prefix[b*stride+l]+prefix[t*stride+l]>0;};
 const guards=otherBoxes.filter(b=>b.id!==region.id).map(b=>b.bbox),boxes=[],seenBoxes=new Set();
 const add=(l,t,bw,bh)=>{const bbox={x:l/W,y:t/H,width:bw/W,height:bh/H};if(!validBox(bbox)||guards.some(b=>overlaps(bbox,b))||blocked(l-marginPx,t-marginPx,l+bw+marginPx,t+bh+marginPx))return false;
  const key=[l,t,bw,bh].join(':');if(!seenBoxes.has(key)){seenBoxes.add(key);boxes.push({bbox,pixels:{left:l,top:t,width:bw,height:bh},requiresRoiReview:!inside(bbox,region.allowedBbox??s),saved:false,approved:false,authorizedForExecution:false,geometryDrift:Math.hypot(l+bw/2-cx,t+bh/2-cy),basis:safetyPlane?'EXPLICIT_PIXEL_SAFETY_PLANE_INSET':'CLOSED_WHITE_COMPONENT_INSET',marginPx});}return true;};
 const heights=[...new Set([.25,.35,.5,.7,1].map(v=>Math.max(40,Math.round(s.height*H*v))).concat([96,144,208,288]))];
 for(const dy of[0,-.1,.1,-.2,.2,-.35,.35])for(const dx of[0,-.15,.15])for(const bh of heights){const x=cx+dx*s.width*W,y=cy+dy*s.height*H,t=Math.round(y-bh/2);let lo=10,hi=Math.min(cw-2*marginPx,Math.floor(Math.min(x-px0,px0+cw-x)*2)-2*marginPx),best=0;
  while(lo<=hi){const bw=Math.floor((lo+hi)/2),l=Math.round(x-bw/2),b={x:l/W,y:t/H,width:bw/W,height:bh/H};if(!blocked(l-marginPx,t-marginPx,l+bw+marginPx,t+bh+marginPx)&&!guards.some(g=>overlaps(b,g))){best=bw;lo=bw+1;}else hi=bw-1;}
  if(best>=20)for(const ratio of[1,.85]){const bw=Math.floor(best*ratio);add(Math.round(x-bw/2),t,bw,bh);}}
 // Keep width/height/position diversity rather than a single huge-box maximum.
 boxes.sort((a,b)=>(b.pixels.width-a.pixels.width)||a.geometryDrift-b.geometryDrift||a.pixels.height-b.pixels.height);
 const selected=[],buckets=new Map();for(const b of boxes){const bucket=Math.round(b.pixels.width/8)+':'+Math.round(b.pixels.height/60);if((buckets.get(bucket)??0)>=1)continue;buckets.set(bucket,1);selected.push(b);if(selected.length>=maximumBoxes)break;}
 return {policy:POLICY,closedWhite:!safetyPlane,componentArea:end,componentBounds:{x:px0,y:py0,width:cw,height:ch},touchesFrame:touches,boxes:selected,authorizedForExecution:false};
}
module.exports={POLICY,assessDisplayReadability,discoverReadabilityGeometry,checkProposalCollisions,rankReadableCandidates};
