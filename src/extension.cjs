'use strict';
const vscode = require('vscode');
const {randomUUID} = require('node:crypto');
const {DEMO,demoQuery,pickSql,readonly,quoteTable} = require('./query.cjs');
const {makeJdbc,UnknownState,connectionConfig} = require('./jdbc.cjs');
const {makeDms,DmsStopped,dmsCatalog,targetMetadata,dmsConfig,listDmsProfiles,accessKeyCredentials,searchConfig,searchDmsDatabases,authMode,dmsAccountConfig,dmsTargets,isDmsAccount} = require('./dms.cjs');
const {relationAt,tableDdl} = require('./ddl.cjs');
const {languages,regionAt,selectedSql} = require('./embedded.cjs');
const {suggestions,ddlColumns} = require('./completion.cjs');
const {Sessions} = require('./sessions.cjs');
const {connectHtml,resultHtml} = require('./webviews.cjs');
const {importer}=require('./migration.cjs');
const path=require('node:path');
const {translator}=require('../media/i18n.js');

// Version 0.1.0 stored JDBC connections without a channel field.
const channelOf = c => c.engine === 'demo' ? 'demo' : c.channel === 'dms' ? 'dms' : 'jdbc';
const targetSignature = c => JSON.stringify([channelOf(c),channelOf(c)==='dms'?undefined:c.engine,c.host,c.port,c.database,c.databaseId,c.sslMode??'VERIFY_IDENTITY',...(channelOf(c)==='dms' ? [authMode(c),c.profile??'dms-prod',c.region??'cn-hangzhou'] : [])]);

function activate(context) {
  const tr=translator(vscode.env?.language);
  const connectionName=c=>c.id==='demo' ? tr('Local Demo') : c.name;
  const engineLabel=engine=>({mysql:'MySQL',rds:'RDS MySQL',polardb:'PolarDB MySQL',drds:'PolarDB-X / DRDS',doris:'Doris',selectdb:'SelectDB',ots:'Tablestore'}[engine]??'');
  const environmentLabel=env=>tr({product:'Production',test:'Test',dev:'Development',pre:'Pre-release',sit:'SIT',uat:'UAT',pet:'Load test',stag:'Staging'}[env]??'');
  const targetLabel=c=>[c.instanceName,environmentLabel(c.environment),engineLabel(c.engine)].filter(Boolean).join(' · ');
  const relation=(c,table)=>c.engine==='ots'?quoteTable(table):quoteTable(c.database)+'.'+quoteTable(table);
  const catalogPending=new Set(),catalogErrors=new Map();
  const instanceNodes=account=>{
    const groups=new Map();
    for(const target of dmsTargets(account)) {
      const key=target.instanceId??'legacy';
      if(!groups.has(key)) groups.set(key,{kind:'dmsInstance',instanceId:key,label:target.instanceName??tr('Existing databases'),connection:account,targets:[]});
      groups.get(key).targets.push(target);
    }
    return [...groups.values()];
  };
  const channelLabel=c=>channelOf(c)==='demo' ? tr('offline') : channelOf(c)==='jdbc' && c.sslMode==='DISABLED' ? tr('JDBC · Unencrypted') : channelOf(c).toUpperCase();
  const modeLabel=mode=>({DATA:tr('Data'),PROPERTIES:tr('Properties'),PREVIEW:tr('Preview data')}[mode] ?? mode);
  const {window,workspace,commands,TreeItem,TreeItemCollapsibleState: State,ThemeIcon,Uri} = vscode;
  const bindings = new WeakMap(), tables = new Map([['demo',['products']]]);
  const columns = new Map([['demo',new Map([['products',demoQuery('DESCRIBE products').rows]])]]);
  const ddlCache = new Map(), ddlPending = new Map();
  const changed = new vscode.EventEmitter();
  const sessions=new Sessions();
  let activeId = DEMO.id, running = false, online = false, importing = false, serial = 0;
  const saved = () => context.globalState.get('connections',[]);
  const all = () => [DEMO,...saved().flatMap(dmsTargets)];
  const owner = c => c.accountId ? saved().find(item=>item.id===c.accountId) : c;
  const live = old => {
    const current = all().find(item => item.id === old.id);
    if (!current || current.revision !== old.revision) throw Error(tr("Connection target or credentials changed. Choose an execution connection for this file again."));
    return current;
  };
  const liveConfigured=old=>{
    const current=saved().find(c=>c.id===old.id);
    if(!current || current.revision!==old.revision) throw Error(tr("Connection target or credentials changed. Choose an execution connection for this file again."));
    return current;
  };
  function getTarget(node) {
    if(node?.kind==='dmsAccount') {
      const target=dmsTargets(liveConfigured(node.connection))[0];
      if(!target) throw Error('Choose a database under this DMS connection.');
      return target;
    }
    const id = node?.connection?.id ?? activeId;
    const connection = all().find(c => c.id === id);
    if (!connection) throw Error(tr("This connection is no longer available."));
    return connection;
  }

  const configured=node=>owner(node?.kind==='dmsAccount' ? liveConfigured(node.connection):getTarget(node));

  const workspaceDdlKey = 'ddlConnection:workspaceDefault';
  const workspaceDdl = () => context.workspaceState.get(workspaceDdlKey);
  const workspaceDdlCommand = 'setWorkspaceDdlConnection';
  const branch = {connection:'database',schema:'symbol-namespace',tables:'folder',table:'table',column:'symbol-field',group:'folder',dmsAccount:'database',dmsInstance:'server',catalogStatus:'info',ddlDefault:'settings-gear'};
  const tree = {
    onDidChangeTreeData: changed.event,
    getTreeItem(node) {
      const children = !(node.kind==='dmsAccount' && !node.connection.databases.length) && node.kind !== 'ddlDefault' && node.kind !== 'column' && node.kind !== 'catalogStatus' && (node.kind !== 'table' || columns.get(node.connection.id)?.has(node.label));
      const item = new TreeItem(node.label,!children ? State.None : (node.connection?.engine === 'demo' && node.kind !== 'table') || node.kind === 'group' ? State.Expanded : State.Collapsed);
      item.id = JSON.stringify([node.connection?.id,node.kind,node.instanceId,node.table,node.label]);
      item.iconPath = new ThemeIcon(branch[node.kind]);
      item.contextValue = node.connection?.id === 'demo' && node.kind === 'connection' ? 'dbw-schema' : 'dbw-' + node.kind;
      if (node.kind === 'ddlDefault') {
        const selection=workspaceDdl();
        item.description=tr("Not set");
        if (selection) {
          try { const current=live(selection);item.description=current.name+(current.accountId?' / '+current.database:''); } catch { item.description=tr("Connection changed; choose again"); }
        }
        item.tooltip=tr("Choose the workspace default DDL preview connection. File-specific choices take priority; Run SQL is not affected.");
        item.command={command:'dbw.' + workspaceDdlCommand,title:tr("Set Workspace Default DDL Preview Connection")};
      }
      if (node.kind === 'connection') {
        item.description = channelLabel(node.connection);
        if(channelOf(node.connection)==='dms' && authMode(node.connection)==='accessKey') item.contextValue='dbw-akConnection';
      }
      if (node.kind === 'dmsAccount') item.description=tr('DMS · {0} databases',node.connection.databases.length);
      if (node.kind === 'dmsInstance') item.description=[environmentLabel(node.targets[0].environment),engineLabel(node.targets[0].engine)].filter(Boolean).join(' · ') || tr('Instance metadata not yet loaded');
      if (node.kind === 'schema' && node.connection.engine==='ots') item.description=tr('Schema browsing only');
      if (node.kind === 'catalogStatus') item.command={command:'dbw.refresh',title:tr('Load / Refresh Tables'),arguments:[node]};
      if (node.kind === 'tables') item.description = tables.has(node.connection.id) ? String(tables.get(node.connection.id).length) : tr("Load tables ↗");
      if (node.kind === 'column') item.description = node.type;
      if (node.kind === 'table') item.command = {command:'dbw.describe',title:tr("Properties"),arguments:[node]};
      return item;
    },
    getParent(node) {
      const c=node.connection;
      if(node.kind==='table') return {kind:'tables',label:tr("Tables"),connection:c};
      if(node.kind==='tables') return {kind:'schema',label:c.database,connection:c};
      if(node.kind==='schema') return c.accountId ? instanceNodes(owner(c)).find(n=>n.targets.some(t=>t.id===c.id)) : {kind:'connection',label:connectionName(c),connection:c};
      if(node.kind==='dmsInstance') return {kind:'dmsAccount',label:c.name,connection:c};
      if(['connection','dmsAccount'].includes(node.kind) && c.group) return {kind:'group',label:c.group};
    },
    getChildren(node) {
      const c = node?.connection;
      const connectionNode = connection => ({kind:isDmsAccount(connection)?'dmsAccount':'connection',label:connectionName(connection),connection});
      if (!node) {
        const connections = [DEMO,...saved()];
        const groups = [...new Set(connections.map(x=>x.group).filter(Boolean))];
        const settings=workspace.workspaceFolders?.length ? [{kind:'ddlDefault',label:tr("Default DDL preview connection")}] : [];
        return [...settings,...connections.filter(x=>!x.group).map(connectionNode),...groups.map(label=>({kind:'group',label}))];
      }
      if (node.kind === 'group') return saved().filter(x=>x.group===node.label).map(connectionNode);
      if (node.kind === 'dmsAccount') return instanceNodes(liveConfigured(c));
      if (node.kind === 'dmsInstance') return instanceNodes(liveConfigured(c)).find(n=>n.instanceId===node.instanceId)?.targets.map(connection=>({kind:'schema',label:connection.database,connection}))??[];
      if (node.kind === 'connection') return [{kind:'schema',label:c.database,connection:c}];
      if (node.kind === 'schema') return [{kind:'tables',label:tr("Tables"),connection:c}];
      if (node.kind === 'tables') {
        if(!all().some(target=>target.id===c.id)) return [];
        if(!tables.has(c.id)) return [{kind:'catalogStatus',label:catalogErrors.get(c.id)??tr(catalogPending.has(c.id)?'Loading tables…':'Expand to load tables'),connection:c}];
        return tables.get(c.id).map(label=>({kind:'table',label,connection:c}));
      }
      if (node.kind === 'table') return (columns.get(c.id)?.get(node.label) ?? []).map(([label,type])=>({kind:'column',label,type,table:node.label,connection:c}));
      return [];
    }
  };
  const treeView=window.createTreeView('dbw.explorer',{treeDataProvider:tree});
  context.subscriptions.push(changed,treeView);
  const expanded=treeView.onDidExpandElement?.(({element})=>{
    if(['schema','tables'].includes(element.kind) && !tables.has(element.connection.id) && !catalogPending.has(element.connection.id)) {
      void loadCatalog(element.connection).catch(()=>{});
    }
  });
  if(expanded) context.subscriptions.push(expanded);

  function register(name, callback) {
    context.subscriptions.push(commands.registerCommand('dbw.' + name, async (...args) => {
      try {
        if(importing) throw Error(tr("Wait for the legacy migration to finish."));
        return await callback(...args);
      }
      catch (error) { void window.showErrorMessage('SQLQuay: ' + tr(error.message)); }
    }));
  }
  const cfg = () => workspace.getConfiguration('dbWorkbench');
  const secretKey = id => 'jdbc:' + id;
  async function credentialsFor(connection) {
    const raw = await context.secrets.get(secretKey(connection.id));
    if (!raw) throw Error(tr("Edit this connection to enter its read-only credentials."));
    const value = JSON.parse(raw);
    if (typeof value?.user !== 'string' || typeof value?.password !== 'string') throw Error(tr("Saved credentials are unavailable."));
    return value;
  }
  const akSecretKey=id=>'dms-ak:'+id;
  async function dmsCredentialsFor(connection) {
    const raw=await context.secrets.get(akSecretKey(connection.accountId??connection.id));
    if(isDmsAccount(connection)) liveConfigured(connection); else live(connection);
    if(!raw) throw Error('Edit this DMS connection to enter its AccessKey.');
    try {return accessKeyCredentials(JSON.parse(raw));}
    catch {throw Error('Saved DMS credentials are unavailable. Re-enter the AccessKey.');}
  }
  const pendingChannel = () => context.globalState.get('jdbcPending',false) ? 'JDBC'
    : context.globalState.get('dmsPending',false) ? 'DMS' : undefined;
  async function query(connection, sql, limit = 200, credentials, table, onProgress) {
    const channel = channelOf(connection);
    if (channel === 'demo') {
      if (table === 'products') return demoQuery('SELECT id, name, category, price FROM products LIMIT 100');
      return demoQuery(sql);
    }
    if (!workspace.isTrusted) throw Error(tr("Online queries are disabled in untrusted workspaces."));
    if(importing) throw Error(tr("Wait for the legacy migration to finish."));
    if (online) throw Error(tr("An online operation is already running."));
    const pending = pendingChannel();
    if (pending) throw Error(tr('{0} stopped without a safe continuation. Verify its state and unlock before using either online connection.',pending));
    const key = channel + 'Pending';
    online = true;
    try {
      const settings = cfg(), python = settings.get('pythonPath');
      const execute = channel === 'dms'
        ? async () => makeDms({python,onProgress,wrapper:settings.get('dmsWrapperPath') || path.join(context.extensionPath,'policy','execute_safe.py')})(connection,sql,limit,table,authMode(connection)==='accessKey' ? credentials??await dmsCredentialsFor(connection) : undefined)
        : async () => {
          const auth = credentials ?? await credentialsFor(connection);
          return makeJdbc({onProgress,java:settings.get('javaPath'),python,jar:settings.get('driverJar'),guard:settings.get('guardPath') || path.join(context.extensionPath,'policy','query_guard.py')},context.extensionPath)(connection,auth,sql,limit,table);
        };
      await context.globalState.update(key,true);
      try {
        const result = await execute();
        await context.globalState.update(key,false);
        return result;
      } catch (error) {
        if (!(error instanceof UnknownState || error instanceof DmsStopped)) await context.globalState.update(key,false);
        throw error;
      }
    } finally { online=false; }
  }
  const ddlCommand = 'dbw.loadTableDdl', previewCommand = 'dbw.previewTable', ddlPreviewLimit = 24_000;
  const ddlKey = (connection,table) => JSON.stringify([connection.id,connection.revision,connection.database,table]);
  const clearDdl = connection => {
    for (const [key,entry] of ddlCache) if (entry.connectionId===connection.id) ddlCache.delete(key);
  };
  const savedSql = doc => doc?.uri.scheme==='file';
  const supported = doc => doc && languages.includes(doc.languageId);
  const region = (doc,offset) => regionAt(doc,offset);
  const fileDdlKey = doc => 'ddlConnection:' + doc.uri.toString();
  const fileDdl = doc => savedSql(doc) ? context.workspaceState.get(fileDdlKey(doc)) : undefined;
  const fileSqlKey = doc => 'sqlConnection:' + doc.uri.toString();
  const executionBinding = doc => (savedSql(doc) ? context.workspaceState.get(fileSqlKey(doc)) : undefined) ?? bindings.get(doc);
  const inheritedDdl = doc => supported(doc) && savedSql(doc) && workspace.getWorkspaceFolder(doc.uri) ? workspaceDdl() : undefined;
  const ddlBinding = doc => executionBinding(doc) ?? fileDdl(doc) ?? inheritedDdl(doc);
  const saveDdlBinding = (key,c) => context.workspaceState.update(key,c ? {id:c.id,revision:c.revision} : undefined);
  const bindingSignature = binding => binding ? JSON.stringify([binding.id,binding.revision]) : null;
  const connectionStatus=window.createStatusBarItem(vscode.StatusBarAlignment.Right,100);
  connectionStatus.command='dbw.bindConnection';
  connectionStatus.name=tr("SQLQuay execution connection");
  context.subscriptions.push(connectionStatus);
  function setEditorContext() {
    const doc=window.activeTextEditor?.document;
    const enabled=(savedSql(doc) && supported(doc)) || !!bindings.get(doc) || !!executionBinding(doc);
    void commands.executeCommand('setContext','dbw.runnableEditor',enabled);
    if (!enabled) { connectionStatus.hide(); return; }
    const bound=executionBinding(doc);
    let label=tr("Choose execution connection");
    if (bound) {
      try { const c=live(bound); label=connectionName(c)+' / '+c.database+' · '+channelLabel(c)+(targetLabel(c)?' · '+targetLabel(c):''); }
      catch { label=tr("Connection changed; reselect"); }
    }
    connectionStatus.text='$(database) '+label;
    connectionStatus.tooltip=tr("Execution connection for this file. Click to change it; the workspace preview default does not automatically execute SQL.");
    connectionStatus.show();
  }
  context.subscriptions.push(window.onDidChangeActiveTextEditor(setEditorContext));
  async function chooseConnection({doc,schema,title,resetLabel,current}) {
    const options=all().filter(c=>(workspace.isTrusted || channelOf(c)==='demo') && (!schema || c.database===schema));
    if (!options.length) throw Error(tr("No preview connection matches this database. Add a connection first."));
    const items=[...options.filter(c=>c!==DEMO),...options.filter(c=>c===DEMO)].map(c=>({
      label:connectionName(c),description:c.database + ' · ' + channelLabel(c)+(targetLabel(c)?' · '+targetLabel(c):'') +
        (bindingSignature(c)===bindingSignature(current) ? tr(" · Selected") : ''),connection:c
    }));
    if (resetLabel) items.push({label:resetLabel,reset:true});
    const choice=await window.showQuickPick(items,{title,matchOnDescription:true,placeHolder:schema ?? tr("Choose a JDBC or DMS connection")});
    if (!choice || doc?.isClosed) return;
    return choice.reset ? null : live(choice.connection);
  }
  const fileDdlTitle = tr("Choose a DDL preview connection for this SQL file");
  const rememberDdlConnection = (doc,c) => saveDdlBinding(fileDdlKey(doc),c);
  register(workspaceDdlCommand,async ()=>{
    if (!workspace.workspaceFolders?.length) throw Error(tr("Open a VS Code workspace first."));
    const current=workspaceDdl();
    const connection=await chooseConnection({title:tr("Set Workspace Default DDL Preview Connection"),current,
      resetLabel:current ? tr("Clear workspace default connection") : undefined});
    if (connection===undefined) return;
    await saveDdlBinding(workspaceDdlKey,connection);
    changed.fire();
    window.setStatusBarMessage(connection ? tr('Workspace default preview connection: {0}',connection.name) : tr("Workspace default preview connection cleared."),4000);
  });
  register('bindDdlConnection',async ()=>{
    const doc=window.activeTextEditor?.document;
    if (!savedSql(doc)) throw Error(tr("Open an existing SQL file."));
    if (executionBinding(doc)) throw Error(tr("Hover and preview use this file's execution connection. Use Choose Execution Connection for Current File to change it."));
    const override=fileDdl(doc);
    const connection=await chooseConnection({doc,title:fileDdlTitle,current:ddlBinding(doc),
      resetLabel:override ? tr("Clear file override (use workspace default)") : undefined});
    if (connection===undefined) return;
    await rememberDdlConnection(doc,connection);
    window.setStatusBarMessage(connection ? tr('DDL preview connection: {0}',connection.name) : tr("File preview override cleared."),4000);
  });
  async function bindConnection(doc) {
    if (!savedSql(doc) && !bindings.has(doc)) throw Error(tr("Open a local SQL file or a New Query editor first."));
    const current=executionBinding(doc), signature=bindingSignature(current);
    const connection=await chooseConnection({doc,title:tr("Choose Execution Connection for Current File"),current,
      resetLabel:current ? tr("Clear execution connection (keep preview settings)") : undefined});
    if (connection===undefined) return;
    if (doc.isClosed || bindingSignature(executionBinding(doc))!==signature) throw Error(tr("File connection changed. Choose again."));
    if (savedSql(doc)) await saveDdlBinding(fileSqlKey(doc),connection);
    else if (connection) bindings.set(doc,connection);
    else bindings.delete(doc);
    setEditorContext();
    return connection;
  }
  register('bindConnection',()=>bindConnection(window.activeTextEditor?.document));
  register('searchTables',async node=>{
    const scope=node?.connection;
    const items=all().filter(c=>!scope || c.id===scope.id || (isDmsAccount(scope) && c.accountId===scope.id)).flatMap(connection=>(tables.get(connection.id)??[])
      .map(table=>({label:table,description:connectionName(connection)+' / '+connection.database+' · '+channelLabel(connection),connection,table})));
    if(!items.length) throw Error(tr("Load the table list with Load / Refresh Tables first."));
    const choice=await window.showQuickPick(items,{title:tr("Search loaded tables"),matchOnDescription:true});
    if(!choice) return;
    const connection=live(choice.connection);
    await treeView.reveal({kind:'table',label:choice.table,connection},{select:true,focus:true});
  });
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(languages.map(language=>({language})),{
    provideCompletionItems(doc,position) {
      const offset=doc.offsetAt(position), part=region(doc,offset), bound=ddlBinding(doc);
      if(!part || !bound) return [];
      let c;try {c=live(bound);} catch{return [];}
      if(channelOf(c)!=='demo' && !workspace.isTrusted) return [];
      return suggestions(part.text,offset-part.start,c.database,tables.get(c.id)??[],columns.get(c.id)??new Map()).map(v=>{
        const item=new vscode.CompletionItem(v.name,v.kind==='table' ? vscode.CompletionItemKind.Struct : vscode.CompletionItemKind.Field);
        item.detail=v.kind==='table' ? connectionName(c)+' / '+c.database : v.type;
        item.insertText=v.insert;
        item.range=new vscode.Range(doc.positionAt(part.start+v.start),doc.positionAt(part.start+v.end));
        return item;
      });
    }
  },'.'));
  function waitForHover(token) {
    return new Promise(resolve=>{
      const timer=setTimeout(()=>finish(true),250);
      let subscription;
      subscription=token.onCancellationRequested?.(()=>finish(false));
      function finish(ready) { clearTimeout(timer); subscription?.dispose(); resolve(ready); }
    });
  }
  function loadDdl(connection,table) {
    const key=ddlKey(connection,table);
    if (ddlCache.has(key)) return Promise.resolve(ddlCache.get(key));
    if (ddlPending.has(key)) return ddlPending.get(key);
    live(connection);
    if (channelOf(connection)!=='demo') {
      if (pendingChannel()) return Promise.resolve({error:tr("Online queries are locked. Verify the previous query state first.")});
      if (online) return Promise.resolve({error:tr("Another online operation is running. Hover again when it finishes.")});
    }
    const task=(async ()=>{
      let preview, fields;
      try {
        const result=await query(connection,'SHOW CREATE TABLE ' + relation(connection,table),1);
        const ddl=tableDdl(result,connection.engine);
        preview={ddl:ddl.slice(0,ddlPreviewLimit),truncated:ddl.length>ddlPreviewLimit};
        fields=ddlColumns(ddl);
      } catch (error) {
        // A failed hover is not retried automatically; refreshing the connection clears it.
        preview={error:tr(error.message)};
      }
      live(connection);
      if(fields?.length) {
        const cache=columns.get(connection.id)??new Map();
        cache.set(table,fields);columns.set(connection.id,cache);
        changed.fire();
      }
      if (ddlCache.size>=200) ddlCache.delete(ddlCache.keys().next().value);
      ddlCache.set(key,{connectionId:connection.id,...preview});
      return preview;
    })().finally(()=>ddlPending.delete(key));
    ddlPending.set(key,task);
    return task;
  }
  function hoverLink(title,command,doc,offset,bound) {
    const args=encodeURIComponent(JSON.stringify([doc.uri.toString(),doc.version,offset,bindingSignature(bound)])).replace(/[()']/g,c=>'%'+c.charCodeAt(0).toString(16));
    const link=new vscode.MarkdownString();
    link.isTrusted={enabledCommands:[command]};
    link.appendMarkdown('[' + title + '](command:' + command + '?' + args + ')');
    return link;
  }
  context.subscriptions.push(vscode.languages.registerHoverProvider(languages.map(language=>({language})),{
    async provideHover(doc,position,token) {
      const bound=ddlBinding(doc), file=savedSql(doc);
      if ((!bound && !file) || token.isCancellationRequested) return;
      let connection;
      if (bound) try { connection=live(bound); } catch { if (!file) return; }
      if (connection && channelOf(connection)!=='demo' && !workspace.isTrusted) return;
      const offset=doc.offsetAt(position);
      const part=region(doc,offset);
      if(!part) return;
      const ref=relationAt(part.text,offset-part.start,file ? undefined : connection?.database);
      if(ref) {ref.start+=part.start;ref.end+=part.start;}
      if (!ref) return;
      const sameDatabase=connection && (!ref.schema || ref.schema===connection.database);
      const range=new vscode.Range(doc.positionAt(ref.start),doc.positionAt(ref.end));
      const heading=new vscode.MarkdownString();
      heading.appendText(sameDatabase
        ? connection.database + '.' + ref.table + ' · ' + connectionName(connection) + ' · ' + channelLabel(connection) +
          (file && !executionBinding(doc) && !fileDdl(doc) ? tr(" · Workspace default") : '')
        : (ref.schema ? ref.schema + '.' : '') + ref.table +
          (executionBinding(doc) ? tr(" · Change this file's execution connection") : tr(" · Choose a preview connection first")));
      const body=new vscode.MarkdownString();
      if (sameDatabase) {
        const version=doc.version, signature=bindingSignature(bound);
        const current=()=>!doc.isClosed && doc.version===version && !token.isCancellationRequested &&
          (workspace.isTrusted || channelOf(connection)==='demo') &&
          bindingSignature(ddlBinding(doc))===signature;
        let preview=ddlCache.get(ddlKey(connection,ref.table));
        if (!preview) {
          if (!(await waitForHover(token)) || !current()) return;
          try { preview=await loadDdl(connection,ref.table); live(connection); } catch { return; }
          if (!current()) return;
        }
        if (preview.error) body.appendText(preview.error);
        else {
          body.appendCodeblock(preview.ddl,'sql');
          if (preview.truncated) body.appendText(tr("The table definition is truncated to the first 24,000 characters."));
          return new vscode.Hover([heading,...(connection.engine==='ots'?[]:[hoverLink(tr("Preview data"),previewCommand,doc,offset,bound)]),body],range);
        }
      } else {
        if (executionBinding(doc)) {
          body.appendText(tr("Use the status bar or database icon to choose an execution connection matching this table."));
          return new vscode.Hover([heading,body],range);
        }
        return new vscode.Hover([heading,hoverLink(tr("Choose preview connection"),ddlCommand,doc,offset,bound)],range);
      }
      return new vscode.Hover([heading,body],range);
    }
  }));
  register('previewTable',(uri,version,offset,signature)=>{
    const doc=workspace.textDocuments.find(d=>d.uri.toString()===uri);
    const bound=doc && ddlBinding(doc);
    if (!bound || doc.isClosed || doc.version!==version || !Number.isInteger(offset) || bindingSignature(bound)!==signature) {
      throw Error(tr("File or preview connection changed. Hover the table name again."));
    }
    const connection=live(bound);
    if(connection.engine==='ots') throw Error('Tablestore supports databases, tables and DDL only. Data queries and previews require verified EXPLAIN support.');
    const part=region(doc,offset);
    const ref=part && relationAt(part.text,offset-part.start,connection.database);
    if (!ref || !ddlCache.get(ddlKey(connection,ref.table))?.ddl) throw Error(tr("Hover the table name again before previewing data."));
    return run(connection,connection.database + '.' + ref.table,'PREVIEW',ref.table);
  });
  register('loadTableDdl',async (uri,version,offset,signature)=>{
    const doc=workspace.textDocuments.find(d=>d.uri.toString()===uri);
    const current=()=>doc && !doc.isClosed && doc.version===version && bindingSignature(ddlBinding(doc))===signature;
    if (!current() || !Number.isInteger(offset)) throw Error(tr("Hover the table name again in the SQL editor."));
    const bound=ddlBinding(doc), file=savedSql(doc);
    let connection;
    if (bound) try { connection=live(bound); } catch (error) { if (!file) throw error; }
    if (!connection && !file) throw Error(tr("Hover the table name again in the bound SQL editor."));
    const part=region(doc,offset);
    const ref=part && relationAt(part.text,offset-part.start,file ? undefined : connection.database);
    if (!ref) throw Error(tr("The cursor is not on a previewable table name."));
    if (file && (!connection || (ref.schema && ref.schema!==connection.database))) {
      connection=await chooseConnection({doc,schema:ref.schema,title:fileDdlTitle});
      if (!connection) return;
      if (!current()) throw Error(tr("File or preview connection changed. Hover the table name again."));
      await rememberDdlConnection(doc,connection);
    }
    const preview=await window.withProgress({location:vscode.ProgressLocation.Notification,title:tr("Loading table definition…")},
      ()=>loadDdl(connection,ref.table));
    if (preview.error) throw Error(preview.error);
    window.setStatusBarMessage(tr("Table definition loaded. Hover the table name to view it."),4000);
  });
  function assetPaths(view) {
    const media = Uri.joinPath(context.extensionUri,'media');
    const uri = name => view.asWebviewUri(Uri.joinPath(media,name)).toString();
    return {language:vscode.env?.language,csp:view.cspSource,css:uri('workbench.css'),script:uri('workbench.js'),i18n:uri('i18n.js'),icon:uri('database.svg')};
  }
  const webOptions = {enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[Uri.joinPath(context.extensionUri,'media')]};
  let formPanel;
  function openForm(edit,adding=false) {
    if (formPanel) {
      formPanel.dispose();
      formPanel=undefined;
    }
    const panel = window.createWebviewPanel('dbw.connect',edit ? tr('Edit {0}',edit.name) : tr("Connect to server"),vscode.ViewColumn.One,webOptions);
    formPanel=panel;
    let busy=false,disposed=false,draftAuth,savedAuth;
    const verifiedSearch=new Map(),verifiedInstances=new Map(),databaseKey=c=>JSON.stringify([c.databaseId,c.database]);
    const formAuth=async values=>{
      if(values.accessKeyId || values.accessKeySecret) {
        const entered=accessKeyCredentials(values);
        if(!draftAuth || draftAuth.accessKeyId!==entered.accessKeyId || draftAuth.accessKeySecret!==entered.accessKeySecret) {
          draftAuth=entered;verifiedSearch.clear();verifiedInstances.clear();
        }
      }
      if(draftAuth) return draftAuth;
      if(edit && authMode(edit)==='accessKey') {savedAuth??=await dmsCredentialsFor(edit);return savedAuth;}
      return accessKeyCredentials({});
    };
    const receive = panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      if (message.type==='close' && !busy) { panel.dispose();return; }
      if (message.type==='loadDmsProfiles') {
        if(!workspace.isTrusted) return;
        try { await panel.webview.postMessage({type:'dmsProfiles',profiles:await listDmsProfiles()}); }
        catch(error) { await panel.webview.postMessage({type:'dmsProfiles',profiles:[],message:tr(error.message)}); }
        return;
      }
      if (message.type==='configureDms') {
        if(!workspace.isTrusted) return;
        const terminal=window.createTerminal({name:tr("SQLQuay · Aliyun CLI setup")});
        terminal.show();terminal.sendText('aliyun configure --profile my-dms',false);
        return;
      }
      if(message.type==='openAccessKeyGuide') {void vscode.env.openExternal(Uri.parse('https://ram.console.aliyun.com/profile/access-keys'));return;}
      if(['listDmsInstances','listDmsDatabases'].includes(message.type)) {
        if(busy || !workspace.isTrusted || !message.values || typeof message.values!=='object') return;
        busy=true;
        try {
          if(online || pendingChannel()) throw Error('Wait for the active query to finish.');
          if(edit) liveConfigured(edit);
          const values=message.values,auth=await formAuth(values),kind=message.type==='listDmsInstances'?'instances':'databases';
          let instance;
          if(kind==='databases') {
            const verified=verifiedInstances.get(values.instanceId);
            if(!verified || verified.auth!==auth || verified.region!==values.region) throw Error('Load the instance list with this AccessKey first.');
            instance=verified;
          }
          online=true;
          try {
            await context.globalState.update('dmsPending',true);
            const result=await dmsCatalog({python:cfg().get('pythonPath')},{...values,kind,...(instance?targetMetadata(instance):{})},auth);
            if(!disposed && kind==='instances') for(const instance of result.instances) verifiedInstances.set(instance.instanceId,{...instance,auth,region:values.region});
            if(!disposed && kind==='databases') for(const database of result.databases) verifiedSearch.set(databaseKey(database),{keyword:database.keyword,region:values.region,auth,database});
            if(!disposed) await panel.webview.postMessage({type:kind==='instances'?'dmsInstances':'dmsDatabases',...result});
            await context.globalState.update('dmsPending',false);
          } catch(error) {
            if(!(error instanceof DmsStopped)) await context.globalState.update('dmsPending',false);
            throw error;
          } finally {online=false;}
        } catch(error) {if(!disposed) await panel.webview.postMessage({type:'error',message:tr(error.message)});}
        finally {busy=false;}
        return;
      }
      if(message.type==='searchDmsDatabases') {
        if(busy || !workspace.isTrusted || !message.values || typeof message.values!=='object') return;
        busy=true;
        try {
          if(online || pendingChannel()) throw Error('Wait for the active query to finish.');
          if(edit) liveConfigured(edit);
          const search=searchConfig(message.values);
          online=true;
          try {
            const auth=await formAuth(message.values);
            await context.globalState.update('dmsPending',true);
            try {
              const result=await searchDmsDatabases({python:cfg().get('pythonPath')},search,auth);
              if(!disposed) for(const database of result.databases) verifiedSearch.set(databaseKey(database),{...search,auth,database});
              if(!disposed) await panel.webview.postMessage({type:'dmsDatabases',...result});
              await context.globalState.update('dmsPending',false);
            } catch(error) {
              if(!(error instanceof DmsStopped)) await context.globalState.update('dmsPending',false);
              throw error;
            }
          } finally {online=false;}
        } catch(error) {if(!disposed) await panel.webview.postMessage({type:'error',message:tr(error.message)});}
        finally {busy=false;}
        return;
      }
      if (message.type==='ready') { if(edit) await panel.webview.postMessage({type:'configure',connection:{...edit,channel:channelOf(edit)},adding});return; }
      if (busy || !['save','connect'].includes(message.type) || !message.values || typeof message.values!=='object') return;
      busy=true;

      try {
        if (!workspace.isTrusted) throw Error(tr("Online connection configuration is disabled in untrusted workspaces."));
        const prior=edit ? liveConfigured(edit):undefined;
        const channel = message.values.channel;
        if (!['jdbc','dms'].includes(channel) || (edit && channel !== channelOf(edit))) {
          throw Error(tr("To change the connection method, create a new connection."));
        }
        if(edit && channel==='dms' && authMode(edit)!==authMode(message.values)) throw Error('To change DMS authentication, create a new connection.');
        const multiple=channel==='dms' && Array.isArray(message.values.databases);
        if(isDmsAccount(prior) && !multiple) throw Error('Choose one or more databases for this AccessKey connection.');
        let data=multiple ? dmsAccountConfig(message.values,{allowEmpty:!!edit}) : channel==='dms' ? dmsConfig(message.values) : connectionConfig(message.values);
        const previousTargets=prior ? dmsTargets(prior) : [];
        const removals=message.values.removedDatabases??[];
        if(!Array.isArray(removals) || (removals.length && (!multiple || !edit))) throw Error('The database selection changed. Reopen the connection and choose the databases again.');
        if(multiple && edit) {
          const proposed=new Map(data.databases.map(c=>[databaseKey(c),c])),removed=new Set();
          for(const row of removals) {
            if(!row || typeof row!=='object' || !previousTargets.some(c=>databaseKey(c)===databaseKey(row)) || proposed.has(databaseKey(row))) throw Error('The database selection changed. Reopen the connection and choose the databases again.');
            removed.add(databaseKey(row));
          }
          const retained=previousTargets.filter(c=>!removed.has(databaseKey(c))).map(c=>proposed.get(databaseKey(c))??c);
          const known=new Set(previousTargets.map(databaseKey));
          data=dmsAccountConfig({...data,databases:[...retained,...data.databases.filter(c=>!known.has(databaseKey(c)))]},{allowEmpty:true});
        }
        const connection = {...data,channel,id:edit?.id ?? randomUUID(),revision:edit ? edit.revision : randomUUID()};
        if(multiple) connection.databases=connection.databases.map(database=>({...database,
          id:previousTargets.find(c=>databaseKey(c)===databaseKey(database))?.id ?? randomUUID()}));
        let credentials, newUser = false;
        if (channel === 'jdbc') {
          const user = typeof message.values.user === 'string' ? message.values.user.trim() : '';
          const password = typeof message.values.password === 'string' ? message.values.password : '';
          if (user.length > 256 || password.length > 1024 || (password && !user)) throw Error(tr("Enter a valid read-only username and password."));
          if (!edit && !user) throw Error(tr("Enter a read-only username."));
          const changedTarget = edit && ['host','port','database','engine'].some(key=>connection[key]!==edit[key]);
          if (changedTarget && !user) throw Error(tr("Re-enter credentials when changing the target."));
          if (connection.sslMode === 'DISABLED' && (edit?.sslMode !== 'DISABLED' || changedTarget)) {
            const action = tr("Use Unencrypted JDBC");
            const answer = await window.showWarningMessage(
              tr("This JDBC connection will send traffic without TLS. The server identity is not verified, and SQL and results can be intercepted or modified. Prefer DMS on public networks."),
              {modal:true},action
            );
            if (answer !== action || disposed) throw Error(tr("Unencrypted JDBC was not confirmed. Choose verified TLS or use DMS."));
          }
          credentials = user ? {user,password} : await credentialsFor(edit);
          newUser = !!user;
        }
        let newAccessKey=false;
        if(channel==='dms' && authMode(connection)==='accessKey') {
          credentials=await formAuth(message.values);
          newAccessKey=!!draftAuth;
          for(const target of dmsTargets(connection)) {
            const previous=previousTargets.find(c=>databaseKey(c)===databaseKey(target));
            const sameSaved=previous && !newAccessKey && targetSignature(previous)===targetSignature(target);
            const verified=verifiedSearch.get(databaseKey(target));
            const selected=verified && verified.region===connection.region && verified.keyword===target.keyword && verified.auth===credentials;
            if(!sameSaved && !selected) throw Error('Search and select the database with this AccessKey first.');
            const metadata=targetMetadata(selected ? verified.database : previous);
            const row=multiple ? connection.databases.find(c=>databaseKey(c)===databaseKey(target)) : connection;
            for(const field of ['instanceId','instanceName','engine','environment']) delete row[field];
            Object.assign(row,metadata);
          }
        }
        const targetChanged=multiple ? edit && (edit.region??'cn-hangzhou')!==connection.region : edit && targetSignature(edit)!==targetSignature(connection);
        if (edit && (targetChanged || newUser || newAccessKey)) connection.revision=randomUUID();
        const targets=dmsTargets(connection),catalogs=new Map();
        if(message.type==='connect' && !multiple) for(const target of targets) {
          if(disposed) return;
          if(edit) liveConfigured(edit);
          const catalog=await query(target,'SHOW TABLES',10000,credentials);
          if(catalog.truncated) throw Error(tr("The table list exceeded the metadata display limit."));
          catalogs.set(target.id,catalog);
        }
        if (disposed) return;
        if(edit) liveConfigured(edit);
        const existing = saved();
        if (newUser) await context.secrets.store(secretKey(connection.id),JSON.stringify(credentials));
        let previousAk;
        if(newAccessKey) {
          previousAk=await context.secrets.get(akSecretKey(connection.id));
          await context.secrets.store(akSecretKey(connection.id),JSON.stringify(credentials));
        }
        try {await context.globalState.update('connections',edit ? existing.map(c=>c.id===edit.id ? connection:c) : [...existing,connection]);}
        catch(error) {
          if(newAccessKey) {
            if(previousAk===undefined) await context.secrets.delete(akSecretKey(connection.id));
            else await context.secrets.store(akSecretKey(connection.id),previousAk);
          }
          throw error;
        }
        const retainedIds=new Set(targets.map(c=>c.id));
        for(const previous of previousTargets) if(!retainedIds.has(previous.id)) {tables.delete(previous.id);columns.delete(previous.id);clearDdl(previous);}
        for(const target of targets) {
          const changedTarget=!previousTargets.some(c=>c.id===target.id && c.revision===target.revision);
          if(catalogs.has(target.id)) tables.set(target.id,tableNames(catalogs.get(target.id))); else if(changedTarget) tables.delete(target.id);
          if(changedTarget) {columns.delete(target.id);clearDdl(target);}
        }
        activeId = targets[0]?.id??'demo'; changed.fire(); setEditorContext(); panel.dispose();
      } catch (error) {
        if (!disposed) await panel.webview.postMessage({type:'error',message:tr(error.message)});
      } finally { busy=false; }
    });
    panel.onDidDispose(()=>{disposed=true;draftAuth=savedAuth=undefined;verifiedSearch.clear();verifiedInstances.clear();receive.dispose();if(formPanel===panel) formPanel=undefined;});
    panel.webview.html=connectHtml(assetPaths(panel.webview));
  }

  function tableNames(catalog) {
    const at=Math.max(0,catalog.columns.findIndex(column=>/^Tables_in_/i.test(column.name)));
    return catalog.rows.map(row=>row[at]).filter(name=>typeof name==='string' && name);
  }
  register('connect',()=>openForm());
  register('edit',node=>{const connection=configured(node); if(connection.engine!=='demo') openForm(connection);});
  register('addDmsDatabases',node=>{
    const connection=configured(node);
    if(channelOf(connection)!=='dms' || authMode(connection)!=='accessKey') throw Error('Choose an AccessKey DMS connection from the Database tree.');
    openForm(owner(connection),true);
  });
  register('remove',async node=>{
    const connection=configured(node); if(connection.engine==='demo') return;
    const confirmed=await window.showWarningMessage(tr('Remove {0}?',connection.name),{modal:true},tr("Remove"));
    if (confirmed!==tr("Remove")) return;
    await context.globalState.update('connections',context.globalState.get('connections',[]).filter(c=>c.id!==connection.id));
    if (channelOf(connection) === 'jdbc') await context.secrets.delete(secretKey(connection.id));
    if(channelOf(connection)==='dms' && authMode(connection)==='accessKey') await context.secrets.delete(akSecretKey(connection.id));
    for(const target of dmsTargets(connection)) {tables.delete(target.id);columns.delete(target.id);clearDdl(target);if(activeId===target.id) activeId='demo';}
    changed.fire();setEditorContext();
  });
  async function loadCatalog(connection) {
    live(connection);
    if(catalogPending.has(connection.id)) return;
    catalogPending.add(connection.id);catalogErrors.delete(connection.id);changed.fire();
    try {
      const result=await query(connection,'SHOW TABLES',10000);
      if(result.truncated) throw Error(tr('The table list exceeded the metadata display limit.'));
      live(connection);tables.set(connection.id,tableNames(result));
      if(connection.id!=='demo') columns.delete(connection.id);
      clearDdl(connection);
    } catch(error) {catalogErrors.set(connection.id,error.message);throw error;}
    finally {catalogPending.delete(connection.id);changed.fire();}
  }
  register('refresh',async node=>{
    const connection=getTarget(node);
    return window.withProgress({location:vscode.ProgressLocation.Notification,title:tr('Loading tables · {0}',connectionName(connection))},()=>loadCatalog(connection));
  });
  register('newQuery',async node=>{
    const connection=getTarget(node);
    const content=connection.engine==='demo' ? 'SELECT id, name, category, price\nFROM products\nLIMIT 50;\n' : 'SELECT 1 AS probe;\n';
    const doc=await workspace.openTextDocument({language:'sql',content});
    bindings.set(doc,connection); activeId=connection.id;
    await window.showTextDocument(doc); await setEditorContext();
    return doc;
  });
  register('run',async ()=>{
    const editor=window.activeTextEditor;
    if(!editor) throw Error(tr("Open an editor first."));
    const doc=editor.document, version=doc.version;
    const offset=doc.offsetAt(editor.selection.active), selected=doc.getText(editor.selection);
    const part=region(doc,offset);
    if(!selected.trim() && !part) throw Error(tr("Select plain SQL or put the cursor inside a supported SQL block."));
    let sql=selected.trim() ? selected : pickSql(part.text,offset-part.start,'');
    if(doc.languageId!=='sql') sql=selectedSql(sql);
    const bound=executionBinding(doc) ?? await bindConnection(doc);
    if (!bound) return;
    if (doc.isClosed || doc.version!==version || window.activeTextEditor?.document!==doc) throw Error(tr("SQL file changed. Run it again."));
    return run(bound,sql);
  });
  register('describe',async node=>{
    if(node?.kind!=='table' || !tables.get(node.connection.id)?.includes(node.label)) throw Error(tr("Choose a table from the Database tree."));
    const result=await run(node.connection,'DESCRIBE ' + quoteTable(node.label),'PROPERTIES');
    if (!result || result.truncated) return;
    live(node.connection);
    const cache=columns.get(node.connection.id) ?? new Map();
    cache.set(node.label,result.rows.filter(row=>typeof row[0]==='string'));
    columns.set(node.connection.id,cache); changed.fire(); return result;
  });
  register('unlock',async ()=>{
    const pending = pendingChannel();
    if (online || !pending) return;
    const action = pending === 'DMS' ? tr("the DMS query has ended and AI Mode is clean") : tr("the JDBC query has ended on the server");
    if (await window.showWarningMessage(tr('Confirm {0} before unlocking either online connection.',action),{modal:true},tr("Confirmed"))===tr("Confirmed")) {
      await context.globalState.update(pending.toLowerCase() + 'Pending',false);
    }
  });
  function publish(entry) {
    if(entry.panel) {
      entry.panel.title=(entry.pinned?'📌 ':'')+tr('Query Result #{0} · {1}',entry.view.id,modeLabel(entry.view.mode));
      void entry.panel.webview.postMessage({...entry.view,pinned:!!entry.pinned});
    }
  }
  function showResult(entry) {
    if(entry.panel) {entry.panel.reveal(undefined,true);return;}
    const panel=window.createWebviewPanel('dbw.result',tr('Query Result #{0} · {1}',entry.view.id,modeLabel(entry.view.mode)),
      {viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},webOptions);
    entry.panel=panel;
    const receive=panel.webview.onDidReceiveMessage(message=>{
      if(!message || typeof message!=='object') return;
      if(message.type==='ready') {publish(entry);return;}
      if(message.runId!==entry.view.id) return;
      if(message.type==='pin') {entry.pinned=!entry.pinned;publish(entry);return;}
      if(message.type==='history') {void commands.executeCommand('dbw.history');return;}
      if(message.type==='run' && entry.view.mode!=='PREVIEW' && typeof message.sql==='string' && !running) {
        void run(entry.target,message.sql).catch(error=>void window.showErrorMessage(tr(error.message)));
      }
      if(message.type==='copy' && Number.isInteger(message.row) && entry.view.result?.rows[message.row]) {
        void vscode.env.clipboard.writeText(entry.view.result.rows[message.row].map(v=>v===null?'NULL':v.replace(/[\t\r\n]+/g,' ')).join('\t'));
      }
    });
    panel.onDidDispose(()=>{receive.dispose();if(entry.panel===panel)entry.panel=undefined;});
    panel.webview.html=resultHtml(assetPaths(panel.webview));
  }
  register('history',async ()=>{
    const items=[...sessions.entries].reverse().map(entry=>({
      label:(entry.pinned?'$(pinned) ':'')+'#'+entry.view.id+' '+entry.view.sql.replace(/\s+/g,' ').slice(0,100),
      description:entry.view.target,detail:tr({running:'Running',done:'Completed',error:'Failed'}[entry.view.state])+' · '+(entry.view.elapsed??0)+' ms',entry}));
    if(!items.length) {window.setStatusBarMessage(tr("No query history in this session."),3000);return;}
    const choice=await window.showQuickPick(items,{title:tr("Session query history (memory only; selecting restores results without running SQL)"),matchOnDescription:true});
    if(choice && sessions.entries.includes(choice.entry)) showResult(choice.entry);
  });
  register('clearHistory',()=>{
    sessions.clearClosed();
    window.setStatusBarMessage(tr("Closed, unpinned history cleared; open or pinned results are kept."),4000);
  });
  async function run(target,sql,mode='DATA',table) {
    if(running) throw Error(tr("Wait for the active query to finish."));
    const connection=live(target);
    if(table===undefined) readonly(sql);
    const start=performance.now(), id=++serial;
    const entry=sessions.add({target:connection,view:{id,state:'running',sql,mode,
      target:connectionName(connection)+' / '+connection.database+(channelOf(connection)==='demo'?'':' · '+channelLabel(connection))+(targetLabel(connection)?' · '+targetLabel(connection):'')}});
    running=true;
    try {
      showResult(entry);publish(entry);
      const onProgress=phase=>{if(entry.view.state==='running') {entry.view.phase=phase;publish(entry);}};
      const result=table===undefined ? await query(connection,readonly(sql),200,undefined,undefined,onProgress) : await query(connection,undefined,100,undefined,table,onProgress);
      entry.view={...entry.view,state:'done',elapsed:Math.round(performance.now()-start),result,timings:result.timings};
      publish(entry);return result;
    } catch(error) {
      entry.view={...entry.view,state:'error',elapsed:Math.round(performance.now()-start),error:tr(error.message),timings:error.timings,diagnostic:error.diagnostic};
      publish(entry);
    } finally {running=false;}
  }
  const migration=importer(context,vscode,()=>{changed.fire();setEditorContext();},busy=>{importing=busy;});
  register('importLegacy',async()=>{
    if(online || running) throw Error(tr("Wait for the active query to finish."));
    const result=await migration.start();
    if(result?.alreadyImported) window.setStatusBarMessage(tr("Legacy settings already imported for this workspace."),4000);
    else if(result && !result.cancelled) window.setStatusBarMessage(tr('Imported {0} connections, {1} JDBC credential sets and {2} workspace bindings; legacy data is retained.',result.connections,result.credentials,result.bindings),6000);
    return result;
  });
  setEditorContext();
  return {importLegacyData:migration.receive};
}
module.exports = {activate};
