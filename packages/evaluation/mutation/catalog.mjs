import assert from 'node:assert/strict';
const clone = structuredClone;
const box=(x,y,width=.2,height=.22)=>({x,y,width,height});
const get=(obj,keys)=>keys.reduce((v,k)=>v?.[k],obj);
export function applyOperator(original, patches) {
  const value=clone(original);
  for(const p of patches) {
    const parent=get(value,p.path.slice(0,-1)),key=p.path.at(-1);
    assert.ok(parent && p.path.length,'Invalid mutation path');
    if(p.op==='delete') delete parent[key];
    else {assert.equal(p.op,'set');parent[key]=clone(p.value);}
  }
  return value;
}
const set=(path,value)=>({op:'set',path:path.split('.'),value});
const del=path=>({op:'delete',path:path.split('.')});
const make=(mutationId,area,lane,label,base,patches,expectedDecision,extra={})=>({
  mutationId,originalFixtureId:mutationId+'-original-v1',familyFixtureId:area+'-normal-v1',area,lane,label,severity:'major',truth:patches.length?'defect':'normal',independentOracle:true,
  oracleOrigin:'PROGRAMMATIC_SYNTHETIC_TEST_SPEC_NOT_HUMAN_MANGA_GT',operator:patches.length?'EXPLICIT_PATCH_SEQUENCE':'IDENTITY_CONTROL',patches,
  expectedDecision,expectedVerdict:expectedDecision==='error'?'DETECTED':expectedDecision==='pass'?(patches.length?'MISSED':'CORRECT_PASS'):expectedDecision==='review'?'NEEDS_REVIEW':expectedDecision==='unsupported'?'UNSUPPORTED_DETECTOR':'NOT_MEASURABLE',
  baseline:base,...extra});
export function materializeCase(c) {
  const mutant=applyOperator(c.baseline,c.patches);
  for(const p of c.patches) assert.notDeepEqual(get(c.baseline,p.path),get(mutant,p.path),'Operator did not inject its declared change');
  if(c.baseline.reference && !c.allowOracleChange)assert.deepEqual(mutant.reference,c.baseline.reference,'Mutation modified the independent oracle');
  return {baseline:clone(c.baseline),mutant,proof:{verified:true,changedPaths:c.patches.map(p=>p.path.join('.')),
    changes:c.patches.map(p=>({path:p.path,before:get(c.baseline,p.path)??null,after:get(mutant,p.path)??null,operation:p.op})),oracleUnchanged:!c.allowOracleChange}};
}

export function mutationCatalog() {
  const cases=[];
  const refs=[{id:'ref-1',text:'行かない',translation:'안 갈게',bbox:box(.1,.1),order:1},
    {id:'ref-2',text:'田中（20）',translation:'다나카(20)',bbox:box(.65,.1),order:2},
    {id:'ref-small',text:'注',translation:'주',bbox:box(.1,.6,.06,.06),order:3}];
  const ocr={reference:{regions:refs,glyphBox:{x:4,y:2,width:2,height:6},furigana:{small:'line-1'}},
    regions:refs.map((r,i)=>({id:'prediction-'+(i+1),text:r.text,bbox:clone(r.bbox),readingOrder:r.order})),
    mapping:{line1:['roi-1'],line2:['roi-2','roi-3']},furigana:{small:'line-1'},sourceLineIds:['line-1','line-2','small'],
    detectionConfidence:.99,recognitionAccuracy:null,redetection:{x:0,y:0,width:10,height:10}};
  const oc=(id,label,patches,decision='error',extra={})=>cases.push(make(id,'ocr','quality',label,ocr,patches,decision,{detector:'STAGE02_FINAL_REGION_CER_ORDER',...extra}));
  oc('OCR-01','정상 원문과 정상 OCR',[],'pass');
  oc('OCR-02','대사 글줄 삭제',[set('regions',ocr.regions.slice(1))]);
  oc('OCR-03','없는 글줄 추가',[set('regions',[...ocr.regions,{id:'extra',text:'追加',bbox:box(.65,.6),readingOrder:4}])]);
  oc('OCR-04','다른 ID로 중복 글줄',[set('regions',[...ocr.regions,{...ocr.regions[0],id:'duplicate',readingOrder:4}])]);
  oc('OCR-05','두 글줄 잘못 병합',[set('regions',[{...ocr.regions[0],text:refs[0].text+refs[1].text,bbox:box(.1,.1,.75,.22)},ocr.regions[2]])]);
  oc('OCR-06','글줄 잘못 분할',[set('regions',[{...ocr.regions[0],text:'行か',bbox:box(.1,.1,.2,.10)},{id:'split',text:'ない',bbox:box(.1,.22,.2,.10),readingOrder:4},...ocr.regions.slice(1)])]);
  oc('OCR-07','다른 말풍선에 배정',[set('regions.0.bbox',ocr.regions[1].bbox),set('regions.1.bbox',ocr.regions[0].bbox)]);
  oc('OCR-08','유효한 ID의 다중 ROI 연결 오류',[set('mapping.line2',['roi-1'])],'unsupported',{reason:'HUMAN_LINE_TO_ROI_DETECTOR_NOT_IMPLEMENTED'});
  oc('OCR-09','세로쓰기 읽기 순서 변경',[set('regions.0.readingOrder',2),set('regions.1.readingOrder',1)]);
  oc('OCR-10','후리가나 대응 오류',[set('furigana.small','line-2')],'unsupported',{reason:'FURIGANA_ASSOCIATION_DETECTOR_NOT_IMPLEMENTED'});
  oc('OCR-11','작은 글씨 누락',[set('regions',ocr.regions.slice(0,2))]);
  oc('OCR-12','원본 글줄 ID 소실',[set('sourceLineIds',[])],'error',{lane:'structure',detector:'STAGE06_SOURCE_PROVENANCE'});
  oc('OCR-13','검출 confidence를 인식 정확도로 주장',[set('recognitionAccuracy',.99)],'unmeasured',{reason:'DETECTOR_CONFIDENCE_IS_NOT_CHARACTER_ACCURACY'});
  oc('OCR-14','여백만 줄어든 재검출',[set('redetection',{x:3,y:1,width:4,height:8})],'review',{truth:'normal',reason:'GEOMETRY_ALONE_CANNOT_CONFIRM_GLYPH_PRESERVATION'});
  oc('OCR-15','실제 글자 일부가 빠진 재검출',[set('redetection',{x:5,y:1,width:2,height:8})],'review',{reason:'GEOMETRY_ALONE_CANNOT_CONFIRM_GLYPH_PRESERVATION'});

  const meanings=[
    ['SEM-01','부정→긍정','行かない','안 갈게','갈게','critical'],
    ['SEM-02','긍정→부정','行く','갈게','안 갈게','critical'],
    ['SEM-03','이름 변경','田中だ','다나카야','스즈키야','major'],
    ['SEM-04','수량 변경','三個ある','세 개 있어','두 개 있어','major'],
    ['SEM-05','의미 일부 삭제','田中（20）','다나카(20)','다나카','major'],
    ['SEM-06','없는 내용 추가','帰る','돌아갈게','돌아가서 돈을 훔칠게','major'],
    ['SEM-07','질문→평서','行くの？','갈 거야?','갈 거야.','major'],
    ['SEM-08','명령→요청','今すぐ来い','당장 와','와 주실래요?','major'],
    ['SEM-09','화자 혼동','私が行く','내가 갈게','네가 가','critical'],
    ['SEM-10','존댓말 불일치','待ってください','기다려 주세요','기다려','major'],
    ['SEM-11','호칭 변경','お兄さん','오빠','아저씨','major'],
    ['SEM-12','시제·상 변경','もう食べた','벌써 먹었어','이제 먹을 거야','major'],
    ['SEM-13','작품 용어 불일치','星門を開ける','별문을 연다','우주항을 연다','major'],
    ['SEM-14','문맥 충돌','彼はここにいる','그는 여기에 있어','그는 죽어서 없어','critical'],
    ['SEM-15','모호성을 확정','来るかもしれない','올지도 몰라','분명히 올 거야','major'],
  ];
  for(const [id,label,source,correct,wrong,severity] of meanings) {
    cases.push(make(id,'semantic','quality',label,{reference:{source,acceptable:[correct],context:'명시된 합성 상황'},source,translation:correct},[set('translation',wrong)],'unsupported',
      {severity,detector:'LEGACY_TRANSLATION_RULE_QA_PLUS_STAGE06_ASSESSMENT_GATE',reason:'SEMANTIC_DETECTION_NOT_IMPLEMENTED'}));
  }
  for(const [id,source,a,b] of [['SEM-C01','ありがとう','고마워','고마워'],['SEM-C02','ありがとう','고마워','정말 고맙다'],['SEM-C03','少し待って','잠깐 기다려','잠시만 기다려 줘']])
    cases.push(make(id,'semantic','quality','허용 가능한 자연스러운 표현',{reference:{source,acceptable:[a,b]},source,translation:a},a===b?[]:[set('translation',b)],'unsupported',{truth:'normal',detector:'LEGACY_TRANSLATION_RULE_QA',semanticVerified:false}));
  for(const [id,text,decision] of [['SEM-R01','', 'error'],['SEM-R02','고마워 ありがとう','review'],['SEM-R03','고마워 あ','pass']])
    cases.push(make(id,'semantic_rules','quality','규칙 범위 대조',{reference:{source:'ありがとう',acceptable:['고마워']},source:'ありがとう',translation:'고마워'},[set('translation',text)],decision,{detector:'LEGACY_TRANSLATION_RULE_QA',reason:decision==='pass'?'SINGLE_KANA_RESIDUE_MISSED_BY_RULE':null}));
  cases.push(make('RULE-C01','semantic_rules','quality','정상 자연스러운 번역 규칙 대조',{reference:{source:'ありがとう',acceptable:['고마워']},source:'ありがとう',translation:'고마워'},[],'pass',{detector:'LEGACY_TRANSLATION_RULE_QA'}));

  // Each pixel is an intentional toy primitive, not an assertion about a real manga glyph.
  const width=8,height=8,pixels=Array(width*height*4).fill(255);
  const paint=(a,indices,color)=>{const b=[...a];for(const i of indices)b.splice(i*4,4,...color);return b;};
  const glyph=[18,19,26,27],halo=[17,20],sfx=[6,7],border=[0,1,2],art=[42,43],contact=[28],remove=[...glyph,...halo,35];
  let source=paint(pixels,[...glyph,...sfx,...border,...art,...contact],[0,0,0,255]);source=paint(source,halo,[230,230,230,255]);
  const clean=paint(source,[...glyph,...halo],[255,255,255,255]);
  const image={width,height,source,cleaned:clean,removal:remove,protection:[...sfx,...border,...art,...contact],encoding:'binary255_active_remove',
    reference:{cleaned:clean,glyph,halo,sfx,border,art,contact,remove,hiddenBackgroundAvailable:true}};
  const im=(id,label,patches,decision,extra={})=>cases.push(make(id,'image','quality',label,image,patches,decision,{detector:'STAGE06_EXACT_RGBA_MASK_COMPARISON',...extra}));
  im('IMG-01','일본어 획 일부 잔류',[set('cleaned',paint(clean,[18],[0,0,0,255]))],'unsupported',{reason:'SOURCE_RESIDUE_DETECTOR_NOT_IMPLEMENTED'});
  im('IMG-02','흰 외곽선 잔류',[set('cleaned',paint(clean,[17],[230,230,230,255]))],'unsupported',{reason:'WHITE_HALO_DETECTOR_NOT_IMPLEMENTED'});
  im('IMG-03','반투명 원문 잔상',[set('cleaned',paint(clean,[19],[220,220,220,255]))],'unsupported',{reason:'TRANSLUCENT_RESIDUE_DETECTOR_NOT_IMPLEMENTED'});
  for(const [id,label,indices] of [['IMG-04','보존 효과음 삭제',sfx],['IMG-05','말풍선 테두리 삭제',border],['IMG-06','캐릭터 선화 삭제',art],['IMG-07','문자와 붙은 그림 손상',contact],['IMG-08','보호 영역 침범',[42]]])
    im(id,label,[set('cleaned',paint(clean,indices,[255,255,255,255]))],'error',{reason:'PROTECTED_PIXEL_DELTA_NOT_SEMANTIC_ARTWORK_RECOGNITION'});
  im('IMG-09','마스크 밖 픽셀 변경',[set('cleaned',paint(clean,[60],[0,0,0,255]))],'error');
  im('IMG-10','제거·보호 마스크 충돌',[set('removal',[...remove,42])],'error');
  im('IMG-11','alpha 제거·보존 의미 반전',[set('encoding','studio_inverse_alpha')],'error',{reason:'MASK_ENCODING_INVERTED_PIXELS_COMPARE_TO_TOY_MASK_ORACLE'});
  im('IMG-12','복원 내부 인공 무늬',[set('cleaned',paint(clean,[35],[0,0,0,255]))],'unsupported',{reason:'INSIDE_ARTWORK_DEFECT_DETECTOR_NOT_IMPLEMENTED'});
  im('IMG-C01','안전한 합성 복원·효과음 보존',[],'pass');
  im('IMG-C02','숨겨진 배경 정답 없음',[set('reference.hiddenBackgroundAvailable',false)],'unmeasured',{truth:'unknown',independentOracle:false,allowOracleChange:true,reason:'HIDDEN_BACKGROUND_TRUTH_NOT_AVAILABLE'});
  im('IMG-C03','mask 안쪽 선화 손상·밖 변경0',[set('removal',[...remove,42]),set('protection',image.protection.filter(i=>i!==42)),set('cleaned',paint(clean,[42],[255,255,255,255]))],'unsupported',{reason:'OUTSIDE_ZERO_DOES_NOT_CERTIFY_INSIDE_ARTWORK'});
  cases.push(make('COMPOUND-01','image','quality','잔상 제거 후 새 작화 손상',{...image,cleaned:paint(clean,[18],[0,0,0,255])},[set('cleaned',paint(clean,[42],[255,255,255,255]))],'error',
    {detector:'STAGE06_EXACT_RGBA_MASK_COMPARISON',resolvedDefect:'SOURCE_STROKE_RESIDUE',introducedDefect:'PROTECTED_ARTWORK_ERASURE'}));

  const type={reference:{text:'가나',glyphPixels:[9,10,17,18],safePixels:[9,10,17,18,25,26],minimumFontSizePx:12},
    text:'가나',translationId:'g1',layoutId:'g1',fontSizePx:20,fontLoaded:true,glyphs:['가','나'],pixels:[9,10,17,18],bubbleId:'bubble-1',safePixels:[9,10,17,18,25,26],rotation:0,userEdit:'가나'};
  const ty=(id,label,patches,decision='unsupported',extra={})=>cases.push(make(id,'typesetting','quality',label,type,patches,decision,{detector:'STAGE06_TYPESETTING_REPORT',reason:'ACTUAL_GLYPH_OR_LAYOUT_QUALITY_DETECTOR_NOT_IMPLEMENTED',...extra}));
  ty('TYPE-01','글자 하나 누락',[set('text','가'),set('glyphs',['가']),set('pixels',[9,10])]);
  ty('TYPE-02','글리프 누락',[set('glyphs',['가']),set('pixels',[9,10])]);
  ty('TYPE-03','말풍선 밖 넘침',[set('pixels',[9,10,17,18,60])],'review',{reason:'ENGINE_RASTER_CLAIM_REQUIRES_INDEPENDENT_PIXEL_AUDIT'});
  ty('TYPE-04','안전 영역 밖 렌더링',[set('pixels',[9,10,17,18,27])],'review',{reason:'ENGINE_RASTER_CLAIM_REQUIRES_INDEPENDENT_PIXEL_AUDIT'});
  ty('TYPE-05','너무 작은 글꼴',[set('fontSizePx',2)],'unmeasured',{reason:'READABILITY_THRESHOLD_NOT_HUMAN_DEFINED'});
  ty('TYPE-06','과도하게 긴 문장',[set('text','가나'.repeat(200))]);
  ty('TYPE-07','clipping으로 문자 일부 소실',[set('pixels',[9,10,17])]);
  ty('TYPE-08','다른 말풍선에 배치',[set('bubbleId','bubble-2')]);
  ty('TYPE-09','번역 ID·식자 ID 불일치',[set('layoutId','foreign')],'error',{lane:'structure',reason:'TYPESETTING_LINEAGE_MISMATCH'});
  ty('TYPE-10','사용자 수정 후 이전 텍스트 렌더',[set('userEdit','다라')]);
  ty('TYPE-11','회전·세로쓰기 오류',[set('rotation',90),set('pixels',[14,22,13,21])],'review',{reason:'RASTER_OUTSIDE_SAFE_AREA_SIGNAL_NOT_ORIENTATION_CLASSIFICATION'});
  ty('TYPE-12','폰트 로딩 성공·실제 glyph 없음',[set('glyphs',[]),set('pixels',[])]);
  ty('TYPE-C01','정상 크기·줄바꿈·픽셀',[],'pass',{reason:null});
  ty('TYPE-C02','내부 픽셀 측정 없음',[set('pixels',null)],'unmeasured',{truth:'unknown',independentOracle:false,reason:'BUBBLE_INTERIOR_NOT_MEASURED_FOR_ALL_TARGETS'});

  const opbase={reference:{executionVerified:false,qualityMeasured:false},mode:'normal'};
  const operations=[
    ['OPS-01','실제 모델 호출 없이 성공 주장','no_model','review','integrity'],
    ['OPS-02','실패 job을 completed로 주장','failed_completed','error','integrity'],
    ['OPS-03','재시도를 최초 성공으로 집계','retry','error','report_contract'],
    ['OPS-04','수동 수정을 자동 성공으로 집계','manual','error','report_contract'],
    ['OPS-05','이전 generation','generation','error','integrity'],
    ['OPS-06','다른 source revision','revision','error','integrity'],
    ['OPS-07','사용자 확정값 덮어쓰기','user_overwrite','error','integrity'],
    ['OPS-08','실패 결과가 이전 PNG 교체','failed_replace','error','integrity'],
    ['OPS-09','일부 OCR만 전체 완료 주장','partial','error','structure'],
    ['OPS-10','공유 요청 비용 중복 집계','shared_cost','error','report_contract'],
    ['OPS-11','미측정 비용을 0으로 승격','unknown_cost','error','report_contract'],
    ['OPS-12','미측정 품질을 PASS로 승격','quality_pass','error','report_contract'],
    ['OPS-13','AI를 사람 검수로 위장','ai_human','error','integrity'],
    ['OPS-14','무검수 결과 전달 가능','deliverable','error','report_contract'],
    ['OPS-15','다른 작품 정답 혼입','foreign_gt','error','integrity'],
  ];
  for(const [id,label,mode,decision,lane] of operations)cases.push(make(id,'operations',lane,label,opbase,[set('mode',mode)],decision,{detector:'STAGE04_ADMISSION_STAGE06_EVIDENCE_REPORT_OPERATIONS'}));
  for(const [id,mode,label] of [['OPS-C01','normal','정상 revision'],['OPS-C02','legal_retry','적법한 재시도'],['OPS-C03','zero','실제 측정값0'],['OPS-C04','unknown','미측정 비용 null 유지']])
    cases.push(make(id,'operations','report_contract',label,opbase,mode==='normal'?[]:[set('mode',mode)],mode==='unknown'?'unmeasured':'pass',{truth:mode==='unknown'?'unknown':'normal',independentOracle:mode!=='unknown',detector:'STAGE06_OPERATIONS'}));
  for(const [id,mode,label] of [['INT-01','hash','내용 변경·기존 해시 유지'],['INT-02','job','다른 job OCR 삽입'],['INT-03','page','다른 페이지 번역 연결'],['INT-04','work','다른 작품 문맥'],['INT-05','owner','다른 소유자']])
    cases.push(make(id,'integrity','integrity',label,opbase,[set('mode',mode)],'error',{detector:'STAGE06_EVIDENCE_BINDING'}));
  cases.push(make('INT-C01','integrity','integrity','정상 파일 pin·연결',opbase,[],'pass',{detector:'STAGE06_EVIDENCE_BINDING'}));
  cases.push(make('STRUCT-C01','operations','structure','정상 원본 ID·번역 연결',opbase,[],'pass',{detector:'STAGE06_EVIDENCE_BINDING'}));
  assert.equal(new Set(cases.map(c=>c.mutationId)).size,cases.length);
  return cases;
}
