const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {translator}=require('../media/i18n.js');
const tr=translator(vscode.env.language),resultPrefix=tr('Query Result #{0} · {1}').split('{0}')[0];
const tabs = label => vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>label==='Query Result' ? tab.label.startsWith(resultPrefix) : tab.label===label);
async function waitForTab(label) {
  if (tabs(label).length) return;
  await new Promise((resolve,reject)=>{
    const sub=vscode.window.tabGroups.onDidChangeTabs(()=>{
      if (tabs(label).length) {sub.dispose();clearTimeout(timer);resolve();}
    });
    const timer=setTimeout(()=>{sub.dispose();reject(Error('Tab did not open: ' + label));},8000);
  });
}
async function acceptPicker(command) {
  let done=false;
  const result=command.finally(()=>{done=true;});
  for (let i=0;i<20 && !done;i++) {
    await new Promise(resolve=>setTimeout(resolve,150));
    if (!done) await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  }
  assert.ok(done,'Preview connection picker did not complete');
  return result;
}
async function waitForResults(count) {
  for(let i=0;i<50 && tabs('Query Result').length<count;i++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(tabs('Query Result').length>=count,JSON.stringify(vscode.window.tabGroups.all.flatMap(g=>g.tabs).map(t=>t.label)));
}
exports.run = async function() {
  try {
  const mark=message=>fs.appendFileSync(process.env.DBW_HOST_RESULT+'.progress',message+'\n');
  mark('start');
  const extension=vscode.extensions.getExtension('TomMajor.sqlquay');
  assert.ok(extension);
  assert.equal(extension.packageJSON.displayName,'SQLQuay');
  assert.equal(extension.packageJSON.version,require('../package.json').version);
  const file=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'existing.sql');
  const source='SELECT id FROM products;\n';
  await vscode.workspace.fs.writeFile(file,Buffer.from(source));
  mark('existing file written');
  let openTimer;
  const existing=await Promise.race([vscode.workspace.openTextDocument(file),new Promise((_,reject)=>{
    openTimer=setTimeout(()=>reject(Error('Initial SQL open timed out before Workbench activation')),20000);
  })]).finally(()=>clearTimeout(openTimer));
  mark('existing document opened');
  await vscode.window.showTextDocument(existing);
  mark('existing editor shown');
  const position=new vscode.Position(0,17);
  // The language event starts activation asynchronously; the test must not activate by API.
  for(let i=0;i<40 && !extension.isActive;i++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(extension.isActive,'Opening SQL activates Workbench');
  mark('before initial hover');
  const results=await vscode.commands.executeCommand('vscode.executeHoverProvider',file,position);
  const offer=results.flatMap(h=>h.contents).find(item=>item.value?.includes('['+tr('Choose preview connection')+']'));
  assert.ok(offer,'Existing SQL gets a Workbench hover without opening a Workbench view');
  mark('initial hover returned');
  const fileArgs=JSON.parse(decodeURIComponent(offer.value.match(/command:dbw\.loadTableDdl\?([^)]*)/)[1]));
  await acceptPicker(vscode.commands.executeCommand('dbw.loadTableDdl',...fileArgs));
  mark('initial picker complete');
  const fileHover=await vscode.commands.executeCommand('vscode.executeHoverProvider',file,position);
  assert.ok(fileHover.flatMap(h=>h.contents).some(item=>item.value?.includes('CREATE TABLE products')));
  assert.equal(existing.getText(),source);
  mark('before default picker');
  await acceptPicker(vscode.commands.executeCommand('dbw.setWorkspaceDdlConnection'));
  await vscode.commands.executeCommand('dbw.refresh');
  mark('default picked');
  const nextFile=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'another.sql');
  await vscode.workspace.fs.writeFile(nextFile,Buffer.from(source));
  await vscode.workspace.openTextDocument(nextFile);
  const inherited=await vscode.commands.executeCommand('vscode.executeHoverProvider',nextFile,position);
  const inheritedText=inherited.flatMap(h=>h.contents).map(item=>item.value).join('\n');
  assert.ok(inheritedText.includes(tr(' · Workspace default')));
  assert.match(inheritedText,/CREATE TABLE products/);
  assert.doesNotMatch(inheritedText,/command:dbw\.loadTableDdl/);
  const previewLink=inheritedText.match(/command:dbw\.previewTable\?([^)]*)\)/);
  assert.ok(previewLink);
  const sample=await vscode.commands.executeCommand('dbw.previewTable',...JSON.parse(decodeURIComponent(previewLink[1])));
  assert.equal(sample.rows.length,6);
  await waitForTab('Query Result');
  await vscode.window.showTextDocument(existing);
  await acceptPicker(vscode.commands.executeCommand('dbw.bindConnection'));
  const fileResult=await vscode.commands.executeCommand('dbw.run');
  assert.deepEqual(fileResult.columns.map(c=>c.name),['id']);
  assert.equal(fileResult.rows.length,6);
  assert.equal(existing.getText(),source);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const reopened=await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(reopened);
  assert.equal((await vscode.commands.executeCommand('dbw.run')).rows.length,6);
  await vscode.commands.executeCommand('dbw.connect');
  await waitForTab(tr('Connect to server'));
  const doc=await vscode.commands.executeCommand('dbw.newQuery');
  assert.equal(doc.languageId,'sql');
  assert.equal(vscode.window.activeTextEditor.document,doc);
  const tablePosition=new vscode.Position(1,7);
  const hover=async()=>vscode.commands.executeCommand('vscode.executeHoverProvider',doc.uri,tablePosition);
  const cached=(await hover()).flatMap(h=>h.contents).find(item=>item.value?.includes('CREATE TABLE products'));
  assert.ok(cached);
  assert.doesNotMatch(cached.value,/View Data|command:/);
  mark('before demo run');
  const data=await vscode.commands.executeCommand('dbw.run');
  assert.deepEqual(data.columns.map(c=>c.name),['id','name','category','price']);
  assert.equal(data.rows.length,6);
  await waitForTab('Query Result');
  const edit=new vscode.WorkspaceEdit();
  edit.insert(doc.uri,new vscode.Position(3,0),'SELECT 1 AS probe;\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const editor=await vscode.window.showTextDocument(doc);
  editor.selection=new vscode.Selection(3,0,3,18);
  const selected=await vscode.commands.executeCommand('dbw.run');
  assert.deepEqual(selected.rows,[['1']]);
  const panels=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.label.startsWith(resultPrefix));
  assert.ok(panels.length>=4);
  const metadata=await vscode.commands.executeCommand('dbw.describe',{kind:'table',label:'products',connection:require('../src/query.cjs').DEMO});
  assert.deepEqual(metadata.rows.map(row=>row[0]),['id','name','category','price']);
  mark('waiting for all result tabs');
  await waitForResults(6);
  mark('starting embedded');
  const fence=String.fromCharCode(96).repeat(3);
  const embeddedFile=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'embedded.md');
  const embeddedSource='Introduction\n'+fence+'sql\nSELECT id FROM products LIMIT 1;\n'+fence+'\n';
  await vscode.workspace.fs.writeFile(embeddedFile,Buffer.from(embeddedSource));
  const embedded=await vscode.workspace.openTextDocument(embeddedFile);
  await vscode.window.showTextDocument(embedded);
  const embeddedHover=await vscode.commands.executeCommand('vscode.executeHoverProvider',embeddedFile,new vscode.Position(2,17));
  assert.ok(embeddedHover.flatMap(h=>h.contents).some(c=>c.value?.includes('CREATE TABLE products')));
  await acceptPicker(vscode.commands.executeCommand('dbw.bindConnection'));
  const embeddedEditor=await vscode.window.showTextDocument(embedded);
  embeddedEditor.selection=new vscode.Selection(2,17,2,17);
  assert.equal((await vscode.commands.executeCommand('dbw.run')).rows.length,1);
  assert.equal(embedded.getText(),embeddedSource);
  await vscode.window.showTextDocument(doc);
  const completionEdit=new vscode.WorkspaceEdit();
  completionEdit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),'SELECT p.pr FROM products p;');
  assert.ok(await vscode.workspace.applyEdit(completionEdit));
  const completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',doc.uri,new vscode.Position(0,11));
  assert.ok(completions.items.some(item=>item.label==='price'));
  const hostCases=[
    ['embedded.py','python','query = """SELECT id FROM products LIMIT 1;"""'],
    ['Embedded.java','java','String query = """\nSELECT id FROM products LIMIT 1;\n""";'],
    ['embedded.js','javascript','const query = `SELECT id FROM products LIMIT 1;`;'],
    ['embedded.jsx','javascriptreact','const query = `SELECT id FROM products LIMIT 1;`;'],
    ['embedded.ts','typescript','const query: string = `SELECT id FROM products LIMIT 1;`;'],
    ['embedded.tsx','typescriptreact','const query: string = `SELECT id FROM products LIMIT 1;`;'],
    ['mysql.md','markdown','text\n~~~mysql\nSELECT id FROM products LIMIT 1;\n~~~\n'],
  ];
  for(const [name,language,source] of hostCases) {
    const uri=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,name);
    await vscode.workspace.fs.writeFile(uri,Buffer.from(source));
    const embeddedDoc=await vscode.workspace.openTextDocument(uri);
    assert.equal(embeddedDoc.languageId,language);
    const offset=source.indexOf('products'),position=embeddedDoc.positionAt(offset+1);
    const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',uri,position);
    assert.ok(hovers.flatMap(h=>h.contents).some(c=>c.value?.includes('CREATE TABLE products')),name+' DDL');
    const outside=await vscode.commands.executeCommand('vscode.executeHoverProvider',uri,new vscode.Position(0,0));
    assert.ok(outside.flatMap(h=>h.contents).every(c=>!c.value?.includes('CREATE TABLE products')),name+' outside SQL');
    const embeddedEditor=await vscode.window.showTextDocument(embeddedDoc);
    await acceptPicker(vscode.commands.executeCommand('dbw.bindConnection'));
    embeddedEditor.selection=new vscode.Selection(position,position);
    assert.equal((await vscode.commands.executeCommand('dbw.run')).rows.length,1,name+' execution');
    assert.equal(embeddedDoc.getText(),source,name+' source preserved');
    mark('embedded passed: '+name);
  }
  const plainUri=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'manual.txt');
  const plainSource='not SQL\nSELECT id FROM products LIMIT 1;\nnot SQL';
  await vscode.workspace.fs.writeFile(plainUri,Buffer.from(plainSource));
  const plainDoc=await vscode.workspace.openTextDocument(plainUri);
  const plainEditor=await vscode.window.showTextDocument(plainDoc);
  plainEditor.selection=new vscode.Selection(1,0,1,'SELECT id FROM products LIMIT 1;'.length);
  assert.equal((await acceptPicker(vscode.commands.executeCommand('dbw.run'))).rows.length,1);
  assert.equal(plainDoc.getText(),plainSource);
  mark('manual selection in plain text passed');
  await acceptPicker(vscode.commands.executeCommand('dbw.searchTables'));
  mark('search table reveal passed');

  const regexUri=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'regex.js');
  const regexSource='export default /`SELECT id FROM products`/;';
  await vscode.workspace.fs.writeFile(regexUri,Buffer.from(regexSource));
  const regexDoc=await vscode.workspace.openTextDocument(regexUri);
  const regexPosition=regexDoc.positionAt(regexSource.indexOf('products'));
  const regexHover=await vscode.commands.executeCommand('vscode.executeHoverProvider',regexUri,regexPosition);
  assert.ok(regexHover.flatMap(h=>h.contents).every(c=>!c.value?.includes('CREATE TABLE products')));
  const regexEditor=await vscode.window.showTextDocument(regexDoc);
  regexEditor.selection=new vscode.Selection(regexPosition,regexPosition);
  const beforeRegex=tabs('Query Result').length;
  assert.equal(await vscode.commands.executeCommand('dbw.run'),undefined);
  assert.equal(tabs('Query Result').length,beforeRegex);
  mark('regex SQL stays inactive in real VS Code');

  const findings=[];
  async function inspectSql(source,token,kind) {
    const edit=new vscode.WorkspaceEdit();
    edit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),source);
    assert.ok(await vscode.workspace.applyEdit(edit));
    if(kind==='completion') {
      const r=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',doc.uri,doc.positionAt(source.indexOf(token)+token.length));
      return r.items.filter(item=>['products','price'].includes(item.label)).map(item=>item.label);
    }
    const r=await vscode.commands.executeCommand('vscode.executeHoverProvider',doc.uri,doc.positionAt(source.indexOf(token)));
    return r.flatMap(h=>h.contents).some(c=>c.value?.includes('CREATE TABLE products'));
  }
  await vscode.window.showTextDocument(doc);
  const inFunction=await inspectSql('SELECT SUM(p.pr) FROM products p;','p.pr','completion');
  assert.ok(inFunction.includes('price'));
  findings.push({case:'alias in function',expected:['price'],actual:inFunction});
  const schemaAlias=await inspectSql('SELECT sandbox.pr FROM products sandbox;','sandbox.pr','completion');
  assert.ok(schemaAlias.includes('price'));
  findings.push({case:'alias matches schema',expected:['price'],actual:schemaAlias});
  const sql='SELECT * FROM products WHERE id IN (WITH products AS (SELECT 1) SELECT id FROM products);';
  const nestedCte=await inspectSql(sql,'products WHERE','hover');
  assert.equal(nestedCte,true);
  findings.push({case:'nested CTE hides outer table',expected:true,actual:nestedCte});
  const correlated=await inspectSql('SELECT p.id FROM products p WHERE EXISTS (SELECT p.id);','p.id);','hover');
  assert.equal(correlated,true);
  findings.push({case:'correlated outer alias',expected:true,actual:correlated});
  fs.writeFileSync(process.env.DBW_HOST_RESULT+'.findings.json',JSON.stringify(findings,null,2));
  mark('four parser regressions passed in real VS Code host');
  mark('before history');
  const historyCount=tabs('Query Result').length;
  await acceptPicker(vscode.commands.executeCommand('dbw.history'));
  assert.equal(tabs('Query Result').length,historyCount);
  const latest=tabs('Query Result').at(-1);
  assert.ok(await vscode.window.tabGroups.close(latest));
  await acceptPicker(vscode.commands.executeCommand('dbw.history'));
  await waitForResults(historyCount);
  mark('closed result restored from history');
  const reset=new vscode.WorkspaceEdit();
  reset.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),'SELECT 1 AS probe;');
  assert.ok(await vscode.workspace.applyEdit(reset));
  const demoEditor=await vscode.window.showTextDocument(doc);
  demoEditor.selection=new vscode.Selection(0,0,0,0);
  for(let count=tabs('Query Result').length;count<20;count++) {
    assert.deepEqual((await vscode.commands.executeCommand('dbw.run')).rows,[['1']]);
    await waitForResults(count+1);
  }
  assert.equal(await vscode.commands.executeCommand('dbw.run'),undefined);
  assert.equal(tabs('Query Result').length,20);
  assert.ok(await vscode.window.tabGroups.close(tabs('Query Result').at(-1)));
  await vscode.commands.executeCommand('dbw.clearHistory');
  assert.deepEqual((await vscode.commands.executeCommand('dbw.run')).rows,[['1']]);
  await waitForResults(20);
  mark('20 open results protected; close/clear/re-run passed');
  fs.writeFileSync(process.env.DBW_HOST_RESULT,'DBW_VSCODE_PASS\n');
  } catch(error) {
    if (process.env.DBW_HOST_RESULT) fs.writeFileSync(process.env.DBW_HOST_RESULT, String(error.stack));
    throw error;
  }
};
