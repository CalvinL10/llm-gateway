// Daily task entry hosted inside the native conversation/approval UI.
(() => {
  const endpoint = '/api/gateway-agent-tasks';
  const storageKey = 'gateway-agent-task-entry-v1';
  const active = new Set(['queued', 'running', 'cancel-requested']);
  const labels = {
    queued: '已排队，尚未创建会话或调用模型', running: '正在执行', 'cancel-requested': '已请求取消，等待宿主确认',
    completed: '模型回合已结束（未经测试或业务验收）',
    limited: '调用限额已阻止继续', failed: '执行失败',
    stopped: '宿主已停止任务', unknown: '执行结果未知，禁止自动重放',
    reconciled: '未知状态已只读核对，可由用户显式继续'
  };
  const safeErrors = {
    TASK_NOT_FOUND: '没有找到该任务。', REQUEST_ID_CONFLICT: '请求身份与已保存内容冲突，请保留现场并检查任务。',
    WORKSPACE_NOT_AUTHORIZED: '所选工作区不在当前授权列表。', GATEWAY_DRAINING: '服务正在排空，暂不接收新任务。',
    CALL_LIMIT_NOT_AUTHORIZED: '所选调用限额未由当前部署明确授权。', MODEL_NOT_AUTHORIZED: '所选模型未由当前部署授权。',
    INVALID_SCHEDULING: '调度模式与子模型选择不一致。', SCHEDULING_UNAVAILABLE: '当前部署没有开放可配置的模型调度。',
    CONTINUATION_ID_CONFLICT: '继续请求身份与已保存内容冲突，请保留现场并检查原任务。',
    TASK_ALREADY_RUNNING: '任务已有正在执行的尝试；请等待其结束或先取消。',
    RECONCILIATION_REQUIRED: '该任务在重启后状态未知，必须先执行只读核对。',
    RECONCILE_NOT_REQUIRED: '该任务当前不需要核对；请选择继续或补充目标。',
    CONTINUATION_CALL_LIMIT_NOT_AUTHORIZED: '追加调用次数未由当前部署明确授权。',
    TASK_CALL_LIMIT: '任务已用完累计调用额度；继续需要选择明确授权的追加额度。',
    CALL_LIMIT_EXCEEDS_MAXIMUM: '追加后累计调用额度超过系统上限。',
    GATEWAY_CLOSING: '服务正在关闭，暂不接收新任务。', INVALID_INPUT: '目标或请求参数无效。',
    INPUT_TOO_LARGE: '目标内容超过允许长度。', JSON_REQUIRED: '请求格式无效。',
    STORAGE_UNAVAILABLE: '浏览器无法保存请求身份；为避免重复任务，提交已停用。',
    GATEWAY_ERROR: '宿主无法处理请求，请查看本地服务状态。'
  };

  function freshDraft(workspaceId = null, maxCalls = null, scheduling = null) {
    return {requestId: crypto.randomUUID(), goal: '', workspaceId, maxCalls, scheduling, pending: false};
  }
  function freshContinuation(taskId = null, kind = 'continue') {
    return {taskId, continuationId: crypto.randomUUID(), kind, instruction: '', additionalCalls: 0, pending: false};
  }
  function readState() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey));
      if (value?.draft?.requestId && typeof value.draft.goal === 'string') {
        if (!value.continuation?.continuationId || typeof value.continuation.instruction !== 'string')
          value.continuation = freshContinuation(value.selectedTaskId ?? null);
        return value;
      }
    } catch {}
    return {draft: freshDraft(), selectedTaskId: null, continuation: freshContinuation()};
  }
  function writeState(state) {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); return true; } catch { return false; }
  }

  function mount() {
    if (document.getElementById('gateway-task-entry')) return;
    const host = document.createElement('div'); host.id = 'gateway-task-entry';
    host.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:1000';
    document.body.append(host);
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>
      :host{font:14px/1.45 system-ui;color:#172c45}button,select,textarea{font:inherit}
      #open{padding:9px 14px;border:1px solid #8aa0b8;border-radius:9px;background:#fff;color:#17324d;box-shadow:0 3px 14px #16324d22}
      dialog{width:min(980px,94vw);height:min(820px,90vh);box-sizing:border-box;overflow:auto;color:#172c45;background:#f7f9fc;border:1px solid #aebdca;border-radius:12px;padding:20px}
      header,.row,.actions{display:flex;gap:12px;align-items:center}.row>*{min-width:0}header{justify-content:space-between}.grow{flex:1}
      h2,h3{margin:0 0 10px}section{background:#fff;border:1px solid #d7e0e8;border-radius:9px;padding:14px;margin:12px 0}
      label{display:block;font-weight:650;margin:8px 0 4px}textarea,select{box-sizing:border-box;width:100%;padding:8px;border:1px solid #9fb0bf;border-radius:7px;background:#fff;color:#172c45}
      textarea{min-height:76px;resize:vertical}button{padding:8px 12px;border:1px solid #839bb1;border-radius:7px;background:#eef4fa;color:#17324d;cursor:pointer}
      button.primary{background:#234e73;color:#fff;border-color:#234e73}button.danger{background:#fff3f0;color:#842c20;border-color:#ce8d84}button:disabled{opacity:.55;cursor:default}
      #status{padding:10px;border-left:5px solid #7995ad;background:#edf4fa}#status[data-tone="warning"]{border-color:#b78316;background:#fff8e6}#status[data-tone="danger"]{border-color:#b94a3d;background:#fff1ef}
      .muted{color:#546b80}.evidence{font:12px/1.45 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      ul{margin:6px 0;padding-left:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7fa;padding:10px;border-radius:6px;max-height:260px;overflow:auto}
      #error{color:#842c20;font-weight:650}.pill{display:inline-block;padding:2px 7px;border-radius:12px;background:#e8eef4;margin:2px 4px 2px 0}
      @media(max-width:700px){.grid{grid-template-columns:1fr}.row{align-items:stretch;flex-direction:column}}
    </style><button id="open">新目标与任务</button><dialog aria-labelledby="title"><header><h2 id="title">新目标与任务</h2><button id="close">关闭</button></header>
      <p class="muted">提交到当前受保护宿主。审批仍在原生会话中进行；此页面不会自动批准，也不会把一次批准复用于后续动作。</p>
      <section><h3>提交新目标</h3><label for="workspace">已授权工作区</label><select id="workspace"></select>
        <label for="call-limit">本任务累计调用上限</label><select id="call-limit"></select>
        <label for="root-model">主模型</label><select id="root-model"></select>
        <label for="schedule-mode">调度模式</label><select id="schedule-mode"><option value="single">单模型执行</option><option value="delegate">主模型自主委派</option></select>
        <label for="child-models">允许的子模型（委派模式）</label><select id="child-models" multiple size="4"></select>
        <label for="goal">简短目标</label><textarea id="goal" maxlength="24000" placeholder="例如：修复登录后列表为空的问题，并运行相关测试"></textarea>
        <div class="actions"><button id="submit" class="primary" disabled>提交目标</button><span id="request" class="muted evidence"></span></div>
        <div id="policy" class="muted"></div></section>
      <section><div class="row"><div class="grow"><label for="tasks">任务</label><select id="tasks"></select></div><button id="refresh">刷新</button><button id="open-native">在宿主会话查看</button><button id="cancel" class="danger">取消任务</button></div>
        <p id="status"></p><p id="boundary" class="muted"></p><p id="error" role="alert"></p></section>
      <section><h3>显式继续</h3><p class="muted">继续沿用原任务与宿主 Session，保留全部调用、失败和副作用证据。状态 unknown 时只能先做只读核对；旧的“允许一次”不会继承。</p>
        <div class="row"><div class="grow"><label for="continuation-kind">继续类型</label><select id="continuation-kind"></select></div><div class="grow"><label for="continuation-calls">追加模型调用</label><select id="continuation-calls"></select></div></div>
        <label for="continuation-instruction">本次说明或补充目标</label><textarea id="continuation-instruction" maxlength="24000" placeholder="说明要继续、补充或核对的内容"></textarea>
        <div class="actions"><button id="continue" class="primary" disabled>继续原任务</button><span id="continuation-request" class="muted evidence"></span></div></section>
      <section><h3>尝试与累计预算</h3><p id="budget"></p><div id="attempts"></div><div id="reconciliation"></div></section>
      <section><h3>审批与接管</h3><p id="workspace-scope"></p><div id="approvals"></div>
        <p class="muted">待审批时，打开原生会话并核对工具、理由、参数、工作区和影响后，由你选择“允许一次”或“拒绝”。取消任务会撤回等待中的审批，不会视为允许。</p>
        <p class="muted">接管前先取消并等待宿主确认停止，再在工作区查看 Git 差异和宿主工具证据。需要保留的变更由你自行暂存或提交；只撤销你选中的路径，系统不会自动回滚你的编辑。</p></section>
      <div class="grid"><section><h3>模型调用</h3><div id="calls"></div></section><section><h3>文件与命令证据</h3><div id="operations"></div></section></div>
      <section><h3>模型回合最终文本</h3><p class="muted">文本仅代表模型回合结束；测试证据与用户业务验收分别显示。</p><p id="result-ref" class="evidence"></p><pre id="result"></pre></section>
      <section><h3>验证与业务验收</h3><div id="validation"></div></section>
    </dialog>`;
    const $ = id => root.getElementById(id), dialog = root.querySelector('dialog');
    const state = readState();
    let storageReady = writeState(state);
    let timer, fetching = false, mutating = false, stickyError = '';
    let latest = {tasks: [], policy: null, workspaces: [], authorizedContinuationCallIncrements: []};

    const evidence = value => {
      const span = document.createElement('span'); span.className = 'evidence'; span.textContent = value; return span;
    };
    const list = (items, empty) => {
      const ul = document.createElement('ul');
      if (!items.length) { const li = document.createElement('li'); li.textContent = empty; ul.append(li); return ul; }
      for (const item of items) { const li = document.createElement('li'); li.append(item); ul.append(li); }
      return ul;
    };
    const routeKey = route => JSON.stringify([route.provider, route.model, route.reasoningEffort ?? null]);
    function routeLabel(route) { return route.provider + '/' + route.model + (route.reasoningEffort ? ' · ' + route.reasoningEffort : ''); }
    function selectedScheduling() {
      const root = latest.scheduling?.roots?.find(item => routeKey(item) === $('root-model').value);
      const children = [...$('child-models').selectedOptions].map(option => latest.scheduling?.children?.find(item => routeKey(item) === option.value)).filter(Boolean);
      return root ? {root, mode:$('schedule-mode').value, children} : null;
    }
    function saveDraft() {
      state.draft.goal = $('goal').value;
      state.draft.workspaceId = $('workspace').value || state.draft.workspaceId;
      state.draft.maxCalls = Number($('call-limit').value) || state.draft.maxCalls;
      state.draft.scheduling = selectedScheduling() ?? state.draft.scheduling;
      storageReady = writeState(state);
      if (!storageReady) setError(safeErrors.STORAGE_UNAVAILABLE);
      $('request').textContent = '请求身份 ' + state.draft.requestId + (state.draft.pending ? ' · 等待查询确认' : '');
    }
    async function decode(response) {
      let value = {};
      try { value = await response.json(); } catch {}
      if (response.ok) return value;
      const error = new Error(value.error ?? 'GATEWAY_ERROR'); error.code = value.error;
      error.httpStatus = response.status; throw error;
    }
    async function lookup(id) {
      try { return await decode(await fetch(endpoint + '?id=' + encodeURIComponent(id), {cache:'no-store'})); }
      catch (error) { if (error.code === 'TASK_NOT_FOUND') return null; throw error; }
    }
    function showError(error) {
      setError(error?.httpStatus === 401 ? '登录已失效；本地请求身份已保留，请重新登录后刷新。'
        : safeErrors[error?.code] ?? '网络响应未确认；本地请求身份已保留，请刷新或重新登录后查询。');
    }
    function setError(message) {
      stickyError = message; $('error').textContent = message;
    }
    function workspaceOptions(workspaces) {
      const selected = state.draft.workspaceId;
      $('workspace').replaceChildren();
      for (const workspace of workspaces) {
        const option = document.createElement('option'); option.value = workspace.id; option.textContent = workspace.label;
        $('workspace').append(option);
      }
      if (workspaces.some(item => item.id === selected)) $('workspace').value = selected;
      state.draft.workspaceId = $('workspace').value || null; storageReady = writeState(state);
      if (!storageReady) setError(safeErrors.STORAGE_UNAVAILABLE);
      $('goal').disabled = $('workspace').disabled = $('call-limit').disabled = !!state.draft.pending;
      $('submit').disabled = mutating || !!state.draft.pending || !state.draft.workspaceId || !storageReady;
    }
    function callLimitOptions(policy, authorizedTaskMaxCalls = []) {
      const allowed = authorizedTaskMaxCalls.length ? authorizedTaskMaxCalls : policy ? [policy.maxCalls] : [];
      const selected = Number(state.draft.maxCalls);
      $('call-limit').replaceChildren();
      for (const limit of allowed) {
        const option = document.createElement('option'); option.value = String(limit);
        option.textContent = limit + (limit === policy?.maxCalls ? '（默认）' : ''); $('call-limit').append(option);
      }
      $('call-limit').value = allowed.includes(selected) ? String(selected) : String(policy?.maxCalls ?? allowed[0] ?? '');
      state.draft.maxCalls = Number($('call-limit').value) || null;
    }
    function schedulingOptions(data) {
      const scheduling = data.scheduling;
      if (!scheduling) { $('root-model').replaceChildren(); $('child-models').replaceChildren(); return; }
      const current = state.draft.scheduling ?? scheduling.defaults?.scheduling;
      $('root-model').replaceChildren();
      for (const route of scheduling.roots ?? []) { const option = document.createElement('option'); option.value = routeKey(route); option.textContent = routeLabel(route); $('root-model').append(option); }
      if (current?.root && [...$('root-model').options].some(option => option.value === routeKey(current.root))) $('root-model').value = routeKey(current.root);
      $('schedule-mode').value = current?.mode === 'delegate' ? 'delegate' : 'single';
      $('child-models').replaceChildren();
      for (const route of scheduling.children ?? []) { const option = document.createElement('option'); option.value = routeKey(route); option.textContent = routeLabel(route); option.selected = !!current?.children?.some(item => routeKey(item) === routeKey(route)); $('child-models').append(option); }
      state.draft.scheduling = selectedScheduling() ?? current ?? null;
      const delegate = $('schedule-mode').value === 'delegate'; $('child-models').disabled = !delegate || !!state.draft.pending;
      $('root-model').disabled = $('schedule-mode').disabled = !!state.draft.pending;
    }
    function continuationKinds(task) {
      return task?.status === 'unknown' ? ['reconcile']
        : task && !active.has(task.status) ? ['continue','supplement'] : [];
    }
    function ensureContinuation(task) {
      const kinds = continuationKinds(task);
      if (!state.continuation || (!state.continuation.pending && state.continuation.taskId !== (task?.id ?? null)))
        state.continuation = freshContinuation(task?.id ?? null, kinds[0] ?? 'continue');
      if (!state.continuation.pending && kinds.length && !kinds.includes(state.continuation.kind))
        state.continuation.kind = kinds[0];
      return kinds;
    }
    function continuationOptions(task) {
      const kinds = ensureContinuation(task);
      const kindLabels = {continue:'继续原目标', supplement:'补充原目标', reconcile:'只读核对未知状态'};
      $('continuation-kind').replaceChildren();
      for (const kind of kinds) {
        const option = document.createElement('option'); option.value = kind; option.textContent = kindLabels[kind];
        $('continuation-kind').append(option);
      }
      if (kinds.includes(state.continuation.kind)) $('continuation-kind').value = state.continuation.kind;

      const increments = [0, ...(latest.authorizedContinuationCallIncrements ?? [])]
        .filter((value, index, values) => Number.isInteger(value) && value >= 0 && values.indexOf(value) === index);
      $('continuation-calls').replaceChildren();
      for (const increment of increments) {
        const option = document.createElement('option'); option.value = String(increment);
        option.textContent = increment === 0 ? '0（不增加）' : '+' + increment; $('continuation-calls').append(option);
      }
      $('continuation-calls').value = increments.includes(Number(state.continuation.additionalCalls))
        ? String(state.continuation.additionalCalls) : '0';
      state.continuation.additionalCalls = Number($('continuation-calls').value) || 0;
      $('continuation-instruction').value = state.continuation.instruction;
      const disabled = !task || !kinds.length || state.continuation.pending || mutating || !storageReady;
      $('continuation-kind').disabled = $('continuation-calls').disabled = $('continuation-instruction').disabled = disabled;
      $('continue').disabled = disabled;
      $('continuation-request').textContent = state.continuation.taskId
        ? '继续身份 ' + state.continuation.continuationId + (state.continuation.pending ? ' · 等待查询确认' : '') : '';
      storageReady = writeState(state);
      if (!storageReady) setError(safeErrors.STORAGE_UNAVAILABLE);
    }
    function saveContinuation() {
      const task = latest.tasks?.find(item => item.id === state.selectedTaskId);
      ensureContinuation(task);
      state.continuation.instruction = $('continuation-instruction').value;
      state.continuation.kind = $('continuation-kind').value || state.continuation.kind;
      state.continuation.additionalCalls = Number($('continuation-calls').value) || 0;
      storageReady = writeState(state);
      if (!storageReady) setError(safeErrors.STORAGE_UNAVAILABLE);
      $('continuation-request').textContent = '继续身份 ' + state.continuation.continuationId +
        (state.continuation.pending ? ' · 等待查询确认' : '');
    }
    function continuationAttempt(task, continuationId) {
      return task?.report?.attempts?.find(attempt => attempt.id === continuationId) ?? null;
    }
    function continuationMatches(attempt, value) {
      return !!attempt && attempt.kind === value.kind && attempt.additionalCalls === value.additionalCalls;
    }
    function resetContinuation(task) {
      const kinds = continuationKinds(task);
      state.continuation = freshContinuation(task?.id ?? null, kinds[0] ?? 'continue');
    }
    function renderPolicy(policy, capabilities, authorizedTaskMaxCalls) {
      if (!policy) { $('policy').textContent = ''; return; }
      const routes = policy.allowedRoutes.map(route => route.provider + '/' + route.model).join('、');
      const limits = (authorizedTaskMaxCalls?.length ? authorizedTaskMaxCalls : [policy.maxCalls]).join('、');
      $('policy').textContent = `服务端授权模型范围：${routes}；默认 ${policy.maxCalls} 次共享模型调用；可提交任务时单独选择主模型、委派模式、子模型和上限。命令执行${capabilities?.commandExecution === 'enabled' ? 'Docker 隔离执行器可用' : capabilities?.commandExecution === 'disabled' ? '不可用' : '状态未知'}。`;
    }
    function renderTask(task) {
      $('calls').replaceChildren(); $('operations').replaceChildren(); $('approvals').replaceChildren();
      $('attempts').replaceChildren(); $('reconciliation').replaceChildren();
      if (!task) {
        $('status').textContent = '尚无任务'; $('status').dataset.tone = '';
        $('boundary').textContent = ''; $('workspace-scope').textContent = ''; $('result-ref').textContent = ''; $('result').textContent = ''; $('validation').textContent = ''; $('budget').textContent = '';
        $('cancel').disabled = true; $('open-native').disabled = true; continuationOptions(null); return;
      }
      $('status').textContent = labels[task.status] ?? '未知状态';
      $('status').dataset.tone = ['limited','stopped','unknown','cancel-requested'].includes(task.status) ? 'warning'
        : task.status === 'failed' ? 'danger' : '';
      const report = task.report ?? {};
      const budget = report.budget ?? {};
      $('boundary').textContent = `累计调用：${budget.used ?? task.calls?.length ?? 0}/${budget.maxCalls ?? task.policy?.maxCalls ?? '未知'}；模型回合：${report.stopReason ?? '尚未结束'}；工具事件：${report.evidenceCoverage ?? '不可用'}；测试验证：${report.validation ?? '未建立'}；用户业务验收：${report.businessOutcome ?? '未记录'}。`;
      $('budget').textContent = `初始额度 ${budget.initialMaxCalls ?? '未知'}；显式追加 ${budget.addedCalls ?? 0}；累计上限 ${budget.maxCalls ?? task.policy?.maxCalls ?? '未知'}；已用 ${budget.used ?? task.calls?.length ?? 0}；剩余 ${budget.remaining ?? '未知'}；历史限额拒绝 ${budget.everLimitDenied ? '有' : '无'}。`;
      const workspace = latest.workspaces?.find(item => item.id === (task.workspaceId ?? latest.workspaces[0]?.id));
      $('workspace-scope').textContent = `授权工作区：${workspace?.label ?? '未知'}（${task.workspaceId ?? 'default'}）。审批只针对原生卡片中的当前动作；不会授权其他工作区或后续动作。`;
      const selected = task.policy?.scheduling;
      if (selected) $('boundary').textContent += ` 调度：${routeLabel(selected.root)} · ${selected.mode === 'delegate' ? '自主委派' : '单模型'}${selected.children?.length ? ' · 子模型 ' + selected.children.map(routeLabel).join('、') : ''}。`;
      $('cancel').disabled = !active.has(task.status) || mutating;
      $('open-native').disabled = false;
      continuationOptions(task);
      const approvalItems = (report.approvalOperations ?? []).map(value => evidence(
        `动作 ${value.name} · ${value.outcome}${value.attemptId ? ' · attempt ' + value.attemptId : ''} · ${value.sessionId}#seq:${value.seq}${value.decisionSeq === undefined ? '' : '→' + value.decisionSeq} · 影响：请求突破当前动作的既有权限；参数和理由仅在原生审批卡核对`));
      $('approvals').append(list(approvalItems, '当前没有审批请求。需要审批的动作必须逐次在原生会话决定。'));
      const callItems = (task.calls ?? []).map(call => {
        const node = document.createDocumentFragment();
        node.append(document.createTextNode(`${call.provider}/${call.model} · ${call.outcome}${call.attemptId ? ' · attempt ' + call.attemptId : ''} · `),
          evidence(`${call.sessionId}#call:${call.id}`)); return node;
      });
      $('calls').append(list(callItems, '尚无模型调用。'));
      const refs = [], operations = report.toolOperations ?? [
        ...(report.confirmedFileChanges ?? []), ...(report.commandOperations ?? []),
        ...(report.failedOperations ?? []), ...(report.unconfirmedOperations ?? [])];
      for (const value of operations) {
        const title = ['edit','write'].includes(value.name) ? '文件变更' : value.name === 'pwsh' ? '命令' : '工具';
        refs.push(evidence(`${title} · ${value.name} · ${value.outcome}${value.attemptId ? ' · attempt ' + value.attemptId : ''} · ${value.sessionId}#seq:${value.seq}${value.resultSeq === undefined ? '' : '→' + value.resultSeq}${value.exitCode === undefined ? '' : ' · exit ' + value.exitCode}${value.errorCode ? ' · ' + value.errorCode : ''}`));
      }
      $('operations').append(list(refs, '尚无文件或命令证据。所有差异需在上述宿主会话事件中核对。'));
      const attemptItems = (report.attempts ?? []).map(value => evidence(
        `${value.kind} · ${value.status} · ${value.id} · calls ${value.callStart}→${value.callEnd ?? '?'} · budget ${value.budgetBefore}→${value.budgetAfter}${value.failureCode ? ' · ' + value.failureCode : ''}${value.failureStage ? '@' + value.failureStage : ''}`));
      $('attempts').append(list(attemptItems, '尚无尝试记录。'));
      const reconciliations = (report.attempts ?? []).filter(value => value.reconciliationEvidence).map(value => {
        const pre = document.createElement('pre');
        pre.textContent = '只读核对 ' + value.id + '\n' + JSON.stringify(value.reconciliationEvidence, null, 2); return pre;
      });
      $('reconciliation').append(...reconciliations);
      $('result-ref').textContent = '宿主会话引用 ' + task.sessionId;
      $('result').textContent = task.artifact || '没有可显示的最终文本。部分成果仍保留在模型调用和工具证据中。';
      $('validation').textContent = `测试证据：${report.validation === 'not-established' ? '未建立，命令成功不能自动算测试通过。' : report.validation} 用户业务验收：${report.businessOutcome === 'unverified' ? '未验收。' : report.businessOutcome}`;
    }
    function render(data) {
      latest = data;
      if (state.draft.pending) {
        const pending = data.tasks?.find(task => task.id === state.draft.requestId);
        const matches = pending && pending.goal === state.draft.goal &&
          (pending.workspaceId ?? data.workspaces?.[0]?.id) === state.draft.workspaceId &&
          (state.draft.maxCalls == null ||
            (pending.report?.budget?.initialMaxCalls ?? pending.policy?.maxCalls) === state.draft.maxCalls);
        if (matches) {
          state.selectedTaskId = pending.id;
          state.draft = freshDraft(state.draft.workspaceId, state.draft.maxCalls);
          setError('已按原请求身份找回任务，没有重复提交。');
        } else if (pending) {
          state.draft = {...state.draft, requestId:crypto.randomUUID(), pending:false};
          setError(safeErrors.REQUEST_ID_CONFLICT);
        } else {
          state.draft.pending = false;
          setError('未找到该请求身份对应的任务，可以使用原请求身份重新提交。');
        }
      }
      if (state.continuation?.pending) {
        const pendingTask = data.tasks?.find(task => task.id === state.continuation.taskId);
        const attempt = continuationAttempt(pendingTask, state.continuation.continuationId);
        if (attempt && continuationMatches(attempt, state.continuation)) {
          state.selectedTaskId = pendingTask.id;
          resetContinuation(pendingTask);
          setError('已按原继续身份找回尝试，没有重复提交。');
        } else if (attempt) {
          resetContinuation(pendingTask);
          setError(safeErrors.CONTINUATION_ID_CONFLICT);
        } else if (!mutating) {
          state.continuation.pending = false;
          setError('未找到该继续身份对应的尝试，可以使用原继续身份安全重试。');
        }
      }
      callLimitOptions(data.policy, data.authorizedTaskMaxCalls); schedulingOptions(data); workspaceOptions(data.workspaces ?? []);
      renderPolicy(data.policy, data.capabilities, data.authorizedTaskMaxCalls);
      const previous = state.selectedTaskId ?? $('tasks').value;
      $('tasks').replaceChildren();
      for (const task of [...(data.tasks ?? [])].reverse()) {
        const option = document.createElement('option'); option.value = task.id;
        option.textContent = task.id + ' · ' + (labels[task.status] ?? '未知'); $('tasks').append(option);
      }
      if (data.tasks?.some(task => task.id === previous)) $('tasks').value = previous;
      state.selectedTaskId = $('tasks').value || null; storageReady = writeState(state);
      renderTask(data.tasks?.find(task => task.id === state.selectedTaskId));
      $('goal').value = state.draft.goal;
      $('request').textContent = '请求身份 ' + state.draft.requestId + (state.draft.pending ? ' · 等待查询确认' : '');
    }
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const data = await decode(await fetch(endpoint, {cache:'no-store'}));
        if (!stickyError) $('error').textContent = '';
        render(data);
      }
      catch (error) { showError(error); }
      finally { fetching = false; }
    }
    async function submit() {
      if (mutating) return;
      saveDraft(); const payload = {...state.draft, goal:state.draft.goal.trim()};
      if (!storageReady) return;
      if (!payload.goal) { $('error').textContent = '请输入目标。'; return; }
      payload.pending = undefined;
      state.draft = {...payload, pending:true}; storageReady = writeState(state);
      if (!storageReady) { showError({code:'STORAGE_UNAVAILABLE'}); return; }
      $('goal').disabled = $('workspace').disabled = true;
      mutating = true; stickyError = ''; $('submit').disabled = true; $('error').textContent = '';
      let task = null;
      try {
        try { task = await decode(await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})); }
        catch (postError) {
          if (postError.httpStatus && postError.httpStatus < 500) throw postError;
          task = await lookup(payload.requestId);
          if (!task) throw postError;
        }
        if (task.goal !== payload.goal || (task.workspaceId ?? payload.workspaceId) !== payload.workspaceId ||
          (task.report?.budget?.initialMaxCalls ?? task.policy?.maxCalls) !== payload.maxCalls ||
          JSON.stringify(task.policy?.scheduling ?? null) !== JSON.stringify(payload.scheduling ?? null)) {
          const conflict = new Error('REQUEST_ID_CONFLICT'); conflict.code = 'REQUEST_ID_CONFLICT'; conflict.httpStatus = 409;
          throw conflict;
        }
        state.selectedTaskId = task.id;
        state.draft = freshDraft(payload.workspaceId, payload.maxCalls, payload.scheduling); storageReady = writeState(state);
        await refresh();
      } catch (error) {
        if (error.httpStatus && error.httpStatus < 500) {
          state.draft = {...payload, requestId:crypto.randomUUID(), pending:false}; storageReady = writeState(state);
        }
        showError(error);
      }
      finally {
        mutating = false; $('goal').disabled = $('workspace').disabled = $('call-limit').disabled = !!state.draft.pending;
        $('submit').disabled = !!state.draft.pending || !state.draft.workspaceId || !storageReady;
        renderTask(latest.tasks?.find(item => item.id === state.selectedTaskId));
      }
    }
    async function continueTask() {
      const task = latest.tasks?.find(item => item.id === state.selectedTaskId);
      if (mutating || !task) return;
      saveContinuation();
      const payload = {continuationId:state.continuation.continuationId, kind:state.continuation.kind,
        instruction:state.continuation.instruction.trim(), additionalCalls:state.continuation.additionalCalls};
      if (!payload.instruction) { setError('请输入本次继续、补充或核对说明。'); return; }
      if (state.continuation.taskId !== task.id || !continuationKinds(task).includes(payload.kind)) {
        setError(task.status === 'unknown' ? safeErrors.RECONCILIATION_REQUIRED : safeErrors.TASK_ALREADY_RUNNING); return;
      }
      state.continuation = {...payload, taskId:task.id, pending:true}; storageReady = writeState(state);
      if (!storageReady) { showError({code:'STORAGE_UNAVAILABLE'}); return; }
      mutating = true; stickyError = ''; $('error').textContent = ''; continuationOptions(task);
      try {
        let result = null;
        try {
          result = await decode(await fetch(endpoint + '?id=' + encodeURIComponent(task.id) + '&action=continue',
            {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}));
        } catch (postError) {
          if (postError.httpStatus && postError.httpStatus < 500) throw postError;
          const recovered = await lookup(task.id);
          const recoveredAttempt = continuationAttempt(recovered, payload.continuationId);
          if (!recoveredAttempt) {
            state.continuation.pending = false; storageReady = writeState(state); throw postError;
          }
          result = recovered;
        }
        const attempt = continuationAttempt(result, payload.continuationId);
        if (!continuationMatches(attempt, payload)) {
          const conflict = new Error('CONTINUATION_ID_CONFLICT'); conflict.code = 'CONTINUATION_ID_CONFLICT'; conflict.httpStatus = 409;
          throw conflict;
        }
        state.selectedTaskId = result.id;
        resetContinuation(result); storageReady = writeState(state);
        setError('继续请求已由原任务接收；历史尝试和累计消费保持不变。');
        await refresh();
      } catch (error) {
        if (error.httpStatus && error.httpStatus < 500) {
          const continuationId = error.code === 'CONTINUATION_ID_CONFLICT' ? crypto.randomUUID() : payload.continuationId;
          state.continuation = {...payload, taskId:task.id, continuationId, pending:false}; storageReady = writeState(state);
        }
        showError(error);
      } finally {
        mutating = false;
        renderTask(latest.tasks?.find(item => item.id === state.selectedTaskId));
      }
    }
    const stopPolling = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const startPolling = () => {
      stopPolling();
      refresh();
      timer = setInterval(refresh, 1000);
    };
    // A released modal may emit its close event after navigation has already
    // restored it. Only stop polling while the dialog is actually closed.
    dialog.onclose = () => { if (!dialog.open) stopPolling(); };

    async function openNative() {
      const task = latest.tasks?.find(item => item.id === state.selectedTaskId);
      if (!task) return;
      const title = '目标任务 · ' + task.id.slice(0, 8);
      const find = () => [...document.querySelectorAll('[role="treeitem"]')]
        .find(item => item.textContent.includes(title));
      // The task API can recover before native navigation finishes rendering.
      // Wait only for this task; never open another session or submit again.
      let sidebarRequested = false;
      const waitForRow = async (openSidebar = false) => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const row = find();
          if (row) return row;
          if (openSidebar && !sidebarRequested) {
            const toggle = document.querySelector('button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]');
            if (toggle) { toggle.click(); sidebarRequested = true; }
          }
          await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        }
        return find();
      };
      let releasedDialog = false;
      const releaseDialog = () => {
        if (!dialog.open) return;
        dialog.close();
        releasedDialog = true;
      };
      const restoreDialog = () => {
        if (releasedDialog && !dialog.open) {
          dialog.showModal();
          startPolling();
        }
      };
      let row = find();
      if (!row) {
        // A modal makes the host navigation inert. Release it before clicking the
        // exact sidebar control, then keep matching only this task's native row.
        releaseDialog();
        // The gateway panel can recover before the native sidebar hydrates.
        // Wait for its exact control as well, clicking at most once.
        row = await waitForRow(true);
      }
      if (!row) {
        const label = latest.workspaces?.find(item => item.id === (task.workspaceId ?? latest.workspaces[0]?.id))?.label;
        [...document.querySelectorAll('[role="treeitem"]')].find(item => label && item.textContent.trim() === label)?.click();
        row = await waitForRow();
      }
      if (!row) {
        restoreDialog();
        $('error').textContent = '正确的宿主会话暂未出现在导航中，请刷新后重试；不要在其他会话处理审批。';
        return;
      }
      if (!releasedDialog) dialog.close();
      row.click();
    }
    async function cancel() {
      const id = state.selectedTaskId;
      if (mutating || !id) return;
      mutating = true; stickyError = ''; $('cancel').disabled = true; $('error').textContent = '';
      try {
        await decode(await fetch(endpoint + '?id=' + encodeURIComponent(id) + '&action=cancel',
          {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}));
        await refresh();
      } catch (error) { showError(error); }
      finally { mutating = false; }
    }
    $('open').onclick = () => { dialog.showModal(); startPolling(); };
    $('close').onclick = () => dialog.close();
    $('refresh').onclick = refresh; $('submit').onclick = submit; $('continue').onclick = continueTask;
    $('cancel').onclick = cancel; $('open-native').onclick = openNative;
    $('tasks').onchange = () => {
      const selected = $('tasks').value || null;
      if (state.continuation?.pending && selected !== state.continuation.taskId) {
        $('tasks').value = state.selectedTaskId ?? state.continuation.taskId;
        setError('继续请求仍在核对中；请先确认其 attempt 身份，不能切换任务后丢失请求身份。');
        return;
      }
      state.selectedTaskId = selected; storageReady = writeState(state);
      renderTask(latest.tasks.find(task => task.id === state.selectedTaskId));
    };
    $('goal').oninput = saveDraft; $('workspace').onchange = saveDraft; $('call-limit').onchange = saveDraft;
    for (const id of ['root-model','schedule-mode','child-models']) $(id).onchange = () => { saveDraft(); const value = selectedScheduling(); if (value) fetch(endpoint + '?action=preferences', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scheduling:value,maxCalls:Number($('call-limit').value)})}).catch(() => {}); schedulingOptions(latest); };
    $('continuation-instruction').oninput = saveContinuation; $('continuation-kind').onchange = saveContinuation;
    $('continuation-calls').onchange = saveContinuation;
    $('goal').value = state.draft.goal; $('request').textContent = '请求身份 ' + state.draft.requestId;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
