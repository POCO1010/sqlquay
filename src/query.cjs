'use strict';
const DEMO = Object.freeze({ id: 'demo', name: 'Local Demo', group: '', database: 'sandbox', engine: 'demo' });
const products = [['1','Trail mug','Accessories','12.50'],['2','Studio lamp','Home','49.90'],['3','Pocket notebook','Stationery','6.00'],['4','Field tote','Accessories','23.00'],['5','Desk tray','Home',null],['6','Grid pad','Stationery','8.90']];
const fields = ['id','name','category','price'];
const result = (names, rows, truncated = false) => ({columns: names.map(name => ({name, type: ''})), rows, truncated});
const sqlTokens = /\/\*[\s\S]*?(?:\*\/|$)|--(?=\s|$)[^\n]*|#[^\n]*|'(?:''|\\[\s\S]|[^'\\])*'|"(?:""|\\[\s\S]|[^"\\])*"|`(?:``|[^`])*`|;/g;
function slices(text) {
  const segments = []; let start = 0;
  for (const m of text.matchAll(sqlTokens)) if (m[0] === ';') { segments.push([start,m.index + 1]); start = m.index + 1; }
  segments.push([start,text.length]);
  return segments;
}
const leadingComments = /^(?:\s+|--(?=\s|$)[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;
function pickSql(text, cursor, selection) {
  if (selection?.trim()) return selection.trim();
  const ranges = slices(text).filter(([a,b]) => text.slice(a,b).replace(leadingComments,'').replace(/;$/,'').trim());
  const range = ranges.find(([, b]) => cursor < b) ?? ranges.at(-1);
  return range ? text.slice(...range).trim() : '';
}
function readonly(sql) {
  if (typeof sql !== 'string' || sql.length > 48_000 || /\/\*\s*(?:M)?!/i.test(sql)) throw Error('Expected one read-only SQL statement (48 KB maximum).');
  const units = slices(sql).map(([a,b]) => sql.slice(a,b).replace(leadingComments,'').replace(/;$/,'').trim()).filter(Boolean);
  if (units.length !== 1 || !/^(SELECT|WITH|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i.test(units[0])) throw Error('Run one read-only statement at a time.');
  return units[0];
}
function dmsReadonly(sql) {
  const statement = readonly(sql);
  // Keep quoted names visible for credential checks; ignore values and comments.
  const identifiers = statement.replace(sqlTokens, token => token[0] === '`' ? token.slice(1,-1) : ' ');
  const code = statement.replace(sqlTokens, ' ');
  const tableMetadata = /^SHOW\s+(?:(?:FULL\s+)?(?:TABLES|COLUMNS|FIELDS)|INDEX(?:ES)?|KEYS|CREATE\s+(?:TABLE|VIEW))\b/i;
  if (/^SHOW\b/i.test(code) && !tableMetadata.test(code)) throw Error('SHOW is limited to table, column and index metadata.');
  if (/\b(?:authentication_string|access_token|api_key|secret_key|private_key|access_key_secret|password)\b/i.test(identifiers)) throw Error('Credential fields are not allowed.');
  if (/\/\*\+/.test(sql) || /\b(?:FOR|LOCK|INTO|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|SLEEP|BENCHMARK|LOAD_FILE)\b/i.test(code) ||
      (/^EXPLAIN\b/i.test(code) && /\bANALYZE\b/i.test(code))) throw Error('Optimizer hints, locking, INTO and statements with side effects are not allowed.');
  return statement;
}
function demoQuery(sql) {
  const statement = readonly(sql);
  if (/^show\s+create\s+table\s+`sandbox`\.`products`$/i.test(statement)) {
    return result(['Table','Create Table'], [['products','CREATE TABLE products (\n  id INTEGER,\n  name TEXT,\n  category TEXT,\n  price DECIMAL\n);']]);
  }
  if (/^show\s+tables$/i.test(statement)) return result(['Tables_in_sandbox'], [['products']]);
  if (/^desc(?:ribe)?\s+[`]?products[`]?$/i.test(statement)) return result(['Field','Type'], [['id','INTEGER'],['name','TEXT'],['category','TEXT'],['price','DECIMAL']]);
  const probe = /^select\s+1(?:\s+as\s+([a-z_]\w*))?$/i.exec(statement);
  if (probe) return result([probe[1] ?? '1'], [['1']]);
  const match = /^select\s+([a-z_,\s]+?)\s+from\s+products(?:\s+where\s+id\s*=\s*(\d+))?(?:\s+limit\s+(\d+))?$/i.exec(statement);
  if (!match) throw Error('Local Demo supports SELECT 1 AS probe, or a SELECT of named columns from products (optional WHERE id = … and LIMIT). Use a JDBC or DMS connection for other SQL.');
  const selected = match[1].split(',').map(s => s.trim().toLowerCase());
  if (selected.some(n => !fields.includes(n))) throw Error('Unknown demo column. Use id, name, category or price.');
  return result(selected, products.filter(row => !match[2] || Number(row[0]) === Number(match[2])).slice(0, match[3] === undefined ? products.length : Number(match[3])).map(row => selected.map(n => row[fields.indexOf(n)])));
}
function quoteTable(name) {
  if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name)) throw Error('Invalid table name.');
  return '`' + name.replaceAll('`','``') + '`';
}
module.exports = { DEMO, demoQuery, pickSql, readonly, dmsReadonly, quoteTable };
