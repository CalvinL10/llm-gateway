(() => {
  function mount() {
    if (document.getElementById('gateway-workflows')) return;
    const host = document.createElement('div');
    host.id = 'gateway-workflows';
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:1000';
    document.body.append(host);
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>
      *{box-sizing:border-box}button,select,input,textarea{font:inherit}button{cursor:pointer;padding:8px 14px;border:1px solid #bac5d1;border-radius:6px;background:#fff;color:#12243b}button:disabled{opacity:.5}
      .launch{background:#172c45;color:#fff}dialog{width:min(1120px,95vw);max-height:92vh;border:1px solid #bac5d1;border-radius:12px;padding:22px;background:#f8fafc;color:#172c45;font:14px/1.5 system-ui}dialog::backdrop{background:#101e3099}
      h2{margin:0}header{display:flex;justify-content:space-between;align-items:center}label{display:block;margin:12px 0 5px}textarea{display:block;width:100%;min-height:84px;padding:9px;white-space:pre;font:13px/1.5 monospace}select,input{padding:7px;max-width:100%}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.muted{color:#50647a}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:14px;background:white;border:1px solid #d9e1e9;max-height:48vh;overflow:auto}.error{color:#b42318}.actions{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}details{margin:12px 0}small{display:block;overflow-wrap:anywhere}@media(max-width:720px){.grid{grid-template-columns:1fr}}
    </style><button class="launch">生成与审阅</button><dialog><header><h2>生成 → 独立审阅 → 人工决定</h2><button id="close">关闭</button></header>
      <p class="muted">仅使用你输入的文本。每个阶段使用独立会话；不会执行生成方案。连接使用 DSH 中当前已登录的账号，请在订阅设置核对账号。</p>
      <label>已有流程 <select id="tasks"><option value="">选择流程</option></select></label>
      <details id="new" open><summary>新建流程</summary><form id="form">
      <label>问题<textarea id="question" required maxlength="8000"></textarea></label>
      <div id="materials"><label>材料 1<textarea class="material" maxlength="16000"></textarea></label></div><button type="button" id="add">添加下一份文本材料</button>
      <label>约束<textarea id="constraints" maxlength="8000"></textarea></label><div class="grid" id="selections"></div>
      <div class="actions"><button id="submit">开始生成并审阅</button></div></form></details>
      <p id="error" role="alert" class="error"></p><section id="result" hidden><p id="status"></p>
      <div class="actions"><button id="cancel">请求取消</button><button id="retry-generation">仅重试失败的生成阶段</button><button id="retry-review">仅重试失败的审阅阶段</button></div>
      <p class="muted">取消请求不等于停止：等待本地回合结束；远端计算及计费停止仍未知。未知状态不自动重放。重试保持原连接/模型，请先在宿主核对当前账号。</p>
      <div class="grid"><article><h3>生成方案</h3><small id="generation-meta"></small><pre id="generation"></pre></article><article><h3>独立审阅</h3><small id="review-meta"></small><pre id="review"></pre></article></div>
      <details><summary>原始输入与执行记录</summary><pre id="trace"></pre></details>
      <form id="decision"><label>人工决定 <select id="choice"><option value="defer">暂缓</option><option value="accept">采纳</option><option value="reject">不采纳</option></select></label>
      <label>备注<textarea id="note" maxlength="4000"></textarea></label><button id="save">保存决定</button><p id="saved" class="muted"></p></form></section></dialog>`;
    const $ = id => root.getElementById(id);
    const dialog = root.querySelector('dialog');
    let current = null, catalog, timer, fetching = false, decisionKey, displayedTask;
    const submissionKey = 'gateway-workflow-pending-request';
    const states = {pending:'等待', running:'运行中', 'cancel-requested':'已请求取消，尚未确认停止', completed:'已完成', failed:'失败', stopped:'本地流程已停止（不代表远端停止）', unknown:'结果未知，禁止重放', 'awaiting-decision':'等待人工决定'};
    const choices = {accept:'采纳', reject:'不采纳', defer:'暂缓'};
    const statusLabel = task => task.decision ? `${states[task.status] === '等待人工决定' ? '阶段已完成' : states[task.status]} · 已决定${choices[task.decision.choice]}` : states[task.status];
    const api = async (query = '', value) => {
      const response = await fetch('/api/gateway-workflows' + query, value === undefined ? {cache:'no-store'} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)});
      const data = await response.json(); if (!response.ok) throw Error(data.error ?? `HTTP ${response.status}`); return data;
    };
    const report = error => { $('error').textContent = error.message; };
    function option(select, value, label) { const node = document.createElement('option'); node.value=value; node.textContent=label; select.append(node); }
    function selections() {
      $('selections').replaceChildren();
      for (const [role, title] of [['generation','生成阶段'],['review','审阅阶段']]) {
        const block=document.createElement('fieldset'), legend=document.createElement('legend'); legend.textContent=title; block.append(legend);
        const selects = {};
        for (const [field,label] of [['connectionId','连接'],['model','模型'],['reasoningEffort','思考等级']]) {
          const l=document.createElement('label'), s=document.createElement('select'); l.textContent=label+' '; s.id=role+'-'+field; s.required=field!=='reasoningEffort'; l.append(s); block.append(l); selects[field]=s;
        }
        const {connectionId: connection, model, reasoningEffort: effort}=selects;
        option(connection,'','请选择连接'); catalog.connections.forEach(c=>option(connection,c.id,c.label));
        connection.onchange=()=>{model.replaceChildren(); option(model,'','请选择模型'); const provider=catalog.connections.find(c=>c.id===connection.value)?.provider;
          catalog.models.groups.find(g=>g.id===provider)?.models.forEach(m=>option(model,m.id,m.name)); model.onchange();};
        model.onchange=()=>{effort.replaceChildren(); const provider=catalog.connections.find(c=>c.id===connection.value)?.provider;
          const efforts=catalog.models.groups.find(g=>g.id===provider)?.models.find(m=>m.id===model.value)?.reasoning?.efforts ?? [];
          option(effort,'',efforts.length?'请选择思考等级':'不适用'); efforts.forEach(e=>option(effort,e.id,e.name)); effort.required=efforts.length>0;};
        connection.onchange(); $('selections').append(block);
      }
    }
    async function list() {const tasks=await api(); $('tasks').replaceChildren(); option($('tasks'),'','选择流程'); tasks.forEach(t=>option($('tasks'),t.id,`${statusLabel(t)} · ${t.question.slice(0,60)}`)); $('tasks').value=current ?? '';}
    function render(task) {
      displayedTask=task;
      $('result').hidden=false; $('status').textContent=`流程 ${task.id} · ${statusLabel(task)}`;
      const row=[...$('tasks').options].find(o=>o.value===task.id);
      if(row) row.textContent=`${statusLabel(task)} · ${task.input.question.slice(0,60)}`;
      for (const role of ['generation','review']) {
        const stage=task.stages[role], s=stage.selection;
        $(role).textContent=stage.artifact ?? '尚无产物';
        $(role+'-meta').textContent=`${states[stage.status]} · ${s.connectionLabel} / ${s.provider} / ${s.model} / ${s.reasoningEffort || '不适用'} · ${stage.elapsedMs ?? '未知'} ms · 会话 ${stage.sessionId}${stage.error ? ' · '+stage.error.message : ''}`;
      }
      $('trace').textContent=JSON.stringify(task,null,2);
      $('cancel').disabled=task.status!=='running';
      for (const role of ['generation','review']) $('retry-'+role).hidden=task.status!=='failed' || task.stages[role].status!=='failed';
      $('save').disabled=['running','cancel-requested'].includes(task.status) || !task.stages.generation.artifact;
      const nextKey=task.id+JSON.stringify(task.decision);
      if (decisionKey!==nextKey) {decisionKey=nextKey; $('choice').value=task.decision?.choice ?? 'defer'; $('note').value=task.decision?.note ?? '';}
      $('saved').textContent=task.decision ? `已保存：${choices[task.decision.choice]} · ${task.decision.savedAt}（保存和刷新不会调用模型）` : '尚未保存决定';
    }
    async function refresh() { if (!current || fetching) return; fetching=true; const id=current; try {const task=await api('?id='+encodeURIComponent(id)); if (current===id) render(task);} catch(e){report(e);} finally{fetching=false;} }
    root.querySelector('.launch').onclick=async()=>{dialog.showModal(); $('error').textContent=''; try {catalog=await api('?catalog=1'); selections();
      const pending=sessionStorage.getItem(submissionKey);
      if(pending) { const tasks=await api(); if(tasks.some(t=>t.id===pending)) {current=pending;sessionStorage.removeItem(submissionKey);} }
      await list(); await refresh(); timer=setInterval(refresh,1500);} catch(e){report(e);}};
    $('close').onclick=()=>dialog.close(); dialog.onclose=()=>clearInterval(timer);
    $('add').onclick=()=>{const count=root.querySelectorAll('.material').length; if(count>=20)return; const l=document.createElement('label'); l.textContent=`材料 ${count+1}`; const t=document.createElement('textarea'); t.className='material'; t.maxLength=16000; l.append(t); $('materials').append(l);};
    $('tasks').onchange=async()=>{current=$('tasks').value||null; $('result').hidden=!current; await refresh();};
    $('form').onsubmit=async event=>{event.preventDefault(); $('error').textContent=''; $('submit').disabled=true;
      try {const value={question:$('question').value,materials:[...root.querySelectorAll('.material')].map(t=>t.value),constraints:$('constraints').value};
        for(const role of ['generation','review']) value[role]=Object.fromEntries(['connectionId','model','reasoningEffort'].map(field=>[field,$(role+'-'+field).value]));
        const requestId=sessionStorage.getItem(submissionKey) ?? crypto.randomUUID();
        sessionStorage.setItem(submissionKey,requestId);
        const task=await api('',{...value,requestId}); sessionStorage.removeItem(submissionKey); current=task.id; render(task); $('new').open=false; await list();
      }catch(e){report(e);}finally{$('submit').disabled=false;}};
    $('decision').onsubmit=async event=>{event.preventDefault(); $('error').textContent=''; try {render(await api('?id='+encodeURIComponent(current),{choice:$('choice').value,note:$('note').value}));}catch(e){report(e);}};
    $('cancel').onclick=async()=>{const id=current; $('cancel').disabled=true; try {const task=await api('?id='+encodeURIComponent(id)+'&action=cancel',{}); if(current===id)render(task);}catch(e){report(e);}finally{await refresh();}};
    for(const role of ['generation','review']) $('retry-'+role).onclick=async()=>{
      const task=displayedTask; if(!task || !confirm('仅重试此失败阶段，使用原连接/模型及当前登录账号；可能消耗额度。继续？'))return;
      $('retry-'+role).disabled=true;
      try {const updated=await api('?id='+encodeURIComponent(task.id)+'&action=retry',{role,sessionId:task.stages[role].sessionId}); if(current===task.id)render(updated);}
      catch(e){report(e);}finally{$('retry-'+role).disabled=false; await refresh();}
    };
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
