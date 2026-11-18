/** Read-only compatibility schema for local settings saved before online-only mode. */
export type LocalTranslationSettings={
 version:1;engine:'gemma-local';modelSource:'huggingface'|'local';variant:'fast'|'legacy';
 preset:'12b'|'26b'|'31b'|'custom';runtime:'cuda12'|'rtx50'|'vulkan'|'rocm';
 repoId:string;filename:string;modelPath:string;vramReserveMiB:number;
 temperature:number;topP:number;topK:number;maxOutputTokens:number;contextLength:number;
};
const LEGACY_GENERATION=Object.freeze({temperature:.1,topP:.95,topK:64,maxOutputTokens:24576,contextLength:32768});
export const DEFAULT_LOCAL_TRANSLATION:Readonly<LocalTranslationSettings>=Object.freeze({
 version:1,engine:'gemma-local',modelSource:'huggingface',variant:'fast',preset:'12b',runtime:'cuda12',
 repoId:'',filename:'',modelPath:'',vramReserveMiB:512,...LEGACY_GENERATION,
});
const choice=<T extends string>(value:unknown,values:readonly T[],fallback:T):T=>values.includes(value as T)?value as T:fallback;
const number=(value:unknown,fallback:number,min:number,max:number,integer=false)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,integer?Math.round(value):value)):fallback;
const text=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max):'';
/** Optional v1 settings are backward compatible with existing project backups. */
export function normalizeLocalTranslation(value:unknown):LocalTranslationSettings {
 const v=value&&typeof value==='object'?value as Partial<LocalTranslationSettings>:{};
 const contextLength=number(v.contextLength,LEGACY_GENERATION.contextLength,512,262144,true);
 return {version:1,engine:'gemma-local',modelSource:choice(v.modelSource,['huggingface','local'],'huggingface'),variant:choice(v.variant,['fast','legacy'],'fast'),preset:choice(v.preset,['12b','26b','31b','custom'],'12b'),runtime:choice(v.runtime,['cuda12','rtx50','vulkan','rocm'],'cuda12'),repoId:text(v.repoId,200),filename:text(v.filename,300),modelPath:text(v.modelPath,1000),vramReserveMiB:number(v.vramReserveMiB,512,0,65536,true),temperature:number(v.temperature,LEGACY_GENERATION.temperature,0,2),topP:number(v.topP,LEGACY_GENERATION.topP,.01,1),topK:number(v.topK,LEGACY_GENERATION.topK,0,1000,true),maxOutputTokens:Math.min(number(v.maxOutputTokens,LEGACY_GENERATION.maxOutputTokens,1,131072,true),contextLength),contextLength};
}
export type LocalOcrSettings={version:1;engine:'hayai'|'hunyuan15'|'paddle';device:'cuda'|'rocm'|'cpu'};
export const DEFAULT_LOCAL_OCR:Readonly<LocalOcrSettings>=Object.freeze({version:1,engine:'hayai',device:'cuda'});
export function normalizeLocalOcr(value:unknown):LocalOcrSettings {
 const settings=value&&typeof value==='object'?value as Partial<LocalOcrSettings>:{};
 return {version:1,engine:choice(settings.engine,['hayai','hunyuan15','paddle'],'hayai'),device:choice(settings.device,['cuda','rocm','cpu'],'cuda')};
}
