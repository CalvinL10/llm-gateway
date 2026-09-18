import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,copyFile,writeFile,readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {developmentPwshPatch} from './deploy-subscription.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const source=resolve(root,'integrations/dsh-agent-gateway');
const diagnostic=resolve(root,'.local/dsh-task02/node-test-pipes-regression');
await mkdir(diagnostic,{recursive:true});
for(const name of ['package.json','pwsh-test-pipes.js','node-test-pipes.cjs'])
  await copyFile(resolve(source,name),resolve(diagnostic,name));
const {default:Executor,withTestPipePreload}=await import(pathToFileURL(resolve(diagnostic,'pwsh-test-pipes.js')));
const require=createRequire(import.meta.url);
const {isTestWorker}=require('./node-test-pipes.cjs');

test('only the default isolated Node test worker is matched',()=>{
  const options={env:{NODE_TEST_CONTEXT:'child-v8'},stdio:['pipe','pipe','pipe']};
  assert.equal(isTestWorker(process.execPath,options),true);
  assert.equal(isTestWorker('other.exe',options),false);
  assert.equal(isTestWorker(process.execPath,{...options,env:{}}),false);
  assert.equal(isTestWorker(process.execPath,{...options,stdio:['ignore','pipe','pipe']}),false);
  assert.equal(isTestWorker(process.execPath,{...options,stdio:[...options.stdio,'ipc']}),false);
});
test('executor preserves policy, argv, environment and abort signal',()=>{
  const env={NODE_OPTIONS:'--no-warnings',KEEP:'original'};
  const patched=withTestPipePreload(env,'--trace-warnings');
  assert.equal(env.NODE_OPTIONS,'--no-warnings');
  assert.match(patched.NODE_OPTIONS,/^--no-warnings --require /);
  assert.equal(patched.KEEP,'original');
  const signal=new AbortController().signal;
  const policy={mode:'workspace-write'};
  const spec={command:'node --test .\\range.test.js',workdir:'unchanged',env,sandboxPolicy:policy};
  const context={config:{maxSpillBytes:4096,maxOutputBytes:4096,graceMs:10}};
  const result=Executor.prototype.spawnSpec.call(context,spec,4096,signal,['native-confinement','unchanged']);
  assert.deepEqual(result.argv,['native-confinement','unchanged']);
  assert.equal(result.cwd,'unchanged');assert.equal(result.signal,signal);assert.equal(spec.sandboxPolicy,policy);
  assert.equal(result.env.KEEP,'original');
  if(process.platform==='win32')assert.match(result.env.NODE_OPTIONS,/node-test-pipes.cjs/);
  for(const mode of ['read-only','danger-full-access']){
    const unchanged=Executor.prototype.spawnSpec.call(context,{...spec,sandboxPolicy:{mode}},4096,signal,['native']);
    assert.equal(unchanged.env.NODE_OPTIONS,'--no-warnings');
  }
});
test('development deployment selects the confined executor through real loader semantics',async()=>{
  assert.deepEqual(developmentPwshPatch(diagnostic,false),[]);
  const patch=developmentPwshPatch(diagnostic,true);
  if(process.platform!=='win32'){assert.deepEqual(patch,[]);return;}
  const {composeEntries}=await import(pathToFileURL(resolve(root,'.local/dsh-task02/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
  const native={id:'pwsh-sandbox',name:'@deepseek-ai/dsh-pwsh-sandbox',config:{timeoutMs:60000}};
  const warnings=[];
  const entries=composeEntries([[{insert:[native]}],patch],message=>warnings.push(message));
  assert.deepEqual(warnings,[]);
  assert.equal(entries[0].disabled,true);
  assert.equal(entries[0].name,native.name);
  assert.deepEqual(entries[0].config,native.config);
  assert.equal(entries[1].id,'gateway-pwsh-sandbox');
  assert.equal(entries[1].name,resolve(diagnostic,'pwsh-test-pipes.js').replaceAll('\\','/'));
  assert.equal(Object.getPrototypeOf(Executor.prototype).constructor.name,'SandboxPwshExecutor');
});

const workspace=process.env.GATEWAY_PIPE_TEST_WORKSPACE;
test('same-workspace native ACL before/after regression (zero model)',{skip:!workspace||process.platform!=='win32',timeout:60000},async t=>{
  // Explicit existing workspace only: never prepare its ACL or replace it with a temp workspace.
  const cwd=resolve(workspace,'acceptance-boundary-fixture');
  await access(resolve(cwd,'range.test.js'));
  const original=await readFile(resolve(cwd,'range.test.js'));
  const {AclSandbox,workspaceWriteSid}=await import(pathToFileURL(resolve(root,'.local/dsh-task02/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/index.js')));
  const {resolvePwshPath}=await import(pathToFileURL(resolve(root,'.local/dsh-task02/node_modules/@deepseek-ai/dsh-pwsh-local/lib/index.js')));
  const sandbox=new AclSandbox({mode:'workspace-write',writableDirs:[workspace],writeSid:workspaceWriteSid(workspace),tempDir:null,manageDacls:false});
  const evidence={workspace,cwd,node:process.version,scope:'native ACL backend only; temp disabled; no deployment or gateway session',results:[]};
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  async function run(command,preload){
    const options=preload?withTestPipePreload({NODE_OPTIONS:''}).NODE_OPTIONS:'';
    // Remove only the outer regression runner's child marker, absent in deployment.
    const full='$env:NODE_TEST_CONTEXT = $null; $env:NODE_OPTIONS = '+quote(options)+'; '+command;
    const result=await sandbox.spawn({command:resolvePwshPath(),args:['-NoLogo','-NoProfile','-NonInteractive','-Command',full],cwd,stdio:'pipe'}).wait();
    const item={command,preload,exitCode:result.exitCode,stdout:result.stdout.toString(),stderr:result.stderr.toString()};
    evidence.results.push(item);return item;
  }
  try{
    await sandbox.init();
    await t.test('unpatched original command still reproduces EPERM',async()=>{
      const r=await run('node --test .\\range.test.js',false);
      assert.equal(r.exitCode,1);assert.match(r.stdout+r.stderr,/spawn EPERM/);
    });
    await t.test('patched original command passes without disabling isolation',async()=>{
      const r=await run('node --test .\\range.test.js',true);
      assert.equal(r.exitCode,0);assert.match(r.stdout,/pass 1/);
    });
    const helper=resolve(diagnostic,'worker-fixture.cjs');
    const denied=resolve(diagnostic,'must-not-write.txt');
    await assert.rejects(access(denied),{code:'ENOENT'});
    await writeFile(helper,
      "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');\n"+
      "test('isolated worker retains confinement and output',()=>{assert.notEqual(process.pid,Number(process.env.PARENT_PID));assert.equal(process.env.NODE_TEST_CONTEXT,'child-v8');assert.throws(()=>fs.writeFileSync("+JSON.stringify(denied)+",'forbidden'),e=>['EPERM','EACCES'].includes(e.code));console.log('x'.repeat(32768)+'STDOUT_END');console.error('STDERR_END');if(process.env.EXPECT_FAILURE==='1')assert.fail('EXPECTED_BUSINESS_FAILURE');});\n");
    // Capture the actual runner PID in its own preload, not the outer host PID.
    const parentMarker=resolve(diagnostic,'parent-marker.cjs');
    await writeFile(parentMarker,"if(process.env.NODE_TEST_CONTEXT!=='child-v8')process.env.PARENT_PID=String(process.pid);\n");
    const helperCommand='$env:NODE_OPTIONS += '+quote(' --require '+JSON.stringify(parentMarker))+'; node --test '+quote(helper);
    await t.test('isolated worker keeps denied writes and complete stdout/stderr',async()=>{
      const r=await run(helperCommand,true);
      assert.equal(r.exitCode,0);assert.match(r.stdout,/STDOUT_END/);assert.match(r.stdout+r.stderr,/STDERR_END/);
      await assert.rejects(access(denied),{code:'ENOENT'});
    });
    await t.test('real assertion failure remains a nonzero command result',async()=>{
      const r=await run("$env:EXPECT_FAILURE = '1'; "+helperCommand,true);
      assert.equal(r.exitCode,1);assert.match(r.stdout+r.stderr,/EXPECTED_BUSINESS_FAILURE/);assert.doesNotMatch(r.stdout+r.stderr,/spawn EPERM/);
    });
    await t.test('multiple isolated workers drain output without pipe deadlock',async()=>{
      const files=[];
      for(let i=0;i<4;i++){
        const file=resolve(diagnostic,'parallel-worker-'+i+'.cjs');
        await copyFile(helper,file);files.push(quote(file));
      }
      const r=await run('$env:NODE_OPTIONS += '+quote(' --require '+JSON.stringify(parentMarker))+'; node --test --test-concurrency=4 '+files.join(' '),true);
      assert.equal(r.exitCode,0);assert.match(r.stdout,/pass 4/);
      assert.equal((r.stdout.match(/STDOUT_END/g)||[]).length,4);
      assert.equal(((r.stdout+r.stderr).match(/STDERR_END/g)||[]).length,4);
    });
    await t.test('worker timeout remains a failure and closes inherited pipes',async()=>{
      const slow=resolve(diagnostic,'slow-worker.cjs');
      await writeFile(slow,"require('node:test')('timeout fixture',async()=>{await new Promise(r=>setTimeout(r,10000));});\n");
      const r=await run('node --test --test-timeout=300 '+quote(slow),true);
      assert.equal(r.exitCode,1);assert.match(r.stdout+r.stderr,/timed out|timeout/i);
      assert.doesNotMatch(r.stdout+r.stderr,/spawn EPERM/);
    });
    assert.deepEqual(await readFile(resolve(cwd,'range.test.js')),original);
  }finally{
    sandbox.dispose();
    await writeFile(resolve(root,'.local/diagnostic-6846b7ee-pipe-regression.json'),JSON.stringify(evidence,null,2));
  }
});
