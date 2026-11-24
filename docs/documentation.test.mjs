import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import test from 'node:test';

const documents = [
  'README.md',
  'README.en.md',
  'AGENTS.md',
  'PLAN.md',
  'docs/architecture.md',
  'docs/history-snapshot.md',
  'docs/local-use.md',
  'docs/runbook.md',
  'docs/releases/v0.2.0.md',
  'docs/releases/v0.2.0.en.md',
  'integrations/dsh-agent-gateway/README.md',
  'integrations/dsh-agent-gateway/README.en.md',
  'legacy/python-cache-experiment/README.md',
];

test('current documentation has no broken relative Markdown links', async () => {
  const missing = [];
  for (const document of documents) {
    const markdown = await readFile(document, 'utf8');
    const links = markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
    for (const [, rawTarget] of links) {
      const target = rawTarget.split('#', 1)[0];
      if (/^file:/i.test(target)) { missing.push(`${document} -> hardcoded file URL (${target})`); continue; }
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || isAbsolute(target)) continue;
      const absolute = resolve(dirname(document), decodeURIComponent(target));
      if (!existsSync(absolute)) missing.push(`${document} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('shipped @llm-gateway/dsh-agent-gateway package contract targets exist on disk', async () => {
  const base = 'integrations/dsh-agent-gateway';
  const pkg = JSON.parse(await readFile(resolve(base, 'package.json'), 'utf8'));
  const missing = [];
  for (const entry of Object.values(pkg.exports ?? {})) {
    const full = resolve(base, entry);
    if (!existsSync(full)) missing.push(`export:${entry}`);
  }
  for (const item of pkg.files ?? []) {
    const full = resolve(base, item);
    if (!existsSync(full)) missing.push(`file:${item}`);
  }
  assert.deepEqual(missing, []);
});

test('documentation preserves core safety boundaries and archive traceability', async () => {
  const [readme, readmeEn, agents, snapshot, runbook] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.en.md', 'utf8'),
    readFile('AGENTS.md', 'utf8'),
    readFile('docs/history-snapshot.md', 'utf8'),
    readFile('docs/runbook.md', 'utf8'),
  ]);
  assert.ok(agents.split(/\r?\n/).length <= 80, 'AGENTS.md must stay <= 80 lines');
  assert.match(readme, /127\.0\.0\.1/);
  assert.match(readme, /unknown/);
  assert.match(readmeEn, /127\.0\.0\.1/);
  assert.match(readmeEn, /unknown/);
  assert.match(snapshot, /archive\/p01-p12-history/);
  assert.match(runbook, /ops\/lifecycle\.mjs/);
  assert.match(runbook, /ops\/maintenance\.mjs/);
  assert.match(runbook, /smoke\/web-smoke\.mjs/);
});
