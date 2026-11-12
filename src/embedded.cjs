'use strict';
const languages=['sql','python','markdown','java','javascript','javascriptreact','typescript','typescriptreact'];
const head=/^\s*(?:(?:--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(?:SELECT|WITH|SHOW|DESC|DESCRIBE|EXPLAIN|INSERT|CREATE)\b/i;
function regionAt(doc,offset) {
  const text=doc.getText(), language=doc.languageId;
  if(language==='sql') return {text,start:0,end:text.length};
  if(language==='markdown') {
    let open,position=0;
    for(const line of text.split(/(?<=\n)/)) {
      const m=/^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
      if(m) {
        if(!open) open={fence:m[1][0],length:m[1].length,sql:/^\s*(?:sql|mysql|postgresql|pgsql|doris)\s*$/i.test(m[2]),start:position+line.length};
        else if(m[1][0]===open.fence && m[1].length>=open.length && !m[2].trim()) {
          if(open.sql && open.start<=offset && offset<position) return {text:text.slice(open.start,position),start:open.start,end:position};
          open=undefined;
        }
      }
      position+=line.length;
    }
    return;
  }
  if(!languages.includes(language)) return;
  const javascript=/^(?:java|type)script/.test(language), parens=[];
  let previous='';
  for(let i=0;i<text.length;) {
    if((language==='python' && text[i]==='#') || (language!=='python' && text.slice(i,i+2)==='//')) {
      i=text.indexOf('\n',i);if(i<0) break;continue;
    }
    if(language!=='python' && text.slice(i,i+2)==='/*') {
      const end=text.indexOf('*/',i+2);if(end<0) break;i=end+2;continue;
    }
    const char=text[i];
    // shortcut: Regex/division uses token context; use a host parser if richer syntax is added.
    if(javascript && char==='/' && !(language.endsWith('react') && text[i-1]==='<') &&
      (!previous || (previous.length===1 && '([{:;,=!?&|+*%~^<>/-}'.includes(previous)) ||
      /^(?:return|throw|case|yield|await|delete|void|typeof|instanceof|in|of|else|do|new|default|extends)$/.test(previous))) {
      let end=i+1, group=false;
      for(;end<text.length && !/[\r\n]/.test(text[end]);end++) {
        if(text[end]==='\\') {end++;continue;}
        if(text[end]==='[') group=true;
        if(text[end]===']') group=false;
        if(text[end]==='/' && !group) break;
      }
      if(text[end]!=='/' || group) return;
      i=end+1;
      while(/[a-z]/i.test(text[i]??'')) i++;
      previous='literal';continue;
    }
    if(!['"', "'",'`'].includes(char)) {
      if(javascript && !/\s/.test(char)) {
        const word=/^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(text.slice(i));
        if(word) {previous=previous==='.' ? 'literal' : word[0];i+=word[0].length;continue;}
        if(['+','-'].includes(char) && text[i+1]===char) {previous='literal';i+=2;continue;}
        if(char==='(') parens.push(/^(?:if|while|for|with|switch|catch)$/.test(previous));
        previous=char===')' && parens.pop() ? ';' : char;
      }
      i++;continue;
    }
    const triple=text.slice(i,i+3)===char.repeat(3) && char!=='`';
    const delimiter=triple ? char.repeat(3) : char;
    const prefix=language==='python' ? /([a-zA-Z]+)$/.exec(text.slice(0,i))?.[1]??'' : '';
    const start=i+delimiter.length;
    let end=start;
    while(end<text.length) {
      if(text[end]==='\\') {end+=2;continue;}
      if(text.startsWith(delimiter,end)) break;
      end++;
    }
    if(end>=text.length) break;
    const sql=text.slice(start,end);
    const supported=(language==='python' && triple && !/[fb]/i.test(prefix)) ||
      (language==='java' && delimiter==='"""') || (/^(?:java|type)script/.test(language) && char==='`');
    if(supported && start<=offset && offset<end && head.test(sql) && !/\$\{|\{\{|\\/.test(sql)) return {text:sql,start,end};
    previous='literal';
    i=end+delimiter.length;
  }
}
function selectedSql(text) {
  if(/\$\{|\{\{|\{[a-zA-Z_]\w*(?:[.:][^{}]*)?\}/.test(text)) throw Error("Replace template variables with explicit values first; SQLQuay does not execute host code or evaluate expressions.");
  return text;
}
module.exports={languages,regionAt,selectedSql};
