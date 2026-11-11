'use strict';
const vscode = require('vscode');
const {randomUUID} = require('node:crypto');
const {DEMO,demoQuery,pickSql,readonly,quoteTable} = require('./query.cjs');
const {makeJdbc,UnknownState,connectionConfig} = require('./jdbc.cjs');
const {makeDms,DmsStopped,dmsConfig,listDmsProfiles} = require('./dms.cjs');
const {relationAt,tableDdl} = require('./ddl.cjs');
const {languages,regionAt,selectedSql} = require('./embedded.cjs');
const {suggestions,ddlColumns} = require('./completion.cjs');
const {Sessions} = require('./sessions.cjs');
const {connectHtml,resultHtml} = require('./webviews.cjs');
const {importer}=require('./migration.cjs');
const path=require('node:path');

// Version 0.1.0 stored JDBC connections without a channel field.
const channelOf = c => c.engine === 'demo' ? 'demo' : c.channel === 'dms' ? 'dms' : 'jdbc';
const channelLabel = c => channelOf(c) === 'demo' ? 'offline'
  : channelOf(c) === 'jdbc' && c.sslMode === 'DISABLED' ? 'JDBC · Unencrypted' : channelOf(c).toUpperCase();
const targetSignature = c => JSON.stringify([channelOf(c),c.engine,c.host,c.port,c.database,c.databaseId,c.sslMode??'VERIFY_IDENTITY',...(channelOf(c)==='dms' ? [c.profile??'dms-prod',c.region??'cn-hangzhou'] : [])]);

function activate(context) {
  const {window,workspace,commands,TreeItem,TreeItemCollapsibleState: State,ThemeIcon,Uri} = vscode;
  const bindings = new WeakMap(), tables = new Map([['demo',['products']]]);
  const columns = new Map([['demo',new Map([['products',demoQuery('DESCRIBE products').rows]])]]);
  const ddlCache = new Map(), ddlPending = new Map();
  const changed = new vscode.EventEmitter();
  const sessions=new Sessions();
  let activeId = DEMO.id, running = false, online = false, importing = false, serial = 0;
  const all = () => [DEMO,...context.globalState.get('connections',[])];
  const live = old => {
    const current = all().find(item => item.id === old.id);
    if (!current || current.revision !== old.revision) throw Error('连接目标或认证已变更，请为当前文件重新选择执行连接。');
    return current;
  };
  function getTarget(node) {
    const id = node?.connection?.id ?? activeId;
    const connection = all().find(c => c.id === id);
    if (!connection) throw Error('This connection is no longer available.');
    return connection;
  }

  const workspaceDdlKey = 'ddlConnection:workspaceDefault';
  const workspaceDdl = () => context.workspaceState.get(workspaceDdlKey);
  const workspaceDdlCommand = 'setWorkspaceDdlConnection';
  const branch = {connection:'database',schema:'symbol-namespace',tables:'folder',table:'table',column:'symbol-field',group:'folder',ddlDefault:'settings-gear'};
  const tree = {
    onDidChangeTreeData: changed.event,
    getTreeItem(node) {
      const children = node.kind !== 'ddlDefault' && node.kind !== 'column' && (node.kind !== 'table' || columns.get(node.connection.id)?.has(node.label));
      const item = new TreeItem(node.label,!children ? State.None : (node.connection?.engine === 'demo' && node.kind !== 'table') || node.kind === 'group' ? State.Expanded : State.Collapsed);
      item.id = JSON.stringify([node.connection?.id,node.kind,node.table,node.label]);
      item.iconPath = new ThemeIcon(branch[node.kind]);
      item.contextValue = node.connection?.id === 'demo' && node.kind === 'connection' ? 'dbw-schema' : 'dbw-' + node.kind;
      if (node.kind === 'ddlDefault') {
        const selection=workspaceDdl();
        item.description='未设置';
        if (selection) {
          try { item.description=live(selection).name; } catch { item.description='连接已变更，请重新选择'; }
        }
        item.tooltip='点击选择此工作区的 DDL 默认预览连接。单文件设置优先，不影响 Run SQL。';
        item.command={command:'dbw.' + workspaceDdlCommand,title:'设置工作区默认表定义预览连接'};
      }
      if (node.kind === 'connection') item.description = channelLabel(node.connection);
      if (node.kind === 'tables') item.description = tables.has(node.connection.id) ? String(tables.get(node.connection.id).length) : 'Load tables ↗';
      if (node.kind === 'column') item.description = node.type;
      if (node.kind === 'table') item.command = {command:'dbw.describe',title:'Properties',arguments:[node]};
      return item;
    },
    getParent(node) {
      const c=node.connection;
      if(node.kind==='table') return {kind:'tables',label:'Tables',connection:c};
      if(node.kind==='tables') return {kind:'schema',label:c.database,connection:c};
      if(node.kind==='schema') return {kind:'connection',label:c.name,connection:c};
      if(node.kind==='connection' && c.group) return {kind:'group',label:c.group};
    },
    getChildren(node) {
      const c = node?.connection;
      const connectionNode = connection => ({kind:'connection',label:connection.name,connection});
      if (!node) {
        const connections = all();
        const groups = [...new Set(connections.map(x=>x.group).filter(Boolean))];
        const settings=workspace.workspaceFolders?.length ? [{kind:'ddlDefault',label:'DDL 默认预览连接'}] : [];
        return [...settings,...connections.filter(x=>!x.group).map(connectionNode),...groups.map(label=>({kind:'group',label}))];
      }
      if (node.kind === 'group') return all().filter(x=>x.group===node.label).map(connectionNode);
      if (node.kind === 'connection') return [{kind:'schema',label:c.database,connection:c}];
      if (node.kind === 'schema') return [{kind:'tables',label:'Tables',connection:c}];
      if (node.kind === 'tables') return (tables.get(c.id) ?? []).map(label=>({kind:'table',label,connection:c}));
      if (node.kind === 'table') return (columns.get(c.id)?.get(node.label) ?? []).map(([label,type])=>({kind:'column',label,type,table:node.label,connection:c}));
      return [];
    }
  };
  const treeView=window.createTreeView('dbw.explorer',{treeDataProvider:tree});
  context.subscriptions.push(changed,treeView);

  function register(name, callback) {
    context.subscriptions.push(commands.registerCommand('dbw.' + name, async (...args) => {
      try {
        if(importing) throw Error('Wait for the legacy migration to finish.');
        return await callback(...args);
      }
      catch (error) { void window.showErrorMessage('SQLQuay: ' + error.message); }
    }));
  }
  const cfg = () => workspace.getConfiguration('dbWorkbench');
  const secretKey = id => 'jdbc:' + id;
  async function credentialsFor(connection) {
    const raw = await context.secrets.get(secretKey(connection.id));
    if (!raw) throw Error('Edit this connection to enter its read-only credentials.');
    const value = JSON.parse(raw);
    if (typeof value?.user !== 'string' || typeof value?.password !== 'string') throw Error('Saved credentials are unavailable.');
    return value;
  }
  const pendingChannel = () => context.globalState.get('jdbcPending',false) ? 'JDBC'
    : context.globalState.get('dmsPending',false) ? 'DMS' : undefined;
  async function query(connection, sql, limit = 200, credentials, table) {
    const channel = channelOf(connection);
    if (channel === 'demo') {
      if (table === 'products') return demoQuery('SELECT id, name, category, price FROM products LIMIT 100');
      return demoQuery(sql);
    }
    if (!workspace.isTrusted) throw Error('Online queries are disabled in untrusted workspaces.');
    if(importing) throw Error('Wait for the legacy migration to finish.');
    if (online) throw Error('An online operation is already running.');
    const pending = pendingChannel();
    if (pending) throw Error(pending + ' stopped without a safe continuation. Verify its state and unlock before using either online connection.');
    const key = channel + 'Pending';
    online = true;
    try {
      const settings = cfg(), python = settings.get('pythonPath');
      const execute = channel === 'dms'
        ? () => makeDms({python,wrapper:settings.get('dmsWrapperPath') || path.join(context.extensionPath,'policy','execute_safe.py')})(connection,sql,limit,table)
        : async () => {
          const auth = credentials ?? await credentialsFor(connection);
          return makeJdbc({java:settings.get('javaPath'),python,jar:settings.get('driverJar'),guard:settings.get('guardPath') || path.join(context.extensionPath,'policy','query_guard.py')},context.extensionPath)(connection,auth,sql,limit,table);
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
  connectionStatus.name='SQLQuay 当前执行连接';
  context.subscriptions.push(connectionStatus);
  function setEditorContext() {
    const doc=window.activeTextEditor?.document;
    const enabled=(savedSql(doc) && supported(doc)) || !!bindings.get(doc) || !!executionBinding(doc);
    void commands.executeCommand('setContext','dbw.runnableEditor',enabled);
    if (!enabled) { connectionStatus.hide(); return; }
    const bound=executionBinding(doc);
    let label='选择执行连接';
    if (bound) {
      try { const c=live(bound); label=c.name+' / '+c.database+' · '+channelLabel(c); }
      catch { label='连接已变更，重新选择'; }
    }
    connectionStatus.text='$(database) '+label;
    connectionStatus.tooltip='当前文件的执行连接。点击切换；工作区默认预览连接不会自动用于执行 SQL。';
    connectionStatus.show();
  }
  context.subscriptions.push(window.onDidChangeActiveTextEditor(setEditorContext));
  async function chooseConnection({doc,schema,title,resetLabel,current}) {
    const options=all().filter(c=>(workspace.isTrusted || channelOf(c)==='demo') && (!schema || c.database===schema));
    if (!options.length) throw Error('没有符合这个库名的预览连接，请先添加连接。');
    const items=[...options.filter(c=>c!==DEMO),...options.filter(c=>c===DEMO)].map(c=>({
      label:c.name,description:c.database + ' · ' + channelLabel(c) +
        (bindingSignature(c)===bindingSignature(current) ? ' · 当前选择' : ''),connection:c
    }));
    if (resetLabel) items.push({label:resetLabel,reset:true});
    const choice=await window.showQuickPick(items,{title,placeHolder:schema ?? '选择 JDBC 或 DMS 连接'});
    if (!choice || doc?.isClosed) return;
    return choice.reset ? null : live(choice.connection);
  }
  const fileDdlTitle = '为此 SQL 文件选择表定义预览连接';
  const rememberDdlConnection = (doc,c) => saveDdlBinding(fileDdlKey(doc),c);
  register(workspaceDdlCommand,async ()=>{
    if (!workspace.workspaceFolders?.length) throw Error('请先打开一个 VS Code 工作区。');
    const current=workspaceDdl();
    const connection=await chooseConnection({title:'设置工作区默认表定义预览连接',current,
      resetLabel:current ? '清除工作区默认连接' : undefined});
    if (connection===undefined) return;
    await saveDdlBinding(workspaceDdlKey,connection);
    changed.fire();
    window.setStatusBarMessage(connection ? '工作区默认预览连接：' + connection.name : '已清除工作区默认预览连接。',4000);
  });
  register('bindDdlConnection',async ()=>{
    const doc=window.activeTextEditor?.document;
    if (!savedSql(doc)) throw Error('请打开一个已有的 SQL 文件。');
    if (executionBinding(doc)) throw Error('当前文件的悬停和预览跟随执行连接，请使用“选择当前文件的执行连接”切换。');
    const override=fileDdl(doc);
    const connection=await chooseConnection({doc,title:fileDdlTitle,current:ddlBinding(doc),
      resetLabel:override ? '清除文件单独设置（使用工作区默认）' : undefined});
    if (connection===undefined) return;
    await rememberDdlConnection(doc,connection);
    window.setStatusBarMessage(connection ? '表定义预览连接：' + connection.name : '已清除文件单独设置。',4000);
  });
  async function bindConnection(doc) {
    if (!savedSql(doc) && !bindings.has(doc)) throw Error('请先打开一个本地 SQL 文件或 New Query 编辑器。');
    const current=executionBinding(doc), signature=bindingSignature(current);
    const connection=await chooseConnection({doc,title:'选择当前文件的执行连接',current,
      resetLabel:current ? '清除执行连接（保留预览设置）' : undefined});
    if (connection===undefined) return;
    if (doc.isClosed || bindingSignature(executionBinding(doc))!==signature) throw Error('文件连接已变更，请重新选择。');
    if (savedSql(doc)) await saveDdlBinding(fileSqlKey(doc),connection);
    else if (connection) bindings.set(doc,connection);
    else bindings.delete(doc);
    setEditorContext();
    return connection;
  }
  register('bindConnection',()=>bindConnection(window.activeTextEditor?.document));
  register('searchTables',async node=>{
    const scope=node?.connection;
    const items=all().filter(c=>!scope || c.id===scope.id).flatMap(connection=>(tables.get(connection.id)??[])
      .map(table=>({label:table,description:connection.name+' / '+connection.database+' · '+channelLabel(connection),connection,table})));
    if(!items.length) throw Error('请先使用 Load / Refresh Tables 加载表清单。');
    const choice=await window.showQuickPick(items,{title:'搜索已加载的表',matchOnDescription:true});
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
        item.detail=v.kind==='table' ? c.name+' / '+c.database : v.type;
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
      if (pendingChannel()) return Promise.resolve({error:'在线查询已锁定，请先核对上一条查询的状态。'});
      if (online) return Promise.resolve({error:'另一条在线请求正在运行，结束后再悬停。'});
    }
    const task=(async ()=>{
      let preview, fields;
      try {
        const result=await query(connection,'SHOW CREATE TABLE ' + quoteTable(connection.database) + '.' + quoteTable(table),1);
        const ddl=tableDdl(result);
        preview={ddl:ddl.slice(0,ddlPreviewLimit),truncated:ddl.length>ddlPreviewLimit};
        fields=ddlColumns(ddl);
      } catch (error) {
        // A failed hover is not retried automatically; refreshing the connection clears it.
        preview={error:error.message};
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
        ? connection.database + '.' + ref.table + ' · ' + connection.name + ' · ' + channelLabel(connection) +
          (file && !executionBinding(doc) && !fileDdl(doc) ? ' · 工作区默认' : '')
        : (ref.schema ? ref.schema + '.' : '') + ref.table +
          (executionBinding(doc) ? ' · 请切换当前文件的执行连接' : ' · 请先选择预览连接'));
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
          if (preview.truncated) body.appendText('表定义过长，仅显示前 24,000 个字符。');
          return new vscode.Hover([heading,hoverLink('预览数据',previewCommand,doc,offset,bound),body],range);
        }
      } else {
        if (executionBinding(doc)) {
          body.appendText('请点击状态栏或编辑器右上的数据库图标，重新选择匹配此表的执行连接。');
          return new vscode.Hover([heading,body],range);
        }
        return new vscode.Hover([heading,hoverLink('选择预览连接',ddlCommand,doc,offset,bound)],range);
      }
      return new vscode.Hover([heading,body],range);
    }
  }));
  register('previewTable',(uri,version,offset,signature)=>{
    const doc=workspace.textDocuments.find(d=>d.uri.toString()===uri);
    const bound=doc && ddlBinding(doc);
    if (!bound || doc.isClosed || doc.version!==version || !Number.isInteger(offset) || bindingSignature(bound)!==signature) {
      throw Error('文件或预览连接已变更，请重新悬停表名。');
    }
    const connection=live(bound);
    const part=region(doc,offset);
    const ref=part && relationAt(part.text,offset-part.start,connection.database);
    if (!ref || !ddlCache.get(ddlKey(connection,ref.table))?.ddl) throw Error('请重新悬停表名后预览数据。');
    return run(connection,connection.database + '.' + ref.table,'PREVIEW',ref.table);
  });
  register('loadTableDdl',async (uri,version,offset,signature)=>{
    const doc=workspace.textDocuments.find(d=>d.uri.toString()===uri);
    const current=()=>doc && !doc.isClosed && doc.version===version && bindingSignature(ddlBinding(doc))===signature;
    if (!current() || !Number.isInteger(offset)) throw Error('请在 SQL 编辑器中重新悬停表名。');
    const bound=ddlBinding(doc), file=savedSql(doc);
    let connection;
    if (bound) try { connection=live(bound); } catch (error) { if (!file) throw error; }
    if (!connection && !file) throw Error('请在绑定的 SQL 编辑器中重新悬停表名。');
    const part=region(doc,offset);
    const ref=part && relationAt(part.text,offset-part.start,file ? undefined : connection.database);
    if (!ref) throw Error('当前光标不是可预览的表名。');
    if (file && (!connection || (ref.schema && ref.schema!==connection.database))) {
      connection=await chooseConnection({doc,schema:ref.schema,title:fileDdlTitle});
      if (!connection) return;
      if (!current()) throw Error('文件或预览连接已变更，请重新悬停表名。');
      await rememberDdlConnection(doc,connection);
    }
    const preview=await window.withProgress({location:vscode.ProgressLocation.Notification,title:'正在加载表定义…'},
      ()=>loadDdl(connection,ref.table));
    if (preview.error) throw Error(preview.error);
    window.setStatusBarMessage('表定义已加载，再次悬停表名可查看。',4000);
  });
  function assetPaths(view) {
    const media = Uri.joinPath(context.extensionUri,'media');
    const uri = name => view.asWebviewUri(Uri.joinPath(media,name)).toString();
    return {csp:view.cspSource,css:uri('workbench.css'),script:uri('workbench.js'),icon:uri('database.svg')};
  }
  const webOptions = {enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[Uri.joinPath(context.extensionUri,'media')]};
  let formPanel;
  function openForm(edit) {
    if (formPanel) {
      formPanel.dispose();
      formPanel=undefined;
    }
    const panel = window.createWebviewPanel('dbw.connect',edit ? 'Edit ' + edit.name : 'Connect to server',vscode.ViewColumn.One,webOptions);
    formPanel=panel;
    let busy=false;
    const receive = panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      if (message.type==='close' && !busy) { panel.dispose();return; }
      if (message.type==='loadDmsProfiles') {
        if(!workspace.isTrusted) return;
        try { await panel.webview.postMessage({type:'dmsProfiles',profiles:await listDmsProfiles()}); }
        catch(error) { await panel.webview.postMessage({type:'dmsProfiles',profiles:[],message:error.message}); }
        return;
      }
      if (message.type==='configureDms') {
        if(!workspace.isTrusted) return;
        const terminal=window.createTerminal({name:'SQLQuay · Aliyun CLI setup'});
        terminal.show();terminal.sendText('aliyun configure --profile my-dms',false);
        return;
      }
      if (message.type==='ready') { if(edit) await panel.webview.postMessage({type:'configure',connection:{...edit,channel:channelOf(edit)}});return; }
      if (busy || !['save','connect'].includes(message.type) || !message.values || typeof message.values!=='object') return;
      busy=true;
      let disposed = false;
      const lifecycle = panel.onDidDispose(()=>{disposed=true;});
      try {
        if (!workspace.isTrusted) throw Error('Online connection configuration is disabled in untrusted workspaces.');
        if (edit) live(edit);
        const channel = message.values.channel;
        if (!['jdbc','dms'].includes(channel) || (edit && channel !== channelOf(edit))) {
          throw Error('To change the connection method, create a new connection.');
        }
        const data = channel === 'dms' ? dmsConfig(message.values) : connectionConfig(message.values);
        const connection = {...data,channel,id:edit?.id ?? randomUUID(),revision:edit ? edit.revision : randomUUID()};
        let credentials, newUser = false;
        if (channel === 'jdbc') {
          const user = typeof message.values.user === 'string' ? message.values.user.trim() : '';
          const password = typeof message.values.password === 'string' ? message.values.password : '';
          if (user.length > 256 || password.length > 1024 || (password && !user)) throw Error('Enter a valid read-only username and password.');
          if (!edit && !user) throw Error('Enter a read-only username.');
          const changedTarget = edit && ['host','port','database','engine'].some(key=>connection[key]!==edit[key]);
          if (changedTarget && !user) throw Error('Re-enter credentials when changing the target.');
          if (connection.sslMode === 'DISABLED' && (edit?.sslMode !== 'DISABLED' || changedTarget)) {
            const action = 'Use Unencrypted JDBC';
            const answer = await window.showWarningMessage(
              'This JDBC connection will send traffic without TLS. The server identity is not verified, and SQL and results can be intercepted or modified. Prefer DMS on public networks.',
              {modal:true},action
            );
            if (answer !== action || disposed) throw Error('Unencrypted JDBC was not confirmed. Choose verified TLS or use DMS.');
          }
          credentials = user ? {user,password} : await credentialsFor(edit);
          newUser = !!user;
        }
        if (edit && (targetSignature(edit)!==targetSignature(connection) || newUser)) connection.revision=randomUUID();
        const changedConnection=!edit || connection.revision!==edit.revision;
        const catalog = message.type === 'connect' ? await query(connection,'SHOW TABLES',10000,credentials) : undefined;
        if (disposed) return;
        const existing = context.globalState.get('connections',[]);
        if (catalog?.truncated) throw Error('The table list exceeded the metadata display limit.');
        if (newUser) await context.secrets.store(secretKey(connection.id),JSON.stringify(credentials));
        await context.globalState.update('connections',edit ? existing.map(c=>c.id===edit.id ? connection:c) : [...existing,connection]);
        if (catalog) tables.set(connection.id,tableNames(catalog)); else if (changedConnection) tables.delete(connection.id);
        if (changedConnection) { columns.delete(connection.id); clearDdl(connection); }
        activeId = connection.id; changed.fire(); setEditorContext(); panel.dispose();
      } catch (error) {
        if (!disposed) await panel.webview.postMessage({type:'error',message:error.message});
      } finally { busy=false; lifecycle.dispose(); }
    });
    panel.onDidDispose(()=>{receive.dispose();if(formPanel===panel) formPanel=undefined;});
    panel.webview.html=connectHtml(assetPaths(panel.webview));
  }

  function tableNames(catalog) { return catalog.rows.map(row=>row[0]).filter(name=>typeof name==='string' && name); }
  register('connect',()=>openForm());
  register('edit',node=>{const connection=getTarget(node); if(connection.engine!=='demo') openForm(connection);});
  register('remove',async node=>{
    const connection=getTarget(node); if(connection.engine==='demo') return;
    const confirmed=await window.showWarningMessage('Remove ' + connection.name + '?',{modal:true},'Remove');
    if (confirmed!=='Remove') return;
    await context.globalState.update('connections',context.globalState.get('connections',[]).filter(c=>c.id!==connection.id));
    if (channelOf(connection) === 'jdbc') await context.secrets.delete(secretKey(connection.id));
    tables.delete(connection.id); columns.delete(connection.id); clearDdl(connection); if(activeId===connection.id) activeId='demo'; changed.fire(); setEditorContext();
  });
  register('refresh',async node=>{
    const connection=getTarget(node);
    const result=await window.withProgress({location:vscode.ProgressLocation.Notification,title:'Loading tables · ' + connection.name},()=>query(connection,'SHOW TABLES',10000));
    if(result.truncated) throw Error('The table list exceeded the metadata display limit.');
    live(connection); tables.set(connection.id,tableNames(result)); if(connection.id!=='demo') columns.delete(connection.id); clearDdl(connection); changed.fire();
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
    if(!editor) throw Error('请先打开编辑器。');
    const doc=editor.document, version=doc.version;
    const offset=doc.offsetAt(editor.selection.active), selected=doc.getText(editor.selection);
    const part=region(doc,offset);
    if(!selected.trim() && !part) throw Error('请选中纯 SQL，或将光标放在受支持的 SQL 代码块内。');
    let sql=selected.trim() ? selected : pickSql(part.text,offset-part.start,'');
    if(doc.languageId!=='sql') sql=selectedSql(sql);
    const bound=executionBinding(doc) ?? await bindConnection(doc);
    if (!bound) return;
    if (doc.isClosed || doc.version!==version || window.activeTextEditor?.document!==doc) throw Error('SQL 文件已变更，请重新执行。');
    return run(bound,sql);
  });
  register('describe',async node=>{
    if(node?.kind!=='table' || !tables.get(node.connection.id)?.includes(node.label)) throw Error('Choose a table from the Database tree.');
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
    const action = pending === 'DMS' ? 'the DMS query has ended and AI Mode is clean' : 'the JDBC query has ended on the server';
    if (await window.showWarningMessage('Confirm ' + action + ' before unlocking either online connection.',{modal:true},'Confirmed')==='Confirmed') {
      await context.globalState.update(pending.toLowerCase() + 'Pending',false);
    }
  });
  function publish(entry) {
    if(entry.panel) {
      entry.panel.title=(entry.pinned?'📌 ':'')+'Query Result #'+entry.view.id+' · '+entry.view.mode;
      void entry.panel.webview.postMessage({...entry.view,pinned:!!entry.pinned});
    }
  }
  function showResult(entry) {
    if(entry.panel) {entry.panel.reveal(undefined,true);return;}
    const panel=window.createWebviewPanel('dbw.result','Query Result #'+entry.view.id+' · '+entry.view.mode,
      {viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},webOptions);
    entry.panel=panel;
    const receive=panel.webview.onDidReceiveMessage(message=>{
      if(!message || typeof message!=='object') return;
      if(message.type==='ready') {publish(entry);return;}
      if(message.runId!==entry.view.id) return;
      if(message.type==='pin') {entry.pinned=!entry.pinned;publish(entry);return;}
      if(message.type==='history') {void commands.executeCommand('dbw.history');return;}
      if(message.type==='run' && entry.view.mode!=='PREVIEW' && typeof message.sql==='string' && !running) {
        void run(entry.target,message.sql).catch(error=>void window.showErrorMessage(error.message));
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
      description:entry.view.target,detail:entry.view.state+' · '+(entry.view.elapsed??0)+' ms',entry}));
    if(!items.length) {window.setStatusBarMessage('本次会话暂无查询历史。',3000);return;}
    const choice=await window.showQuickPick(items,{title:'会话查询历史（仅内存，选择只恢复结果，不执行 SQL）',matchOnDescription:true});
    if(choice && sessions.entries.includes(choice.entry)) showResult(choice.entry);
  });
  register('clearHistory',()=>{
    sessions.clearClosed();
    window.setStatusBarMessage('已清除关闭且未固定的会话历史；打开或固定的结果仍保留。',4000);
  });
  async function run(target,sql,mode='DATA',table) {
    if(running) throw Error('Wait for the active query to finish.');
    const connection=live(target);
    if(table===undefined) readonly(sql);
    const start=performance.now(), id=++serial;
    const entry=sessions.add({target:connection,view:{id,state:'running',sql,mode,
      target:connection.name+' / '+connection.database+(channelOf(connection)==='demo'?'':' · '+channelLabel(connection))}});
    running=true;
    try {
      showResult(entry);publish(entry);
      const result=table===undefined ? await query(connection,readonly(sql)) : await query(connection,undefined,100,undefined,table);
      entry.view={...entry.view,state:'done',elapsed:Math.round(performance.now()-start),result,timings:result.timings};
      publish(entry);return result;
    } catch(error) {
      entry.view={...entry.view,state:'error',elapsed:Math.round(performance.now()-start),error:error.message,timings:error.timings};
      publish(entry);
    } finally {running=false;}
  }
  const migration=importer(context,vscode,()=>{changed.fire();setEditorContext();},busy=>{importing=busy;});
  register('importLegacy',async()=>{
    if(online || running) throw Error('Wait for the active query to finish.');
    const result=await migration.start();
    if(result?.alreadyImported) window.setStatusBarMessage('当前工作区已导入旧版配置。',4000);
    else if(result && !result.cancelled) window.setStatusBarMessage(`已导入 ${result.connections} 个连接、${result.credentials} 套 JDBC 凭据、${result.bindings} 个当前工作区绑定；旧数据保留。`,6000);
    return result;
  });
  setEditorContext();
  return {importLegacyData:migration.receive};
}
module.exports = {activate};
