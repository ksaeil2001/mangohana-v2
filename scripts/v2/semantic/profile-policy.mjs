// Internal resource diagnosis only. Both reviewed profiles retain core limits.
export function modelArguments({profile,modelPath,projectorPath,alias,port}){
 const vision=profile?.imageMaxTokens===1024;
 const specialLoad=profile?.loadMode==='none'&&profile?.noHost===true;
 const standardLoad=profile?.loadMode===undefined&&profile?.noHost===undefined;
 if(!profile||profile.gpuLayers!==20||profile.contextSize!==8192||typeof profile.thinking!=='boolean'||profile.reasoningBudget!==(profile.thinking?1024:0)||
  !(vision?profile.batchSize===4096&&profile.ubatchSize===4096&&typeof projectorPath==='string':profile.imageMaxTokens===0&&profile.batchSize===512&&profile.ubatchSize===512)||!standardLoad&&!specialLoad||vision&&specialLoad)throw new Error('RESOURCE_PROFILE_INVALID');
 return ['--model',modelPath,...(vision?['--mmproj',projectorPath]:[]),'--host','127.0.0.1','--port',String(port),'--alias',alias,'--ctx-size',String(profile.contextSize),'--parallel','1','--n-gpu-layers',String(profile.gpuLayers),'--threads','4','--reasoning',profile.thinking?'on':'off','--reasoning-budget',String(profile.reasoningBudget),'--no-webui','--batch-size',String(profile.batchSize),'--ubatch-size',String(profile.ubatchSize),...(vision?['--image-max-tokens',String(profile.imageMaxTokens)]:[]),...(specialLoad?['--load-mode','none','--no-host']:[]),'-lv','4'];
}

export function textOnlyRequest(body){
 if(!body||body.messages?.length!==2||body.messages[0].role!=='system'||typeof body.messages[0].content!=='string'||body.messages[1].role!=='user'||!Array.isArray(body.messages[1].content)||body.messages[1].content.length!==2||body.messages[1].content.filter(part=>part.type==='text'&&typeof part.text==='string').length!==1||body.messages[1].content.filter(part=>part.type==='image_url').length!==1)throw new Error('TEXT_ONLY_REQUEST_INVALID');
 const system=body.messages[0].content
  .replace('페이지 그림과 전체 대사, 앞 페이지 문맥을 함께 사용하세요.','그림이 제공되지 않았습니다. 전체 대사와 앞 페이지 문맥만 사용하며 그림의 내용을 추측하지 마세요.')
  .replace('그림과 문맥으로만 읽고','대사 문맥으로만 읽고');
 if(!system.includes('그림이 제공되지 않았습니다'))throw new Error('TEXT_ONLY_REQUEST_INVALID');
 return {...body,messages:[{...body.messages[0],content:system},{...body.messages[1],content:body.messages[1].content.filter(part=>part.type==='text').map(part=>({...part}))}]};
}
