'use strict';
const {execFileSync} = require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {makeJdbc,UnknownState}=require('../src/jdbc.cjs');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'dbw-driver-'));
async function main() {
  try {
    const driver=path.join(temp,'driver'),classes=path.join(temp,'build/jdbc');
    fs.mkdirSync(classes,{recursive:true});fs.mkdirSync(driver);fs.mkdirSync(path.join(temp,'scripts'));
    if(process.env.DBW_TEST_BRIDGE)fs.copyFileSync(process.env.DBW_TEST_BRIDGE,path.join(classes,'WorkbenchJdbc.class'));
    else execFileSync('javac',['-encoding','UTF-8','-d',classes,path.join(root,'scripts','WorkbenchJdbc.java')]);
    execFileSync('javac',['-encoding','UTF-8','-d',driver,path.join(root,'test','fixture','Driver.java')]);
    const manifest=path.join(temp,'manifest');
    fs.writeFileSync(manifest,'Manifest-Version: 1.0\nImplementation-Version: 8.0.32\n\n');
    const jar=path.join(temp,'fixture.jar');
    execFileSync('jar',['cfm',jar,manifest,'-C',driver,'.']);
    for (const script of ['jdbc_guard.py','preview_safe.py']) fs.copyFileSync(path.join(root,'scripts',script),path.join(temp,'scripts',script));
    const original=process.env.DBW_TEST_GUARD || path.join(os.homedir(),'.sqlquay/policy/query_guard.py');
    const guard=path.join(temp,'query_guard.py');
    fs.copyFileSync(original,guard);
    fs.appendFileSync(guard,"\nfrom functools import partial\nsingle_query_lock = partial(single_query_lock, path=Path(__file__).parent / 'test.lock')\n");
    const query=makeJdbc({jar,guard,java:'java',python:'python3'},temp);
    const connection={name:'fixture',engine:'mysql',host:'fixture.invalid',port:3306,database:'sandbox'};
    const auth={user:'reader',password:'synthetic'};
    const release=await require('./fixture/hold-lock.cjs')(temp);
    try {await assert.rejects(query(connection,auth,'SELECT 1 AS probe'),/already in flight/);}
    finally {await release();}
    assert.deepEqual((await query(connection,auth,'SHOW CREATE TABLE `sandbox`.`products`',1)).rows,[['products','CREATE TABLE products (id BIGINT)']]);
    const accepted=await query(connection,auth,'SELECT id, price FROM products WHERE id = 1 LIMIT 1');
    for(const phase of ['connect','preflight','execute']) assert.ok(accepted.timings[phase]>0,phase);
    assert.deepEqual(accepted.columns.map(c=>c.name),['same','same']);
    assert.deepEqual(accepted.rows,[['9007199254740993',null]]);
    await assert.rejects(query(connection,auth,'SELECT id FROM products WHERE id = 999 LIMIT 1'),/estimate/);
    await assert.rejects(query(connection,auth,'SELECT id FROM products LIMIT 1'),/bounded/);
    await assert.rejects(query(connection,auth,'EXPLAIN ANALYZE SELECT 1'),/executes/);
    await assert.rejects(query(connection,auth,'SELECT GET_LOCK(1, 3)'),/side-effect/);
    await assert.rejects(query(connection,auth,'SHOW CREATE USER reader'),/metadata/);
    await assert.rejects(query(connection,auth,'SELECT `authentication_string` FROM users WHERE id=1 LIMIT 1'),/Credential/);
    await assert.rejects(query(connection,auth,'SELECT 1 AS timeout_probe'),UnknownState);
    const sample=await query(connection,auth,undefined,100,'products');
    assert.equal(sample.rows.length,100);
    assert.deepEqual(sample.columns.map(c=>c.name),['id']);
    await assert.rejects(query(connection,auth,undefined,100,'unknown'),/Full-scan estimate/);
    await assert.rejects(query(connection,auth,undefined,100,'too_large'),/Full-scan estimate/);
    await assert.rejects(query(connection,auth,undefined,100,'preview_timeout'),UnknownState);
    assert.equal((await query({...connection,engine:'doris',port:9030},auth,undefined,100,'products')).rows.length,100);
    const olap=await query({...connection,engine:'doris',port:9030},auth,'SELECT id FROM products WHERE id = 1 LIMIT 1');
    assert.equal(olap.rows.length,1);
    const unencrypted=await query({...connection,port:3307,sslMode:'DISABLED'},auth,'SELECT 1 AS probe');
    assert.equal(unencrypted.rows.length,1);
    console.log('DBW_JDBC_FIXTURE_PASS');
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
