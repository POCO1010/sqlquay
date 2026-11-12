'use strict';
class Sessions {
  constructor(limit=20){this.limit=limit;this.entries=[];}
  add(entry) {
    if(this.entries.length>=this.limit) {
      const index=this.entries.findIndex(e=>!e.panel && !e.pinned && e.view.state!=='running');
      if(index<0) throw Error("20 open or pinned results are retained. Close an unpinned result or clear closed session history before running another query.");
      this.entries.splice(index,1);
    }
    this.entries.push(entry);return entry;
  }
  clearClosed(){this.entries=this.entries.filter(e=>e.panel || e.pinned || e.view.state==='running');}
}
function copyCells(result,selection) {
  const {rows,from,to}=selection??{};
  if(!Array.isArray(result?.rows) || !Array.isArray(rows) || !rows.length || rows.length>result.rows.length ||
    new Set(rows).size!==rows.length || rows.some(i=>!Number.isInteger(i) || i<0 || i>=result.rows.length) ||
    !Number.isInteger(from) || !Number.isInteger(to) || from<0 || from>to || to>=result.columns.length) return;
  const values=rows.map(i=>result.rows[i].slice(from,to+1).map(v=>v===null?'NULL':v));
  if(values.length===1 && from===to) return values[0][0];
  const tsv=value=>/[\t\r\n"]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
  return values.map(row=>row.map(tsv).join('\t')).join('\n');
}
module.exports={Sessions,copyCells};
