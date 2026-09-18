import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Real Web/Controller/loop/storage, but credential-free local adapters only.
export async function runFaultChecks({api, postStatus, restart}) {
  const path='/api/gateway-workflows', ids={}, evidence=[];
  const input=(generation='local',review='local')=>({requestId:randomUUID(),question:'TASK04 local fault test',
    materials:['if ready:\n  keep_exact_text()'],constraints:'Only supplied text',
    generation:{connectionId:'local-a',model:generation,reasoningEffort:''},
    review:{connectionId:'local-b',model:review,reasoningEffort:''}});
  const get=id=>api(path+'?id='+id);
  const calls=()=>api('/api/gateway-fixture-calls');
  async function waitFor(read, check) {
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {const value=await read();if(check(value))return value;await new Promise(r=>setTimeout(r,30));}
    assert.fail('Timed out waiting for local fixture state');
  }
  const terminal=id=>waitFor(()=>get(id),t=>!['running','cancel-requested'].includes(t.status));
  const retry=(task,role)=>api(path+'?id='+task.id+'&action=retry',{role,sessionId:task.stages[role].sessionId});
  const cancel=id=>api(path+'?id='+id+'&action=cancel',{});

  // Simultaneous/repeated POSTs (including replay after a lost response) create exactly one task.
  const before=(await calls()).length, value=input();
  const created=await Promise.all(Array.from({length:6},()=>api(path,value)));
  assert.ok(created.every(t=>t.id===value.requestId));
  await terminal(value.requestId);await api(path,value);
  assert.equal((await calls()).length-before,2);
  assert.equal(await postStatus(path,{...value,question:'different input'}),400);
  ids.duplicate=value.requestId;evidence.push('same UUID: 6 concurrent + repeated POSTs = 2 stage calls; changed input rejected');

  let task=await api(path,input('local','fail-once'));task=await terminal(task.id);
  assert.equal(task.status,'failed');assert.equal(task.stages.review.status,'failed');
  const draft=structuredClone(task.stages.generation), oldReview=task.stages.review.sessionId;
  await api(path+'?id='+task.id,{choice:'defer',note:'keep draft before retry'});
  const priorCalls=(await calls()).length;
  const attempts=await Promise.all([retry(task,'review'),postStatus(path+'?id='+task.id+'&action=retry',{role:'review',sessionId:oldReview})]);
  assert.equal(attempts[1],400);
  task=await terminal(task.id);assert.equal(task.status,'awaiting-decision');
  assert.deepEqual(task.stages.generation,draft);assert.notEqual(task.stages.review.sessionId,oldReview);
  assert.equal(task.stages.review.attempts[0].sessionId,oldReview);
  assert.equal(task.decision,null);assert.equal(task.decisionHistory[0].choice,'defer');
  assert.equal((await calls()).length-priorCalls,1);
  ids.reviewRetry=task.id;evidence.push('review retry: 1 extra call, draft unchanged, previous attempt/decision retained, duplicate retry rejected');

  task=await api(path,input('fail-once'));task=await terminal(task.id);
  assert.equal(task.status,'failed');assert.equal(task.stages.review.status,'pending');
  await retry(task,'generation');task=await terminal(task.id);assert.equal(task.status,'awaiting-decision');
  assert.equal(task.stages.generation.attempts.length,1);ids.generationRetry=task.id;

  for(const model of ['login-expired','disconnect']) {
    const start=(await calls()).length;
    task=await api(path,input(model));task=await terminal(task.id);
    assert.equal(task.status,'failed');assert.equal(task.stages.review.status,'pending');
    assert.equal((await calls()).length-start,1);assert.ok(task.stages.generation.error);
    // DSH does not commit assistant/message for an exceptional stream failure.
    // Transient deltas are not a durable artifact; do not invent a recovered draft.
    if(model==='disconnect')assert.equal(task.stages.generation.artifact,'');
    ids[model]=task.id;
    // Repeated failing retries cannot be replayed using the earlier session ID.
    if(model==='login-expired') {
      const first=task.stages.generation.sessionId;
      await retry(task,'generation');task=await terminal(task.id);
      assert.equal(task.status,'failed');assert.equal(task.stages.generation.attempts.length,1);
      assert.equal(await postStatus(path+'?id='+task.id+'&action=retry',{role:'generation',sessionId:first}),400);
      assert.ok((await calls()).slice(start).every(c=>c.provider==='workflow-local-a' && c.model===model));
    }
  }
  evidence.push('expired-login/stream-disconnect: explicit failed end, no fallback/review/automatic retry; uncommitted deltas are not artifacts');
  task=await api(path,input('local','disconnect'));task=await terminal(task.id);
  assert.equal(task.status,'failed');assert.equal(task.stages.generation.status,'completed');
  assert.ok(task.stages.generation.artifact);ids.reviewDisconnect=task.id;

  for(const model of ['wait','ignore-abort']) {
    const start=(await calls()).length;
    task=await api(path,input('local',model));
    await waitFor(calls,rows=>rows.slice(start).some(c=>c.model===model && c.waiting));
    const requested=await cancel(task.id);assert.equal(requested.status,'cancel-requested');
    assert.equal(await postStatus(path+'?id='+task.id+'&action=retry',{role:'review',sessionId:requested.stages.review.sessionId}),400);
    if(model==='ignore-abort') {
      assert.equal(await postStatus(path+'?id='+task.id,{choice:'accept',note:'too early'}),400);
      await waitFor(calls,rows=>rows.at(-1).aborted);
      const running=await get(task.id);assert.equal(running.status,'cancel-requested');
      assert.equal((await calls()).at(-1).cleaned,false);
      await cancel(task.id); // repeated cancellation neither runs nor confirms anything
      await api('/api/gateway-fixture-release',{});
    }
    task=await terminal(task.id);assert.equal(task.status,'stopped');
    assert.equal(task.stages.review.status,'stopped');assert.equal(task.stages.review.terminalReason,'aborted');
    assert.ok(task.stages.review.artifact);assert.equal((await calls()).length-start,2);
    ids[model]=task.id;
  }
  evidence.push('cooperative/delayed cancel: cancel-requested until actual idle/end; retained partial output; no queued replay');

  const extended=input();extended.review={connectionId:'local-extra',model:'example',reasoningEffort:''};
  task=await api(path,extended);task=await terminal(task.id);
  assert.equal(task.status,'awaiting-decision');assert.equal(task.stages.review.requestEvents[0].provider,'workflow-local-extension');
  assert.ok(task.stages.review.artifact.includes('本地扩展示例'));ids.extension=task.id;
  evidence.push('extra local adapter + configuration only; unchanged orchestration/runner; NOT a real third provider');

  // Kill the real child while local work is still running; restarting is query-only.
  const crashInput=input('local','ignore-abort');task=await api(path,crashInput);
  await waitFor(()=>get(task.id),t=>t.stages.review.status==='running');
  await waitFor(calls,rows=>rows.at(-1).model==='ignore-abort' && rows.at(-1).waiting);
  const savedDraft=(await get(task.id)).stages.generation;
  await cancel(task.id);ids.restart=task.id;
  const runningInput=input('ignore-abort');const runningTask=await api(path,runningInput);ids.runningRestart=runningTask.id;
  await waitFor(calls,rows=>rows.at(-1).model==='ignore-abort' && rows.at(-1).waiting);
  await restart();
  task=await get(task.id);assert.equal(task.status,'unknown');assert.equal(task.stages.review.status,'unknown');
  assert.deepEqual(task.stages.generation,savedDraft);assert.equal((await calls()).length,0);
  assert.equal(await postStatus(path+'?id='+task.id+'&action=retry',{role:'review',sessionId:task.stages.review.sessionId}),400);
  assert.equal((await api(path,crashInput)).id,task.id);assert.equal((await calls()).length,0);
  assert.equal((await api(path,value)).id,value.requestId);assert.equal((await calls()).length,0);
  const runningRestored=await get(runningTask.id);assert.equal(runningRestored.status,'unknown');
  assert.equal(runningRestored.stages.generation.status,'unknown');assert.equal(runningRestored.stages.review.status,'pending');
  assert.equal((await api(path,runningInput)).id,runningTask.id);assert.equal((await calls()).length,0);
  const restored=await get(ids.reviewRetry);assert.equal(restored.stages.review.attempts[0].sessionId,oldReview);
  assert.equal(restored.decisionHistory[0].choice,'defer');
  evidence.push('actual process restart: cancel-requested -> unknown, draft/attempts/decisions preserved, same-ID POST and reads = 0 new calls');
  console.log(JSON.stringify({result:'TASK04 PASS',realModelCalls:0,ids,evidence}));
}
