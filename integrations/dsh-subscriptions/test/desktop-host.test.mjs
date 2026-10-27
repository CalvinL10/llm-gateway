import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';

// Uses a separate Home and background backend process. Never launches a window,
// reads existing credentials, or modifies the user's desktop profile.
const installation=process.env.DSH_DESKTOP_ROOT;
test('installed desktop backend loads packaged connections in an isolated Home',
  {skip:!installation,timeout:120000},async()=>{
  const root=resolve(import.meta.dirname,'..');
  const scratch=resolve(root,'../../.local/subscriptions-021-desktop');
  const home=resolve(scratch,'home'),workspace=resolve(scratch,'workspace');
  await mkdir(workspace,{recursive:true});
  const executable=resolve(installation,'DeepSeek Harness.exe');
  const runtime=resolve(installation,'resources/app.asar/dsh');
  const host=resolve(runtime,'node_modules/@deepseek-ai/dsh-desktop-host/lib');
  const env={...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1'};
  const run=promisify(execFile);
  const cli=async args=>(await run(executable,['--expose-internals',resolve(host,'cli.js'),...args],
    {cwd:workspace,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024})).stdout;
  await cli(['--profile','dsh','--from-default-profile','web','--dump-config']);
  const manifest=JSON.parse(await readFile(resolve(home,'profiles/dsh/package.json'),'utf8'));
  if(manifest.dependencies?.['@llm-gateway/dsh-subscriptions'])
    await cli(['plugin','--profile','dsh','remove','@llm-gateway/dsh-subscriptions']);
  const npm=resolve(process.execPath,'../node_modules/npm/bin/npm-cli.js');
  const pack=JSON.parse((await run(process.execPath,[npm,'pack','--ignore-scripts','--json','--pack-destination',scratch],
    {cwd:root,windowsHide:true})).stdout)[0];
  await cli(['plugin','--profile','dsh','add',resolve(scratch,pack.filename),'--config.auto-install-peers=false','--config.ignore-scripts=true']);
  const child=spawn(executable,['--expose-internals',resolve(host,'index.js'),runtime,resolve(home,'profiles/dsh'),resolve(installation,'resources/runtime/primary-runtime')],
    {cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let diagnostics='';
  const redact=value=>String(value).replace(/([?&]token=)[^\s&]+/g,'$1[redacted]');
  child.stdout.on('data',value=>{diagnostics+=redact(value);});child.stderr.on('data',value=>{diagnostics+=redact(value);});
  try {
    const ready=await new Promise((ok,fail)=>{
      const timer=setTimeout(()=>fail(Error('Desktop host startup timeout: '+diagnostics)),45000);
      child.once('error',fail);child.once('exit',code=>{clearTimeout(timer);fail(Error(`Desktop host exited ${code}: ${diagnostics}`));});
      child.on('message',message=>{
        if(message.type==='ready'){clearTimeout(timer);ok(message);}
        if(message.type==='fatal'){clearTimeout(timer);fail(Error(redact(message.diagnostic??message.message)));}
      });
    });
    const login=await fetch(ready.url,{redirect:'manual'});
    const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    assert.ok(cookie);
    const origin=new URL(ready.url).origin;
    const settings=await fetch(origin+'/api/gateway-model-defaults',{headers:{cookie},signal:AbortSignal.timeout(20000)});
    assert.equal(settings.status,200,await settings.clone().text());
    assert.ok(Array.isArray((await settings.json()).catalog.groups));
    for(const provider of ['codex','antigravity','claude']) {
      const response=await fetch(origin+'/api/gateway-subscription-bridge',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},
        body:JSON.stringify({provider,path:'/status',method:'GET'}),signal:AbortSignal.timeout(20000)});
      assert.equal(response.status,200,await response.clone().text());
    }
    await writeFile(resolve(scratch,'result.json'),JSON.stringify({installedBackend:true,isolatedHome:true,windowOpened:false,
      modelCatalog:true,threeAccountStatusRoutes:true,desktopRendererTransport:false,realModelCalls:0},null,2));
  }finally{
    if(child.exitCode===null){
      const exited=once(child,'exit');
      if(child.connected)try{child.send({type:'shutdown'},()=>{});}catch{}
      const timer=setTimeout(()=>child.kill(),10000);await exited;clearTimeout(timer);
    }
    await writeFile(resolve(scratch,'last-host.log'),diagnostics);
  }
});
