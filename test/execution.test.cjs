'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {progressReader,diagnosticError}=require('../src/execution.cjs');
const result=require('./fixture/result-dom.cjs');
test('DMS lifecycle owns the lock before authentication and through cleanup',()=>{
 assert.match(execFileSync('python3',['-I','-B',path.join(__dirname,'runtime-fixture.py')],{encoding:'utf8'}),/LIFECYCLE_RUNTIME_FIXTURE_PASS/);
});
test('progress accepts fragmented JSON lines and safe phases only',()=>{
 const phases=[],read=progressReader(p=>phases.push(p));
 read(Buffer.from('{"status":"progress","pha'));read(Buffer.from('se":"connect"}\n'));
 read(Buffer.from('{"status":"progress","phase":"fixture-secret"}\n{"status":"timing"}\n'));
 read(Buffer.from('x'.repeat(5000)));read(Buffer.from('{"status":"progress","phase":"execute"}\n'));
 read(Buffer.from('{"status":"progress","phase":"preflight"}\n'));
 assert.deepEqual(phases,['connect','preflight']);
});
test('diagnostics distinguish rejected plans without echoing raw messages',()=>{
 const a=diagnosticError({code:'drds_multishard',phase:'preflight',shards:8,secret:'fixture-secret'},'fallback');
 const b=diagnosticError({code:'scan_unknown',phase:'preflight'},'fallback');
 assert.notEqual(a.message,b.message);assert.ok(!JSON.stringify(a).includes('fixture-secret'));
 assert.deepEqual(a.diagnostic,{code:'drds_multishard',phase:'preflight',shards:8});
 assert.equal(diagnosticError({code:'untrusted',phase:'fixture-secret'},'fallback').message,'fallback');
});
test('both languages show live stages and exact safe metrics without replacing SQL edits',()=>{
 for(const language of ['zh-cn','en']) {
  const view=result(undefined,language);
  view.receive({id:1,state:'running',sql:'SELECT 1',target:'fixture',phase:'connect'});
  assert.match(view.get('message').textContent,language==='en'?/Connection/:/连接/);
  view.get('statement').value='SELECT 2';
  view.receive({id:1,state:'running',sql:'SELECT 1',target:'fixture',phase:'preflight'});
  assert.equal(view.get('statement').value,'SELECT 2');
  assert.match(view.get('message').textContent,language==='en'?/preflight/:/预检/);
  view.receive({id:1,state:'error',sql:'SELECT 1',target:'fixture',error:'refused',diagnostic:{code:'scan_limit',phase:'preflight',estimatedRows:100001,maxRows:100000}});
  assert.match(view.get('diagnostic').textContent,/100001/);assert.match(view.get('diagnostic').textContent,/100000/);
  view.receive({id:2,state:'done',sql:'SELECT 3',target:'fixture',result:{columns:[],rows:[],truncated:false}});
  assert.equal(view.get('diagnostic').hidden,true);
 }
});
