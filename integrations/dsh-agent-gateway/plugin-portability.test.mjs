import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {access, mkdir, readFile, writeFile, copyFile, symlink, realpath} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {dirname, resolve, relative} from 'node:path';
import {request as httpRequest} from 'node:http';
import {isOrdinaryHostSession} from './ledger.js';

const source = import.meta.dirname;
const scratch = resolve(source, '../../.local/plugin-portability-check');
const runtime = resolve(source, 'runtime');
const bin = resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const pack = resolve(scratch, 'llm-gateway-dsh-agent-gateway-0.2.0.tgz');
const run = promisify(execFile);
const endpoint = '/api/gateway-agent-tasks';
const route = {provider:'fixture-lead', model:'planner'};
const children = [{provider:'fixture-deep',model:'flash-a'}, {provider:'fixture-google',model:'flash-b'}];
const selection = mode => ({root:route, mode, children:mode === 'single' ? [] : children});
const redact = text => String(text).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]');

test('documentation language navigation resolves paired pages and local links', async () => {
  const root = resolve(source, '../..');
  for (const [zh, en] of [
    ['README.md', 'README.en.md'],
    ['integrations/dsh-agent-gateway/README.md', 'integrations/dsh-agent-gateway/README.en.md'],
    ['docs/releases/v0.2.0.md', 'docs/releases/v0.2.0.en.md'],
  ]) {
    for (const [file, other, label] of [[zh, en, 'English'], [en, zh, '中文']]) {
      const text = await readFile(resolve(root, file), 'utf8');
      const destination = relative(dirname(resolve(root, file)), resolve(root, other)).replaceAll('\\', '/');
      assert.ok(text.split(/\r?\n/).slice(0, 5).join('\n').includes('[' + label + '](' + destination + ')'), file);
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^(?:https?:|#)/.test(match[1])) continue;
        await access(resolve(root, dirname(file), match[1].split('#')[0]));
      }
    }
  }
});

test('coexistence requires complete host-owned identity, not prompt or caller claims', () => {
  const gateway = new Set(['llm-gateway-single']);
  const sessions = new Map([
    ['ordinary', {header:{id:'ordinary'}}],
    ['child', {header:{origin:'subagent',parentSession:'ordinary'}}],
    ['orphan', {header:{origin:'subagent',parentSession:'missing'}}],
    ['preset', {header:{},snapshotEvents:()=>[{type:'agent-preset/selected',data:{agentPreset:'llm-gateway-single'}}]}],
    ['cycle', {header:{origin:'subagent',parentSession:'cycle'}}],
    ['descendant', {header:{origin:'subagent',parentSession:'gateway-agent-missing'}}],
  ]);
  for (const id of ['ordinary','child']) assert.equal(isOrdinaryHostSession(id, sid=>sessions.get(sid), gateway), true);
  for (const id of [undefined,'missing','gateway-agent-missing','orphan','preset','cycle','descendant'])
    assert.equal(isOrdinaryHostSession(id, sid=>sessions.get(sid), gateway), false, String(id));
});

// One real-host check, two fixed Homes. No real adapters/accounts or browser automation.
// Retain these exact directories on failure; reruns reuse them, never another batch.
test('native package install, coexistence, independent Homes, task controls and removal', {timeout:240000}, async () => {
  await mkdir(scratch, {recursive:true});
  const envBase = {...process.env, TEMP:scratch, TMP:scratch,
    npm_config_cache:resolve(scratch,'npm-cache'), PNPM_HOME:resolve(scratch,'pnpm-home'),
    XDG_CACHE_HOME:resolve(scratch,'cache'), XDG_DATA_HOME:resolve(scratch,'data'),
    DSH_PERMISSION_MODE:'workspace-write'};
  const npm = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const packed = JSON.parse((await run(process.execPath, [npm,'pack','--json','--ignore-scripts','--pack-destination',scratch],
    {cwd:source,env:envBase,windowsHide:true})).stdout)[0];
  assert.equal(packed.filename, 'llm-gateway-dsh-agent-gateway-0.2.0.tgz');
  for (const guide of ['README.md','README.en.md']) {
    assert.ok(packed.files.some(file=>file.path===guide), guide+' must ship in the release package');
    const text=await readFile(resolve(source,guide),'utf8');
    assert.ok(text.includes('plugin --profile web add') && text.includes('plugin --profile web remove'));
  }
  assert.ok(packed.files.every(({path}) => !/(^|\/)(runtime|tests?|preset|\.local)(\/|$)|\.test\.|fixture|evidence/.test(path)));
  await writeFile(resolve(scratch,'package-files.json'), JSON.stringify(packed.files.map(f=>f.path),null,2));
  const fixtureDir = resolve(scratch,'fixture');
  await mkdir(fixtureDir,{recursive:true});
  await symlink(resolve(runtime,'node_modules'),resolve(fixtureDir,'node_modules'),'junction').catch(e=>{if(e.code!=='EEXIST')throw e;});
  await writeFile(resolve(fixtureDir,'package.json'),'{"type":"module"}');
  for (const file of ['fixture.js','fixture-scenario.mjs']) await copyFile(resolve(source,file),resolve(fixtureDir,file));
  // The extra endpoint is test-only, protected by the real DSH auth/origin layer.
  await writeFile(resolve(fixtureDir,'probe.js'), `
import {randomUUID} from 'node:crypto';
export const inject=['sessionController','sessions','agentPresets','llm','connection','tools','shell'];
export async function apply(ctx,config) {
  ctx.connection.fetch.register({path:'/api/portability-probe',methods:['POST'],requestBody:'buffered',async fetch(request) {
    const {kind,sessionId:requested,preset}=await request.json();
    try {
      if(kind==='inspect') {
        const {agent,error}=await ctx.sessionController.resolveAgent(requested); if(error)throw error;
        return Response.json({tools:(ctx.agentPresets.serviceFor(agent,'tools')??ctx.tools).schemas(agent).map(t=>t.name),events:agent.session.snapshotEvents()});
      }
      if(kind==='ordinary'||kind==='scope') {
        const sessionId=randomUUID();
        await ctx.sessionController.create({sessionId,cwd:config.cwd,agentPreset:preset??'standard'});
        const {agent,error}=await ctx.sessionController.resolveAgent(sessionId); if(error)throw error;
        const shell=ctx.agentPresets.serviceFor(agent,'shell')??ctx.shell;
        const tools=(ctx.agentPresets.serviceFor(agent,'tools')??ctx.tools).schemas(agent).map(t=>t.name);
        if(kind==='ordinary') {
          await ctx.sessionController.selectModel({sessionId,provider:'fixture-lead',model:'planner'});
          await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'simple ordinary session'}]},new AbortController().signal);
          await agent.whenIdle();
        }
        return Response.json({sessionId,tools,docker:shell?.dockerExecutor===true,events:agent.session.snapshotEvents()});
      }
      let sessionId=requested;
      if(kind==='orphan') {
        sessionId=randomUUID();
        await ctx.sessionController.create({sessionId,cwd:config.cwd,agentPreset:'llm-gateway-single'});
      }
      const chunks=[];
      for await (const chunk of ctx.llm.stream({sessionId,provider:'fixture-lead',model:'planner',
        messages:[{role:'user',content:[{type:'text',text:'simple'}]}],signal:new AbortController().signal})) chunks.push(chunk);
      return Response.json({chunks});
    } catch(error) {return Response.json({error:error.code??error.message});}
  }});
}
`);
  const hosts = [];
  async function native(home, args) {
    const env = {...envBase,DSH_HOME:home};
    try {return (await run(process.execPath,['--expose-internals',bin,...args],
      {cwd:scratch,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024})).stdout;}
    catch(e) {throw new Error(redact(e.stderr || e.message));}
  }
  async function install(home, verb) {
    const output = await native(home, ['plugin','--profile','web',verb,
      verb==='add'?pack:'@llm-gateway/dsh-agent-gateway','--config.offline=true','--config.ignore-scripts=true',
      '--config.auto-install-peers=false','--store-dir',resolve(scratch,'pnpm-store'),
      '--cache-dir',resolve(scratch,'pnpm-cache')]);
    await writeFile(resolve(home,verb+'.log'),redact(output));
  }
  async function makeHost(label, calls) {
    const home=resolve(scratch,'home-'+label),cwd=resolve(scratch,'workspace-'+label);
    await mkdir(home,{recursive:true}); await mkdir(cwd,{recursive:true});
    const patchPath=resolve(home,'profiles/web/cordis.patch.yml');
    // Reuse this same fixture on rerun, including a failed/uninstalled Home.
    await native(home,['web','--dump-config']);
    await writeFile(patchPath,'[]');
    const manifest=JSON.parse(await readFile(resolve(home,'profiles/web/package.json'),'utf8'));
    if(manifest.dependencies?.['@llm-gateway/dsh-agent-gateway']) await install(home,'remove');
    await install(home,'add');
    const disabled=await native(home,['web','--dump-config']);
    assert.match(disabled,/gateway-agent-tasks/);
    const config={workspaces:[{id:label,label,cwd}],authorizedTaskMaxCalls:[4,8],policy:{
      root:route,allowedRoutes:[route,...children],allowedChildRoutes:children,
      toolSet:'development',delegationEnabled:false,maxCalls:calls},
      scheduling:{roots:[route],children}};
    const extra={insert:[{id:'local-fixture',name:resolve(fixtureDir,'fixture.js')},
      {id:'local-probe',name:resolve(fixtureDir,'probe.js'),config:{cwd}}]};
    const patch=[extra,{id:'gateway-agent-tasks',disabled:false,config}];
    const host={home,cwd,patchPath,patch,extra,child:null,starts:0,logs:''}; hosts.push(host);
    host.save=()=>writeFile(patchPath,JSON.stringify(host.patch,null,2));
    host.stop=async()=>{
      if(!host.child || host.child.exitCode!==null || host.child.signalCode!==null)return;
      const exited=once(host.child,'exit'); host.child.kill(); await exited;
    };
    host.start=async()=>{
      host.logs=''; let stdout='';
      host.child=spawn(process.execPath,['--expose-internals',bin,'web','--no-open','--host','127.0.0.1','--port','0'],
        {cwd,env:{...envBase,DSH_HOME:home},stdio:['ignore','pipe','pipe'],windowsHide:true});
      host.child.stderr.on('data',s=>{host.logs+=redact(s);});
      const url=await new Promise((ok,fail)=>{
        const timer=setTimeout(()=>fail(Error('Host startup timeout: '+host.logs)),30000);
        host.child.once('exit',code=>{clearTimeout(timer);fail(Error('Host exited '+code+': '+host.logs));});
        host.child.once('error',e=>{clearTimeout(timer);fail(e);});
        host.child.stdout.on('data',s=>{stdout+=s;host.logs+=redact(s);const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
          if(match){clearTimeout(timer);ok(match[0]);}});
      });
      const auth=await fetch(url,{redirect:'manual'});assert.equal(auth.status,303);
      host.origin=new URL(url).origin;
      host.headers={Origin:host.origin,Cookie:auth.headers.getSetCookie().map(s=>s.split(';')[0]).join('; '),'Content-Type':'application/json'};
      host.starts++;
    };
    host.response=(path=endpoint,body)=>fetch(host.origin+path,{headers:host.headers,...body===undefined?{}:{method:'POST',body:JSON.stringify(body)}});
    host.api=async(path=endpoint,body)=>{const res=await host.response(path,body);const text=await res.text();assert.ok(res.ok,text+'\n'+host.logs);return JSON.parse(text);};
    host.probe=body=>host.api('/api/portability-probe',body);
    host.done=id=>until(async()=>{const t=await host.api(endpoint+'?id='+id);return ['queued','running','cancel-requested'].includes(t.status)?null:t;});
    // First boot is genuinely disabled, not a mocked loader check.
    await host.start();assert.equal((await host.response()).status,404);await host.stop();
    await host.save(); await host.start();
    assert.equal((await host.api()).policy.maxCalls,calls);
    const installed=await realpath(resolve(home,'profiles/web/node_modules/@llm-gateway/dsh-agent-gateway'));
    assert.ok(!relative(scratch,installed).startsWith('..'));
    for(const file of ['plugin.js','index.js','presets/llm-gateway-single-docker/agent.cordis.yml'])
      assert.ok((await readFile(resolve(installed,file),'utf8'))===(await readFile(resolve(source,file),'utf8')),file+' must match this package, not a cached previous build');
    return host;
  }
  async function until(check) {const end=Date.now()+20000;while(Date.now()<end){const x=await check();if(x)return x;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out; '+hosts.map(h=>h.logs).join('\n'));}
  try {
    const a=await makeHost('a',8),b=await makeHost('b',4);
    for(const host of [a,b]) await host.api(endpoint+'?action=preferences',{scheduling:selection('single'),maxCalls:host===a?8:4});
    assert.equal((await fetch(a.origin+endpoint)).status,401);
    assert.equal((await fetch(a.origin+endpoint,{headers:{...a.headers,Origin:'https://untrusted.example'}})).status,403);
    assert.equal(await new Promise((ok,fail)=>{const req=httpRequest(a.origin+endpoint,{headers:{...a.headers,Host:'untrusted.example'}},res=>{res.resume();ok(res.statusCode);});req.on('error',fail);req.end();}),403);
    assert.ok((await (await a.response('/')).text()).includes('gateway-task-entry'));
    const ordinary=await a.probe({kind:'ordinary'});
    assert.ok(ordinary.events,JSON.stringify(ordinary)+'\n'+a.logs);
    assert.ok(ordinary.events.some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes('DIRECT_ANSWER')),JSON.stringify(ordinary));
    assert.equal(ordinary.docker,false);
    assert.ok(ordinary.tools.includes('pwsh')&&ordinary.tools.includes('write'),JSON.stringify(ordinary.tools));
    assert.equal((await a.probe({kind:'orphan'})).error,'TASK_NOT_AUTHORIZED');
    assert.equal((await a.probe({kind:'raw',sessionId:'gateway-agent-missing'})).error,'TASK_NOT_AUTHORIZED');
    assert.equal((await a.probe({kind:'raw'})).error,'TASK_NOT_AUTHORIZED');
    // Opt-in executor composes locally, without running Docker or changing host shell.
    const scoped=await a.probe({kind:'scope',preset:'llm-gateway-single-docker'});
    assert.equal(scoped.docker,true,JSON.stringify(scoped));
    assert.equal((await a.probe({kind:'ordinary'})).docker,false);
    assert.equal((await a.api()).capabilities.commandExecution,'disabled');
    const submitted=await a.api(endpoint,{requestId:randomUUID(),goal:'simple task'});
    const finished=await a.done(submitted.id);assert.equal(finished.status,'completed',JSON.stringify(finished));
    assert.equal(finished.artifact,'DIRECT_ANSWER');
    assert.ok(!(await b.api()).tasks.some(t=>t.id===submitted.id));
    const resumed=await a.api(endpoint+'?id='+submitted.id+'&action=continue',
      {continuationId:randomUUID(),kind:'continue',instruction:'simple followup',additionalCalls:0});
    const continued=await a.done(resumed.id);
    assert.equal(continued.status,'completed',JSON.stringify(continued));
    assert.equal(continued.report.attempts.length,2);
    await a.api(endpoint+'?action=preferences',{scheduling:selection('delegate'),maxCalls:8});
    assert.equal((await b.api()).scheduling.defaults.scheduling.mode,'single');
    const delegated=await a.api(endpoint,{requestId:randomUUID(),goal:'adaptive delegation'});
    const delegateDone=await a.done(delegated.id);assert.equal(delegateDone.status,'completed',JSON.stringify({task:delegateDone,session:await a.probe({kind:'inspect',sessionId:delegated.sessionId})}));
    assert.ok(delegateDone.calls.some(c=>c.parentSessionId===delegateDone.sessionId));
    const looping=await a.api(endpoint,{requestId:randomUUID(),goal:'loop until budget stops',maxCalls:4});
    assert.equal((await a.done(looping.id)).status,'limited');
    const approval=await a.api(endpoint,{requestId:randomUUID(),goal:'approval cancel browser',scheduling:selection('single')});
    await until(async()=>{const t=await a.api(endpoint+'?id='+approval.id);return t.report.approvalOperations.some(o=>o.outcome==='pending');});
    await a.api(endpoint+'?id='+approval.id+'&action=cancel',{});
    assert.equal((await a.done(approval.id)).status,'stopped');
    const cancelled=await a.api(endpoint,{requestId:randomUUID(),goal:'cancel child'});
    await until(async()=>(await a.api('/api/gateway-agent-fixture')).activeChildren>0);
    await a.api(endpoint+'?id='+cancelled.id+'&action=cancel',{});
    assert.equal((await a.done(cancelled.id)).status,'stopped');
    assert.equal((await a.probe({kind:'raw',sessionId:cancelled.sessionId})).error,'TASK_NOT_RUNNING');
    const interrupted=await a.api(endpoint,{requestId:randomUUID(),goal:'cancel child for restart'});
    await until(async()=>(await a.api('/api/gateway-agent-fixture')).activeChildren>0);
    await a.stop();await a.start();
    assert.equal((await a.api(endpoint+'?id='+interrupted.id)).status,'unknown');
    assert.equal((await a.api('/api/gateway-agent-fixture')).calls.length,0);
    assert.equal((await a.api()).scheduling.defaults.scheduling.mode,'delegate');
    // A text-only task narrows its own sandbox even on a workspace-write host.
    await b.stop();
    const textConfig=b.patch[1].config;
    textConfig.policy.toolSet='delegation';textConfig.policy.delegationEnabled=true;
    delete textConfig.scheduling;
    await b.save();await b.start();
    const textTask=await b.api(endpoint,{requestId:randomUUID(),goal:'simple text task'});
    const textDone=await b.done(textTask.id);
    assert.equal(textDone.status,'completed',JSON.stringify(textDone));
    assert.equal(textDone.policy.agentPreset,'llm-gateway-text');
    assert.ok(!(await a.api()).tasks.some(t=>t.id===textTask.id));
    for(const host of [a,b]) {
      await host.stop();host.patch=[host.extra];await host.save();await install(host.home,'remove');
      await host.start();assert.equal((await host.response()).status,404);
      const normal=await host.probe({kind:'ordinary'});assert.ok(normal.events.some(e=>e.type==='assistant/message'));
      await host.stop();
    }
    // Reinstallation sees retained records/preferences, not a recreated empty Home.
    await install(a.home,'add');a.patch=[a.extra,{id:'gateway-agent-tasks',disabled:false,config:{
      workspaces:[{id:'a',label:'a',cwd:a.cwd}],authorizedTaskMaxCalls:[4,8],policy:{root:route,allowedRoutes:[route,...children],allowedChildRoutes:children,
        toolSet:'development',delegationEnabled:false,maxCalls:8},scheduling:{roots:[route],children}}}];
    await a.save();await a.start();
    assert.equal((await a.api(endpoint+'?id='+submitted.id)).artifact,'DIRECT_ANSWER');
    assert.equal((await a.api(endpoint+'?id='+interrupted.id)).status,'unknown');
    assert.equal((await a.api()).scheduling.defaults.scheduling.mode,'delegate');
    const result={package:pack,homes:hosts.map(h=>h.home),nativeInstallRemove:true,coexistence:true,scopedDocker:true,
      isolatedData:true,authentication:401,origin:403,host:403,tasks:'result/delegation/limit/approval/cancel/continue',restart:'unknown; no replay',realModelCalls:0};
    await writeFile(resolve(scratch,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally {
    for(const h of hosts) {await h.stop();await writeFile(resolve(h.home,'host.log'),redact(h.logs));}
  }
});
