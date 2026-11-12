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
module.exports={Sessions};
