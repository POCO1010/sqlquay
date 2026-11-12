'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {copyCells}=require('../src/sessions.cjs');
const create=require('./fixture/result-dom.cjs');
const event=values=>({preventDefault(){},stopPropagation(){},...values});
const data={columns:[{name:'id',type:'BIGINT'},{name:'payload',type:'JSON'}],rows:[['2','{"n":9007199254740993}'],['1','<script>fixture</script>'],['3',null]],truncated:false};
const show=view=>view.receive({id:1,state:'done',mode:'DATA',sql:'SELECT id, payload',target:'Long connection / sandbox',connectionInfo:{name:'Long connection',database:'sandbox',instance:'Test warehouse',channel:'dms',environment:'test'},result:data});
test('clipboard selection validates loaded addresses and preserves exact cell values',()=>{
 const result={columns:[{},{}],rows:[['a\tb','x"y'],[null,'line\n2']]};
 assert.equal(copyCells(result,{rows:[0],from:0,to:0}),'a\tb');
 assert.equal(copyCells(result,{rows:[0,1],from:0,to:1}),'"a\tb"\t"x""y"\nNULL\t"line\n2"');
 for(const selection of [{rows:[],from:0,to:1},{rows:[-1],from:0,to:0},{rows:[2],from:0,to:0},{rows:[0],from:0,to:2},{rows:[0],from:1,to:0},{rows:[0.5],from:0,to:0},{rows:[0,1,0],from:0,to:0}]) assert.equal(copyCells(result,selection),undefined);
 assert.equal(copyCells({columns:[{}],rows:[['']]},{rows:[0],from:0,to:0}),'');
});
test('cell and Shift-click rectangles copy in visible order; sorting/filtering/paging clear a range',()=>{
 const view=create();show(view);
 view.cell(0,0).onclick(event());view.cell(1,1).onclick(event({shiftKey:true}));view.get('copy-selection').onclick();
 assert.equal(view.cell(0,0).attrs.role,'gridcell');assert.equal(view.cell(1,1).attrs['aria-selected'],'true');
 assert.deepEqual({...view.sent.at(-1),rows:[...view.sent.at(-1).rows]},{type:'copySelection',runId:1,rows:[0,1],from:0,to:1});
 view.sort();assert.equal(view.get('copy-selection').disabled,true);
 view.cell(0,1).onclick(event());view.cell(1,0).onclick(event({shiftKey:true}));view.get('copy-selection').onclick();
 assert.deepEqual([...view.sent.at(-1).rows],[1,0]);
 view.get('filter').value='9007';view.get('filter').oninput();assert.equal(view.get('copy-selection').disabled,true);
 view.get('filter').value='';view.get('filter').oninput();view.get('size').value='1';view.get('size').onchange();
 view.cell(0,0).onclick(event());view.get('next').onclick();assert.equal(view.get('copy-selection').disabled,true);
 assert.ok(view.sent.every(m=>['ready','copySelection'].includes(m.type)));
});
test('keyboard range and detail viewer keep raw JSON precision and literal HTML',()=>{
 const view=create();show(view);const cell=view.cell(0,1);cell.onclick(event());assert.equal(view.cell(0,1),cell,'keep the DOM cell so native double-click can fire');
 view.cell(0,1).onkeydown(event({key:'ArrowDown',shiftKey:true}));view.cell(1,1).onkeydown(event({key:'c',metaKey:true}));
 assert.deepEqual([...view.sent.at(-1).rows],[0,1]);
 view.get('grid').oncopy(event());assert.equal(view.sent.at(-1).type,'copySelection');
 view.cell(0,1).ondblclick(event());assert.equal(view.get('cell-detail').hidden,false);
 assert.equal(view.get('cell-value').textContent,'{"n":9007199254740993}');
 view.get('copy-value').onclick();assert.deepEqual([...view.sent.at(-1).rows],[0]);assert.equal(view.sent.at(-1).from,1);
 view.cell(1,1).ondblclick(event());assert.equal(view.get('cell-value').textContent,'<script>fixture</script>');
 view.get('cell-detail').onkeydown(event({key:'Escape'}));assert.equal(view.get('cell-detail').hidden,true);
 view.receive({type:'copied',runId:1});assert.match(view.get('selection-status').textContent,/复制/);
 view.show(['new']);assert.equal(view.get('cell-detail').hidden,true);assert.equal(view.get('copy-selection').disabled,true);
});
test('column resize supports pointer and keyboard and survives same-result updates',()=>{
 const view=create();show(view);let handle=view.resize(1);
 handle.onpointerdown(event({button:0,pointerId:1,clientX:100}));handle.onpointermove(event({pointerId:1,clientX:180}));handle.onpointerup(event({pointerId:1}));
 assert.equal(view.cell(0,1).style.width,'168px');
 show(view);assert.equal(view.cell(0,1).style.width,'168px');
 handle=view.resize(1);handle.onkeydown(event({key:'ArrowRight'}));assert.equal(view.cell(0,1).style.width,'184px');
 handle.ondblclick(event());assert.equal(view.cell(0,1).style.width,'');
 view.show(['new']);assert.equal(view.cell(0,0).style.width,'');
});
test('target badges are separate, bilingual and do not guess a missing JDBC environment',()=>{
 for(const language of ['en','zh-cn']) {
  const view=create(undefined,language);show(view);
  assert.equal(view.get('channel-badge').textContent,'DMS');assert.equal(view.get('environment-badge').textContent,language==='en'?'Test':'测试');
  assert.equal(view.get('target').textContent,'Long connection');assert.equal(view.get('target').title,'Long connection / sandbox');
  assert.equal(view.get('target-database').textContent,'sandbox');assert.equal(view.get('target-instance').textContent,'Test warehouse');
  view.receive({id:2,state:'running',sql:'SELECT 1',target:'Production by name only',connectionInfo:{name:'Production by name only',channel:'jdbc',database:'sandbox'}});
  assert.equal(view.get('environment-badge').textContent,language==='en'?'Unmarked':'未标记');assert.equal(view.get('channel-badge').textContent,'JDBC');
 }
});
