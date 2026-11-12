'use strict';
const {spawn} = require('node:child_process');
const {accessSync, constants} = require('node:fs');
const path = require('node:path');
const {homedir} = require('node:os');
const {readonly} = require('./query.cjs');
const {progressReader,diagnosticError,attachDiagnostic}=require('./execution.cjs');
class UnknownState extends Error {
  constructor() { super('JDBC may still be running on the server. Confirm the query ended before unlocking.'); }
}
const expand = input => input.startsWith('~/') ? path.join(homedir(), input.slice(2)) : input;
function connectionConfig(input) {
  const trim = key => typeof input[key] === 'string' ? input[key].trim() : '';
  const name = trim('name'), group = trim('group'), engine = trim('engine'), host = trim('host'), database = trim('database');
  const port = Number(trim('port'));
  if (!name || name.length > 80 || group.length > 80 || /[\r\n\t]/.test(name + group)) throw Error('Enter a connection name (80 characters maximum).');
  if (!['mysql','polardb','drds','doris'].includes(engine) || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z0-9_-]{1,128}$/i.test(database)) throw Error('Enter a host name, port and exact database. JDBC URLs and connection options are not accepted.');
  const sslMode = input.sslMode ?? 'VERIFY_IDENTITY';
  if (!['VERIFY_IDENTITY','DISABLED'].includes(sslMode)) throw Error('Choose a supported JDBC TLS mode.');
  const environment=trim('environment');
  if(environment && !['product','test','dev','pre','sit','uat','pet','stag'].includes(environment)) throw Error('Choose a supported environment label.');
  return {name, group, engine, host, port, database, sslMode,...(environment?{environment}:{})};
}
function call(command, args, body, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['pipe','pipe','pipe'], windowsHide: true});
    let bytes = 0, chunks = [];
    child.stderr.on('data',progressReader(onProgress));
    child.on('error', error => reject(error.code === 'ENOENT' ? Error('Python executable was not found.') : new UnknownState()));
    child.stdin.on('error', () => { /* exit status distinguishes a rejected or indeterminate run */ });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 7_000_000) child.kill();
      else chunks.push(chunk);
    });
    child.once('close', code => {
      if (code !== 0) return reject(new UnknownState());
      try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(new UnknownState()); }
    });
    child.stdin.end(JSON.stringify(body));
  });
}
function makeJdbc(settings, extensionPath, transport = call) {
  return async (connection, credentials, sql, limit = 200, table) => {
    const statement = table === undefined ? readonly(sql) : undefined;
    settings.onProgress?.('prepare');
    const jar = expand(settings.jar), guard = expand(settings.guard);
    if (!path.isAbsolute(jar) || !jar.toLowerCase().endsWith('.jar') || jar.includes(path.delimiter)) throw Error('Set dbWorkbench.driverJar to an absolute MySQL Connector/J JAR path.');
    try { accessSync(jar, constants.R_OK); accessSync(guard, constants.R_OK); }
    catch { throw Error('JDBC driver or shared SQL guard is not readable. Check SQLQuay settings.'); }
    // Display labels do not change the existing transport contract.
    const target = connectionConfig({...connection, port:String(connection.port), environment:undefined});
    const payload = {url: 'jdbc:mysql://' + target.host + ':' + target.port + '/' + encodeURIComponent(target.database), engine: target.engine, sslMode:target.sslMode,
      user:credentials.user, password:credentials.password, sql:statement, limit,
      ...(table === undefined ? {} : {table,schema:target.database})};
    const response = await transport(expand(settings.python), ['-I','-B',path.join(extensionPath,'scripts','jdbc_guard.py'), guard, expand(settings.java),
      [path.join(extensionPath,'build','jdbc'),jar].join(path.delimiter)], payload, settings.onProgress);
    if (response?.error) {
      const error=response.error==='unknown' ? attachDiagnostic(new UnknownState(),response.diagnostic) : diagnosticError(response.diagnostic,response.message??'JDBC execution failed.');
      error.timings=response.timings;throw error;
    }
    if (!Array.isArray(response?.columns) || !response.columns.every(c => typeof c?.name === 'string' && typeof c.type === 'string') ||
        !Array.isArray(response.rows) || response.rows.length > limit || !response.rows.every(r => Array.isArray(r) && r.length === response.columns.length && r.every(x => x === null || typeof x === 'string')) || typeof response.truncated !== 'boolean') throw Error('Invalid JDBC result.');
    return response;
  };
}
module.exports = {makeJdbc, UnknownState, connectionConfig, expand};
