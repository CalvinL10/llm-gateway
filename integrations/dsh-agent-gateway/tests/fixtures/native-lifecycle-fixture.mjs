// TEST ONLY. This endpoint is loaded only in an isolated credential-free Home.
// It exercises native receipts, not the P08 comparison scheduler, review or caps.
import {apply as applyGateway} from './index.js';
export {inject} from './index.js';
export const name = 'gateway-native-lifecycle-fixture';

export async function apply(ctx, config) {
  let runtime;
  const receipts = new Map(), cancellations = [];
  await applyGateway(ctx, config, {lifecycleBinding:{
    connect(value) { runtime = value; },
    onOperatorCancel(value) { cancellations.push(value); },
  }});
  ctx.connection.fetch.register({path:'/api/native-lifecycle-fixture', methods:['GET','POST'], requestBody:'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams;
      if (request.method === 'POST') {
        const input = await request.json();
        const receipt = query.has('id') ? await runtime.continue(query.get('id'), input) : await runtime.start(input);
        receipts.set(receipt.attemptId, receipt);
        return Response.json({synthetic:true, taskId:receipt.taskId, sessionId:receipt.sessionId, attemptId:receipt.attemptId});
      }
      const receipt = receipts.get(query.get('attempt'));
      if (!receipt) return Response.json({error:'NO_TEST_RECEIPT'}, {status:404});
      const ended = await receipt.done;
      return Response.json({synthetic:true, realModelCalls:0, cancellations, ...ended});
    }});
}
