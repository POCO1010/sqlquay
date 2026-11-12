'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {language,translator,messages}=require('../media/i18n.js');
const {connectHtml,resultHtml}=require('../src/webviews.cjs');
const createResult=require('./fixture/result-dom.cjs');
const root=path.join(__dirname,'..');
test('locale follows VS Code: Chinese variants use Chinese; others use English',()=>{
  for(const locale of ['zh','zh-cn','zh-TW','zh_Hans','ZH-hk']) assert.equal(language(locale),'zh-CN');
  for(const locale of [undefined,'en','en-US','fr','zhx','']) assert.equal(language(locale),'en');
  assert.equal(translator('zh-cn')('Host'),'主机');
  assert.equal(translator('fr')('Host'),'Host');
});
test('translation substitutes literal arguments and preserves unknown database messages',()=>{
  const tr=translator('zh-cn');
  assert.equal(tr('Loaded {0} rows',0),'已加载 0 行');
  assert.equal(tr('Remove {0}?','<$&>{1}'),'移除 <$&>{1}？');
  for(const text of ['ER_UNKNOWN_TABLE: raw detail','__proto__','constructor','SELECT 1 AS probe']) assert.equal(tr(text),text);
  const slots=text=>[...text.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort();
  for(const [key,value] of Object.entries(messages)) {assert.ok(value.trim(),key);assert.deepEqual(slots(value),slots(key),key);}
});
test('manifest titles and all settings have English and Chinese resources',()=>{
  const manifest=require('../package.json'),en=require('../package.nls.json'),zh=require('../package.nls.zh.json');
  const keys=[...JSON.stringify(manifest).matchAll(/%([^%]+)%/g)].map(m=>m[1]);
  assert.equal(keys.length,23);
  assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
  for(const key of keys) {assert.ok(en[key]);assert.ok(zh[key]);}
  assert.equal(manifest.name,'sqlquay');assert.equal(manifest.publisher,'TomMajor');
  assert.equal(manifest.contributes.configuration.properties['dbWorkbench.driverJar'].default,'');
});
test('both webviews translate visible and accessible labels without changing protocol fields or CSP',()=>{
  for(const locale of ['zh-cn','en','fr']) {
    const tr=translator(locale),assets={language:locale,csp:"'self'",css:'style.css',script:'workbench.js',i18n:'i18n.js',icon:'database.svg'};
    for(const render of [connectHtml,resultHtml]) {
      const html=render(assets);
      assert.ok(html.includes('lang="'+language(locale)+'"'));
      assert.ok(html.includes("connect-src 'none'"));
      const scripts=[...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)">/g)];
      assert.deepEqual(scripts.map(m=>m[2]),['i18n.js','workbench.js']);
      assert.equal(scripts[0][1],scripts[1][1]);
    }
    const form=connectHtml(assets),result=resultHtml(assets);
    for(const label of ['Connect to server','Host','Password','CLI profile','Region','Database ID','Refresh profiles','Save']) assert.ok(form.includes(tr(label)),label);
    assert.ok(form.includes('placeholder="'+tr('Connection name')+'"'));
    assert.ok(form.includes('aria-label="'+tr('Aliyun CLI profile')+'"'));
    for(const field of ['host','password','profile','region','databaseId']) assert.ok(form.includes('name="'+field+'"'));
    assert.ok(form.includes('value="VERIFY_IDENTITY"'));assert.ok(form.includes('value="DISABLED"'));
    assert.ok(result.includes('aria-label="'+tr('Result controls')+'"'));
    for(const label of ['Pin result','Session history','Search Results','Copy row','Rows per page']) assert.ok(result.includes(tr(label)),label);
    assert.ok(result.includes(tr('Loaded {0} rows',0)));
  }
});
test('result updates, counts, phases and pin controls work in both languages; data stays unchanged',()=>{
  for(const locale of ['zh-cn','en']) {
    const tr=translator(locale),view=createResult(undefined,locale);
    view.receive({id:1,state:'done',mode:'PREVIEW',target:'用户自己的连接',sql:'sandbox.products',pinned:true,elapsed:12,timings:{connect:3,preflight:4,execute:2},result:{columns:[{name:'price',type:'DECIMAL'}],rows:[['1.20'],['-2.00']],truncated:false}});
    assert.equal(view.get('mode').textContent,tr('Preview data'));
    assert.equal(view.get('pin').textContent,tr('Unpin result'));
    assert.equal(view.get('target').textContent,'用户自己的连接');
    assert.equal(view.get('statement').value,'sandbox.products');
    assert.equal(view.get('total').textContent,tr('Loaded {0} rows',2)+tr(' · Preview limit: 100 rows'));
    assert.equal(view.get('phases').textContent,tr('Connection {0} ms · Preflight {1} ms · Execution {2} ms · Other {3} ms',3,4,2,3));
    view.sort();assert.deepEqual(view.values(),['-2.00','1.20']);
    view.get('filter').value='1.20';view.get('filter').oninput();
    assert.equal(view.get('total').textContent,tr('Matched {0} / ',1)+tr('Loaded {0} rows',2)+tr(' · Preview limit: 100 rows'));
    view.get('pin').onclick();assert.deepEqual({...view.sent.at(-1)},{type:'pin',runId:1});
    view.show([]);assert.equal(view.get('message').textContent,tr('No rows returned.'));
  }
});
test('owned runtime error strings have translations and non-catalog sources use canonical English',()=>{
  for(const name of ['extension','execution','jdbc','dms','query','ddl','embedded','sessions','migration']) {
    const source=fs.readFileSync(path.join(root,'src',name+'.cjs'),'utf8');
    assert.doesNotMatch(source,/\p{Script=Han}/u,name);
    for(const match of source.matchAll(/(?:Error|UnknownState|DmsStopped)\((?:tr\()?(['"])(.*?)\1/g)) {
      assert.ok(Object.hasOwn(messages,match[2]),name+': '+match[2]);
    }
  }
});
