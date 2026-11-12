'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {relationAt,tableDdl}=require('../src/ddl.cjs');
const target=(sql,mark)=>relationAt(sql,sql.indexOf(mark), 'dw')?.table;
test('recognizes real tables and aliases in SELECT, including qualified and quoted names',()=>{
  const sql='SELECT o.id FROM `dw`.`order-detail` AS o JOIN user_dim u ON u.id=o.id;';
  assert.equal(target(sql,'`order-detail`'),'order-detail');
  assert.equal(target(sql,'o.id'),'order-detail');
  assert.equal(target(sql,'user_dim'),'user_dim');
  assert.equal(target(sql,'u.id'),'user_dim');
  assert.equal(target('SELECT * FROM `with``tick`','`with'),'with`tick');
  assert.equal(target('SELECT 1; SELECT * FROM second;','second'),'second');
  assert.equal(target('SELECT * FROM /* no-op */ actual','actual'),'actual');
});
test('warehouse SQL targets can be recognized without a default database',()=>{
  for (const sql of ['INSERT INTO `dw`.products (id) SELECT 1','INSERT OVERWRITE TABLE dw.products SELECT 1',
    'CREATE TABLE IF NOT EXISTS dw.products (id BIGINT)']) {
    const ref=relationAt(sql,sql.indexOf('products'));
    assert.equal(ref.table,'products');
    assert.equal(ref.schema,'dw');
  }
  assert.equal(target('CREATE TABLE IF NOT EXISTS other.products (id BIGINT)','products'),undefined);
});
test('does not point at a CTE, other schema, comments, strings or non-table tokens',()=>{
  for (const [sql,mark] of [
    ['WITH x(n) AS (SELECT id FROM actual) SELECT * FROM x','x(n)'],
    ['WITH tmp AS (SELECT 1) SELECT * FROM tmp AS alias','alias'],
    ['SELECT x.id FROM other.orders x','x.id'],
    ['SELECT * FROM x.y.z','z'],
    ['SELECT * FROM dw.','dw.'],
    ['SELECT col FROM orders','col'],
    ["SELECT 'FROM fake' FROM actual",'fake'],
    ["SELECT 'unfinished FROM fake",'fake'],
    ['SELECT 1 -- FROM fake','fake'],
    ['SELECT EXTRACT(YEAR FROM started) FROM actual','started'],
    ['SELECT * FROM JSON_TABLE(doc, x) AS derived','derived'],
    ['SELECT q.id FROM (SELECT 1) q','q.id'],
  ]) assert.equal(target(sql,mark),undefined,sql);
  assert.equal(target('WITH first AS (SELECT 1), cte AS (SELECT id FROM actual) SELECT cte.id FROM cte','actual'),'actual');
});
test('uses the named DDL column and refuses partial or sensitive results',()=>{
  const grid=(ddl,truncated=false)=>({columns:[{name:'Table'},{name:'Create Table'}],rows:[['t',ddl]],truncated});
  const valid='CREATE TABLE t (id BIGINT) ENGINE=OLAP';
  assert.equal(tableDdl(grid(valid)),valid);
  assert.throws(()=>tableDdl(grid(valid,true)),/No physical table/);
  for(const ddl of ["CREATE TABLE t (id INT) ENGINE=JDBC", "CREATE TABLE t (id INT) PROPERTIES ('jdbc_password'='fixture')","CREATE EXTERNAL TABLE t (id INT)"]) {
    assert.throws(()=>tableDdl(grid(ddl)), /cannot be previewed|No physical table/);
  }
});
test('function parentheses and correlated subqueries resolve visible aliases, with nearest shadowing',()=>{
  for(const [sql,mark,expected] of [
    ['SELECT SUM(p.price) FROM products p','p.price','products'],
    ['SELECT COALESCE(ROUND(p.price,2),0) FROM products p','p.price','products'],
    ['SELECT p.id FROM products p WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id=p.id)','p.id)','products'],
    ['SELECT p.id FROM products p WHERE EXISTS (SELECT SUM(p.id) FROM orders p)','p.id)','orders'],
    ['SELECT p.id FROM products p WHERE EXISTS (SELECT p.id FROM (SELECT 1) p)','p.id FROM (',undefined],
    ['SELECT p.id FROM products p WHERE EXISTS (SELECT p.id FROM other.orders p)','p.id FROM other',undefined],
  ])assert.equal(target(sql,mark),expected,sql);
});
test('nested CTE names stay in their query block and do not hide outer physical tables',()=>{
  const sql='SELECT * FROM orders WHERE id IN (WITH orders AS (SELECT id FROM products) SELECT id FROM orders)';
  assert.equal(target(sql,'orders WHERE'),'orders');
  assert.equal(relationAt(sql,sql.lastIndexOf('orders'),'dw'),undefined);
  assert.equal(target('WITH orders AS (SELECT id FROM products) SELECT * FROM (SELECT * FROM orders) q','orders) q'),undefined);
  const siblings='SELECT * FROM (WITH orders AS (SELECT 1) SELECT * FROM orders) a JOIN (SELECT * FROM orders) b';
  assert.equal(relationAt(siblings,siblings.lastIndexOf('orders'),'dw')?.table,'orders');
});
