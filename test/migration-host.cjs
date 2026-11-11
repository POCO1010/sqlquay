'use strict';
const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs');
exports.run=async()=>{
 const result=process.env.DBW_HOST_RESULT,mark=text=>fs.appendFileSync(result+'.progress',text+'\n');
 try {
  mark('start');
  const entry=require('../src/extension.cjs'),original=entry.activate;let context;
  entry.activate=ctx=>{context=ctx;return original(ctx);};
  const extension=vscode.extensions.getExtension('TomMajor.sqlquay');assert.ok(extension);
  await extension.activate();entry.activate=original;assert.ok(context,'The host must activate after the test context hook');mark('public activated');
  const imported=await vscode.commands.executeCommand('dbw.importLegacy');mark('import returned');
  assert.deepEqual(imported,{connections:2,credentials:1,bindings:2});
  assert.equal(context.globalState.get('connections')[0].id,'native-jdbc');
  assert.equal(context.globalState.get('jdbcPending'),true);
  const raw=await context.secrets.get('jdbc:native-jdbc');assert.equal(JSON.parse(raw).user,'reader');assert.equal(JSON.parse(raw).password,'fixture');
  const legacy=vscode.extensions.getExtension('local-workbench.database-workbench');const source=legacy.exports.testContext();
  assert.equal(await source.secrets.get('jdbc:native-jdbc'),raw);assert.equal(source.globalState.get('connections').length,2);
  const file='file:///fixture/existing.sql';
  assert.deepEqual(context.workspaceState.get('sqlConnection:'+file),{id:'native-jdbc',revision:'native-r1'});
  assert.deepEqual(context.workspaceState.get('ddlConnection:workspaceDefault'),{id:'native-dms',revision:'native-r2'});
  assert.equal(vscode.workspace.getConfiguration('dbWorkbench').get('guardPath'),'~/.sqlquay/policy/query_guard.py');
  assert.deepEqual(await vscode.commands.executeCommand('dbw.importLegacy'),{alreadyImported:true});
  fs.writeFileSync(result,JSON.stringify({status:'passed',nativeSecretStorage:true,sourceRetained:true,pendingLockRetained:true,workspaceBindings:2,idempotent:true}));
 } catch(error) {fs.writeFileSync(result,JSON.stringify({status:'failed',error:error.message}));throw error;}
};
