'use strict';
const {spawn} = require('node:child_process');
const {accessSync, constants} = require('node:fs');
const path = require('node:path');
const {expand} = require('./jdbc.cjs');
const {dmsReadonly} = require('./query.cjs');

class DmsStopped extends Error {}
function dmsConfig(input) {
  const get = key => typeof input[key] === 'string' ? input[key].trim() : '';
  const name = get('name'), group = get('group'), keyword = get('keyword'), database = get('database'), databaseId = get('databaseId');
  if (!name || name.length > 80 || group.length > 80 || /[\x00-\x1f]/.test(name + group)) throw Error('Enter a connection name (80 characters maximum).');
  if (!keyword || keyword.length > 128 || !database || database.length > 128 ||
      /[\x00-\x1f]/.test(keyword + database) || !/^[1-9][0-9]{0,19}$/.test(databaseId)) {
    throw Error('Enter the DMS search keyword, exact schema, and verified numeric Database ID.');
  }
  return {channel:'dms',name,group,keyword,database,databaseId};
}

function call(command, args) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    const buffers = {stdout:[],stderr:[]}, sizes = {stdout:0,stderr:0};
    const cap = 16 * 1024 * 1024;
    for (const key of ['stdout','stderr']) child[key].on('data', chunk => {
      sizes[key] += chunk.length;
      if (sizes[key] <= cap) buffers[key].push(chunk);
    });
    child.once('error',reject);
    // Drain output and let the wrapper finish its AI Mode cleanup even if a result is too large.
    child.once('close',code=>resolve({code,stdout:Buffer.concat(buffers.stdout).toString(),
      stderr:Buffer.concat(buffers.stderr).toString(),stdoutOverflow:sizes.stdout>cap,stderrOverflow:sizes.stderr>cap}));
  });
}

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function decode(text) {
  // DMS can encode BIGINT and DECIMAL as JSON numbers. Keep their exact text for the grid.
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token=>token[0] === '"' ? token : '"' + token + '"'));
}
const locked = {
  server_state_unknown:'DMS could not confirm that the query ended.',
  timed_out_stopped:'DMS timed out and stopped this query. It was not retried.',
  cleanup_failed:'DMS could not complete AI Mode cleanup.'
};
const known = {
  needs_split:'DMS could not verify the scan budget. Narrow the filter or split the query.',
  blocked:'DMS blocked the statement during read-only preflight.',
  query_in_flight:'Another governed query is running. Wait for it to finish.',
  execution_failed:'DMS execution failed. Check CLI access, the target and the SQL.'
};
function grid(rows, sql, limit, columns) {
  const display = rows.slice(0,limit);
  let names = columns ?? [...new Set(display.flatMap(Object.keys))];
  if (/^DESC(?:RIBE)?\b/i.test(sql)) {
    const field = names.find(n=>/^field$/i.test(n)), type = names.find(n=>/^type$/i.test(n));
    if (field && type) names = [field,type,...names.filter(n=>n!==field && n!==type)];
  }
  return {columns:names.map(name=>({name,type:''})),rows:display.map(row=>names.map(name=>{
    if (!Object.hasOwn(row,name) || row[name] === null) return null;
    const value = row[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  })),truncated:rows.length>limit};
}
function makeDms(settings, transport = call) {
  return async (connection, sql, limit = 200, table) => {
    const target = dmsConfig(connection), statement = table === undefined ? dmsReadonly(sql) : '';
    const wrapper = expand(settings.wrapper);
    if (!path.isAbsolute(wrapper) || path.basename(wrapper) !== 'execute_safe.py') throw Error('Set dbWorkbench.dmsWrapperPath to the installed execute_safe.py.');
    try { accessSync(wrapper,constants.R_OK); } catch { throw Error('The approved DMS execute_safe.py was not found.'); }
    let plugin;
    try { plugin = await transport('aliyun',['plugin','list']); }
    catch { throw Error('Aliyun CLI is not available to VS Code.'); }
    if (plugin.code !== 0 || !/^\s*aliyun-cli-dms-enterprise(?:[ \t]|$)/m.test(plugin.stdout)) {
      throw Error('Install and configure aliyun-cli-dms-enterprise separately; Workbench does not install plugins.');
    }
    let response;
    try {
      // The approved entrypoint fixes --profile dms-prod and owns target resolution, the
      // workstation lock, scan limits, timeouts, and the CLI AI Mode lifecycle.
      const targetArgs=['--database-keyword='+target.keyword,'--schema='+target.database,'--db-id='+target.databaseId];
      const args=table === undefined ? ['-I','-B',path.join(__dirname,'..','scripts','dms_timed.py'),wrapper,...targetArgs,'--sql='+statement] :
        ['-I','-B',path.join(__dirname,'..','scripts','preview_safe.py'),...targetArgs,'--safe-wrapper='+wrapper,'--table='+table];
      response = await transport(expand(settings.python),args);
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('Python executable was not found.');
      throw new DmsStopped('DMS wrapper exited unexpectedly. Verify query and AI Mode state.');
    }
    const reports = response.stderr.split(/\r?\n/).flatMap(line=>{
      try { const value=JSON.parse(line);return object(value) ? [value] : []; } catch { return []; }
    });
    const timing=reports.find(r=>r.status==='timing')?.timings;
    const timings=timing && ['connect','preflight','execute'].every(k=>Number.isFinite(timing[k]) && timing[k]>=0) ? timing : undefined;
    const fail=error=>{error.timings=timings;return error;};
    const stop = reports.find(r=>Object.hasOwn(locked,r.status));
    if (stop || response.stderrOverflow) throw fail(new DmsStopped(locked[stop?.status] ?? 'DMS did not return a complete status.'));
    const failure = reports.find(r=>Object.hasOwn(known,r.status));
    if (failure) {
      if (table !== undefined && failure.status==='needs_split') throw fail(Error('无法确认全表扫描量，或估算超出扫描上限，未读取数据。'));
      const targetMiss = failure.status==='blocked' && typeof failure.error==='string' && failure.error.startsWith('Database metadata did not resolve');
      throw fail(Error(targetMiss ? 'DMS target not found. Verify the keyword, exact schema and Database ID for the product environment.' : known[failure.status]));
    }
    if (response.code === 0 && response.stdoutOverflow) throw Error('DMS result exceeded the display size limit. Select fewer columns or rows.');
    let out;
    try { out=decode(response.stdout); } catch { /* Unknown exit is handled below. */ }
    if (response.code !== 0 || out?.status !== 'success' || out.source !== 'dms') {
      throw new DmsStopped('DMS wrapper did not report completion. Verify query and AI Mode state.');
    }
    if (String(out.database_id)!==target.databaseId || !Array.isArray(out.rows) || !out.rows.every(object)) {
      throw Error('DMS response did not match the bound target or result format.');
    }
    if (table !== undefined && (!Array.isArray(out.columns) || !out.columns.length || !out.columns.every(c=>typeof c==='string'))) {
      throw Error('Invalid preview columns.');
    }
    return {...grid(out.rows,statement,limit,table === undefined ? undefined : out.columns),...(timings ? {timings} : {})};
  };
}
module.exports = {dmsConfig, makeDms, DmsStopped};
