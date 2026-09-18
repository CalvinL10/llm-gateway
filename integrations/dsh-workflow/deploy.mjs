import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, '../..');
const target = resolve(root, '.local/dsh-task02/gateway-workflow');
await mkdir(target, {recursive: true});
for (const file of ['package.json', 'index.js', 'workflow.js', 'runner.js', 'panel.js']) await copyFile(resolve(source, file), resolve(target, file));
// Invocation overlay; does not overwrite the existing Home/Web profile patch.
const patch = [
  '- id: session-title-llm', '  disabled: true',
  '- id: llm-retry', '  disabled: true',
  '- insert:', '    - id: gateway-workflow', `      name: ${JSON.stringify(resolve(target, 'index.js').replaceAll('\\','/'))}`,
  '      config:', `        cwd: ${JSON.stringify(resolve(root, '.local/dsh-task02-workspace').replaceAll('\\','/'))}`,
  '        connections:', '          - id: chatgpt-existing', '            label: ChatGPT · 已连接订阅账号', '            provider: codex-chatgpt',
  '          - id: google-existing', '            label: Google · 已连接订阅账号', '            provider: antigravity', '',
].join('\n');
await writeFile(resolve(target, 'web.patch.yml'), patch);
console.log('Prepared local Web invocation overlay:', resolve(target, 'web.patch.yml'));
