import { spawn } from 'node:child_process';
import { mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const engineRoot = path.dirname(fileURLToPath(import.meta.url));
export const repository = path.join(engineRoot,'vendor/trio');
export const buildRoot = path.join(engineRoot,'.build/compiled');
export const rendererBundle = path.join(engineRoot,'.build/renderer.js');
export async function buildEngine() {
  await mkdir(path.dirname(rendererBundle),{recursive:true});
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(engineRoot,'node_modules/typescript/bin/tsc'),'-p',path.join(engineRoot,'tsconfig.json')],{cwd:engineRoot,windowsHide:true,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('엔진 TypeScript 빌드 실패')));
  });
  await build({configFile:false,root:repository,logLevel:'warn',build:{emptyOutDir:false,minify:false,outDir:path.dirname(rendererBundle),lib:{entry:path.join(repository,'scripts/sites-local/renderer.ts'),name:'SitesCandidate',formats:['iife'],fileName:()=>path.basename(rendererBundle)}}});
  const resourcesPath=path.join(engineRoot,'.build/resources');
  await cp(path.join(repository,'resources'),resourcesPath,{recursive:true});
  await cp(path.join(repository,'resources/font_ko_fallback/pretendard-1.3.9'),path.join(resourcesPath,'pipeline-resources/pretendard-ko-fallback/1.3.9'),{recursive:true,filter:file=>path.basename(file)!=='source-manifest.json'});
  return {repository,buildRoot,rendererBundle,resourcesPath};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildEngine()));
