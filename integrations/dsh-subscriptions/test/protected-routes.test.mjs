import test from 'node:test';
import assert from 'node:assert/strict';
import {protectedRouteContext} from '../src/protected-routes.js';

function setup(){let handler;const context=protectedRouteContext({connection:{fetch:{register(route){handler=route.fetch;}}},
  emit(){},get(){},llm:{},logger:{}});return {context,invoke:body=>handler(new Request('http://127.0.0.1/api/gateway-subscription-bridge',{method:'POST',body:JSON.stringify(body)}))};}

test('protected carrier forwards JSON and status to unchanged Node handlers without registering raw HTTP routes',async()=>{
  const {context,invoke}=setup();
  const release=context.webServer.register({kind:'prefix',path:'/claude/api',async handler(req,res){
    assert.equal(req.method,'POST');assert.equal(req.url,'/claude/api/settings');
    let body='';for await(const chunk of req)body+=chunk;
    assert.deepEqual(JSON.parse(body),{enabled:true});
    assert.equal(req.headers.origin,'http://127.0.0.1');
    res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value:{saved:true}}));
  }});
  const response=await invoke({provider:'claude',path:'/settings',method:'POST',body:{enabled:true}});
  assert.equal(response.status,201);assert.deepEqual(await response.json(),{ok:true,value:{saved:true}});
  release();assert.equal((await invoke({provider:'claude',path:'/status',method:'GET'})).status,404);
});

test('bridge refuses unknown destinations, path traversal and unsupported streams',async()=>{
  const {invoke}=setup();
  for(const body of [null,{}, {provider:'other',path:'/status',method:'GET'},
    {provider:'codex',path:'/../credentials',method:'GET'},
    {provider:'codex',path:'/login/events',method:'GET'},
    {provider:'codex',path:'/status',method:'DELETE'}]) assert.equal((await invoke(body)).status,400);
});
