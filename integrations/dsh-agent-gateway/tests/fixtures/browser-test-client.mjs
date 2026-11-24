// Credential-free isolated browser test helper. Never attach to a user profile.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait=milliseconds=>new Promise(resolvePromise=>setTimeout(resolvePromise,milliseconds));
export async function until(fn,timeout=30000) {
  const end=Date.now()+timeout;let lastError;
  while(Date.now()<end) {
    try {const value=await fn();if(value)return value;}catch(error){lastError=error;}
    await wait(100);
  }
  throw lastError??new Error('Condition timeout');
}
class Cdp {
  constructor(socket) {
    this.socket=socket;this.id=0;this.pending=new Map();
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);if(!message.id||!this.pending.has(message.id))return;
      const {resolve:resolvePromise,reject}=this.pending.get(message.id);this.pending.delete(message.id);
      if(message.error)reject(new Error(message.error.message));else resolvePromise(message.result);
    };
  }
  call(method,params={}) {
    const id=++this.id;
    const promise=new Promise((resolvePromise,reject)=>this.pending.set(id,{resolve:resolvePromise,reject}));
    this.socket.send(JSON.stringify({id,method,params}));return promise;
  }
  async evaluate(expression) {
    const result=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result.value;
  }
}
export async function connectPage(profile) {
  const port=await until(async()=>Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]));
  const target=await until(async()=>(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .find(item=>item.type==='page'&&item.webSocketDebuggerUrl));
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise,reject)=>{socket.onopen=resolvePromise;socket.onerror=reject;});
  const cdp=new Cdp(socket);await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Network.enable');
  return cdp;
}
