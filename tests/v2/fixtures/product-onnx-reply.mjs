// Test child only. No Python, installed model, project page or network access.
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const [stage,fault]=process.argv.slice(2),chunks=[];
for await(const b of process.stdin)chunks.push(b);
const bytes=Buffer.concat(chunks),input=JSON.parse(bytes);
const box={x:0,y:0,width:1,height:1};
const region={id:'bubble-17',kind:'text_bubble',confidence:0.99,bbox:box};
const data=stage==='translate'&&fault==='unavailable'?{failure:'TRANSLATION_PROVIDER_UNAVAILABLE',inferenceStarted:false}:stage==='ocr'?{page:input.jobId,sourceSha256:input.sourceSha256,width:1,height:1,
  lines:[{...region,source:'テスト'}],detections:[region],uncoveredBubbles:fault==='miss'?['hole']:[]}:
  {lines:input.lines.map(row=>({...row,ko:fault==='repetition'?'가'.repeat(256):fault==='residue'?'日本語':'테스트',rawKo:'테스트',normalizations:[],flags:[]})),
    generation:{eos:true,inputTokens:24,generatedTokens:5},revision:'41a4dd4d147229f83043afb98a4d4c803b8bfcbb'};
if(stage==='translate'&&fault==='lost')process.exit(2);
process.stdout.write(JSON.stringify({provider:'onnx-cpu',stage,requestSha256:hash(bytes),data}));
