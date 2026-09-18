import {mkdir,readFile,writeFile,copyFile,realpath,symlink,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {singleAttemptSubscription} from './subscription-copy.mjs';

const source=dirname(fileURLToPath(import.meta.url)), root=resolve(source,'../..');
const installed=await realpath(resolve(root,'.local/dsh-task02-home/profiles/web/node_modules/@eddyskywalker/dsh-chatgpt-subscription'));
const home=resolve(root,'.local/dsh-agent-subscription-home');
const cwd=resolve(root,'.local/dsh-agent-subscription-workspace');
const deployed=resolve(root,'.local/dsh-task02/gateway-agent-subscription');
const subscription=resolve(deployed,'subscription');
export async function ensureGrantableWorkspace(workspacePath) {
  await mkdir(workspacePath, {recursive: true});
  if (process.platform === 'win32') {
    const aclPkg = resolve(root, '.local/dsh-task02/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/index.js');
    const { pathToFileURL } = await import('node:url');
    const { AclWriteGrant, workspaceWriteSid } = await import(pathToFileURL(aclPkg).href);
    const sid = workspaceWriteSid(workspacePath);
    try {
      const grant = AclWriteGrant.create(sid);
      grant.add(workspacePath, true);
      grant.dispose();
    } catch (error) {
      if (error?.win32Code === 5 || String(error?.message ?? '').includes('Win32 5')) {
        const { readdirSync, rmdirSync, mkdirSync } = await import('node:fs');
        const entries = readdirSync(workspacePath);
        if (entries.length === 0) {
          rmdirSync(workspacePath);
          mkdirSync(workspacePath, { recursive: true });
          const grant2 = AclWriteGrant.create(sid);
          grant2.add(workspacePath, true);
          grant2.dispose();
        } else {
          throw new Error(`Deployment workspace ${workspacePath} is not grantable under Windows ACL sandbox (Win32 5) and is not empty. Please clean up or fix ownership.`);
        }
      } else {
        throw error;
      }
    }
  }
}

const slash = p => p.replaceAll('\\', '/');
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export function developmentPwshPatch(directory, development) {
  return development && process.platform === 'win32'
    ? [{id: 'pwsh-sandbox', disabled: true},
       {insert: [{id: 'gateway-pwsh-sandbox', name: slash(resolve(directory, 'pwsh-test-pipes.js'))}]}]
    : [];
}

async function deploy() {
  await mkdir(resolve(subscription, 'lib'), {recursive: true});
  await ensureGrantableWorkspace(cwd);
const patched=singleAttemptSubscription(await readFile(resolve(installed,'lib/index.js'),'utf8'));
for (const file of ['package.json','cordis.patch.yml']) await copyFile(resolve(installed,file),resolve(subscription,file));
for (const file of ['client.js']) await copyFile(resolve(installed,'lib',file),resolve(subscription,'lib',file));
await copyFile(resolve(installed,'LICENSE'),resolve(subscription,'LICENSE'));
await writeFile(resolve(subscription,'lib/index.js'),patched);
async function link(target,path) {
  try { await lstat(path); if(await realpath(path)!==await realpath(target)) throw new Error('Unexpected existing dependency link: '+path); }
  catch(error) {if(error.code!=='ENOENT')throw error; await mkdir(dirname(path),{recursive:true});await symlink(target,path,'junction');}
}
// Code dependencies only; no Home/settings/token files are linked or copied.
await link(resolve(installed,'../..'),resolve(subscription,'node_modules'));
const profile=resolve(home,'profiles/web'); await mkdir(profile,{recursive:true});
await link(subscription,resolve(profile,'node_modules/@eddyskywalker/dsh-chatgpt-subscription'));
await writeFile(resolve(profile,'package.json'),JSON.stringify({name:'gateway-subscription-profile',private:true,dsh:{profile:{
  bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@eddyskywalker/dsh-chatgpt-subscription']}}},null,2));
const isDevelopment = process.argv.includes('--development') || process.env.GATEWAY_PRESET === 'development';
for(const file of ['package.json','index.js','ledger.js','report.js','panel.js','tools.js','pwsh-test-pipes.js','node-test-pipes.cjs'])await copyFile(resolve(source,file),resolve(deployed,file));
const preset=resolve(home,'.agent-presets/gateway-agent');await mkdir(preset,{recursive:true});
await copyFile(resolve(source,isDevelopment ? 'preset/development-preset.yml' : 'preset/preset.yml'),resolve(preset,'preset.yml'));
let persona=await readFile(resolve(source,isDevelopment ? 'preset/development-agent.cordis.yml' : 'preset/agent.cordis.yml'),'utf8');
persona=persona.replace("'@llm-gateway/dsh-agent-gateway/tools'",JSON.stringify(slash(resolve(deployed,'tools.js'))));
persona=persona.replace('    provider: spawn','    agentOptions:\n      provider: antigravity\n      model: gemini-3.8-flash\n      reasoningEffort: high\n    provider: spawn');
await writeFile(resolve(preset,'agent.cordis.yml'),persona);
const lead={provider:'codex-chatgpt',model:'gpt-5.6-sol',reasoningEffort:'medium'};
const child={provider:'antigravity',model:'gemini-3.8-flash',reasoningEffort:'high'};
const patch=[...developmentPwshPatch(deployed,isDevelopment),{id:'session-title-llm',disabled:true},{id:'llm-retry',disabled:true},
  {id:'dsh-chatgpt-subscription',config:{syncAgentPresets:false}},
  {id:'subagent-model-selection-settings',config:{enabled:true,allowedModels:[{provider:child.provider,model:child.model}]}},
  {insert:[{id:'gateway-agent-tasks',name:slash(resolve(deployed,'index.js')),config:{cwd,policy:{root:lead,allowedRoutes:[lead,child],allowedChildRoutes:[child],...(isDevelopment?{toolSet:'development'}:{}),maxCalls:8}}}]}];
await writeFile(resolve(deployed,'subscription.patch.json'),JSON.stringify(patch,null,2));
console.log(JSON.stringify({home,cwd,patch:resolve(deployed,'subscription.patch.json'),mode:isDevelopment?'development':'delegation',credentialsCopied:false,realModelCalls:0}));
}

if (isDirectRun) {
  await deploy();
}
