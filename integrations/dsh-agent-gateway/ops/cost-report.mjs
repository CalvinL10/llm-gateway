// Offline accounting projection. It never dispatches, retries, reads credentials, or changes a ledger.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const CATEGORIES = ['api', 'subscription', 'resource', 'human'];
const TOKENS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];
const SCALE = 1_000_000_000_000n;
const fail = (condition, message) => { if (!condition) throw new Error(message); };
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';
const nonNegative = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => nonEmpty(value) && Number.isFinite(Date.parse(value));

function amount(value) {
  fail(typeof value === 'string' && /^\d+(?:\.\d{1,12})?$/.test(value), 'amount must be a nonnegative decimal string');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
function printAmount(value) {
  const fraction = (value % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}
function unique(rows, identity, label) {
  const seen = new Map();
  for (const row of rows ?? []) {
    const key = identity(row);
    fail(nonEmpty(key), `${label} is missing an identity`);
    const previous = seen.get(key);
    if (previous && !isDeepStrictEqual(previous, row)) fail(false, `conflicting duplicate ${label}: ${key}`);
    seen.set(key, row);
  }
  return [...seen.values()];
}
function source(value, synthetic) {
  fail(value && ['official-price', 'user-bill', ...(synthetic ? ['synthetic'] : [])].includes(value.kind)
    && nonEmpty(value.reference) && iso(value.asOf), 'dated official source or user bill is required');
  return {kind:value.kind, reference:value.reference, asOf:value.asOf};
}
function divisor(value, accepted) {
  if (!accepted) return {amount:null, reason:'zero-final-acceptances'};
  if (value === null) return {amount:null, reason:'incomplete-cost-evidence'};
  const n = BigInt(accepted);
  return {amount:printAmount(value / n), remainderPicoUnits:(value % n).toString(), denominator:accepted,
    rounding:'truncate at 12 decimals; remainder retained'};
}
function duration(start, end) {
  if (!iso(start) || !iso(end) || Date.parse(end) < Date.parse(start)) return null;
  return Date.parse(end) - Date.parse(start);
}
function nearest(values, formatter = value => value) {
  if (!values.length) return {count:0, median:null, p95:null, max:null};
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return {count:sorted.length, median:formatter(sorted[Math.ceil(sorted.length * .5) - 1]),
    p95:formatter(sorted[Math.ceil(sorted.length * .95) - 1]), max:formatter(sorted.at(-1)), method:'nearest-rank'};
}

function estimate(call, prices) {
  const matches = prices.filter(price => price.provider === call.logicalRoute?.provider
    && price.model === call.logicalRoute?.model && iso(call.admittedAt)
    && Date.parse(call.admittedAt) >= Date.parse(price.validFrom)
    && Date.parse(call.admittedAt) < Date.parse(price.validUntil));
  fail(matches.length <= 1, `ambiguous price interval for call ${call.id}`);
  if (!matches.length) return {knownSubtotal:'0', amount:null, reasons:['no-dated-matching-price']};
  const price = matches[0], reasons = [], components = {};
  let subtotal = 0n;
  if (call.usageStatus !== 'final') reasons.push('usage-not-final');
  for (const field of TOKENS) {
    const tokens = call.usage?.[field], rate = price.perMillion?.[field];
    if (!nonNegative(tokens)) { reasons.push(`missing-${field}`); continue; }
    if (tokens !== 0 && rate === undefined) { reasons.push(`missing-rate-${field}`); continue; }
    const line = tokens === 0 ? 0n : BigInt(tokens) * amount(rate) / 1_000_000n;
    components[field] = printAmount(line); subtotal += line;
  }
  // totalTokens is an aggregate; reasoningTokens is a detail field and is never added again.
  if (price.reasoningTreatment !== 'included-in-output' || !nonEmpty(price.mappingEvidence)) reasons.push('unknown-reasoning-inclusion');
  return {knownSubtotal:printAmount(subtotal), amount:reasons.length ? null : printAmount(subtotal), components,
    reasons, priceId:price.id, priceSource:source(price.source, price.source.kind === 'synthetic'), mappingEvidence:price.mappingEvidence ?? null};
}

export function costReport(audit, accounting = {}) {
  fail(Array.isArray(audit?.tasks), 'audit.tasks must be an array');
  const synthetic = accounting.mode === 'synthetic';
  const currency = accounting.currency ?? 'USD';
  fail(/^[A-Z]{3}$/.test(currency), 'currency must be a three-letter code');
  const tasks = unique(audit.tasks, task => task.id, 'task');
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const attemptsByTask = new Map();
  const calls = [];
  for (const task of tasks) {
    if (task.admissionCount !== undefined) fail(nonNegative(task.admissionCount) && nonEmpty(task.evidence), 'historical admissions require nonnegative count and evidence');
    const attempts = unique(task.attempts, attempt => attempt.id, 'attempt');
    attemptsByTask.set(task.id, attempts);
    for (const call of unique(task.calls, call => call.id, 'call')) {
      fail(!calls.some(existing => existing.id === call.id), `call belongs to multiple tasks: ${call.id}`);
      if (call.attemptId) fail(attempts.some(attempt => attempt.id === call.attemptId), `unknown attempt for call ${call.id}`);
      calls.push({...call, taskId:task.id});
    }
    fail(task.admissionCount === undefined || task.admissionCount >= unique(task.calls, call => call.id, 'call').length, 'admission count is smaller than observed calls');
  }
  const checkAllocation = row => {
    if (row.taskId !== undefined && row.taskId !== null) fail(taskById.has(row.taskId), 'unknown task allocation');
    if (row.attemptId !== undefined && row.attemptId !== null) fail(attemptsByTask.get(row.taskId)?.some(attempt => attempt.id === row.attemptId), 'unknown attempt allocation');
    if (row.callId !== undefined && row.callId !== null) fail(calls.some(call => call.id === row.callId && call.taskId === row.taskId
      && (row.attemptId == null || call.attemptId === row.attemptId)), 'unknown or inconsistent call allocation');
  };
  const acceptances = unique(accounting.acceptances, row => row.taskId, 'acceptance');
  for (const row of acceptances) fail(taskById.has(row.taskId) && typeof row.accepted === 'boolean' && nonEmpty(row.evidence), 'acceptance needs task, decision, and evidence');
  const accepted = acceptances.filter(row => row.accepted).length;
  const perAccepted = value => accepted && acceptances.length !== tasks.length
    ? {amount:null, reason:'incomplete-acceptance-evidence'} : divisor(value, accepted);
  const prices = unique(accounting.prices, row => row.id, 'price').map(row => {
    fail(row.currency === currency && iso(row.validFrom) && iso(row.validUntil) && Date.parse(row.validUntil) > Date.parse(row.validFrom), 'invalid price interval');
    source(row.source, synthetic);
    fail(nonEmpty(row.provider) && nonEmpty(row.model) && row.perMillion, 'price needs route and perMillion rates');
    for (const field of TOKENS) if (row.perMillion?.[field] !== undefined) {
      amount(row.perMillion[field]);
      fail(/^\d+(?:\.\d{1,6})?$/.test(row.perMillion[field]), 'per-million rates support up to six decimal places');
    }
    return row;
  });
  const charges = unique(accounting.charges, row => JSON.stringify([row.source?.kind, row.source?.reference, row.entryId]), 'charge').map(row => {
    fail(nonEmpty(row.entryId), 'charge entryId is required');
    fail(CATEGORIES.includes(row.category) && row.currency === currency, 'invalid charge category or currency');
    fail(['line-item', 'summary'].includes(row.recordType) && ['batch', 'account-period'].includes(row.scope), 'invalid charge record type or scope');
    fail(row.source?.kind === 'user-bill' || (synthetic && row.source?.kind === 'synthetic'), 'actual charge needs bill evidence');
    source(row.source, synthetic); amount(row.amount); checkAllocation(row);
    fail(row.scope !== 'account-period' || row.taskId == null, 'account-period charges cannot be allocated to a task');
    return {entryId:row.entryId, source:source(row.source, synthetic), category:row.category, currency,
      amount:row.amount, recordType:row.recordType, scope:row.scope, taskId:row.taskId ?? null,
      attemptId:row.attemptId ?? null, callId:row.callId ?? null};
  });
  const lineItems = charges.filter(row => row.recordType === 'line-item' && row.scope === 'batch');
  // Invoice summaries are checks, never additional charges. A mismatch prevents a complete total.
  const summaryReconciliation = charges.filter(row => row.recordType === 'summary').map(row => {
    const items = charges.filter(item => item.recordType === 'line-item' && item.scope === row.scope
      && item.source.kind === row.source.kind && item.source.reference === row.source.reference);
    const sum = items.reduce((total, item) => total + amount(item.amount), 0n);
    return {entryId:row.entryId, scope:row.scope, source:row.source, declared:row.amount,
      lineItemSubtotal:printAmount(sum), matches:sum === amount(row.amount)};
  });
  const summariesMatch = summaryReconciliation.every(row => row.scope !== 'batch' || row.matches);
  const coverage = Object.fromEntries(CATEGORIES.map(category => {
    const row = accounting.coverage?.[category];
    return [category, summariesMatch && row?.complete === true && nonEmpty(row.reference) && iso(row.asOf)
      ? {complete:true, reference:row.reference, asOf:row.asOf} : {complete:false}];
  }));
  const buckets = Object.fromEntries(CATEGORIES.map(category => {
    const rows = lineItems.filter(row => row.category === category);
    const subtotal = rows.reduce((sum, row) => sum + amount(row.amount), 0n);
    return [category, {knownSubtotal:printAmount(subtotal), total:coverage[category].complete ? printAmount(subtotal) : null,
      lineItems:rows.length, coverage:coverage[category]}];
  }));
  const actualSubtotal = lineItems.reduce((sum, row) => sum + amount(row.amount), 0n);
  const actualComplete = CATEGORIES.every(category => coverage[category].complete);
  const pricedCalls = calls.map(call => ({callId:call.id, taskId:call.taskId, attemptId:call.attemptId ?? null,
    outcome:call.outcome ?? 'unknown', source:call.source ?? null, ...estimate(call, prices)}));
  const detailComplete = task => Array.isArray(task.calls) && (task.admissionCount === undefined
    || task.admissionCount === unique(task.calls, call => call.id, 'call').length);
  const admissionsComplete = tasks.every(detailComplete);
  const estimateComplete = admissionsComplete && pricedCalls.every(call => call.amount !== null);
  const estimateSubtotal = pricedCalls.reduce((sum, row) => sum + amount(row.knownSubtotal), 0n);
  const labor = unique(accounting.labor, row => row.id, 'labor').map(row => {
    checkAllocation(row); fail(['repair', 'review', 'business-intervention'].includes(row.activity) && nonEmpty(row.evidence)
      && (row.minutes === null || Number.isFinite(row.minutes) && row.minutes >= 0), 'labor needs evidence and minutes or null');
    return {id:row.id, taskId:row.taskId ?? null, attemptId:row.attemptId ?? null,
      activity:row.activity, minutes:row.minutes, evidence:row.evidence};
  });
  const resources = unique(accounting.resources, row => row.id, 'resource').map(row => {
    checkAllocation(row); fail(nonEmpty(row.unit) && nonEmpty(row.evidence) && (row.quantity === null || Number.isFinite(row.quantity) && row.quantity >= 0), 'resource needs evidence and quantity or null');
    return {id:row.id, taskId:row.taskId ?? null, unit:row.unit, quantity:row.quantity, evidence:row.evidence};
  });
  const observations = unique(accounting.subscriptionObservations, row => row.id, 'subscription observation').map(row => {
    fail(nonEmpty(row.windowId) && nonEmpty(row.accountLabel) && nonEmpty(row.unit) && nonEmpty(row.evidence) && iso(row.observedAt)
      && Number.isFinite(row.used) && row.used >= 0 && (row.limit === null || Number.isFinite(row.limit) && row.limit >= row.used), 'invalid subscription observation');
    return {id:row.id, accountLabel:row.accountLabel, windowId:row.windowId, unit:row.unit,
      observedAt:row.observedAt, used:row.used, limit:row.limit, evidence:row.evidence};
  });
  const groups = new Map();
  for (const row of observations) {
    const key = JSON.stringify([row.accountLabel, row.windowId, row.unit]);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
  }
  const windows = [...groups.values()].map(rows => {
    rows.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const first = rows[0], last = rows.at(-1);
    const monotonic = rows.length > 1 && rows.every((row, index) => !index || row.used >= rows[index - 1].used
      && row.limit === first.limit && Date.parse(row.observedAt) > Date.parse(rows[index - 1].observedAt));
    return {accountLabel:first.accountLabel, windowId:first.windowId, unit:first.unit,
      observedDelta:monotonic ? last.used - first.used : null, taskAttributedDelta:null,
      reason:monotonic ? 'shared-account-window-not-task-attribution' : 'insufficient-or-reset-window-evidence', observations:rows};
  });
  const taskRows = tasks.map(task => {
    const taskCalls = calls.filter(call => call.taskId === task.id);
    const taskCharges = lineItems.filter(row => row.taskId === task.id);
    const knownActual = taskCharges.reduce((sum, row) => sum + amount(row.amount), 0n);
    const taskEstimates = pricedCalls.filter(row => row.taskId === task.id);
    const knownEstimate = taskEstimates.reduce((sum, row) => sum + amount(row.knownSubtotal), 0n);
    const acceptedRow = acceptances.find(row => row.taskId === task.id);
    const completeTaskActual = actualComplete && lineItems.every(row => row.taskId != null);
    const completeTaskEstimate = detailComplete(task) && taskEstimates.every(row => row.amount !== null);
    const tools = unique(task.tools, row => JSON.stringify([row.sessionId, row.seq]), 'tool');
    const unallocatedTaskCharges = taskCharges.filter(row => row.attemptId == null
      && !taskCalls.find(call => call.id === row.callId)?.attemptId);
    const attemptRows = attemptsByTask.get(task.id).map(attempt => {
      const attemptCalls = taskCalls.filter(call => call.attemptId === attempt.id);
      const attemptCharges = taskCharges.filter(row => row.attemptId === attempt.id
        || (row.callId !== undefined && attemptCalls.some(call => call.id === row.callId)));
      const attemptEstimates = taskEstimates.filter(row => row.attemptId === attempt.id);
      return {attemptId:attempt.id, status:attempt.status, observedCalls:attemptCalls.length,
        actualKnownSubtotal:printAmount(attemptCharges.reduce((sum, row) => sum + amount(row.amount), 0n)),
        actualTotal:completeTaskActual && unallocatedTaskCharges.length === 0
          ? printAmount(attemptCharges.reduce((sum, row) => sum + amount(row.amount), 0n)) : null,
        apiEquivalentKnownSubtotal:printAmount(attemptEstimates.reduce((sum, row) => sum + amount(row.knownSubtotal), 0n)),
        apiEquivalentTotal:detailComplete(task) && taskCalls.every(call => call.attemptId)
          && attemptEstimates.every(row => row.amount !== null) ? printAmount(attemptEstimates.reduce((sum, row) => sum + amount(row.amount), 0n)) : null};
    });
    return {taskId:task.id, accepted:acceptedRow?.accepted ?? null, acceptanceEvidence:acceptedRow?.evidence ?? null,
      localStatus:task.status, admissions:task.admissionCount ?? (Array.isArray(task.calls) ? taskCalls.length : null), observedCallDetails:taskCalls.length,
      actualKnownSubtotal:printAmount(knownActual), actualTotal:completeTaskActual ? printAmount(knownActual) : null,
      apiEquivalentKnownSubtotal:printAmount(knownEstimate), apiEquivalentTotal:completeTaskEstimate ? printAmount(knownEstimate) : null,
      elapsedMilliseconds:duration(task.createdAt, task.endedAt), attempts:attemptRows,
      unallocatedAttemptActualSubtotal:printAmount(unallocatedTaskCharges.reduce((sum, row) => sum + amount(row.amount), 0n)),
      unallocatedAttemptCallCount:taskCalls.filter(call => !call.attemptId).length,
      tools:{count:tools.length, measuredDurationCount:tools.filter(tool => duration(tool.startedAt, tool.endedAt) !== null).length,
        summedOperationMilliseconds:tools.reduce((sum, tool) => sum + (duration(tool.startedAt, tool.endedAt) ?? 0), 0),
        basis:'observed operation durations; overlaps possible; not CPU or billed runtime'}};
  });
  return {batchId:accounting.batchId ?? null, mode:synthetic ? 'synthetic-not-real-spend' : 'evidence-only', currency,
    accountingBasis:'All attempts, failures, retries, auxiliary calls and interventions retained. Missing evidence is unknown, not free.',
    finalAcceptance:{accepted, unknown:tasks.length - acceptances.length, totalTasks:tasks.length},
    actual:{categories:buckets, knownSubtotal:printAmount(actualSubtotal), total:actualComplete ? printAmount(actualSubtotal) : null,
      perFinalAcceptedTask:perAccepted(actualComplete ? actualSubtotal : null), charges, summaryReconciliation,
      unallocatedBatchSubtotal:printAmount(lineItems.filter(row => row.taskId === null).reduce((sum, row) => sum + amount(row.amount), 0n)),
      excludedFromBatch:charges.filter(row => row.recordType === 'summary' || row.scope === 'account-period')},
    apiEquivalent:{knownSubtotal:printAmount(estimateSubtotal), total:estimateComplete ? printAmount(estimateSubtotal) : null,
      perFinalAcceptedTask:perAccepted(estimateComplete ? estimateSubtotal : null), calls:pricedCalls,
      basis:'scenario estimate only; never added to actual spend; internal HTTP retries remain unpriced'},
    subscription:{windows, taskDollarAttribution:null, basis:'account-period bills are not batch charges; admissions are not quota units'},
    labor:{records:labor, knownMinutes:labor.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
      totalMinutes:accounting.laborComplete === true && labor.every(row => row.minutes !== null) ? labor.reduce((sum, row) => sum + row.minutes, 0) : null},
    resources, tasks:taskRows,
    longTail:{admissions:nearest(taskRows.map(row => row.admissions).filter(value => value !== null)),
      actualCompleteTaskCosts:nearest(taskRows.filter(row => row.actualTotal !== null).map(row => amount(row.actualTotal)), printAmount),
      apiEquivalentCompleteTaskCosts:nearest(taskRows.filter(row => row.apiEquivalentTotal !== null).map(row => amount(row.apiEquivalentTotal)), printAmount)},
    limitations:['No provider HTTP inference from admissions.', 'Known subtotals are not complete totals.',
      'Completeness is caller-supplied evidence, not inferred from completed task state.',
      'Task cost tails exclude incomplete costs and include their coverage counts.',
      'No other client credentials are read.']};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    fail(process.argv.length >= 3 && process.argv.length <= 4, 'Usage: node cost-report.mjs AUDIT.json [ACCOUNTING.json]');
    const audit = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const accounting = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : {};
    process.stdout.write(`${JSON.stringify(costReport(audit, accounting), null, 2)}\n`);
  } catch (error) { process.stderr.write(`Cost report failed: ${error.message}\n`); process.exitCode = 1; }
}
