'use strict';
const {test} = require('node:test'), assert=require('node:assert/strict'), Module=require('node:module');
const {DmsStopped}=require('../src/dms.cjs');
test('new DMS form, existing JDBC connection, shared result panel and cross-channel stop',async()=>{
  const jdbc={id:'legacy',revision:'v1',name:'Existing JDBC',group:'',engine:'mysql',host:'fixture.invalid',port:3306,database:'sandbox'};
  const state=new Map([['connections',[jdbc]]]), calls=[], panels=[], commands=new Map(), errors=[];
  let tree, hoverProvider, completionProvider, stopped=false, secretReads=0, allowPlaintext=false, blocker;
  const copied=[],deleted=[],terminals=[];
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
    showWarningMessage:async(_message, _options, action)=>action==='Use Unencrypted JDBC' && !allowPlaintext ? undefined : action,
    showTextDocument:async document=>{window.activeTextEditor={document,selection:{active:0}};}
  };
  const vscode={window,env:{clipboard:{writeText:async value=>copied.push(value)}},workspace:{isTrusted:true,workspaceFolders:[{}],getWorkspaceFolder:uri=>uri.toString().startsWith('file:///workspace/') ? {} : undefined,getConfiguration:()=>({get:()=>''}),textDocuments:documents,openTextDocument:async ({content,language})=>{
    const doc={languageId:language,uri:'untitled:'+documents.length,version:1,text:content,offsetAt:n=>n,positionAt:n=>n,getText(selection){return selection?'':this.text;}};
    documents.push(doc);return doc;
  }},commands:{executeCommand:async()=>{},registerCommand:(id,fn)=>{commands.set(id,fn);return dispose();}},
    StatusBarAlignment:{Right:2},languages:{registerHoverProvider:(_,p)=>{hoverProvider=p;return dispose();},registerCompletionItemProvider:(_,p)=>{completionProvider=p;return dispose();}},ProgressLocation:{Notification:1},
    CompletionItem:class{constructor(label,kind){Object.assign(this,{label,kind});}},CompletionItemKind:{Struct:1,Field:2},
    MarkdownString:class {value='';appendText(s){this.value+=s;} appendMarkdown(s){this.value+=s;} appendCodeblock(s){this.value+=s;}},
    Hover:class {constructor(contents,range){Object.assign(this,{contents,range});}}, Range:class {},
    TreeItem:class {},TreeItemCollapsibleState:{},ThemeIcon:class {},Uri:{joinPath:(...v)=>v.join('/')},
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
        if(request==='./dms.cjs') return {...load.apply(this,arguments),listDmsProfiles:async()=>[{name:'team-fixture',region:'cn-beijing',valid:true}],makeDms:()=>async(connection,sql,limit,table)=>{
          if (table) { calls.push(['preview','dms',connection.id,table,limit]);return grid(['id'],[['2']]); }
          calls.push(['dms',connection.id,sql]);
          if(stopped) throw new DmsStopped('DMS fixture stopped.');
          if(sql==='SHOW TABLES') return grid(['Tables_in_sandbox'],[['products']]);
          if(sql.startsWith('SHOW CREATE TABLE')) return grid(['Table','Create Table'],[['products','CREATE TABLE products (dms INT)']]);
          if(sql.startsWith('DESCRIBE')) return grid(['Field','Type'],[['id','BIGINT']]);
          return grid(['probe'],[['dms']]);
        }};
      }
      return load.apply(this,arguments);
    };
    ({activate}=require('../src/extension.cjs'));
  } finally { Module._load=load; }
  activate({extensionUri:'fixture',extensionPath:'fixture',subscriptions:[],
    globalState:{get:(key,other)=>state.get(key)??other,update:async(key,value)=>state.set(key,value)},
    workspaceState:{get:key=>previewBindings.get(key),update:async(key,value)=>previewBindings.set(key,value)},
    secrets:{get:async key=>{secretReads++;assert.equal(key,'jdbc:legacy');return '{"user":"reader","password":"fixture"}';},store:async(key,value)=>stored.push([key,value]),delete:async key=>deleted.push(key)}
  });
  const run=(id,...args)=>commands.get('dbw.'+id)(...args);
  const jdbcNode=tree.getChildren().find(x=>x.connection?.id==='legacy');
  assert.equal(tree.getTreeItem(jdbcNode).description,'JDBC');
  await run('newQuery',jdbcNode);
  const jdbcEditor=window.activeTextEditor;
  await run('connect');
  const form=panels.at(-1);
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
  assert.match(firstFileHover.contents[0].value,/请选择|请先选择/);
  assert.match(firstFileHover.contents[1].value,/选择预览连接/);
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
  assert.match(errors.pop(),/重新悬停/);
  assert.match((await hoverFor(reopened)).contents[2].value,/jdbc INT/);
  assert.deepEqual(calls.at(-1),['jdbc','legacy','SHOW CREATE TABLE `sandbox`.`file_products`']);
  const workspaceDefaultEditor={document:{...saved,uri:{scheme:'file',toString:()=> 'file:///workspace/default.sql'},
    text:'SELECT * FROM default_products;'}};
  documents.push(workspaceDefaultEditor.document);
  const oldDefaultLink=loadArgs((await hoverFor(workspaceDefaultEditor)).contents[1]);
  pickedId=dmsNode.connection.id;
  const beforeDefault=calls.length;
  const defaultNode=()=>tree.getTreeItem(tree.getChildren().find(x=>x.kind==='ddlDefault'));
  assert.equal(defaultNode().description,'未设置');
  assert.equal(defaultNode().command.command,'dbw.setWorkspaceDdlConnection');
  await commands.get(defaultNode().command.command)();
  assert.equal(defaultNode().description,dmsNode.connection.name);
  assert.equal(calls.length,beforeDefault);
  const outside={document:{...saved,uri:{scheme:'file',toString:()=> 'file:///outside.sql'}}};
  assert.match((await hoverFor(outside)).contents[0].value,/请先选择/);
  await run('loadTableDdl',...oldDefaultLink);
  assert.equal(calls.length,beforeDefault);
  assert.match(errors.pop(),/重新悬停/);
  pickedId=undefined;pickItems=undefined;
  const inherited=await hoverFor(workspaceDefaultEditor);
  assert.match(inherited.contents[0].value,/DMS.*工作区默认/);
  assert.match(inherited.contents[2].value,/dms INT/);
  assert.equal(pickItems,undefined);
  assert.deepEqual(calls.at(-1),['dms',dmsNode.connection.id,'SHOW CREATE TABLE `sandbox`.`default_products`']);
  const fileHover=await hoverFor(fileEditor);
  assert.match(fileHover.contents[0].value,/JDBC/);
  const click=fileHover.contents[1];
  assert.match(click.value,/^\[预览数据\]\(command:dbw\.previewTable\?/);
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
  assert.match((await hoverFor(fileEditor)).contents[0].value,/DMS.*工作区默认/);
  await run('setWorkspaceDdlConnection');
  const afterClear=calls.length;
  await run('previewTable',...loadArgs(inherited.contents[1]));
  assert.equal(calls.length,afterClear);
  assert.match(errors.pop(),/重新悬停/);
  assert.match((await hoverFor(workspaceDefaultEditor)).contents[0].value,/请先选择/);
  assert.equal(defaultNode().description,'未设置');
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
  assert.match(mismatch.contents[0].value,/切换当前文件的执行连接/);
  assert.doesNotMatch(mismatch.contents[1].value,/command:/);
  assert.equal(calls.length,beforeMismatch);
  pickedId='reset';
  await run('bindConnection');
  assert.equal(previewBindings.get('sqlConnection:file:///workspace/old.sql'),undefined);
  pickedId=undefined;
  const cancelCalls=calls.length;
  await run('run');
  assert.equal(calls.length,cancelCalls);
  assert.match(status.text,/选择执行连接/);
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
  assert.match(errors.pop(),/SQL 文件已变更/);
  jdbcEditor.document.text=dmsEditor.document.text='SELECT 1 AS probe;';
  stopped=true;
  window.activeTextEditor=dmsEditor;
  await run('run');
  assert.equal(state.get('dmsPending'),true);
  window.activeTextEditor=jdbcEditor;
  const before=calls.length;
  await run('run');
  assert.equal(calls.length,before);
  assert.match(currentPanel().messages.at(-1).error,/either online connection/);
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
  assert.match(edit.messages.at(-1).message,/not confirmed/);
  assert.equal(state.get('connections').find(c=>c.id==='legacy').sslMode,undefined);
  allowPlaintext=true;
  await edit.receive({type:'save',values});
  assert.equal(calls.length,beforeCancel);
  const updated=tree.getChildren().find(x=>x.connection?.id==='legacy');
  assert.equal(updated.connection.sslMode,'DISABLED');
  assert.notEqual(updated.connection.revision,jdbc.revision);
  assert.equal(tree.getTreeItem(updated).description,'JDBC · Unencrypted');
  await run('newQuery',updated);
  assert.deepEqual((await run('run')).rows,[['jdbc']]);
  assert.match(currentPanel().messages.at(-1).target,/JDBC · Unencrypted$/);
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
  assert.match(errors.pop(),/连接目标或认证已变更/);
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
  assert.match(errors.pop(),/选中纯 SQL/);
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
  assert.match(errors.pop(),/Wait for the active query/);
  concurrentEditor.document.text='SELECT id FROM busy_products;';
  const busyHover=await hoverFor(concurrentEditor);
  assert.match(busyHover.contents[1].value,/在线查询已锁定|另一条在线请求/);
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
  assert.match(currentPanel().messages.at(-1).error,/untrusted/);
  assert.equal(calls.length,beforeTrust);
  assert.equal(await hoverFor(concurrentEditor),undefined);
  vscode.workspace.isTrusted=true;
  const archived=ownResult.messages.at(-1);
  ownResult.dispose();
  await run('remove',renamedJdbc);
  assert.deepEqual(deleted,['jdbc:legacy']);
  const afterRemove=calls.length;
  await run('run');
  assert.match(errors.pop(),/连接目标或认证已变更/);
  assert.equal(calls.length,afterRemove);
  pickHistoryId=archived.id;
  await run('history');
  await currentPanel().receive({type:'ready'});
  assert.equal(currentPanel().messages.at(-1).id,archived.id);
  assert.deepEqual(currentPanel().messages.at(-1).result.rows,archived.result.rows);
  assert.equal(calls.length,afterRemove);
  assert.deepEqual(errors,[]);
});
