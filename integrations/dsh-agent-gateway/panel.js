// Read-only companion to the native conversation/approval UI; never submits work.
(() => {
  function mount() {
    if (document.getElementById('gateway-task-report')) return;
    const host = document.createElement('div'); host.id = 'gateway-task-report';
    host.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:1000';
    document.body.append(host);
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>
      button,select{font:inherit;padding:8px}dialog{width:min(820px,92vw);max-height:85vh;overflow:auto;font:14px/1.6 system-ui;color:#172c45;background:#f8fafc;border:1px solid #bac5d1;border-radius:10px}
      pre{white-space:pre-wrap;overflow-wrap:anywhere}header{display:flex;justify-content:space-between}
    </style><button id="open">任务状态与部分成果</button><dialog><header><h2>执行记录报告（非业务验收）</h2><button id="close">关闭</button></header>
      <p>原生对话中的中途文字不代表任务完成。此面板只读，不批准、不续跑、不调用模型。</p>
      <label>任务 <select id="tasks"></select></label><p id="status"></p><p id="boundary"></p><pre id="report"></pre><p id="error" role="alert"></p></dialog>`;
    const $ = id => root.getElementById(id), dialog = root.querySelector('dialog');
    const labels = {running: '运行中', 'cancel-requested': '已请求取消，尚未确认停止',
      completed: '回合正常结束（不等于业务目标完成）', limited: '调用上限已阻止继续（未完成）',
      failed: '执行失败', stopped: '本地已停止（不保证远端停止）', unknown: '执行结果未知，禁止自动重放'};
    let timer, fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch('/api/gateway-agent-tasks', {cache: 'no-store'});
        if (!response.ok) throw Error('无法读取任务报告');
        const {tasks} = await response.json();
        const selected = $('tasks').value;
        $('tasks').replaceChildren();
        for (const task of [...tasks].reverse()) {
          const option = document.createElement('option'); option.value = task.id;
          option.textContent = task.id + ' · ' + (labels[task.status] ?? '未知'); $('tasks').append(option);
        }
        if (tasks.some(t => t.id === selected)) $('tasks').value = selected;
        const task = tasks.find(t => t.id === $('tasks').value);
        $('status').textContent = task ? labels[task.status] ?? '未知' : '尚无任务';
        $('boundary').textContent = task ? '业务目标与检查通过：尚未证实。成功 edit/write 仅证实工具确认的文件变更；命令返回不等于测试通过，失败操作也可能已有部分副作用。未记录的检查不能推断为已完成。' : '';
        // No assistant text, goal, command, path, tool output, error message or meta.
        $('report').textContent = task ? JSON.stringify(task.report ?? {evidenceCoverage: 'unavailable'}, null, 2) : '';
        $('error').textContent = '';
      } catch { $('error').textContent = '无法读取任务报告；请检查本地服务及登录状态。'; }
      finally { fetching = false; }
    }
    $('open').onclick = () => { dialog.showModal(); refresh(); timer = setInterval(refresh, 1500); };
    $('close').onclick = () => dialog.close();
    dialog.onclose = () => clearInterval(timer);
    $('tasks').onchange = refresh;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
