'use strict';
class Sessions {
  constructor(limit=20){this.limit=limit;this.entries=[];}
  add(entry) {
    if(this.entries.length>=this.limit) {
      const index=this.entries.findIndex(e=>!e.panel && !e.pinned && e.view.state!=='running');
      if(index<0) throw Error('已保留 20 份打开或固定的结果。请关闭未固定结果，或清除已关闭的会话历史后再运行。');
      this.entries.splice(index,1);
    }
    this.entries.push(entry);return entry;
  }
  clearClosed(){this.entries=this.entries.filter(e=>e.panel || e.pinned || e.view.state==='running');}
}
module.exports={Sessions};
