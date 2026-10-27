import {Readable,Writable} from 'node:stream';

const prefixes={codex:'/api/dsh-chatgpt-subscription',antigravity:'/antigravity/api',claude:'/claude/api'};

// Upstream settings handlers use node:http. Keep those handlers unchanged but
// serve them exclusively through DSH's authenticated, carrier-neutral Fetch
// registry, including the desktop IPC carrier. No raw HTTP route is installed.
export function protectedRouteContext(ctx) {
  const routes=[];
  const webServer={register(route){routes.push(route);return()=>{const i=routes.indexOf(route);if(i>=0)routes.splice(i,1);};}};
  ctx.connection.fetch.register({path:'/api/gateway-subscription-bridge',methods:['POST'],requestBody:'buffered',async fetch(request) {
    try {
      const text=await request.text();
      if(text.length>65536) return Response.json({error:'请求内容过大'},{status:413});
      const input=JSON.parse(text);
      if(!Object.hasOwn(prefixes,input.provider)||typeof input.path!=='string'||!/^\/[a-z0-9/_-]+$/i.test(input.path)
        ||!['GET','POST'].includes(input.method)||input.path==='/login/events')
        return Response.json({error:'不支持的订阅设置请求'},{status:400});
      const path=prefixes[input.provider]+input.path;
      const route=routes.find(route=>route.kind==='exact'&&route.path===path)
        ??routes.find(route=>route.kind==='prefix'&&(path===route.path||path.startsWith(route.path+'/')));
      if(!route) return Response.json({error:'连接接口不可用'},{status:404});
      const body=input.method==='POST'?JSON.stringify(input.body??{}):'';
      const incoming=Readable.from(body?[Buffer.from(body)]:[]);
      incoming.method=input.method;incoming.url=path;
      incoming.headers={host:new URL(request.url).host,origin:request.headers.get('origin')??new URL(request.url).origin,'content-type':'application/json'};
      const chunks=[];const headers=new Headers();let status=200;
      const outgoing=new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}});
      outgoing.statusCode=200;
      outgoing.setHeader=(key,value)=>{headers.set(key,String(value));return outgoing;};
      outgoing.getHeader=key=>headers.get(key);
      outgoing.writeHead=(code,values)=>{status=code;outgoing.statusCode=code;for(const [key,value] of Object.entries(values??{}))headers.set(key,String(value));return outgoing;};
      outgoing.flushHeaders=()=>{};
      await route.handler(incoming,outgoing);
      if(!outgoing.writableFinished) await new Promise((ok,fail)=>{outgoing.once('finish',ok);outgoing.once('error',fail);});
      return new Response(Buffer.concat(chunks),{status:outgoing.statusCode??status,headers});
    }catch(error){return Response.json({error:error.message??'订阅连接请求失败'},{status:400});}
  }});
  return {webServer,emit:ctx.emit.bind(ctx),get:ctx.get.bind(ctx),llm:ctx.llm,logger:ctx.logger};
}
