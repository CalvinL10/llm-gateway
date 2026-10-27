import {z} from 'zod';
import {childDefaults,configuredChildRoutes,editablePresets} from './preset-defaults.js';

export const name='gateway-model-defaults';
export const inject=['connection','sessionController','agentDefaultModel','configEditor'];
const route=z.object({provider:z.string().min(1),model:z.string().min(1),reasoningEffort:z.string().min(1).optional()}).strict();
const update=z.object({main:route.optional(),child:route.nullable().optional(),
  childSelection:z.object({enabled:z.boolean(),allowedModels:z.array(route.omit({reasoningEffort:true}))}).strict().optional()}).strict();

export function apply(ctx) {
  let writes=Promise.resolve();
  const state=async()=>({catalog:await ctx.sessionController.modelCatalog(),
    main:ctx.agentDefaultModel.currentSelection(),
    presets:editablePresets(ctx.configEditor).map(entry=>({id:entry.options.config.id,
      routes:configuredChildRoutes(entry.options.config)})),
    childSelection:ctx.get('subagentModelSelection')?.current() ?? null});
  ctx.connection.fetch.register({path:'/api/gateway-model-defaults',methods:['GET','POST'],requestBody:'buffered',async fetch(request) {
    if (request.method==='GET') return Response.json(await state());
    try {
      const text=await request.text();
      if (text.length>65536) return Response.json({error:'设置内容过大'},{status:413});
      const value=update.parse(JSON.parse(text));
      const operation=writes.then(async()=>{
        const catalog=await ctx.sessionController.modelCatalog();
        const available=route=>catalog.groups.some(group=>group.id===route.provider && group.models.some(model=>model.id===route.model));
        for (const selected of [value.main,value.child])
          if (selected && !available(selected)) throw new Error(`当前模型目录中没有 ${selected.provider}/${selected.model}`);
        const savedModels=ctx.get('subagentModelSelection')?.current()?.allowedModels ?? [];
        for(const selected of value.childSelection?.allowedModels ?? [])
          if(!available(selected)&&!savedModels.some(saved=>saved.provider===selected.provider&&saved.model===selected.model))
            throw new Error(`当前模型目录中没有 ${selected.provider}/${selected.model}`);
        if (value.childSelection?.enabled && value.childSelection.allowedModels.length===0)
          throw new Error('请至少选择一个允许子代理使用的模型');
        if (value.child !== undefined) {
          const targets=editablePresets(ctx.configEditor).filter(entry=>childDefaults(entry.options.config,value.child).count>0);
          if (targets.length===0) throw new Error('当前 profile 没有可配置的原生 spawn 子代理预设');
          for (const entry of targets) await ctx.configEditor.edit(entry,current=>childDefaults(current,value.child).config);
        }
        if (value.childSelection) {
          const entry=ctx.configEditor.entries().find(entry=>entry.options.name==='@deepseek-ai/dsh-tool-subagent/model-selection-settings');
          if (!entry) throw new Error('宿主未提供原生子代理模型设置');
          await ctx.configEditor.edit(entry,current=>({...current,...value.childSelection}));
        }
        if (value.main) await ctx.agentDefaultModel.saveSelection(value.main);
        return state();
      });
      writes=operation.catch(()=>{});
      return Response.json(await operation);
    } catch(error) {
      // Multiple native configuration writes keep their own persistence semantics;
      // report failure and let GET show what was actually saved, never claim rollback.
      return Response.json({error:error.message ?? '保存失败，请刷新查看已保存的设置'},{status:400});
    }
  }});
}
