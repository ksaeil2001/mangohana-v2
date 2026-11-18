// Bundle the actual product functions for offline Electron comparisons. No model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [audit,name]=process.argv.slice(2);
if(!path.isAbsolute(audit??'')||!/^[-a-z0-9]+$/.test(name??''))throw Error('absolute audit and fresh build name required');
const root=process.cwd(),out=path.join(audit,'evidence',name),vendor=path.join(root,'packages/ai-engine/vendor/trio');
await fs.mkdir(out,{recursive:false});
const modules={
 '../scripts/local-preview/renderer.ts':['renderCandidate'],
 '../scripts/sites-local/renderer.ts':['prepare','render','invalidate'],
 'renderer/imageBurnInRenderer.ts':['getResolvedDialogueText','renderTypesettingToCanvas'],
 'renderer/candidateTypesettingFit.ts':['measureCandidateFit','inspectCandidateInk','findInteriorRectangle'],
 'shared/typesettingGeometry.ts':['layoutTextForBubbleShape','autoFitFontSizeForBubbleShape','getRecommendedFontFallbackChain']
};
const entry=path.join(out,'entry.ts');
await fs.writeFile(entry,Object.entries(modules).map(([p,names])=>`export { ${names.join(', ')} } from ${JSON.stringify(path.resolve(vendor,'src',p).replaceAll('\\','/'))};`).join('\n'),{flag:'wx'});
const require=createRequire(path.join(root,'packages/ai-engine/package.json')),{build}=await import(pathToFileURL(require.resolve('vite')).href);
await build({configFile:false,root:vendor,logLevel:'warn',build:{emptyOutDir:false,minify:false,outDir:out,lib:{entry,name:'Stage12Product',formats:['iife'],fileName:()=> 'renderer.js'}}});
const bytes=await fs.readFile(path.join(out,'renderer.js'));
console.log(JSON.stringify({output:out,rendererBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
