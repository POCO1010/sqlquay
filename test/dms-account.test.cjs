'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {dmsAccountConfig,dmsTargets,isDmsAccount}=require('../src/dms.cjs');
const databases=[{keyword:'sand',database:'sandbox',databaseId:'42'},{keyword:'orders',database:'orders',databaseId:'43'}];
const account={channel:'dms',authMode:'accessKey',name:'Team DMS',group:'',region:'cn-beijing',databases};
test('one AK account validates independent exact database targets without accepting secrets or client IDs',()=>{
  const config=dmsAccountConfig({...account,accessKeyId:'not-metadata',accessKeySecret:'not-metadata',databases:databases.map(row=>({...row,id:'untrusted'}))});
  assert.deepEqual(config,account);
  assert.equal(isDmsAccount(config),true);
  for(const input of [{...account,databases:[]},{...account,databases:[databases[0],databases[0]]},{...account,authMode:'profile'},{...account,databases:[{...databases[0],databaseId:'--help'}]}])assert.throws(()=>dmsAccountConfig(input));
});
test('database identities and revisions stay separate from the shared credential owner',()=>{
  const legacy={channel:'dms',authMode:'accessKey',id:'saved',revision:'r1',name:'Saved',region:'cn-beijing',...databases[0]};
  assert.deepEqual(dmsTargets(legacy),[legacy]);
  const multi={...account,id:'saved',revision:'r1',databases:[{...databases[0],id:'saved'},{...databases[1],id:'second'}]};
  const targets=dmsTargets(multi);
  assert.equal(targets.length,2);assert.equal(targets[0].id,legacy.id);assert.equal(targets[0].revision,legacy.revision);
  assert.deepEqual(targets.map(c=>[c.id,c.accountId,c.database,c.databaseId]),[['saved','saved','sandbox','42'],['second','saved','orders','43']]);
  assert.ok(targets.every(c=>c.databases===undefined));
  assert.equal(dmsTargets({...multi,databases:[...multi.databases,{id:'third',keyword:'dim',database:'dim',databaseId:'44'}]})[0].revision,'r1');
});
