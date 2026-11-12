'use strict';
const {randomUUID}=require('node:crypto');
const {translator}=require('../media/i18n.js');
const {connectionConfig}=require('./jdbc.cjs'),{dmsConfig}=require('./dms.cjs');
const LEGACY_ID='local-workbench.database-workbench',PUBLIC_ID='TomMajor.sqlquay';
const globalMark='legacyMigration:global',workspaceMark='legacyMigration:workspace';
const legacyPolicies={guardPath:'~/.sqlquay/policy/query_guard.py',dmsWrapperPath:'~/.sqlquay/policy/execute_safe.py'};
const bindingKey=key=>typeof key==='string' && /^(?:ddlConnection:|sqlConnection:)/.test(key);
const identifier=value=>typeof value==='string' && /^[a-z0-9_-]{1,100}$/i.test(value);
function validate(bundle) {
  if(bundle?.source!==LEGACY_ID || !Array.isArray(bundle.connections) || !Array.isArray(bundle.bindings) || !bundle.secrets || typeof bundle.secrets!=='object') throw Error('Invalid legacy migration data.');
  const seen=new Set();
  const connections=bundle.connections.map(c=>{
    if(!identifier(c?.id) || c.id==='demo' || seen.has(c.id) || (c.revision!==undefined && !identifier(c.revision))) throw Error('Invalid legacy connection identity.');
    seen.add(c.id);
    if(c.channel!==undefined && !['jdbc','dms'].includes(c.channel)) throw Error('Invalid legacy connection channel.');
    const config=c.channel==='dms' ? dmsConfig(c) : connectionConfig({...c,port:String(c.port)});
    return {...config,id:c.id,...(c.revision===undefined ? {} : {revision:c.revision})};
  });
  const secrets=new Map();
  for(const c of connections.filter(c=>c.channel!=='dms')) {
    const raw=bundle.secrets[c.id];
    if(raw===undefined) continue;
    const auth=typeof raw==='string' ? JSON.parse(raw) : undefined;
    if(typeof auth?.user!=='string' || typeof auth.password!=='string') throw Error('Invalid legacy credential data.');
    secrets.set('jdbc:'+c.id,JSON.stringify({user:auth.user,password:auth.password}));
  }
  const keys=new Set();
  const bindings=bundle.bindings.map(pair=>{
    if(!Array.isArray(pair) || pair.length!==2 || !bindingKey(pair[0]) || keys.has(pair[0]) || !identifier(pair[1]?.id) || (pair[1].revision!==undefined && !identifier(pair[1].revision))) throw Error('Invalid legacy editor binding.');
    keys.add(pair[0]);return [pair[0],{id:pair[1].id,...(pair[1].revision===undefined ? {} : {revision:pair[1].revision})}];
  });
  for(const key of ['jdbcPending','dmsPending']) if(typeof bundle[key]!=='boolean') throw Error('Invalid legacy query state.');
  return {...bundle,connections,bindings,secrets};
}
function importer(context,vscode,onImported,onBusy) {
  let token;
  async function receive(raw,proof) {
    if(!token || proof!==token) throw Error('Start migration from the SQLQuay command palette.');
    token=undefined;
    const bundle=validate(raw),existing=context.globalState.get('connections',[]);
    const known=new Set(existing.map(c=>c.id)),added=bundle.connections.filter(c=>!known.has(c.id));
    const addedIds=new Set(added.map(c=>c.id));
    const secrets=[...bundle.secrets].filter(([key])=>addedIds.has(key.slice(5)));
    for(const [key] of secrets) if(await context.secrets.get(key)!==undefined) throw Error('An existing SQLQuay credential would be overwritten.');
    const undo=[];
    const write=async(action,restore)=>{undo.push(restore);await action();};
    const globalWrite=async(key,value)=>{
      const before=context.globalState.get(key);
      await write(()=>context.globalState.update(key,value),()=>context.globalState.update(key,before));
    };
    let bindingCount=0;
    try {
      for(const [key,value] of secrets) await write(()=>context.secrets.store(key,value),()=>context.secrets.delete(key));
      if(added.length) await globalWrite('connections',[...existing,...added]);
      for(const key of ['jdbcPending','dmsPending']) if(bundle[key] && !context.globalState.get(key,false)) await globalWrite(key,true);
      if(!context.globalState.get(globalMark,false)) {
        const settings=vscode.workspace.getConfiguration('dbWorkbench');
        for(const [key,value] of Object.entries(legacyPolicies)) {
          const inspect=settings.inspect(key) ?? {};
          if(['globalValue','workspaceValue','workspaceFolderValue','globalLanguageValue','workspaceLanguageValue','workspaceFolderLanguageValue'].some(k=>inspect[k]!==undefined)) continue;
          await write(()=>settings.update(key,value,vscode.ConfigurationTarget.Global),()=>settings.update(key,undefined,vscode.ConfigurationTarget.Global));
        }
        await globalWrite(globalMark,true);
      }
      const available=new Set([...known,...addedIds]);
      for(const [key,value] of bundle.bindings) {
        if(!available.has(value.id) || context.workspaceState.get(key)!==undefined) continue;
        await write(()=>context.workspaceState.update(key,value),()=>context.workspaceState.update(key,undefined));
        bindingCount++;
      }
      const workspaceBefore=context.workspaceState.get(workspaceMark);
      await write(()=>context.workspaceState.update(workspaceMark,true),()=>context.workspaceState.update(workspaceMark,workspaceBefore));
    } catch {
      let failed=false;
      for(const restore of undo.reverse()) try {await restore();} catch {failed=true;}
      throw Error(failed ? 'Migration and rollback were incomplete. Keep the legacy installation and restore it before continuing.' : 'Migration failed. SQLQuay changes were rolled back; legacy data is unchanged.');
    }
    onImported();
    return {connections:added.length,credentials:secrets.length,bindings:bindingCount};
  }
  async function start() {
    const legacy=vscode.extensions.getExtension(LEGACY_ID);
    if(!legacy?.packageJSON.sqlquayMigrationHelper) throw Error('Install the SQLQuay legacy migration helper VSIX, reload VS Code, then run this command.');
    if(token) throw Error('A migration is already running.');
    onBusy(true);token=randomUUID();
    try {
      const api=await legacy.activate();
      if(api?.migrationVersion!==2 || typeof api.migrate!=='function') throw Error('Update the local legacy migration helper to 0.4.2 and reload VS Code.');
      return await api.migrate(token,{knownIds:context.globalState.get('connections',[]).map(c=>c.id),workspaceImported:context.workspaceState.get(workspaceMark,false)});
    } finally {token=undefined;onBusy(false);}
  }
  return {start,receive};
}
async function sendLegacy(context,vscode,token,{knownIds=[],workspaceImported=false}={}) {
  const tr=translator(vscode.env?.language);
  const target=vscode.extensions.getExtension(PUBLIC_ID);
  if(!target?.isActive || typeof target.exports?.importLegacyData!=='function') throw Error('Start migration from SQLQuay, not the legacy helper.');
  const known=new Set(knownIds),all=context.globalState.get('connections',[]);
  const candidates=all.filter(c=>!known.has(c.id));
  if(!candidates.length && workspaceImported) return {alreadyImported:true};
  const choices=candidates.length ? await vscode.window.showQuickPick(candidates.map(connection=>({label:connection.name,description:connection.channel==='dms'?'DMS':connection.sslMode==='DISABLED'?tr("JDBC · TLS Disabled"):'JDBC',picked:true,connection})),{canPickMany:true,title:tr("Choose legacy connections to import"),placeHolder:tr("Only selected new connections are added; existing connections and file choices are kept.")}) : [];
  if(!choices || (candidates.length && !choices.length)) return {cancelled:true};
  const connections=choices.map(item=>item.connection);
  const action=tr("Import to SQLQuay");
  const accepted=await vscode.window.showWarningMessage(tr('Import {0} selected legacy connections, credentials and related workspace bindings into TomMajor.sqlquay? Existing SQLQuay connections are kept. Credentials only pass through extension memory; legacy data is retained.',connections.length),{modal:true},action);
  if(accepted!==action) return {cancelled:true};
  const secrets=Object.create(null);
  for(const c of connections) if(c.channel!=='dms') {
    const raw=await context.secrets.get('jdbc:'+c.id);
    if(raw!==undefined) secrets[c.id]=raw;
  }
  const available=new Set([...knownIds,...connections.map(c=>c.id)]);
  const bindings=context.workspaceState.keys().filter(bindingKey).map(key=>[key,context.workspaceState.get(key)]).filter(([,value])=>available.has(value?.id));
  try {
    return await target.exports.importLegacyData({source:LEGACY_ID,connections,secrets,bindings,jdbcPending:context.globalState.get('jdbcPending',false),dmsPending:context.globalState.get('dmsPending',false)},token);
  } finally {for(const key of Object.keys(secrets)) delete secrets[key];}
}
module.exports={importer,sendLegacy,LEGACY_ID,PUBLIC_ID};
