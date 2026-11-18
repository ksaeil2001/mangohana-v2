import fs from 'node:fs/promises';import path from 'node:path';import sharp from 'sharp';import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const ellipse=(x,y,rx,ry)=>({kind:'ellipse',x,y,rx,ry});
const line=(text,bbox,id='a',order=1)=>({id,order,pageNumber:1,sourceText:'合成原文',sourceLanguage:'ja',dialogueType:'speech',ocrEditStatus:'ai_proposed',parseConfidence:1,parseWarnings:[],aiTranslation:text,typesetting:{bbox,writingMode:'horizontal-tb'}});
const box=(x,y,width,height)=>({x,y,width,height});
export async function reviewFixtures(audit){
 const defs=[
 ['wide',600,380,[ellipse(300,190,265,155)],'첫 줄을 지킵니다.\n\n둘째 문단도 그대로 보존합니다.',box(.34,.3,.32,.35)],
 ['narrow',360,640,[ellipse(180,320,86,275)],'아무리길어도문자하나생략하지않고끝까지모두보존합니다',box(.43,.32,.14,.36)],
 ['oval',480,600,[ellipse(240,300,185,245)],'그렇다면 내일 다시 만나는 거야…!? 정말이지?',box(.4,.36,.2,.28)],
 ['irregular',520,560,[{kind:'polygon',points:[[120,75],[365,50],[460,205],[410,425],[280,465],[110,420],[60,230]]}],'불규칙한 말풍선에서도 글자를 모두 보존해야 해.',box(.38,.33,.22,.29)],
 ['long',620,600,[ellipse(310,300,275,260)],'이것은 대사가 긴 말풍선의 시험 문장입니다. 번역 내용을 줄이거나 생략해서는 안 됩니다. 한국어와 숫자 12.5kg, 30%도 그대로 보존합니다.',box(.4,.32,.2,.34)],
 ['exclamation',400,400,[ellipse(200,200,165,160)],'뭐?!',box(.43,.4,.14,.2)],
 ['small',420,340,[ellipse(210,170,76,40)],'작은 글씨도 모두 읽을 수 있어야 합니다.',box(.41,.46,.18,.09)],
 ['mixed',640,460,[ellipse(320,230,280,190)],'한글 ABC 12.5kg 日本語 한글 e\u0301…!?',box(.38,.3,.24,.36)],
 ['name',820,420,[{kind:'rectangle',x:35,y:40,width:750,height:340}],'AlexandertheGreat는 “정말…!?” 하고 물었어요. (123.45kg)',box(.3,.31,.4,.35)],
 ['adjacent',720,520,[ellipse(177,260,142,220),ellipse(543,260,142,220)],'이 말풍선의 대사야.',box(.19,.36,.12,.28)]
 ];
 const fixtures=defs.map(([id,width,height,shapes,text,bbox])=>({id,width,height,shapes,lines:[line(text,bbox)],level:'SYNTHETIC_KNOWN_GEOMETRY_AND_TEXT',source:{kind:'synthetic',humanTranslationGt:false}}));
 fixtures.find(x=>x.id==='irregular').tail=[[275,443],[266,532],[330,442]];
 fixtures.find(x=>x.id==='adjacent').lines.push(line('옆 대사와 겹치면 안 돼!',box(.7,.35,.12,.3),'b',2));
 const baseline=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
 const pins=baseline.protectedFiles,translation=pins.find(r=>/one-page.*translations\.json$/.test(r.path));
 const read=async pin=>{const bytes=await fs.readFile(pin.path);if(sha(bytes)!==pin.sha256)throw Error('saved source pin mismatch');return bytes;};
 const translations=JSON.parse(await read(translation)),base=path.dirname(translation.path),normalized=pins.find(r=>r.path===path.join(base,'normalized.png')),cleaned=pins.find(r=>r.path===path.join(base,'cleaned.png'));
 const [originalBytes,cleanBytes]=await Promise.all([read(normalized),read(cleaned)]),metadata=await sharp(cleanBytes).metadata();
 const selected=translations.lines.filter(l=>l.aiTranslation?.length>10&&l.typesetting?.bbox).slice(0,3);
 for(const [index,saved]of selected.entries()){
  const b=saved.typesetting.bbox,W=metadata.width,H=metadata.height,cx=(b.x+b.width/2)*W,cy=(b.y+b.height/2)*H;
  const left=Math.max(0,Math.floor(cx-Math.max(b.width*W*2,180))),top=Math.max(0,Math.floor(cy-Math.max(b.height*H*2,180)));
  const width=Math.min(W-left,Math.ceil(cx+Math.max(b.width*W*2,180))-left),height=Math.min(H-top,Math.ceil(cy+Math.max(b.height*H*2,180))-top),crop={left,top,width,height};
  const original=await sharp(originalBytes).extract(crop).png().toBuffer(),clean=await sharp(cleanBytes).extract(crop).png().toBuffer();
  const candidate=structuredClone(saved);candidate.typesetting={...saved.typesetting,bbox:box((b.x*W-left)/width,(b.y*H-top)/height,b.width*W/width,b.height*H/height)};
  fixtures.push({id:'saved-'+(index+1),level:'SAVED_REAL_IMAGE_CROP_UNREVIEWED_EXISTING_TRANSLATION',width,height,original:original.toString('base64'),cleaned:clean.toString('base64'),lines:[candidate],source:{normalized,cleaned,translation,crop,normalizedDimensions:{width:W,height:H},sourceRegionId:saved.id,cropOriginalSha256:sha(original),cropCleanedSha256:sha(clean),semanticAccuracy:null,maskInteriorQuality:null,humanReview:'pending',sourceLineIds:saved.sourceLineIds??null,ocrGeneration:'historical_saved_run_not_new_stage11_inference'}});
 }
 return fixtures;
}
