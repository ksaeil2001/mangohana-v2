import type {StudioPage} from './studio-model';

export const PROJECT_PREVIEW_LIMIT=12;
export const isSampleImage=(image:string)=>/^\/samples\/journey-0[1-4]\.(png|svg)$/.test(image);

/** Count original binary bytes, without decoding or counting base64 storage overhead. */
export function inlineImageBytes(image:string):number|null {
 const prefix=/^data:image\/[\w+.-]+;base64,/.exec(image);if(!prefix)return null;
 const data=image.slice(prefix[0].length).replace(/\s/g,'');
 if(!data||data.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(data)||(data.includes('=')&&data.length%4!==0))return null;
 return Math.floor(data.length*3/4)-(data.endsWith('==')?2:data.endsWith('=')?1:0);
}

export function projectImageSummary(pages:readonly StudioPage[],assetBytes:Readonly<Record<string,number|null>>={}){
 let bytes=0,unknownCount=0;
 for(const page of pages){const size=inlineImageBytes(page.image)??assetBytes[page.image];if(typeof size==='number'&&Number.isSafeInteger(size)&&size>=0)bytes+=size;else unknownCount++;}
 return {fileCount:pages.length,bytes,unknownCount,previews:pages.slice(0,PROJECT_PREVIEW_LIMIT)};
}

export function formatFileBytes(bytes:number):string {
 if(bytes<1000)return `${bytes} B`;
 const units=['KB','MB','GB','TB'];const index=Math.min(Math.floor(Math.log(bytes)/Math.log(1000))-1,units.length-1);
 return `${new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(bytes/1000**(index+1))} ${units[index]}`;
}
