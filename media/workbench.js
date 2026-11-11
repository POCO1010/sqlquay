'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  if (document.body.dataset.view === 'connect') {
    const form = $('connection'), feedback = $('feedback');
    let engine = 'mysql', editing = false;
    const method = () => form.elements.channel.value;
    const working = busy => {
      const dms = method() === 'dms';
      $('methods').disabled = busy || editing;
      $('jdbc-fields').hidden = dms;
      $('jdbc-fields').disabled = busy || dms;
      $('dms-fields').hidden = !dms;
      $('dms-fields').disabled = busy || !dms;
      $('tls-warning').hidden = dms || form.elements.sslMode.value !== 'DISABLED';
      for (const control of form.querySelectorAll('[name="name"],[name="group"],button[type="submit"]')) control.disabled = busy;
    };
    form.addEventListener('change', e => {
      if (e.target.name === 'channel') { feedback.textContent = ''; working(false); }
      if (e.target.name === 'sslMode') working(false);
      if (e.target.name !== 'engine') return;
      const oldDefault = engine === 'mysql' ? '3306' : '9030';
      engine = e.target.value;
      if (form.elements.port.value === oldDefault) form.elements.port.value = engine === 'mysql' ? '3306' : '9030';
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = {...Object.fromEntries(new FormData(form)),channel:method()};
      if (values.channel === 'dms') {
        values.database = values.schema;
        delete values.schema;
      }
      const type = e.submitter?.value === 'save' ? 'save' : 'connect';
      feedback.textContent = type === 'connect' ? 'Checking connection…' : 'Saving…';
      working(true);
      vscode.postMessage({type,values});
      form.elements.password.value = '';
    });
    $('close').onclick = () => vscode.postMessage({type:'close'});
    window.addEventListener('message', ({data:m}) => {
      if (m?.type === 'configure' && m.connection) {
        const {channel, name, group, database, engine:kind, host, port, keyword, databaseId, sslMode} = m.connection;
        $('heading').textContent = 'Edit connection';
        editing = true;
        form.elements.channel.value = channel;
        const values = channel === 'dms' ? {name,group,schema:database,keyword,databaseId} : {name,group,database,engine:kind,host,port,sslMode:sslMode ?? 'VERIFY_IDENTITY'};
        for (const [key,value] of Object.entries(values)) form.elements[key].value = value ?? '';
        if (channel === 'jdbc') {
          form.elements.user.required = false;
          form.elements.user.placeholder = 'Leave blank to keep credentials';
          engine = kind;
        }
        working(false);
      }
      if (m?.type === 'error') { feedback.textContent = m.message; working(false); }
    });
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
      $('total').textContent = (needle ? `匹配 ${visible.length} / ` : '') + `已加载 ${data.length} 行` +
        (preview ? ' · 预览上限 100 行' : '') + (truncated ? ' · 已截断' : '');
      $('prev').disabled = page === 0; $('next').disabled = page >= pageCount-1;
      $('copy').disabled = selected === null || !visible.some(({index})=>index === selected);
      const header = document.createElement('tr'); header.append(cell('th','#','number'));
      for (const [index,column] of cols.entries()) {
        const th = document.createElement('th'), label = cell('button',column.name || '(unnamed)');
        th.setAttribute('scope','col');
        label.setAttribute('aria-label',column.name || '(unnamed)');
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
      $('pin').textContent=m.pinned ? '取消固定' : '固定结果';
      $('pin').setAttribute('aria-pressed',String(!!m.pinned));
      preview = m.mode==='PREVIEW';
      $('mode').textContent = preview ? '预览数据' : m.mode ?? 'DATA';
      $('run').hidden = preview;
      $('run').disabled = preview || m.state==='running';
      statement.readOnly = preview;
      statement.setAttribute('aria-label',preview ? '预览表' : 'SQL');
      cols = m.result?.columns ?? []; data = m.result?.rows ?? []; truncated = !!m.result?.truncated;
      numericColumns=cols.map((column,index)=>{
        if (column.type) return /^(?:tinyint|smallint|mediumint|int|integer|bigint|largeint|number|numeric|dec|decimal\w*|float|double|real)\b/i.test(column.type);
        const values=data.map(row=>row[index]).filter(value=>value!==null);
        return values.length>0 && values.every(value=>decimal(value));
      });
      $('timing').textContent = m.elapsed === undefined ? '' : `${m.elapsed} ms`;
      const t=m.timings, phases=$('phases');
      phases.hidden=!t || !['connect','preflight','execute'].every(k=>Number.isFinite(t[k]) && t[k]>=0);
      phases.textContent=phases.hidden ? '' : `连接 ${Math.round(t.connect)} ms · 预检 ${Math.round(t.preflight)} ms · 执行 ${Math.round(t.execute)} ms · 其他 ${Math.max(0,Math.round((m.elapsed??0)-t.connect-t.preflight-t.execute))} ms`;
      message.textContent = m.state==='running' ? 'Running query…' : m.error ?? (m.result?.truncated ? 'Showing the first rows returned within the display limit.' : data.length===0 ? 'No rows returned.' : '');
      message.classList.toggle('error',m.state==='error');
      message.hidden = !message.textContent;
      draw();
    });
    draw();
  }
  vscode.postMessage({type:'ready'});
})();
