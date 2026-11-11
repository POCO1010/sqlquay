'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {issues}=require('../scripts/check-public.cjs');
const manifest=require('../package.json');
test('SQLQuay declares the confirmed publisher and MIT license without renaming query entrypoints',()=>{
  assert.equal(manifest.displayName,'SQLQuay');
  assert.equal(manifest.license,'MIT');
  assert.equal(manifest.icon,'media/icon.png');
  assert.ok(manifest.contributes.commands.some(c=>c.command==='dbw.importLegacy'));
  assert.equal(manifest.publisher+'.'+manifest.name,'TomMajor.sqlquay');
  assert.equal(manifest.contributes.configuration.properties['dbWorkbench.guardPath'].default,'');
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
