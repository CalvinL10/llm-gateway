// P04-B manual harness: starts a credential-free real DSH Web host and waits
// for a person to use the native approval UI. It never answers approvals.
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRuntime} from '../ops/runtime-paths.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = name => {const index=args.indexOf(name); return index < 0 ? undefined : args[index+1];};
const runtime = (await inspectRuntime(resolve(valueOf('--runtime') ?? resolve(source,'runtime')))).runtime;
const launcher = (await inspectRuntime(runtime)).launcher;
const run = await mkdtemp(resolve(runtime,'approval-manual-'));
const plugin=resolve(run,'plugin'),home=resolve(run,'home'),workspace=resolve(run,'workspace');
const secondaryWorkspace=resolve(run,'workspace-secondary');
await mkdir(plugin,{recursive:true}); await mkdir(workspace); await mkdir(secondaryWorkspace);
for(const file of ['package.json','index.js','ledger.js','report.js','panel.js','tools.js'])
  await copyFile(resolve(source,file),resolve(plugin,file));
for(const file of ['fixture.js','fixture-scenario.mjs'])
  await copyFile(resolve(source,'tests/fixtures',file),resolve(plugin,file));
const presetDir=resolve(home,'.agent-presets/gateway-agent'); await mkdir(presetDir,{recursive:true});
await copyFile(resolve(source,'tests/fixtures/legacy-preset/development-preset.yml'),resolve(presetDir,'preset.yml'));
const preset=await readFile(resolve(source,'tests/fixtures/legacy-preset/development-agent.cordis.yml'),'utf8');
await writeFile(resolve(presetDir,'agent.cordis.yml'),preset.replace("'@llm-gateway/dsh-agent-gateway/tools'",
  JSON.stringify(resolve(plugin,'tools.js').replaceAll('\\','/'))));
const routes=[{provider:'fixture-lead',model:'planner'},{provider:'fixture-deep',model:'flash-a'},
  {provider:'fixture-google',model:'flash-b'}];
const patch=[{id:'session-title-llm',disabled:true},{id:'llm-retry',disabled:true},
  {id:'subagent-model-selection-settings',config:{enabled:true,allowedModels:routes}},
  {insert:[{id:'gateway-agent-fixture',name:resolve(plugin,'fixture.js').replaceAll('\\','/')},
    {id:'gateway-agent-tasks',name:resolve(plugin,'index.js').replaceAll('\\','/'),config:{
      workspaces:[{id:'approval-primary',label:'P04-B approval fixture',cwd:workspace},
        {id:'approval-secondary',label:'P04-B secondary fixture',cwd:secondaryWorkspace}],
      policy:{root:routes[0],allowedRoutes:routes,toolSet:'development',maxCalls:8}}}]}];
const patchPath=resolve(plugin,'approval.patch.json'); await writeFile(patchPath,JSON.stringify(patch));
const env={...process.env,DSH_HOME:home,DSH_PERMISSION_MODE:'workspace-write'};
execFileSync(process.execPath,[launcher,'web','--dump-config'],{cwd:workspace,env,stdio:'pipe'});
const host=spawn(process.execPath,[launcher,'web','--patch',patchPath,'--no-open','--host','127.0.0.1','--port',valueOf('--port') ?? '0'],
  {cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',stopping=false,announced=false;
host.stderr.on('data',chunk=>{stderr+=chunk.toString();});
host.stdout.on('data',chunk=>{
  stdout+=chunk.toString();
  const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
  if(match&&!announced) {
    announced=true;
    process.stdout.write(`P04_B_MANUAL_URL=${match[0]}\n`);
    process.stdout.write('Submit "manual approval two-step" and click Allow once, then Reject in the native session.\n');
    process.stdout.write('Submit "manual approval expire" and leave it unanswered for 10 seconds.\n');
    process.stdout.write('The fixture requests decisions only; it performs no file operation and makes zero real model calls. Press Ctrl+C to stop.\n');
  }
});
async function stop(code=0) {
  if(stopping)return; stopping=true;
  if(host.exitCode===null&&host.signalCode===null){host.kill();await once(host,'exit').catch(()=>{});}
  await rm(run,{recursive:true,force:true}).catch(()=>{});
  process.exitCode=code;
}
process.once('SIGINT',()=>{stop(0);}); process.once('SIGTERM',()=>{stop(0);});
host.once('exit',code=>{if(!stopping){process.stderr.write(`P04-B manual host exited ${code}: ${stderr}\n`);stop(code??1);}});
await once(host,'exit');
