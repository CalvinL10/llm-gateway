// Test-only scripted model responses. No credentials, network model or product decision rules.
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { responseFor } from './fixture-scenario.mjs';
export const name='gateway-agent-fixture';
export const inject=['llm','connection','sessions','agents','approval'];
export function apply(ctx, config={}) {
  const calls=[];
  let activeChildren=0, maxActiveChildren=0;
  function requestOf(options) {
      const blocks=options.messages.flatMap(m=>m.content);
      const inputs=options.messages.filter(m=>m.role==='user' && m.source?.kind!=='tool').flatMap(m=>m.content).filter(b=>b.type==='text').map(b=>b.text);
      const goal=inputs.join('\n');
      const results=blocks.filter(b=>b.type==='tool-result');
      const header=ctx.sessions.get(options.sessionId)?.header;
      const isChild=header?.origin==='subagent';
      return {inputs,goal,results,header,isChild};
  }
  ctx.on('llm/stream',async function* (options,next) {
      const {inputs,header,isChild}=requestOf(options);
      calls.push({sessionId:options.sessionId,parentSessionId:header?.parentSession??null,provider:options.provider,model:options.model,
        cwd:header?.cwd??null,tools:(options.tools??[]).map(t=>t.name),inputs,cleaned:false});
      const call=calls.at(-1);
      if(isChild) {activeChildren++; maxActiveChildren=Math.max(maxActiveChildren,activeChildren);}
      try {yield* next();}
      finally {if(isChild)activeChildren--;call.cleaned=true;}
  });
  class Fixture extends LlmAdapter {
    async listModels(provider) { return [{provider,id:provider==='fixture-lead'?'planner':provider==='fixture-deep'?'flash-a':'flash-b',name:'Local scripted fixture'}]; }
    async *stream(options) {
      const request=requestOf(options), {goal,isChild}=request;
      if(isChild) {
        if(goal.includes('fail-child')) throw new LlmError('Deliberate local child failure','FIXTURE_FAILURE');
        if(goal.includes('wait-for-cancel')) {
          await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});
          options.signal.throwIfAborted();
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      let output;
      if(!isChild && goal.includes('manual approval two-step')) {
        const outcomes=[];
        for(let step=1;step<=2;step++) outcomes.push(await ctx.approval.request({agent:ctx.agents.get(options.sessionId),
          toolName:'write', reason:`TEST ONLY: no file operation will run; decide one-shot approval ${step} of 2 in this authorized workspace`,
          signal:options.signal}));
        output=[{type:'text',text:'MANUAL_APPROVAL_OUTCOMES: '+outcomes.join(',')}];
      } else if(!isChild && goal.includes('manual approval expire')) {
        const controller=new AbortController();
        const abort=()=>controller.abort(options.signal.reason);
        options.signal.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>controller.abort(new Error('TEST_ONLY_APPROVAL_EXPIRED')),10000);
        try {
          const outcome=await ctx.approval.request({agent:ctx.agents.get(options.sessionId),toolName:'write',
            reason:'TEST ONLY: no file operation will run; leave this request unanswered to verify expiry after 10 seconds',
            signal:controller.signal});
          output=[{type:'text',text:'MANUAL_APPROVAL_EXPIRY: '+outcome}];
        } finally {clearTimeout(timer);options.signal.removeEventListener('abort',abort);}
      } else if(!isChild && goal.includes('approval cancel browser')) {
        const outcome=await ctx.approval.request({agent:ctx.agents.get(options.sessionId),toolName:'write',
          reason:'TEST ONLY: no file operation will run; cancel the task from its task page',signal:options.signal});
        output=[{type:'text',text:'APPROVAL_CANCEL_OUTCOME: '+outcome}];
      } else output=responseFor({...request,ordinal:calls.length});
      for(const [index,block] of output.entries()) {
        yield {type:'block-start',index,blockType:block.type};
        if(block.type==='text') yield {type:'text-delta',index,text:block.text};
        yield {type:'block-end',index,block};
      }
      yield {type:'usage',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
      yield {type:'finish',reason:{kind:output.some(b=>b.type==='tool-call')?'tool-calls':'stop'}};
    }
  }
  if(!config.observeOnly) ctx.llm.registerAdapter(['fixture-lead','fixture-deep','fixture-google','fixture-forbidden'],new Fixture());
  ctx.connection.fetch.register({path:'/api/gateway-agent-fixture',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json({calls,activeChildren,maxActiveChildren})});
}
