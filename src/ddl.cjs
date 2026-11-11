'use strict';

const lex = /\/\*[\s\S]*?(?:\*\/|$)|--(?=\s|$)[^\n]*|#[^\n]*|'(?:''|\\[\s\S]|[^'\\])*(?:'|$)|"(?:""|\\[\s\S]|[^"\\])*(?:"|$)|`(?:``|[^`])*(?:`|$)|[\p{L}_$][\p{L}\p{N}_$]*|[^\s]/gu;
const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const clause = /^(?:SELECT|FROM|AS|WITH|WHERE|GROUP|ORDER|LIMIT|HAVING|QUALIFY|WINDOW|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|NATURAL|FULL|SEMI|ANTI|ON|USING|UNION|INTERSECT|EXCEPT|OFFSET|FETCH|PARTITION|TABLESAMPLE|FOR|LOCK|USE|FORCE|IGNORE|STRAIGHT_JOIN)$/i;
function name(token) {
  const text = token?.text;
  if (!text) return undefined;
  if (text.startsWith('`') && text.endsWith('`') && text.length > 2) return text.slice(1,-1).replaceAll('``','`');
  if (identifier.test(text) && !clause.test(text)) return text;
}

function relationAt(sql, offset, database) {
  const tokens = [];
  for (const match of sql.matchAll(lex)) {
    const text = match[0], start = match.index, end = start + text.length;
    if (text === ';') {
      if (offset <= start) break;
      tokens.length = 0;
      continue;
    }
    if (!/^(?:\/\*|--(?=\s|$)|#)/.test(text)) tokens.push({text,start,end});
  }
  const at = tokens.findIndex(t=>t.start <= offset && offset < t.end);
  if (at < 0 || !name(tokens[at])) return;
  const scopes = [], stack = [], close = new Map();
  for (const [i,t] of tokens.entries()) {
    scopes[i] = stack.at(-1) ?? -1;
    if (t.text === '(') stack.push(i);
    if (t.text === ')' && stack.length) close.set(stack.pop(),i);
  }
  const word = i => tokens[i]?.text.toUpperCase();
  function* visibleScopes(scope) {
    while (true) {
      yield scope;
      if (scope===-1) return;
      scope=scopes[scope];
    }
  }
  const ctes = [];
  for (let i=0;i<tokens.length;i++) {
    if (word(i)!=='WITH') continue;
    let j = word(i+1)==='RECURSIVE' ? i+2 : i+1;
    while (name(tokens[j])) {
      const as = word(j+1)==='(' ? (close.get(j+1) ?? j) + 1 : j+1;
      const end = close.get(as+1);
      if (word(as)!=='AS' || end === undefined) break;
      ctes.push({scope:scopes[i],name:name(tokens[j]).toLowerCase()});
      if (word(end+1)!==',') break;
      j=end+2;
    }
  }
  const selects = new Set(), refs = [];
  for (let i=0;i<tokens.length;i++) {
    const scope=scopes[i], w=word(i);
    if (w==='SELECT') selects.add(scope);
    const source=selects.has(scope) && ['FROM','JOIN','STRAIGHT_JOIN'].includes(w);
    let first=i+1;
    if (!source) {
      if (i===0 && w==='INSERT' && ['INTO','OVERWRITE'].includes(word(first))) {
        first++;
        if (word(first)==='TABLE') first++;
      } else if (i===1 && w==='TABLE' && word(0)==='CREATE') {
        if (word(first)==='IF' && word(first+1)==='NOT' && word(first+2)==='EXISTS') first+=3;
      } else continue;
    }
    const parts=[];
    let next=first;
    while (name(tokens[next])) {
      parts.push(name(tokens[next++]));
      if (word(next)!=='.') break;
      next++;
    }
    const fromFunction=source && word(next)==='(';
    const end=fromFunction ? (close.get(next) ?? tokens.length) + 1 : next;
    const aliasIndex=word(end)==='AS' ? end+1 : end;
    const alias=source ? name(tokens[aliasIndex]) : undefined;
    const table=parts.at(-1), schema=parts.length===2 ? parts[0] : undefined;
    const visible=[...visibleScopes(scope)];
    const physical=table && !fromFunction && parts.length<=2 && (!database || !schema || schema===database) && word(next-1)!=='.' &&
      (parts.length===2 || !ctes.some(cte=>cte.name===table.toLowerCase() && visible.includes(cte.scope)));
    refs.push({scope,tableIndex:table ? next-1 : -1,aliasIndex,alias,table,schema,physical});
  }
  const direct=refs.find(r=> at===r.tableIndex || (r.alias && at===r.aliasIndex));
  let qualified=[];
  if (word(at+1)==='.') for (const scope of visibleScopes(scopes[at])) {
    qualified=refs.filter(r=>r.scope===scope && (r.alias ?? r.table)?.toLowerCase()===name(tokens[at]).toLowerCase());
    if (qualified.length) break;
  }
  const ref=direct ?? (qualified.length===1 ? qualified[0] : undefined);
  if (ref?.physical) return {table:ref.table,schema:ref.schema,start:tokens[at].start,end:tokens[at].end};
}

function tableDdl(result) {
  const at=result.columns.findIndex(c=>/^create[ _]table$/i.test(c.name.trim()));
  const ddl=result.rows.length===1 && !result.truncated && at>=0 ? result.rows[0][at] : undefined;
  if (typeof ddl!=='string' || !/^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(ddl)) {
    throw Error('未收到普通表的建表定义。');
  }
  // External storage/connector properties and explicit secret-like fields are not previewed.
  if (/(?:^|[^a-z0-9])(?:password|passwd|authentication_string|access[_ .-]?token|access[_ .-]?key(?:[_ .-]?(?:id|secret))?|secret[_ .-]?key|private[_ .-]?key|api[_ .-]?key|credentials)(?=$|[^a-z0-9])/i.test(ddl) ||
      /\bENGINE\s*=\s*[`"']?(?!(?:OLAP|InnoDB|MyISAM|MEMORY|Aria|ARCHIVE|CSV|BLACKHOLE|NDB(?:CLUSTER)?|PERFORMANCE_SCHEMA)\b)\w+/i.test(ddl)) {
    throw Error('表定义包含外部引擎或疑似凭据，不显示预览。');
  }
  return ddl;
}
module.exports = {relationAt,tableDdl};
