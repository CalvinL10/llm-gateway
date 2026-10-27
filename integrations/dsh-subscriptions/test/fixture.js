// Offline-only adapters. No provider credentials or external model requests.
import {LlmAdapter,LlmError} from '@deepseek-ai/dsh-llm';
import {randomUUID} from 'node:crypto';
export const inject=['llm','connection','sessionController','sessions','agents'];
export function apply(ctx,config) {
  const calls=[];
  const delegated=new Set();
  ctx.on('llm/stream',async function* (options,next){
    const session=ctx.sessions.get(options.sessionId);
    calls.push({sessionId:options.sessionId,parentSession:session?.header.parentSession,provider:options.provider,model:options.model,isChild:session?.header.origin==='subagent'});
    yield* next();
  });
  class Scripted extends LlmAdapter {
    async listModels(provider) {return [{provider,id:'model',name:`Scripted ${provider}`,contextWindow:32000}];}
    async *stream(options) {
      const session=ctx.sessions.get(options.sessionId);
      const isChild=session?.header.origin==='subagent';
      const text=options.messages.filter(m=>m.role==='user').flatMap(m=>m.content).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      let blocks;
      if (!isChild && text.includes('delegate') && !delegated.has(options.sessionId)) {
        delegated.add(options.sessionId);
        const args={description:'Offline route test',prompt:'Answer with one scripted word'};
        if(text.includes('explicit')) Object.assign(args,{provider:'fixture-api',model:'model'});
        blocks=[{type:'tool-call',id:randomUUID(),name:'subagent',arguments:JSON.stringify(args)}];
      } else if(text.includes('fixture-failure')) throw new LlmError('Offline provider failure','AUTH');
      else blocks=[{type:'text',text:isChild?'CHILD_OK':'ORDINARY_OK'}];
      for(const [index,block] of blocks.entries()) {
        yield {type:'block-start',index,blockType:block.type};
        if(block.type==='text') yield {type:'text-delta',index,text:block.text};
        yield {type:'block-end',index,block};
      }
      yield {type:'finish',reason:{kind:blocks.some(b=>b.type==='tool-call')?'tool-calls':'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture-deepseek','fixture-api','fixture-third'],new Scripted());
  ctx.connection.fetch.register({path:'/api/gateway-subscription-fixture',methods:['GET','POST'],requestBody:'buffered',async fetch(request) {
    if(request.method==='GET') return Response.json({calls});
    try {
      const input=await request.json(),sessionId=randomUUID();
      await ctx.sessionController.create({sessionId,cwd:config.cwd,agentPreset:'standard'});
      const {agent,error}=await ctx.sessionController.resolveAgent(sessionId);if(error)throw error;
      if(input.provider) await ctx.sessionController.selectModel({sessionId,provider:input.provider,model:'model'});
      await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:input.prompt??'ordinary answer'}]},new AbortController().signal);
      await agent.whenIdle();
      // Child work and its native completion notice may wake the parent later.
      for(let n=0;n<80;n++) {
        const children=ctx.agents.list().filter(item=>item.session.header.parentSession===sessionId);
        if(children.length) await Promise.all(children.map(item=>item.whenIdle()));
        await new Promise(resolve=>setTimeout(resolve,25));await agent.whenIdle();
        if(!input.prompt?.includes('delegate') || calls.some(call=>call.parentSession===sessionId)) break;
      }
      return Response.json({sessionId,calls:calls.filter(call=>call.sessionId===sessionId||call.parentSession===sessionId),events:agent.session.snapshotEvents()});
    }catch(error){return Response.json({error:error.message},{status:500});}
  }});
}
