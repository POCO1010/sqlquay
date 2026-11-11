'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const createResult=require('./fixture/result-dom.cjs');
test('numeric sort handles signs, decimals, NULL and stable equal values',()=>{
  const view=createResult();
  view.show(['1.2','-2',null,'1.10','-10','0','-0','+0.0'],'DECIMAL');
  view.sort();
  assert.deepEqual(view.values(),['NULL','-10','-2','0','-0','+0.0','1.10','1.2']);
  view.sort();
  assert.deepEqual(view.values(),['1.2','1.10','0','-0','+0.0','-2','-10','NULL']);
  assert.deepEqual(view.sent.map(x=>x.type),['ready']);
});
test('large integers and high precision decimals are compared without Number rounding',()=>{
  const view=createResult();
  view.show(['9007199254740993','9007199254740992','9007199254740993.00000000000001','9007199254740992.99999999999999'],'DECIMAL');
  view.sort();
  assert.deepEqual(view.values(),['9007199254740992','9007199254740992.99999999999999','9007199254740993','9007199254740993.00000000000001']);
  view.show(['1e500','2e499','1e-500','-2e499','.001','-.01'],'DOUBLE');
  view.sort();
  assert.deepEqual(view.values(),['-2e499','-.01','1e-500','.001','2e499','1e500']);
});
test('DMS columns without type infer numeric data; typed text stays text',()=>{
  const view=createResult();
  view.show(['-10','1.2','-2','1.10',null]);
  view.sort();
  assert.deepEqual(view.values(),['NULL','-10','-2','1.10','1.2']);
  view.show(['1.10','1.2'],'VARCHAR');
  view.sort();
  assert.deepEqual(view.values(),['1.2','1.10']);
  view.show(['NaN','2','1','-Infinity'],'DOUBLE');
  view.sort();
  assert.deepEqual(view.values(),['1','2','-Infinity','NaN']);
  view.show([null,null],'INT');view.sort();
  assert.deepEqual(view.values(),['NULL','NULL']);
});
test('counts describe loaded rows, preview limit, filtering and truncation',()=>{
  const view=createResult();
  view.show(Array.from({length:100},(_,i)=>String(i+1)),'BIGINT','PREVIEW');
  assert.equal(view.get('total').textContent,'已加载 100 行 · 预览上限 100 行');
  view.get('filter').value='100';view.get('filter').oninput();
  assert.equal(view.get('total').textContent,'匹配 1 / 已加载 100 行 · 预览上限 100 行');
  view.show(['1','2'],'BIGINT','DATA',true);
  assert.equal(view.get('total').textContent,'已加载 2 行 · 已截断');
  view.show([],'','PREVIEW');
  assert.equal(view.get('total').textContent,'已加载 0 行 · 预览上限 100 行');
});
test('pin and same-result updates preserve SQL edits; a new result initializes its own SQL',()=>{
  const view=createResult();
  view.show(['1'],'BIGINT');
  view.get('statement').value='SELECT 1 AS pending_edit;';
  view.get('filter').value='1';
  const reply={id:1,mode:'DATA',state:'done',sql:'Offline fixture',target:'fixture',
    result:{columns:[{name:'value',type:'BIGINT'}],rows:[['1']],truncated:false}};
  for(const pinned of [true,false]) {
    view.get('pin').onclick();
    view.receive({...reply,pinned});
    assert.equal(view.get('statement').value,'SELECT 1 AS pending_edit;');
    assert.equal(view.get('filter').value,'1');
    assert.deepEqual(view.values(),['1']);
  }
  view.get('run').onclick();
  assert.deepEqual({...view.sent.at(-1)},{type:'run',runId:1,sql:'SELECT 1 AS pending_edit;'});
  view.show(['2']);
  assert.equal(view.get('statement').value,'Offline fixture');
  assert.equal(view.get('filter').value,'');
});
