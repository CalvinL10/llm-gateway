import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:http';

const run=promisify(execFile);
const root=resolve(import.meta.dirname,'..');
const runtime=process.env.DSH_TEST_RUNTIME;
const scratch=resolve(root,'../../.local/subscriptions-021-test');
const redact=value=>String(value).replace(/([?&]token=)[^\s&]+/g,'$1[redacted]');

test('native 0.2.1-rc.3 install, ordinary sessions, independent defaults, mixed routes, restart and uninstall',
  {skip:!runtime,timeout:240000},async()=>{
  await mkdir(scratch,{recursive:true});
  const home=resolve(scratch,'home'),cwd=resolve(scratch,'workspace');await mkdir(cwd,{recursive:true});
  const bin=resolve(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const apiCalls=[];
  const modelServer=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    apiCalls.push({url:request.url,body:body?JSON.parse(body):null});
    response.writeHead(200,{'content-type':'text/event-stream'});
    for(const chunk of [{choices:[{index:0,delta:{role:'assistant',content:'HTTP_API_OK'},finish_reason:null}]},
      {choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}])
      response.write('data: '+JSON.stringify({id:'offline-api',created:1,model:'model',...chunk})+'\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(ok=>modelServer.listen(0,'127.0.0.1',ok));
  const env={...process.env,DSH_HOME:home,DSH_SUBSCRIPTIONS_TEST_KEY:'OFFLINE_TEST_ONLY'};
  const native=async args=>{
    try {return (await run(process.execPath,['--expose-internals',bin,...args],{cwd:scratch,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024})).stdout;}
    catch(error){throw new Error(redact(error.stderr??error.message));}
  };
  const npm=resolve(process.execPath,'../node_modules/npm/bin/npm-cli.js');
  const packed=JSON.parse((await run(process.execPath,[npm,'pack','--ignore-scripts','--json','--pack-destination',scratch],{cwd:root,env,windowsHide:true})).stdout)[0];
  assert.ok(packed.files.every(file=>!/(^|\/)(node_modules|test|src|\.local)\//.test(file.path)));
  const pack=resolve(scratch,packed.filename);
  await native(['web','--dump-config']);
  const manifestPath=resolve(home,'profiles/web/package.json');
  const prior=JSON.parse(await readFile(manifestPath,'utf8'));
  if(prior.dependencies?.['@llm-gateway/dsh-subscriptions']) await native(['plugin','--profile','web','remove','@llm-gateway/dsh-subscriptions']);
  await native(['plugin','--profile','web','add',pack,'--config.auto-install-peers=false','--config.ignore-scripts=true']);
  const patchPath=resolve(home,'profiles/web/cordis.patch.yml');
  await writeFile(patchPath,JSON.stringify([{insert:[{id:'offline-subscription-fixture',name:resolve(root,'test/fixture.js'),config:{cwd}}]},
    {id:'agent-default-model',config:{provider:'fixture-deepseek',model:'model'}},
    {id:'llm-pi-ai',config:{providers:{'fixture-http':{displayName:'Offline HTTP API',api:'openai-completions',baseURL:`http://127.0.0.1:${modelServer.address().port}/v1`,apiKeyEnv:'DSH_SUBSCRIPTIONS_TEST_KEY',models:[{id:'model',name:'Offline API model',contextWindow:32000,maxTokens:2048,input:['text']}]}}}}],null,2));
  let child,origin,cookie,logs='';
  const start=async()=>{
    logs='';let stdout='';
    child=spawn(process.execPath,['--expose-internals',bin,'web','--host','127.0.0.1','--port','0','--no-open'],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stderr.on('data',data=>{logs+=redact(data);});
    const login=await new Promise((ok,fail)=>{
      const timer=setTimeout(()=>fail(Error('Startup timeout: '+logs)),30000);
      child.once('error',fail);child.once('exit',code=>{clearTimeout(timer);fail(Error('Host exited '+code+': '+logs));});
      child.stdout.on('data',data=>{stdout+=data;logs+=redact(data);const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);if(match){clearTimeout(timer);ok(match[0]);}});
    });
    origin=new URL(login).origin;
    const exchange=await fetch(login,{redirect:'manual'});cookie=exchange.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    assert.ok(cookie,'host auth cookie');
  };
  const stop=async()=>{if(child?.exitCode===null){const done=once(child,'exit');child.kill();await done;}};
  const api=async(path,body)=>{
    const response=await fetch(origin+path,{signal:AbortSignal.timeout(25000),headers:{cookie,origin,...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{method:'POST',body:JSON.stringify(body)}});
    const text=await response.text();assert.equal(response.status,200,text);return JSON.parse(text);
  };
  try {
    await start();
    console.log('Host ready; checking authentication and provider status');
    assert.equal((await fetch(origin+'/api/gateway-model-defaults')).status,401);
    let state=await api('/api/gateway-model-defaults');
    assert.equal(state.main.provider,'fixture-deepseek');assert.ok(state.catalog.groups.some(g=>g.id==='fixture-api'));
    assert.equal((await fetch(origin+'/api/gateway-subscription-bridge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(origin+'/api/gateway-model-defaults',{method:'POST',headers:{cookie,origin:'https://foreign.invalid','content-type':'application/json'},body:'{}'})).status,403);
    for(const provider of ['codex','antigravity','claude']) {
      await api('/api/gateway-subscription-bridge',{provider,path:'/status',method:'GET'});
    }
    const ordinary=await api('/api/gateway-subscription-fixture',{});
    console.log('Ordinary conversation completed; saving native child defaults');
    assert.equal(ordinary.calls[0].provider,'fixture-deepseek');
    await api('/api/gateway-subscription-fixture',{provider:'fixture-http'});
    assert.ok(apiCalls.length>0,'native API adapter reached the independent HTTP endpoint');
    await api('/api/gateway-model-defaults',{child:{provider:'fixture-third',model:'model'},
      childSelection:{enabled:true,allowedModels:['fixture-deepseek','fixture-api','fixture-third','fixture-http'].map(provider=>({provider,model:'model'}))}});
    const delegated=await api('/api/gateway-subscription-fixture',{provider:'fixture-deepseek',prompt:'delegate default'});
    console.log('Default delegation completed');
    assert.ok(delegated.calls.some(call=>call.isChild&&call.provider==='fixture-third'),JSON.stringify(delegated));
    const explicit=await api('/api/gateway-subscription-fixture',{provider:'fixture-deepseek',prompt:'delegate explicit'});
    assert.ok(explicit.calls.some(call=>call.isChild&&call.provider==='fixture-api'),JSON.stringify(explicit));
    const mixed=await api('/api/gateway-subscription-fixture',{provider:'fixture-api',prompt:'delegate default'});
    assert.ok(mixed.calls.some(call=>call.isChild&&call.provider==='fixture-third'),JSON.stringify(mixed));
    await api('/api/gateway-model-defaults',{child:{provider:'fixture-http',model:'model'}});
    const httpChild=await api('/api/gateway-subscription-fixture',{provider:'fixture-deepseek',prompt:'delegate default'});
    assert.ok(httpChild.calls.some(call=>call.isChild&&call.provider==='fixture-http'),JSON.stringify(httpChild));
    await stop();await start();
    state=await api('/api/gateway-model-defaults');assert.ok(state.presets.some(p=>p.routes.some(route=>route?.provider==='fixture-http')));
    await api('/api/gateway-subscription-fixture',{provider:'fixture-api'});
    await stop();
    await native(['plugin','--profile','web','remove','@llm-gateway/dsh-subscriptions']);
    await start();
    const after=await api('/api/gateway-subscription-fixture',{provider:'fixture-api'});
    assert.equal(after.calls[0].provider,'fixture-api');
    const httpCallsBefore=apiCalls.length;await api('/api/gateway-subscription-fixture',{provider:'fixture-http'});assert.ok(apiCalls.length>httpCallsBefore);
    assert.equal((await fetch(origin+'/api/gateway-model-defaults',{headers:{cookie}})).status,404);
    await writeFile(resolve(scratch,'result.json'),JSON.stringify({runtime:'0.2.1-rc.3',nativeInstallRemove:true,auth:true,ordinary:true,defaultChild:true,explicitChild:true,mixedProviders:true,nativeHttpApi:true,httpApiChild:true,restart:true,realModelCalls:0},null,2));
  }finally{await stop();await new Promise(ok=>modelServer.close(ok));await writeFile(resolve(scratch,'last-host.log'),redact(logs));}
});
