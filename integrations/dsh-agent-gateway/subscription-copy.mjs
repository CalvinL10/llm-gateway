// Local, dedicated deployment adaptation of the installed MIT subscription plugin.
// Never edit the shared installation or credentials. No hash/security changes.
// The first real run authorizes exact models and no internal generation retry.
export function singleAttemptSubscription(source) {
  const edits = [
    ['const fallback = resolveCodexFallbackModel(currentModel);', 'const fallback = undefined; // Gateway: no model substitution.'],
    ['if (response.status === 401) {\n\t\t\tawait response.body?.cancel()',
      'if (false) { // Gateway: return 401; reauthorize before a new task, never resend generation.\n\t\t\tawait response.body?.cancel()'],
    ['if (fallbackRuntime && !candidates.includes(fallbackRuntime)) candidates.push(fallbackRuntime);',
      '// Gateway: no runtime-model substitution.'],
    ['if (routing?.fallbackCandidates) {', 'if (false) { // Gateway: no cross-version fallback.'],
    ['for (const endpoint of endpointCandidates()) try {\n\t\t\t\tresponse = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {',
      'for (const endpoint of endpointCandidates().slice(0, 1)) try { // Gateway: one generation endpoint attempt.\n\t\t\t\tresponse = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {'],
  ];
  for (const [before,after] of edits) {
    // Ordinary patch application check, not a version freeze or quality gate.
    if (source.split(before).length !== 2) throw new Error('Installed subscription code needs manual patch review: '+before);
    source=source.replace(before,after);
  }
  return source;
}
