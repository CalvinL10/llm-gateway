import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root=resolve(import.meta.dirname,'..');
const scratch=resolve(root,'../../.local/subscriptions-021-preview');
const home=resolve(scratch,'home'),cwd=resolve(scratch,'workspace');
const runtime=process.env.DSH_TEST_RUNTIME;
if(!runtime) throw Error('Set DSH_TEST_RUNTIME to a 0.2.1-rc.3 installation');
await mkdir(cwd,{recursive:true});
const bin=resolve(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js');
const env={...process.env,DSH_HOME:home};
const run=promisify(execFile);
const native=args=>run(process.execPath,['--expose-internals',bin,...args],{cwd:scratch,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
await native(['web','--dump-config']);
const installed=JSON.parse(await readFile(resolve(home,'profiles/web/package.json'),'utf8'));
if(installed.dependencies?.['@llm-gateway/dsh-subscriptions']) await native(['plugin','--profile','web','remove','@llm-gateway/dsh-subscriptions']);
const npm=resolve(process.execPath,'../node_modules/npm/bin/npm-cli.js');
const packed=JSON.parse((await run(process.execPath,[npm,'pack','--ignore-scripts','--json','--pack-destination',scratch],{cwd:root,env,windowsHide:true})).stdout)[0];
await native(['plugin','--profile','web','add',resolve(scratch,packed.filename),'--config.auto-install-peers=false','--config.ignore-scripts=true']);
await writeFile(resolve(home,'profiles/web/cordis.patch.yml'),JSON.stringify([{insert:[{id:'offline-fixture',name:resolve(root,'test/fixture.js'),config:{cwd}}]},
  {id:'agent-default-model',config:{provider:'fixture-deepseek',model:'model'}}],null,2));
const child=spawn(process.execPath,['--expose-internals',bin,'web','--host','127.0.0.1','--port','0','--no-open'],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',ready=false;
child.stdout.on('data',async data=>{
  output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
  if(match&&!ready){ready=true;await writeFile(resolve(scratch,'preview-url.txt'),match[0],{mode:0o600});console.log('Offline preview ready at '+new URL(match[0]).origin);}
});
child.stderr.on('data',data=>process.stderr.write(String(data).replace(/([?&]token=)[^\s&]+/g,'$1[redacted]')));
child.on('exit',code=>process.exit(code??1));
process.stdin.on('data',data=>{if(String(data).trim()==='stop')child.kill();});
process.on('SIGTERM',()=>child.kill());process.on('SIGINT',()=>child.kill());process.on('exit',()=>child.kill());
