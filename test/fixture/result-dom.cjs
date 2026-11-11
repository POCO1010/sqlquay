'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element {
  constructor(){this.children=[];this.value='';this.classList={add(){},toggle(){}};}
  set textContent(value){this.children=[String(value)];}
  get textContent(){return this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(){}
  get rows(){return this.children;}
  get cells(){return this.children;}
  get firstElementChild(){return this.children.find(c=>c instanceof Element);}
  focus(){}
}
module.exports=function createResult(script=path.join(__dirname,'../../media/workbench.js')) {
  const ids=new Map(),head=new Element(),body=new Element(),events={},sent=[];
  const document={body:{dataset:{view:'result'}},
    getElementById(id){if(!ids.has(id)) ids.set(id,new Element());return ids.get(id);},
    querySelector:s=>s==='thead'?head:body,createElement:()=>new Element()};
  const get=id=>document.getElementById(id);
  get('size').value='100';
  vm.runInNewContext(fs.readFileSync(script,'utf8'),{document,window:{addEventListener:(name,fn)=>events[name]=fn},
    acquireVsCodeApi:()=>({postMessage:m=>sent.push(m)}),Intl});
  let id=0;
  return {get,sent,
    receive(data){events.message({data});},
    show(rows,type='',mode='DATA',truncated=false){
      events.message({data:{id:++id,mode,state:'done',sql:'Offline fixture',target:'fixture',
        result:{columns:[{name:'value',type}],rows:rows.map(value=>[value]),truncated}}});
    },
    sort(){head.rows[0].cells[1].firstElementChild.onclick();},
    values:()=>body.rows.map(row=>row.cells[1].textContent)
  };
};
