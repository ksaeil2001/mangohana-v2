// Administrator audit of an existing real mask. No OCR, translation, inpainting,
// browser navigation or result/state mutation is performed by this program.
const {app,nativeImage}=require('electron');
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {verifyLearnedMask,protectedOcrRegions}=require('../../packages/ai-engine/quality/mask-evidence.cjs');
const job=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
const profile=path.join(path.dirname(output),'mask-audit-profile-'+randomUUID());
fsSync.mkdirSync(profile,{recursive:false});
app.setPath('userData',profile);app.setPath('sessionData',profile);app.setPath('temp',profile);
app.disableHardwareAcceleration();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
 await app.whenReady();
 const files=['normalized.png','raw-ocr.json','region-selection.json','learned-mask-evidence.json','removal-mask.png','removal-mask-learned-gray.png'];
 const bytes=Object.fromEntries(await Promise.all(files.map(async name=>[name,await fs.readFile(path.join(job,name))])));
 const parse=name=>JSON.parse(bytes[name].toString('utf8'));
 const raw=parse('raw-ocr.json'),{detection,selection}=parse('region-selection.json'),reply=parse('learned-mask-evidence.json');
 const sourceHash=sha(bytes['normalized.png']);
 if(detection.imageSha256!==sourceHash)throw new Error('DETECTOR_SOURCE_MISMATCH');
 const ids=[...new Set(selection.decisions.filter(item=>item.action==='translate').map(item=>item.detectorRegionId))];
 const regions=ids.map(id=>{const detected=detection.regions.find(region=>region.id===id&&region.kind==='text_bubble');if(!detected)throw new Error('DETECTOR_ID_MISMATCH');return {id,bbox:detected.bbox};});
 const decode=name=>{const image=nativeImage.createFromBuffer(bytes[name]);const size=image.getSize();if(image.isEmpty()||size.width!==reply.width||size.height!==reply.height)throw new Error('DECODE_SIZE_MISMATCH');return image.toBitmap();};
 decode('normalized.png');
 const result=verifyLearnedMask({reply,request:{imageSha256:sourceHash,width:reply.width,height:reply.height,regions},
  bytes:bytes['removal-mask.png'],grayBytes:bytes['removal-mask-learned-gray.png'],bitmap:decode('removal-mask.png'),grayBitmap:decode('removal-mask-learned-gray.png'),
  protectedRegions:protectedOcrRegions(raw,selection)});
 const evidence={scope:'STORED_REAL_MASK_REVALIDATION_NO_AI',jobDirectory:job,aiRequests:0,
  priorExecutionUnchanged:true,originalSourceRegions:raw.speechBubbles.length,preexistingNonSpeechRegions:raw.nonSpeechText.length,
  hashes:Object.fromEntries(files.map(name=>[name,sha(bytes[name])])),
  verifierSha256:sha(await fs.readFile(path.resolve(__dirname,'../../packages/ai-engine/quality/mask-evidence.cjs'))),result};
 await fs.writeFile(output,JSON.stringify(evidence,null,2),{flag:'wx'});
 console.log(JSON.stringify(evidence));app.exit(0);
}
main().catch(error=>{console.error(JSON.stringify({scope:'STORED_REAL_MASK_REVALIDATION_NO_AI',code:error.code??'MASK_AUDIT_FAILED'}));app.exit(1);});
