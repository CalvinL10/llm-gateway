// Minimal extra local adapter: loaded ONLY by the credential-free test overlay.
// Adding a connection + adapter requires no Workflow/runner Provider branches.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'gateway-local-extension-example';
export const inject = ['llm'];
export function apply(ctx) {
  class LocalExtension extends LlmAdapter {
    async listModels(provider) { return [{provider, id: 'example', name: 'Local extension example (no network)'}]; }
    async *stream() {
      const text = '本地扩展示例：独立审阅已收到文本；不是第三个真实 Provider。';
      yield {type: 'block-start', index: 0, blockType: 'text'};
      yield {type: 'text-delta', index: 0, text};
      yield {type: 'block-end', index: 0, block: {type: 'text', text}};
      yield {type: 'finish', reason: {kind: 'stop'}};
    }
  }
  ctx.llm.registerAdapter(['workflow-local-extension'], new LocalExtension());
}
