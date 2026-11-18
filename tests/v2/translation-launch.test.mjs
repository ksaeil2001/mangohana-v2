// Native argument boundary only. No model/process is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {llamaArguments}=createRequire(import.meta.url)('../../packages/ai-engine/vendor/trio/scripts/sites-local/translation-launch.cjs');
const base={gemmaModel:'E:/models/example.gguf',mmproj:'E:/models/projector.gguf'};
test('page translation prefills an empty thought channel in the pinned Gemma4 template',()=>{
 const args=llamaArguments({...base,pageContextTranslation:true},12345);
 assert.ok(args.includes('--chat-template-file'));
 assert.match(args[args.indexOf('--chat-template-file')+1],/gemma4-final-content\.jinja$/);
 assert.equal(args.includes('--skip-chat-parsing'),false);assert.equal(args.includes('--reasoning-format'),false);
 assert.equal(args[args.indexOf('--reasoning')+1],'off');
});
test('default model loading preserves existing vision batch and local endpoint arguments',()=>{
 const args=llamaArguments(base,12345);assert.equal(args.includes('--load-mode'),false);assert.equal(args.includes('--no-host'),false);
 assert.equal(args[args.indexOf('--host')+1],'127.0.0.1');assert.equal(args[args.indexOf('--port')+1],'12345');
 assert.equal(args[args.indexOf('--ubatch-size')+1],'4096');
});
test('explicit none loading uses streamed weights without the Windows mapped prefetch while keeping vision batch size',()=>{
 const args=llamaArguments({...base,llamaLoadMode:'none'},12345);
 assert.equal(args[args.indexOf('--load-mode')+1],'none');assert.equal(args.includes('--no-host'),true);
 assert.equal(args[args.indexOf('--ubatch-size')+1],'4096');assert.equal(args.includes('--no-warmup'),false);assert.equal(args.includes('--mlock'),false);
});
test('unknown and coerced load modes cannot silently launch the default memory profile',()=>{
 for(const llamaLoadMode of [null,true,0,'mmap','NONE','prefetch'])assert.throws(()=>llamaArguments({...base,llamaLoadMode},12345),error=>error.code==='CONFIG_PATH');
});
