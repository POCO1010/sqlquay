'use strict';
const {test} = require('node:test'), assert=require('node:assert/strict'), Module=require('node:module');
const {DmsStopped}=require('../src/dms.cjs');
const {translator}=require('../media/i18n.js');
for(const language of ['zh-cn','en']) test('connection routing, safety gates, hover and session results · '+language,async()=>{
  const tr=translator(language);
  const includes=(value,key)=>assert.ok(value.includes(tr(key)),value);
  const jdbc={id:'legacy',revision:'v1',name:'Existing JDBC',group:'',engine:'mysql',host:'fixture.invalid',port:3306,database:'sandbox'};
  const state=new Map([['connections',[jdbc]]]), calls=[], panels=[], commands=new Map(), errors=[];
  let tree, hoverProvider, completionProvider, stopped=false, secretReads=0, allowPlaintext=false, blocker;
  const copied=[],deleted=[],terminals=[],opened=[],akSecrets=new Map(),akSearches=[],akExecutions=[];
  const akAuth={accessKeyId:'fixture-key-id',accessKeySecret:'fixture-key-secret'};
  let failConnectionSave=false,akReadGate,akReadStarted,akQueryGate,akQueryStarted;
  const status={show(){this.visible=true;},hide(){this.visible=false;},dispose(){}}, stored=[];
  const documents=[], previewBindings=new Map();
  let pickedId, pickItems, duringPick, pickHistoryId, revealed;
  const grid=(label,rows)=>({columns:label.map(name=>({name,type:''})),rows,truncated:false});
  const dispose=()=>({dispose(){}});
  const window={
    createTerminal(options){const terminal={options,show(){this.shown=true;},sendText(text,execute){this.text=text;this.execute=execute;}};terminals.push(terminal);return terminal;},
    createTreeView(_,options){tree=options.treeDataProvider;return {...dispose(),reveal:async node=>{revealed=node;}};},
    createStatusBarItem:()=>status,
    onDidChangeActiveTextEditor:dispose,
    createWebviewPanel(type,title){
      const listeners=[], panel={type,title,messages:[],reveal(){},onDidDispose(fn){listeners.push(fn);return dispose();},dispose(){for(const fn of [...listeners]) fn();}};
      panel.webview={
        asWebviewUri:uri=>uri,cspSource:"'self'",postMessage:async m=>panel.messages.push(m),
        onDidReceiveMessage(fn){panel.receive=fn;return dispose();}
      };
      panels.push(panel);return panel;
    },
    showErrorMessage:e=>errors.push(e),
    showQuickPick:async items=>{pickItems=items;duringPick?.();return items.find(x=>pickHistoryId ? x.entry?.view.id===pickHistoryId : pickedId==='reset' ? x.reset : x.connection?.id===pickedId);},
    withProgress:(_,fn)=>fn(),setStatusBarMessage:()=>{},
    showWarningMessage:async(message, _options, action)=>{
      if(action===tr('Use Unencrypted JDBC')) {
        assert.equal(message,tr("This JDBC connection will send traffic without TLS. The server identity is not verified, and SQL and results can be intercepted or modified. Prefer DMS on public networks."));return allowPlaintext ? action : undefined;
      }
      return action;
    },
    showTextDocument:async document=>{window.activeTextEditor={document,selection:{active:0}};}
  };
  const vscode={window,env:{language,openExternal:async url=>opened.push(url),clipboard:{writeText:async value=>copied.push(value)}},workspace:{isTrusted:true,workspaceFolders:[{}],getWorkspaceFolder:uri=>uri.toString().startsWith('file:///workspace/') ? {} : undefined,getConfiguration:()=>({get:()=>''}),textDocuments:documents,openTextDocument:async ({content,language})=>{
    const doc={languageId:language,uri:'untitled:'+documents.length,version:1,text:content,offsetAt:n=>n,positionAt:n=>n,getText(selection){return selection?'':this.text;}};
    documents.push(doc);return doc;
  }},commands:{executeCommand:async()=>{},registerCommand:(id,fn)=>{commands.set(id,fn);return dispose();}},
    StatusBarAlignment:{Right:2},languages:{registerHoverProvider:(_,p)=>{hoverProvider=p;return dispose();},registerCompletionItemProvider:(_,p)=>{completionProvider=p;return dispose();}},ProgressLocation:{Notification:1},
    CompletionItem:class{constructor(label,kind){Object.assign(this,{label,kind});}},CompletionItemKind:{Struct:1,Field:2},
    MarkdownString:class {value='';appendText(s){this.value+=s;} appendMarkdown(s){this.value+=s;} appendCodeblock(s){this.value+=s;}},
    Hover:class {constructor(contents,range){Object.assign(this,{contents,range});}}, Range:class {},
    TreeItem:class {},TreeItemCollapsibleState:{},ThemeIcon:class {},Uri:{joinPath:(...v)=>v.join('/'),parse:value=>value},
    EventEmitter:class {fire(){}},ViewColumn:{One:1,Beside:2}};
  const load=Module._load;
  let activate;
  try {
    Module._load=function(request,parent,isMain){
      if (parent?.filename.endsWith('/src/extension.cjs')) {
        if(request==='vscode') return vscode;
        if(request==='./jdbc.cjs') return {...load.apply(this,arguments),makeJdbc:()=>async(connection,credentials,sql,limit,table)=>{
          if (table) { calls.push(['preview','jdbc',connection.id,table,limit]);return grid(['id'],[['1']]); }
          calls.push(['jdbc',connection.id,sql]);assert.equal(credentials.user,'reader');
          if(blocker) await blocker;
          if(sql.startsWith('SHOW CREATE TABLE')) return grid(['Table','Create Table'],[['products','CREATE TABLE products (jdbc INT)']]);
          return grid(['probe'],[['jdbc']]);
        }};
        if(request==='./dms.cjs') return {...load.apply(this,arguments),listDmsProfiles:async()=>[{name:'team-fixture',region:'cn-beijing',valid:true}],
          searchDmsDatabases:async(_settings,search,auth)=>{akSearches.push(search);assert.deepEqual(auth,akAuth);const target=search.keyword==='multi-b'?{database:'orders',databaseId:'43'}:search.keyword==='multi-c'?{database:'dimensions',databaseId:'44'}:{database:'sandbox',databaseId:'42'};return {databases:[{...target,engine:'mysql',label:target.database+' · Fixture · #'+target.databaseId}],more:false};},
          makeDms:()=>async(connection,sql,limit,table,auth)=>{
          if(connection.authMode==='accessKey' && akQueryGate) {const gate=akQueryGate;akQueryGate=undefined;akQueryStarted?.();await gate;}
          if(connection.authMode==='accessKey') {assert.deepEqual(auth,akAuth);akExecutions.push({id:connection.id,accountId:connection.accountId,database:connection.database,databaseId:connection.databaseId,sql,table});}
          if (table) { calls.push(['preview','dms',connection.id,table,limit]);return grid(['id'],[['2']]); }
          calls.push(['dms',connection.id,sql]);
          if(stopped) throw new DmsStopped('DMS fixture stopped.');
          if(sql==='SHOW TABLES') return grid(['Tables_in_sandbox'],[['products']]);
          if(sql.startsWith('SHOW CREATE TABLE')) return grid(['Table','Create Table'],[['products','CREATE TABLE products ('+(connection.accountId?'db'+connection.databaseId+'_field':'dms')+' INT)']]);
          if(sql.startsWith('DESCRIBE')) return grid(['Field','Type'],[['id','BIGINT']]);
          return grid(['probe'],[['dms']]);
        }};
      }
      return load.apply(this,arguments);
    };
    delete require.cache[require.resolve('../src/extension.cjs')];
    ({activate}=require('../src/extension.cjs'));
  } finally { Module._load=load; }
  activate({extensionUri:'fixture',extensionPath:'fixture',subscriptions:[],
    globalState:{get:(key,other)=>state.get(key)??other,update:async(key,value)=>{if(key==='connections' && failConnectionSave){failConnectionSave=false;throw Error('fixture storage failure');}state.set(key,value);}},
    workspaceState:{get:key=>previewBindings.get(key),update:async(key,value)=>previewBindings.set(key,value)},
    secrets:{get:async key=>{if(key.startsWith('dms-ak:')) {if(akReadGate){const gate=akReadGate;akReadGate=undefined;akReadStarted?.();await gate;}return akSecrets.get(key);}secretReads++;assert.equal(key,'jdbc:legacy');return '{"user":"reader","password":"fixture"}';},store:async(key,value)=>{stored.push([key,value]);if(key.startsWith('dms-ak:')) akSecrets.set(key,value);},delete:async key=>{deleted.push(key);akSecrets.delete(key);}}
  });
  const run=(id,...args)=>commands.get('dbw.'+id)(...args);
  const jdbcNode=tree.getChildren().find(x=>x.connection?.id==='legacy');
  assert.equal(tree.getTreeItem(jdbcNode).description,'JDBC');
  await run('newQuery',jdbcNode);
  const jdbcEditor=window.activeTextEditor;
  await run('connect');
  const form=panels.at(-1);
  includes(form.title,'Connect to server');
  assert.ok(form.webview.html.includes('lang="'+(language==='en'?'en':'zh-CN')+'"'));
  assert.equal(tree.getChildren().find(n=>n.connection?.id==='demo').label,tr('Local Demo'));
  await form.receive({type:'loadDmsProfiles'});assert.equal(form.messages.at(-1).profiles[0].name,'team-fixture');
  await form.receive({type:'configureDms'});assert.equal(terminals[0].text,'aliyun configure --profile my-dms');assert.equal(terminals[0].execute,false);assert.equal(secretReads,0);
  await form.receive({type:'connect',values:{channel:'dms',name:'DMS fixture',keyword:'sandbox',database:'sandbox',databaseId:'42'}});
  const dmsNode=tree.getChildren().find(x=>x.connection?.channel==='dms');
  assert.equal(tree.getTreeItem(dmsNode).description,'DMS');
  assert.equal(secretReads,0);
  assert.equal(stored.length,0);
  const table=tree.getChildren(tree.getChildren(tree.getChildren(dmsNode)[0])[0])[0];
  assert.equal(table.label,'products');
  assert.deepEqual((await run('describe',table)).rows,[['id','BIGINT']]);
  const firstResult=panels.at(-1), firstSnapshot=firstResult.messages.at(-1);
  const currentPanel=()=>panels.filter(p=>p.type==='dbw.result').at(-1);
  await run('newQuery',dmsNode);
  const dmsEditor=window.activeTextEditor;
  assert.deepEqual((await run('run')).rows,[['dms']]);
  assert.match(currentPanel().messages.at(-1).target,/· DMS$/);
  window.activeTextEditor=jdbcEditor;
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.match(currentPanel().messages.at(-1).target,/· JDBC$/);
  assert.equal(panels.filter(x=>x.type==='dbw.result').length,3);
  assert.equal(firstResult.messages.at(-1),firstSnapshot);
  const hoverFor=(editor,token={})=>hoverProvider.provideHover(editor.document,editor.document.text.indexOf('products')+1,token);
  jdbcEditor.document.text=dmsEditor.document.text='SELECT id FROM `sandbox`.`products`;';
  const beforeHover=calls.length;
  let cancel;
  const token={isCancellationRequested:false,onCancellationRequested(fn){cancel=fn;return dispose();}};
  const cancelled=hoverFor(jdbcEditor,token);
  token.isCancellationRequested=true;
  cancel();
  assert.equal(await cancelled,undefined);
  assert.equal(calls.length,beforeHover);
  const loadArgs=h=>JSON.parse(decodeURIComponent(h.value.split('?')[1].slice(0,-1)));
  window.activeTextEditor=dmsEditor;
  const [jdbcHit,duplicate]=await Promise.all([hoverFor(jdbcEditor),hoverFor(jdbcEditor)]);
  assert.equal(calls.length,beforeHover+1);
  assert.deepEqual(calls.at(-1),['jdbc','legacy','SHOW CREATE TABLE `sandbox`.`products`']);
  assert.match(jdbcHit.contents[2].value,/jdbc INT/);
  assert.equal(duplicate.contents[2].value,jdbcHit.contents[2].value);
  assert.equal(jdbcHit.contents[2].isTrusted,undefined);
  assert.doesNotMatch(jdbcHit.contents[2].value,/加载表定义|command:/);
  await hoverFor(jdbcEditor);
  assert.equal(calls.length,beforeHover+1);
  assert.match((await hoverFor(dmsEditor)).contents[2].value,/dms INT/);
  assert.deepEqual(calls.at(-1),['dms',dmsNode.connection.id,'SHOW CREATE TABLE `sandbox`.`products`']);
  assert.match((await hoverFor(jdbcEditor)).contents[2].value,/jdbc INT/);
  const beforeAliasHover=calls.length;
  for(const [editor,field] of [[jdbcEditor,'jdbc'],[dmsEditor,'dms']]) {
    editor.document.text='SELECT SUM(p.'+field+') FROM products p;';
    const offset=editor.document.text.indexOf('p.');
    assert.match((await hoverProvider.provideHover(editor.document,offset,{})).contents[2].value,new RegExp(field+' INT'));
    assert.deepEqual(completionProvider.provideCompletionItems(editor.document,offset+2).map(i=>i.label),[field]);
    editor.document.text='SELECT id FROM `sandbox`.`products`;';
  }
  assert.equal(calls.length,beforeAliasHover);
  await run('refresh',dmsNode);
  const afterRefresh=calls.length;
  assert.match((await hoverFor(dmsEditor)).contents[2].value,/dms INT/);
  assert.equal(calls.length,afterRefresh+1);
  const fileText='INSERT OVERWRITE TABLE `sandbox`.`file_products` SELECT 1;';
  const saved={...jdbcEditor.document,uri:{scheme:'file',toString:()=> 'file:///workspace/old.sql'},text:fileText,version:1};
  documents.push(saved);
  const fileEditor={document:saved};
  const noQuery=calls.length;
  const firstFileHover=await hoverFor(fileEditor);
  includes(firstFileHover.contents[0].value,' · Choose a preview connection first');
  includes(firstFileHover.contents[1].value,'Choose preview connection');
  assert.deepEqual(firstFileHover.contents[1].isTrusted,{enabledCommands:['dbw.loadTableDdl']});
  const fileArgs=loadArgs(firstFileHover.contents[1]);
  assert.equal(calls.length,noQuery);
  await run('loadTableDdl',...fileArgs); // picker cancelled
  assert.equal(calls.length,noQuery);
  assert.equal(previewBindings.size,0);
  pickedId=dmsNode.connection.id;
  await run('loadTableDdl',...fileArgs);
  assert.deepEqual(pickItems.map(x=>x.connection.database),['sandbox','sandbox','sandbox']);
  assert.deepEqual(calls.at(-1),['dms',dmsNode.connection.id,'SHOW CREATE TABLE `sandbox`.`file_products`']);
  assert.equal(saved.text,fileText);
  const reopened={document:{...saved}};
  assert.match((await hoverFor(reopened)).contents[2].value,/dms INT/);
  window.activeTextEditor={document:saved,selection:{active:0}};
  pickedId=jdbc.id;
  await run('bindDdlConnection');
  const beforeOldLink=calls.length;
  await run('loadTableDdl',...fileArgs);
  assert.equal(calls.length,beforeOldLink);
  includes(errors.pop(),'Hover the table name again in the SQL editor.');
  assert.match((await hoverFor(reopened)).contents[2].value,/jdbc INT/);
  assert.deepEqual(calls.at(-1),['jdbc','legacy','SHOW CREATE TABLE `sandbox`.`file_products`']);
  const workspaceDefaultEditor={document:{...saved,uri:{scheme:'file',toString:()=> 'file:///workspace/default.sql'},
    text:'SELECT * FROM default_products;'}};
  documents.push(workspaceDefaultEditor.document);
  const oldDefaultLink=loadArgs((await hoverFor(workspaceDefaultEditor)).contents[1]);
  pickedId=dmsNode.connection.id;
  const beforeDefault=calls.length;
  const defaultNode=()=>tree.getTreeItem(tree.getChildren().find(x=>x.kind==='ddlDefault'));
  assert.equal(defaultNode().description,tr('Not set'));
  assert.equal(defaultNode().command.command,'dbw.setWorkspaceDdlConnection');
  await commands.get(defaultNode().command.command)();
  assert.equal(defaultNode().description,dmsNode.connection.name);
  assert.equal(calls.length,beforeDefault);
  const outside={document:{...saved,uri:{scheme:'file',toString:()=> 'file:///outside.sql'}}};
  includes((await hoverFor(outside)).contents[0].value,' · Choose a preview connection first');
  await run('loadTableDdl',...oldDefaultLink);
  assert.equal(calls.length,beforeDefault);
  includes(errors.pop(),'Hover the table name again in the SQL editor.');
  pickedId=undefined;pickItems=undefined;
  const inherited=await hoverFor(workspaceDefaultEditor);
  includes(inherited.contents[0].value,' · Workspace default');
  assert.match(inherited.contents[2].value,/dms INT/);
  assert.equal(pickItems,undefined);
  assert.deepEqual(calls.at(-1),['dms',dmsNode.connection.id,'SHOW CREATE TABLE `sandbox`.`default_products`']);
  const fileHover=await hoverFor(fileEditor);
  assert.match(fileHover.contents[0].value,/JDBC/);
  const click=fileHover.contents[1];
  assert.ok(click.value.startsWith('['+tr('Preview data')+'](command:dbw.previewTable?'));
  assert.deepEqual(click.isTrusted,{enabledCommands:['dbw.previewTable']});
  assert.equal(calls.some(call=>call[0]==='preview'),false);
  window.activeTextEditor=dmsEditor; // click must use the originating file, not the active editor
  assert.deepEqual((await run('previewTable',...loadArgs(click))).rows,[['1']]);
  assert.deepEqual(calls.at(-1),['preview','jdbc',jdbc.id,'file_products',100]);
  assert.equal(currentPanel().messages.at(-1).mode,'PREVIEW');
  assert.deepEqual((await run('previewTable',...loadArgs(inherited.contents[1]))).rows,[['2']]);
  assert.deepEqual(calls.at(-1),['preview','dms',dmsNode.connection.id,'default_products',100]);
  assert.equal(pickItems,undefined);
  const beforeRerun=calls.length;
  await currentPanel().receive({type:'run',sql:'SELECT 1',runId:currentPanel().messages.at(-1).id});
  assert.equal(calls.length,beforeRerun);
  window.activeTextEditor={document:saved,selection:{active:0}};
  pickedId='reset';
  await run('bindDdlConnection');
  includes((await hoverFor(fileEditor)).contents[0].value,' · Workspace default');
  await run('setWorkspaceDdlConnection');
  const afterClear=calls.length;
  await run('previewTable',...loadArgs(inherited.contents[1]));
  assert.equal(calls.length,afterClear);
  includes(errors.pop(),'File or preview connection changed. Hover the table name again.');
  includes((await hoverFor(workspaceDefaultEditor)).contents[0].value,' · Choose a preview connection first');
  assert.equal(defaultNode().description,tr('Not set'));
  const beforeRun=calls.length;
  await run('run');
  assert.equal(calls.length,beforeRun); // DDL binding does not enable Run.
  assert.equal(previewBindings.get('sqlConnection:file:///workspace/old.sql'),undefined);
  assert.deepEqual(errors,[]);
  saved.text='SELECT 1 AS first; SELECT 2 AS second;';
  window.activeTextEditor={document:saved,selection:{active:saved.text.indexOf('SELECT 2')}};
  pickedId=jdbc.id;
  const beforeBind=calls.length;
  await run('bindConnection');
  assert.equal(calls.length,beforeBind); // Choosing a connection never runs SQL.
  assert.match(status.text,/Existing JDBC.*JDBC/);
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.deepEqual(calls.at(-1),['jdbc',jdbc.id,'SELECT 2 AS second']);
  const reopenedSql={...saved};
  window.activeTextEditor={document:reopenedSql,selection:{active:0,text:'SELECT 3 AS selected;'}};
  reopenedSql.getText=function(selection){return selection?.text??this.text;};
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.deepEqual(calls.at(-1),['jdbc',jdbc.id,'SELECT 3 AS selected']);
  pickedId=dmsNode.connection.id;
  await run('bindConnection');
  assert.deepEqual((await run('run')).rows,[['dms']]);
  assert.deepEqual(calls.at(-1),['dms',dmsNode.connection.id,'SELECT 3 AS selected']);
  assert.match(status.text,/DMS/);
  reopenedSql.text='SELECT id FROM file_products WHERE id=1 LIMIT 1';
  assert.match((await hoverFor({document:reopenedSql})).contents[0].value,/DMS/);
  reopenedSql.text='SELECT id FROM other.file_products';
  const beforeMismatch=calls.length;
  const mismatch=await hoverFor({document:reopenedSql});
  includes(mismatch.contents[0].value," · Change this file's execution connection");
  assert.doesNotMatch(mismatch.contents[1].value,/command:/);
  assert.equal(calls.length,beforeMismatch);
  pickedId='reset';
  await run('bindConnection');
  assert.equal(previewBindings.get('sqlConnection:file:///workspace/old.sql'),undefined);
  pickedId=undefined;
  const cancelCalls=calls.length;
  await run('run');
  assert.equal(calls.length,cancelCalls);
  includes(status.text,'Choose execution connection');
  const directDoc={...saved,uri:{scheme:'file',toString:()=> 'file:///workspace/direct.sql'}};
  window.activeTextEditor={document:directDoc,selection:{active:0}};
  pickedId=jdbc.id;
  assert.deepEqual((await run('run')).rows,[['jdbc']]); // First Run offers a connection, then executes.
  assert.equal(previewBindings.get('sqlConnection:file:///workspace/direct.sql').id,jdbc.id);
  const changedDoc={...saved,uri:{scheme:'file',toString:()=> 'file:///workspace/changed.sql'}};
  window.activeTextEditor={document:changedDoc,selection:{active:0}};
  duringPick=()=>{changedDoc.version++;};
  const beforeChangedDoc=calls.length;
  await run('run');
  duringPick=undefined;
  assert.equal(calls.length,beforeChangedDoc);
  includes(errors.pop(),'SQL file changed. Run it again.');
  jdbcEditor.document.text=dmsEditor.document.text='SELECT 1 AS probe;';
  stopped=true;
  window.activeTextEditor=dmsEditor;
  await run('run');
  assert.equal(state.get('dmsPending'),true);
  window.activeTextEditor=jdbcEditor;
  const before=calls.length;
  await run('run');
  assert.equal(calls.length,before);
  assert.equal(currentPanel().messages.at(-1).error,tr('{0} stopped without a safe continuation. Verify its state and unlock before using either online connection.','DMS'));
  await run('unlock');
  stopped=false;
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.deepEqual(errors,[]);
  await run('edit',jdbcNode);
  const edit=panels.at(-1);
  const values={channel:'jdbc',name:jdbc.name,host:jdbc.host,port:String(jdbc.port),database:jdbc.database,engine:jdbc.engine,sslMode:'DISABLED'};
  const beforeCancel=calls.length;
  await edit.receive({type:'connect',values});
  assert.equal(calls.length,beforeCancel);
  includes(edit.messages.at(-1).message,'Unencrypted JDBC was not confirmed. Choose verified TLS or use DMS.');
  assert.equal(state.get('connections').find(c=>c.id==='legacy').sslMode,undefined);
  allowPlaintext=true;
  await edit.receive({type:'save',values});
  assert.equal(calls.length,beforeCancel);
  const updated=tree.getChildren().find(x=>x.connection?.id==='legacy');
  assert.equal(updated.connection.sslMode,'DISABLED');
  assert.notEqual(updated.connection.revision,jdbc.revision);
  assert.equal(tree.getTreeItem(updated).description,tr('JDBC · Unencrypted'));
  await run('newQuery',updated);
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  includes(currentPanel().messages.at(-1).target,'JDBC · Unencrypted');
  window.activeTextEditor={document:directDoc,selection:{active:0}};
  await run('bindConnection'); // Rebind explicitly after the TLS change.
  await run('edit',updated);
  await panels.at(-1).receive({type:'save',values:{...values,name:'Renamed JDBC',group:'Renamed group'}});
  const renamed=tree.getChildren().find(x=>x.kind==='group');
  const renamedJdbc=tree.getChildren(renamed).find(x=>x.connection.id===jdbc.id);
  assert.equal(renamedJdbc.connection.revision,updated.connection.revision);
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.match(currentPanel().messages.at(-1).target,/Renamed JDBC/);
  assert.match(status.text,/Renamed JDBC/);
  await run('edit',dmsNode);
  await panels.at(-1).receive({type:'save',values:{...dmsNode.connection,name:'Renamed DMS'}});
  const dmsRenamed=tree.getChildren().find(x=>x.connection?.id===dmsNode.connection.id);
  assert.equal(dmsRenamed.connection.revision,dmsNode.connection.revision);
  window.activeTextEditor=dmsEditor;
  assert.deepEqual((await run('run')).rows,[['dms']]);
  assert.match(currentPanel().messages.at(-1).target,/Renamed DMS/);
  await run('edit',dmsRenamed);
  await panels.at(-1).receive({type:'save',values:{...dmsRenamed.connection,databaseId:'43'}});
  const afterTargetChange=calls.length;
  await run('run');
  assert.equal(calls.length,afterTargetChange);
  includes(errors.pop(),'Connection target or credentials changed. Choose an execution connection for this file again.');
  assert.deepEqual(errors,[]);
  const beforeHistory=calls.length, historyId=firstSnapshot.id;
  await firstResult.receive({type:'pin',runId:historyId});
  assert.equal(firstResult.messages.at(-1).pinned,true);
  firstResult.dispose();
  pickHistoryId=historyId;
  await run('history');
  assert.equal(calls.length,beforeHistory);
  assert.equal(currentPanel().messages.length,0); // replay waits for ready, no query
  await currentPanel().receive({type:'ready'});
  assert.equal(currentPanel().messages.at(-1).sql,firstSnapshot.sql);
  assert.deepEqual(currentPanel().messages.at(-1).result.rows,firstSnapshot.result.rows);
  assert.equal(currentPanel().messages.at(-1).pinned,true);
  pickHistoryId=undefined;pickedId='demo';
  await run('searchTables');
  assert.equal(revealed.label,'products');
  assert.equal(calls.length,beforeHistory);
  const completionDoc={...saved,text:'SELECT p.pr FROM products p'};
  // Local Demo already has cached field metadata.
  window.activeTextEditor={document:completionDoc};
  await run('bindConnection');
  const items=completionProvider.provideCompletionItems(completionDoc,11);
  assert.deepEqual(items.map(i=>i.label),['price']);
  assert.equal(calls.length,beforeHistory);
  const pythonDoc={...saved,languageId:'python',uri:{scheme:'file',toString:()=> 'file:///workspace/query.py'},
    text:'query = """SELECT id FROM products WHERE id=1 LIMIT 1;"""'};
  documents.push(pythonDoc);
  window.activeTextEditor={document:pythonDoc,selection:{active:pythonDoc.text.indexOf('products')}};
  pickedId=jdbc.id;
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.deepEqual(calls.at(-1),['jdbc',jdbc.id,'SELECT id FROM products WHERE id=1 LIMIT 1']);
  const beforeOutside=calls.length;
  assert.equal(await hoverProvider.provideHover(pythonDoc,0,{}),undefined);
  assert.equal(calls.length,beforeOutside);
  pythonDoc.text='query = f"""SELECT id FROM products WHERE id={key}"""';
  await run('run');
  includes(errors.pop(),'Select plain SQL or put the cursor inside a supported SQL block.');
  assert.equal(calls.length,beforeOutside);
  assert.deepEqual(errors,[]);
  // Each additional case starts from a clean result inventory, not a different connection.
  for(const panel of panels.filter(p=>p.type==='dbw.result'))panel.dispose();
  await run('clearHistory');
  await run('newQuery',renamedJdbc);
  const concurrentEditor=window.activeTextEditor;
  let release;
  blocker=new Promise(resolve=>{release=resolve;});
  const pending=run('run');
  for(let i=0;i<20 && calls.at(-1)?.[2]!=='SELECT 1 AS probe';i++) await new Promise(resolve=>setImmediate(resolve));
  const whileRunning=calls.length;
  await run('run');
  includes(errors.pop(),'Wait for the active query to finish.');
  concurrentEditor.document.text='SELECT id FROM busy_products;';
  const busyHover=await hoverFor(concurrentEditor);
  assert.ok(['Online queries are locked. Verify the previous query state first.','Another online operation is running. Hover again when it finishes.'].some(key=>busyHover.contents[1].value.includes(tr(key))));
  assert.equal(calls.length,whileRunning);
  release();blocker=undefined;
  assert.deepEqual((await pending).rows,[['jdbc']]);
  assert.match((await hoverFor(concurrentEditor)).contents[2].value,/jdbc INT/);
  assert.equal(calls.length,whileRunning+1);
  const ownResult=currentPanel(),ownId=ownResult.messages.at(-1).id;
  await ownResult.receive({type:'copy',runId:ownId+1,row:0});
  assert.deepEqual(copied,[]);
  await ownResult.receive({type:'copy',runId:ownId,row:0});
  assert.deepEqual(copied,['jdbc']);
  await ownResult.receive({type:'pin',runId:ownId+1});
  assert.equal(ownResult.messages.at(-1).pinned,false);
  const beforeTrust=calls.length;
  vscode.workspace.isTrusted=false;
  concurrentEditor.document.text='SELECT 1 AS probe;';
  await run('run');
  includes(currentPanel().messages.at(-1).error,'Online queries are disabled in untrusted workspaces.');
  assert.equal(calls.length,beforeTrust);
  assert.equal(await hoverFor(concurrentEditor),undefined);
  vscode.workspace.isTrusted=true;
  const archived=ownResult.messages.at(-1);
  ownResult.dispose();
  await run('remove',renamedJdbc);
  assert.deepEqual(deleted,['jdbc:legacy']);
  const afterRemove=calls.length;
  await run('run');
  includes(errors.pop(),'Connection target or credentials changed. Choose an execution connection for this file again.');
  assert.equal(calls.length,afterRemove);
  pickHistoryId=archived.id;
  await run('history');
  await currentPanel().receive({type:'ready'});
  assert.equal(currentPanel().messages.at(-1).id,archived.id);
  assert.deepEqual(currentPanel().messages.at(-1).result.rows,archived.result.rows);
  assert.equal(calls.length,afterRemove);
  assert.deepEqual(errors,[]);
  for(const panel of panels.filter(p=>p.type==='dbw.result')) panel.dispose();
  await run('clearHistory');
  const oldConnections=JSON.stringify(state.get('connections')),oldBindings=JSON.stringify([...previewBindings]);
  await run('connect');const akForm=panels.at(-1);
  await akForm.receive({type:'openAccessKeyGuide'});assert.deepEqual(opened,['https://ram.console.aliyun.com/profile/access-keys']);
  const akValues={channel:'dms',authMode:'accessKey',name:'AK fixture',region:'cn-beijing',keyword:'sandbox',database:'sandbox',databaseId:'42'};
  await akForm.receive({type:'searchDmsDatabases',values:{...akValues,...akAuth}});
  assert.equal(akSearches.length,1);assert.equal(akSecrets.size,0);
  assert.equal(JSON.stringify(state.get('connections')),oldConnections);
  assert.ok(!JSON.stringify(akForm.messages).includes(akAuth.accessKeySecret));
  await akForm.receive({type:'save',values:{...akValues,...akAuth,accessKeySecret:'fixture-replacement-secret'}});
  includes(akForm.messages.at(-1).message,'Search and select the database with this AccessKey first.');assert.equal(akSecrets.size,0);
  await akForm.receive({type:'searchDmsDatabases',values:{...akValues,...akAuth}});
  await akForm.receive({type:'save',values:{...akValues,databaseId:'43'}});
  includes(akForm.messages.at(-1).message,'Search and select the database with this AccessKey first.');
  assert.equal(akSecrets.size,0);
  failConnectionSave=true;await akForm.receive({type:'save',values:akValues});
  assert.equal(akSecrets.size,0);assert.equal(JSON.stringify(state.get('connections')),oldConnections);
  await akForm.receive({type:'save',values:akValues});
  const akNode=tree.getChildren().find(n=>n.connection?.authMode==='accessKey'),akKey='dms-ak:'+akNode.connection.id;
  assert.deepEqual(JSON.parse(akSecrets.get(akKey)),akAuth);
  assert.ok(!JSON.stringify(state.get('connections')).includes(akAuth.accessKeySecret));
  assert.deepEqual(JSON.parse(oldConnections),state.get('connections').filter(c=>c.id!==akNode.connection.id));
  assert.equal(JSON.stringify([...previewBindings]),oldBindings);
  await run('newQuery',akNode);assert.deepEqual((await run('run')).rows,[['dms']]);
  await run('edit',akNode);const akEdit=panels.at(-1);await akEdit.receive({type:'ready'});
  assert.ok(!JSON.stringify(akEdit.messages).includes(akAuth.accessKeySecret));
  await akEdit.receive({type:'save',values:{...akValues,name:'Renamed AK'}});
  const renamedAk=tree.getChildren().find(n=>n.connection?.id===akNode.connection.id);
  assert.equal(renamedAk.connection.revision,akNode.connection.revision);
  assert.deepEqual((await run('run')).rows,[['dms']]);
  // An existing single-AK target keeps its ID and bindings when the user appends a database.
  await run('addDmsDatabases',renamedAk);const legacyAppend=panels.at(-1);
  await legacyAppend.receive({type:'ready'});assert.equal(legacyAppend.messages.at(-1).adding,true);
  await legacyAppend.receive({type:'searchDmsDatabases',values:{keyword:'multi-b',region:'cn-beijing'}});
  await legacyAppend.receive({type:'save',values:{channel:'dms',authMode:'accessKey',name:'Renamed AK',region:'cn-beijing',databases:[{keyword:'multi-b',database:'orders',databaseId:'43'}]}});
  const converted=tree.getChildren().find(n=>n.connection?.id===akNode.connection.id);
  assert.equal(converted.kind,'dmsAccount');assert.equal(tree.getChildren(converted).length,2);
  assert.equal(tree.getChildren(converted)[0].connection.id,akNode.connection.id);
  assert.equal(converted.connection.revision,akNode.connection.revision);
  assert.deepEqual((await run('run')).rows,[['dms']]);
  const legacySchemas=tree.getChildren(converted),legacyRevision=converted.connection.revision;
  await run('refresh',legacySchemas[0]);const removedTables=tree.getChildren(legacySchemas[0])[0];assert.equal(tree.getChildren(removedTables).length,1);
  const removeValues={channel:'dms',authMode:'accessKey',name:'Renamed AK',region:'cn-beijing',databases:[{keyword:'multi-b',database:'orders',databaseId:'43'}],removedDatabases:[{database:'sandbox',databaseId:'42'}]};
  await run('edit',converted);const removeForm=panels.at(-1);const removeState=JSON.stringify(state.get('connections')),removeWrites=stored.length;
  await removeForm.receive({type:'save',values:{...removeValues,removedDatabases:[{database:'foreign',databaseId:'999'}]}});
  assert.equal(JSON.stringify(state.get('connections')),removeState);assert.equal(removeForm.messages.at(-1).type,'error');
  failConnectionSave=true;await removeForm.receive({type:'save',values:removeValues});assert.equal(JSON.stringify(state.get('connections')),removeState);
  await removeForm.receive({type:'save',values:removeValues});
  let legacyOwner=tree.getChildren().find(n=>n.connection?.id===converted.connection.id);
  assert.equal(tree.getChildren(removedTables).length,0);
  assert.equal(tree.getChildren(legacyOwner).length,1);assert.equal(tree.getChildren(legacyOwner)[0].connection.id,legacySchemas[1].connection.id);
  assert.equal(legacyOwner.connection.revision,legacyRevision);assert.equal(stored.length,removeWrites);assert.ok(akSecrets.has(akKey));
  const deletedCalls=calls.length;await run('run');assert.equal(calls.length,deletedCalls);includes(errors.pop(),'Connection target or credentials changed. Choose an execution connection for this file again.');
  await run('newQuery',tree.getChildren(legacyOwner)[0]);await run('run');assert.equal(akExecutions.at(-1).databaseId,'43');
  await run('addDmsDatabases',legacyOwner);const emptyForm=panels.at(-1);await emptyForm.receive({type:'ready'});assert.equal(emptyForm.messages.at(-1).connection.databases.length,1);
  await emptyForm.receive({type:'save',values:{...removeValues,databases:[],removedDatabases:[{database:'orders',databaseId:'43'}]}});
  legacyOwner=tree.getChildren().find(n=>n.connection?.id===converted.connection.id);
  assert.equal(tree.getChildren(legacyOwner).length,0);assert.ok(akSecrets.has(akKey));assert.equal(stored.length,removeWrites);
  await run('addDmsDatabases',legacyOwner);const restoreForm=panels.at(-1);await restoreForm.receive({type:'ready'});assert.equal(restoreForm.messages.at(-1).connection.databases.length,0);
  await restoreForm.receive({type:'searchDmsDatabases',values:{keyword:'multi-c',region:'cn-beijing'}});
  await restoreForm.receive({type:'save',values:{...removeValues,databases:[{keyword:'multi-c',database:'dimensions',databaseId:'44'}],removedDatabases:[]}});
  legacyOwner=tree.getChildren().find(n=>n.connection?.id===converted.connection.id);
  const restored=tree.getChildren(legacyOwner)[0];assert.equal(restored.label,'dimensions');
  assert.notEqual(restored.connection.id,converted.connection.id);assert.ok(!legacySchemas.some(n=>n.connection.id===restored.connection.id));
  await run('run');includes(errors.pop(),'Connection target or credentials changed. Choose an execution connection for this file again.');
  await run('newQuery',restored);await run('run');assert.equal(akExecutions.at(-1).databaseId,'44');
  await run('remove',legacyOwner);assert.ok(!akSecrets.has(akKey));
  assert.deepEqual(JSON.parse(oldConnections),state.get('connections'));
  const targets=[{keyword:'multi-a',database:'sandbox',databaseId:'42'},{keyword:'multi-b',database:'orders',databaseId:'43'}];
  const multiValues={channel:'dms',authMode:'accessKey',name:'Shared AK',group:'',region:'cn-beijing',databases:targets};
  const originalBindings=new Map(previewBindings);
  await run('connect');const multiForm=panels.at(-1);
  await multiForm.receive({type:'searchDmsDatabases',values:{...akAuth,keyword:'multi-a',region:'cn-beijing'}});
  await multiForm.receive({type:'searchDmsDatabases',values:{...akAuth,keyword:'multi-b',region:'cn-beijing'}});
  await multiForm.receive({type:'save',values:{...multiValues,databases:[...targets,{keyword:'not-searched',database:'forged',databaseId:'999'}]}});
  includes(multiForm.messages.at(-1).message,'Search and select the database with this AccessKey first.');assert.equal(akSecrets.size,0);
  failConnectionSave=true;await multiForm.receive({type:'save',values:{...multiValues,...akAuth}});assert.equal(akSecrets.size,0);
  assert.deepEqual(JSON.parse(oldConnections),state.get('connections'));
  const beforeSaveQueries=akExecutions.length;await multiForm.receive({type:'save',values:{...multiValues,...akAuth}});
  assert.equal(akExecutions.length,beforeSaveQueries);assert.equal(akSecrets.size,1);
  let account=tree.getChildren().find(n=>n.kind==='dmsAccount');const ownerId=account.connection.id,revision=account.connection.revision;
  const schemas=tree.getChildren(account);assert.deepEqual(schemas.map(n=>n.label),['sandbox','orders']);
  assert.ok(schemas.every(n=>n.connection.accountId===ownerId));assert.equal(tree.getParent(schemas[1]).connection.id,ownerId);
  assert.equal(tree.getTreeItem(account).description,tr('DMS · {0} databases',2));
  await run('newQuery',schemas[0]);const editorA=window.activeTextEditor;await run('run');
  assert.equal(akExecutions.at(-1).databaseId,'42');assert.equal(akExecutions.at(-1).accountId,ownerId);
  await run('newQuery',schemas[1]);const editorB=window.activeTextEditor;await run('run');
  assert.equal(akExecutions.at(-1).databaseId,'43');assert.notEqual(schemas[0].connection.id,schemas[1].connection.id);
  editorA.document.text=editorB.document.text='SELECT id FROM products;';
  assert.match((await hoverFor(editorA)).contents[2].value,/db42_field/);
  const hoverB=await hoverFor(editorB);assert.match(hoverB.contents[2].value,/db43_field/);
  const cacheQueries=akExecutions.length;await hoverFor(editorA);assert.equal(akExecutions.length,cacheQueries);
  await run('previewTable',...loadArgs(hoverB.contents[1]));assert.equal(akExecutions.at(-1).databaseId,'43');assert.equal(akExecutions.at(-1).table,'products');
  await run('refresh',schemas[1]);assert.equal(akExecutions.at(-1).databaseId,'43');
  const multiFile={...saved,uri:{scheme:'file',toString:()=> 'file:///workspace/multi.sql'},text:'SELECT 1 AS probe'};documents.push(multiFile);
  window.activeTextEditor={document:multiFile,selection:{active:0}};pickHistoryId=undefined;pickedId=schemas[1].connection.id;await run('bindConnection');
  assert.equal(previewBindings.get('sqlConnection:file:///workspace/multi.sql').id,schemas[1].connection.id);
  assert.ok(pickItems.some(item=>item.connection?.id===schemas[0].connection.id && item.description.includes('sandbox')));
  await run('run');assert.equal(akExecutions.at(-1).databaseId,'43');
  const writesBeforeAppend=stored.length;
  await run('addDmsDatabases',account);const append=panels.at(-1);await append.receive({type:'ready'});
  assert.equal(append.messages.at(-1).connection.databases.length,2);assert.ok(!JSON.stringify(append.messages).includes(akAuth.accessKeySecret));
  await append.receive({type:'searchDmsDatabases',values:{keyword:'multi-c',region:'cn-beijing'}});
  const beforeAppend=JSON.stringify(state.get('connections'));failConnectionSave=true;
  await append.receive({type:'save',values:{...multiValues,databases:[{keyword:'multi-c',database:'dimensions',databaseId:'44'}]}});
  assert.equal(JSON.stringify(state.get('connections')),beforeAppend);assert.equal(stored.length,writesBeforeAppend);
  await append.receive({type:'save',values:{...multiValues,databases:[{keyword:'multi-c',database:'dimensions',databaseId:'44'}]}});
  account=tree.getChildren().find(n=>n.connection?.id===ownerId);
  assert.equal(account.connection.revision,revision);assert.equal(stored.length,writesBeforeAppend);assert.equal(akSecrets.size,1);
  assert.deepEqual(tree.getChildren(account).slice(0,2).map(n=>n.connection.id),schemas.map(n=>n.connection.id));
  assert.equal(tree.getChildren(account).length,3);await run('run');assert.equal(akExecutions.at(-1).databaseId,'43');
  await hoverFor(editorA);assert.equal(akExecutions.at(-1).sql,'SELECT 1 AS probe'); // Appending keeps the original DDL cache.
  for(const [key,value] of originalBindings)assert.deepEqual(previewBindings.get(key),value);
  assert.deepEqual(JSON.parse(oldConnections),state.get('connections').filter(c=>c.id!==ownerId));
  await run('addDmsDatabases',account);const gated=panels.at(-1);let releaseRead;
  akReadGate=new Promise(resolve=>releaseRead=resolve);const readStarted=new Promise(resolve=>akReadStarted=resolve);
  const searchWaiting=gated.receive({type:'searchDmsDatabases',values:{keyword:'multi-c',region:'cn-beijing'}});await readStarted;
  try {const before=akExecutions.length;window.activeTextEditor=editorA;await run('run');assert.equal(akExecutions.length,before);}
  finally {releaseRead();akReadGate=undefined;await searchWaiting;gated.dispose();}
  window.activeTextEditor={document:multiFile,selection:{active:0}};
  await run('edit',account);const partial=panels.at(-1);
  await partial.receive({type:'searchDmsDatabases',values:{...akAuth,keyword:'multi-c',region:'cn-beijing'}});
  await partial.receive({type:'save',values:{...multiValues,databases:[{keyword:'multi-c',database:'dimensions',databaseId:'44'}]}});
  includes(partial.messages.at(-1).message,'Search and select the database with this AccessKey first.');
  assert.equal(tree.getChildren().find(n=>n.connection?.id===ownerId).connection.revision,revision);
  partial.dispose();await run('run');assert.equal(akExecutions.at(-1).databaseId,'43');
  stopped=true;await run('run');assert.equal(state.get('dmsPending'),true);stopped=false;
  window.activeTextEditor=editorA;const blockedCalls=akExecutions.length;await run('run');assert.equal(akExecutions.length,blockedCalls);
  await run('unlock');assert.equal(state.get('dmsPending'),false);
  await run('remove',account);assert.equal(akSecrets.size,0);assert.deepEqual(JSON.parse(oldConnections),state.get('connections'));
  assert.deepEqual(errors,[]);
  await run('connect');const connectMany=panels.at(-1);
  for(const [index,row] of targets.entries())await connectMany.receive({type:'searchDmsDatabases',values:{...row,region:'cn-beijing',...(index===0?akAuth:{})}});
  const beforeConnect=akExecutions.length;await connectMany.receive({type:'connect',values:multiValues});
  assert.deepEqual(akExecutions.slice(beforeConnect).map(c=>[c.databaseId,c.sql]),[['42','SHOW TABLES'],['43','SHOW TABLES']]);
  const connected=tree.getChildren().find(n=>n.kind==='dmsAccount');
  for(const schema of tree.getChildren(connected))assert.equal(tree.getChildren(tree.getChildren(schema)[0])[0].label,'products');
  await run('edit',connected);const interrupted=panels.at(-1);
  for(const [index,row] of targets.entries())await interrupted.receive({type:'searchDmsDatabases',values:{...row,region:'cn-beijing',...(index===0?akAuth:{})}});
  let releaseQuery;akQueryGate=new Promise(resolve=>releaseQuery=resolve);const queryStarted=new Promise(resolve=>akQueryStarted=resolve);
  const pendingSave=interrupted.receive({type:'connect',values:multiValues});await queryStarted;
  await run('remove',connected);releaseQuery();await pendingSave;
  assert.equal(akSecrets.size,0);includes(interrupted.messages.at(-1).message,'Connection target or credentials changed. Choose an execution connection for this file again.');
  assert.deepEqual(JSON.parse(oldConnections),state.get('connections'));

  assert.deepEqual(errors,[]);
});
