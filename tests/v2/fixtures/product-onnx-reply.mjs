// Test child only. No Python, installed model, project page or network access.
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const [stage,fault]=process.argv.slice(2),chunks=[];
for await(const b of process.stdin)chunks.push(b);
const bytes=Buffer.concat(chunks),input=JSON.parse(bytes);
const box={x:0,y:0,width:1,height:1};
const mixed = ['mixed', 'name-mixed'].includes(fault);
const textOnly = ['notes', 'name-note'].includes(fault);
const region={id:'bubble-17',kind:textOnly?'text_free':'text_bubble',confidence:0.99,bbox:mixed?{...box,width:.45}:box};
const terminology={
  'predicate-gasp':{source:'寝ちゃったよ！',ko:'헉… 헉…',flags:[]},
  'punctuation-word':{source:'、',ko:'그리고',flags:[]},
  'numeric-fields':{source:'【体力：35/100】【気力：80/100】',ko:'[체력: 35/100] '+'[기력: 80/100] '.repeat(6).trimEnd(),flags:[]},
  'name-inline':{source:'アリスの説明',ko:'アリス의 설명',flags:['JAPANESE_REMAINS']},
  'name-only':{source:'アリス',ko:'アリス',flags:['JAPANESE_REMAINS','NO_HANGUL']},
  'name-copy':{source:'アリスの説明',ko:'アリスの説明',flags:['JAPANESE_REMAINS','NO_HANGUL']},
  'name-promise':{source:'アリスを呼んで！',ko:'アリス를 부를게!',flags:['JAPANESE_REMAINS','REQUEST_BECAME_PROMISE']},
};
const first = terminology[fault] ?? (fault === 'name-note' ? terminology['name-only'] : undefined);
const sign = fault === 'name-mixed' ? terminology['name-inline'] : undefined;
const lines=[{...region,source:first?.source??'テスト'}];
if(mixed)lines.push({id:'sign',kind:'text_free',confidence:.95,bbox:{x:.6,y:.2,width:.25,height:.4},source:sign?.source??'出口'});
const data=stage==='translate'&&fault==='unavailable'?{failure:'TRANSLATION_PROVIDER_UNAVAILABLE',inferenceStarted:false}:stage==='ocr'?{page:input.jobId,sourceSha256:input.sourceSha256,width:1,height:1,
  lines,detections:lines,uncoveredBubbles:fault==='miss'?['hole']:[]}:
  {lines:input.lines.map(row=>{
    const term = row.id === 'sign' ? sign : first;
    return {...row,ko:term?.ko??(fault==='repetition'?'가'.repeat(256):fault==='residue'?'日本語':'테스트'),rawKo:term?.ko??'테스트',normalizations:[],flags:term?.flags??[]};
  }),
    generation:{eos:true,inputTokens:24,generatedTokens:5},revision:'41a4dd4d147229f83043afb98a4d4c803b8bfcbb'};
if(stage==='translate'&&fault==='lost')process.exit(2);
process.stdout.write(JSON.stringify({provider:'onnx-cpu',stage,requestSha256:hash(bytes),data}));
