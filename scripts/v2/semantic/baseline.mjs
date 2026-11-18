import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateLines} from './protocol.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function readBaseline(directory){
 const job=path.resolve(directory),reportBytes=await fs.readFile(path.join(job,'report.json'));
 const report=JSON.parse(reportBytes),state=JSON.parse(await fs.readFile(path.join(job,'state.json'),'utf8'));
 const engineReport=JSON.parse(await fs.readFile(path.join(job,'engine-report.json'),'utf8'));
 const ocr=JSON.parse(await fs.readFile(path.join(job,'ocr.json'),'utf8'));
 const image=await fs.readFile(path.join(job,'normalized.png')),imageSha256=sha(image);
 if(state.status!=='completed'||sha(reportBytes)!==state.reportSha256||!isDeepStrictEqual(report,engineReport)||!isDeepStrictEqual(ocr,report.ocr)||report.manualCorrections!==0||report.originalPreserved!==true||report.hashes.normalized!==imageSha256)throw new Error('SOURCE_EVIDENCE_INVALID');
 const lines=ocr.speechBubbles.map(bubble=>({id:bubble.id,sourceText:bubble.text,order:bubble.readingOrder}));validateLines(lines);
 if(lines.some(line=>!report.lines.some(original=>original.id===line.id&&original.sourceText===line.sourceText)))throw new Error('SOURCE_ID_MISMATCH');
 return {job,image,imageSha256,lines,reportSha256:sha(reportBytes)};
}
