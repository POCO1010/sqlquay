'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.DBW_PLAYWRIGHT || 'playwright');
const {connectHtml,resultHtml}=require('../src/webviews.cjs');
const media=path.join(__dirname,'../media');
const assets={csp:"'self'",css:'/workbench.css',script:'/workbench.js',i18n:'/i18n.js',icon:'/database.svg'};
const output=process.argv[2];
const external=[],errors=[];
async function create(browser,html,width=1120,light=false) {
  const page=await browser.newPage({viewport:{width,height:680},colorScheme:light?'light':'dark'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(light=>{
    window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.sent.push(m)});
    const theme=light?{'editor-background':'#ffffff','editor-foreground':'#292929','panel-border':'#dedede','input-background':'#f7f7f7','input-border':'#cecece','descriptionForeground':'#555555','list-hoverBackground':'#efefef','font-family':'system-ui'}:{'font-family':'system-ui'};
    document.addEventListener('DOMContentLoaded',()=>{for(const [k,v] of Object.entries(theme)) document.documentElement.style.setProperty('--vscode-'+k,v);});
  },light);
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://workbench.invalid'){external.push(url.origin);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
    const name=url.pathname.slice(1);
    if(!['workbench.js','i18n.js','workbench.css','database.svg'].includes(name))return route.abort();
    return route.fulfill({path:path.join(media,name)});
  });
  await page.goto('http://workbench.invalid/');
  await page.waitForFunction(()=>window.sent.some(m=>m.type==='ready'));
  return page;
}
const dispatch=(page,message)=>page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),message);
async function main(){
 const browser=await chromium.launch({headless:true,executablePath:process.env.DBW_CHROME,args:['--disable-background-networking','--no-first-run']});
 try {
   const form=await create(browser,connectHtml(assets));
   if(output) await form.screenshot({path:path.join(output,'connect-verified.png')});
   assert.equal(await form.getByRole('combobox',{name:'TLS',exact:true}).inputValue(),'VERIFY_IDENTITY');
   assert.equal(await form.locator('#tls-warning').isVisible(),false);
   await form.getByRole('combobox',{name:'TLS',exact:true}).selectOption('DISABLED');
   assert.equal(await form.locator('#tls-warning').isVisible(),true);
   if(output) await form.screenshot({path:path.join(output,'connect-unencrypted.png')});
   await form.getByRole('radio',{name:/Doris/}).check();
   assert.equal(await form.getByLabel('Port').inputValue(),'9030');
   for(const [name,value] of Object.entries({Name:'Test fixture',Host:'fixture.invalid',Username:'reader',Password:'synthetic',Database:'sandbox'})) await form.getByLabel(name,{exact:true}).fill(value);
   await form.getByRole('button',{name:'Connect'}).click();
   assert.equal((await form.evaluate(()=>window.sent.at(-1))).type,'connect');
   assert.equal((await form.evaluate(()=>window.sent.at(-1))).values.sslMode,'DISABLED');
   assert.equal(await form.getByLabel('Password').inputValue(),'');
   await dispatch(form,{type:'error',message:'Check test credentials.'});
   assert.equal(await form.locator('#feedback').textContent(),'Check test credentials.');
   await form.getByRole('button',{name:'Save',exact:true}).click();
   assert.equal((await form.evaluate(()=>window.sent.at(-1))).type,'save');
   const ak=await create(browser,connectHtml(assets));
   await ak.getByRole('radio',{name:'DMS',exact:true}).check();
   assert.equal(await ak.locator('.config-tabs').count(),0);
   const database=ak.getByRole('combobox',{name:'Database',exact:true});
   await database.fill('sand');await database.press('Enter');
   assert.equal((await ak.evaluate(()=>window.sent.at(-1))).values.keyword,'sand');
   await dispatch(ak,{type:'dmsDatabases',databases:[{database:'sandbox',databaseId:'42',label:'sandbox · Demo · #42'}]});
   await database.press('ArrowDown');await ak.getByRole('listbox',{name:'Matching databases'}).press('Enter');
   assert.equal(await database.inputValue(),'sandbox');
   await ak.getByRole('button',{name:'Save',exact:true}).click();
   const selected=(await ak.evaluate(()=>window.sent.at(-1))).values;
   assert.equal(selected.keyword,'sand');assert.equal(selected.database,'sandbox');assert.equal(selected.databaseId,'42');
   await dispatch(ak,{type:'error',message:'Offline'});await database.fill('different');
   const attempts=await ak.evaluate(()=>window.sent.length);await ak.getByRole('button',{name:'Save',exact:true}).click();
   assert.equal(await ak.evaluate(()=>window.sent.length),attempts);
   const dms=await create(browser,connectHtml(assets),520,true);
   await dms.getByRole('radio',{name:'DMS',exact:true}).check();
   assert.equal(await dms.getByLabel('Username').isVisible(),false);
   await dms.getByRole('combobox',{name:'DMS authentication',exact:true}).selectOption('profile');
   assert.equal((await dms.evaluate(()=>window.sent.at(-1))).type,'loadDmsProfiles');
   await dispatch(dms,{type:'dmsProfiles',profiles:[{name:'team-fixture',region:'cn-beijing',valid:true}]});
   await dms.getByRole('combobox',{name:'Aliyun CLI profile'}).selectOption('team-fixture');
   assert.equal(await dms.getByRole('textbox',{name:'DMS region'}).inputValue(),'cn-beijing');
   assert.equal(await dms.evaluate(()=>document.documentElement.scrollWidth),520);
   if (output) await dms.screenshot({path:path.join(output,'connect-dms.png')});
   for(const [name,value] of Object.entries({Name:'DMS fixture',Schema:'fixture','Database ID':'42'})) {
     await dms.getByLabel(name,{exact:true}).fill(value);
   }
   await dms.getByRole('button',{name:'Connect'}).click();
   assert.deepEqual((await dms.evaluate(()=>window.sent.at(-1))).values,{
     channel:'dms',authMode:'profile',profile:'team-fixture',region:'cn-beijing',name:'DMS fixture',group:'',keyword:'fixture',database:'fixture',databaseId:'42'
   });
   await dispatch(dms,{type:'error',message:'Target not found.'});
   assert.equal(await dms.locator('#feedback').textContent(),'Target not found.');
   await dispatch(dms,{type:'configure',connection:{channel:'dms',name:'Saved DMS',database:'saved_schema',keyword:'saved',databaseId:'7'}});
   assert.equal(await dms.getByRole('radio',{name:'JDBC',exact:true}).isDisabled(),true);
   assert.equal(await dms.getByLabel('Schema').inputValue(),'saved_schema');
   await dms.getByRole('button',{name:'Save',exact:true}).click();
   assert.equal((await dms.evaluate(()=>window.sent.at(-1))).values.channel,'dms');
   await dispatch(form,{type:'error',message:'Synthetic fixture'});
   await dispatch(form,{type:'configure',connection:{channel:'jdbc',name:'Saved JDBC',engine:'doris',host:'fixture.invalid',port:9030,database:'sandbox'}});
   assert.equal(await form.getByLabel('Host').inputValue(),'fixture.invalid');
   assert.equal(await form.getByRole('combobox',{name:'TLS',exact:true}).inputValue(),'VERIFY_IDENTITY');
   assert.equal(await form.getByRole('radio',{name:'DMS',exact:true}).isDisabled(),true);
   await form.getByRole('button',{name:'Save',exact:true}).click();
   assert.equal((await form.evaluate(()=>window.sent.at(-1))).values.channel,'jdbc');
   const table=await create(browser,resultHtml(assets));
   const rowset=Array.from({length:28},(_,i)=>[String(i+1),i===2?'NULL':i===4?null:i===5?'<img src="https://example.invalid/no">':'Product '+(i+1),i===0?'9007199254740993':String(i+1)]);
   const state={id:1,target:'Local Demo / sandbox',sql:'SELECT id, name, price FROM products LIMIT 50;',elapsed:12,state:'done',
      result:{columns:['id','name','price'].map(name=>({name,type:'TEXT'})),rows:rowset,truncated:false}};
   if(output) {
     const sample={...state,sql:'SELECT id, name, category, price FROM products LIMIT 50;',result:{...state.result,columns:['id','name','category','price'].map(name=>({name,type:'TEXT'})),rows:[['1','Trail mug','Accessories','12.50'],['2','Studio lamp','Home','49.90'],['3','Pocket notebook','Stationery','6.00'],['4','Field tote','Accessories','23.00'],['5','Desk tray','Home',null],['6','Grid pad','Stationery','8.90']]}};
     await dispatch(table,sample);
     await table.screenshot({path:path.join(output,'result.png')});
     const compact=await create(browser,resultHtml(assets),460,true);
     await dispatch(compact,sample);
     assert.equal(await compact.evaluate(()=>document.documentElement.scrollWidth),460);
     await compact.screenshot({path:path.join(output,'result-light.png')});
     await compact.close();
   }
   await dispatch(table,{...state,id:2});
   assert.equal(await table.locator('tbody tr').count(),25);
   await table.getByRole('button',{name:'Next page'}).click();
   assert.equal(await table.locator('tbody tr').count(),3);
   await table.getByRole('button',{name:'Previous page'}).click();
   await table.getByRole('button',{name:'id',exact:true}).click();
   await table.getByRole('button',{name:/^id/}).click();
   assert.equal(await table.locator('tbody tr th').first().textContent(),'28');
   const search=table.getByRole('textbox',{name:'Search Results'});
   await search.fill('NULL');
   assert.equal(await table.locator('tbody tr').count(),2);
   assert.equal(await table.locator('tbody td.null').count(),1);
   await table.locator('tbody tr').first().click();
   await table.getByRole('button',{name:'Copy row'}).click();
   assert.equal((await table.evaluate(()=>window.sent.at(-1))).type,'copy');
   await search.fill('9007199254740993');
   assert.equal(await table.locator('tbody tr').count(),1);
   await dispatch(table,{id:1,sql:'SELECT 999',target:'stale',state:'error',error:'stale'});
   assert.equal(await table.getByRole('textbox',{name:'SQL',exact:true}).inputValue(),state.sql);
   assert.deepEqual((await table.evaluate(()=>window.sent)).map(m=>m.type),['ready','copy']);
   await table.getByRole('textbox',{name:'SQL',exact:true}).fill('SELECT 1 AS probe;');
   await table.getByRole('button',{name:/Run/}).click();
   assert.equal((await table.evaluate(()=>window.sent.at(-1))).sql,'SELECT 1 AS probe;');
   await dispatch(table,{...state,id:3,mode:'PREVIEW',sql:'sandbox.products'});
   const preview=table.getByRole('textbox',{name:'Preview table'});
   assert.equal(await preview.inputValue(),'sandbox.products');
   assert.equal(await preview.isEditable(),false);
   assert.equal(await table.getByRole('button',{name:/Run/}).isVisible(),false);
   await preview.press('Meta+Enter');
   assert.equal((await table.evaluate(()=>window.sent)).filter(m=>m.type==='run').length,1);
   assert.equal(await table.locator('tbody tr').count(),25);
   if(output) await table.screenshot({path:path.join(output,'preview.png')});
   await dispatch(table,{...state,id:4});
   assert.equal(await table.getByRole('textbox',{name:'SQL',exact:true}).isEditable(),true);
   assert.equal(await table.getByRole('button',{name:/Run/}).isVisible(),true);
   await dispatch(table,{...state,id:5,result:{columns:[{name:'amount',type:'DECIMAL'}],
     rows:[['1.2'],['-2'],['9007199254740993.00000000000001'],['9007199254740993'],['1.10'],['-10'],[null]],truncated:false}});
   await table.getByRole('button',{name:'amount',exact:true}).click();
   assert.deepEqual(await table.locator('tbody tr td').allTextContents(),['NULL','-10','-2','1.10','1.2','9007199254740993','9007199254740993.00000000000001']);
   assert.equal(await table.locator('#total').textContent(),'Loaded 7 rows');
   if(output) await table.screenshot({path:path.join(output,'numeric-sort.png')});
   await dispatch(table,{...state,id:6,mode:'PREVIEW',sql:'sandbox.products',result:{columns:[{name:'id',type:''}],
     rows:Array.from({length:100},(_,i)=>[String(i+1)]),truncated:false}});
   assert.equal(await table.locator('#total').textContent(),'Loaded 100 rows · Preview limit: 100 rows');
   await search.fill('100');
   assert.equal(await table.locator('#total').textContent(),'Matched 1 / Loaded 100 rows · Preview limit: 100 rows');
   if(output) await table.screenshot({path:path.join(output,'preview-count.png')});
   assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
   await dispatch(table,{...state,id:7,pinned:true,timings:{connect:3,preflight:4,execute:2},elapsed:12});
   assert.equal(await table.getByRole('button',{name:'Unpin result',exact:true}).getAttribute('aria-pressed'),'true');
   assert.match(await table.locator('#phases').textContent(),/Connection 3 ms · Preflight 4 ms · Execution 2 ms · Other 3 ms/);
   await table.getByRole('button',{name:'Unpin result',exact:true}).click();
   assert.equal((await table.evaluate(()=>window.sent.at(-1))).type,'pin');
   await table.getByRole('button',{name:'Session history',exact:true}).click();
   assert.equal((await table.evaluate(()=>window.sent.at(-1))).type,'history');
   await table.getByRole('textbox',{name:'SQL',exact:true}).fill('SELECT 1 AS pending_edit;');
   for(const pinned of [false,true]) {
     await table.locator('#pin').click();
     await dispatch(table,{...state,id:7,pinned});
     assert.equal(await table.getByRole('textbox',{name:'SQL',exact:true}).inputValue(),'SELECT 1 AS pending_edit;');
   }
   await table.getByRole('button',{name:/Run/}).click();
   assert.equal((await table.evaluate(()=>window.sent.at(-1))).sql,'SELECT 1 AS pending_edit;');
   if(output) await table.screenshot({path:path.join(output,'history-timing.png')});
   console.log('DBW_WEBVIEW_PASS');
 } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
