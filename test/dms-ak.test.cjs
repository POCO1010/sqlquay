'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {dmsConfig,makeDms,accessKeyCredentials,searchDmsDatabases,DmsStopped}=require('../src/dms.cjs');
const auth={accessKeyId:'fixture-key-id',accessKeySecret:'fixture-key-secret'};
const target={channel:'dms',authMode:'accessKey',name:'Independent',region:'cn-beijing',keyword:'sandbox',database:'sandbox',databaseId:'42'};
test('independent credentials are validated, excluded from metadata and never passed in arguments',async()=>{
  const config=dmsConfig({...target,...auth,profile:'must-not-use'});
  for(const key of ['accessKeyId','accessKeySecret','profile']) assert.equal(config[key],undefined);
  assert.equal(config.authMode,'accessKey');
  for(const value of [{},{accessKeyId:'x'},{...auth,accessKeySecret:'x\nsecret'},{...auth,accessKeyId:'x'.repeat(257)}]) assert.throws(()=>accessKeyCredentials(value),/both AccessKey/);
  const calls=[];
  const query=makeDms({python:'python3',wrapper:'/not-used/execute_safe.py'},async(command,args,input)=>{
    calls.push({command,args});assert.deepEqual(input,auth);assert.ok(!args.join(' ').includes(auth.accessKeySecret));
    return {code:0,stdout:'{"status":"success","source":"dms","database_id":"42","rows":[{"probe":"1"}]}',stderr:''};
  });
  await query(target,'SELECT 1',200,undefined,auth);assert.equal(calls.length,1);
  assert.equal(path.basename(calls[0].args[2]),'dms_ak.py');assert.equal(calls[0].args[3],'query');
  assert.ok(calls[0].args.includes('--profile=sqlquay'));
  assert.ok(!JSON.stringify(calls).includes('/not-used/'));
  await assert.rejects(query(target,'DELETE FROM t',200,undefined,auth));assert.equal(calls.length,1);
});
test('search validates metadata and surfaces cleanup failures before configuration errors',async()=>{
  await assert.rejects(searchDmsDatabases({python:'python3'},target,auth,async()=>({code:2,stdout:'',stderr:'{"status":"cleanup_failed"}\n{"status":"configuration_error","reason":"search_failed"}'})),DmsStopped);
  await assert.rejects(searchDmsDatabases({python:'python3'},target,auth,async()=>({code:0,stdout:'{"status":"success","databases":[{"databaseId":"--bad"}],"more":false}',stderr:''})),/search failed/);
  await assert.rejects(searchDmsDatabases({python:'python3'},target,auth,async()=>({code:2,stdout:'',stderr:'{"status":"configuration_error","reason":"plugin_missing"}'})),/separately/);
});
test('real local AK runner isolates CLI files and environment; search, query and preview retain all gates',async t=>{
  const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'sqlquay-ak-fixture-'));
  const before={...process.env},project=path.join(temp,'project'),log=path.join(temp,'calls.jsonl');
  t.after(()=>{for(const key of Object.keys(process.env)) if(!Object.hasOwn(before,key)) delete process.env[key];Object.assign(process.env,before);fs.rmSync(temp,{recursive:true,force:true});});
  for(const dir of ['src','scripts','policy']) fs.mkdirSync(path.join(project,dir),{recursive:true});
  for(const file of ['src/dms.cjs','src/execution.cjs','src/jdbc.cjs','src/query.cjs','scripts/dms_ak.py','scripts/dms_catalog.py','scripts/dms_timed.py','scripts/preview_safe.py','policy/execute_safe.py','policy/query_guard.py','policy/engine_policy.py','policy/workbench_runtime.py']) fs.copyFileSync(path.join(root,file),path.join(project,file));
  fs.appendFileSync(path.join(project,'policy/query_guard.py'),"\nfrom functools import partial\nsingle_query_lock=partial(single_query_lock,path=Path(__file__).parent/'fixture.lock')\n");
  const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
  fs.writeFileSync(path.join(temp,'aliyun'),'#!'+python+'\n'+String.raw`
import json, os, sys
from pathlib import Path
a=sys.argv[1:]
assert os.environ['ALIBABA_CLOUD_IGNORE_PROFILE']=='TRUE'
assert os.environ['ALIBABA_CLOUD_PROFILE_MODE']=='AK'
assert os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID']=='fixture-key-id'
assert os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET']=='fixture-key-secret'
assert os.environ['ALIBABA_CLOUD_RETRY_COUNT']=='0'
assert os.environ['ALIBABA_CLOUD_CLI_PLUGIN_AUTO_INSTALL']=='false'
assert 'ALIBABACLOUD_ACCESS_KEY_ID' not in os.environ
assert 'ALIBABA_CLOUD_ENDPOINT' not in os.environ
assert 'DEBUG' not in os.environ
assert 'fixture-key-secret' not in ' '.join(a)
home=Path(os.environ['HOME']);assert home.name.startswith('sqlquay-dms-')
config=home/'.aliyun'/'config.json';assert not config.exists()
assert home.stat().st_mode & 0o777==0o700
assert '--config-path' not in a
assert os.environ['ALIBABA_CLOUD_CLI_PLUGINS_DIR']
with open(os.environ['SQLQUAY_FIXTURE_LOG'],'a') as f:f.write(json.dumps({'operation':a[:3],'config':str(config),'script':a[a.index('--script')+1] if '--script' in a else ''})+'\n')
if a[:2]==['plugin','list']:
 print('aliyun-cli-dms-enterprise 0.7.8');sys.exit(0)
assert a[a.index('--profile')+1]=='sqlquay'
if a[:2]==['configure','ai-mode']:
 if a[2]=='disable' and os.environ.get('SQLQUAY_FIXTURE_FAIL')=='cleanup':sys.exit(1)
 config.parent.mkdir(exist_ok=True)
 (config.parent/'ai-mode.json').write_text(json.dumps({'enabled':a[2]!='disable'}));sys.exit(0)
assert a[0]=='dms-enterprise'
assert a[a.index('--region')+1]=='cn-beijing'
instances=[dict(InstanceId=str(i+7),InstanceAlias='Fixture '+str(i),InstanceType=kind,EnvType=env,State='NORMAL') for i,(kind,env) in enumerate([('mysql','product'),('polardb','dev'),('drds','pre'),('selectdb','test'),('ots','product')])]
if a[1]=='list-instances':
 assert '--cli-query' in a
 print(json.dumps({'Success':True,'TotalCount':101,'InstanceList':{'Instance':instances}}));sys.exit(0)
if a[1]=='list-databases':
 identity=a[a.index('--instance-id')+1];instance=next(x for x in instances if x['InstanceId']==identity)
 row=dict(SchemaName='sandbox',DatabaseId=str(420+int(identity)),InstanceId=identity,DbType=instance['InstanceType'],EnvType=instance['EnvType'],State='NORMAL')
 print(json.dumps({'Success':True,'TotalCount':1,'DatabaseList':{'Database':[row]}}));sys.exit(0)
if a[1]=='search-database':
 if os.environ.get('SQLQUAY_FIXTURE_FAIL')=='search':print('fixture-key-secret',file=sys.stderr);sys.exit(1)
 print(json.dumps({'Success':True,'TotalCount':101,'SearchDatabaseList':{'SearchDatabase':[
 {'SchemaName':'sandbox','DatabaseId':'42','EnvType':'product','DbType':'mysql','Alias':'Sample'},
 {'SchemaName':'sandbox','DatabaseId':'43','EnvType':'test','DbType':'mysql'},
 {'SchemaName':'other','DatabaseId':'44','EnvType':'product','DbType':'postgresql'},
 {'SchemaName':'logic','DatabaseId':'45','EnvType':'product','DbType':'mysql','Logic':True}]}}));sys.exit(0)
assert a[1]=='execute-script'
s=a[a.index('--script')+1]
if s=='SELECT 1 AS timeout_probe':
 print(json.dumps({'Results':[{'Success':False,'Message':'execute script timeout'}]}));sys.exit(0)
elif s=='SELECT 1 AS probe':rows=[{'probe':'1'}]
elif s=='SHOW FULL TABLES':rows=[{'Table_type':'BASE TABLE','Tables_in_sandbox':'products'}]
elif s.startswith('SHOW CREATE TABLE'):rows=[{'Table':'products','Create Table':'CREATE TABLE products (id BIGINT)'+(' ENGINE=Tablestore' if a[a.index('--db-id')+1]=='431' else '')}]
elif s.startswith('SHOW INDEX'):rows=[{'Key_name':'PRIMARY','Column_name':'id','Seq_in_index':1}]
elif s.startswith('EXPLAIN SHARDING'):
 assert 'LIMIT 100' not in s;rows=[{'SHARD_COUNT':2 if 'multi_shard' in s else 1}]
elif s.startswith('EXPLAIN EXECUTE'):rows=[{'rows':100001 if 'large' in s else 100000}]
elif s.startswith('/*TDDL:SOCKET_TIMEOUT=5000*/'):
 assert 'password' not in s
 if 'drds_timeout' in s:
  print(json.dumps({'Results':[{'Success':False,'Message':'ERR_SQL_QUERY_TIMEOUT'}]}));sys.exit(0)
 rows=[{'id':'1'}]
elif s.startswith('DESCRIBE'):rows=[{'Field':'id','Type':'BIGINT'},{'Field':'password','Type':'varchar(255)'}]
elif s.startswith('EXPLAIN'):rows=[{'rows':100001 if 'large' in s else 2}]
elif s.startswith('SELECT /*+'):
 assert 'LIMIT 100' in s and 'password' not in s;rows=[{'id':'1'},{'id':'2'}]
else:raise AssertionError('Unexpected SQL')
print(json.dumps({'Results':[{'Success':True,'Rows':rows}]}))
`);fs.chmodSync(path.join(temp,'aliyun'),0o700);
  Object.assign(process.env,{PATH:temp+path.delimiter+before.PATH,SQLQUAY_FIXTURE_LOG:log,ALIBABACLOUD_ACCESS_KEY_ID:'not-used',ALIBABA_CLOUD_ENDPOINT:'https://not-used.invalid',DEBUG:'sdk'});
  const local=require(path.join(project,'src/dms.cjs'));
  const found=await local.searchDmsDatabases({python},target,auth);
  assert.deepEqual(found,{databases:[{database:'sandbox',databaseId:'42',engine:'mysql',environment:'product',label:'sandbox · Sample · mysql · #42'},{database:'sandbox',databaseId:'43',engine:'mysql',environment:'test',label:'sandbox · mysql · #43'}],more:true});
  const query=local.makeDms({python,wrapper:'/not-used/execute_safe.py'});
  assert.deepEqual((await query(target,'SELECT 1 AS probe',200,undefined,auth)).rows,[['1']]);
  const sample=await query(target,undefined,100,'products',auth);
  assert.deepEqual(sample.columns.map(c=>c.name),['id']);assert.deepEqual(sample.rows,[['1'],['2']]);
  await assert.rejects(query(target,undefined,100,'large',auth),/scan limit/);
  await assert.rejects(query(target,'SELECT 1 AS timeout_probe',200,undefined,auth),local.DmsStopped);
  const calls=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  let entries=calls();assert.ok(entries.some(row=>row.script==='EXPLAIN SELECT `id` FROM `sandbox`.`products`'));
  assert.ok(!entries.some(row=>row.script.startsWith('SELECT /*+') && row.script.includes('large')));
  assert.equal(entries.filter(row=>row.operation[0]==='configure'&&row.operation[2]==='disable').length,5);
  for(const row of entries)assert.ok(!fs.existsSync(path.dirname(row.config)));
  assert.ok(!fs.readFileSync(log,'utf8').includes(auth.accessKeySecret));
  const inventory=await local.dmsCatalog({python},{kind:'instances',region:'cn-beijing',keyword:'',page:1},auth);
  assert.deepEqual(inventory.instances.map(i=>[i.engine,i.environment]),[['mysql','product'],['polardb','dev'],['drds','pre'],['selectdb','test'],['ots','product']]);
  assert.equal(inventory.more,true);assert.equal(inventory.page,1);
  const filtered=await local.dmsCatalog({python},{kind:'instances',region:'cn-beijing',keyword:'',page:1,environment:'test'},auth);
  assert.deepEqual(filtered.instances.map(i=>i.engine),['selectdb']);
  const libraries=await local.dmsCatalog({python},{kind:'databases',region:'cn-beijing',...inventory.instances[4],keyword:'',page:1},auth);
  assert.equal(libraries.databases[0].engine,'ots');assert.equal(libraries.databases[0].instanceId,'11');
  assert.ok(!JSON.stringify(libraries).includes('DatabasePassword'));assert.ok(!JSON.stringify(libraries).includes(auth.accessKeyId));
  const drdsLibrary=await local.dmsCatalog({python},{kind:'databases',region:'cn-beijing',...inventory.instances[2],keyword:'',page:1},auth);
  const drds={...target,...drdsLibrary.databases[0]};
  assert.deepEqual((await query(drds,'SELECT id FROM products WHERE id=1 LIMIT 1',200,undefined,auth)).rows,[['1']]);
  const drdsPreview=await query(drds,undefined,100,'products',auth);assert.deepEqual(drdsPreview.rows,[['1']]);
  assert.ok(drdsPreview.timings.preflight>0 && drdsPreview.timings.execute>0);
  await assert.rejects(query(drds,'SELECT id AS multi_shard FROM products WHERE id=1 LIMIT 1',200,undefined,auth),error=>error.diagnostic?.code==='drds_multishard' && error.diagnostic.shards===2);
  await assert.rejects(query(drds,'SELECT id FROM products WHERE id=1 LIMIT 1',200,'large',auth),/scan limit/);
  await assert.rejects(query(drds,'SELECT id AS drds_timeout FROM products WHERE id=1 LIMIT 1',200,undefined,auth),local.DmsStopped);
  assert.equal(calls().filter(x=>x.script.startsWith('/*TDDL:') && x.script.includes('drds_timeout')).length,1);
  assert.ok(!calls().some(x=>x.script.startsWith('/*TDDL:') && /large|multi_shard/.test(x.script)));
  const ots={...target,...libraries.databases[0]};
  assert.deepEqual((await query(ots,'SHOW TABLES',10000,undefined,auth)).rows,[['BASE TABLE','products']]);
  assert.deepEqual((await query(ots,'SHOW CREATE TABLE `products`',1,undefined,auth)).rows,[['products','CREATE TABLE products (id BIGINT) ENGINE=Tablestore']]);
  assert.deepEqual((await query(ots,'DESCRIBE `products`',10000,undefined,auth)).rows[0],['id','BIGINT']);
  assert.ok(calls().some(x=>x.script==='SHOW FULL TABLES'));
  const dataBefore=calls().filter(x=>x.operation[1]==='execute-script').length;
  await assert.rejects(query({...target,...libraries.databases[0]},'SELECT id FROM products WHERE id=1 LIMIT 1',200,undefined,auth),/Tablestore/);
  assert.equal(calls().filter(x=>x.operation[1]==='execute-script').length,dataBefore);
  process.env.SQLQUAY_FIXTURE_FAIL='search';
  await assert.rejects(local.searchDmsDatabases({python},target,auth),error=>!error.message.includes(auth.accessKeySecret) && /search failed/.test(error.message));
  process.env.SQLQUAY_FIXTURE_FAIL='cleanup';
  await assert.rejects(local.searchDmsDatabases({python},target,auth),error=>error instanceof local.DmsStopped);
  entries=calls();assert.equal(entries.filter(row=>row.operation[1]==='search-database').length,7);
  delete process.env.SQLQUAY_FIXTURE_FAIL;
  let completed=false;const phases=[];
  const live=local.makeDms({python,onProgress:phase=>{assert.equal(completed,false);phases.push(phase);}});
  await live(target,'SELECT 1 AS probe',200,undefined,auth);completed=true;
  assert.deepEqual(phases,['prepare','waiting','connect','resolve','preflight','execute','cleanup']);
});
