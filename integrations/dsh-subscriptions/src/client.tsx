import React,{useEffect,useState} from 'react';

export const inject=['slots'];
const prefixes={codex:'/api/dsh-chatgpt-subscription',antigravity:'/antigravity/api',claude:'/claude/api'};
const codex={startLogin:()=>request(prefixes.codex+'/login/start',{}),logout:()=>request(prefixes.codex+'/logout',{})};
async function request(url,body?) {
  const connection=Object.entries(prefixes).find(([,prefix])=>url.startsWith(prefix+'/'));
  const target=connection?'/api/gateway-subscription-bridge':url;
  const payload=connection?{provider:connection[0],path:url.slice(connection[1].length),method:body===undefined?'GET':'POST',body}:body;
  const response=await fetch(target,{credentials:'same-origin',...(payload===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})});
  const result=await response.json();
  if (!response.ok || result.ok===false) throw new Error(typeof result.error==='string'?result.error:result.error?.message??`请求失败 (${response.status})`);
  return 'ok' in result ? result.value??result.data??result : result;
}

function Account({kind,label}) {
  const [status,setStatus]=useState<any>(null),[flow,setFlow]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[code,setCode]=useState('');
  const refresh=async()=>{const next=await request(`${prefixes[kind]}/status`);setStatus(next);if(next.authenticated||next.connection?.authenticated)setFlow({status:'complete'});};
  useEffect(()=>{refresh().catch(e=>setError(e.message));},[]);
  useEffect(()=>{
    if (!flow || ['complete','error','idle','cancelled'].includes(flow.status)) return;
    const timer=setInterval(()=>{
      (kind==='codex'?refresh():request(`${prefixes[kind]}/login/status`).then(next=>{
        setFlow(next); if(next.status==='complete') return refresh(); if(next.error) setError(next.error);
      })).catch(e=>setError(e.message));
    },2000);
    return ()=>clearInterval(timer);
  },[flow?.status]);
  const action=async work=>{setBusy(true);setError('');try{await work();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const authenticated=status?.authenticated===true || status?.connection?.authenticated===true;
  const login=()=>action(async()=>{
    const next=kind==='codex'?await codex.startLogin():await request(`${prefixes[kind]}/login`,{});
    setFlow({...next,status:next.status??'pending'});
    // Claude's original host handler already opens the browser.
    if(next.authUrl && kind!=='claude') window.open(next.authUrl,'_blank','noopener,noreferrer');
  });
  return <section className="gateway-card">
    <h3>{label}</h3><p>{status ? authenticated?'已连接':'尚未连接':'正在读取连接状态…'}</p>
    <div className="gateway-actions"><button disabled={busy} onClick={login}>登录账号</button>
      <button disabled={busy} onClick={()=>action(refresh)}>刷新状态</button>
      {authenticated && <button disabled={busy} onClick={()=>action(async()=>{
        if(kind==='codex') await codex.logout(); else await request(`${prefixes[kind]}/logout`,{});
        await refresh();
      })}>退出此连接</button>}</div>
    {flow?.authUrl && !authenticated && <p><a href={flow.authUrl} target="_blank" rel="noreferrer">打开账号授权页面</a></p>}
    {kind==='claude' && flow?.status==='pending' && <div><label>授权页面返回的授权码<input value={code} onChange={e=>setCode(e.target.value)} autoComplete="off" /></label>
      <button disabled={busy||!code.trim()} onClick={()=>action(async()=>{await request(`${prefixes[kind]}/login/input`,{input:code});setCode('');setFlow(null);await refresh();})}>完成登录</button></div>}
    {error && <p role="alert">{error}</p>}
    {kind!=='codex' && <p className="gateway-note">通过社区连接器使用订阅账号；服务可用性和额度由上游决定。</p>}
  </section>;
}

function Models() {
  const [state,setState]=useState<any>(null),[main,setMain]=useState(''),[child,setChild]=useState(''),[allowed,setAllowed]=useState<string[]>([]),[enabled,setEnabled]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const key=route=>JSON.stringify([route.provider,route.model]);
  const childValue=next=>{const values=[...new Set(next.presets.flatMap(p=>p.routes).map(route=>route?key(route):''))];return values.length>1?'mixed':values[0]??'';};
  const load=async()=>{
    const next=await request('/api/gateway-model-defaults'); setState(next);setMain(key(next.main));
    setChild(childValue(next));
    setEnabled(next.childSelection?.enabled??false);setAllowed((next.childSelection?.allowedModels??[]).map(key));
  };
  useEffect(()=>{load().catch(e=>setMessage(e.message));},[]);
  if(!state) return <section className="gateway-card"><h3>主模型与子代理</h3><p>{message||'正在读取宿主模型目录…'}</p></section>;
  const options=state.catalog.groups.flatMap(group=>group.models.map(model=>({key:JSON.stringify([group.id,model.id]),label:`${group.name} / ${model.name}`})));
  const visible=new Set(options.map(option=>option.key));
  const saved=[key(state.main),...state.presets.flatMap(p=>p.routes).filter(Boolean).map(key),...allowed];
  for(const value of new Set(saved))if(!visible.has(value)){const [provider,model]=JSON.parse(value);options.push({key:value,label:`${provider} / ${model}（已保存，当前不可用）`});}
  const route=value=>{const [provider,model]=JSON.parse(value);return {provider,model};};
  return <section className="gateway-card"><h3>主模型与子代理</h3>
    <p>可选择宿主已接入的任意渠道。保存后用于新对话；当前对话仍可在输入框旁切换主模型。</p>
    <label>默认主模型<select aria-label="默认主模型" value={main} onChange={e=>setMain(e.target.value)}>{options.map(o=><option key={o.key} value={o.key}>{o.label}</option>)}</select></label>
    <label>默认子模型<select aria-label="默认子模型" value={child} onChange={e=>setChild(e.target.value)}>{childValue(state)==='mixed'&&<option value="mixed">保留各预设已有的不同默认值</option>}<option value="">使用 DSH 原生继承方式</option>{options.map(o=><option key={o.key} value={o.key}>{o.label}</option>)}</select></label>
    <label><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} />允许不同子代理另选模型</label>
    {enabled && <fieldset><legend>允许子代理选择的模型（DSH 原生设置）</legend><button onClick={()=>setAllowed([...new Set([...allowed,...options.filter(o=>visible.has(o.key)).map(o=>o.key)])])}>选择全部渠道</button>
      {options.map(o=><label key={o.key}><input type="checkbox" checked={allowed.includes(o.key)} onChange={e=>setAllowed(e.target.checked?[...allowed,o.key]:allowed.filter(k=>k!==o.key))}/>{o.label}</label>)}</fieldset>}
    <div className="gateway-actions"><button disabled={busy} onClick={async()=>{setBusy(true);setMessage('');try{
      const patch:any={};
      if(main!==key(state.main))patch.main=route(main);
      if(child!==childValue(state))patch.child=child?route(child):null;
      const savedAllowed=(state.childSelection?.allowedModels??[]).map(key);
      if(enabled!==(state.childSelection?.enabled??false)||allowed.length!==savedAllowed.length||allowed.some(key=>!savedAllowed.includes(key)))
        patch.childSelection={enabled,allowedModels:allowed.map(route)};
      await request('/api/gateway-model-defaults',patch);
      await load();setMessage('已保存。请新建对话使用。');
    }catch(e){setMessage(`保存未完成：${e.message}。请刷新检查已保存项。`);}finally{setBusy(false);}}}>保存设置</button><button disabled={busy} onClick={()=>load().catch(e=>setMessage(e.message))}>刷新目录与设置</button></div>
    {state.catalog.failures.map(f=><p key={f.id}>{f.name}：{f.message}</p>)}
    <p role="status">{message}</p><p className="gateway-note">独立模型由原生 spawn 子代理使用；分叉和外部产品子代理沿用各自的宿主设置。</p>
  </section>;
}

function Settings() {return <main className="gateway-settings"><h2>订阅连接与模型设置</h2><p>连接账号后，直接在 DSH 普通新对话中选择模型。</p>
  <Account kind="codex" label="Codex / ChatGPT"/><Account kind="antigravity" label="Antigravity"/><Account kind="claude" label="Claude"/><Models/></main>;}

export function apply(ctx) {
  const style=document.createElement('style');
  style.textContent='.gateway-settings{max-width:880px;margin:auto;padding:24px;color:inherit}.gateway-card{border:1px solid #8885;border-radius:12px;padding:20px;margin:16px 0}.gateway-card h3{margin-top:0}.gateway-card label{display:block;margin:12px 0}.gateway-card select,.gateway-card input:not([type=checkbox]){display:block;width:100%;padding:8px;margin-top:6px;background:transparent;color:inherit;border:1px solid #8888;border-radius:6px}.gateway-card input[type=checkbox]{margin-right:8px}.gateway-actions{display:flex;gap:12px;flex-wrap:wrap}.gateway-card button{padding:8px 14px;border:1px solid #8888;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.gateway-note{opacity:.7;font-size:13px}.gateway-card [role=alert]{color:#d45}.gateway-card fieldset{max-height:320px;overflow:auto;border:1px solid #8885}';
  document.head.append(style);ctx.on('dispose',()=>style.remove());
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'gateway-subscriptions',order:46,label:()=> '订阅连接与模型设置'},Settings));
}
