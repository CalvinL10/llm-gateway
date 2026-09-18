// Scripted TEST responses only. Production scheduling lives in the native model/tool loop.
export const text = value => ({type:'text',text:value});
const tool = (id,name,args) => ({type:'tool-call',id,name,arguments:JSON.stringify(args)});
const child = (id,prompt,provider='fixture-deep',model='flash-a') =>
  tool(id,'subagent',{description:'Focused local test task',prompt,provider,model});

export function responseFor({isChild,goal,results,ordinal}) {
  if (isChild) return [text(goal.includes('follow-up') ? 'VERIFIED'
    : goal.includes('recovered') ? 'RECOVERED'
    : goal.includes('first') ? 'NEED_FOLLOWUP' : 'SECOND_RESULT')];
  if (goal.includes('simple')) return [text('DIRECT_ANSWER')];
  if (goal.includes('loop')) return [tool('catalog-'+ordinal,'list_subagent_models',{})];
  if (!results.some(r=>r.toolCallId==='catalog')) return [tool('catalog','list_subagent_models',{})];
  if (goal.includes('cancel')) return [child('waiting','wait-for-cancel')];
  if (goal.includes('forbidden')) return results.some(r=>r.toolCallId==='forbidden')
    ? [text('Unauthorized delegation rejected')] : [child('forbidden','do not execute','fixture-forbidden','other')];
  if (goal.includes('recover')) {
    if (!results.some(r=>r.toolCallId==='failedchild')) return [child('failedchild','fail-child')];
    if (!results.some(r=>r.toolCallId==='recovery')) return [child('recovery','recovered task','fixture-google','flash-b')];
  } else {
    if (!results.some(r=>r.toolCallId==='first')) return [child('first','first independent task'),child('second','second independent task','fixture-google','flash-b')];
    if (results.some(r=>JSON.stringify(r).includes('NEED_FOLLOWUP')) && !results.some(r=>r.toolCallId==='followup'))
      return [child('followup','follow-up on NEED_FOLLOWUP','fixture-google','flash-b')];
  }
  return [text('SYNTHESIS: '+results.filter(r=>r.toolCallId!=='catalog').map(r=>JSON.stringify(r.content)).join('\n'))];
}
