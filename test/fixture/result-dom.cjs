'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element {
  constructor(){this.children=[];this.value='';this.attrs={};this.style={};const classes=new Set();this.classList={add:k=>classes.add(k),toggle:(k,on)=>on?classes.add(k):classes.delete(k),contains:k=>classes.has(k)};}
  set textContent(value){this.children=[String(value)];}
  get textContent(){return this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(key,value){this.attrs[key]=value;}
  getBoundingClientRect(){return {width:88};}
  setPointerCapture(){}
  releasePointerCapture(){}
  get rows(){return this.children;}
  get cells(){return this.children;}
  get firstElementChild(){return this.children.find(c=>c instanceof Element);}
  focus(){}
}
module.exports=function createResult(script=path.join(__dirname,'../../media/workbench.js'),language='zh-cn') {
  const ids=new Map(),head=new Element(),body=new Element(),events={},sent=[];
  const document={documentElement:{lang:language},body:{dataset:{view:'result'}},
    getElementById(id){if(!ids.has(id)) ids.set(id,new Element());return ids.get(id);},
    querySelector:s=>s==='thead'?head:body,createElement:()=>new Element()};
  const get=id=>document.getElementById(id);
  get('size').value='100';
  const context=vm.createContext({document,window:{addEventListener:(name,fn)=>events[name]=fn},
    acquireVsCodeApi:()=>({postMessage:m=>sent.push(m)}),Intl});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../media/i18n.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(script,'utf8'),context);
  let id=0;
  return {get,sent,cell:(row,col)=>body.rows[row].cells[col+1],resize:col=>head.rows[0].cells[col+1].children[1],
    receive(data){if(Number.isInteger(data.id))id=Math.max(id,data.id);events.message({data});},
    show(rows,type='',mode='DATA',truncated=false){
      events.message({data:{id:++id,mode,state:'done',sql:'Offline fixture',target:'fixture',
        result:{columns:[{name:'value',type}],rows:rows.map(value=>[value]),truncated}}});
    },
    sort(){head.rows[0].cells[1].firstElementChild.onclick();},
    values:()=>body.rows.map(row=>row.cells[1].textContent)
  };
};
