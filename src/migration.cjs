'use strict';
const {randomUUID}=require('node:crypto');
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
    const bundle=validate(raw),first=!context.globalState.get(globalMark,false);
    if(first && context.globalState.get('connections',[]).length) throw Error('SQLQuay already has connections. Import into an empty installation to avoid overwriting them.');
    if(first) for(const key of bundle.secrets.keys()) if(await context.secrets.get(key)!==undefined) throw Error('An existing SQLQuay credential would be overwritten.');
    const undo=[];
    const write=async(action,restore)=>{undo.push(restore);await action();};
    let bindingCount=0;
    try {
      if(first) {
        for(const [key,value] of bundle.secrets) await write(()=>context.secrets.store(key,value),()=>context.secrets.delete(key));
        for(const key of ['connections','jdbcPending','dmsPending']) {
          const before=context.globalState.get(key);
          await write(()=>context.globalState.update(key,bundle[key]),()=>context.globalState.update(key,before));
        }
        const settings=vscode.workspace.getConfiguration('dbWorkbench');
        for(const [key,value] of Object.entries(legacyPolicies)) {
          const inspect=settings.inspect(key) ?? {};
          if(['globalValue','workspaceValue','workspaceFolderValue','globalLanguageValue','workspaceLanguageValue','workspaceFolderLanguageValue'].some(k=>inspect[k]!==undefined)) continue;
          await write(()=>settings.update(key,value,vscode.ConfigurationTarget.Global),()=>settings.update(key,undefined,vscode.ConfigurationTarget.Global));
        }
        await write(()=>context.globalState.update(globalMark,true),()=>context.globalState.update(globalMark,undefined));
      }
      for(const [key,value] of bundle.bindings) {
        if(context.workspaceState.get(key)!==undefined) continue;
        await write(()=>context.workspaceState.update(key,value),()=>context.workspaceState.update(key,undefined));
        bindingCount++;
      }
      await write(()=>context.workspaceState.update(workspaceMark,true),()=>context.workspaceState.update(workspaceMark,undefined));
    } catch {
      let failed=false;
      for(const restore of undo.reverse()) try {await restore();} catch {failed=true;}
      throw Error(failed ? 'Migration and rollback were incomplete. Keep the legacy installation and restore it before continuing.' : 'Migration failed. SQLQuay changes were rolled back; legacy data is unchanged.');
    }
    onImported();
    return {connections:first?bundle.connections.length:0,credentials:first?bundle.secrets.size:0,bindings:bindingCount};
  }
  async function start() {
    if(context.workspaceState.get(workspaceMark,false)) return {alreadyImported:true};
    const legacy=vscode.extensions.getExtension(LEGACY_ID);
    if(!legacy?.packageJSON.sqlquayMigrationHelper) throw Error('Install the SQLQuay legacy migration helper VSIX, reload VS Code, then run this command.');
    if(token) throw Error('A migration is already running.');
    if(!context.globalState.get(globalMark,false) && context.globalState.get('connections',[]).length) throw Error('SQLQuay already has connections. Import into an empty installation to avoid overwriting them.');
    onBusy(true);token=randomUUID();
    try {
      const api=await legacy.activate();
      if(typeof api?.migrate!=='function') throw Error('The legacy migration helper is not ready. Reload VS Code.');
      return await api.migrate(token);
    } finally {token=undefined;onBusy(false);}
  }
  return {start,receive};
}
async function sendLegacy(context,vscode,token) {
  const target=vscode.extensions.getExtension(PUBLIC_ID);
  if(!target?.isActive || typeof target.exports?.importLegacyData!=='function') throw Error('Start migration from SQLQuay, not the legacy helper.');
  const action='导入到 SQLQuay';
  const accepted=await vscode.window.showWarningMessage('把旧版连接、凭据和当前工作区绑定导入 TomMajor.sqlquay？不查询数据库，不写导出文件，旧版数据保留。',{modal:true},action);
  if(accepted!==action) return {cancelled:true};
  const connections=context.globalState.get('connections',[]),secrets=Object.create(null);
  for(const c of connections) if(c.channel!=='dms') {
    const raw=await context.secrets.get('jdbc:'+c.id);
    if(raw!==undefined) secrets[c.id]=raw;
  }
  const bindings=context.workspaceState.keys().filter(bindingKey).map(key=>[key,context.workspaceState.get(key)]);
  try {
    return await target.exports.importLegacyData({source:LEGACY_ID,connections,secrets,bindings,jdbcPending:context.globalState.get('jdbcPending',false),dmsPending:context.globalState.get('dmsPending',false)},token);
  } finally {for(const key of Object.keys(secrets)) delete secrets[key];}
}
module.exports={importer,sendLegacy,LEGACY_ID,PUBLIC_ID};
