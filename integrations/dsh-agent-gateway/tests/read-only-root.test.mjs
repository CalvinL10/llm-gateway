import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply,assertExecutionSafety,toolsFor} from '../tools.js';

test('native read-only development root can investigate without widening sandbox or approvals',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'gateway-readonly-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await writeFile(join(cwd,'source.txt'),'evidence');
 let guard;const permissions={sandbox:'read-only',approval:'ask'};
 const ctx={tools:{guard:fn=>guard=fn},on(){},shell:{dockerExecutor:true},
  sessionProjections:{stateOf:()=>permissions},agentPresets:{serviceFor:()=>({schemas:()=>toolsFor('development',undefined,false,false).map(name=>({name}))})}};
 const agent={session:{header:{cwd},snapshotEvents:()=>[]}},policy={toolSet:'development',delegationEnabled:false};
 apply(ctx,{mode:'development',delegationEnabled:false});assert.doesNotThrow(()=>assertExecutionSafety(ctx,agent,policy));
 for(const name of ['read','glob','grep'])assert.equal(guard({name,agent,arguments:{file_path:'source.txt',path:cwd}}),undefined);
 for(const name of ['write','edit','pwsh','subagent','list_subagent_models'])assert.ok(guard({name,agent,arguments:{file_path:'source.txt'}}));
 assert.deepEqual(permissions,{sandbox:'read-only',approval:'ask'});
 permissions.approval='never';assert.throws(()=>assertExecutionSafety(ctx,agent,policy));assert.ok(guard({name:'read',agent,arguments:{file_path:'source.txt'}}));
 permissions.approval='ask';permissions.sandbox='danger-full-access';assert.throws(()=>assertExecutionSafety(ctx,agent,policy));assert.ok(guard({name:'read',agent,arguments:{file_path:'source.txt'}}));
});
