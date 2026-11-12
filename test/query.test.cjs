const assert = require('node:assert/strict');
const {test} = require('node:test');
const {pickSql,readonly,demoQuery,quoteTable} = require('../src/query.cjs');
const {connectionConfig,makeJdbc,UnknownState} = require('../src/jdbc.cjs');
const {connectHtml,resultHtml} = require('../src/webviews.cjs');
const os = require('node:os'), fs=require('node:fs'), path=require('node:path');

test('run current statement vs selection; semicolon in strings and comments is not a boundary',()=>{
  const sql = "SELECT 'a;';\n-- ignored ;\nSELECT 1 AS probe;\n";
  assert.equal(pickSql(sql,0,''),"SELECT 'a;';");
  assert.equal(readonly(pickSql(sql,sql.indexOf('probe'),'')),'SELECT 1 AS probe');
  assert.equal(pickSql(sql,0,' SELECT 1; '),'SELECT 1;');
  for(const statement of ['DELETE FROM products','SELECT 1; SELECT 2','/*! SELECT 1 */ SELECT 1','/*M! SELECT 1 */ SELECT 1','SELECT 1;; SELECT 2']) assert.throws(()=>readonly(statement));
  assert.equal(quoteTable('one`two'),'`one``two`');
});
test('offline SQL produces an ordered grid, supports scope, errors on unknown columns or SQL',()=>{
  const data=demoQuery('SELECT id,price,price FROM products WHERE id = 5 LIMIT 1;');
  assert.deepEqual(data.columns.map(x=>x.name),['id','price','price']);
  assert.deepEqual(data.rows,[['5',null,null]]);
  assert.deepEqual(demoQuery('SELECT 1 AS probe;').rows,[['1']]);
  assert.deepEqual(demoQuery('SHOW TABLES;').rows,[['products']]);
  assert.deepEqual(demoQuery('DESC `products`;').rows.map(r=>r[0]),['id','name','category','price']);
  assert.throws(()=>demoQuery('SELECT email FROM products LIMIT 1'));
});
test('JDBC validates target and sends credentials over stdin, keeps SQL NULL and duplicate labels', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbw-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const jar=path.join(dir,'test.jar'), guard=path.join(dir,'query_guard.py');
  for(const file of [jar,guard]) fs.writeFileSync(file,'');
  const target=connectionConfig({name:'fixture',host:'localhost',port:'3306',database:'sandbox',engine:'mysql'});
  assert.equal(target.sslMode,'VERIFY_IDENTITY');
  assert.equal(target.environment,undefined);
  assert.equal(connectionConfig({...target,port:'3306',environment:'test'}).environment,'test');
  assert.throws(()=>connectionConfig({...target,port:'3306',environment:'invalid'}),/environment label/);
  assert.throws(()=>connectionConfig({...target,port:'3306',sslMode:'PREFERRED'}),/TLS mode/);
  for(const host of ['example.com?allowMultiQueries=true','localhost:1','a,b']) assert.throws(()=>connectionConfig({...target,port:'3306',host}));
  const settings={jar,guard,java:'java',python:'python3'};
  const fake=makeJdbc(settings,dir,async(command,args,body)=>{
    assert.equal(command,'python3');
    assert.equal(args.includes('fixture-secret'),false);
    assert.equal(body.password,'fixture-secret');
    assert.equal(body.url,'jdbc:mysql://localhost:3306/sandbox');
    assert.equal(body.sql,'SELECT 1 AS probe');
    assert.equal(body.sslMode,'VERIFY_IDENTITY');
    return {columns:[{name:'a',type:'BIGINT'},{name:'a',type:'INT'}],rows:[['9007199254740993',null]],truncated:false};
  });
  const credentials={user:'reader',password:'fixture-secret'};
  assert.deepEqual((await fake(target,credentials,'SELECT 1 AS probe;')).rows,[['9007199254740993',null]]);
  assert.deepEqual((await fake({...target,environment:'legacy-custom'},credentials,'SELECT 1 AS probe;')).rows,[['9007199254740993',null]]);
  await assert.rejects(makeJdbc(settings,dir,async()=>({error:'unknown'}))(target,credentials,'SELECT 1'),UnknownState);
});
test('webviews load local assets and define the action order',()=>{
  const assets={css:'test.css',script:'test.js',i18n:'i18n.js',icon:'database.svg',csp:"'self'"};
  for(const template of [connectHtml,resultHtml]) {
    const html=template(assets);
    assert.match(html,/connect-src 'none'/);
    assert.match(html,/<script nonce="[a-zA-Z\d+/]+" src="test\.js"><\/script>/);
  }
  assert.match(connectHtml(assets),/Server Type[\s\S]+Host[\s\S]+Username[\s\S]+Save[\s\S]+Connect/);
  assert.match(resultHtml(assets),/id="statement"[\s\S]+id="filter"[\s\S]+SQL results/);
});
