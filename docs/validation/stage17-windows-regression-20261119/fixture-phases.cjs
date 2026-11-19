// Test-only witness. The original fixture, auth checks, deadlines and owner still run.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const owned = process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR;
const output = process.env.STAGE17_FIXTURE_PHASES;
if (output && owned && process.env.NODE_TEST_CONTEXT &&
    path.basename(process.argv[1] || '') === 'engine-runtime-reuse.test.mjs') {
  const parentSpawn = childProcess.spawn;
  const rows = [];
  childProcess.spawn = function(executable, args, options) {
    const script = args?.[0] || '';
    if (executable !== process.execPath || path.basename(script) !== 'synthetic-server.cjs' ||
        path.dirname(path.dirname(script)) !== owned ||
        !/^engine-(default|reuse)-[A-Za-z0-9]{6}$/.test(path.basename(path.dirname(script)))) {
      return parentSpawn.apply(this, arguments);
    }
    const leaf = path.basename(path.dirname(script));
    const events = [];
    const row = {leaf, requested: new Date().toISOString(), events};
    rows.push(row);
    const probe = path.join(__dirname, 'provider-probe.cjs');
    const local = process.env.STAGE17_PROVIDER_MODE === 'local';
    const light = local || process.env.STAGE17_PROVIDER_MODE === 'journal';
    const extra = local ? {STAGE17_LOCAL_PHASE_FILE: path.join(path.dirname(output),'child-'+rows.length+'.jsonl')} : {};
    if(local)row.localFile=extra.STAGE17_LOCAL_PHASE_FILE;
    const child = parentSpawn.call(this, executable, ['--require', probe, ...args], {
      ...options, env: {...options.env, ...extra, STAGE17_MODULE_TRACE: light?'0':'1', STAGE17_LIGHT_IO: light?'1':'0'},
      stdio: local ? options.stdio : ['ignore', 'ignore', 'pipe']
    });
    row.pid = child.pid;
    let pending = '';
    child.stderr?.on('data', bytes => {
      pending += bytes.toString('utf8');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.startsWith('{')) continue;
        try {
          const {phase, utc, elapsedMs, id} = JSON.parse(line);
          if (typeof phase === 'string' && typeof utc === 'string') events.push({phase, utc, elapsedMs, id});
        } catch {}
      }
    });
    child.once('exit', (code, signal) => Object.assign(row, {exit: new Date().toISOString(), code, signal}));
    return child;
  };
  process.once('exit', () => {
    for(const row of rows){
      if(row.localFile && fs.existsSync(row.localFile)){
        const contents=fs.readFileSync(row.localFile,'utf8').trim();
        if(contents)row.events=contents.split(/\r?\n/).map(line=>JSON.parse(line));
      }
    }
    fs.writeFileSync(output, JSON.stringify(rows,null,2)+'\n', {flag:'wx'});
  });
}
