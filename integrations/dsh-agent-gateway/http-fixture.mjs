// Loopback-only OpenAI-compatible servers for transport tests. Never a real Provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { responseFor, text } from './fixture-scenario.mjs';

export async function startHttpFixtures(routes) {
  const servers=[], calls=[], errors=[], providers={};
  const contentText = content => typeof content==='string' ? content : (content??[]).map(b=>b.text??'').join('\n');
  const close = async () => { await Promise.all(servers.map(server=>new Promise(resolve=>{
    server.close(resolve); server.closeAllConnections();
  }))); };
  try {
    for(const [index,route] of routes.entries()) {
      const server=createServer((req,res)=>{ handle(req,res).catch(error=>{
        errors.push(String(error)); if(!res.headersSent)res.writeHead(500);res.end();
      }); });
      async function handle(req,res) {
        assert.equal(req.method,'POST'); assert.equal(req.url,'/v1/chat/completions');
        assert.equal(req.headers.authorization,'Bearer local-fixture-not-a-secret');
        let raw=''; for await(const chunk of req)raw+=chunk;
        const body=JSON.parse(raw); assert.equal(body.model,route.model); assert.equal(body.stream,true);
        assert.equal(body.reasoning_effort,index===0?'high':undefined);
        assert.ok(body.tools.some(t=>t.function.name==='subagent'));
        const inputs=body.messages.filter(m=>m.role==='user').map(m=>contentText(m.content));
        const goal=inputs.join('\n'), isChild=index!==0;
        const results=body.messages.filter(m=>m.role==='tool').map(m=>({toolCallId:m.tool_call_id,content:[text(contentText(m.content))]}));
        const call={provider:route.provider,model:body.model,toolResults:results.map(r=>r.toolCallId),
          waiting:goal.includes('wait-for-cancel'),closed:false};
        calls.push(call);res.on('close',()=>{call.closed=true;});
        if(isChild && goal.includes('fail-child')) {
          res.writeHead(503,{'Content-Type':'application/json'});
          res.end(JSON.stringify({error:{message:'Deliberate local child failure',type:'server_error',code:'FIXTURE_FAILURE'}}));return;
        }
        if(isChild && goal.includes('wait-for-cancel')) {await once(res,'close');return;}
        if(isChild) await new Promise(resolve=>setTimeout(resolve,60));
        const output=responseFor({isChild,goal,results,ordinal:calls.length});
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        const send=(delta,finish_reason=null,usage)=>res.write('data: '+JSON.stringify({id:'local-'+calls.length,
          object:'chat.completion.chunk',created:1,model:body.model,
          choices:usage?[]:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
        send({role:'assistant'});
        let toolIndex=0;
        for(const block of output) {
          if(block.type==='text')send({content:block.text});
          else {
            // Deliberately split arguments to exercise actual adapter stream assembly.
            const middle=Math.floor(block.arguments.length/2), index=toolIndex++;
            send({tool_calls:[{index,id:block.id,type:'function',function:{name:block.name,arguments:block.arguments.slice(0,middle)}}]});
            send({tool_calls:[{index,function:{arguments:block.arguments.slice(middle)}}]});
          }
        }
        send({},toolIndex?'tool_calls':'stop');
        send({},null,{prompt_tokens:10,completion_tokens:5,total_tokens:15});
        res.end('data: [DONE]\n\n');
      }
      servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
      providers[route.provider]={api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,
        apiKeyEnv:'GATEWAY_LOCAL_FIXTURE_KEY',compat:{supportsReasoningEffort:true},
        models:[{id:route.model,name:'Local HTTP fixture',reasoningEfforts:index===0?{high:'high'}:false}]};
    }
    return {providers,calls,errors,close};
  } catch(error) {await close();throw error;}
}
