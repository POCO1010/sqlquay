'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const tr=window.SQLQuayI18n.translator(document.documentElement.lang);
  const $ = id => document.getElementById(id);
  const phaseNames={prepare:"Preparation",waiting:"Query lock",connect:"Connection",resolve:"Target verification",preflight:"Read-only preflight",execute:"SQL execution",cleanup:"Session cleanup"};
  const phaseName=phase=>tr(phaseNames[phase]??'Preparation');
  if (document.body.dataset.view === 'connect') {
    const form = $('connection'), feedback = $('feedback'),databaseInput=form.elements.keyword;
    let engine='mysql',editing=false,profiles=[],databases=[],searchedKeyword='';
    const selectedDatabases=new Map(),savedDatabases=new Map(),checks=new Map(),instances=new Map();
    let instancePage=1,databasePage=1,activeInstance;
    const environmentLabel=env=>tr({product:'Production',test:'Test',dev:'Development',pre:'Pre-release',sit:'SIT',uat:'UAT',pet:'Load test',stag:'Staging'}[env]??env);
    const engineLabel=engine=>({mysql:'MySQL',rds:'RDS MySQL',polardb:'PolarDB MySQL',drds:'PolarDB-X / DRDS',doris:'Doris',selectdb:'SelectDB',ots:'Tablestore'}[engine]??engine);
    const databaseLabel=row=>[row.database,row.instanceName,row.environment?environmentLabel(row.environment):'',row.engine?engineLabel(row.engine):'','#'+row.databaseId].filter(Boolean).join(' · ');
    const metadataValues=()=>({region:form.elements.region.value,accessKeyId:form.elements.accessKeyId.value,accessKeySecret:form.elements.accessKeySecret.value});
    const databaseKey=row=>JSON.stringify([row.databaseId,row.database]);
    const method=()=>form.elements.channel.value,authMode=()=>form.elements.authMode.value;
    const loadProfiles=()=>{$('dms-auth-status').textContent=tr('Reading local CLI profiles…');vscode.postMessage({type:'loadDmsProfiles'});};
    const syncSelection=()=>{
      $('dms-selected').hidden=!selectedDatabases.size && !editing;
      $('dms-selection-count').textContent=editing && !selectedDatabases.size ? tr('No databases selected. Save to keep this connection and its authentication.') : tr('Selected databases: {0}. Save when ready.',selectedDatabases.size);
      const removed=[...savedDatabases.keys()].filter(key=>!selectedDatabases.has(key)).length;
      $('dms-removal-status').hidden=!removed;
      $('dms-removal-status').textContent=removed ? tr('Saving removes {0} databases from this connection. Files bound to them will need another connection.',removed) : '';
      $('dms-selected-databases').replaceChildren(...[...selectedDatabases].map(([key,row])=>{
        const item=document.createElement('li'),label=document.createElement('span');label.textContent=row.label;item.append(label);
        if(savedDatabases.has(key)) {const note=document.createElement('span');note.className='subdued';note.textContent=tr('Already added');item.append(note);}
        const remove=document.createElement('button');remove.type='button';remove.className='plain';remove.textContent='×';
        remove.setAttribute('aria-label',tr(savedDatabases.has(key)?'Remove {0} from this connection':'Remove {0} from selection',row.label));
        remove.onclick=()=>{selectedDatabases.delete(key);syncSelection();databaseInput.focus();};item.append(remove);
        return item;
      }));
      for(const [key,check] of checks) check.checked=selectedDatabases.has(key);
      const available=databases;
      const count=available.filter(row=>selectedDatabases.has(databaseKey(row))).length;
      $('dms-select-all').disabled=!available.length;
      $('dms-select-all').checked=!!available.length && count===available.length;
      $('dms-select-all').indeterminate=count>0 && count<available.length;
      if(selectedDatabases.size && !form.elements.name.value.trim()) form.elements.name.value='DMS';
    };
    const clearResults=()=>{
      databases=[];checks.clear();$('dms-database-options').replaceChildren();$('dms-search-results').hidden=true;
      $('dms-search-status').textContent=tr('Search for databases and select one or more. Search again to add others.');
    };
    const selectDatabase=(row,checked)=>{
      const key=databaseKey(row);
      if(checked) selectedDatabases.set(key,{...row,keyword:row.keyword??searchedKeyword});
      else selectedDatabases.delete(key);
    };
    $('dms-select-all').onchange=()=>{
      for(const row of databases) selectDatabase(row,$('dms-select-all').checked);
      syncSelection();
    };
    databaseInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('dms-search').click();}};
    const working=busy=>{
      const dms=method()==='dms',ak=authMode()==='accessKey';
      $('methods').disabled=busy||editing;
      $('jdbc-fields').hidden=dms;$('jdbc-fields').disabled=busy||dms;
      $('dms-fields').hidden=!dms;$('dms-fields').disabled=busy||!dms;
      form.elements.authMode.disabled=busy||editing;
      $('dms-ak-fields').hidden=!ak;$('dms-ak-fields').disabled=busy||!dms||!ak;
      $('dms-profile-fields').hidden=ak;$('dms-profile-fields').disabled=busy||!dms||ak;
      $('dms-database-picker').hidden=!ak;$('dms-database-picker').disabled=busy||!dms||!ak;
      $('dms-search').hidden=!ak;$('dms-search-status').hidden=!ak;$('dms-search').disabled=busy;
      $('tls-warning').hidden=dms||form.elements.sslMode.value!=='DISABLED';
      const connect=form.querySelector?.('button[value="connect"]');
      if(connect) connect.textContent=dms && ak?tr('Save and open'):'＋ '+tr('Connect');
      for(const control of form.querySelectorAll('[name="name"],[name="group"],button[type="submit"]')) control.disabled=busy;
    };
    $('dms-profiles').onclick=loadProfiles;
    $('dms-auth').onclick=()=>vscode.postMessage({type:'configureDms'});
    $('dms-ak-guide').onclick=()=>vscode.postMessage({type:'openAccessKeyGuide'});
    const clearInstances=()=>{$('dms-database-picker').append($('dms-search-results'));instances.clear();activeInstance=undefined;$('dms-instances').replaceChildren();$('dms-instance-results').hidden=true;};
    const browseInstances=page=>{
      searchedKeyword=databaseInput.value.trim();
      const values={...metadataValues(),keyword:databaseInput.value,environment:$('dms-environment-filter').value||'',engine:$('dms-engine-filter').value||'',page};
      if(!values.region.trim()){feedback.textContent=tr('Enter a DMS region.');return;}
      if(page===1) {clearResults();clearInstances();}
      feedback.textContent=tr('Loading instances…');working(true);vscode.postMessage({type:'listDmsInstances',values});
    };
    const browseDatabases=(instance,page=1)=>{
      activeInstance=instance;
      if(page===1) clearResults();
      instance.element?.append($('dms-search-results'));
      $('dms-search-results').hidden=false;
      $('dms-instance-title').textContent=instance.instanceName+' · '+environmentLabel(instance.environment)+' · '+engineLabel(instance.engine);
      $('dms-capability').hidden=instance.engine!=='ots';
      feedback.textContent=tr('Searching databases…');working(true);
      vscode.postMessage({type:'listDmsDatabases',values:{...metadataValues(),instanceId:instance.instanceId,keyword:$('dms-database-filter').value||'',page}});
    };
    $('dms-search').onclick=()=>browseInstances(1);
    $('dms-more-instances').onclick=()=>browseInstances(instancePage+1);
    $('dms-more-databases').onclick=()=>{if(activeInstance) browseDatabases(activeInstance,databasePage+1);};
    $('dms-filter-databases').onclick=()=>{if(activeInstance) browseDatabases(activeInstance);};
    $('dms-database-filter').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('dms-filter-databases').click();}};
    for(const id of ['dms-environment-filter','dms-engine-filter']) $(id).onchange=()=>{clearResults();clearInstances();};
    form.addEventListener('input',e=>{
      if(authMode()!=='accessKey') return;
      if(e.target.name==='keyword') {clearResults();clearInstances();}
      if(['accessKeyId','accessKeySecret','region'].includes(e.target.name)) {
        clearResults();clearInstances();for(const key of selectedDatabases.keys()) if(!savedDatabases.has(key)) selectedDatabases.delete(key);syncSelection();
      }
    });
    form.addEventListener('change',e=>{
      if(e.target.name==='channel' || e.target.name==='authMode') {
        if(e.target.name==='authMode') {selectedDatabases.clear();savedDatabases.clear();clearResults();syncSelection();}
        feedback.textContent='';working(false);
        if(method()==='dms' && authMode()==='profile') loadProfiles();
      }
      if(e.target.name==='profile') {
        const selected=profiles.find(p=>p.name===form.elements.profile.value);
        form.elements.region.value=selected?.region??'';
        $('dms-auth-status').textContent=selected?.valid ? tr('Authentication uses the selected local CLI profile.') : tr('Configure or refresh this profile in your terminal, then refresh the list.');
      }
      if(e.target.name==='sslMode') working(false);
      if(e.target.name!=='engine') return;
      const oldDefault=engine==='doris'?'9030':'3306';engine=e.target.value;
      if(form.elements.port.value===oldDefault) form.elements.port.value=engine==='doris'?'9030':'3306';
    });
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const values={...Object.fromEntries(new FormData(form)),channel:method()};
      if(values.channel==='dms') {
        values.authMode=authMode();
        if(values.authMode==='accessKey') {
          if(!selectedDatabases.size && !editing){feedback.textContent=tr('Choose one or more databases for this AccessKey connection.');return;}
          values.databases=[...selectedDatabases.values()].map(({keyword,database,databaseId,instanceId,instanceName,engine,environment})=>({keyword,database,databaseId,...(instanceId?{instanceId,instanceName,engine,environment}:{})}));
          const removed=[...savedDatabases].filter(([key])=>!selectedDatabases.has(key)).map(([,row])=>({database:row.database,databaseId:row.databaseId}));
          if(removed.length) values.removedDatabases=removed;
          delete values.keyword;
        } else {
          values.database=form.elements.schema.value;values.databaseId=form.elements.databaseId.value;
          if(form.elements.dmsEngine.value) values.engine=form.elements.dmsEngine.value;
          delete values.dmsEngine;
          values.keyword=form.elements.searchHint.value.trim()||values.database;
        }
        delete values.schema;delete values.searchHint;
      } else {values.environment=values.jdbcEnvironment;delete values.jdbcEnvironment;}
      const type=e.submitter?.value==='save'?'save':'connect';
      feedback.textContent=type==='connect' && !(values.channel==='dms' && values.authMode==='accessKey')?tr('Checking connection…'):tr('Saving…');working(true);
      vscode.postMessage({type,values});form.elements.password.value='';
    });
    $('close').onclick=()=>vscode.postMessage({type:'close'});
    window.addEventListener('message',({data:m})=>{
      if(m?.type==='configure' && m.connection) {
        const {channel,name,group,database,engine:kind,host,port,keyword,databaseId,sslMode,profile,region,environment,authMode:auth}=m.connection;
        $('heading').textContent=m.adding?tr('Add databases'):tr('Edit connection');editing=true;form.elements.channel.value=channel;
        const values=channel==='dms'?{name,group,schema:database,keyword:'',searchHint:keyword===database?'':keyword,databaseId,region:region??'cn-hangzhou',authMode:auth??'profile',environment:environment??'product',dmsEngine:kind??''}:{name,group,database,engine:kind,host,port,sslMode:sslMode??'VERIFY_IDENTITY',jdbcEnvironment:environment??''};
        for(const [key,value] of Object.entries(values)) form.elements[key].value=value??'';
        if(channel==='jdbc') {form.elements.user.required=false;form.elements.user.placeholder=tr('Leave blank to keep credentials');engine=kind;}
        if(channel==='dms' && authMode()==='profile') {$('dms-search-options').open=keyword!==database;form.elements.profile.add(new Option(profile??'dms-prod',profile??'dms-prod',true,true));loadProfiles();}
        if(channel==='dms' && authMode()==='accessKey') {
          for(const row of m.connection.databases??[m.connection]) {
            const entry={...row,label:databaseLabel(row)};
            savedDatabases.set(databaseKey(entry),entry);selectedDatabases.set(databaseKey(entry),{...entry});
          }
          syncSelection();
          for(const key of ['accessKeyId','accessKeySecret']) form.elements[key].placeholder=tr('Leave blank to keep credentials');
        }
        working(false);
      }
      if(m?.type==='dmsProfiles') {
        const selected=form.elements.profile.value;profiles=Array.isArray(m.profiles)?m.profiles:[];
        form.elements.profile.replaceChildren(new Option(tr('Choose a configured profile'),''),...profiles.map(p=>new Option(p.name+' · '+p.region+(p.valid?'':tr(' · authentication needed')),p.name)));
        if(selected && !profiles.some(p=>p.name===selected)) form.elements.profile.add(new Option(selected+tr(' · not found locally'),selected));
        form.elements.profile.value=selected;
        $('dms-auth-status').textContent=m.message||(profiles.length?tr('Select a local CLI profile. Region can be adjusted for your DMS service.'):tr('No named profile found. Configure CLI authentication in the terminal, then refresh.'));
      }
      if(m?.type==='dmsInstances') {
        instancePage=m.page??1;
        for(const row of m.instances??[]) {
          if(instances.has(row.instanceId)) continue;
          const element=document.createElement('section'),button=document.createElement('button');element.className='instance-group';button.type='button';button.className='instance-option';
          button.textContent=row.instanceName+' · '+environmentLabel(row.environment)+' · '+engineLabel(row.engine);button.setAttribute('aria-expanded','false');
          const instance={...row,element};instances.set(row.instanceId,instance);
          button.onclick=()=>{for(const other of instances.values()) other.element.children[0].setAttribute('aria-expanded','false');button.setAttribute('aria-expanded','true');$('dms-database-filter').value='';browseDatabases(instance);};
          element.append(button);$('dms-instances').append(element);
        }
        $('dms-instance-results').hidden=false;$('dms-more-instances').hidden=!m.more;
        feedback.textContent=instances.size?'':tr('No matching instances. Check the filters and DMS permissions.');
        $('dms-search-status').textContent=tr('Choose an instance to load its databases.');working(false);
      }
      if(m?.type==='dmsDatabases') {
        if(m.instance) m.databases=(m.databases??[]).map(row=>({...row,label:databaseLabel(row)}));
        databasePage=m.page??1;
        databases=m.instance && databasePage>1 ? [...databases,...(m.databases??[])] : Array.isArray(m.databases)?m.databases:[];checks.clear();
        $('dms-more-databases').hidden=!m.instance || !m.more;
        $('dms-instance-search').hidden=!m.instance;
        $('dms-database-options').replaceChildren(...databases.map(row=>{
          const key=databaseKey(row),label=document.createElement('label'),check=document.createElement('input'),text=document.createElement('span');
          label.className='database-option';check.type='checkbox';check.disabled=false;text.textContent=row.label;
          if(selectedDatabases.has(key)) selectedDatabases.set(key,{...row,keyword:row.keyword??searchedKeyword});
          check.onchange=()=>{selectDatabase(row,check.checked);syncSelection();};checks.set(key,check);label.append(check,text);return label;
        }));
        $('dms-search-results').hidden=!databases.length && !m.instance;syncSelection();
        feedback.textContent=databases.length?'':tr('No matching databases. Check permissions or the database filter.');
        $('dms-search-status').textContent=databases.length?tr('Found {0} databases. Select the ones to add.',databases.length)+(!m.instance && m.more?' '+tr('Only the first 100 matches are searched. Enter a more specific database name if yours is missing.'):''):'';
        for(const key of ['accessKeyId','accessKeySecret']) form.elements[key].placeholder=tr('Leave blank to keep the entered AccessKey');
        working(false);(m.instance?$('dms-database-filter'):databaseInput).focus();
      }
      if(m?.type==='error') {feedback.textContent=m.message;working(false);}
    });
    working(false);
  } else {
    let data = [], cols = [], numericColumns = [], preview = false, page = 0, sort = null, selected = null, runId = 0, truncated = false, anchor=null, focusCell=null, shown=[], widths=[], detailCell=null;
    const statement = $('statement'), filter = $('filter'), size = $('size'), message = $('message');
    const head = document.querySelector('thead'), body = document.querySelector('tbody');
    const collator = new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
    const display = value => value === null ? 'NULL' : value;
    function decimal(value) {
      const m=/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.trim());
      if (!m || !(m[2] || m[3])) return;
      const raw=m[2]+(m[3]??''), digits=raw.replace(/^0+/,'');
      return {sign:digits ? (m[1]==='-' ? -1 : 1) : 0,digits,
        order:BigInt(m[2].length-(raw.length-digits.length))+BigInt(m[4]??0)};
    }
    function compare(a,b,numeric) {
      if (a===null || b===null) return a===b ? 0 : a===null ? -1 : 1;
      if (!numeric) return collator.compare(a,b);
      const x=decimal(a), y=decimal(b);
      if (!x || !y) return x ? -1 : y ? 1 : collator.compare(a,b);
      if (x.sign!==y.sign) return x.sign-y.sign;
      if (!x.sign) return 0;
      if (x.order!==y.order) return x.sign*(x.order>y.order ? 1 : -1);
      const width=Math.max(x.digits.length,y.digits.length);
      const left=x.digits.padEnd(width,'0'), right=y.digits.padEnd(width,'0');
      return x.sign*(left===right ? 0 : left>right ? 1 : -1);
    }
    const cell = (tag, text, className) => {
      const el = document.createElement(tag); el.textContent = text;
      if (className) el.className = className;
      return el;
    };
    const bounds=()=>anchor && focusCell ? {top:Math.min(anchor.row,focusCell.row),bottom:Math.max(anchor.row,focusCell.row),from:Math.min(anchor.col,focusCell.col),to:Math.max(anchor.col,focusCell.col)} : null;
    const clearRange=()=>{anchor=focusCell=null;};
    const copyRange=()=>{
      const range=bounds();
      if(range) vscode.postMessage({type:'copySelection',runId,rows:shown.slice(range.top,range.bottom+1).map(item=>item.index),from:range.from,to:range.to});
    };
    const applyWidth=(element,col)=>{for(const key of ['width','minWidth','maxWidth']) element.style[key]=widths[col]===undefined?'':widths[col]+'px';};
    const resizeColumn=(col,value)=>{
      widths[col]=value;
      applyWidth(head.rows[0].cells[col+1],col);
      for(const row of body.rows) applyWidth(row.cells[col+1],col);
      head.rows[0].cells[col+1].children[1].setAttribute('aria-valuenow',Math.round(head.rows[0].cells[col+1].getBoundingClientRect().width));
    };
    const chooseCell=(row,col,extend=false)=>{
      if(!extend || !anchor) anchor={row,col};
      focusCell={row,col};selected=shown[row].index;paintSelection();body.rows[row].cells[col+1].focus();
    };
    const openValue=(row,col)=>{
      chooseCell(row,col);detailCell={row:shown[row].index,col};
      $('cell-heading').textContent=tr('Row {0} · {1}',detailCell.row+1,cols[col].name||tr('(unnamed)'));
      $('cell-value').textContent=display(data[detailCell.row][col]);$('cell-detail').hidden=false;$('cell-value').focus();
    };
    $('copy-selection').onclick=copyRange;
    $('grid').oncopy=e=>{if(bounds()){e.preventDefault();copyRange();}};
    $('view-value').onclick=()=>{if(focusCell) openValue(focusCell.row,focusCell.col);};
    $('close-value').onclick=()=>{$('cell-detail').hidden=true;if(focusCell) body.rows[focusCell.row]?.cells[focusCell.col+1]?.focus();};
    $('copy-value').onclick=()=>{if(detailCell) vscode.postMessage({type:'copySelection',runId,rows:[detailCell.row],from:detailCell.col,to:detailCell.col});};
    $('cell-detail').onkeydown=e=>{if(e.key==='Escape') {$('close-value').onclick();e.preventDefault();}};
    function paintSelection() {
      const range=bounds();
      $('copy').disabled=selected===null || !data[selected];
      $('copy-selection').disabled=!range;$('view-value').disabled=!focusCell;
      $('copy-selection').textContent=range && (range.top!==range.bottom || range.from!==range.to)?tr('Copy selection'):tr('Copy cell');
      $('selection-status').textContent=range?tr('{0} × {1} selected',range.bottom-range.top+1,range.to-range.from+1):'';
      for(const [position,row] of [...body.rows].entries()) {
        row.classList.toggle('selected',shown[position].index===selected && !range);
        row.setAttribute('aria-selected',String(shown[position].index===selected && !range));
        for(let col=0;col<cols.length;col++) {
          const td=row.cells[col+1],inRange=!!range && position>=range.top && position<=range.bottom && col>=range.from && col<=range.to;
          td.classList.toggle('cell-selected',inRange);td.setAttribute('role','gridcell');td.setAttribute('aria-selected',String(inRange));
          td.tabIndex=focusCell ? position===focusCell.row && col===focusCell.col?0:-1 : position===0 && col===0?0:-1;
        }
      }
    }
    function draw() {
      const needle = filter.value.toLocaleLowerCase(), perPage = Number(size.value);
      const visible = data.map((row,index)=>({row,index})).filter(({row})=>!needle || row.some(v=>display(v).toLocaleLowerCase().includes(needle)));
      if (sort) visible.sort((a,b)=>sort.sign * compare(a.row[sort.index],b.row[sort.index],numericColumns[sort.index]) || a.index - b.index);
      const pageCount = Math.max(1,Math.ceil(visible.length/perPage)); page = Math.min(page,pageCount - 1);
      shown=visible.slice(page*perPage,(page+1)*perPage);
      const range=bounds();
      $('page').textContent = `${page + 1} / ${pageCount}`;
      $('total').textContent = (needle ? tr('Matched {0} / ',visible.length) : '') + tr('Loaded {0} rows',data.length) +
        (preview ? tr(" · Preview limit: 100 rows") : '') + (truncated ? tr(" · Truncated") : '');
      $('prev').disabled = page === 0; $('next').disabled = page >= pageCount-1;
      const header = document.createElement('tr'); header.append(cell('th','#','number'));
      for (const [index,column] of cols.entries()) {
        const th = document.createElement('th'), label = cell('button',column.name || tr("(unnamed)"));
        th.setAttribute('scope','col');applyWidth(th,index);
        label.setAttribute('aria-label',column.name || tr("(unnamed)"));
        if (sort?.index === index) { th.setAttribute('aria-sort',sort.sign > 0 ? 'ascending':'descending'); label.append(sort.sign > 0 ? ' ↑':' ↓'); }
        if (column.type) label.title = column.type;
        label.onclick = () => {
          sort = {index,sign:sort?.index === index ? -sort.sign : 1}; page=0;clearRange();draw();head.rows[0].cells[index+1].firstElementChild.focus();
        };
        const handle=document.createElement('span');handle.className='column-resize';handle.tabIndex=0;
        handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label',tr('Resize {0}',column.name||tr('(unnamed)')));
        handle.title=tr('Drag to resize; double-click to reset. Arrow keys adjust width.');
        handle.setAttribute('aria-valuemin',72);handle.setAttribute('aria-valuenow',widths[index]??88);
        handle.onfocus=()=>handle.setAttribute('aria-valuenow',Math.round(th.getBoundingClientRect().width));
        let drag;
        handle.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();drag={id:e.pointerId,x:e.clientX,width:th.getBoundingClientRect().width};handle.setPointerCapture(e.pointerId);};
        handle.onpointermove=e=>{if(drag?.id===e.pointerId) resizeColumn(index,Math.max(72,Math.round(drag.width+e.clientX-drag.x)));};
        handle.onpointerup=e=>{if(drag?.id===e.pointerId){handle.releasePointerCapture(e.pointerId);drag=undefined;}};
        handle.onpointercancel=()=>{drag=undefined;};
        handle.ondblclick=e=>{e.stopPropagation();resizeColumn(index,undefined);};
        handle.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home'].includes(e.key)){e.preventDefault();e.stopPropagation();resizeColumn(index,e.key==='Home'?undefined:Math.max(72,(widths[index]??th.getBoundingClientRect().width)+(e.key==='ArrowRight'?16:-16)));}};
        th.append(label,handle); header.append(th);
      }
      head.replaceChildren(...(cols.length ? [header] : []));
      body.replaceChildren(...shown.map(({row,index},position)=>{
        const tr = document.createElement('tr'); tr.append(cell('th',index+1,'number'));
        if (index === selected && !range) tr.classList.add('selected');
        tr.tabIndex=0;
        const choose = () => { selected=index;clearRange();paintSelection();body.rows[position].focus(); };
        tr.onclick = choose;
        tr.onkeydown = e => { if(e.target===tr && (e.key==='Enter' || e.key===' ')) {e.preventDefault();choose();} };
        for (const [col,value] of row.entries()) {
          const td = cell('td',display(value),value === null?'null':''); td.title=display(value);applyWidth(td,col);
          td.onclick=e=>{e.stopPropagation();chooseCell(position,col,e.shiftKey);};
          td.ondblclick=e=>{e.stopPropagation();openValue(position,col);};
          td.onkeydown=e=>{
            if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='c'){e.preventDefault();if(!focusCell)chooseCell(position,col);copyRange();return;}
            if(e.key==='Enter' || e.key==='F2'){e.preventDefault();e.stopPropagation();openValue(position,col);return;}
            const steps={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]},step=steps[e.key];
            if(step){e.preventDefault();chooseCell(Math.max(0,Math.min(shown.length-1,position+step[0])),Math.max(0,Math.min(cols.length-1,col+step[1])),e.shiftKey);}
          };
          tr.append(td);
        }
        return tr;
      }));
      paintSelection();
    }
    filter.oninput = () => {page=0;selected=null;clearRange();draw();};
    size.onchange = () => {page=0;clearRange();draw();};
    $('prev').onclick = () => {page--;clearRange();draw();};
    $('next').onclick = () => {page++;clearRange();draw();};
    $('copy').onclick = () => {if (selected!==null) vscode.postMessage({type:'copy',runId,row:selected});};
    $('pin').onclick = () => vscode.postMessage({type:'pin',runId});
    $('history').onclick = () => vscode.postMessage({type:'history',runId});
    const execute = () => { if (statement.value.trim() && !$('run').disabled) vscode.postMessage({type:'run',sql:statement.value,runId}); };
    $('run').onclick = execute;
    statement.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key==='Enter') {e.preventDefault();execute();} };
    window.addEventListener('message', ({data:m}) => {
      if(m?.runId===runId && ['copied','copyError'].includes(m.type)) {$('selection-status').textContent=tr(m.type==='copied'?'Copied':'Could not copy. Try again.');return;}
      if (!m || !Number.isInteger(m.id) || m.id < runId) return;
      if (m.id !== runId) { selected=null;sort=null;page=0;clearRange();widths=[];detailCell=null;$('cell-detail').hidden=true;$('cell-value').textContent='';filter.value='';statement.value=m.sql; }
      runId = m.id;
      const info=m.connectionInfo,environmentNames={product:'Production',test:'Test',dev:'Development',pre:'Pre-release',sit:'SIT',uat:'UAT',pet:'Load test',stag:'Staging',demo:'Offline'};
      $('target').textContent=info?.name??m.target;$('target').title=m.target;
      $('channel-badge').hidden=!info;$('channel-badge').textContent=info?.channel?.toUpperCase()??'';
      $('environment-badge').hidden=!info;$('environment-badge').textContent=tr(environmentNames[info?.environment]??'Unmarked');
      $('environment-badge').classList.toggle('production',info?.environment==='product');
      $('tls-badge').hidden=!info?.unencrypted;
      for(const [id,value] of [['target-database',info?.database],['target-instance',info?.instance]]) {$(id).textContent=value??'';$(id).title=value??'';$(id).hidden=!value;}
      $('pin').textContent=m.pinned ? tr("Unpin result") : tr("Pin result");
      $('pin').setAttribute('aria-pressed',String(!!m.pinned));
      preview = m.mode==='PREVIEW';
      $('mode').textContent = ({PREVIEW:tr('Preview data'),DATA:tr('Data'),PROPERTIES:tr('Properties')}[m.mode] ?? m.mode ?? tr('Data'));
      $('run').hidden = preview;
      $('run').disabled = preview || m.state==='running';
      statement.readOnly = preview;
      statement.setAttribute('aria-label',preview ? tr("Preview table") : 'SQL');
      cols = m.result?.columns ?? []; data = m.result?.rows ?? []; truncated = !!m.result?.truncated;
      numericColumns=cols.map((column,index)=>{
        if (column.type) return /^(?:tinyint|smallint|mediumint|int|integer|bigint|largeint|number|numeric|dec|decimal\w*|float|double|real)\b/i.test(column.type);
        const values=data.map(row=>row[index]).filter(value=>value!==null);
        return values.length>0 && values.every(value=>decimal(value));
      });
      $('timing').textContent = m.elapsed === undefined ? '' : `${m.elapsed} ms`;
      const t=m.timings, phases=$('phases');
      phases.hidden=!t || !['connect','preflight','execute'].every(k=>Number.isFinite(t[k]) && t[k]>=0);
      phases.textContent=phases.hidden ? '' : tr('Connection {0} ms · Preflight {1} ms · Execution {2} ms · Other {3} ms',Math.round(t.connect),Math.round(t.preflight),Math.round(t.execute),Math.max(0,Math.round((m.elapsed??0)-t.connect-t.preflight-t.execute)));
      const detail=m.diagnostic, diagnostics=[];
      if(m.state==='error' && detail && typeof detail==='object') {
        if(Object.hasOwn(phaseNames,detail.phase)) diagnostics.push(tr('Stopped during {0}',phaseName(detail.phase)));
        if(Number.isSafeInteger(detail.estimatedRows) && detail.estimatedRows>=0) diagnostics.push(tr('Estimated scan: {0} rows',detail.estimatedRows));
        if(Number.isSafeInteger(detail.maxRows) && detail.maxRows>=0) diagnostics.push(tr('Scan limit: {0} rows',detail.maxRows));
        if(Number.isSafeInteger(detail.shards) && detail.shards>=0) diagnostics.push(tr('Shards: {0} / allowed: 1',detail.shards));
      }
      $('diagnostic').textContent=diagnostics.join(' · ');$('diagnostic').hidden=!diagnostics.length;
      message.textContent = m.state==='running' ? (m.phase ? tr('Current phase: {0}',phaseName(m.phase)) : tr("Running query…")) : m.error ?? (m.result?.truncated ? tr("Showing the first rows returned within the display limit.") : data.length===0 ? tr("No rows returned.") : '');
      message.classList.toggle('error',m.state==='error');
      message.hidden = !message.textContent;
      draw();
    });
    draw();
  }
  vscode.postMessage({type:'ready'});
})();
