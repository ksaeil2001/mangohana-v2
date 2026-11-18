import path from 'node:path';
const runIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function ownedStopPath(root,runId){
  if(!runIdPattern.test(runId))throw new Error('잘못된 실행 ID입니다.');
  return path.resolve(root,'STOP-'+runId);
}
export function ownsRuntime(runtime,pid,runId){
  return runtime?.status==='listening'&&runtime.pid===pid&&runtime.runId===runId&&runIdPattern.test(runId);
}
