'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {regionAt,selectedSql}=require('../src/embedded.cjs');
const {suggestions,ddlColumns}=require('../src/completion.cjs');
const {Sessions}=require('../src/sessions.cjs');
const doc=(text,languageId)=>({languageId,getText:()=>text});
test('static SQL blocks preserve source offsets in common host languages',()=>{
  for(const [language,code] of [['python','q = """SELECT id FROM products;"""'],
    ['java','String q = """\nSELECT id FROM products;\n""";'],
    ['javascript','const q = `SELECT id FROM products;`;'],['typescript','const q: string = `SELECT id FROM products;`;'],
    ['markdown','before\n```sql\nSELECT id FROM products;\n```\nafter']]) {
    const offset=code.indexOf('products'),part=regionAt(doc(code,language),offset);
    assert.ok(part,language);
    assert.equal(part.text.indexOf('products')+part.start,offset);
    assert.equal(regionAt(doc(code,language),0),undefined);
  }
});
test('comments, other fences, dynamic templates, escaped and unfinished strings stay inactive',()=>{
  for(const [language,code] of [['python','# q = """SELECT id FROM products"""'],['python','q=f"""SELECT id FROM products WHERE id={id}"""'],
    ['java','// String q = """SELECT id FROM products"""'],['javascript','const q = `SELECT id FROM products WHERE id=${id}`;'],
    ['python','q="""SELECT id FROM products\\n"""'],['python','q="""SELECT id FROM products'],
    ['markdown','```python\n# ```sql\nSELECT id FROM products\n```']]) {
    assert.equal(regionAt(doc(code,language),code.indexOf('products')),undefined,code);
  }
  assert.throws(()=>selectedSql('SELECT id FROM ${table}'),/template variables/);
  assert.equal(selectedSql('SELECT 1'),'SELECT 1');
});
test('table and alias field suggestions use cached metadata only',()=>{
  const columns=new Map([['products',[['id','BIGINT'],['price','DECIMAL']]]]);
  assert.equal(suggestions('SELECT * FROM pro',17,'sandbox',['products'],columns)[0].name,'products');
  const sql='SELECT p.pr FROM products p';
  assert.deepEqual(suggestions(sql,11,'sandbox',['products'],columns).map(x=>x.name),['price']);
  assert.deepEqual(suggestions('SELECT x. FROM products p',9,'sandbox',['products'],columns),[]);
  assert.deepEqual(suggestions('-- FROM pro',11,'sandbox',['products'],columns),[]);
  assert.deepEqual(suggestions("SELECT 'FROM pro",16,'sandbox',['products'],columns),[]);
  assert.deepEqual(suggestions('SELECT p. FROM other.products p',9,'sandbox',['products'],columns),[]);
  assert.deepEqual(ddlColumns('CREATE TABLE t (\n `id` BIGINT, price DECIMAL(10,2), PRIMARY KEY(id), note VARCHAR(20) COMMENT \'a,b\')'),
    [['id','BIGINT'],['price','DECIMAL(10,2)'],['note','VARCHAR(20)']]);
});
test('open or pinned results are not evicted, closed history is bounded and clearable',()=>{
  const store=new Sessions(2),entry=id=>({view:{id,state:'done'}});
  const one=store.add(entry(1));one.panel={};
  const two=store.add(entry(2));two.pinned=true;
  assert.throws(()=>store.add(entry(3)),/retained/);
  two.pinned=false;store.add(entry(3));
  assert.deepEqual(store.entries.map(e=>e.view.id),[1,3]);
  store.clearClosed();
  assert.deepEqual(store.entries,[one]);
});
test('function and schema-named aliases complete fields before considering schema table names',()=>{
  const metadata=new Map([['products',[['price','DECIMAL']]]]);
  for(const sql of ['SELECT SUM(p.pr) FROM products p','SELECT sandbox.pr FROM products sandbox','SELECT `sandbox`.pr FROM products `sandbox`']) {
    assert.deepEqual(suggestions(sql,sql.indexOf('.pr')+3,'sandbox',['products'],metadata).map(i=>i.name),['price']);
  }
  assert.deepEqual(suggestions('SELECT * FROM sandbox.pro',25,'sandbox',['products'],metadata).map(i=>i.name),['products']);
  const join='SELECT sandbox.price FROM products sandbox JOIN sandbox.pro';
  assert.deepEqual(suggestions(join,join.length,'sandbox',['products'],metadata).map(i=>i.name),['products']);
  for(const sql of ['SELECT sandbox.pr FROM (SELECT 1) sandbox','SELECT sandbox.pr FROM other.products sandbox']) {
    assert.deepEqual(suggestions(sql,sql.indexOf('.pr')+3,'sandbox',['products'],metadata),[]);
  }
});
test('JS and TS regex literals stay inactive, including escapes, character classes and expression contexts',()=>{
  const literal='/`SELECT id FROM products`/';
  for(const language of ['javascript','javascriptreact','typescript','typescriptreact']) {
    for(const sql of [
      'const pattern = '+literal+';',
      'export default '+literal+';',
      'const pattern = new '+literal+'.constructor();',
      'class Pattern extends '+literal+'.constructor {}',
      'const pattern = /* comment */ '+literal+';',
      'function pattern(){return '+literal+';}',
      'const patterns = ['+literal+'];',
      'if(ok) '+literal+'.test(value);',
      'if(ok) {} '+literal+'.test(value);',
      'const pattern = /[`]SELECT id FROM products[`]/g;',
      'const pattern = /\\/`SELECT id FROM products`/;',
    ])assert.equal(regionAt(doc(sql,language),sql.indexOf('products')),undefined,language+': '+sql);
  }
});
test('division and prior regex literals do not suppress a later static SQL template',()=>{
  for(const prefix of ['const ratio=10/2;','const ratio=total/count;','const p=/[\\/]/;','if(ok) /test/.test(value);',
    'const ratio=count++/2;','const ratio=count--/2;','const ratio=object.return/2;']) {
    const sql=prefix+' const q=`SELECT id FROM products`;';
    assert.equal(regionAt(doc(sql,'javascript'),sql.indexOf('products'))?.text,'SELECT id FROM products',sql);
  }
  for(const language of ['javascriptreact','typescriptreact']) {
    const sql='const View = () => <div>ok</div>; const q=`SELECT id FROM products`;';
    assert.equal(regionAt(doc(sql,language),sql.indexOf('products'))?.text,'SELECT id FROM products',language);
  }
});
