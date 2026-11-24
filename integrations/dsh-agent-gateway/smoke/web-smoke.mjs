import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { startHttpFixtures } from '../tests/fixtures/http-fixture.mjs';
import {runtimeArgument, inspectRuntime, createRuntimeScratch} from '../ops/runtime-paths.mjs';

const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const parsed=runtimeArgument(process.argv.slice(2),resolve(source,'runtime'));
const {runtime,launcher:bin}=await inspectRuntime(parsed.runtime);
// Preserve earlier diagnostic Homes and do not collide with any running deployment.
const run=await createRuntimeScratch(runtime), deployed=resolve(run,'plugin');
const home=resolve(run,'home'), cwd=resolve(run,'workspace');
let wire, child, stderr='', headers, origin, phase='setup';
const safeStderr = () => stderr.replace(/([?&]token=)[^\s&]+/g,'$1[redacted]');
async function stop() {if(!child || child.exitCode!==null || child.signalCode!==null)return; const exited=once(child,'exit');child.kill();await exited;}
try {
await mkdir(deployed,{recursive:true}); await mkdir(cwd,{recursive:true});
for(const file of ['package.json','index.js','ledger.js','report.js','panel.js','tools.js']) await copyFile(resolve(source,file),resolve(deployed,file));
for(const file of ['fixture.js','fixture-scenario.mjs']) await copyFile(resolve(source,'tests/fixtures',file),resolve(deployed,file));
const presetDir=resolve(home,'.agent-presets/gateway-agent'); await mkdir(presetDir,{recursive:true});
await copyFile(resolve(source,'tests/fixtures/legacy-preset/preset.yml'),resolve(presetDir,'preset.yml'));
const preset=await readFile(resolve(source,'tests/fixtures/legacy-preset/agent.cordis.yml'),'utf8');
await writeFile(resolve(presetDir,'agent.cordis.yml'),preset.replace("'@llm-gateway/dsh-agent-gateway/tools'",JSON.stringify(resolve(deployed,'tools.js').replaceAll('\\','/'))));
const env={...process.env,DSH_HOME:home,DSH_PERMISSION_MODE:'read-only'};
execFileSync(process.execPath,['--expose-internals',bin,'web','--dump-config'],{cwd,env,stdio:'pipe'});
const routes=[{provider:'fixture-lead',model:'planner'},{provider:'fixture-deep',model:'flash-a'},{provider:'fixture-google',model:'flash-b'}];
wire=parsed.args.includes('--http')?await startHttpFixtures(routes):null;
if(wire)env.GATEWAY_LOCAL_FIXTURE_KEY='local-fixture-not-a-secret';
const patch=[{id:'session-title-llm',disabled:true},{id:'llm-retry',disabled:true},
  {id:'subagent-model-selection-settings',config:{enabled:true,allowedModels:routes}},
  ...(wire?[{id:'llm-pi-ai',config:{providers:wire.providers}}]:[]),
  {insert:[{id:'gateway-agent-fixture',name:resolve(deployed,'fixture.js').replaceAll('\\','/'),config:{observeOnly:!!wire}},
    {id:'gateway-agent-tasks',name:resolve(deployed,'index.js').replaceAll('\\','/'),config:{cwd,policy:{
      root:{...routes[0],...(wire?{reasoningEffort:'high'}:{})},allowedRoutes:routes,maxCalls:8}}}]}];
const patchPath=resolve(deployed,'offline.patch.json'); await writeFile(patchPath,JSON.stringify(patch,null,2));
async function start() {
  phase='host startup';
  child=spawn(process.execPath,['--expose-internals',bin,'web','--patch',patchPath,'--no-open','--host','127.0.0.1','--port','0'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='';stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const url=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Startup timeout: '+stderr)),30000);
    child.once('exit',code=>{clearTimeout(timeout);reject(Error('Web exit '+code+': '+stderr));});
    child.stdout.on('data',chunk=>{stdout+=chunk;const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
  });
  origin=new URL(url).origin;
  phase='authentication bootstrap';
  const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,303);
  headers={Cookie:response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; '),Origin:origin,'Content-Type':'application/json'};
}
const endpoint='/api/gateway-agent-tasks';
async function api(path=endpoint,value) {
  phase=(value===undefined?'GET ':'POST ')+path;
  const response=await fetch(origin+path,{headers,...value===undefined?{}:{method:'POST',body:JSON.stringify(value)}});
  const data=await response.json();assert.ok(response.ok,JSON.stringify(data)+'\n'+stderr);return data;
}
async function until(predicate) {
  const end=Date.now()+20000;
  while(Date.now()<end) {const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,50));}
  throw new Error('Condition timeout\n'+stderr);
}
async function done(id) {return until(async()=>{const task=await api(endpoint+'?id='+id);return ['queued','running','cancel-requested'].includes(task.status)?null:task;});}
const fixture=()=>api('/api/gateway-agent-fixture');
  await start();
  assert.equal((await fetch(origin+endpoint)).status,401);
  assert.equal((await fetch(origin+endpoint,{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const req=httpRequest(origin+endpoint,{headers:{...headers,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(badHost,403);
  const rejected=await fetch(origin+endpoint,{headers,method:'POST',body:JSON.stringify({requestId:randomUUID(),goal:'simple',attachments:[]})});assert.equal(rejected.status,400);
  const simple=await api(endpoint,{requestId:randomUUID(),goal:'simple task'}), simpleDone=await done(simple.id);
  assert.equal(simpleDone.status,'completed',JSON.stringify(simpleDone)+'\n'+safeStderr());
  assert.equal(simpleDone.calls.length,1);assert.equal(simpleDone.artifact,'DIRECT_ANSWER');
  assert.equal(simpleDone.report.stopReason,'TURN_COMPLETED');
  assert.equal(simpleDone.report.businessOutcome,'unverified');
  const page = await fetch(origin+'/',{headers});
  assert.ok((await page.text()).includes('gateway-task-entry'));
  const input={requestId:randomUUID(),goal:'adaptive delegation\nPRIVATE_PARENT_ONLY'};
  const repeated=await Promise.all(Array.from({length:4},()=>api(endpoint,input)));
  assert.ok(repeated.every(t=>t.id===input.requestId));
  const adaptive=await done(input.requestId);
  assert.equal(adaptive.status,'completed',JSON.stringify({task:adaptive,fixtureErrors:wire?.errors,fixtureCalls:wire?.calls},null,2)+'\n'+safeStderr());
  assert.equal(adaptive.calls.length,7,JSON.stringify(adaptive));
  assert.ok(adaptive.artifact.includes('VERIFIED') && adaptive.artifact.includes('SECOND_RESULT'));
  const observed=await fixture();assert.equal(observed.calls.length,8);
  assert.ok(observed.maxActiveChildren>=2,'Native tools must execute independent children concurrently');
  const children=observed.calls.filter(c=>c.parentSessionId===adaptive.sessionId);
  assert.deepEqual(new Set(children.map(c=>c.provider)),new Set(['fixture-deep','fixture-google']));
  assert.ok(children.every(c=>!c.inputs.join('').includes('PRIVATE_PARENT_ONLY')),'Spawn must not copy parent history');
  assert.ok(observed.calls.every(c=>c.tools.every(t=>['subagent','list_subagent_models'].includes(t))));
  assert.ok(adaptive.calls.every(c=>c.usage?.totalTokens===15));
  await api(endpoint+'?id='+adaptive.id);await api();await api(endpoint,input);
  assert.equal((await fixture()).calls.length,8,'Reads and duplicate submission cannot start work');
  if(wire) {
    assert.equal(wire.calls.length,8);
    assert.deepEqual(new Set(wire.calls.map(c=>c.provider)),new Set(routes.map(r=>r.provider)));
    assert.ok(wire.calls.some(c=>c.toolResults.includes('followup')),'Child result must reach root HTTP history');
    assert.ok(adaptive.calls.filter(c=>!c.parentSessionId).every(c=>c.reasoningEffort==='high'));
  }
  const recovering=await api(endpoint,{requestId:randomUUID(),goal:'recover from child failure'}), recovered=await done(recovering.id);
  assert.equal(recovered.status,'completed',JSON.stringify({task:recovered,fixtureErrors:wire?.errors},null,2)+'\n'+safeStderr());assert.ok(recovered.artifact.includes('RECOVERED'));
  assert.equal(recovered.calls.length,6);assert.equal(recovered.calls.filter(c=>c.outcome==='error').length,1);
  assert.deepEqual(new Set(recovered.calls.filter(c=>c.parentSessionId).map(c=>c.provider)),new Set(['fixture-deep','fixture-google']));
  const denied=await api(endpoint,{requestId:randomUUID(),goal:'forbidden route task'});await done(denied.id);
  assert.ok((await fixture()).calls.every(c=>c.provider!=='fixture-forbidden'));
  const looping=await api(endpoint,{requestId:randomUUID(),goal:'loop until budget stops'}), limited=await done(looping.id);
  assert.equal(limited.status,'limited',JSON.stringify({task:limited,fixtureErrors:wire?.errors},null,2)+'\n'+safeStderr());assert.equal(limited.calls.length,8);
  assert.ok(limited.denials.some(d=>d.code==='TASK_CALL_LIMIT'));
  assert.equal(limited.artifact,null);
  assert.equal(limited.report.stopReason,'TASK_CALL_LIMIT');
  assert.equal(limited.report.needsUserDecision,true);
  const cancellation=await api(endpoint,{requestId:randomUUID(),goal:'cancel child'});
  await until(async()=>{const f=await fixture();return f.activeChildren>0;});
  if(wire)await until(()=>wire.calls.some(c=>c.waiting && !c.closed));
  await api(endpoint+'?id='+cancellation.id+'&action=cancel',{});
  const cancelled=await done(cancellation.id);assert.equal(cancelled.status,'stopped',JSON.stringify({task:cancelled,fixtureErrors:wire?.errors},null,2)+'\n'+safeStderr());
  assert.equal(cancelled.artifact,null);assert.equal(cancelled.report.stopReason,'CANCELLED');
  assert.equal((await fixture()).activeChildren,0);
  if(wire)await until(()=>wire.calls.every(c=>c.closed));
  const interrupted=await api(endpoint,{requestId:randomUUID(),goal:'cancel child for restart'});
  await until(async()=>{const f=await fixture();return f.activeChildren>0;});
  if(wire)await until(()=>wire.calls.some(c=>c.waiting && !c.closed));
  const wireCallsBeforeRestart=wire?.calls.length;
  await stop();await start();
  const unknown=await api(endpoint+'?id='+interrupted.id);
  assert.equal(unknown.status,'unknown',JSON.stringify({task:unknown,fixtureErrors:wire?.errors},null,2)+'\n'+safeStderr());assert.equal(unknown.artifact,null);
  assert.equal(unknown.report.stopReason,'EXECUTION_UNCONFIRMED');
  await api(endpoint,{requestId:interrupted.id,goal:interrupted.goal});
  assert.equal((await fixture()).calls.length,0);
  if(wire) {
    assert.equal(wire.calls.length,wireCallsBeforeRestart);
    assert.deepEqual(wire.errors,[]);
    await until(()=>wire.calls.every(c=>c.closed));
  }
  console.log(JSON.stringify({result:'AGENT_GATEWAY_PASS',simpleCalls:1,adaptiveCalls:7,adaptiveChildCalls:3,
    crossProviderChildren:true,parallelChildren:true,resultDrivenFollowup:true,callLimit:8,cancelledChildren:true,
    modelDirectedRecovery:true,transport:wire?'pi-ai + loopback HTTP SSE':'in-process scripted adapter',
    restartNoReplay:true,authentication:401,origin:403,host:403,attachments:400,realModelCalls:0,
    tasks:{simple:simple.id,adaptive:adaptive.id,recovered:recovered.id,limited:limited.id,cancelled:cancelled.id,unknown:interrupted.id}}));
} catch (error) {
  console.error('Smoke failed during '+phase+'; host exit='+child?.exitCode+' signal='+child?.signalCode);
  console.error(safeStderr());
  throw error;
} finally {await stop();await wire?.close();await rm(run,{recursive:true,force:true});}
