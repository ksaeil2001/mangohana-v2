const fs = require('node:fs');
const path = require('node:path');
const entry = process.argv[1];
const diary = process.env.SYNTHETIC_DIARY;
if (path.basename(entry) !== 'synthetic-server.cjs' || diary !== path.join(path.dirname(entry), 'synthetic-http.jsonl')) {
  throw Error('Expected the test-owned synthetic server and its own diary');
}
const delay = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
if (process.env.STAGE17_DELAY_KIND === 'journal-open') {
  const append = fs.appendFileSync;
  fs.appendFileSync = function (file, ...rest) {
    if (file === diary) delay();
    return append.call(this, file, ...rest);
  };
} else if (process.env.STAGE17_DELAY_KIND === 'model-listen') {
  const net = require('node:net');
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    delay();
    return listen.apply(this, args);
  };
} else throw Error('Expected a named synthetic delay');
