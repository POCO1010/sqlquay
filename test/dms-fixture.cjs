'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {makeDms,DmsStopped}=require('../src/dms.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dbw-dms-wrapper-'));
async function main() {
  const oldPath=process.env.PATH;
  try {
    const skill=process.env.DBW_TEST_DMS_SCRIPTS || path.join(os.homedir(),'.sqlquay/policy');
    const wrapper=path.join(temp,'execute_safe.py'), guard=path.join(temp,'query_guard.py'), log=path.join(temp,'calls');
    fs.copyFileSync(path.join(skill,'execute_safe.py'),wrapper);
    fs.copyFileSync(path.join(skill,'query_guard.py'),guard);
    fs.appendFileSync(guard,"\nfrom functools import partial\nsingle_query_lock = partial(single_query_lock, path=Path(__file__).parent / 'fixture.lock')\n");
    fs.writeFileSync(path.join(temp,'aliyun'),`#!${process.execPath}
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.join(' ')==='plugin list'){console.log('aliyun-cli-dms-enterprise 0.7.8');return;}
assert.equal(args[args.indexOf('--profile')+1],'dms-prod');
if(args[0]==='configure'){
  assert.equal(args[1],'ai-mode');
  assert.ok(['enable','set-user-agent','disable'].includes(args[2]));
  return;
}
assert.equal(args[0],'dms-enterprise');
if(args[1]==='search-database'){
  console.log(JSON.stringify({SearchDatabaseList:{SearchDatabase:[
    {SchemaName:'sandbox',EnvType:'product',DatabaseId:42,DbType:'mysql'},
    {SchemaName:'sandbox',EnvType:'test',DatabaseId:43,DbType:'mysql'},
    {SchemaName:'sandbox',EnvType:'product',DatabaseId:44,DbType:'selectdb'}
  ]}}));return;
}
assert.equal(args[1],'execute-script');
const dbId=args[args.indexOf('--db-id')+1];
assert.ok(['42','44'].includes(dbId));
const sql=args[args.indexOf('--script')+1];
let rows;
if(sql==='SHOW TABLES') rows=[{Tables_in_sandbox:'products'}];
else if(sql==='SHOW CREATE TABLE \`sandbox\`.\`products\`') rows=[{Table:'products','Create Table':'CREATE TABLE products (id BIGINT)'}];
else if(sql==='SELECT 1 AS probe') rows=[{probe:'1'}];
else if(sql.startsWith('SHOW INDEX')) rows=[{Key_name:'PRIMARY',Seq_in_index:1,Column_name:'id'}];
else if(sql.startsWith('SHOW CREATE TABLE ')) rows=[{Table:'fixture','Create Table':'CREATE TABLE fixture (id BIGINT)'}];
else if(sql.startsWith('DESCRIBE ')) rows=[{Field:'id',Type:'BIGINT'},{Field:'user_phone',Type:'varchar(64)'},{Field:'apiToken',Type:'varchar(64)'}];
else if(sql.startsWith('EXPLAIN SELECT \`id\` FROM \`sandbox\`.')) {
  assert.ok(!sql.includes('LIMIT') && !sql.includes('phone') && !sql.includes('apiToken'));
  rows=dbId==='44'
    ? [{Plan:'0:VOlapScanNode(2)\\n | cardinality='+(sql.includes('unknown') ? '-1' : '10,000,000')+', avgRowSize=1.0'}]
    : [{rows:sql.includes('too_large') ? 100001 : 100000}];
}
else if(sql.startsWith('EXPLAIN ')) rows=[{rows:sql.includes('id=2') ? 50 : 100001}];
else if(sql==='SELECT id FROM products WHERE id=2 LIMIT 1') rows=[{id:'2'}];
else if(sql.startsWith('SELECT /*+ ')) {
  assert.ok(!/too_large|unknown|phone|apiToken|WHERE/.test(sql));
  assert.match(sql,/LIMIT 100$/);
  assert.ok(sql.includes(dbId==='44' ? 'SET_VAR(query_timeout=5)' : 'MAX_EXECUTION_TIME(5000)'));
  if(sql.includes('preview_timeout')) {
    console.log(JSON.stringify({Results:[{Success:false,Message:'read timeout'}]}));return;
  }
  rows=Array.from({length:110},(_,i)=>({id:i}));
}
else if(sql==='SELECT 1 AS timeout_probe'){
  console.log(JSON.stringify({Results:[{Success:false,Message:'execute script timeout'}]}));return;
}
else throw Error('Unexpected fixture SQL');
console.log(JSON.stringify({Results:[{Success:true,Rows:rows}]}));
`,{mode:0o700});
    process.env.PATH=temp + path.delimiter + oldPath;
    const query=makeDms({python:'python3',wrapper});
    const target={name:'fixture',keyword:'sandbox',database:'sandbox',databaseId:'42'};
    const release=await require('./fixture/hold-lock.cjs')(temp);
    try {
      await assert.rejects(query(target,'SELECT 1 AS probe'),/Another governed query/);
      await assert.rejects(query(target,undefined,100,'products'),/Another governed query/);
      const blockedCalls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(blockedCalls.some(args=>args.includes('execute-script')),false);
    } finally {await release();}
    assert.deepEqual((await query(target,'SHOW TABLES',10000)).rows,[['products']]);
    assert.deepEqual((await query(target,'SHOW CREATE TABLE `sandbox`.`products`',1)).rows,[['products','CREATE TABLE products (id BIGINT)']]);
    const probe=await query(target,'SELECT 1 AS probe');
    assert.deepEqual(probe.rows,[['1']]);
    assert.ok(probe.timings.connect>0);assert.ok(probe.timings.execute>0);assert.equal(probe.timings.preflight,0);
    const bounded=await query(target,'SELECT id FROM products WHERE id=2 LIMIT 1');
    assert.deepEqual(bounded.rows,[['2']]);
    for(const phase of ['connect','preflight','execute'])assert.ok(bounded.timings[phase]>0);
    await assert.rejects(query({...target,databaseId:'43'},'SELECT 1 AS probe'),/product environment/);
    await assert.rejects(query(target,'SELECT id FROM products WHERE id=1 LIMIT 1'),/scan budget/);
    await assert.rejects(query(target,'SELECT 1 AS timeout_probe'),DmsStopped);
    const sample=await query(target,undefined,100,'products');
    assert.equal(sample.rows.length,100);
    assert.ok(sample.timings.preflight>0);
    assert.deepEqual(sample.columns.map(c=>c.name),['id']);
    await assert.rejects(query(target,undefined,100,'too_large'),/扫描上限/);
    const warehouse={...target,databaseId:'44'};
    assert.equal((await query(warehouse,undefined,100,'products')).rows.length,100);
    await assert.rejects(query(warehouse,undefined,100,'unknown'),/扫描上限/);
    await assert.rejects(query(warehouse,undefined,100,'preview_timeout'),DmsStopped);
    const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(a=>a[0]==='plugin').length,14);
    assert.equal(calls.filter(a=>a[0]==='configure'&&a[2]==='disable').length,13);
    assert.equal(calls.filter(a=>a.includes('SELECT 1 AS timeout_probe')).length,1);
    assert.equal(calls.some(a=>a.includes('SELECT id FROM products WHERE id=1 LIMIT 1')),false);
    assert.equal(calls.filter(a=>a.some(v=>v.startsWith('SELECT /*+') && v.includes('preview_timeout'))).length,1);
    assert.equal(calls.filter(a=>a.some(v=>v.startsWith('SELECT /*+'))).length,3);
    console.log('DBW_DMS_WRAPPER_FIXTURE_PASS');
  } finally {
    process.env.PATH=oldPath;
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
