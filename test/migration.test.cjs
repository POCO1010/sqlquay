'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {importer,sendLegacy,LEGACY_ID,PUBLIC_ID}=require('../src/migration.cjs');
function context(global=[],workspace=[],secrets=[]) {
  const state=entries=>{
    const values=new Map(entries);
    return {values,keys:()=>[...values.keys()],get:(key,fallback)=>values.has(key)?values.get(key):fallback,update:async(key,value)=>value===undefined?values.delete(key):values.set(key,value)};
  };
  const auth=new Map(secrets);
  return {globalState:state(global),workspaceState:state(workspace),secrets:{values:auth,reads:0,get:async function(key){this.reads++;return auth.get(key);},store:async(key,value)=>auth.set(key,value),delete:async key=>auth.delete(key)}};
}
function setup(options={}) {
  const jdbc={id:'jdbc-1',revision:'r1',name:'JDBC fixture',group:'',engine:'mysql',host:'fixture.invalid',port:3306,database:'sandbox'};
  const dms={id:'dms-1',revision:'r2',channel:'dms',name:'DMS fixture',group:'',keyword:'sandbox',database:'sandbox',databaseId:'42'};
  const source=context([['connections',[jdbc,dms]],['jdbcPending',true]],[[
    'ddlConnection:workspaceDefault',{id:dms.id,revision:dms.revision}],['sqlConnection:file:///workspace/existing.sql',{id:jdbc.id,revision:jdbc.revision}],['ddlConnection:file:///workspace/other.sql',{id:jdbc.id,revision:jdbc.revision}],['unrelated','leave in source']],[['jdbc:'+jdbc.id,JSON.stringify({user:'reader',password:'fixture'})]]);
  const destination=context(options.global,options.workspace),settings=new Map(options.settings),busy=[],notices=[];
  const vscode={ConfigurationTarget:{Global:1},workspace:{getConfiguration:()=>({inspect:key=>({globalValue:settings.get(key)}),update:async(key,value)=>value===undefined?settings.delete(key):settings.set(key,value)})},window:{showWarningMessage:async(text,_options,action)=>{notices.push(text);return options.cancel?undefined:action;}},extensions:{getExtension:id=>id===LEGACY_ID ? {packageJSON:{sqlquayMigrationHelper:options.helper!==false},activate:async()=>({migrate:token=>sendLegacy(source,vscode,token)})} : id===PUBLIC_ID ? {isActive:true,exports:{importLegacyData:(...args)=>bridge.receive(...args)}} : undefined}};
  const bridge=importer(destination,vscode,()=>{},value=>busy.push(value));
  return {source,destination,settings,busy,notices,bridge,vscode,jdbc,dms};
}
test('legacy migration keeps IDs, credentials, pending locks and explicit file choices; source stays unchanged',async()=>{
  const current={id:'demo'};
  const x=setup({workspace:[['sqlConnection:file:///workspace/existing.sql',current]],settings:[['guardPath','/fixture/approved/query_guard.py']]});
  const source=JSON.stringify([...x.source.globalState.values]),auth=[...x.source.secrets.values];
  const result=await x.bridge.start();
  assert.deepEqual(result,{connections:2,credentials:1,bindings:2});
  assert.equal(x.destination.globalState.get('connections')[0].id,'jdbc-1');
  assert.equal(x.destination.globalState.get('connections')[0].revision,'r1');
  assert.equal(x.destination.globalState.get('jdbcPending'),true);
  assert.equal(x.destination.secrets.values.get('jdbc:jdbc-1'),auth[0][1]);
  assert.deepEqual(x.destination.workspaceState.get('sqlConnection:file:///workspace/existing.sql'),current);
  assert.deepEqual(x.destination.workspaceState.get('ddlConnection:workspaceDefault'),{id:'dms-1',revision:'r2'});
  assert.equal(x.destination.workspaceState.get('unrelated'),undefined);
  assert.equal(x.settings.get('guardPath'),'/fixture/approved/query_guard.py');
  assert.equal(x.settings.get('dmsWrapperPath'),'~/.sqlquay/policy/execute_safe.py');
  assert.equal(JSON.stringify([...x.source.globalState.values]),source);assert.deepEqual([...x.source.secrets.values],auth);
  assert.deepEqual(x.busy,[true,false]);
  const reads=x.source.secrets.reads;
  assert.deepEqual(await x.bridge.start(),{alreadyImported:true});assert.equal(x.source.secrets.reads,reads);
});
test('cancelling migration reads no legacy secret and writes nothing',async()=>{
 const x=setup({cancel:true});assert.deepEqual(await x.bridge.start(),{cancelled:true});
 assert.equal(x.source.secrets.reads,0);assert.equal(x.destination.globalState.values.size,0);assert.equal(x.destination.workspaceState.values.size,0);assert.equal(x.settings.size,0);
});
test('new workspaces import bindings without replacing already migrated connections or credentials',async()=>{
 const x=setup();await x.bridge.start();
 const connections=x.destination.globalState.get('connections');connections[0].name='Renamed in SQLQuay';
 await x.destination.secrets.store('jdbc:jdbc-1',JSON.stringify({user:'reader',password:'synthetic'}));
 const next=context();next.globalState=x.destination.globalState;next.secrets=x.destination.secrets;
 const bridge=importer(next,x.vscode,()=>{},()=>{});
 const previous=x.vscode.extensions.getExtension;
 x.vscode.extensions.getExtension=id=>id===PUBLIC_ID?{isActive:true,exports:{importLegacyData:bridge.receive}}:previous(id);
 const result=await bridge.start();assert.deepEqual(result,{connections:0,credentials:0,bindings:3});
 assert.equal(next.globalState.get('connections')[0].name,'Renamed in SQLQuay');
 assert.equal(JSON.parse(next.secrets.values.get('jdbc:jdbc-1')).password,'synthetic');
});
test('storage failure rolls back the new installation and leaves the source intact',async()=>{
 const x=setup();const update=x.destination.workspaceState.update;let fail=true;
 x.destination.workspaceState.update=async(key,value)=>{if(fail){fail=false;throw Error('fixture storage failure');}return update(key,value);};
 await assert.rejects(x.bridge.start(),/rolled back/);
 assert.equal(x.destination.globalState.values.size,0);assert.equal(x.destination.workspaceState.values.size,0);assert.equal(x.destination.secrets.values.size,0);assert.equal(x.settings.size,0);
 assert.equal(x.source.globalState.get('connections').length,2);assert.equal(x.source.secrets.values.size,1);assert.deepEqual(x.busy,[true,false]);
});
test('migration refuses unsolicited payloads, a populated target and a full legacy extension',async()=>{
 const x=setup();await assert.rejects(x.bridge.receive({},'unrequested'),/command palette/);
 const populated=setup({global:[['connections',[{id:'keep'}]]]});await assert.rejects(populated.bridge.start(),/already has connections/);assert.equal(populated.source.secrets.reads,0);
 const legacy=setup({helper:false});await assert.rejects(legacy.bridge.start(),/helper VSIX/);assert.equal(legacy.source.secrets.reads,0);
});
