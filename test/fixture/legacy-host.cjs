'use strict';
const vscode=require('vscode');
const {sendLegacy}=require(process.env.DBW_PROJECT_ROOT+'/src/migration.cjs');
exports.activate=async context=>{
 await context.globalState.update('connections',[
  {id:'native-jdbc',revision:'native-r1',name:'JDBC fixture',engine:'mysql',host:'fixture.invalid',port:3306,database:'sandbox'},
  {id:'native-dms',revision:'native-r2',name:'DMS fixture',channel:'dms',keyword:'sandbox',database:'sandbox',databaseId:'42'}]);
 await context.globalState.update('jdbcPending',true);
 await context.workspaceState.update('sqlConnection:file:///fixture/existing.sql',{id:'native-jdbc',revision:'native-r1'});
 await context.workspaceState.update('ddlConnection:workspaceDefault',{id:'native-dms',revision:'native-r2'});
 await context.secrets.store('jdbc:native-jdbc',JSON.stringify({user:'reader',password:'fixture'}));
 const api={extensions:vscode.extensions,window:{showWarningMessage:async(_message,_options,action)=>action}};
 return {migrate:token=>sendLegacy(context,api,token),testContext:()=>context};
};
