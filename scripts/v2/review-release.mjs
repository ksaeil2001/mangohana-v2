import {readFile} from 'node:fs/promises';
import {assessRelease,rehearseRollback} from '../../packages/evaluation/stage17-release.mjs';

const [mode,...args]=process.argv.slice(2);
if(mode==='check'&&args.length===2){
  const [packet,pins]=await Promise.all(args.map(async f=>JSON.parse(await readFile(f,'utf8'))));
  const result=assessRelease(packet,pins);
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.status==='BLOCKED'?2:0;
}else if(mode==='rehearse'&&args.length===4){
  const [previous,previousSha256,failed,candidateSha256]=args;
  console.log(JSON.stringify(await rehearseRollback({previous,previousSha256,failed,candidateSha256}),null,2));
}else{
  console.error('Usage: review-release.mjs check DOSSIER.json TRUSTED-PINS.json | rehearse PREVIOUS PREVIOUS-SHA CANDIDATE CANDIDATE-SHA');
  process.exitCode=64;
}
