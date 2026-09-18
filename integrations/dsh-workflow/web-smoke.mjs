import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { runFaultChecks } from './web-fault-checks.mjs';
const faults=process.argv.includes('--faults');
const source=dirname(fileURLToPath(import.meta.url)), root=resolve(source,'../..');
const runtime=resolve(root,'.local/dsh-task02'), deployed=resolve(runtime,'gateway-workflow');
const home=resolve(root,faults?'.local/dsh-task04-offline-home':'.local/dsh-task03-offline-home'), cwd=resolve(root,'.local/dsh-task03-offline-workspace');
const bin=resolve(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js');
execFileSync(process.execPath,[resolve(source,'deploy.mjs')],{stdio:'pipe'});
await mkdir(cwd,{recursive:true});
await mkdir(resolve(home,'.agent-presets/text-only'),{recursive:true});
await copyFile(resolve(source,'../dsh-text-only/presets/text-only/preset.yml'),resolve(home,'.agent-presets/text-only/preset.yml'));
const preset=await readFile(resolve(source,'../dsh-text-only/presets/text-only/agent.cordis.yml'),'utf8');
await writeFile(resolve(home,'.agent-presets/text-only/agent.cordis.yml'),preset.replace("'@llm-gateway/dsh-text-only'",JSON.stringify(resolve(source,'../dsh-text-only/index.js').replaceAll('\\','/'))));
await copyFile(resolve(source,'web-fixture.js'),resolve(deployed,'web-fixture.js'));
await copyFile(resolve(source,'local-extension-example.js'),resolve(deployed,'local-extension-example.js'));
const env={...process.env,DSH_HOME:home,DSH_PERMISSION_MODE:'read-only'};
// This separate Home is created by the stock launcher, without subscription plugins or OAuth.
execFileSync(process.execPath,[bin,'web','--dump-config'],{cwd,env,stdio:'pipe'});
const patch=[
  {id:'session-title-llm',disabled:true},{id:'llm-retry',disabled:true},
  {insert:[{id:'gateway-offline-fixture',name:resolve(deployed,'web-fixture.js').replaceAll('\\','/')},
    {id:'gateway-extension-example',name:resolve(deployed,'local-extension-example.js').replaceAll('\\','/')},
    {id:'gateway-workflow',name:resolve(deployed,'index.js').replaceAll('\\','/'),config:{cwd,connections:[
      {id:'local-a',label:'Offline A (no network)',provider:'workflow-local-a'},
      {id:'local-b',label:'Offline B (no network)',provider:'workflow-local-b'},
      {id:'local-extra',label:'Extra local adapter (no network)',provider:'workflow-local-extension'},
    ]}}]},
];
const patchPath=resolve(deployed,'offline.patch.json');await writeFile(patchPath,JSON.stringify(patch,null,2));
let child, stderr='';
async function stop() {if(!child || child.exitCode!==null || child.signalCode!==null)return; const closed=once(child,'exit');child.kill();await closed;}
async function start() {
child=spawn(process.execPath,[bin,'web','--patch',patchPath,'--no-open','--host','127.0.0.1','--port','3082'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let output='';stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
return await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Web startup timeout: '+stderr)),30000);
  child.once('exit',code=>{clearTimeout(timeout);reject(Error('Web exited '+code+': '+stderr));});
  child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:3082\/\?token=[\w-]+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
}).catch(error=>{child.kill();throw error;});
}
let url=await start();
try {
  const origin=new URL(url).origin;
  assert.equal((await fetch(origin+'/api/gateway-workflows')).status,401);
  const login=await fetch(url,{redirect:'manual'});assert.equal(login.status,303);
  let cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/api/gateway-workflows',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
  const badHostStatus=await new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/api/gateway-workflows',{headers:{...headers,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(badHostStatus,403);
  const api=async(path,value)=>{const response=await fetch(origin+path,{headers,...value===undefined?{}:{method:'POST',body:JSON.stringify(value)}});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  const modelCatalog=await api('/api/gateway-workflows?catalog=1');assert.equal(modelCatalog.connections.length,3);
  const value={question:'TASK03 offline: explain indentation',materials:['if ready:\n  print("fixture")\n','\tsecond material'],constraints:'Only supplied text',
    generation:{connectionId:'local-a',model:'local',reasoningEffort:''},review:{connectionId:'local-b',model:'local',reasoningEffort:''}};
  const rejected=await fetch(origin+'/api/gateway-workflows',{method:'POST',headers,body:JSON.stringify({...value,attachments:[]})});assert.equal(rejected.status,400);
  const before=await api('/api/gateway-fixture-calls');
  const created=await api('/api/gateway-workflows',value);
  let task=created;
  const deadline=Date.now()+15000;
  while(task.status==='running' && Date.now()<deadline){await new Promise(r=>setTimeout(r,100));task=await api('/api/gateway-workflows?id='+created.id);}
  assert.equal(task.status,'awaiting-decision',JSON.stringify(task)+'\n'+stderr);
  assert.notEqual(task.stages.generation.sessionId,task.stages.review.sessionId);
  assert.equal(task.stages.generation.requestEvents[0].provider,'workflow-local-a');
  assert.equal(task.stages.review.requestEvents[0].provider,'workflow-local-b');
  for(const stage of Object.values(task.stages)) {assert.equal(stage.auxiliaryTitleAttempts,0);assert.deepEqual(stage.retryEvents,[]);}
  const reviewMessages=await api('/api/gateway-fixture-input?id='+task.stages.review.sessionId);
  const reviewTexts=reviewMessages.flat().map(b=>b.text);
  for(const text of [value.question,...value.materials,value.constraints,task.stages.generation.artifact]) assert.ok(reviewTexts.includes(text),'Review input must preserve each original text part');
  const calls=await api('/api/gateway-fixture-calls');assert.equal(calls.length-before.length,2);assert.ok(calls.every(c=>c.tools===0));
  await api('/api/gateway-workflows?id='+created.id,{choice:'defer',note:'离线验收，不代表真实模型质量'});
  await api('/api/gateway-workflows?id='+created.id);await api('/api/gateway-workflows');
  assert.equal((await api('/api/gateway-fixture-calls')).length,calls.length);
  console.log(JSON.stringify({result:'PASS',workflow:created.id,sessions:Object.values(task.stages).map(s=>s.sessionId),stubCalls:2,realModelCalls:0,authentication:401,origin:403,host:403,attachments:400,readAndDecisionExtraCalls:0}));
  if(faults) await runFaultChecks({api,
    postStatus:async(path,value)=>(await fetch(origin+path,{headers,method:'POST',body:JSON.stringify(value)})).status,
    restart:async()=>{await stop();url=await start();const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,303);
      cookie=response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');headers.Cookie=cookie;},
  });
  if(process.argv.includes('--serve')) {console.log('Offline browser fixture: '+url); await new Promise(()=>{});}
} finally {await stop();}
