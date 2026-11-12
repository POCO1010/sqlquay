'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const tr=window.SQLQuayI18n.translator(document.documentElement.lang);
  const $ = id => document.getElementById(id);
  if (document.body.dataset.view === 'connect') {
    const form = $('connection'), feedback = $('feedback');
    let engine='mysql',editing=false,profiles=[],databases=[],selectedDatabase,searchedKeyword='';
    const databaseInput=form.elements.keyword,targets=form.elements.dmsDatabase;
    const method=()=>form.elements.channel.value,authMode=()=>form.elements.authMode.value;
    const loadProfiles=()=>{$('dms-auth-status').textContent=tr('Reading local CLI profiles…');vscode.postMessage({type:'loadDmsProfiles'});};
    const clearKeys=()=>{for(const key of ['accessKeyId','accessKeySecret']) form.elements[key].value='';};
    const closeTargets=()=>{targets.hidden=true;databaseInput.setAttribute('aria-expanded','false');};
    const showTargets=()=>{if(databases.length){targets.hidden=false;databaseInput.setAttribute('aria-expanded','true');}};
    const clearTargets=()=>{
      databases=[];selectedDatabase=undefined;searchedKeyword='';targets.replaceChildren();closeTargets();
      $('dms-search-status').textContent=tr('Enter a database name, click Find, then choose a match.');
    };
    const chooseTarget=()=>{
      const selected=databases[targets.selectedIndex];if(!selected) return;
      selectedDatabase=selected;databaseInput.value=selected.database;
      if(!form.elements.name.value.trim()) form.elements.name.value=selected.database+' · DMS';
      $('dms-search-status').textContent=tr('Selected: {0}',selected.label);closeTargets();databaseInput.focus();
    };
    databaseInput.onclick=showTargets;
    targets.onclick=chooseTarget;
    targets.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();chooseTarget();}if(e.key==='Escape'){e.preventDefault();closeTargets();databaseInput.focus();}};
    databaseInput.onkeydown=e=>{
      if(e.key==='Enter'){e.preventDefault();$('dms-search').click();}
      if(e.key==='ArrowDown' && databases.length){e.preventDefault();showTargets();if(targets.selectedIndex<0)targets.selectedIndex=0;targets.focus();}
      if(e.key==='Escape'){e.preventDefault();closeTargets();}
    };
    for(const event of ['pointerdown','focusin']) document.addEventListener(event,e=>{if(!$('dms-database-control').contains(e.target)) closeTargets();});
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
      for(const control of form.querySelectorAll('[name="name"],[name="group"],button[type="submit"]')) control.disabled=busy;
    };
    $('dms-profiles').onclick=loadProfiles;
    $('dms-auth').onclick=()=>vscode.postMessage({type:'configureDms'});
    $('dms-ak-guide').onclick=()=>vscode.postMessage({type:'openAccessKeyGuide'});
    $('dms-search').onclick=()=>{
      const values={keyword:form.elements.keyword.value,region:form.elements.region.value,accessKeyId:form.elements.accessKeyId.value,accessKeySecret:form.elements.accessKeySecret.value};
      if(!values.keyword.trim() || !values.region.trim()) {feedback.textContent=tr('Enter a region and a database name.');return;}
      clearTargets();searchedKeyword=values.keyword.trim();feedback.textContent=tr('Searching databases…');working(true);
      vscode.postMessage({type:'searchDmsDatabases',values});clearKeys();
    };
    form.addEventListener('input',e=>{
      if(authMode()==='accessKey' && ['accessKeyId','accessKeySecret','region','keyword'].includes(e.target.name)) clearTargets();
    });
    form.addEventListener('change',e=>{
      if(e.target.name==='channel' || e.target.name==='authMode') {
        closeTargets();if(e.target.name==='authMode') clearTargets();
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
      const oldDefault=engine==='mysql'?'3306':'9030';engine=e.target.value;
      if(form.elements.port.value===oldDefault) form.elements.port.value=engine==='mysql'?'3306':'9030';
    });
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const values={...Object.fromEntries(new FormData(form)),channel:method()};
      if(values.channel==='dms') {
        values.authMode=authMode();
        if(values.authMode==='accessKey' && !selectedDatabase){feedback.textContent=tr('Search and select the database with this AccessKey first.');return;}
        values.database=values.authMode==='accessKey'?selectedDatabase.database:form.elements.schema.value;
        values.databaseId=values.authMode==='accessKey'?selectedDatabase.databaseId:form.elements.databaseId.value;
        values.keyword=values.authMode==='accessKey'?searchedKeyword:(form.elements.searchHint.value.trim()||values.database);
        delete values.schema;delete values.dmsDatabase;delete values.searchHint;
      }
      const type=e.submitter?.value==='save'?'save':'connect';
      feedback.textContent=type==='connect'?tr('Checking connection…'):tr('Saving…');working(true);
      vscode.postMessage({type,values});form.elements.password.value='';clearKeys();
    });
    $('close').onclick=()=>vscode.postMessage({type:'close'});
    window.addEventListener('message',({data:m})=>{
      if(m?.type==='configure' && m.connection) {
        const {channel,name,group,database,engine:kind,host,port,keyword,databaseId,sslMode,profile,region,authMode:auth}=m.connection;
        $('heading').textContent=tr('Edit connection');editing=true;form.elements.channel.value=channel;
        const values=channel==='dms'?{name,group,schema:database,keyword:database,searchHint:keyword===database?'':keyword,databaseId,region:region??'cn-hangzhou',authMode:auth??'profile'}:{name,group,database,engine:kind,host,port,sslMode:sslMode??'VERIFY_IDENTITY'};
        for(const [key,value] of Object.entries(values)) form.elements[key].value=value??'';
        if(channel==='jdbc') {form.elements.user.required=false;form.elements.user.placeholder=tr('Leave blank to keep credentials');engine=kind;}
        if(channel==='dms' && authMode()==='profile') {$('dms-search-options').open=keyword!==database;form.elements.profile.add(new Option(profile??'dms-prod',profile??'dms-prod',true,true));loadProfiles();}
        if(channel==='dms' && authMode()==='accessKey') {
          searchedKeyword=keyword;selectedDatabase={database,databaseId,label:database+' · #'+databaseId};databases=[selectedDatabase];
          targets.replaceChildren(new Option(selectedDatabase.label,databaseId));targets.selectedIndex=-1;
          $('dms-search-status').textContent=tr('Selected: {0}',selectedDatabase.label);
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
      if(m?.type==='dmsDatabases') {
        databases=Array.isArray(m.databases)?m.databases:[];
        targets.replaceChildren(...databases.map(row=>new Option(row.label,row.databaseId)));targets.size=Math.min(Math.max(databases.length,2),6);targets.selectedIndex=-1;
        feedback.textContent=databases.length?'':tr('No supported production database found. Check permissions or enter a more specific database name.');
        $('dms-search-status').textContent=databases.length?tr('Found {0} databases. Choose one, then save or connect.',databases.length)+(m.more?' '+tr('Only the first 100 matches are searched. Enter a more specific database name if yours is missing.'):''):'';
        for(const key of ['accessKeyId','accessKeySecret']) form.elements[key].placeholder=tr('Leave blank to keep the entered AccessKey');
        working(false);showTargets();databaseInput.focus();
      }
      if(m?.type==='error') {feedback.textContent=m.message;working(false);}
    });
    working(false);
  } else {
    let data = [], cols = [], numericColumns = [], preview = false, page = 0, sort = null, selected = null, runId = 0, truncated = false;
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
    function draw() {
      const needle = filter.value.toLocaleLowerCase(), perPage = Number(size.value);
      const visible = data.map((row,index)=>({row,index})).filter(({row})=>!needle || row.some(v=>display(v).toLocaleLowerCase().includes(needle)));
      if (sort) visible.sort((a,b)=>sort.sign * compare(a.row[sort.index],b.row[sort.index],numericColumns[sort.index]) || a.index - b.index);
      const pageCount = Math.max(1,Math.ceil(visible.length/perPage)); page = Math.min(page,pageCount - 1);
      $('page').textContent = `${page + 1} / ${pageCount}`;
      $('total').textContent = (needle ? tr('Matched {0} / ',visible.length) : '') + tr('Loaded {0} rows',data.length) +
        (preview ? tr(" · Preview limit: 100 rows") : '') + (truncated ? tr(" · Truncated") : '');
      $('prev').disabled = page === 0; $('next').disabled = page >= pageCount-1;
      $('copy').disabled = selected === null || !visible.some(({index})=>index === selected);
      const header = document.createElement('tr'); header.append(cell('th','#','number'));
      for (const [index,column] of cols.entries()) {
        const th = document.createElement('th'), label = cell('button',column.name || tr("(unnamed)"));
        th.setAttribute('scope','col');
        label.setAttribute('aria-label',column.name || tr("(unnamed)"));
        if (sort?.index === index) { th.setAttribute('aria-sort',sort.sign > 0 ? 'ascending':'descending'); label.append(sort.sign > 0 ? ' ↑':' ↓'); }
        if (column.type) label.title = column.type;
        label.onclick = () => {
          sort = {index,sign:sort?.index === index ? -sort.sign : 1}; page=0; draw(); head.rows[0].cells[index+1].firstElementChild.focus();
        };
        th.append(label); header.append(th);
      }
      head.replaceChildren(...(cols.length ? [header] : []));
      body.replaceChildren(...visible.slice(page*perPage,(page+1)*perPage).map(({row,index})=>{
        const tr = document.createElement('tr'); tr.append(cell('th',index+1,'number'));
        if (index === selected) tr.classList.add('selected');
        tr.tabIndex=0;
        const choose = () => { selected=index; draw(); body.querySelector('.selected')?.focus(); };
        tr.onclick = choose;
        tr.onkeydown = e => { if(e.key==='Enter' || e.key===' ') {e.preventDefault();choose();} };
        for (const value of row) {
          const td = cell('td',display(value),value === null?'null':''); td.title=display(value); tr.append(td);
        }
        return tr;
      }));
    }
    filter.oninput = () => {page=0;selected=null;draw();};
    size.onchange = () => {page=0;draw();};
    $('prev').onclick = () => {page--;draw();};
    $('next').onclick = () => {page++;draw();};
    $('copy').onclick = () => {if (selected!==null) vscode.postMessage({type:'copy',runId,row:selected});};
    $('pin').onclick = () => vscode.postMessage({type:'pin',runId});
    $('history').onclick = () => vscode.postMessage({type:'history',runId});
    const execute = () => { if (statement.value.trim() && !$('run').disabled) vscode.postMessage({type:'run',sql:statement.value,runId}); };
    $('run').onclick = execute;
    statement.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key==='Enter') {e.preventDefault();execute();} };
    window.addEventListener('message', ({data:m}) => {
      if (!m || !Number.isInteger(m.id) || m.id < runId) return;
      if (m.id !== runId) { selected=null;sort=null;page=0;filter.value='';statement.value=m.sql; }
      runId = m.id;
      $('target').textContent = m.target;
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
      message.textContent = m.state==='running' ? tr("Running query…") : m.error ?? (m.result?.truncated ? tr("Showing the first rows returned within the display limit.") : data.length===0 ? tr("No rows returned.") : '');
      message.classList.toggle('error',m.state==='error');
      message.hidden = !message.textContent;
      draw();
    });
    draw();
  }
  vscode.postMessage({type:'ready'});
})();
