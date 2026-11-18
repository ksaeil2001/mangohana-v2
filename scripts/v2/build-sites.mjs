import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sites=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../apps/sites');
const entry=path.join(sites,'scripts/run-framework.mjs');
process.chdir(sites);
process.argv=[process.execPath,entry,'build'];
await import(pathToFileURL(entry).href);
