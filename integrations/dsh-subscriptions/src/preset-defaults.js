// Edit native configuration rather than rewriting tool calls or replacing
// authorization. The native delegation tool resolves and checks these options.
export function childDefaults(config, route) {
  let count = 0;
  const visit = rows => rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    let next = row;
    if (row.name === '@deepseek-ai/dsh-tool-subagent' && row.config?.provider === 'spawn') {
      const agentOptions = {...row.config.agentOptions};
      for (const key of ['provider','model','reasoningEffort']) delete agentOptions[key];
      if (route) Object.assign(agentOptions,route);
      const toolConfig = {...row.config};
      if (Object.keys(agentOptions).length) toolConfig.agentOptions = agentOptions;
      else delete toolConfig.agentOptions;
      next = {...row,config:toolConfig}; count++;
    } else if (Array.isArray(row.config)) next = {...row,config:visit(row.config)};
    return next;
  });
  return {config:{...config,plugins:visit(config.plugins ?? [])},count};
}

export function configuredChildRoutes(config) {
  const result=[];
  const visit=rows=>{for (const row of rows ?? []) {
    if (row.name === '@deepseek-ai/dsh-tool-subagent' && row.config?.provider === 'spawn') {
      const {provider,model,reasoningEffort}=row.config.agentOptions ?? {};
      result.push(provider && model ? {provider,model,...reasoningEffort ? {reasoningEffort} : {}} : null);
    } else if (Array.isArray(row.config)) visit(row.config);
  }};
  visit(config.plugins); return result;
}

export function editablePresets(editor) {
  return editor.entries().filter(entry=>entry.options.name==='@deepseek-ai/dsh-agent-preset'
    && !/^(llm-gateway|gateway-agent)/.test(entry.options.config?.id ?? ''));
}
