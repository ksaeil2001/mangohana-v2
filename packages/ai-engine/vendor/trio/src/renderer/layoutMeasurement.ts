import { ensureProductionTypesetFontLoaded } from './productionTypesetFont.js';
import { measureCandidateFit } from './candidateTypesettingFit.js';
import type { NormalizedBbox } from '../shared/speechBubbleExtraction.js';
type Entry = { id: string; bbox: NormalizedBbox; text: string; fontSizePx?: number; lineHeight?: number };
/** Native measurement capability: no image, renderer pipeline or encoder is exposed. */
export async function measureEntries(input: { width: number; height: number; entries: Entry[] }) {
  let paintCalls=0,encodeCalls=0;
  const denyPaint=()=>{paintCalls++;throw Error('TEXT_MEASUREMENT_PAINT_FORBIDDEN');};
  for(const name of ['fillText','strokeText','drawImage','fillRect','strokeRect','putImageData'])
    (CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>)[name]=denyPaint;
  HTMLCanvasElement.prototype.toDataURL=()=>{encodeCalls++;throw Error('TEXT_MEASUREMENT_ENCODING_FORBIDDEN');};
  HTMLCanvasElement.prototype.toBlob=()=>{encodeCalls++;throw Error('TEXT_MEASUREMENT_ENCODING_FORBIDDEN');};
  if(!await ensureProductionTypesetFontLoaded())throw Error('LAYOUT_FONT_UNAVAILABLE');
  const context=document.createElement('canvas').getContext('2d')!;
  const entries=input.entries.map(entry=>{
    const style={bbox:{...entry.bbox},writingMode:'horizontal-tb' as const,shape:'rectangle' as const,
      ...(entry.fontSizePx===undefined?{}:{fontSizeRatio:entry.fontSizePx/(entry.bbox.height*input.height)}),lineHeight:entry.lineHeight};
    const fit=measureCandidateFit(context,entry.text,style,input.width,input.height);
    return {id:entry.id,fontSizePx:fit.fontSizePx,completeText:fit.completeText,fitsBox:fit.fitsBox,linesSeparated:fit.linesSeparated,...(fit.standard?{standard:fit.standard}:{}),
      strokeWidthPx:fit.strokeWidthPx,layout:fit.layout,inkBounds:fit.inkBounds.map(b=>({left:b.left+entry.bbox.x*input.width,right:b.right+entry.bbox.x*input.width,
        top:b.top+entry.bbox.y*input.height,bottom:b.bottom+entry.bbox.y*input.height}))};
  });
  return {fontLoaded:true,entries,paintCalls,encodeCalls,actualPageSupplied:false,actualImageExecution:false};
}
