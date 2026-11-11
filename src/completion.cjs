'use strict';
const {relationAt}=require('./ddl.cjs');
const {quoteTable}=require('./query.cjs');
const insert=name=>/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(name) ? name : quoteTable(name);
function suggestions(sql,offset,database,tables,columns) {
  for(const token of sql.matchAll(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|\\.|[^'\\])*(?:'|$)|"(?:""|\\.|[^"\\])*(?:"|$)/g)) {
    if(token.index<offset && offset<=token.index+token[0].length) return [];
  }
  const m=/(?:(`(?:``|[^`])+`|[\p{L}_][\p{L}\p{N}_$]*)\s*\.\s*)?([\p{L}\p{N}_$]*)$/u.exec(sql.slice(0,offset));
  if(!m) return [];
  const prefix=m[2], start=offset-prefix.length;
  const tableContext=/\b(?:FROM|JOIN|TABLE|INTO|DESCRIBE|DESC)\s+$/i.test(sql.slice(0,m.index));
  let values=tables.map(name=>({name,kind:'table'}));
  if(m[1]) {
    const qualifier=m[1].replace(/^`|`$/g,'').replaceAll('``','`');
    if(tableContext) {
      if(qualifier!==database) return [];
    } else {
      const ref=relationAt(sql,m.index,database);
      if(!ref) return [];
      values=(columns.get(ref.table)??[]).map(([name,type])=>({name,type,kind:'field'}));
    }
  } else if(!tableContext) return [];
  return values.filter(v=>v.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
    .map(v=>({...v,start,end:offset,insert:insert(v.name)}));
}
function ddlColumns(ddl) {
  const start=ddl.indexOf('(');
  if(start<0) return [];
  let depth=1, begin=start+1, quote='', segments=[];
  for(let i=begin;i<ddl.length;i++) {
    const c=ddl[i];
    if(quote) {
      if(c==='\\') i++;
      else if(c===quote) {if(ddl[i+1]===quote)i++;else quote='';}
      continue;
    }
    if(['"', "'",'`'].includes(c)){quote=c;continue;}
    if(c==='(')depth++;
    if(c===')')depth--;
    if((c===',' && depth===1) || depth===0) {segments.push(ddl.slice(begin,i));begin=i+1;}
    if(depth===0) break;
  }
  return segments.flatMap(segment=>{
    const m=/^\s*(?:`((?:``|[^`])+)`|([\p{L}_][\p{L}\p{N}_$]*))\s+([a-zA-Z]+(?:\s*\([^)]*\))?)/u.exec(segment);
    if(!m || (!m[1] && /^(?:PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)$/i.test(m[2]))) return [];
    return [[(m[1]??m[2]).replaceAll('``','`'),m[3]]];
  });
}
module.exports={suggestions,ddlColumns};
