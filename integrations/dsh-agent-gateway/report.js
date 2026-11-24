// Reporting only: no model calls, command parsing, retries or scheduling decisions.
const names = new Set(['read', 'glob', 'grep', 'edit', 'write', 'pwsh', 'subagent', 'list_subagent_models']);
const errorCodes = new Set(['FS_SANDBOX_DENIED', 'FS_NOT_FOUND', 'FS_STALE_VERSION',
  'SEARCH_FAILED', 'SANDBOX_UNAVAILABLE', 'TOOL_ABORTED', 'TOOL_ABORTED_BEFORE_DISPATCH',
  'UNKNOWN_TOOL', 'INVALID_TOOL_OUTPUT']);
export const safeToolName = name => names.has(name) ? name : 'other';
export const safeToolError = code => errorCodes.has(code) ? code : 'TOOL_FAILED';
const approvalOutcomes = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens'];
const safePurposes = new Set(['compaction', 'session-title', 'planning', 'review']);

export const usageSemantics = Object.freeze({
  schema: 'dsh-provider-neutral-token-usage',
  inputTokens: 'uncached input only',
  cacheTokens: 'cacheReadTokens and cacheWriteTokens are disjoint from inputTokens',
  totalTokens: 'full-call provider aggregate when present; never add cache or reasoning fields to it',
  reasoningTokens: 'detail counter whose inclusion in outputTokens/totalTokens is adapter-specific unless separately evidenced',
  missing: 'unknown, not zero',
});

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of tokenFields) if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  return Object.keys(usage).length ? usage : null;
}

const safePurpose = value => value === null || value === undefined || value === ''
  ? null : safePurposes.has(value) ? value : 'custom';

function callSource(call) {
  const sessionRole = call.sessionRole ?? (call.parentSessionId ? 'child' : 'root');
  const purpose = safePurpose(call.auxiliaryPurpose ?? call.purpose ?? null);
  return {kind:call.source ?? (purpose ? 'auxiliary' : sessionRole), sessionRole, purpose};
}

function callAudit(call) {
  const hasCurrentBoundary = call.adapterBoundaryPreparedAt !== null && call.adapterBoundaryPreparedAt !== undefined;
  const hasLegacyBoundary = !hasCurrentBoundary && call.dispatchStartedAt !== null && call.dispatchStartedAt !== undefined;
  const adapterBoundaryPreparedAt = hasCurrentBoundary ? call.adapterBoundaryPreparedAt
    : hasLegacyBoundary ? call.dispatchStartedAt : null;
  const adapterBoundaryBasis = hasCurrentBoundary ? 'durable-preparation-immediately-before-next-invocation'
    : hasLegacyBoundary ? 'legacy-dispatch-field-projected-as-boundary-preparation' : 'not-prepared';
  const httpAttempts = call.httpAttempts ?? (adapterBoundaryPreparedAt === null
    ? {observability:'unknown',count:null,basis:'legacy-record'}
    : {observability:'unavailable',count:null,basis:'legacy-record'});
  return {id:call.id, measurementKind:call.measurementKind ?? 'llm-stream-admission',
    ...(call.attemptId ? {attemptId:call.attemptId} : {}),
    sessionId:call.sessionId, parentSessionId:call.parentSessionId ?? null,
    source:callSource(call), logicalRoute:{provider:call.provider, model:call.model,
      reasoningEffort:call.reasoningEffort ?? null},
    admittedAt:call.admittedAt, adapterBoundaryPreparedAt, adapterBoundaryBasis,
    firstResponseAt:call.firstResponseAt ?? null, firstResponseBasis:'first-adapter-chunk',
    endedAt:call.endedAt ?? null, outcome:call.outcome,
    httpAttempts:{observability:httpAttempts.observability, count:httpAttempts.count,
      basis:httpAttempts.basis}, usageStatus:call.usageStatus ?? (call.usage ? 'unknown' : 'missing'),
    usageFirstObservedAt:call.usageFirstObservedAt ?? call.usageObservedAt ?? null,
    usageObservedAt:call.usageObservedAt ?? null,
    usageObservationCount:call.usageObservationCount ?? (call.usage ? 1 : 0), usage:safeUsage(call.usage)};
}

function toolRef(op) {
  return {sessionId: op.sessionId, seq: op.seq, name: safeToolName(op.name),
    ...(op.attemptId ? {attemptId:op.attemptId} : {}), outcome: op.outcome,
    ...(op.turn !== undefined ? {turn:op.turn} : {}), ...(op.step !== undefined ? {step:op.step} : {}),
    ...(op.startedAt ? {startedAt:op.startedAt} : {}), ...(op.endedAt ? {endedAt:op.endedAt} : {}),
    ...(op.resultSeq !== undefined ? {resultSeq: op.resultSeq} : {}),
    ...(op.errorCode ? {errorCode: safeToolError(op.errorCode)} : {}),
    ...(op.exitCode !== undefined ? {exitCode: op.exitCode} : {})};
}

function approvalRef(op) {
  return {sessionId: op.sessionId, seq: op.seq, name: safeToolName(op.name),
    ...(op.attemptId ? {attemptId:op.attemptId} : {}), outcome: op.outcome,
    ...(op.askedAt ? {askedAt:op.askedAt} : {}), ...(op.decidedAt ? {decidedAt:op.decidedAt} : {}),
    ...(op.decisionSeq !== undefined ? {decisionSeq: op.decisionSeq} : {})};
}

const eventTime = event => {
  if (!Number.isFinite(event?.time)) return undefined;
  const date = new Date(event.time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

// Approval arguments and reasons remain in the native session.  The task page
// gets only enough audit metadata to locate the exact one-shot decision.
export function approvalEvent(sessionId, event, events) {
  if (event.type === 'approval/asked') return {sessionId, seq: event.seq,
    name: safeToolName(event.data.toolName), outcome: 'pending',
    ...(eventTime(event) ? {askedAt:eventTime(event)} : {})};
  if (event.type !== 'approval/decided') return null;
  const asked = events.find(e => e.type === 'approval/asked' && e.data.id === event.data.id && e.seq < event.seq);
  if (!asked) return null;
  return {sessionId, seq: asked.seq, name: safeToolName(asked.data.toolName), decisionSeq: event.seq,
    outcome: approvalOutcomes.has(event.data.outcome) ? event.data.outcome : 'unavailable',
    ...(eventTime(asked) ? {askedAt:eventTime(asked)} : {}),
    ...(eventTime(event) ? {decidedAt:eventTime(event)} : {})};
}

export function toolEvent(sessionId, event, events) {
  if (event.type === 'tool/call') return {sessionId, seq: event.seq,
    name: safeToolName(event.data.name), outcome: 'pending',
    ...(event.data.turn !== undefined ? {turn:event.data.turn} : {}),
    ...(event.data.step !== undefined ? {step:event.data.step} : {}),
    ...(eventTime(event) ? {startedAt:eventTime(event)} : {})};
  if (event.type !== 'tool/result') return null;
  const block = event.data.message?.content?.find(b => b.type === 'tool-result');
  const call = events.find(e => e.type === 'tool/call' &&
    event.sourceEventSeqs?.includes(e.seq) && e.data.callId === block?.toolCallId);
  if (!call || !block) return null;
  return {sessionId, seq: call.seq, name: safeToolName(call.data.name), resultSeq: event.seq,
    ...(call.data.turn !== undefined ? {turn:call.data.turn} : {}),
    ...(call.data.step !== undefined ? {step:call.data.step} : {}),
    ...(eventTime(call) ? {startedAt:eventTime(call)} : {}),
    ...(eventTime(event) ? {endedAt:eventTime(event)} : {}),
    // Native pwsh isError=false also covers non-zero exit. Its structured value
    // is available at tools/result, not in the persisted rendered text event.
    ...(block.isError === true ? {outcome: 'failed', errorCode: safeToolError(event.data.error?.code)}
      : block.isError === false && call.data.name !== 'pwsh' ? {outcome: 'succeeded'} : {})};
}

export function commandResult(value) {
  if (value?.kind !== 'foreground') return {outcome: 'unknown'};
  const exitCode = Number.isSafeInteger(value.exitCode) ? value.exitCode : null;
  const interrupted = value.aborted === true || value.timedOut === true || !!value.signal;
  const denied = value.sandbox?.denied === true || value.sandbox?.runnerFailed === true;
  return {outcome: interrupted || denied || (exitCode !== null && exitCode !== 0) ? 'failed'
    : exitCode === 0 ? 'succeeded' : 'unknown', exitCode,
    ...(interrupted ? {errorCode: 'COMMAND_INTERRUPTED'} : denied ? {errorCode: 'SANDBOX_UNAVAILABLE'}
      : exitCode !== null && exitCode !== 0 ? {errorCode: 'COMMAND_EXIT_NONZERO'} : {})};
}

export function finalAssistantText(events) {
  const end = events.findLast(e => e.type === 'turn/end');
  if (end?.data.reason?.kind !== 'completed') return null;
  const message = events.findLast(e => e.type === 'assistant/message' && e.seq < end.seq && e.data.turn === end.data.turn);
  const content = message?.data.message?.content ?? [];
  if (content.some(b => b.type === 'tool-call')) return null;
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n') || null;
}

const securityPathNames = new Set(['.git', '.hg', '.svn', '.local', '.ssh', '.aws', '.azure', '.kube',
  '.codex', '.agents', '.npmrc', '.netrc', '.pypirc', '.credentials', '.credentials.yaml',
  '.credentials.yml', 'credentials.json', 'id_rsa', 'id_ed25519']);
const isProtectedSegment = segment => securityPathNames.has(segment.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(segment) || /\.(?:pem|p12|pfx|key)$/i.test(segment);

export function classifyRepoPath(repoRelativePath) {
  if (typeof repoRelativePath !== 'string' || !repoRelativePath.trim()) return 'other';
  const normalized = repoRelativePath.replaceAll('\\', '/').replace(/^(?:\.\/|\/)+/, '');
  if (!normalized) return 'other';
  if (/(^|\/)(__tests__|tests?|specs?)\//i.test(normalized) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized) ||
      /_test\.(py|go|rs)$/i.test(normalized) ||
      /(^|\/)test_[^/]+\.py$/i.test(normalized)) return 'test';
  if (normalized.split('/').some(isProtectedSegment) ||
      /(^|\/)presets\//i.test(normalized) ||
      /(^|\/)\.(agents|claude|cursor)\//i.test(normalized) ||
      /(^|\/)(security|auth|rbac|policy|sandbox|guard|ledger|tools|permissions|rules)([._-][^/]*)?\.[a-z0-9]+$/i.test(normalized) ||
      /\.rules$/i.test(normalized)) return 'security';
  if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|tsconfig[^/]*\.json|cordis\.patch\.yml|AGENTS\.md|CLAUDE\.md|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/i.test(normalized) ||
      /(^|\/)\.github\//i.test(normalized) ||
      /\.(schema\.json|proto|graphql|gql)$/i.test(normalized) ||
      /(^|\/)openapi\.(json|ya?ml)$/i.test(normalized)) return 'contract';
  if (/(^|\/)docs\//i.test(normalized) || /\.(md|mdx|txt|rst)$/i.test(normalized)) return 'docs';
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|rb|php|sh|ps1|sql|yml|yaml|toml|json|html|css|scss)$/i.test(normalized)) return 'source';
  return 'other';
}

export function analyzeTestMetrics(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText) return {assertionCount: 0, skipCount: 0};
  const withoutBlocks = sourceText.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const activeLines = [];
  for (const rawLine of withoutBlocks.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|#(?![\[!]))/.test(rawLine)) continue;
    const stripped = rawLine
      .replace(/(?:^|\s)\/\/.*$/, '')
      .replace(/(?:^|\s)#(?![\[!]).*$/, '')
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
    if (stripped.trim()) activeLines.push(stripped);
  }
  const active = activeLines.join('\n');
  const countMatches = regex => {
    let count = 0;
    for (const _ of active.matchAll(regex)) count++;
    return count;
  };
  const assertionCount =
    countMatches(/\bassert(?:\.[a-zA-Z_]\w*)?\s*\(/g) +
    countMatches(/\bexpect\s*\(/g) +
    countMatches(/\b(?:t|require)\.(?:Error|Fatal|Fail|Equal|NoError|True|False)\w*\s*\(/g) +
    countMatches(/(?:^|[;:])[ \t]*assert(?!\s*(?:\(|\.[a-zA-Z_]|from\b))\s+[\w('"\[{!]/gm) +
    countMatches(/\bself\.assert[A-Z]\w*\s*\(/g) +
    countMatches(/\bpytest\.raises\s*\(/g) +
    countMatches(/\bassert(?:_eq|_ne)?!\s*\(/g);
  const skipCount =
    countMatches(/\b(?:test|it|describe)\.(?:skip|only|todo)\s*\(/g) +
    countMatches(/\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/g) +
    countMatches(/\{[^}]*\bskip\s*:\s*true\b[^}]*\}/g) +
    countMatches(/@pytest\.mark\.(?:skip|skipif|xfail)\b/g) +
    countMatches(/\bpytest\.skip\s*\(/g) +
    countMatches(/@unittest\.skip\w*\b/g) +
    countMatches(/\bt\.Skip(?:f|Now)?\s*\(/g) +
    countMatches(/#\[\s*ignore\b/g);
  return {assertionCount, skipCount};
}

export function extractTextClaims(finalText) {
  if (typeof finalText !== 'string' || !finalText.trim())
    return {hasFinalText: false, claimedTestsPassed: false, claimedFileChanged: false};
  let claimedTestsPassed = false, claimedFileChanged = false;
  for (const rawClause of finalText.split(/[\r\n!?;,，。！？；]+|\.(?=\s|$)|\s+\b(?:and|but|however|while|though)\b\s+/i)) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const negationCheck = clause.replace(/\b0\s+failed\b/gi, '');
    const negated = /\b(?:not|no|never|without|didn't|did\s+not|cannot|can't|unable\s+to|haven't|have\s+not|yet\s+to|skipped|unverified|not-established|failed|failing)\b/i.test(negationCheck) ||
      /(?:未运行|未执行|未测试|未经测试|未验证|没有运行|没有执行|没跑|无法运行|跳过测试|未通过|尚未|还没|不代表|不能自动算)/.test(negationCheck);
    const hypothetical = /\b(?:should|would|will|might|could|may|must|expected\s+to|supposed\s+to|going\s+to|plan\s+to|need\s+to|if|whether)\b/i.test(clause) ||
      /(?:应该|将会|预期|预计|可能|如果|是否|需要)/.test(clause);
    if (negated || hypothetical) continue;
    if (/\b(?:all\s+)?(?:unit\s+|integration\s+|regression\s+)?(?:tests?|test\s+suites?|checks?|specs?)\b[^,]{0,40}\b(?:passed|passing|pass|green|succeeded|0\s+failed)\b/i.test(clause) ||
        /\b(?:passed|verified)\b[^,]{0,30}\b(?:all\s+)?(?:unit\s+|integration\s+)?(?:tests?|test\s+suites?)\b/i.test(clause) ||
        /\b[1-9]\d*\/[1-9]\d*\s+(?:tests?\s+)?passed\b/i.test(clause) ||
        /(?:全部|所有|单元|回归|相关)?(?:测试|单测|用例)[^，,]{0,16}(?:全部|均已|都已|已)?(?:通过|全绿|成功)/.test(clause) ||
        /(?:已运行|跑通)[^，,]{0,12}(?:全部|所有|相关)?(?:测试|单测|回归)[^，,]{0,12}(?:通过|全绿|无报错)/.test(clause))
      claimedTestsPassed = true;
    if (/\b(?:i\s+|have\s+|we\s+)?(?:edited|modified|updated|patched|created|wrote|fixed)\b[^,]{0,40}(?:\b(?:files?|source|implementation|module|function)\b|[a-zA-Z0-9_./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|json|md|ya?ml))/i.test(clause) ||
        /(?:已|已经)?(?:修改|更新|编辑|写入|创建|修复)[^，,]{0,20}(?:文件|源码|代码|模块|函数|[a-zA-Z0-9_./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|json|md|ya?ml))/.test(clause))
      claimedFileChanged = true;
  }
  return {hasFinalText: true, claimedTestsPassed, claimedFileChanged};
}

const safeNonNegInt = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeCodeToken = (value, fallback = 'UNSPECIFIED') =>
  typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback;
const safeIsoTime = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? value : null;
const gitCoverageSet = new Set(['baseline-delta', 'git-unavailable', 'skipped-on-cancel', 'not-applicable']);
const gateLevelSet = new Set(['L1_AUTO_PASS', 'L2_AUTO_WARNING', 'L3_HUMAN_REQUIRED']);
const claimStatusSet = new Set(['consistent', 'unverified-edits', 'unverified-claim', 'mismatch']);
const findingCategorySet = new Set(['git-tamper', 'scope-boundary', 'claim-evidence', 'execution-state']);

function safeGitDeltaObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cat = raw.categories ?? {};
  const tamper = raw.testTamper ?? {};
  return {
    totalChangedFiles: safeNonNegInt(raw.totalChangedFiles),
    addedFiles: safeNonNegInt(raw.addedFiles),
    modifiedFiles: safeNonNegInt(raw.modifiedFiles),
    deletedFiles: safeNonNegInt(raw.deletedFiles),
    categories: {
      test: safeNonNegInt(cat.test),
      security: safeNonNegInt(cat.security),
      contract: safeNonNegInt(cat.contract),
      docs: safeNonNegInt(cat.docs),
      source: safeNonNegInt(cat.source),
      other: safeNonNegInt(cat.other),
    },
    testTamper: {
      modifiedTestFiles: safeNonNegInt(tamper.modifiedTestFiles),
      skipAddedFiles: safeNonNegInt(tamper.skipAddedFiles),
      assertionsReducedFiles: safeNonNegInt(tamper.assertionsReducedFiles),
    },
  };
}

function normalizeGitDelta(gitDelta) {
  if (!gitDelta || typeof gitDelta !== 'object' || Array.isArray(gitDelta)) return {
    coverage: 'not-applicable', reason: 'NO_SENSOR_SNAPSHOT',
    baselineDirtyEntries: null, headMoved: null, truncated: null, delta: null,
  };
  const coverage = gitCoverageSet.has(gitDelta.coverage) ? gitDelta.coverage : 'not-applicable';
  return {
    coverage,
    reason: gitDelta.reason == null ? null : safeCodeToken(gitDelta.reason, 'UNSPECIFIED'),
    baselineDirtyEntries: Number.isSafeInteger(gitDelta.baselineDirtyEntries) && gitDelta.baselineDirtyEntries >= 0
      ? gitDelta.baselineDirtyEntries : null,
    headMoved: typeof gitDelta.headMoved === 'boolean' ? gitDelta.headMoved : null,
    truncated: typeof gitDelta.truncated === 'boolean' ? gitDelta.truncated : null,
    delta: coverage === 'baseline-delta' ? safeGitDeltaObject(gitDelta.delta) : null,
  };
}

export function safePolicySensor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 'gateway-policy-sensor-v1')
    return null;
  if (!gateLevelSet.has(value.gateLevel) || !claimStatusSet.has(value.claimEvidenceStatus)) return null;
  const rawClaims = value.claims ?? {};
  const rawCounts = value.evidenceCounts ?? {};
  const findings = Array.isArray(value.findings) ? value.findings
    .filter(item => item && typeof item === 'object' && !Array.isArray(item) &&
      ['L2', 'L3'].includes(item.severity) && findingCategorySet.has(item.category))
    .map(item => ({
      code: safeCodeToken(item.code, 'UNSPECIFIED'),
      severity: item.severity,
      category: item.category,
      ...(Number.isSafeInteger(item.count) && item.count >= 0 ? {count: item.count} : {}),
    })) : [];
  return {
    schema: 'gateway-policy-sensor-v1',
    evaluatedAt: safeIsoTime(value.evaluatedAt),
    gateLevel: value.gateLevel,
    requiresHumanReview: Boolean(value.requiresHumanReview),
    claimEvidenceStatus: value.claimEvidenceStatus,
    claims: {
      hasFinalText: Boolean(rawClaims.hasFinalText),
      claimedTestsPassed: Boolean(rawClaims.claimedTestsPassed),
      claimedFileChanged: Boolean(rawClaims.claimedFileChanged),
    },
    evidenceCounts: {
      confirmedEdits: safeNonNegInt(rawCounts.confirmedEdits),
      succeededCommands: safeNonNegInt(rawCounts.succeededCommands),
      failedCommands: safeNonNegInt(rawCounts.failedCommands),
      unconfirmedCommands: safeNonNegInt(rawCounts.unconfirmedCommands),
      failedTools: safeNonNegInt(rawCounts.failedTools),
      unconfirmedTools: safeNonNegInt(rawCounts.unconfirmedTools),
    },
    git: normalizeGitDelta(value.git),
    findings,
  };
}

export function evaluatePolicySensor({task, attempt = null, status = null, gitDelta = null, finalText = null, evaluatedAt = null}) {
  const effectiveStatus = status ?? attempt?.status ?? task?.status ?? 'unknown';
  const allOps = task?.toolOperations ?? [];
  const scopedOps = attempt?.id
    ? allOps.filter(op => op.attemptId === attempt.id || (!op.attemptId && attempt.kind === 'initial'))
    : allOps;
  const confirmedEdits = scopedOps.filter(op => ['edit', 'write'].includes(op.name) && op.outcome === 'succeeded').length;
  const succeededCommands = scopedOps.filter(op => op.name === 'pwsh' && op.outcome === 'succeeded' && (op.exitCode === 0 || op.exitCode === undefined)).length;
  const failedCommands = scopedOps.filter(op => op.name === 'pwsh' && (op.outcome === 'failed' || (Number.isInteger(op.exitCode) && op.exitCode !== 0))).length;
  const unconfirmedCommands = scopedOps.filter(op => op.name === 'pwsh' && ['pending', 'unknown'].includes(op.outcome)).length;
  const failedTools = scopedOps.filter(op => op.outcome === 'failed').length;
  const unconfirmedTools = scopedOps.filter(op => ['pending', 'unknown'].includes(op.outcome)).length;
  const evidenceCounts = {confirmedEdits, succeededCommands, failedCommands, unconfirmedCommands, failedTools, unconfirmedTools};
  const git = normalizeGitDelta(gitDelta);
  const findings = [];

  if (git.coverage === 'baseline-delta' && git.delta) {
    if (git.headMoved === true) findings.push({code: 'GIT_HEAD_MOVED', severity: 'L3', category: 'git-tamper'});
    if (git.delta.categories.test > 0)
      findings.push({code: 'TEST_FILES_MODIFIED', severity: 'L3', category: 'git-tamper', count: git.delta.categories.test});
    if (git.delta.testTamper.skipAddedFiles > 0)
      findings.push({code: 'TEST_SKIP_OR_ONLY_ADDED', severity: 'L3', category: 'git-tamper', count: git.delta.testTamper.skipAddedFiles});
    if (git.delta.testTamper.assertionsReducedFiles > 0)
      findings.push({code: 'TEST_ASSERTIONS_REDUCED', severity: 'L3', category: 'git-tamper', count: git.delta.testTamper.assertionsReducedFiles});
    const protectedEdits = git.delta.categories.security + git.delta.categories.contract;
    if (protectedEdits > 0)
      findings.push({code: 'CONTRACT_OR_SECURITY_FILES_MODIFIED', severity: 'L3', category: 'scope-boundary', count: protectedEdits});
    if (git.truncated === true) findings.push({code: 'GIT_DIFF_TRUNCATED', severity: 'L2', category: 'scope-boundary'});
  }

  const claims = extractTextClaims(['completed', 'reconciled'].includes(effectiveStatus) ? finalText : null);
  if (claims.claimedTestsPassed) {
    if (failedCommands > 0 || unconfirmedCommands > 0)
      findings.push({code: 'CLAIM_TESTS_PASSED_DESPITE_COMMAND_FAILURE', severity: 'L3', category: 'claim-evidence',
        count: failedCommands + unconfirmedCommands});
    else if (succeededCommands === 0)
      findings.push({code: 'CLAIM_TESTS_PASSED_WITHOUT_COMMAND_EVIDENCE', severity: 'L3', category: 'claim-evidence'});
    else
      findings.push({code: 'CLAIM_TESTS_PASSED_UNSCOPED_COMMAND', severity: 'L2', category: 'claim-evidence', count: succeededCommands});
  }
  if (claims.claimedFileChanged && confirmedEdits === 0 && !(git.coverage === 'baseline-delta' && (git.delta?.totalChangedFiles ?? 0) > 0))
    findings.push({code: 'CLAIM_FILE_CHANGE_WITHOUT_WRITE_EVIDENCE', severity: 'L2', category: 'claim-evidence'});

  const totalChanged = Math.max(confirmedEdits, git.coverage === 'baseline-delta' ? (git.delta?.totalChangedFiles ?? 0) : 0);
  if (totalChanged > 0 && succeededCommands === 0)
    findings.push({code: 'UNVERIFIED_FILE_CHANGES', severity: 'L2', category: 'claim-evidence', count: totalChanged});

  if (['unknown', 'limited', 'failed'].includes(effectiveStatus))
    findings.push({code: 'ATTEMPT_NOT_CLEANLY_COMPLETED', severity: 'L3', category: 'execution-state'});
  if (unconfirmedTools > 0)
    findings.push({code: 'UNCONFIRMED_TOOL_OPERATIONS', severity: 'L3', category: 'execution-state', count: unconfirmedTools});
  if (failedTools > 0)
    findings.push({code: 'FAILED_TOOL_OPERATIONS', severity: 'L2', category: 'execution-state', count: failedTools});
  if (task?.policy?.toolSet === 'development' && attempt?.kind !== 'reconcile' &&
      git.coverage === 'git-unavailable' && confirmedEdits > 0)
    findings.push({code: 'GIT_SENSOR_UNAVAILABLE_WITH_EDITS', severity: 'L2', category: 'scope-boundary'});

  const hasL3 = findings.some(item => item.severity === 'L3');
  const hasL2 = findings.some(item => item.severity === 'L2');
  const gateLevel = hasL3 ? 'L3_HUMAN_REQUIRED' : hasL2 ? 'L2_AUTO_WARNING' : 'L1_AUTO_PASS';
  const hasMismatch = findings.some(item =>
    item.code === 'CLAIM_TESTS_PASSED_WITHOUT_COMMAND_EVIDENCE' ||
    item.code === 'CLAIM_TESTS_PASSED_DESPITE_COMMAND_FAILURE' ||
    item.code === 'CLAIM_FILE_CHANGE_WITHOUT_WRITE_EVIDENCE');
  const claimEvidenceStatus = hasMismatch ? 'mismatch'
    : findings.some(item => item.code === 'CLAIM_TESTS_PASSED_UNSCOPED_COMMAND') ? 'unverified-claim'
    : findings.some(item => item.code === 'UNVERIFIED_FILE_CHANGES') ? 'unverified-edits' : 'consistent';

  return {
    schema: 'gateway-policy-sensor-v1',
    evaluatedAt: safeIsoTime(evaluatedAt) ?? safeIsoTime(attempt?.endedAt) ?? safeIsoTime(task?.endedAt) ?? safeIsoTime(task?.createdAt) ?? null,
    gateLevel,
    requiresHumanReview: hasL3,
    claimEvidenceStatus,
    claims,
    evidenceCounts,
    git,
    findings,
  };
}

const isPersistenceUnconfirmed = lifecycle =>
  lifecycle?.state === 'ended-local' && lifecycle?.persistence === 'unconfirmed';

function resolvedPolicySensor(task, lifecycle) {
  const unconfirmed = isPersistenceUnconfirmed(lifecycle);
  const effectiveStatus = unconfirmed ? 'unknown' : task?.status;
  if (!task || ['queued', 'running', 'cancel-requested'].includes(effectiveStatus)) return null;
  const latestAttempt = (task.attempts ?? []).at(-1) ?? null;
  const persisted = safePolicySensor(latestAttempt?.policySensor);
  if (!unconfirmed && persisted && latestAttempt?.status === effectiveStatus) return persisted;
  return evaluatePolicySensor({
    task, attempt: latestAttempt, status: effectiveStatus,
    gitDelta: persisted?.git ?? null,
    finalText: ['completed', 'reconciled'].includes(effectiveStatus) ? task.artifact : null,
    evaluatedAt: latestAttempt?.endedAt ?? task.endedAt ?? task.createdAt ?? null,
  });
}

const parseTimeMs = value => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function buildTraceTree(task, lifecycle) {
  const attempts = task.attempts ?? [];
  const unconfirmed = isPersistenceUnconfirmed(lifecycle);
  const effectiveTaskStatus = unconfirmed ? 'unknown' : task.status;
  const attemptMap = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const taskSpanId = `task:${task.id}`;
  const spans = [{
    spanId: taskSpanId,
    parentSpanId: null,
    kind: 'task',
    name: 'gateway.task',
    startTime: task.createdAt ?? null,
    endTime: task.endedAt ?? null,
    status: effectiveTaskStatus,
    attributes: {
      workspaceId: task.workspaceId ?? 'default',
      sessionId: task.sessionId,
      lifecycleState: lifecycleReport(task, lifecycle).state,
    },
  }];
  let orphanSpans = 0;
  const resolveAttemptAnchor = attemptId => {
    if (attemptId && attemptMap.has(attemptId)) return {anchor: `attempt:${attemptId}`, attemptId, orphan: false};
    if (!attemptId && attempts[0]) return {anchor: `attempt:${attempts[0].id}`, attemptId: attempts[0].id, orphan: false};
    if (attemptId) orphanSpans++;
    return {anchor: taskSpanId, attemptId: null, orphan: !!attemptId};
  };

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const attemptStatus = unconfirmed && index === attempts.length - 1 ? 'unknown' : attempt.status;
    spans.push({
      spanId: `attempt:${attempt.id}`,
      parentSpanId: taskSpanId,
      kind: 'attempt',
      name: `gateway.attempt.${attempt.kind}`,
      startTime: attempt.startedAt ?? attempt.queuedAt ?? null,
      endTime: attempt.endedAt ?? null,
      status: attemptStatus,
      attributes: {
        kind: attempt.kind,
        callStart: attempt.callStart,
        callEnd: attempt.callEnd ?? null,
        additionalCalls: attempt.additionalCalls ?? 0,
        failureCode: attempt.failureCode ?? null,
        failureStage: attempt.failureStage ?? null,
      },
    });
  }

  const calls = task.calls ?? [];
  const tools = task.toolOperations ?? [];
  const approvals = task.approvalOperations ?? [];
  const denials = task.denials ?? [];
  const sameAttempt = (left, right) => !left || !right || left === right;

  for (const call of calls) {
    const audited = callAudit(call);
    const {anchor, attemptId, orphan} = resolveAttemptAnchor(call.attemptId);
    const callMs = parseTimeMs(call.admittedAt);
    let parentSpanId = anchor, lineageBasis = 'attempt';
    if (call.parentSessionId) {
      const subagentCandidates = tools.filter(op =>
        op.sessionId === call.parentSessionId && safeToolName(op.name) === 'subagent' &&
        sameAttempt(op.attemptId, attemptId) &&
        (!op.startedAt || callMs === null || (parseTimeMs(op.startedAt) !== null && parseTimeMs(op.startedAt) <= callMs)));
      const activeSubagents = subagentCandidates.filter(op =>
        op.outcome === 'pending' || !op.endedAt || callMs === null ||
        (parseTimeMs(op.endedAt) !== null && callMs <= parseTimeMs(op.endedAt)));
      const candidatePool = activeSubagents.length ? activeSubagents : subagentCandidates;
      if (candidatePool.length === 1) {
        parentSpanId = `tool:${candidatePool[0].sessionId}:${candidatePool[0].seq}`;
        lineageBasis = 'subagent-tool';
      } else {
        const parentCall = calls.findLast(candidate =>
          candidate.id !== call.id && candidate.sessionId === call.parentSessionId &&
          sameAttempt(candidate.attemptId, attemptId) &&
          (!candidate.admittedAt || callMs === null ||
            (parseTimeMs(candidate.admittedAt) !== null && parseTimeMs(candidate.admittedAt) <= callMs)));
        if (parentCall) {
          parentSpanId = `llm:${parentCall.id}`;
          lineageBasis = candidatePool.length > 1 ? 'concurrent-subagent-ambiguous' : 'parent-session-llm';
        } else {
          lineageBasis = candidatePool.length > 1 ? 'concurrent-subagent-ambiguous' : 'attempt-fallback';
        }
      }
    }
    spans.push({
      spanId: `llm:${call.id}`,
      parentSpanId,
      kind: 'llm',
      name: `gateway.llm.${audited.source.kind}`,
      startTime: audited.admittedAt ?? null,
      endTime: audited.endedAt ?? null,
      status: audited.outcome,
      attributes: {
        sessionId: audited.sessionId,
        parentSessionId: audited.parentSessionId,
        ...(audited.attemptId ? {attemptId: audited.attemptId} : {}),
        source: audited.source,
        logicalRoute: audited.logicalRoute,
        usageStatus: audited.usageStatus,
        usage: audited.usage,
        httpAttempts: audited.httpAttempts,
        lineageBasis,
        ...(orphan ? {orphan: true} : {}),
      },
    });
  }

  for (const op of tools) {
    const ref = toolRef(op);
    const {anchor, attemptId, orphan} = resolveAttemptAnchor(op.attemptId);
    const opMs = parseTimeMs(op.startedAt);
    const timedCall = calls.findLast(call =>
      call.sessionId === op.sessionId && sameAttempt(call.attemptId, attemptId) &&
      call.admittedAt && opMs !== null && parseTimeMs(call.admittedAt) !== null && parseTimeMs(call.admittedAt) <= opMs);
    const fallbackCall = timedCall ? null : calls.findLast(call =>
      call.sessionId === op.sessionId && sameAttempt(call.attemptId, attemptId));
    const parentCall = timedCall ?? fallbackCall;
    const parentSpanId = parentCall ? `llm:${parentCall.id}` : anchor;
    const lineageBasis = timedCall ? 'llm-call' : fallbackCall ? 'session-llm-fallback' : 'attempt-fallback';
    spans.push({
      spanId: `tool:${ref.sessionId}:${ref.seq}`,
      parentSpanId,
      kind: 'tool',
      name: `gateway.tool.${ref.name}`,
      startTime: ref.startedAt ?? null,
      endTime: ref.endedAt ?? null,
      status: ref.outcome,
      attributes: {...ref, lineageBasis, ...(orphan ? {orphan: true} : {})},
    });
  }

  for (const op of approvals) {
    const ref = approvalRef(op);
    const {anchor, attemptId, orphan} = resolveAttemptAnchor(op.attemptId);
    const matchedTool = tools.findLast(tool =>
      tool.sessionId === op.sessionId && sameAttempt(tool.attemptId, attemptId) &&
      safeToolName(tool.name) === ref.name && tool.seq <= op.seq);
    const parentSpanId = matchedTool ? `tool:${matchedTool.sessionId}:${matchedTool.seq}` : anchor;
    const lineageBasis = matchedTool ? 'tool-call' : 'attempt-fallback';
    spans.push({
      spanId: `approval:${ref.sessionId}:${ref.seq}`,
      parentSpanId,
      kind: 'approval',
      name: `gateway.approval.${ref.name}`,
      startTime: ref.askedAt ?? null,
      endTime: ref.decidedAt ?? null,
      status: ref.outcome,
      attributes: {...ref, lineageBasis, ...(orphan ? {orphan: true} : {})},
    });
  }

  for (let index = 0; index < denials.length; index++) {
    const denial = denials[index];
    const {anchor, orphan} = resolveAttemptAnchor(denial.attemptId);
    spans.push({
      spanId: `denial:${index}`,
      parentSpanId: anchor,
      kind: 'denial',
      name: `gateway.denial.${denial.code}`,
      startTime: denial.at ?? null,
      endTime: denial.at ?? null,
      status: 'denied',
      attributes: {
        sessionId: denial.sessionId,
        parentSessionId: denial.parentSessionId ?? null,
        ...(denial.attemptId ? {attemptId: denial.attemptId} : {}),
        logicalRoute: {provider: denial.provider, model: denial.model, reasoningEffort: denial.reasoningEffort ?? null},
        purpose: safePurpose(denial.purpose),
        code: denial.code,
        ...(orphan ? {orphan: true} : {}),
      },
    });
  }

  let sensorSpans = 0;
  const fallbackLatest = resolvedPolicySensor(task, lifecycle);
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const isLatest = index === attempts.length - 1;
    const sensor = isLatest && unconfirmed
      ? fallbackLatest
      : safePolicySensor(attempt.policySensor) ?? (isLatest ? fallbackLatest : null);
    if (!sensor) continue;
    sensorSpans++;
    spans.push({
      spanId: `sensor:${attempt.id}`,
      parentSpanId: `attempt:${attempt.id}`,
      kind: 'sensor',
      name: 'gateway.policy-sensor',
      startTime: sensor.evaluatedAt ?? null,
      endTime: sensor.evaluatedAt ?? null,
      status: sensor.gateLevel,
      attributes: {
        gateLevel: sensor.gateLevel,
        requiresHumanReview: sensor.requiresHumanReview,
        claimEvidenceStatus: sensor.claimEvidenceStatus,
        gitCoverage: sensor.git?.coverage ?? 'not-applicable',
        findingCodes: (sensor.findings ?? []).map(item => item.code),
      },
    });
  }
  if (!attempts.length && fallbackLatest) {
    sensorSpans++;
    spans.push({
      spanId: `sensor:${task.id}`,
      parentSpanId: taskSpanId,
      kind: 'sensor',
      name: 'gateway.policy-sensor',
      startTime: fallbackLatest.evaluatedAt ?? null,
      endTime: fallbackLatest.evaluatedAt ?? null,
      status: fallbackLatest.gateLevel,
      attributes: {
        gateLevel: fallbackLatest.gateLevel,
        requiresHumanReview: fallbackLatest.requiresHumanReview,
        claimEvidenceStatus: fallbackLatest.claimEvidenceStatus,
        gitCoverage: fallbackLatest.git?.coverage ?? 'not-applicable',
        findingCodes: (fallbackLatest.findings ?? []).map(item => item.code),
      },
    });
  }

  const parentById = new Map(spans.map(span => [span.spanId, span.parentSpanId]));
  let maxDepth = 0;
  for (const span of spans) {
    if (span.parentSpanId !== null && !parentById.has(span.parentSpanId)) orphanSpans++;
    let depth = 0, current = span.spanId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      depth++;
      current = parentById.get(current) ?? null;
    }
    if (depth > maxDepth) maxDepth = depth;
  }

  return {
    schema: 'gateway-otel-trace-v1',
    traceId: task.id,
    rootSpanId: taskSpanId,
    summary: {
      spanCount: spans.length,
      attemptSpans: attempts.length,
      llmSpans: calls.length,
      toolSpans: tools.length,
      approvalSpans: approvals.length,
      denialSpans: denials.length,
      sensorSpans,
      maxDepth,
      orphanSpans,
    },
    spans,
  };
}

function lifecycleReport(task, observation) {
  if (observation) return observation;
  const terminal = !['queued', 'running', 'cancel-requested'].includes(task.status);
  return {
    state: task.status === 'queued' ? 'queued'
      : task.status === 'running' ? 'executing'
      : task.status === 'cancel-requested' ? 'canceling'
      : task.status === 'unknown' && task.endedAt === null ? 'unknown-after-restart' : 'ended',
    localOutcome: terminal && task.endedAt !== null ? task.status : null,
    persistence: 'confirmed',
    stopConfirmation: task.status === 'stopped' ? 'confirmed' : task.status === 'unknown' ? 'unconfirmed' : null,
  };
}

export function taskReport(task, lifecycle) {
  const tools = task.toolOperations ?? [];
  const approvals = task.approvalOperations ?? [];
  const terminal = !['queued', 'running', 'cancel-requested'].includes(task.status);
  const attempts = task.attempts ?? [];
  const latestAttempt = attempts.at(-1);
  const limitDenied = task.denials.some(d => d.code === 'TASK_CALL_LIMIT' &&
    (!latestAttempt || d.attemptId === latestAttempt.id || (!d.attemptId && latestAttempt.kind === 'initial')));
  const usage = task.calls.map(call => ({status:call.usageStatus ?? (call.usage ? 'unknown' : 'missing'),
    value:safeUsage(call.usage)}));
  const tokenTotals = Object.fromEntries(tokenFields.map(field => {
    const reported = usage.filter(item => item.value?.[field] !== undefined);
    const final = reported.filter(item => item.status === 'final');
    const partial = reported.filter(item => item.status === 'partial');
    const unknown = reported.filter(item => item.status === 'unknown');
    return [field, {
      observedSum:reported.reduce((sum, item) => sum + item.value[field], 0),
      reportedCalls:reported.length,
      finalSum:final.reduce((sum, item) => sum + item.value[field], 0), finalReportedCalls:final.length,
      partialObservedSum:partial.reduce((sum, item) => sum + item.value[field], 0),
      partialReportedCalls:partial.length,
      unknownObservedSum:unknown.reduce((sum, item) => sum + item.value[field], 0),
      unknownReportedCalls:unknown.length,
    }];
  }));
  const latestSensor = resolvedPolicySensor(task, lifecycle);
  const unconfirmed = isPersistenceUnconfirmed(lifecycle);
  const http = task.calls.map(call => call.httpAttempts);
  return {
    executionStatus: task.status,
    lifecycle: lifecycleReport(task, lifecycle),
    stopReason: task.status === 'unknown' ? 'EXECUTION_UNCONFIRMED'
      : task.status === 'stopped' ? 'CANCELLED'
      : task.status === 'limited' ? 'TASK_CALL_LIMIT'
      : task.status === 'reconciled' ? 'STATE_RECONCILED'
      : task.status === 'completed' ? 'TURN_COMPLETED'
      : task.status === 'failed' ? 'EXECUTION_FAILED' : null,
    businessOutcome: 'unverified', validation: 'not-established',
    needsUserDecision: terminal,
    evidenceCoverage: task.toolOperations === undefined ? 'unavailable' : 'recorded-events',
    budget: {used: task.calls.length, maxCalls: task.policy.maxCalls,
      initialMaxCalls:attempts[0]?.budgetAfter ?? task.policy.maxCalls,
      addedCalls:attempts.reduce((total, attempt) => total + (attempt.additionalCalls ?? 0), 0),
      remaining: Math.max(0, task.policy.maxCalls - task.calls.length), limitDenied,
      everLimitDenied:task.denials.some(value => value.code === 'TASK_CALL_LIMIT')},
    attempts:attempts.map((attempt, index) => {
      const isLatestUnconfirmed = unconfirmed && index === attempts.length - 1;
      const attemptSensor = isLatestUnconfirmed ? latestSensor : safePolicySensor(attempt.policySensor);
      return {id:attempt.id, kind:attempt.kind, status:isLatestUnconfirmed ? 'unknown' : attempt.status,
        startedAt:attempt.startedAt, endedAt:attempt.endedAt, callStart:attempt.callStart, callEnd:attempt.callEnd,
        additionalCalls:attempt.additionalCalls, budgetBefore:attempt.budgetBefore, budgetAfter:attempt.budgetAfter,
        failureCode:attempt.failureCode, failureStage:attempt.failureStage,
        artifact:isLatestUnconfirmed ? null : attempt.artifact,
        ...(attempt.reconciliationEvidence ? {reconciliationEvidence:attempt.reconciliationEvidence} : {}),
        ...(attemptSensor ? {policySensor:attemptSensor} : {})};
    }),
    policySensor: latestSensor,
    traceSummary: buildTraceTree(task, lifecycle).summary,
    modelCalls: task.calls.reduce((counts, call) => {
      const key = ['stop', 'tool-calls'].includes(call.outcome) ? 'returned'
        : ['error', 'aborted'].includes(call.outcome) ? 'failedOrAborted' : 'unconfirmed';
      counts[key]++; return counts;
    }, {returned: 0, failedOrAborted: 0, unconfirmed: 0}),
    observations:{admissions:task.calls.length,
      adapterBoundaryPreparations:task.calls.filter(call => call.adapterBoundaryPreparedAt ?? call.dispatchStartedAt).length,
      firstResponses:task.calls.filter(call => call.firstResponseAt).length,
      sources:{root:task.calls.filter(call => callSource(call).kind === 'root').length,
        child:task.calls.filter(call => callSource(call).kind === 'child').length,
        auxiliary:task.calls.filter(call => callSource(call).kind === 'auxiliary').length},
      sessionRoles:{root:task.calls.filter(call => callSource(call).sessionRole === 'root').length,
        child:task.calls.filter(call => callSource(call).sessionRole === 'child').length},
      httpAttempts:{observed:http.filter(value => value?.observability === 'observed')
        .reduce((sum, value) => sum + (value.count ?? 0), 0),
        knownZeroBeforeBoundaryPreparation:http.filter(value => value?.observability === 'bounded' && value.count === 0).length,
        unobservableCalls:http.filter(value => value?.observability === 'unavailable').length,
        unknownLegacyCalls:http.filter(value => !value || value.observability === 'unknown').length},
      usage:{final:usage.filter(item => item.status === 'final').length,
        partial:usage.filter(item => item.status === 'partial').length,
        missing:usage.filter(item => item.status === 'missing').length,
        unknown:usage.filter(item => item.status === 'unknown').length,
        tokenTotals, semantics:usageSemantics}},
    approvalOperations: approvals.map(approvalRef),
    approvalCounts: {pending: approvals.filter(value => value.outcome === 'pending').length,
      allowedOnce: approvals.filter(value => value.outcome === 'allowed-once').length,
      rejected: approvals.filter(value => value.outcome === 'rejected').length,
      cancelledOrUnavailable: approvals.filter(value => ['cancelled','unavailable'].includes(value.outcome)).length},
    toolOperations: tools.map(toolRef),
    confirmedFileChanges: tools.filter(t => ['edit', 'write'].includes(t.name) && t.outcome === 'succeeded').map(toolRef),
    failedOperations: tools.filter(t => t.outcome === 'failed').map(toolRef),
    unconfirmedOperations: tools.filter(t => ['pending', 'unknown'].includes(t.outcome)).map(toolRef),
    commandOperations: tools.filter(t => t.name === 'pwsh').map(toolRef),
    toolCounts: {succeeded: tools.filter(t => t.outcome === 'succeeded').length,
      failed: tools.filter(t => t.outcome === 'failed').length,
      unconfirmed: tools.filter(t => ['pending', 'unknown'].includes(t.outcome)).length}
  };
}

export function auditTask(task, lifecycle) {
  const attempts = task.attempts ?? [];
  const unconfirmed = isPersistenceUnconfirmed(lifecycle);
  const effectiveStatus = unconfirmed ? 'unknown' : task.status;
  const latestSensor = resolvedPolicySensor(task, lifecycle);
  return {id:task.id, sessionId:task.sessionId, workspaceId:task.workspaceId ?? 'default',
    status:effectiveStatus, createdAt:task.createdAt, endedAt:task.endedAt ?? null,
    failureCode:task.failureCode ?? null, failureStage:task.failureStage ?? null,
    lifecycle:lifecycleReport(task, lifecycle),
    attempts:attempts.map((attempt, index) => {
      const isLatestUnconfirmed = unconfirmed && index === attempts.length - 1;
      const attemptSensor = isLatestUnconfirmed ? latestSensor : safePolicySensor(attempt.policySensor);
      return {id:attempt.id, kind:attempt.kind, status:isLatestUnconfirmed ? 'unknown' : attempt.status,
        startedAt:attempt.startedAt, endedAt:attempt.endedAt, callStart:attempt.callStart, callEnd:attempt.callEnd,
        failureCode:attempt.failureCode, failureStage:attempt.failureStage,
        ...(attemptSensor ? {policySensor:attemptSensor} : {})};
    }),
    policySensor: latestSensor,
    trace: buildTraceTree(task, lifecycle),
    calls:task.calls.map(callAudit),
    denials:task.denials.map(denial => ({...(denial.attemptId ? {attemptId:denial.attemptId} : {}),
      sessionId:denial.sessionId, parentSessionId:denial.parentSessionId ?? null,
      logicalRoute:{provider:denial.provider, model:denial.model, reasoningEffort:denial.reasoningEffort ?? null},
      purpose:safePurpose(denial.purpose), code:denial.code, at:denial.at})),
    tools:(task.toolOperations ?? []).map(toolRef), approvals:(task.approvalOperations ?? []).map(approvalRef)};
}

export function auditExport(tasks, lifecycles = new Map()) {
  return {format:'gateway-agent-audit-v1', usageSemantics,
    tasks:tasks.map(task => auditTask(task, lifecycles.get(task.id)))};
}

export function publicTask(task, lifecycle) {
  if (!task) return null;
  const status = lifecycle?.state === 'ended-local' && lifecycle.persistence === 'unconfirmed' ? 'unknown'
    : lifecycle?.state === 'canceling' && task.status === 'running' ? 'cancel-requested' : task.status;
  const view = status === task.status ? task : {...task, status};
  // Attempt instructions are user/model input and stay in the durable ledger;
  // expose only the redacted report projection to the task page/API.
  const {attempts: _attempts, ...publicView} = view;
  // Legacy limited records may contain concatenated intermediate claims.
  return {...publicView, calls:view.calls.map(call => {
    const purpose = safePurpose(call.auxiliaryPurpose ?? call.purpose ?? null);
    return {...call, purpose,
      ...(call.auxiliaryPurpose !== undefined ? {auxiliaryPurpose:purpose} : {}), usage:safeUsage(call.usage)};
  }), denials:view.denials.map(denial => ({...denial, purpose:safePurpose(denial.purpose)})),
    artifact: ['completed','reconciled'].includes(status) ? view.artifact : null,
    report: taskReport(view, lifecycle)};
}
