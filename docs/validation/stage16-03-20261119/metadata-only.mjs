// Preloaded in the same process as each explicitly named test, including the first RED.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

function stop() {
  process.stderr.write('S16_FORBIDDEN_OPERATION\n');
  process.exit(91);
}
if (!process.permission || ['fs.write', 'child', 'worker', 'addons'].some(p => process.permission.has(p))) stop();
globalThis.fetch = stop;
const testURL = pathToFileURL(process.argv[1]).href;
const names = JSON.parse(process.env.S16_TEST_NAMES);
const allowedTests = 'data:text/javascript,' + encodeURIComponent(
  "import test from 'node:test';const names=new Set(" + JSON.stringify(names) + ");" +
  'export default (name,...args)=>{if(names.has(name))return test(name,...args)};'
);
const disabledSharp = 'data:text/javascript,' + encodeURIComponent(
  'const stop=()=>{process.stderr.write("S16_FORBIDDEN_OPERATION\\n");process.exit(91)};' +
  'export default new Proxy(stop,{get:(_,key)=>key==="then"?undefined:stop(),construct:stop,apply:stop});'
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:test' && context.parentURL === testURL) return { shortCircuit: true, url: allowedTests };
    if (specifier === 'sharp') return { shortCircuit: true, url: disabledSharp };
    if (/^(?:node:)?(?:http2?|https|net|tls|dgram|worker_threads)$/.test(specifier) ||
        /(?:^|[/\\])(?:sharp|@img|pngjs|jpeg-js|jimp|canvas|@napi-rs|onnxruntime[^/\\]*)(?:[/\\]|$)/i.test(specifier) ||
        /\.(?:node|wasm|png|jpe?g|webp|gif|avif|bmp|tiff?)$/i.test(specifier)) stop();
    return next(specifier, context);
  },
});
