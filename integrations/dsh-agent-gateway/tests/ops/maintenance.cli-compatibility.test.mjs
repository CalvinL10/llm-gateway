// Construction-review coverage, separate from the product Agent's two test files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const script=fileURLToPath(new URL('../../ops/maintenance.mjs',import.meta.url));
const scratch=mkdtempSync(join(tmpdir(),'p11b-cli-review-'));
const home=join(scratch,'must-not-exist');
test.after(()=>rmSync(scratch,{recursive:true,force:true}));
const invoke=args=>spawnSync(process.execPath,[script,...args],{
 cwd:scratch,env:{...process.env,DSH_HOME:home,HOME:home},encoding:'utf8',timeout:10000,windowsHide:true,
});
for(const flag of ['--help','-h'])test(flag+' needs no existing Home and creates no files',()=>{
 const before=readdirSync(scratch),r=invoke([flag]);
 assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
 for(const command of ['inspect','export','backup','restore','delete-plan','delete'])
  assert.match(r.stdout,new RegExp('^  '+command+'\\s','m'));
 for(const option of ['--home','--output','--backup','--plan','--confirm-home'])assert.ok(r.stdout.includes(option));
 assert.match(r.stdout,/stopped/);assert.match(r.stdout,/credentials and configuration are excluded/);
 assert.deepEqual(readdirSync(scratch),before);assert.equal(existsSync(home),false);
});
for(const args of [[],['unknown'],['--help','--home',home],['-h','extra'],['inspect'],['backup','--home',home],['restore','--home',home]])
 test('non-help arguments preserve JSON errors and zero side effects: '+args.slice(0,2).join(' '),()=>{
  const before=readdirSync(scratch),r=invoke(args);
  assert.ifError(r.error);assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.equal(typeof JSON.parse(r.stderr).error,'string');
  assert.deepEqual(readdirSync(scratch),before);assert.equal(existsSync(home),false);
 });
test('import with unrelated process arguments stays silent and leaves Home absent',()=>{
 const before=readdirSync(scratch),url=new URL('../../ops/maintenance.mjs',import.meta.url);
 const r=spawnSync(process.execPath,['--input-type=module','--eval',`await import(${JSON.stringify(url.href)})`,'--','delete','--plan','missing'],{
  cwd:scratch,env:{...process.env,DSH_HOME:home},encoding:'utf8',timeout:10000,windowsHide:true,
 });
 assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
 assert.deepEqual(readdirSync(scratch),before);assert.equal(existsSync(home),false);
});
