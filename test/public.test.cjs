'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {issues}=require('../scripts/check-public.cjs');
const manifest=require('../package.json');
test('SQLQuay keeps the installed extension identity, settings and query entrypoints',()=>{
  assert.equal(manifest.displayName,'SQLQuay');
  assert.equal(manifest.publisher+'.'+manifest.name,'local-workbench.database-workbench');
  assert.equal(manifest.contributes.configuration.properties['dbWorkbench.guardPath'].default,'~/.sqlquay/policy/query_guard.py');
  assert.ok(manifest.contributes.commands.some(c=>c.command==='dbw.run'));
  assert.equal(manifest.repository.url,'https://github.com/POCO1010/sqlquay.git');
});
test('public content checks flag private data without repeating its value',()=>{
  const home=['','Users','example','settings'].join('/');
  const token='ghp_'+'x'.repeat(36);
  for(const text of [home,token,['password','"not-a-real-password"'].join('=')]) {
    const result=issues(text);assert.ok(result.length);assert.ok(!JSON.stringify(result).includes(text));
  }
  assert.deepEqual(issues('password="fixture"\nhttps://github.com/POCO1010/sqlquay'),[]);
});
