import test from 'node:test';import assert from 'node:assert/strict';import {tsImport} from 'tsx/esm/api';
const {renderPage}=await tsImport('../../apps/sites/lib/studio-files.ts',import.meta.url);
const page=()=>({id:'p',name:'test',image:'synthetic',width:500,height:500,blocks:[{id:'a',text:'한국어를 모두 보존합니다.',x:10,y:10,w:50,h:30,font:'sans',size:20,weight:600,align:'center',color:'#000',lineHeight:1.4,fill:false}]});
async function withCanvas(run){const oldDoc=globalThis.document,oldImage=globalThis.Image;let clips=0,serializations=0;const calls=[];
 const ctx={font:'',save(){},restore(){},beginPath(){},rect(){},clip(){clips++;},fillRect(){},drawImage(){},fillText(t,x,y){calls.push({t,x,y});},measureText(t){const w=[...t].length*20;return {width:w,actualBoundingBoxLeft:this.textAlign==='center'?w/2:0,actualBoundingBoxRight:this.textAlign==='center'?w/2:w,actualBoundingBoxAscent:10,actualBoundingBoxDescent:10};}};
 globalThis.document={fonts:{ready:Promise.resolve(),load:async()=>[],check:()=>true},createElement(){return {getContext:()=>ctx,toBlob(cb){serializations++;cb(new Blob(['synthetic PNG']));}};}};
 globalThis.Image=class{naturalWidth=500;naturalHeight=500;set src(v){queueMicrotask(()=>this.onload());}};
 try{await run({ctx,calls,get clips(){return clips;},get serializations(){return serializations;}});}finally{globalThis.document=oldDoc;globalThis.Image=oldImage;}
}
test('manual export never hides overflowing text behind a canvas clip or serializes a partial PNG',()=>withCanvas(async state=>{
 const p=page();p.blocks[0].h=2;await assert.rejects(renderPage(p),/식자|배치|넘|잘/);assert.equal(state.serializations,0);
}));
test('valid manual export keeps all text and user size/position without clipping',()=>withCanvas(async state=>{
 const p=page(),before=structuredClone(p);await renderPage(p);assert.equal(state.clips,0);assert.deepEqual(p,before);assert.equal(state.calls.map(c=>c.t).join(''),p.blocks[0].text);
}));
test('manual export refuses a cleaned image from a different pixel frame',()=>withCanvas(async state=>{
 const p=page();p.width=600;await assert.rejects(renderPage(p),/해상도|크기/);assert.equal(state.serializations,0);
}));
