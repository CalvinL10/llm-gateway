// Test-only adapter. The public synthetic test selects every tool call; no model or auto-approval.
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
export const name = 'gateway-security-fixture';
export const inject = ['llm', 'agents', 'connection', 'sessionProjections'];
export function apply(ctx) {
  const calls = [];
  // Negative synthetic outcome only: no helper ever grants approval.
  ctx.on('approval/request', () => 'rejected', {prepend: true});
  class Fixture extends LlmAdapter {
    async listModels(provider) {return [{provider, id: 'scripted', name: 'Synthetic security fixture'}];}
    async *stream(options) {
      const agent = ctx.agents.get(options.sessionId);
      const results = options.messages.flatMap(m => m.content).filter(b => b.type === 'tool-result');
      const prompt = options.messages.find(m => m.role === 'user' && m.source?.kind !== 'tool').content.find(b => b.type === 'text').text;
      const goal = prompt.split('\n\nGateway workspace tool context:\n', 1)[0];
      const script = JSON.parse(goal);
      calls.push({sessionId: options.sessionId, child: agent.session.header.origin === 'subagent', results,
        permissions: ctx.sessionProjections.stateOf(agent.session, 'permissions')});
      const round = script.rounds.find(round => !results.some(r => r.toolCallId === round[0].id));
      const output = round?.map(t => ({type: 'tool-call', ...t, arguments: JSON.stringify(t.arguments)})) ??
        [{type: 'text', text: script.final ?? 'SYNTHETIC_PROBE_FINISHED'}];
      for (const [index, block] of output.entries()) {
        yield {type: 'block-start', index, blockType: block.type};
        if (block.type === 'text') yield {type: 'text-delta', index, text: block.text};
        yield {type: 'block-end', index, block};
      }
      yield {type: 'finish', reason: {kind: round ? 'tool-calls' : 'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture-security'], new Fixture());
  ctx.connection.fetch.register({path: '/api/security-fixture', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({calls})});
}
