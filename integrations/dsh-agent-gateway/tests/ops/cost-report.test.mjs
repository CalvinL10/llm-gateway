import test from 'node:test';
import assert from 'node:assert/strict';
import {costReport} from '../../ops/cost-report.mjs';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const base = (id, callId, status = 'completed') => ({
  id, status, createdAt:'2026-09-20T01:00:00.000Z', endedAt:'2026-09-20T01:00:02.000Z',
  attempts:[{id:`${id}-attempt`, status, startedAt:'2026-09-20T01:00:00.000Z', endedAt:'2026-09-20T01:00:02.000Z'}],
  calls:[{id:callId, attemptId:`${id}-attempt`, admittedAt:'2026-09-20T01:00:01.000Z',
    outcome:status === 'completed' ? 'completed' : 'failed', usageStatus:'final',
    logicalRoute:{provider:'fixture', model:'model'},
    usage:{inputTokens:1_000_000, cacheReadTokens:500_000, cacheWriteTokens:0, outputTokens:2_000_000}}],
  tools:[]
});
const source = {kind:'synthetic', reference:'synthetic-cost-test', asOf:'2026-09-20T00:00:00.000Z'};
const price = {id:'fixture-price', provider:'fixture', model:'model', currency:'USD',
  validFrom:'2026-01-01T00:00:00.000Z', validUntil:'2027-01-01T00:00:00.000Z',
  perMillion:{inputTokens:'1', cacheReadTokens:'0.1', cacheWriteTokens:'0.1', outputTokens:'2'},
  reasoningTreatment:'included-in-output', mappingEvidence:'fixture adapter defines reasoning as output detail', source};
const completeAccounting = {
  mode:'synthetic', currency:'USD', batchId:'synthetic-batch', prices:[price],
  acceptances:[{taskId:'task-a', accepted:true, evidence:'independent-check-a'}, {taskId:'task-b', accepted:false, evidence:'independent-check-b'}],
  charges:[
    {entryId:'api-line', source, category:'api', amount:'4.5', currency:'USD', recordType:'line-item', scope:'batch'},
    {entryId:'subscription-line', source, category:'subscription', amount:'1.5', currency:'USD', recordType:'line-item', scope:'batch'},
    {entryId:'resource-line', source, category:'resource', amount:'2', currency:'USD', recordType:'line-item', scope:'batch'},
    {entryId:'human-line', source, category:'human', amount:'3', currency:'USD', recordType:'line-item', scope:'batch'},
  ],
  coverage:Object.fromEntries(['api','subscription','resource','human'].map(category => [category, {complete:true, reference:`coverage-${category}`, asOf:'2026-09-20T00:00:00.000Z'}])),
  subscriptionObservations:[
    {id:'sub-1', windowId:'five-hour', accountLabel:'current-account', unit:'used-percent', observedAt:'2026-09-20T01:00:00.000Z', used:20, limit:100, evidence:'account screenshot'},
    {id:'sub-2', windowId:'five-hour', accountLabel:'current-account', unit:'used-percent', observedAt:'2026-09-20T02:00:00.000Z', used:35, limit:100, evidence:'account screenshot'},
  ],
  labor:[{id:'review-1', activity:'review', taskId:'task-a', minutes:null, evidence:'manual minutes unavailable'}],
  resources:[{id:'runtime-1', unit:'node-ms', quantity:100, taskId:null, evidence:'local process timing'}]
};

test('cost report keeps actual spend separate from API equivalent estimates and avoids double counting', () => {
  const report = costReport({tasks:[base('task-a','call-a'), base('task-b','call-b','failed')]}, completeAccounting);
  assert.equal(report.mode, 'synthetic-not-real-spend');
  assert.equal(report.actual.total, '11');
  assert.equal(report.actual.perFinalAcceptedTask.amount, '11');
  assert.equal(report.apiEquivalent.total, '10.1');
  assert.equal(report.apiEquivalent.calls[0].components.inputTokens, '1');
  assert.equal(report.apiEquivalent.calls[0].components.cacheReadTokens, '0.05');
  assert.equal(report.apiEquivalent.calls[0].components.outputTokens, '4');
  assert.equal(report.apiEquivalent.calls[0].amount, '5.05');
  assert.equal(report.subscription.windows[0].observedDelta, 15);
  assert.equal(report.subscription.windows[0].taskAttributedDelta, null);
  assert.equal(report.labor.totalMinutes, null);
  assert.equal(report.longTail.actualCompleteTaskCosts.count, 0);
});

test('missing billing coverage and missing usage remain unknown, not zero or free', () => {
  const accounting = {mode:'synthetic', currency:'USD', acceptances:[{taskId:'task-a', accepted:false, evidence:'not accepted'}],
    prices:[price], coverage:{api:{complete:false, reference:'not available', asOf:'2026-09-20T00:00:00.000Z'}}};
  const task = base('task-a','call-a'); task.calls[0].usage = null; task.calls[0].usageStatus = 'missing';
  const report = costReport({tasks:[task]}, accounting);
  assert.equal(report.actual.knownSubtotal, '0');
  assert.equal(report.actual.total, null);
  assert.equal(report.actual.perFinalAcceptedTask.amount, null);
  assert.equal(report.apiEquivalent.total, null);
  assert.deepEqual(report.apiEquivalent.calls[0].reasons.sort(), ['missing-cacheReadTokens','missing-cacheWriteTokens','missing-inputTokens','missing-outputTokens','usage-not-final']);
});

test('conflicting duplicate charges are rejected instead of silently summed', () => {
  const accounting = {...completeAccounting, acceptances:[{taskId:'task-a', accepted:true, evidence:'accepted-a'}], charges:[
    {...completeAccounting.charges[0]}, {...completeAccounting.charges[0], amount:'9'}
  ]};
  assert.throws(() => costReport({tasks:[base('task-a','call-a')]}, accounting), /conflicting duplicate charge/);
});

test('zero accepted tasks do not produce a normal per-success cost', () => {
  const accounting = {...completeAccounting, acceptances:[{taskId:'task-a', accepted:false, evidence:'failed'}]};
  const report = costReport({tasks:[base('task-a','call-a')]}, accounting);
  assert.equal(report.finalAcceptance.accepted, 0);
  assert.equal(report.actual.perFinalAcceptedTask.amount, null);
  assert.equal(report.actual.perFinalAcceptedTask.reason, 'zero-final-acceptances');
});

test('duplicate rows and invoice summaries do not double bill; account-period subscription is not batch spend', () => {
  const accounting = structuredClone(completeAccounting);
  const charge = accounting.charges[0];
  accounting.charges.push({...charge}, {amount:charge.amount, ...charge});
  accounting.charges.push({...charge, entryId:'summary', recordType:'summary', amount:'11'});
  accounting.charges.push({...charge, entryId:'monthly', category:'subscription', scope:'account-period', amount:'200'});
  const a = base('task-a','call-a'), b = base('task-b','call-b','failed');
  a.calls.push(structuredClone(a.calls[0])); a.attempts.push(structuredClone(a.attempts[0]));
  const report = costReport({tasks:[a,a,b]}, accounting);
  assert.equal(report.actual.total, '11');
  assert.equal(report.actual.excludedFromBatch.length, 2);
  assert.equal(report.apiEquivalent.total, '10.1');
  assert.equal(report.tasks[0].admissions, 1);
  assert.equal(report.tasks[0].actualTotal, null);
  assert.equal(report.actual.unallocatedBatchSubtotal, '11');
  assert.equal(report.actual.summaryReconciliation[0].matches,true);
  accounting.charges.find(c=>c.entryId==='summary').amount='12';
  const incomplete=costReport({tasks:[a,b]},accounting);
  assert.equal(incomplete.actual.summaryReconciliation[0].matches,false);
  assert.equal(incomplete.actual.total,null);
  assert.equal(incomplete.actual.knownSubtotal,'11');
});

test('all attempts including failed repair, review and final accepted work reconcile to batch amortization and tails', () => {
  const a = base('task-a','call-a'), b = base('task-b','call-b','failed');
  a.attempts.unshift({id:'initial-failed',status:'failed'});
  a.calls.unshift({...structuredClone(a.calls[0]), id:'first-failure',attemptId:'initial-failed',outcome:'error',source:{kind:'auxiliary',purpose:'review'}});
  const accounting = structuredClone(completeAccounting);
  accounting.charges = [
    {...accounting.charges[0], entryId:'failure', taskId:'task-a',attemptId:'initial-failed',callId:'first-failure',amount:'2'},
    {...accounting.charges[0], entryId:'retry', taskId:'task-a',callId:'call-a',amount:'3'},
    {...accounting.charges[0], entryId:'unfinished', taskId:'task-b',attemptId:'task-b-attempt',amount:'7'},
  ];
  accounting.labor = [{id:'repair',activity:'repair',minutes:8,taskId:'task-a',evidence:'synthetic timer'},
    {id:'review',activity:'review',minutes:2,taskId:'task-b',evidence:'synthetic timer'}];
  accounting.laborComplete = true;
  const report = costReport({tasks:[a,b]}, accounting);
  assert.equal(report.actual.total, '12');
  assert.equal(report.actual.perFinalAcceptedTask.amount, '12');
  assert.deepEqual(report.tasks.map(t=>t.actualTotal), ['5','7']);
  assert.deepEqual(report.tasks[0].attempts.map(t=>t.actualTotal), ['2','3']);
  assert.equal(report.apiEquivalent.total, '15.15');
  assert.equal(report.apiEquivalent.calls[0].source.purpose, 'review');
  assert.equal(report.longTail.actualCompleteTaskCosts.max, '7');
  assert.equal(report.longTail.actualCompleteTaskCosts.p95, '7');
  assert.equal(report.labor.totalMinutes, 10);
});

test('decimal money is exact; division records its remainder; rates cannot silently round tiny charges to zero', () => {
  const accounting = structuredClone(completeAccounting);
  accounting.acceptances.push({taskId:'task-c',accepted:true,evidence:'check-c'});
  accounting.acceptances[1].accepted = true;
  accounting.charges = [{...accounting.charges[0],amount:'0.1'}, {...accounting.charges[1],amount:'0.2'},
    {...accounting.charges[2],amount:'0.7'}];
  const audit = {tasks:[base('task-a','call-a'),base('task-b','call-b'),base('task-c','call-c')]};
  const report = costReport(audit,accounting);
  assert.equal(report.actual.total,'1');
  assert.equal(report.actual.perFinalAcceptedTask.amount,'0.333333333333');
  assert.equal(report.actual.perFinalAcceptedTask.remainderPicoUnits,'1');
  accounting.prices[0].perMillion.inputTokens='0.0000001';
  assert.throws(()=>costReport(audit,accounting), /six decimal/);
});

test('cache and reasoning are disjoint/detail respectively; partial and missing semantics cannot claim complete estimates', () => {
  const a = base('task-a','call-a'), b = base('task-b','call-b');
  a.calls[0].usage.totalTokens = 3500000;
  a.calls[0].usage.reasoningTokens = 1000000;
  assert.equal(costReport({tasks:[a,b]},completeAccounting).apiEquivalent.total,'10.1');
  a.calls[0].usageStatus='partial';
  const report=costReport({tasks:[a,b]},completeAccounting);
  assert.equal(report.apiEquivalent.total,null);
  assert.equal(report.apiEquivalent.knownSubtotal,'10.1');
  assert.equal(report.tasks[1].apiEquivalentTotal,'5.05');
  const accounting=structuredClone(completeAccounting);
  delete accounting.prices[0].reasoningTreatment;
  assert.ok(costReport({tasks:[a,b]},accounting).apiEquivalent.calls[1].reasons.includes('unknown-reasoning-inclusion'));
  delete b.calls[0].usage.cacheReadTokens;
  assert.ok(costReport({tasks:[a,b]},completeAccounting).apiEquivalent.calls[1].reasons.includes('missing-cacheReadTokens'));
});

test('dated route-specific prices are bounded and synthetic prices cannot escape into actual report mode', () => {
  const a=base('task-a','call-a'), b=base('task-b','call-b');
  const accounting=structuredClone(completeAccounting);
  delete accounting.mode;
  assert.throws(()=>costReport({tasks:[a,b]},accounting), /dated official/);
  accounting.mode='synthetic';
  accounting.prices.push({...accounting.prices[0],id:'overlap'});
  assert.throws(()=>costReport({tasks:[a,b]},accounting), /ambiguous price/);
  accounting.prices.pop(); a.calls[0].admittedAt=price.validUntil;
  assert.equal(costReport({tasks:[a,b]},accounting).apiEquivalent.calls[0].amount,null);
  accounting.prices[0].source.asOf=null;
  assert.throws(()=>costReport({tasks:[a,b]},accounting), /dated official/);
});

test('legacy missing call detail, unknown acceptance, and zero-call tasks stay distinct', () => {
  const a=base('task-a','call-a'), b={id:'task-b',status:'completed',admissionCount:5,evidence:'historical record'};
  const accounting=structuredClone(completeAccounting);
  let report=costReport({tasks:[a,b]},accounting);
  assert.equal(report.apiEquivalent.total,null);
  assert.equal(report.tasks[0].apiEquivalentTotal,'5.05');
  assert.equal(report.tasks[1].apiEquivalentTotal,null);
  assert.deepEqual(report.tasks[1].attempts,[]);
  assert.equal(report.tasks[1].admissions,5);
  delete b.admissionCount;
  report=costReport({tasks:[a,b]},accounting);
  assert.equal(report.tasks[1].admissions,null);
  b.calls=[];
  report=costReport({tasks:[a,b]},accounting);
  assert.equal(report.tasks[1].apiEquivalentTotal,'0');
  accounting.acceptances.pop();
  assert.equal(costReport({tasks:[a,b]},accounting).actual.perFinalAcceptedTask.reason,'incomplete-acceptance-evidence');
  delete a.calls[0].attemptId;
  accounting.charges=[{...accounting.charges[0],taskId:'task-a',callId:'call-a',amount:'2'}];
  report=costReport({tasks:[a,b]},accounting);
  assert.equal(report.tasks[0].unallocatedAttemptActualSubtotal,'2');
  assert.equal(report.tasks[0].attempts[0].actualTotal,null);
});

test('malformed identities, conflicting calls, cross-attempt charges and currency mixing are rejected', () => {
  const audit={tasks:[base('task-a','call-a'),base('task-b','call-b')]};
  const changes=[
    [a=>delete a.charges[0].entryId, /entryId/],
    [a=>a.charges[0].currency='EUR', /currency/],
    [a=>Object.assign(a.charges[0],{taskId:'task-a',callId:'call-b'}), /call allocation/],
    [a=>Object.assign(a.charges[0],{taskId:'task-a',attemptId:'missing'}), /attempt allocation/],
    [a=>Object.assign(a.charges[0],{taskId:'task-a',scope:'account-period'}), /account-period/],
  ];
  for(const [change,pattern] of changes){const a=structuredClone(completeAccounting);change(a);assert.throws(()=>costReport(audit,a),pattern);}
  audit.tasks[0].calls.push({...audit.tasks[0].calls[0],outcome:'error'});
  assert.throws(()=>costReport(audit,completeAccounting), /conflicting duplicate call/);
});

test('subscription resets and changed limits are not subtracted or silently merged across windows', () => {
  const audit={tasks:[base('task-a','call-a'),base('task-b','call-b')]};
  const accounting=structuredClone(completeAccounting);
  accounting.subscriptionObservations[1].used=10;
  assert.equal(costReport(audit,accounting).subscription.windows[0].observedDelta,null);
  accounting.subscriptionObservations[1].windowId='next-window';
  const report=costReport(audit,accounting);
  assert.equal(report.subscription.windows.length,2);
  assert.ok(report.subscription.windows.every(w=>w.observedDelta===null && w.taskAttributedDelta===null));
});

test('accounting extensions do not leak arbitrary private fields into report projections', () => {
  const accounting=structuredClone(completeAccounting);
  for(const row of [...accounting.charges,...accounting.labor,...accounting.resources,...accounting.subscriptionObservations]) row.secret='PRIVATE_SENTINEL';
  const output=JSON.stringify(costReport({tasks:[base('task-a','call-a'),base('task-b','call-b')]},accounting));
  assert.ok(!output.includes('PRIVATE_SENTINEL'));
});

test('existing authorized P06 sample reconciles admissions and acceptance without fabricating charges or calls', async () => {
  const final=JSON.parse(await readFile(new URL('../fixtures/p06-current-sample.json',import.meta.url),'utf8')).finalCompletion;
  const audit={tasks:final.tasks.map(t=>({id:t.id,status:t.status,admissionCount:t.calls,evidence:'P06 current.json'}))};
  const accounting={acceptances:final.tasks.map(t=>({taskId:t.id,accepted:t.acceptedAfterRepair,evidence:'P06 current.json'}))};
  const report=costReport(audit,accounting);
  assert.equal(report.tasks.reduce((s,t)=>s+t.admissions,0),184);
  assert.equal(report.finalAcceptance.accepted,3);
  assert.equal(report.longTail.admissions.median,52);
  assert.equal(report.longTail.admissions.p95,94);
  assert.equal(report.actual.total,null);
  assert.equal(report.apiEquivalent.total,null);
  assert.equal(report.actual.perFinalAcceptedTask.amount,null);
  assert.equal(report.labor.totalMinutes,null);
});

test('CLI processes P07 audit and produces parseable JSON without new model calls', () => {
  const script=fileURLToPath(new URL('../../ops/cost-report.mjs',import.meta.url));
  const audit=fileURLToPath(new URL('../fixtures/p07-sample-audit.json',import.meta.url));
  const output=execFileSync(process.execPath,[script,audit],{encoding:'utf8'});
  const report=JSON.parse(output);
  assert.equal(report.tasks.length,2);
  assert.equal(report.apiEquivalent.calls.length,3);
  assert.equal(report.tasks[0].tools.summedOperationMilliseconds,250);
  assert.equal(report.actual.total,null);
});
