import {build} from 'esbuild';
import {mkdir, readFile, copyFile, access} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Ordinary dependency version/revision pinning; upstream authentication and
// credential protection are compiled unchanged, not reimplemented here.
export const upstreamRevision = '1939b2f63a7dfa8b4525f941d51d698189715a9c';
const root = import.meta.dirname;
const source = resolve(process.env.DSH_SUBSCRIPTION_SOURCE ?? resolve(root, '../../.local/subscription-source-0.42.0'));
try { await access(resolve(source, 'src/index.ts')); }
catch {
  await mkdir(source, {recursive:true});
  const archive = resolve(source, '../subscription-source-0.42.0.tar.gz');
  const response = await fetch(`https://api.github.com/repos/Aa728848/dsh-chatgpt-subscription/tarball/${upstreamRevision}`);
  if (!response.ok) throw new Error(`Cannot download upstream source: HTTP ${response.status}`);
  const {writeFile} = await import('node:fs/promises');
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
  await promisify(execFile)('tar', ['-xzf', archive, '-C', source, '--strip-components=1'], {windowsHide:true});
}
const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
if (manifest.version !== '0.42.0') throw new Error('Build needs upstream 0.42.0 source');
const shared = {bundle:true, format:'esm', packages:'external', logLevel:'info',
  plugins:[{name:'upstream-source', setup(builder) {
    builder.onResolve({filter:/^@subscription-source\//}, args => ({path:resolve(source, 'src', args.path.slice('@subscription-source/'.length))}));
  }}]};
await mkdir(resolve(root, 'lib'), {recursive:true});
await build({...shared, platform:'node', target:'node22', entryPoints:[resolve(root,'src/index.ts')], outfile:resolve(root,'lib/index.js')});
await build({...shared, platform:'node', target:'node22', entryPoints:[resolve(root,'src/defaults.js')], outfile:resolve(root,'lib/defaults.js')});
await build({...shared, platform:'browser', target:'es2022', jsx:'automatic', entryPoints:[resolve(root,'src/client.tsx')], outfile:resolve(root,'lib/client.js')});
await copyFile(resolve(source, 'LICENSE'), resolve(root, 'UPSTREAM_LICENSE'));
