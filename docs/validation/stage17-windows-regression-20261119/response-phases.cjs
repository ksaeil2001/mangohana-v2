// Only the dummy server's stderr is directed to a pre-opened timestamp file.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const entry = process.argv[1] || '';
if (process.env.STAGE17_MEASURE_RESPONSE === '1' && path.basename(entry) === 'synthetic-server.cjs' &&
    process.env.SYNTHETIC_DIARY === path.join(path.dirname(entry), 'synthetic-http.jsonl')) {
  const mark = (phase, extra = {}) => fs.writeSync(2, JSON.stringify({phase, utc:new Date().toISOString(), ...extra}) + '\n');
  mark('entered');
  const append = fs.appendFileSync;
  fs.appendFileSync = function (target, ...args) {
    if (target !== 1) return append.call(this, target, ...args);
    mark('before_diary');
    try { return append.call(this, target, ...args); } finally { mark('after_diary'); }
  };
  const exists = fs.existsSync;
  fs.existsSync = function (file) {
    if (typeof file !== 'string' || !file.endsWith('wrong-model')) return exists.call(this, file);
    mark('before_model_flag');
    const present = exists.call(this, file);
    mark('after_model_flag', {present});
    return present;
  };
  const channel = require('node:diagnostics_channel');
  channel.channel('http.server.request.start').subscribe(() => mark('incoming'));
  channel.channel('http.server.response.finish').subscribe(({response}) => mark('finished', {status:response.statusCode}));
  const {ServerResponse} = require('node:http');
  const end = ServerResponse.prototype.end;
  ServerResponse.prototype.end = function (...args) {
    mark('before_end');
    try { return end.apply(this, args); } finally { mark('after_end'); }
  };
} else if (process.env.NODE_TEST_CONTEXT && path.basename(entry) === 'engine-runtime-reuse.test.mjs' &&
           process.env.STAGE17_RESPONSE_TRACE && process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR) {
  const root = process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR;
  const output = process.env.STAGE17_RESPONSE_TRACE;
  if (path.dirname(output) !== __dirname || !/^provider-response-\d+$/.test(path.basename(output))) throw Error('Unbound response trace');
  const spawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = function (executable, args, options) {
    const main = args?.[0] || '';
    if (executable !== process.execPath || path.basename(main) !== 'synthetic-server.cjs' ||
        path.dirname(path.dirname(main)) !== root) return spawn.apply(this, arguments);
    const leaf = path.basename(path.dirname(main));
    if (!/^engine-(reuse|default)-[A-Za-z0-9]{6}$/.test(leaf)) throw Error('Unbound dummy child');
    const witness = 'child-' + (children.length + 1) + '.jsonl';
    const fd = fs.openSync(path.join(output, witness), 'wx');
    try {
      const row = {leaf,witness,requested:new Date().toISOString()};
      const child = spawn.call(this, executable, ['--require', __filename, ...args], {
        ...options, stdio:[options.stdio[0], options.stdio[1], fd], env:{...options.env, STAGE17_MEASURE_RESPONSE:'1'},
      });
      row.pid = child.pid;
      children.push(row);
      child.once('exit', (code, signal) => Object.assign(row, {exit:new Date().toISOString(), code, signal}));
      return child;
    } finally { fs.closeSync(fd); }
  };
  process.once('exit', () => fs.writeFileSync(path.join(output,'children.json'), JSON.stringify(children,null,2)+'\n', {flag:'wx'}));
}
