'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {connectHtml,resultHtml}=require('../src/webviews.cjs');
function create(language='en') {
  const sent=[],events={},listeners={},ids=new Map(),fields={};let active;
  class Element {
    constructor(value=''){this.value=value;this.children=[];this.attrs={};this.selectedIndex=-1;}
    setAttribute(key,value){this.attrs[key]=value;}
    replaceChildren(...items){this.children=items;this.selectedIndex=items.length?0:-1;}
    add(item){this.children.push(item);}
    append(...items){this.children.push(...items);}
    click(){this.onclick();}
    addEventListener(name,fn){this[name]=fn;}
    focus(){active=this;}
    contains(target){return this===target || this.children.includes(target);}
  }
  const get=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id);};
  for(const name of ['name','group','channel','engine','host','port','user','password','database','sslMode','jdbcEnvironment','authMode','region','accessKeyId','accessKeySecret','keyword','profile','schema','databaseId','searchHint','environment','dmsEngine']) fields[name]=Object.assign(new Element(),{name});
  for(const [key,value] of Object.entries({channel:'jdbc',engine:'mysql',port:'3306',sslMode:'VERIFY_IDENTITY',authMode:'accessKey',region:'cn-hangzhou',environment:'product'}))fields[key].value=value;
  ids.set('dms-database-input',fields.keyword);
  get('dms-database-control').children=[fields.keyword,get('dms-search')];
  const form=get('connection');form.elements=fields;form.querySelectorAll=()=>[fields.name,fields.group];form.querySelector=()=>get('connect-submit');
  form.addEventListener=(name,fn)=>events[name]=fn;
  const document={documentElement:{lang:language},body:{dataset:{view:'connect'}},getElementById:get,createElement:()=>new Element(),addEventListener:(name,fn)=>listeners[name]=fn};
  class FormData {
    constructor(){const names=['name','group','region',...(fields.channel.value==='dms'?(fields.authMode.value==='accessKey'?['keyword','accessKeyId','accessKeySecret']:['profile','schema','databaseId','searchHint','environment','dmsEngine']):['engine','host','port','user','password','database','sslMode','jdbcEnvironment'])];this.entries=names.map(name=>[name,fields[name].value]);}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
  }
  const context=vm.createContext({document,window:{addEventListener:(name,fn)=>events[name]=fn},FormData,Option:class {constructor(text,value){this.textContent=text;this.value=value;}},acquireVsCodeApi:()=>({postMessage:m=>sent.push(JSON.parse(JSON.stringify(m)))})});
  for(const file of ['i18n.js','workbench.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../media',file),'utf8'),context);
  const change=(name,value)=>{fields[name].value=value;events.change({target:fields[name]});};
  const input=(name,value)=>{fields[name].value=value;events.input({target:fields[name]});};
  const key=(element,value)=>{let prevented=false;get(element).onkeydown({key:value,preventDefault(){prevented=true;}});return prevented;};
  return {get,fields,sent,change,input,key,listeners,check(index,checked){const input=get('dms-database-options').children[index].children[0];input.checked=checked;input.onchange();},get active(){return active;},receive:data=>events.message({data}),submit:()=>events.submit({preventDefault(){},submitter:{value:'save'}})};
}
const rows=[{database:'sandbox',databaseId:'42',label:'sandbox · Demo · mysql · #42'},{database:'sandbox',databaseId:'43',label:'sandbox · Other · mysql · #43'}];
test('connection form has one database search with native multi-selection and no fake tabs',()=>{
  const source=connectHtml({language:'en',csp:"'self'",css:'a',script:'b',i18n:'c',icon:'d'});
  assert.deepEqual([...source.matchAll(/name="engine" value="([^"]+)"/g)].map(m=>m[1]),['mysql','polardb','drds','doris']);
  const assets={language:'zh-cn',csp:"'self'",css:'a',script:'b',i18n:'c',icon:'d'};
  const html=connectHtml(assets);
  assert.doesNotMatch(html,/config-tabs|搜索关键词/);
  assert.match(html,/class="connection-status subdued">只读<\/span>/);
  assert.match(html,/name="keyword" type="search"/);
  assert.match(html,/type="checkbox" id="dms-select-all"/);
  assert.equal((html.match(/name="keyword"/g)||[]).length,1);
  assert.match(resultHtml(assets),/class="tab active" id="mode"/);
  for(const [language,connect,save] of [['en','＋ Connect','Save and open'],['zh-cn','＋ 连接','保存并打开']]) {
    const view=create(language);assert.equal(view.get('connect-submit').textContent,connect);
    view.change('channel','dms');assert.equal(view.get('connect-submit').textContent,save);
    view.change('authMode','profile');assert.equal(view.get('connect-submit').textContent,connect);
  }
});
test('search multi-select and later searches retain exact targets and their own lookup names',()=>{
  const view=create();view.change('channel','dms');view.input('keyword','sand');
  assert.equal(view.key('dms-database-input','Enter'),true);assert.equal(view.sent.at(-1).values.keyword,'sand');
  view.receive({type:'dmsDatabases',databases:rows});assert.equal(view.active,view.fields.keyword);
  view.check(0,true);view.check(1,true);assert.equal(view.fields.name.value,'DMS');
  view.input('keyword','orders');assert.equal(view.get('dms-selected-databases').children.length,2);
  view.get('dms-search').onclick();view.receive({type:'dmsDatabases',databases:[{database:'orders',databaseId:'44',label:'orders · #44'}]});
  view.get('dms-select-all').checked=true;view.get('dms-select-all').onchange();
  assert.equal(view.get('dms-selected-databases').children.length,3);
  view.submit();assert.deepEqual(view.sent.at(-1),{type:'save',values:{name:'DMS',group:'',region:'cn-hangzhou',accessKeyId:'',accessKeySecret:'',channel:'dms',authMode:'accessKey',databases:[{keyword:'sand',database:'sandbox',databaseId:'42'},{keyword:'sand',database:'sandbox',databaseId:'43'},{keyword:'orders',database:'orders',databaseId:'44'}]}});
});
test('new selections can be unchecked or removed, and zero selections cannot be saved',()=>{
  const view=create('zh-cn');view.change('channel','dms');view.input('keyword','sand');view.get('dms-search').onclick();
  view.receive({type:'dmsDatabases',databases:rows});view.check(0,true);assert.equal(view.get('dms-select-all').indeterminate,true);
  view.check(1,true);assert.equal(view.get('dms-select-all').checked,true);
  view.check(0,false);assert.equal(view.get('dms-selected-databases').children.length,1);
  view.get('dms-selected-databases').children[0].children[1].onclick();assert.equal(view.get('dms-selected').hidden,true);
  const count=view.sent.length;view.submit();assert.equal(view.sent.length,count);assert.match(view.get('feedback').textContent,/选择一个或多个/);
  view.get('dms-search').onclick();view.receive({type:'dmsDatabases',databases:[]});assert.equal(view.get('dms-search-results').hidden,true);assert.equal(view.get('dms-search').disabled,false);
  view.get('dms-search').onclick();view.receive({type:'error',message:'Offline'});assert.equal(view.get('dms-search').disabled,false);
});
test('append keeps saved targets selected and never asks for their keys again',()=>{
  const view=create();view.receive({type:'configure',adding:true,connection:{channel:'dms',authMode:'accessKey',name:'Saved',database:'sandbox',keyword:'sand',databaseId:'42',region:'cn-beijing'}});
  assert.equal(view.get('heading').textContent,'Add databases');assert.equal(view.fields.keyword.value,'');
  view.input('keyword','sand');view.get('dms-search').onclick();view.receive({type:'dmsDatabases',databases:rows});
  assert.equal(view.get('dms-database-options').children[0].children[0].disabled,false);
  assert.equal(view.get('dms-selected-databases').children[0].children[1].textContent,'Already added');
  view.check(1,true);view.submit();assert.equal(view.sent.at(-1).values.databases.length,2);
  assert.equal(view.sent.at(-1).values.databases[0].databaseId,'42');assert.equal(view.sent.at(-1).values.accessKeyId,'');
});
test('credential or region edits drop unsaved targets but retain existing databases for re-verification',()=>{
  const view=create();view.receive({type:'configure',connection:{channel:'dms',authMode:'accessKey',name:'Saved',region:'cn-beijing',databases:[{keyword:'sand',database:'sandbox',databaseId:'42'}]}});
  view.input('keyword','sand');view.get('dms-search').onclick();view.receive({type:'dmsDatabases',databases:rows});view.check(1,true);
  view.input('region','cn-hangzhou');assert.equal(view.get('dms-selected-databases').children.length,1);assert.equal(view.get('dms-search-results').hidden,true);
  view.submit();assert.equal(view.sent.at(-1).values.databases[0].databaseId,'42');
});
test('saved single AK targets and custom CLI-profile lookup names survive edits without searching',()=>{
  const ak=create();ak.receive({type:'configure',connection:{channel:'dms',authMode:'accessKey',name:'Saved',database:'sandbox',keyword:'sand',databaseId:'42',region:'cn-beijing'}});
  ak.submit();assert.deepEqual(ak.sent.at(-1).values.databases,[{keyword:'sand',database:'sandbox',databaseId:'42'}]);
  for(const keyword of ['sandbox','saved lookup']) {
    const view=create();view.receive({type:'configure',connection:{channel:'dms',name:'Saved',database:'sandbox',keyword,databaseId:'42'}});
    assert.equal(view.get('dms-search-options').open,keyword!=='sandbox');view.submit();
    assert.equal(view.sent.at(-1).values.keyword,keyword);assert.equal(view.sent.at(-1).values.database,'sandbox');assert.equal(view.sent.at(-1).values.searchHint,undefined);
  }
  const profile=create();profile.change('channel','dms');profile.change('authMode','profile');profile.fields.schema.value='sandbox';profile.fields.databaseId.value='42';profile.submit();
  assert.equal(profile.sent.at(-1).values.keyword,'sandbox');
});

test('AK inputs stay masked in the form through multi-selection, repeated searches and failed saves',()=>{
  const view=create();view.change('channel','dms');
  view.input('accessKeyId','fixture-key-id');view.input('accessKeySecret','fixture-key-secret');view.input('keyword','sand');
  const retained=()=>{assert.equal(view.fields.accessKeyId.value,'fixture-key-id');assert.equal(view.fields.accessKeySecret.value,'fixture-key-secret');};
  view.get('dms-search').onclick();retained();view.receive({type:'dmsDatabases',databases:rows});
  view.check(0,true);retained();view.check(1,true);retained();view.check(0,false);retained();
  view.input('keyword','orders');view.get('dms-search').onclick();retained();
  assert.equal(view.sent.at(-1).values.accessKeySecret,'fixture-key-secret');
  view.receive({type:'dmsDatabases',databases:[{database:'orders',databaseId:'44',label:'orders · #44'}]});view.check(0,true);retained();
  view.submit();retained();view.receive({type:'error',message:'Offline save failure'});retained();
  view.submit();retained();assert.equal(view.sent.at(-1).values.databases.length,2);
  const html=connectHtml({language:'en',csp:"'self'",css:'a',script:'b',i18n:'c',icon:'d'});
  for(const field of ['accessKeyId','accessKeySecret'])assert.ok(html.includes('name="'+field+'" type="password" autocomplete="off"'));
});

test('saved databases can be explicitly removed, including all, without losing authentication',()=>{
  const view=create();const stored=rows.map(row=>({...row,keyword:'sand'}));
  view.receive({type:'configure',connection:{channel:'dms',authMode:'accessKey',name:'Saved',region:'cn-beijing',databases:stored}});
  view.get('dms-selected-databases').children[0].children.at(-1).onclick();
  assert.equal(view.get('dms-selected-databases').children.length,1);assert.equal(view.get('dms-removal-status').hidden,false);
  view.input('region','cn-hangzhou');assert.equal(view.get('dms-selected-databases').children.length,1);
  view.input('keyword','sand');view.get('dms-search').onclick();view.receive({type:'dmsDatabases',databases:rows});
  assert.equal(view.get('dms-database-options').children[0].children[0].checked,false);
  view.submit();assert.deepEqual(view.sent.at(-1).values.removedDatabases,[{database:'sandbox',databaseId:'42'}]);
  view.receive({type:'error',message:'Offline save failure'});assert.equal(view.get('dms-selected-databases').children.length,1);
  view.get('dms-selected-databases').children[0].children.at(-1).onclick();view.submit();
  assert.deepEqual(view.sent.at(-1).values.databases,[]);assert.equal(view.sent.at(-1).values.removedDatabases.length,2);
});


test('instance browsing is lazy, paginated, environment-aware and retains AK and selection',()=>{
  const view=create();view.change('channel','dms');view.fields.name.value='Shared';
  view.input('accessKeyId','fixture-key-id');view.input('accessKeySecret','fixture-key-secret');
  view.get('dms-environment-filter').value='test';view.get('dms-search').onclick();
  assert.equal(view.sent.at(-1).type,'listDmsInstances');assert.equal(view.sent.at(-1).values.environment,'test');
  const instance={instanceId:'7',instanceName:'Test warehouse',engine:'selectdb',environment:'test'};
  view.receive({type:'dmsInstances',instances:[instance],page:1,more:true});
  assert.equal(view.sent.filter(m=>m.type==='listDmsDatabases').length,0);
  view.get('dms-instances').children[0].children[0].onclick();
  assert.equal(view.sent.at(-1).type,'listDmsDatabases');assert.equal(view.sent.at(-1).values.instanceId,'7');
  const row={...instance,database:'sandbox',databaseId:'42',keyword:'sandbox',label:'sandbox · Test warehouse · test · selectdb'};
  view.receive({type:'dmsDatabases',instance,databases:[row],page:1,more:true});view.check(0,true);
  view.get('dms-more-databases').onclick();assert.equal(view.sent.at(-1).values.page,2);
  view.receive({type:'dmsDatabases',instance,databases:[{...row,database:'orders',databaseId:'43',keyword:'orders'}],page:2,more:false});
  assert.equal(view.get('dms-database-options').children.length,2);view.check(1,true);
  view.submit();const values=view.sent.at(-1).values;
  assert.equal(values.databases.length,2);assert.equal(values.databases[0].environment,'test');assert.equal(values.databases[0].instanceId,'7');
  assert.equal(values.accessKeyId,'fixture-key-id');assert.equal(values.accessKeySecret,'fixture-key-secret');
  view.receive({type:'error',message:'fixture save error'});view.get('dms-search').onclick();
  view.receive({type:'dmsInstances',instances:[instance],page:1,more:false});
  assert.equal(view.get('dms-instances').children.length,1);assert.equal(view.get('dms-selected-databases').children.length,2);
});

test('JDBC environment is an optional display label; editing restores it without affecting DMS fields',()=>{
 const view=create('zh-cn');view.fields.jdbcEnvironment.value='test';view.submit();assert.equal(view.sent.at(-1).values.environment,'test');assert.equal(view.sent.at(-1).values.jdbcEnvironment,undefined);
 view.receive({type:'configure',connection:{channel:'jdbc',name:'Fixture',host:'fixture.invalid',port:3306,database:'sandbox',engine:'mysql',environment:'product'}});
 assert.equal(view.fields.jdbcEnvironment.value,'product');
});
