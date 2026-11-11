import sys
from pathlib import Path
from tempfile import TemporaryDirectory
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'policy'))
import query_guard as guard
from execute_safe import SafeDmsExecutor,DmsSafeQueryError

assert guard.ENGINE_ROW_LIMITS['mysql']==100000
assert guard.ENGINE_ROW_LIMITS['doris']==10000000
assert not guard.validate_sql('SELECT id FROM products LIMIT 1')['allowed']
assert not guard.validate_sql('SELECT id FROM products WHERE id=1; DELETE FROM products')['allowed']
assert not guard.validate_sql('SELECT password FROM users WHERE id=1 LIMIT 1')['allowed']
check=guard.validate_sql('SELECT id FROM products WHERE id=1 LIMIT 1',engine='mysql')
assert check['allowed'] and check['preflight_required'] and not check['execution_allowed']
assert guard.validate_sql(check['sql'],engine='mysql',estimated_rows=100000)['execution_allowed']
assert not guard.validate_sql(check['sql'],engine='mysql',estimated_rows=100001)['execution_allowed']
assert guard.indexed_scope_columns([{'Key_name':'PRIMARY','Seq_in_index':1,'Column_name':'id'}],['id'])=={'id'}
assert not guard.indexed_scope_columns([{'Key_name':'PRIMARY','Seq_in_index':2,'Column_name':'id'}],['id'])
assert not guard.indexed_scope_columns([{'Key_name':'PRIMARY','Column_name':'id'}],['id'])
assert guard.estimate_rows_from_explain([{'rows':1000},{'rows':1000}])==1000000
assert guard.estimate_rows_from_explain([{'rows':'unknown'}]) is None
for fail in ['enable','set-user-agent']:
 calls=[]
 def run(args):
  calls.append(args)
  assert args[args.index('--profile')+1]=='dms-prod'
  return (1,'','fixture failure') if args[2]==fail else (0,'','')
 executor=SafeDmsExecutor(runner=run)
 try:
  executor.enable_ai_mode()
 except DmsSafeQueryError:
  pass
 else:
  raise AssertionError('fixture did not fail')
 finally:
  executor.disable_ai_mode()
 assert sum(args[2]=='disable' for args in calls)==1
with TemporaryDirectory(prefix='sqlquay-policy-test-') as directory:
 lock=Path(directory)/'lock'
 with guard.single_query_lock(path=lock):
  try:
   with guard.single_query_lock(path=lock):
    raise AssertionError('parallel query lock was not enforced')
  except guard.QueryLockError:
   pass
