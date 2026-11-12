'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {dmsConfig,makeDms,DmsStopped,listDmsProfiles,parseProfiles} = require('../src/dms.cjs');
const {dmsReadonly} = require('../src/query.cjs');
const target = {channel:'dms',name:'Fixture',database:'fixture',keyword:'fixture',databaseId:'9007199254740993'};
const ok = (stdout,stderr='') => ({code:0,stdout,stderr});
const plugin = ok('aliyun-cli-dms-enterprise   0.7.8\n');
const data = '{"status":"success","source":"dms","database_id":9007199254740993,"rows":[{"Type":"DECIMAL","Field":"price","Sample":9007199254740994.01,"Empty":null},{"Field":"id","Type":"BIGINT","Extra":"123\\\"x"}]}';
function adapter(t, response, commands = [], precheck = plugin) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dbw-dms-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const wrapper=path.join(temp,'execute_safe.py');
  fs.writeFileSync(wrapper,'');
  return makeDms({python:'python3',wrapper},async (command,args)=>{
    commands.push([command,args]);
    if (command==='aliyun') return precheck;
    if (response instanceof Error) throw response;
    return response;
  });
}
test('uses only plugin list then approved wrapper, with exact target and result precision', async t=>{
  const calls=[];
  const rows=await adapter(t,ok(data),calls)(target,'DESCRIBE fixture;');
  assert.deepEqual(calls[0],['aliyun',['plugin','list']]);
  assert.equal(calls[1][0],'python3');
  assert.equal(path.basename(calls[1][1][2]),'dms_timed.py');
  assert.deepEqual(calls[1][1].slice(4),['--database-keyword=fixture','--schema=fixture','--db-id='+target.databaseId,'--profile=dms-prod','--region=cn-hangzhou','--sql=DESCRIBE fixture']);
  assert.deepEqual(rows.columns.map(x=>x.name),['Field','Type','Sample','Empty','Extra']);
  assert.deepEqual(rows.rows,[['price','DECIMAL','9007199254740994.01',null,null],['id','BIGINT',null,null,'123"x']]);
  const first=await adapter(t,ok(data))(target,'DESCRIBE fixture;',1);
  assert.equal(first.truncated,true);
  await assert.rejects(adapter(t,ok(data))({...target,databaseId:'5'},'SELECT 1'),/bound target/);
});
test('DMS readiness and terminal-state errors do not retry or fall back', async t=>{
  const calls=[];
  await assert.rejects(adapter(t,ok(data),calls,ok('some-aliyun-cli-dms-enterprise-other'))(target,'SELECT 1'),/separately/);
  assert.equal(calls.length,1);
  const warning=JSON.stringify({status:'cleanup_failed',error:'synthetic-private-data'});
  await assert.rejects(adapter(t,ok(data,warning))(target,'SELECT 1'),e=>e instanceof DmsStopped && !e.message.includes('synthetic'));
  for (const status of ['server_state_unknown','timed_out_stopped']) {
    const attempts=[];
    await assert.rejects(adapter(t,{code:4,stdout:'',stderr:JSON.stringify({status})},attempts)(target,'SELECT 1'),DmsStopped);
    assert.equal(attempts.length,2);
  }
  await assert.rejects(adapter(t,{code:3,stdout:'',stderr:'{"status":"needs_split"}'})(target,'SELECT 1'),/scan budget/);
  await assert.rejects(adapter(t,{code:2,stdout:'',stderr:'{"status":"blocked","error":"Database metadata did not resolve to one target"}'})(target,'SELECT 1'),/instance, environment/);
  await assert.rejects(adapter(t,{code:2,stdout:'',stderr:JSON.stringify({status:'blocked',error:'External policy lacks required engine capabilities.'})})(target,'SELECT 1'),/compatible approved policy/);
  await assert.rejects(adapter(t,{code:null,stdout:'',stderr:''})(target,'SELECT 1'),DmsStopped);
});
test('validates DMS connection and rejects unsafe SQL before CLI execution', async t=>{
  assert.throws(()=>dmsConfig({...target,databaseId:'--help'}));
  assert.equal(dmsConfig({...target,user:'ignored',password:'ignored'}).password,undefined);
  const calls=[];
  const query=adapter(t,ok(data),calls);
  for (const sql of ['SELECT 1; DELETE FROM t','SHOW CREATE USER foo','SELECT `authentication_string` FROM users WHERE id=1 LIMIT 1',
    'SELECT GET_LOCK(1, 1)','EXPLAIN ANALYZE SELECT 1','SELECT id FROM t FOR UPDATE','SELECT /*! 1 */ 1']) await assert.rejects(query(target,sql));
  assert.equal(calls.length,0);
  assert.equal(dmsReadonly("SELECT 'SHOW CREATE USER';"),"SELECT 'SHOW CREATE USER'");
});

test('named profiles are listed without exposing credential columns or changing the active profile',async()=>{
 const output='Profile | Credential | Valid | Region | Language\n'+'team-fixture * | AK:***fixture | Valid | cn-beijing | en\n'+'expired | STS:***fixture | Invalid | cn-hangzhou | en\n';
 const expected=[{name:'team-fixture',region:'cn-beijing',valid:true},{name:'expired',region:'cn-hangzhou',valid:false}];
 assert.deepEqual(parseProfiles(output),expected);
 const calls=[];assert.deepEqual(await listDmsProfiles(async(command,args)=>{calls.push([command,args]);return ok(output);}),expected);
 assert.deepEqual(calls,[['aliyun',['configure','list']]]);
 assert.ok(!JSON.stringify(expected).includes('AK:'));
 assert.deepEqual(parseProfiles('no profiles'),[]);
 await assert.rejects(listDmsProfiles(async()=>{throw Error('private fixture error');}),/official CLI/);
});
test('ordinary and preview queries carry the selected profile and region; legacy defaults remain',async t=>{
 const calls=[];const query=adapter(t,ok(data),calls);
 const custom={...target,profile:'team-fixture',region:'cn-beijing'};
 await query(custom,'SELECT 1');
 assert.ok(calls[1][1].includes('--profile=team-fixture'));assert.ok(calls[1][1].includes('--region=cn-beijing'));
 await assert.rejects(query(custom,undefined,100,'products'),/Invalid preview columns/);
 assert.ok(calls[3][1].includes('--profile=team-fixture'));assert.ok(calls[3][1].includes('--region=cn-beijing'));
 for(const profile of ['--help','x\nprofile']) assert.throws(()=>dmsConfig({...target,profile}),/valid Aliyun/);
 assert.throws(()=>dmsConfig({...target,region:'x;bad'}),/valid Aliyun/);
});


test('exact instance and non-production environments reach ordinary and preview DMS adapters',async t=>{
  for(const environment of ['test','dev','pre']) {
    const calls=[],query=adapter(t,ok(data),calls);
    const bound={...target,environment,instanceId:'7',instanceName:'Fixture',engine:'mysql'};
    await query(bound,'SELECT 1');
    assert.ok(calls.at(-1)[1].includes('--environment='+environment));assert.ok(calls.at(-1)[1].includes('--instance-id=7'));
  }
  for(const input of [{...target,environment:'unknown'},{...target,instanceId:'--bad'},{...target,engine:'polardb_pg'}])assert.throws(()=>dmsConfig(input));
});

test('specific DMS reasons remain safe and cleanup failures always keep the stop latch',async t=>{
  for(const [code,message] of [['drds_multishard',/single-shard/],['drds_shard_unknown',/shard count is unknown/],['scan_unknown',/estimate is unknown/],['scan_limit',/scan limit/]]) {
    const diagnostic={code,phase:'preflight',estimatedRows:100001,maxRows:100000,secret:'fixture-secret'};
    const stderr=JSON.stringify({status:'needs_split',diagnostic,error:'fixture-secret'});
    for(const table of [undefined,'products']) await assert.rejects(adapter(t,{code:3,stdout:'',stderr})(target,table?undefined:'SELECT 1',100,table),error=>message.test(error.message) && error.diagnostic.code===code && error.diagnostic.estimatedRows===100001 && !JSON.stringify(error).includes('fixture-secret'));
  }
  const reports=[{status:'execution_failed',diagnostic:{code:'scan_limit',phase:'preflight'}},{status:'diagnostic',diagnostic:{phase:'cleanup'}},{status:'cleanup_failed'}, {status:'configuration_error',reason:'search_failed'}];
  await assert.rejects(adapter(t,{code:2,stdout:'',stderr:reports.map(JSON.stringify).join('\n')})(target,'SELECT 1'),error=>error instanceof DmsStopped && error.diagnostic.phase==='cleanup');
});
