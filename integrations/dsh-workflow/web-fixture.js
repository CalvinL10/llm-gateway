// Test-only adapters. This module is never loaded by the product overlay.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'gateway-offline-fixture';
export const inject = ['llm', 'connection', 'sessionController'];
export function apply(ctx) {
  const calls = [], releases = new Set();
  const models = ['local', 'fail-once', 'login-expired', 'disconnect', 'wait', 'ignore-abort'];
  class Stub extends LlmAdapter {
    async listModels(provider) { return models.map(id => ({provider,id,name:'Local fixture: '+id})); }
    async *stream(options) {
      if ((options.tools ?? []).length) throw new Error('Unexpected tools');
      const call = {provider:options.provider,model:options.model,tools:(options.tools??[]).length,purpose:options.purpose ?? null,cleaned:false};
      calls.push(call);
      try {
      if(options.model==='login-expired') throw Object.assign(new Error('Local simulated expired login'), {code:'AUTH_EXPIRED'});
      if(options.model==='fail-once' && calls.filter(c=>c.provider===options.provider && c.model===options.model).length===1)
        throw new Error('Local first-attempt failure');
      const text = options.provider === 'workflow-local-a' ? '离线方案\n  保留缩进\n<script>not executed</script>' : '离线审阅：检查边界条件，建议补充空输入说明。';
      yield {type:'block-start', index:0, blockType:'text'};
      yield {type:'text-delta', index:0, text};
      if(options.model==='disconnect') throw new Error('Local simulated stream disconnect');
      if(['wait','ignore-abort'].includes(options.model)) {
        const gate=Promise.withResolvers(); releases.add(gate.resolve); call.waiting=true;
        const abort=()=>{call.aborted=true;if(options.model==='wait')gate.resolve();};
        options.signal.addEventListener('abort',abort,{once:true});
        if(options.signal.aborted)abort();
        try {await gate.promise;} finally {options.signal.removeEventListener('abort',abort);releases.delete(gate.resolve);}
        options.signal.throwIfAborted();
      }
      yield {type:'block-end', index:0, block:{type:'text',text}};
      yield {type:'finish', reason:{kind:'stop'}};
      } finally {call.cleaned=true;}
    }
  }
  ctx.llm.registerAdapter(['workflow-local-a','workflow-local-b'], new Stub());
  ctx.connection.fetch.register({path:'/api/gateway-fixture-release',methods:['POST'],requestBody:'buffered',fetch:async()=>{
    for(const release of releases)release(); return Response.json({released:releases.size});
  }});
  ctx.connection.fetch.register({path:'/api/gateway-fixture-calls',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json(calls)});
  ctx.connection.fetch.register({path:'/api/gateway-fixture-input',methods:['GET'],requestBody:'buffered',fetch:async request=>{
    const session=await ctx.sessionController.inspect(new URL(request.url).searchParams.get('id'));
    return Response.json(session.events.filter(e=>e.type==='user/message').map(e=>e.data.content));
  }});
}
