import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Workflow, InputError } from './workflow.js';
import { dshRunner } from './runner.js';

export const name = 'llm-gateway-workflow';
export const inject = ['sessionController', 'agents', 'agentPresets', 'tools', 'sessionProjections', 'storageDomain', 'connection', 'webServer'];

const selection = z.object({connectionId: z.string(), connectionLabel: z.string(), provider: z.string(), model: z.string(), reasoningEffort: z.string()});
const stage = z.object({selection, sessionId: z.string(), status: z.enum(['pending','running','cancel-requested','completed','failed','stopped','unknown']),
  artifact: z.string().nullable(), startedAt: z.string().nullable(), endedAt: z.string().nullable(), elapsedMs: z.number().nullable(),
  error: z.object({code: z.string(), message: z.string()}).nullable(), usage: z.array(z.unknown()).nullable(), costUSD: z.null()}).passthrough();
const record = z.object({id: z.string(), createdAt: z.string(), status: z.enum(['running','cancel-requested','awaiting-decision','failed','stopped','unknown']),
  input: z.object({question: z.string(), materials: z.array(z.string()), constraints: z.string(), generation: selection, review: selection}),
  stages: z.object({generation: stage, review: stage}),
  decision: z.object({choice: z.enum(['accept','reject','defer']), note: z.string(), savedAt: z.string()}).nullable(),
  cancelRequestedAt: z.string().nullable().optional(), decisionHistory: z.array(z.unknown()).optional()});

export async function apply(ctx, config) {
  const parsed = z.object({cwd: z.string().min(1), connections: z.array(z.object({id: z.string().min(1), label: z.string().min(1), provider: z.string().min(1)})).min(1)}).parse(config);
  if (new Set(parsed.connections.map(c => c.id)).size !== parsed.connections.length) throw new Error('Duplicate connection id');
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Workflow requires loopback deployment');
  const domain = await ctx.storageDomain.open({name: 'gateway_workflows', version: 1, tables: {tasks: {valueSchema: record}}});
  const workflow = new Workflow(domain.table('tasks'), dshRunner(ctx, parsed.cwd), parsed.connections, () => ctx.sessionController.modelCatalog());
  await workflow.initialize();
  ctx.on('dispose', async () => { await workflow.drain(); await domain.close(); });
  const script = await readFile(new URL('./panel.js', import.meta.url), 'utf8');
  ctx.on('webserver/index-inject', rows => rows.push({kind: 'script', placement: 'body', text: script}));
  ctx.connection.fetch.register({path: '/api/gateway-workflows', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        let result;
        if (request.method === 'GET') {
          const query = new URL(request.url).searchParams;
          result = query.has('catalog') ? {connections: parsed.connections, models: await ctx.sessionController.modelCatalog()}
            : query.has('id') ? workflow.get(query.get('id')) : workflow.list();
        } else {
          if (!request.headers.get('content-type')?.startsWith('application/json')) throw new InputError('仅支持 JSON 文本输入');
          const body = await request.text();
          if (body.length > 160000) throw new InputError('请求过大');
          let value;
          try { value = JSON.parse(body); } catch { throw new InputError('JSON 无效'); }
          const query = new URL(request.url).searchParams, id = query.get('id'), action = query.get('action');
          if (action && (!id || !['cancel', 'retry'].includes(action))) throw new InputError('无效操作');
          result = action === 'cancel' ? await workflow.cancel(id, value) : action === 'retry' ? await workflow.retry(id, value)
            : id ? await workflow.decide(id, value) : await workflow.create(value);
        }
        return Response.json(result, {headers: {'Cache-Control': 'no-store'}});
      } catch (error) {
        return Response.json({error: error instanceof InputError ? error.message : '工作流服务错误；未自动重试'},
          {status: error instanceof InputError ? 400 : 500, headers: {'Cache-Control': 'no-store'}});
      }
    }});
}
