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
    click(){this.onclick();}
    addEventListener(name,fn){this[name]=fn;}
    focus(){active=this;}
    contains(target){return this===target || this.children.includes(target);}
  }
  const get=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id);};
  for(const name of ['name','group','channel','engine','host','port','user','password','database','sslMode','authMode','region','accessKeyId','accessKeySecret','keyword','dmsDatabase','profile','schema','databaseId','searchHint']) fields[name]=Object.assign(new Element(),{name});
  for(const [key,value] of Object.entries({channel:'jdbc',engine:'mysql',port:'3306',sslMode:'VERIFY_IDENTITY',authMode:'accessKey',region:'cn-hangzhou'}))fields[key].value=value;
  ids.set('dms-database-input',fields.keyword);ids.set('dms-database-options',fields.dmsDatabase);
  get('dms-database-control').children=[fields.keyword,fields.dmsDatabase,get('dms-search')];
  const form=get('connection');form.elements=fields;form.querySelectorAll=()=>[fields.name,fields.group];
  form.addEventListener=(name,fn)=>events[name]=fn;
  const document={documentElement:{lang:language},body:{dataset:{view:'connect'}},getElementById:get,addEventListener:(name,fn)=>listeners[name]=fn};
  class FormData {
    constructor(){const names=['name','group','region',...(fields.channel.value==='dms'?(fields.authMode.value==='accessKey'?['keyword','accessKeyId','accessKeySecret']:['profile','schema','databaseId','searchHint']):['engine','host','port','user','password','database','sslMode'])];this.entries=names.map(name=>[name,fields[name].value]);}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
  }
  const context=vm.createContext({document,window:{addEventListener:(name,fn)=>events[name]=fn},FormData,Option:class {constructor(text,value){this.textContent=text;this.value=value;}},acquireVsCodeApi:()=>({postMessage:m=>sent.push(JSON.parse(JSON.stringify(m)))})});
  for(const file of ['i18n.js','workbench.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../media',file),'utf8'),context);
  const change=(name,value)=>{fields[name].value=value;events.change({target:fields[name]});};
  const input=(name,value)=>{fields[name].value=value;events.input({target:fields[name]});};
  const key=(element,value)=>{let prevented=false;get(element).onkeydown({key:value,preventDefault(){prevented=true;}});return prevented;};
  return {get,fields,sent,change,input,key,listeners,get active(){return active;},receive:data=>events.message({data}),submit:()=>events.submit({preventDefault(){},submitter:{value:'save'}})};
}
const rows=[{database:'sandbox',databaseId:'42',label:'sandbox · Demo · mysql · #42'},{database:'sandbox',databaseId:'43',label:'sandbox · Other · mysql · #43'}];
test('connection form has one compound database picker and no fake tabs; result tabs stay',()=>{
  const assets={language:'zh-cn',csp:"'self'",css:'a',script:'b',i18n:'c',icon:'d'};
  const html=connectHtml(assets);
  assert.doesNotMatch(html,/config-tabs|搜索关键词/);
  assert.match(html,/class="connection-status subdued">只读<\/span>/);
  assert.match(html,/role="combobox"[^>]*aria-controls="dms-database-options"/);
  assert.equal((html.match(/name="keyword"/g)||[]).length,1);
  assert.match(html,/<details id="dms-search-options"[^>]*>/);
  assert.match(resultHtml(assets),/class="tab active" id="mode"/);
});
test('AK single picker selects exact target while retaining the original lookup name',()=>{
  const view=create();view.change('channel','dms');view.input('keyword','sand');
  assert.equal(view.key('dms-database-input','Enter'),true);
  assert.equal(view.sent.at(-1).type,'searchDmsDatabases');assert.equal(view.sent.at(-1).values.keyword,'sand');
  view.receive({type:'dmsDatabases',databases:rows});
  assert.equal(view.fields.dmsDatabase.hidden,false);assert.equal(view.fields.keyword.attrs['aria-expanded'],'true');assert.equal(view.active,view.fields.keyword);
  view.key('dms-database-input','ArrowDown');assert.equal(view.active,view.fields.dmsDatabase);
  view.fields.dmsDatabase.selectedIndex=1;view.key('dms-database-options','Enter');
  assert.equal(view.fields.keyword.value,'sandbox');assert.equal(view.fields.dmsDatabase.hidden,true);
  assert.equal(view.fields.name.value,'sandbox · DMS');assert.match(view.get('dms-search-status').textContent,/#43/);
  assert.equal(view.sent.at(-1).type,'searchDmsDatabases');
  view.submit();assert.deepEqual(view.sent.at(-1),{type:'save',values:{name:'sandbox · DMS',group:'',region:'cn-hangzhou',keyword:'sand',accessKeyId:'',accessKeySecret:'',channel:'dms',authMode:'accessKey',database:'sandbox',databaseId:'43'}});
  view.receive({type:'error',message:'Offline'});view.input('keyword','another');const count=view.sent.length;view.submit();
  assert.equal(view.sent.length,count);assert.match(view.get('feedback').textContent,/Search and select/);
});
test('picker dismisses without committing; empty and failed searches restore a usable form',()=>{
  const view=create('zh-cn');view.change('channel','dms');view.input('keyword','sand');view.get('dms-search').onclick();
  view.receive({type:'dmsDatabases',databases:rows});view.key('dms-database-input','ArrowDown');
  view.key('dms-database-options','Escape');assert.equal(view.fields.dmsDatabase.hidden,true);
  const count=view.sent.length;view.submit();assert.equal(view.sent.length,count);
  view.key('dms-database-input','ArrowDown');view.listeners.focusin({target:view.fields.name});assert.equal(view.fields.dmsDatabase.hidden,true);
  view.get('dms-search').onclick();view.receive({type:'dmsDatabases',databases:[]});assert.equal(view.fields.dmsDatabase.hidden,true);assert.equal(view.get('dms-search').disabled,false);
  assert.match(view.get('feedback').textContent,/未找到/);
  view.get('dms-search').onclick();view.receive({type:'error',message:'Offline'});assert.equal(view.get('dms-search').disabled,false);
});
test('saved AK targets and custom legacy lookup names survive edits without a new search',()=>{
  const ak=create();ak.receive({type:'configure',connection:{channel:'dms',authMode:'accessKey',name:'Saved',database:'sandbox',keyword:'sand',databaseId:'42',region:'cn-beijing'}});
  assert.equal(ak.fields.keyword.value,'sandbox');ak.submit();assert.equal(ak.sent.at(-1).values.keyword,'sand');assert.equal(ak.sent.at(-1).values.databaseId,'42');
  for(const keyword of ['sandbox','saved lookup']) {
    const view=create();view.receive({type:'configure',connection:{channel:'dms',name:'Saved',database:'sandbox',keyword,databaseId:'42'}});
    assert.equal(view.get('dms-search-options').open,keyword!=='sandbox');view.submit();
    assert.equal(view.sent.at(-1).values.keyword,keyword);assert.equal(view.sent.at(-1).values.database,'sandbox');assert.equal(view.sent.at(-1).values.searchHint,undefined);
  }
  const profile=create();profile.change('channel','dms');profile.change('authMode','profile');profile.fields.schema.value='sandbox';profile.fields.databaseId.value='42';profile.submit();
  assert.equal(profile.sent.at(-1).values.keyword,'sandbox');
});
