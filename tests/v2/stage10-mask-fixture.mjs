// Deterministic raster primitives with exact synthetic truth; no human/manga GT.
export function outlinedFixture({halo=8,edgeAlpha=255}={}){
 const width=112,height=96,size=width*height,source=new Uint8ClampedArray(size*4),background=new Uint8ClampedArray(size*4);
 const core=new Uint8Array(size),outline=new Uint8Array(size),antialias=new Uint8Array(size),protection=new Uint8Array(size);
 const paint=(pixels,x,y,value)=>{const at=(y*width+x)*4;pixels.set([value,value,value,255],at);};
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){paint(source,x,y,210);paint(background,x,y,210);}
 const protectedAt=(x,y)=>{paint(source,x,y,0);paint(background,x,y,0);protection[y*width+x]=255;};
 // Closed balloon boundary, separate SFX primitives, and adjacent character ink.
 for(let x=5;x<107;x++){protectedAt(x,5);protectedAt(x,90);}
 for(let y=5;y<=90;y++){protectedAt(5,y);protectedAt(106,y);}
 for(let y=28;y<72;y++)protectedAt(57,y);
 for(let x=85;x<97;x++){protectedAt(x,22);protectedAt(x,32);}
 for(let y=22;y<=32;y++){protectedAt(85,y);protectedAt(96,y);}
 for(let y=32-halo-1;y<56+halo+1;y++)for(let x=34-halo-1;x<46+halo+1;x++){
  const dx=Math.max(34-x,0,x-45),dy=Math.max(32-y,0,y-55);
  if(!dx&&!dy){paint(source,x,y,0);core[y*width+x]=255;}
  else if(Math.max(dx,dy)<=halo){paint(source,x,y,255);outline[y*width+x]=255;}
  else{paint(source,x,y,230);source[(y*width+x)*4+3]=edgeAlpha;background[(y*width+x)*4+3]=edgeAlpha;antialias[y*width+x]=255;}
 }
 const regions=[{id:'synthetic-dialogue',polygonsPx:[[{x:22,y:20},{x:58,y:20},{x:58,y:68},{x:22,y:68}]]}];
 return {width,height,source,background,core,outline,antialias,protection,regions,truthKind:'SYNTHETIC_PIXEL_ORACLE',humanGroundTruth:false};
}
export function rasterStats(f,mask){
 const sum=a=>a.reduce((n,x)=>n+(x?1:0),0),intersection=a=>a.reduce((n,x,i)=>n+(x&&mask[i]?1:0),0);
 return {core:{numerator:intersection(f.core),denominator:sum(f.core)},outline:{numerator:intersection(f.outline),denominator:sum(f.outline)},antialias:{numerator:intersection(f.antialias),denominator:sum(f.antialias)},protectionIntrusion:{numerator:intersection(f.protection),denominator:sum(f.protection)}};
}
export function oracleClean(f,mask){const result=f.source.slice();for(let i=0;i<mask.length;i++)if(mask[i])result.set(f.background.subarray(i*4,i*4+4),i*4);return result;}
/** Exact toy ground truth only. It deliberately accepts no final/typeset image. */
export function measureFixture(f,mask,cleaned,{phase='cleaned'}={}){
 if(phase!=='cleaned')throw Error('TYPESETTING_OVERLAY_NOT_A_CLEANED_IMAGE');
 if(f.truthKind!=='SYNTHETIC_PIXEL_ORACLE'||f.humanGroundTruth!==false)throw Error('SYNTHETIC_ORACLE_REQUIRED');
 if(!cleaned)return {scope:'SYNTHETIC_PIXEL_ORACLE',status:'NOT_MEASURED',reason:'CLEANED_IMAGE_MISSING',residualPixels:null};
 const size=f.width*f.height;if(mask.length!==size||cleaned.length!==size*4||!mask.every(v=>v===0||v===255))throw Error('FIXTURE_FRAME_OR_ENCODING_MISMATCH');
 let residualPixels=0,protectedChangedPixels=0,outsideMaskChangedPixels=0,insideArtworkDamagePixels=0,alphaChangedPixels=0;
 for(let i=0;i<size;i++){
  const different=(a,b)=>a.subarray(i*4,i*4+4).some((v,c)=>v!==b[i*4+c]);
  if((f.core[i]||f.outline[i]||f.antialias[i])&&different(cleaned,f.background))residualPixels++;
  if(f.protection[i]&&different(cleaned,f.source)){protectedChangedPixels++;if(mask[i])insideArtworkDamagePixels++;}
  if(!mask[i]&&different(cleaned,f.source))outsideMaskChangedPixels++;
  if(cleaned[i*4+3]!==f.source[i*4+3])alphaChangedPixels++;
 }
 return {scope:'SYNTHETIC_PIXEL_ORACLE',status:'MEASURED_SYNTHETIC',...rasterStats(f,mask),residualPixels,protectedChangedPixels,outsideMaskChangedPixels,insideArtworkDamagePixels,alphaChangedPixels,
  evaluablePixels:{numerator:size,denominator:size},humanGroundTruthPages:0,restoration:'EXACT_KNOWN_BACKGROUND_COMPOSITE_NOT_LAMA',qualityApproval:false};
}
