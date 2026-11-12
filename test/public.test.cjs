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

test('Marketplace packaging checks PNG dimensions before uploading',()=>{
  const {validateIcon}=require('../scripts/package.cjs');
  const png=size=>{const b=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(size,16);b.writeUInt32BE(size,20);return b;};
  for(const size of [128,512,1024]) assert.deepEqual(validateIcon(png(size)),{width:size,height:size});
  for(const size of [127,1025,1254]) assert.throws(()=>validateIcon(png(size)),/128 and 1024/);
  assert.throws(()=>validateIcon(Buffer.from('not a PNG')),/PNG/);
  assert.deepEqual(validateIcon(require('node:fs').readFileSync(require('node:path').join(__dirname,'..',manifest.icon))),{width:512,height:512});
});

test('the password label translation is allowed only in the runtime catalog',()=>{
  const label=['"Password"','"密码",'].join(': ');
  assert.deepEqual(issues(label,'media/i18n.js'),[]);
  assert.equal(issues(label,'config.json').length,1);
  assert.equal(issues(['password','"not-a-real-password"'].join('='),'media/i18n.js').length,1);
});
