// Deliberately exits a synthetic Node worker after the real running state reaches disk.
import fs from 'node:fs/promises';import path from 'node:path';import {createJobStore} from '../../apps/engine/store.mjs';
const [root,owner,pngBase64]=process.argv.slice(2),bytes=Buffer.from(pngBase64,'base64');
const engine={health:()=>({ready:true}),inspectImage:()=>({width:1,height:1}),close:async()=>{},async run(input){
 await input.onProgress({stage:'translate',progress:30,message:'synthetic abrupt exit'});
 await fs.writeFile(path.join(root,'stage13-abrupt-exit.json'),JSON.stringify({jobId:input.jobId,pid:process.pid,exitCode:23,modelsLoaded:0}),{flag:'wx'});process.exit(23);
}};
const store=await createJobStore({root,engine});await store.submit({owner,idempotencyKey:'abrupt-exit',bytes,name:'synthetic.png',projectId:'work',pageId:'crash-page'});
