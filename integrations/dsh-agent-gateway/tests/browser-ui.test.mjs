import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRuntime} from '../ops/runtime-paths.mjs';
import {edge,until,connectPage} from './fixtures/browser-test-client.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hostStartupDiagnostic(host, started, stdout, stderr) {
  const redact=value=>value.replace(/([?&]token=)[^\s&"'<>]+/g,'$1[redacted]').slice(-8000);
  return JSON.stringify({elapsedMs:Date.now()-started,exitCode:host.exitCode,signalCode:host.signalCode,
    stdout:redact(stdout),stderr:redact(stderr)});
}

test('browser host startup diagnostics preserve process state without disclosing tokens in either channel',()=>{
  const result=JSON.parse(hostStartupDiagnostic({exitCode:null,signalCode:null},Date.now(),
    'http://127.0.0.1:1/?token=PRIVATE.jwt-1&view=tasks', 'retry /?token=PRIVATE_second\nnot ready'));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  assert.equal(result.exitCode,null);assert.equal(result.signalCode,null);
  assert.ok(result.elapsedMs>=0);assert.match(result.stdout,/view=tasks/);assert.match(result.stderr,/not ready/);
});

test('real browser completes daily task entry recovery, refresh, relogin, empty, partial and cancel flows',
  {timeout: 120000}, async t => {
  const runtime = (await inspectRuntime(resolve(source, 'runtime'))).runtime;
  const launcher = (await inspectRuntime(runtime)).launcher;
  const run = await mkdtemp(resolve(runtime, 'browser-ui-test-'));
  const plugin = resolve(run, 'plugin'), home = resolve(run, 'home'), workspace = resolve(run, 'workspace');
  const secondaryWorkspace = resolve(run, 'workspace-secondary');
  const profile = resolve(run, 'edge-profile');
  await mkdir(plugin, {recursive:true}); await mkdir(workspace); await mkdir(secondaryWorkspace); await mkdir(profile);
  for (const file of ['package.json','index.js','ledger.js','report.js','panel.js','tools.js'])
    await copyFile(resolve(source, file), resolve(plugin, file));
  for (const file of ['fixture.js','fixture-scenario.mjs'])
    await copyFile(resolve(source, 'tests/fixtures', file), resolve(plugin, file));
  const presetDir = resolve(home, '.agent-presets/gateway-agent'); await mkdir(presetDir, {recursive:true});
  await copyFile(resolve(source, 'tests/fixtures/legacy-preset/development-preset.yml'), resolve(presetDir, 'preset.yml'));
  const preset = await readFile(resolve(source, 'tests/fixtures/legacy-preset/development-agent.cordis.yml'), 'utf8');
  await writeFile(resolve(presetDir, 'agent.cordis.yml'), preset.replace("'@llm-gateway/dsh-agent-gateway/tools'",
    JSON.stringify(resolve(plugin, 'tools.js').replaceAll('\\', '/'))));
  const routes = [{provider:'fixture-lead',model:'planner'},{provider:'fixture-deep',model:'flash-a'},
    {provider:'fixture-google',model:'flash-b'}];
  const patch = [{id:'session-title-llm',disabled:true},{id:'llm-retry',disabled:true},
    {id:'subagent-model-selection-settings',config:{enabled:true,allowedModels:routes}},
    {insert:[{id:'gateway-agent-fixture',name:resolve(plugin,'fixture.js').replaceAll('\\','/')},
      {id:'gateway-agent-tasks',name:resolve(plugin,'index.js').replaceAll('\\','/'),config:{
        workspaces:[{id:'browser-fixture',label:'Browser fixture workspace',cwd:workspace},
          {id:'browser-secondary',label:'Secondary browser workspace',cwd:secondaryWorkspace}],
        authorizedTaskMaxCalls:[4,8],
        policy:{root:routes[0],allowedRoutes:routes,toolSet:'development',maxCalls:8}}}]}];
  const patchPath = resolve(plugin, 'browser.patch.json'); await writeFile(patchPath, JSON.stringify(patch));
  const env = {...process.env, DSH_HOME:home, DSH_PERMISSION_MODE:'workspace-write'};
  // Match the managed runtime: native session serialization loads Node internal modules.
  execFileSync(process.execPath, ['--expose-internals',launcher,'web','--dump-config'], {cwd:workspace,env,stdio:'pipe'});
  let host, browser, cdp, stderr = '';
  t.after(async () => {
    try { await cdp?.call('Browser.close'); } catch {}
    if (browser && browser.exitCode === null && browser.signalCode === null) {browser.kill(); await once(browser,'exit').catch(()=>{});}
    if (host && host.exitCode === null && host.signalCode === null) {host.kill(); await once(host,'exit').catch(()=>{});}
    await rm(run, {recursive:true,force:true}).catch(()=>{});
  });
  host = spawn(process.execPath,['--expose-internals',launcher,'web','--patch',patchPath,'--no-open','--host','127.0.0.1','--port','0'],
    {cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  host.stderr.on('data', chunk => {stderr += chunk.toString();});
  let stdout = '';
  const startupStarted = Date.now();
  const startupDiagnostic = () => hostStartupDiagnostic(host,startupStarted,stdout,stderr);
  const authUrl = await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host startup timeout: ' + startupDiagnostic())), 30000);
    host.once('error', error => {clearTimeout(timeout); reject(new Error('Host spawn failed: '+error.message));});
    host.once('exit', code => {clearTimeout(timeout); reject(new Error('Host exited ' + code + ': ' + startupDiagnostic()));});
    host.stdout.on('data', chunk => {stdout += chunk; const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
      if (match) {clearTimeout(timeout); resolvePromise(match[0]);}});
  });
  t.diagnostic('Browser fixture host startup milliseconds: '+(Date.now()-startupStarted));
  const origin = new URL(authUrl).origin;
  browser = spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=0',`--user-data-dir=${profile}`,authUrl], {windowsHide:true,stdio:'ignore'});
  cdp = await connectPage(profile);
  const root = `document.getElementById('gateway-task-entry')?.shadowRoot`;
  await until(() => cdp.evaluate(`!!${root}`));
  const welcomeLabels = ['内测声明', 'Internal Testing Notice'];
  const welcomeActions = ['继续', 'Continue'];
  await until(() => cdp.evaluate(`(() => {
    const dialog=[...document.querySelectorAll('[role="dialog"]')]
      .find(item=>${JSON.stringify(welcomeLabels)}.includes(item.getAttribute('aria-label')));
    return !!dialog && [...dialog.querySelectorAll('button')]
      .some(button=>${JSON.stringify(welcomeActions)}.includes(button.textContent.trim()));
  })()`));
  const welcome = await cdp.evaluate(`(() => {
    const dialog=[...document.querySelectorAll('[role="dialog"]')]
      .find(item=>${JSON.stringify(welcomeLabels)}.includes(item.getAttribute('aria-label')));
    const button=[...dialog.querySelectorAll('button')]
      .find(item=>${JSON.stringify(welcomeActions)}.includes(item.textContent.trim()));
    const result={label:dialog.getAttribute('aria-label'),action:button.textContent.trim(),
      rootInert:document.getElementById('root')?.inert===true};
    button.click(); return result;
  })()`);
  assert.ok(welcomeLabels.includes(welcome.label));
  assert.ok(welcomeActions.includes(welcome.action));
  assert.equal(welcome.rootInert, true, 'fresh-home welcome notice must block host navigation until acknowledged');
  await until(() => cdp.evaluate(`document.getElementById('root')?.inert===false &&
    ![...document.querySelectorAll('[role="dialog"]')]
      .some(item=>${JSON.stringify(welcomeLabels)}.includes(item.getAttribute('aria-label')))`));
  await cdp.evaluate(`${root}.getElementById('open').click()`);
  await until(() => cdp.evaluate(`${root}.getElementById('workspace').value === 'browser-fixture'`));
  assert.equal(await cdp.evaluate(`${root}.getElementById('workspace').options.length`), 2);
  assert.deepEqual(await cdp.evaluate(`[...${root}.getElementById('call-limit').options].map(option=>option.value)`), ['4','8']);
  assert.equal(await cdp.evaluate(`${root}.getElementById('call-limit').value`), '8');
  await cdp.evaluate(`(()=>{const select=${root}.getElementById('workspace'); select.value='browser-secondary';
    select.dispatchEvent(new Event('change'))})()`);
  await cdp.evaluate(`(()=>{const select=${root}.getElementById('call-limit'); select.value='4';
    select.dispatchEvent(new Event('change'))})()`);
  assert.match(await cdp.evaluate(`${root}.getElementById('policy').textContent`), /默认 8 次模型调用.*已授权限额 4、8.*命令执行不可用/);
  assert.deepEqual(await cdp.evaluate(`(async()=>{const response=await fetch('/api/gateway-agent-tasks',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),
      goal:'must be rejected',workspaceId:'client-supplied-path'})}); return {status:response.status,...await response.json()};})()`),
    {status:400,error:'WORKSPACE_NOT_AUTHORIZED'});

  await cdp.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window); window.__gatewayNativeFetch = nativeFetch;
    window.__lostOnce = false; window.__gatewayDisconnected = false;
    window.fetch = async (...args) => { const [url, options = {}] = args;
      if (window.__gatewayDisconnected && url.startsWith('/api/gateway-agent-tasks'))
        throw new TypeError('Synthetic connection loss');
      if (!window.__lostOnce && url === '/api/gateway-agent-tasks' && options.method === 'POST') {
        window.__lostOnce = true; const response = await nativeFetch(...args); await response.clone().text();
        window.__gatewayDisconnected = true;
        throw new TypeError('Synthetic response loss');
      }
      return nativeFetch(...args);
    };
  })()`);
  const firstId = await cdp.evaluate(`(() => {const r=${root}, g=r.getElementById('goal');
    g.value='simple task browser response loss'; g.dispatchEvent(new Event('input'));
    const id=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).draft.requestId;
    r.getElementById('submit').click(); r.getElementById('submit').click(); return id;})()`);
  await until(() => cdp.evaluate(`(async()=>{const value=await (await window.__gatewayNativeFetch('/api/gateway-agent-tasks')).json();
    return value.tasks.length===1 && value.tasks[0].status==='completed';})()`));
  await until(() => cdp.evaluate(`JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).draft.pending===true`));
  assert.equal(await cdp.evaluate(`${root}.getElementById('submit').disabled`), true);
  // An older pending draft has no maxCalls field; upgrade recovery must still find its immutable task policy.
  await cdp.evaluate(`(()=>{const value=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1'));
    delete value.draft.maxCalls; localStorage.setItem('gateway-agent-task-entry-v1',JSON.stringify(value));})()`);
  await cdp.call('Page.reload', {ignoreCache:true});
  await until(() => cdp.evaluate(`!!${root}`)); await cdp.evaluate(`${root}.getElementById('open').click()`);
  await until(() => cdp.evaluate(`(()=>{const value=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1'));
    return value.draft.pending===false && value.selectedTaskId===${JSON.stringify(firstId)}})()`));
  const recovered = await cdp.evaluate(`(async()=>{const tasks=await (await fetch('/api/gateway-agent-tasks')).json();
    const fixture=await (await fetch('/api/gateway-agent-fixture')).json();
    return {id:tasks.tasks[0].id,count:tasks.tasks.length,calls:fixture.calls.length,error:${root}.getElementById('error').textContent,
      draft:JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).draft.requestId};})()`);
  assert.deepEqual({...recovered, draft:undefined, error:undefined},
    {id:firstId,count:1,calls:1,error:undefined,draft:undefined});
  assert.match(recovered.error, /找回任务.*没有重复提交/);
  assert.notEqual(recovered.draft, firstId);
  assert.equal((await cdp.evaluate(`(async()=>await (await fetch('/api/gateway-agent-fixture')).json())()`)).calls[0].cwd,
    secondaryWorkspace);
  assert.equal(await cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
    return value.tasks[0].policy.maxCalls})()`), 4);
  assert.match(await cdp.evaluate(`${root}.getElementById('result-ref').textContent`), /gateway-agent-/);
  const draftAfterSubmit = recovered.draft;
  // Both native controls and target rows may hydrate after API recovery.
  await cdp.evaluate(`(() => {
    const original = document.querySelectorAll.bind(document);
    const originalOne = document.querySelector.bind(document);
    const title = '目标任务 · ' + ${JSON.stringify(firstId)}.slice(0, 8);
    window.__delayedTaskRowProbes = 0;
    window.__delayedSidebarProbes = 0;
    const sidebarReady = performance.now() + 300;
    const until = performance.now() + 600;
    document.querySelector = selector => {
      if (selector === 'button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]'
          && performance.now() < sidebarReady) { window.__delayedSidebarProbes++; return null; }
      return originalOne(selector);
    };
    document.querySelectorAll = selector => {
      const rows = original(selector);
      if (selector !== '[role="treeitem"]' || performance.now() >= until) return rows;
      window.__delayedTaskRowProbes++;
      return [...rows].filter(row => !row.textContent.includes(title));
    };
    setTimeout(() => { document.querySelectorAll = original; document.querySelector = originalOne; }, 1500);
  })()`);
  await cdp.evaluate(`${root}.getElementById('open-native').click()`);
  try {
    await until(() => cdp.evaluate(`document.body.innerText.includes('simple task browser response loss') && document.body.innerText.includes('DIRECT_ANSWER')`));
  } catch (error) {
    const diagnostic = await cdp.evaluate(`(async() => {
      const saved=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1'));
      const tasks=await (await fetch('/api/gateway-agent-tasks')).json();
      const fixture=await (await fetch('/api/gateway-agent-fixture')).json();
      const selected=tasks.tasks.find(item=>item.id===saved?.selectedTaskId);
      return {
        href:location.origin+location.pathname,rootInert:document.getElementById('root')?.inert===true,
        dialogs:[...document.querySelectorAll('[role="dialog"]')].map(item=>({
          label:item.getAttribute('aria-label'),text:item.textContent.trim().slice(0,500)})).slice(0,10),
        sidebarToggle:[...document.querySelectorAll('button')]
          .find(button=>['打开侧边栏','Open sidebar','收起侧边栏','Collapse sidebar'].includes(button.getAttribute('aria-label')))
          ?.getAttribute('aria-label')??null,
        treeitems:[...document.querySelectorAll('[role="treeitem"]')].map(item=>item.textContent.trim()).slice(0,100),
        panelError:${root}?.getElementById('error')?.textContent??null,
        panelOpen:${root}?.querySelector('dialog')?.open??null,
        selectedTask:selected?{id:selected.id,status:selected.status,sessionId:selected.sessionId,
          workspaceId:selected.workspaceId}:null,
        fixtureCalls:fixture.calls.length,delayedTaskRowProbes:window.__delayedTaskRowProbes??null,
        delayedSidebarProbes:window.__delayedSidebarProbes??null,
        hasGoal:document.body.innerText.includes('simple task browser response loss'),
        hasDirectAnswer:document.body.innerText.includes('DIRECT_ANSWER')
      };
    })()`);
    t.diagnostic('Native navigation timeout diagnostic: '+JSON.stringify(diagnostic));
    t.diagnostic('Host state at native navigation timeout: '+startupDiagnostic());
    throw error;
  }
  assert.ok(await cdp.evaluate(`window.__delayedTaskRowProbes > 2`), 'navigation must wait beyond the old probes');
  assert.ok(await cdp.evaluate(`window.__delayedSidebarProbes > 1`), 'navigation must wait for native controls too');
  assert.equal((await cdp.evaluate(`(async()=>await (await fetch('/api/gateway-agent-fixture')).json())()`)).calls.length, 1);

  await cdp.call('Network.clearBrowserCookies'); await cdp.call('Page.reload', {ignoreCache:true});
  await until(() => cdp.evaluate(`location.origin === ${JSON.stringify(origin)}`));
  assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).draft.requestId`), draftAfterSubmit);
  await cdp.call('Page.navigate', {url:authUrl}); await until(() => cdp.evaluate(`!!${root}`));
  await cdp.evaluate(`${root}.getElementById('open').click()`); await until(() => cdp.evaluate(`${root}.getElementById('tasks').children.length===1`));
  await cdp.evaluate(`(() => {const value=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1'));
    value.draft={requestId:${JSON.stringify(firstId)},goal:'conflicting browser goal',workspaceId:'browser-secondary',pending:false};
    localStorage.setItem('gateway-agent-task-entry-v1',JSON.stringify(value));})()`);
  await cdp.call('Page.reload', {ignoreCache:true}); await until(() => cdp.evaluate(`!!${root}`));
  await cdp.evaluate(`${root}.getElementById('open').click()`); await until(() => cdp.evaluate(
    `${root}.getElementById('goal').value==='conflicting browser goal' && !${root}.getElementById('submit').disabled`));
  await cdp.evaluate(`${root}.getElementById('submit').click()`);
  await until(() => cdp.evaluate(`${root}.getElementById('error').textContent.includes('冲突')`));
  assert.deepEqual(await cdp.evaluate(`(()=>{const value=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1'));
    return {sameGoal:value.draft.goal==='conflicting browser goal',newId:value.draft.requestId!==${JSON.stringify(firstId)}}})()`),
    {sameGoal:true,newId:true});
  assert.equal((await cdp.evaluate(`(async()=>await (await fetch('/api/gateway-agent-tasks')).json())()`)).tasks.length, 1);

  async function submitGoal(goal, expectedCount, done) {
    await cdp.evaluate(`(() => {const r=${root}, g=r.getElementById('goal'); g.value=${JSON.stringify(goal)};
      g.dispatchEvent(new Event('input')); r.getElementById('submit').click();})()`);
    return until(() => cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
      const task=value.tasks.find(item=>item.id===JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).selectedTaskId);
      return value.tasks.length===${expectedCount} && task && (${done});})()`), 40000);
  }
  await submitGoal('empty result browser', 2, `task.status==='completed'`);
  await until(() => cdp.evaluate(`${root}.getElementById('status').textContent.includes('未经测试或业务验收')`));
  assert.match(await cdp.evaluate(`${root}.getElementById('result').textContent`), /没有可显示的最终文本/);
  assert.match(await cdp.evaluate(`${root}.getElementById('status').textContent`), /未经测试或业务验收/);

  await submitGoal('loop until budget stops browser', 3, `task.status==='limited'`);
  await until(() => cdp.evaluate(`${root}.getElementById('status').textContent.includes('调用限额')`));
  assert.match(await cdp.evaluate(`${root}.getElementById('status').textContent`), /调用限额/);
  assert.match(await cdp.evaluate(`${root}.getElementById('operations').textContent`), /list_subagent_models/);

  await submitGoal('browser file evidence', 4, `task.status==='completed'`);
  await until(() => cdp.evaluate(`${root}.getElementById('operations').textContent.includes('文件变更') &&
    ${root}.getElementById('operations').textContent.includes('命令')`));
  const operationText = await cdp.evaluate(`${root}.getElementById('operations').textContent`);
  assert.match(operationText, /文件变更 · write · succeeded .*#seq:\d+→\d+/);
  assert.match(operationText, /命令 · pwsh · failed .*#seq:\d+→\d+/);
  assert.match(await cdp.evaluate(`${root}.getElementById('validation').textContent`), /命令成功不能自动算测试通过/);
  await cdp.evaluate(`${root}.getElementById('open-native').click()`);
  await until(() => cdp.evaluate(`document.body.innerText.includes('browser-result.txt') &&
    document.body.innerText.includes('BROWSER_FILE_EVIDENCE_FINISHED')`));
  assert.equal(await cdp.evaluate(`(()=>{const button=[...document.querySelectorAll('button')]
    .find(item=>/工具调用|tool calls?/i.test(item.textContent)); button?.click(); return !!button})()`), true);
  await until(() => cdp.evaluate(`document.body.innerText.includes('Pwsh')`));
  assert.match(await cdp.evaluate(`document.body.innerText`), /Gateway shell disabled|命令执行/);
  await cdp.evaluate(`${root}.getElementById('open').click()`); await until(() => cdp.evaluate(`${root}.getElementById('tasks').children.length===4`));

  await cdp.evaluate(`(() => {const r=${root}, g=r.getElementById('goal'); g.value='cancel child browser';
    g.dispatchEvent(new Event('input')); r.getElementById('submit').click();})()`);
  await until(() => cdp.evaluate(`(async()=>{const f=await (await fetch('/api/gateway-agent-fixture')).json(); return f.activeChildren>0;})()`));
  await cdp.evaluate(`${root}.getElementById('cancel').click()`);
  await until(() => cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
    const id=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).selectedTaskId;
    return value.tasks.length===5 && value.tasks.find(item=>item.id===id)?.status==='stopped';})()`), 40000);
  await until(() => cdp.evaluate(`${root}.getElementById('status').textContent.includes('停止')`));
  assert.match(await cdp.evaluate(`${root}.getElementById('status').textContent`), /停止/);
  assert.equal(await cdp.evaluate(`${root}.getElementById('error').textContent`), '');
  assert.match(await cdp.evaluate(`${root}.getElementById('validation').textContent`), /未建立.*未验收/);

  await cdp.evaluate(`(() => {const r=${root}, g=r.getElementById('goal'); g.value='approval cancel browser';
    g.dispatchEvent(new Event('input')); r.getElementById('submit').click();})()`);
  await until(() => cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
    const id=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).selectedTaskId;
    const task=value.tasks.find(item=>item.id===id);
    return value.tasks.length===6 && task?.report.approvalOperations?.some(item=>item.outcome==='pending');})()`));
  await until(() => cdp.evaluate(`${root}.getElementById('approvals').textContent.includes('pending')`));
  assert.match(await cdp.evaluate(`${root}.getElementById('workspace-scope').textContent`), /Secondary browser workspace.*不会授权其他工作区/);
  await cdp.evaluate(`${root}.getElementById('open-native').click()`);
  await until(() => cdp.evaluate(`!!document.querySelector('[data-approval-key]')`));
  assert.match(await cdp.evaluate(`document.querySelector('[data-approval-scroll]').textContent`), /TEST ONLY.*cancel the task/);
  await cdp.evaluate(`${root}.getElementById('open').click()`);
  await until(() => cdp.evaluate(`${root}.getElementById('tasks').children.length===6`));
  await cdp.evaluate(`${root}.getElementById('cancel').click()`);
  await until(() => cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
    const id=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).selectedTaskId;
    const task=value.tasks.find(item=>item.id===id);
    return task?.status==='stopped' && task.report.approvalOperations?.some(item=>item.outcome==='cancelled');})()`), 40000);
  await until(() => cdp.evaluate(`!document.querySelector('[data-approval-key]')`));
  await until(() => cdp.evaluate(`${root}.getElementById('approvals').textContent.includes('cancelled')`));
  assert.match(await cdp.evaluate(`${root}.getElementById('approvals').textContent`), /cancelled/);
  await until(() => cdp.evaluate(`!${root}.getElementById('submit').disabled`));

  await cdp.evaluate(`(() => {const r=${root}, select=r.getElementById('workspace'); select.value='browser-fixture';
    select.dispatchEvent(new Event('change'))})()`);
  await submitGoal('cross workspace write browser', 7, `!['queued','running','cancel-requested'].includes(task.status)`);
  const crossWorkspaceState = await cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
    const id=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).selectedTaskId;
    const task=value.tasks.find(item=>item.id===id); return {status:task.status,stopReason:task.report.stopReason,
      budget:task.report.budget,artifact:task.artifact};})()`);
  assert.equal(crossWorkspaceState.status,'completed',JSON.stringify(crossWorkspaceState));
  await until(() => cdp.evaluate(`${root}.getElementById('operations').textContent.includes('write · failed')`));
  await assert.rejects(access(resolve(secondaryWorkspace,'cross-workspace.txt')), {code:'ENOENT'});
  const crossWorkspace = await cdp.evaluate(`(async()=>{const value=await (await fetch('/api/gateway-agent-tasks')).json();
    const id=JSON.parse(localStorage.getItem('gateway-agent-task-entry-v1')).selectedTaskId;
    const task=value.tasks.find(item=>item.id===id); return {approvals:task.report.approvalOperations.length,
      workspaceId:task.workspaceId,failed:task.report.failedOperations.some(item=>item.name==='write')};})()`);
  assert.deepEqual(crossWorkspace,{approvals:0,workspaceId:'browser-fixture',failed:true});

  console.log(JSON.stringify({result:'GATEWAY_BROWSER_UI_PASS',browser:'Microsoft Edge',scriptedModel:true,
    sustainedDisconnectRecovered:true,conflictPreserved:true,doubleClickSingleFlight:true,refreshNoReplay:true,
    reloginRecovered:true,nativeSessionOpened:true,emptyResult:true,partialEvidence:true,
    fileAndCommandResultsOpened:true,cancelled:true,pendingApprovalOpened:true,
    cancelDidNotApprove:true,crossWorkspaceWriteDenied:true,realModelCalls:0,tasks:7}));
});
