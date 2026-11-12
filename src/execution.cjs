'use strict';
const {StringDecoder}=require('node:string_decoder');
const phases=new Set(['prepare','waiting','connect','resolve','preflight','execute','cleanup']);
const messages={"drds_multishard": "DRDS requires a single-shard plan. Add or narrow the shard-key condition.", "drds_shard_unknown": "DRDS shard count is unknown. Check EXPLAIN SHARDING before running.", "drds_plan_incomplete": "DRDS physical plan is incomplete. Use one table and verify EXPLAIN EXECUTE.", "scan_unknown": "The physical scan estimate is unknown. Check the execution plan or narrow the query.", "scan_limit": "The scan estimate exceeds the scan limit. Narrow the filter or split the query.", "index_unverified": "A bounded predicate must use a verified leading index. Adjust the WHERE condition.", "scope_required": "The query requires a bounded WHERE condition. LIMIT is not a scan boundary.", "explicit_columns": "SELECT * is not allowed. List the required columns explicitly.", "credential_field": "Credential or sensitive fields are not allowed in this query.", "authentication_failed": "Authentication failed. Check this connection's credentials.", "permission_denied": "Database access was denied. Check this connection's query permission.", "connection_failed": "JDBC connection failed. Check the host, port, network and TLS mode."};
function progressReader(onProgress) {
  const decoder=new StringDecoder('utf8');let pending='',discard=false;
  return chunk=>{
    pending+=decoder.write(chunk);
    let end;
    while((end=pending.indexOf('\n'))>=0) {
      const line=pending.slice(0,end);pending=pending.slice(end+1);
      if(!discard && line.length<=4096) {
        try {const value=JSON.parse(line);if(value?.status==='progress' && phases.has(value.phase)) onProgress?.(value.phase);} catch {}
      }
      discard=false;
    }
    if(pending.length>4096) {pending='';discard=true;}
  };
}
function safeDiagnostic(input) {
  const out={};
  if(!input || typeof input!=='object') return out;
  if(typeof input.code==='string' && Object.hasOwn(messages,input.code)) out.code=input.code;
  if(phases.has(input.phase)) out.phase=input.phase;
  for(const key of ['estimatedRows','maxRows','shards']) if(Number.isSafeInteger(input[key]) && input[key]>=0) out[key]=input[key];
  return out;
}
function attachDiagnostic(error,input) {
  const value=safeDiagnostic(input);
  if(Object.keys(value).length) error.diagnostic=value;
  return error;
}
function diagnosticError(input,fallback) {
  const value=safeDiagnostic(input);
  return attachDiagnostic(Error(messages[value.code]??fallback),value);
}
module.exports={progressReader,diagnosticError,attachDiagnostic};
