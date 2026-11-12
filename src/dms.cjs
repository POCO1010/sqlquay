'use strict';
const {spawn} = require('node:child_process');
const {accessSync, constants} = require('node:fs');
const path = require('node:path');
const {expand} = require('./jdbc.cjs');
const {dmsReadonly} = require('./query.cjs');
const {progressReader,diagnosticError,attachDiagnostic}=require('./execution.cjs');

class DmsStopped extends Error {}
const profileName=value=>typeof value==='string' && value.length>0 && value.length<=128 && !/^[\s-]|[\x00-\x1f\x7f]/.test(value);
function dmsIdentity(input) {
  const get=key=>typeof input[key]==='string' ? input[key].trim() : '';
  const name=get('name'),group=get('group');
  if(!name || name.length>80 || group.length>80 || /[\x00-\x1f]/.test(name+group)) throw Error('Enter a connection name (80 characters maximum).');
  if(!['profile','accessKey'].includes(authMode(input))) throw Error('Choose a supported DMS authentication method.');
  const profile=get('profile')||'dms-prod',region=get('region')||'cn-hangzhou';
  if(!profileName(profile) || !/^[a-z]{2}-[a-z0-9-]{1,40}$/.test(region)) throw Error('Choose a valid Aliyun CLI profile and region.');
  return {channel:'dms',name,group,region,...(authMode(input)==='accessKey'?{authMode:'accessKey'}:{profile})};
}
const environments=new Set(['product','test','dev','pre','sit','uat','pet','stag']);
const engines=new Set(['mysql','rds','polardb','drds','doris','selectdb','ots']);
function targetMetadata(input) {
  const data={};
  for(const field of ['instanceId','instanceName','engine','environment']) if(input[field]!==undefined) {
    const value=input[field];
    if(typeof value!=='string' || !value || value.length>256 || /[\x00-\x1f]/.test(value) ||
      (field==='instanceId' && !/^[1-9][0-9]{0,19}$/.test(value)) ||
      (field==='engine' && !engines.has(value)) || (field==='environment' && !environments.has(value))) throw Error('Invalid DMS instance metadata. Search and choose the database again.');
    data[field]=value;
  }
  return data;
}
function dmsConfig(input) {
  const {channel,name,group,region,...auth}=dmsIdentity(input);
  const get=key=>typeof input[key]==='string' ? input[key].trim() : '';
  const keyword=get('keyword'),database=get('database'),databaseId=get('databaseId');
  if(!keyword || keyword.length>128 || !database || database.length>128 || /[\x00-\x1f]/.test(keyword+database) || !/^[1-9][0-9]{0,19}$/.test(databaseId)) throw Error('Enter the database name and verified numeric Database ID.');
  return {channel,name,group,keyword,database,databaseId,region,...auth,...targetMetadata(input)};
}

const authMode=connection=>connection.authMode??'profile';
const isDmsAccount=connection=>connection?.channel==='dms' && authMode(connection)==='accessKey' && Array.isArray(connection.databases);
function dmsAccountConfig(input,{allowEmpty=false}={}) {
  if(authMode(input)!=='accessKey' || !Array.isArray(input.databases) || (!input.databases.length && !allowEmpty)) throw Error('Choose one or more databases for this AccessKey connection.');
  const identity=dmsIdentity(input),seen=new Set();
  const targets=input.databases.map(row=>{
    if(!row || typeof row!=='object' || Array.isArray(row)) throw Error('Choose one or more databases for this AccessKey connection.');
    const target=dmsConfig({...identity,keyword:row.keyword,database:row.database,databaseId:row.databaseId,...targetMetadata(row)});
    if(seen.has(target.databaseId)) throw Error('Each database can be added only once.');
    seen.add(target.databaseId);
    return {keyword:target.keyword,database:target.database,databaseId:target.databaseId,...targetMetadata(target)};
  });
  return {...identity,databases:targets};
}
function dmsTargets(connection) {
  if(!isDmsAccount(connection)) return [connection];
  const {databases,...account}=connection;
  return databases.map(target=>({...account,...target,revision:account.revision,accountId:account.id}));
}
function accessKeyCredentials(input) {
  const accessKeyId=typeof input?.accessKeyId==='string' ? input.accessKeyId.trim() : '';
  const accessKeySecret=typeof input?.accessKeySecret==='string' ? input.accessKeySecret.trim() : '';
  if(!accessKeyId || !accessKeySecret || accessKeyId.length>256 || accessKeySecret.length>256 || /[\s\x00-\x1f\x7f]/.test(accessKeyId+accessKeySecret)) throw Error('Enter both AccessKey ID and AccessKey Secret.');
  return {accessKeyId,accessKeySecret};
}
function searchConfig(input) {
  const keyword=typeof input?.keyword==='string' ? input.keyword.trim() : '';
  const region=typeof input?.region==='string' ? input.region.trim() : '';
  if(!keyword || keyword.length>128 || /[\x00-\x1f]/.test(keyword) || !/^[a-z]{2}-[a-z0-9-]{1,40}$/.test(region)) throw Error('Enter a region and a database name.');
  return {keyword,region};
}
function call(command, args, input, onProgress) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],windowsHide:true});
    const buffers = {stdout:[],stderr:[]}, sizes = {stdout:0,stderr:0};
    const cap = 16 * 1024 * 1024;
    child.stderr.on('data',progressReader(onProgress));
    for (const key of ['stdout','stderr']) child[key].on('data', chunk => {
      sizes[key] += chunk.length;
      if (sizes[key] <= cap) buffers[key].push(chunk);
    });
    child.once('error',reject);
    if(input!==undefined) {child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));}
    // Drain output and let the wrapper finish its AI Mode cleanup even if a result is too large.
    child.once('close',code=>resolve({code,stdout:Buffer.concat(buffers.stdout).toString(),
      stderr:Buffer.concat(buffers.stderr).toString(),stdoutOverflow:sizes.stdout>cap,stderrOverflow:sizes.stderr>cap}));
  });
}

function parseProfiles(output) {
  return output.split(/\r?\n/).flatMap(line=>{
    const cells=line.split('|').map(value=>value.trim());
    if(cells.length!==5) return [];
    const name=cells[0].replace(/\s+\*$/,'').trim();
    if(!profileName(name) || !/^[a-z]{2}-[a-z0-9-]{1,40}$/.test(cells[3])) return [];
    return [{name,region:cells[3],valid:cells[2]==='Valid'}];
  });
}
async function listDmsProfiles(transport=call) {
  let result;
  try { result=await transport('aliyun',['configure','list']); }
  catch { throw Error('Aliyun CLI was not found. Install the official CLI, then configure a named profile in your terminal.'); }
  if(result.code!==0 || result.stdoutOverflow) throw Error('Could not list Aliyun CLI profiles. Run aliyun configure list in your terminal.');
  return parseProfiles(result.stdout);
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
  return async (connection, sql, limit = 200, table, credentials) => {
    const target = dmsConfig(connection), statement = table === undefined ? dmsReadonly(connection.engine==='ots' && sql==='SHOW TABLES'?'SHOW FULL TABLES':sql) : '';
    settings.onProgress?.('prepare');
    const independent=authMode(target)==='accessKey';
    const auth=independent ? accessKeyCredentials(credentials) : undefined;
    const wrapper = independent ? path.join(__dirname,'..','policy','execute_safe.py') : expand(settings.wrapper);
    if (!path.isAbsolute(wrapper) || path.basename(wrapper) !== 'execute_safe.py') throw Error('Set dbWorkbench.dmsWrapperPath to the installed execute_safe.py.');
    try { accessSync(wrapper,constants.R_OK); } catch { throw Error('The approved DMS execute_safe.py was not found.'); }
    if(!independent) {
      let plugin;
      try { plugin = await transport('aliyun',['plugin','list']); }
      catch { throw Error('Aliyun CLI is not available to VS Code.'); }
      if (plugin.code !== 0 || !/^\s*aliyun-cli-dms-enterprise(?:[ \t]|$)/m.test(plugin.stdout)) {
        throw Error('Install and configure aliyun-cli-dms-enterprise separately; Workbench does not install plugins.');
      }
    }
    let response;
    try {
      // The approved entrypoint uses the bound profile and owns target resolution, the
      // workstation lock, scan limits, timeouts, and the CLI AI Mode lifecycle.
      const targetArgs=['--database-keyword='+target.keyword,'--schema='+target.database,'--db-id='+target.databaseId,'--profile='+(independent?'sqlquay':target.profile),'--region='+target.region,...(target.environment?['--environment='+target.environment]:[]),...(target.instanceId?['--instance-id='+target.instanceId]:[]),...(target.engine?['--engine='+target.engine]:[])];
      const args=table === undefined ? ['-I','-B',path.join(__dirname,'..','scripts','dms_timed.py'),wrapper,...targetArgs,'--sql='+statement] :
        ['-I','-B',path.join(__dirname,'..','scripts','preview_safe.py'),...targetArgs,'--safe-wrapper='+wrapper,'--table='+table];
      response = independent
        ? await transport(expand(settings.python),['-I','-B',path.join(__dirname,'..','scripts','dms_ak.py'),table===undefined?'query':'preview',...targetArgs,...(table===undefined?['--sql='+statement]:['--table='+table])],auth,settings.onProgress)
        : await transport(expand(settings.python),args,undefined,settings.onProgress);
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('Python executable was not found.');
      throw new DmsStopped('DMS wrapper exited unexpectedly. Verify query and AI Mode state.');
    }
    const reports = response.stderr.split(/\r?\n/).flatMap(line=>{
      try { const value=JSON.parse(line);return object(value) ? [value] : []; } catch { return []; }
    });
    const timing=reports.find(r=>r.status==='timing')?.timings;
    const timings=timing && ['connect','preflight','execute'].every(k=>Number.isFinite(timing[k]) && timing[k]>=0) ? timing : undefined;
    const failure = reports.find(r=>Object.hasOwn(known,r.status));
    const stop = reports.find(r=>Object.hasOwn(locked,r.status));
    const lastDetail=[...reports].reverse().find(r=>r.status==='diagnostic')?.diagnostic;
    const detail=stop?.status==='cleanup_failed' ? lastDetail : failure?.diagnostic ?? lastDetail;
    const fail=error=>{error.timings=timings;return attachDiagnostic(error,detail);};
    if (stop || response.stderrOverflow) throw fail(new DmsStopped(locked[stop?.status] ?? 'DMS did not return a complete status.'));
    try {setupFailure(response);} catch(error) {throw fail(error);}
    if (failure) {
      if(failure.status==='blocked' && failure.error==='External policy lacks required engine capabilities.') throw fail(Error(setupMessages.policy_incompatible));
      if (table !== undefined && failure.status==='needs_split') throw fail(diagnosticError(detail,"Cannot confirm the full-table scan size, or its estimate exceeds the scan limit. No data was read."));
      if(failure.status==='blocked' && typeof failure.error==='string' && failure.error.includes('Tablestore supports databases')) throw fail(Error('Tablestore supports databases, tables and DDL only. Data queries and previews require verified EXPLAIN support.'));
      const targetMiss = failure.status==='blocked' && typeof failure.error==='string' && failure.error.startsWith('Database metadata did not resolve');
      throw fail(diagnosticError(detail,targetMiss ? 'DMS target not found. Verify the instance, environment, database name and Database ID.' : known[failure.status]));
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
const setupMessages={
  policy_incompatible:'The selected external DMS policy does not support this engine or instance selection. Use the bundled policy or a compatible approved policy.',
  invalid_credentials:'Enter both AccessKey ID and AccessKey Secret.',
  cli_missing:'Aliyun CLI is not available to VS Code.',
  plugin_missing:'Install and configure aliyun-cli-dms-enterprise separately; Workbench does not install plugins.',
  search_failed:'DMS database search failed. Check this AccessKey, region and DMS permissions.'
};
function setupFailure(response) {
  for(const line of response.stderr.split(/\r?\n/)) {
    let value;try {value=JSON.parse(line);} catch {continue;}
    if(value.status==='configuration_error') throw Error(setupMessages[value.reason]??setupMessages.search_failed);
  }
}
async function searchDmsDatabases(settings,input,credentials,transport=call) {
  const {keyword,region}=searchConfig(input),auth=accessKeyCredentials(credentials);
  let response;
  try {response=await transport(expand(settings.python),['-I','-B',path.join(__dirname,'..','scripts','dms_ak.py'),'search','--database-keyword='+keyword,'--region='+region,'--profile=sqlquay'],auth);}
  catch {throw Error('DMS database search failed. Check this AccessKey, region and DMS permissions.');}
  if(response.stderr.includes('"cleanup_failed"')) throw new DmsStopped(locked.cleanup_failed);
  setupFailure(response);
  let result;try {result=JSON.parse(response.stdout);} catch { /* Refuse incomplete metadata. */ }
  if(response.code!==0 || response.stdoutOverflow || result?.status!=='success' || !Array.isArray(result.databases) || result.databases.length>100 || typeof result.more!=='boolean' || !result.databases.every(row=>
    object(row) && typeof row.databaseId==='string' && /^[1-9][0-9]{0,19}$/.test(row.databaseId) && typeof row.database==='string' && row.database.length>0 && row.database.length<=128 && typeof row.label==='string' && row.label.length<=512 && typeof row.engine==='string')) throw Error(setupMessages.search_failed);
  return {databases:result.databases,more:result.more};
}
async function dmsCatalog(settings,input,credentials,transport=call) {
  const keyword=typeof input.keyword==='string' ? input.keyword.trim() : '';
  if(!['instances','databases'].includes(input.kind) || keyword.length>128 || /[\x00-\x1f]/.test(keyword) || !/^[a-z]{2}-[a-z0-9-]{1,40}$/.test(input.region) || !Number.isInteger(input.page??1) || (input.page??1)<1 || (input.page??1)>10000 ||
    (input.kind==='databases' && (!/^[1-9][0-9]{0,19}$/.test(input.instanceId) || typeof input.instanceName!=='string' || !input.instanceName || input.instanceName.length>256 || /[\x00-\x1f]/.test(input.instanceName) || !environments.has(input.environment) || !engines.has(input.engine))) || (input.environment && !environments.has(input.environment)) || (input.engine && !engines.has(input.engine))) throw Error('Invalid DMS instance metadata. Search and choose the database again.');
  const args=['-I','-B',path.join(__dirname,'..','scripts','dms_ak.py'),input.kind,'--keyword='+keyword,'--region='+input.region,'--profile=sqlquay','--page='+(input.page??1),
    ...(input.instanceId?['--instance-id='+input.instanceId,'--instance-name='+input.instanceName]:[]),...(input.environment?['--environment='+input.environment]:[]),...(input.engine?['--engine='+input.engine]:[])];
  const response=await transport(expand(settings.python),args,accessKeyCredentials(credentials));
  if(response.stderr.includes('"cleanup_failed"')) throw new DmsStopped(locked.cleanup_failed);
  if(response.stderr.includes('"query_in_flight"')) throw Error(known.query_in_flight);
  setupFailure(response);
  let result;try {result=JSON.parse(response.stdout);} catch { /* Refuse incomplete metadata. */ }
  const rows=input.kind==='instances'?result?.instances:result?.databases;
  if(response.code!==0 || response.stdoutOverflow || result?.status!=='success' || !Array.isArray(rows) || rows.length>100 || result.page!==(input.page??1) || typeof result.more!=='boolean') throw Error(setupMessages.search_failed);
  for(const row of rows) {
    const metadata=targetMetadata(row);
    if(!metadata.instanceId || !metadata.instanceName || !metadata.engine || !metadata.environment) throw Error(setupMessages.search_failed);
    if(input.kind==='databases' && (row.instanceId!==input.instanceId || !/^[1-9][0-9]{0,19}$/.test(row.databaseId) || typeof row.database!=='string' || !row.database || row.database.length>128 || typeof row.keyword!=='string' || row.keyword!==row.database || typeof row.label!=='string' || row.label.length>1024)) throw Error(setupMessages.search_failed);
  }
  return result;
}
module.exports = {dmsCatalog,targetMetadata,dmsConfig,makeDms,DmsStopped,listDmsProfiles,parseProfiles,accessKeyCredentials,searchConfig,searchDmsDatabases,authMode,dmsAccountConfig,dmsTargets,isDmsAccount};
