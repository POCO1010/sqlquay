"""Only synthetic executors and private locks; no real CLI or credential access."""
import contextlib,io,json,sys
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"policy"))
import execute_safe as safe
import query_guard as guard
from workbench_runtime import lifecycle_lock
original=safe.SafeDmsExecutor
with TemporaryDirectory(prefix="sqlquay-lifecycle-") as directory:
 lock=Path(directory)/"fixture.lock"
 real_lock=partial(guard.single_query_lock,path=lock)
 safe.single_query_lock=real_lock
 calls=[];cleanup_locked=[];failure=None
 def runner(args):
  calls.append(args[:3])
  if args[:2]==["configure","ai-mode"]:
   if args[2]=="disable":
    try:
     with real_lock():pass
    except guard.QueryLockError:cleanup_locked.append(True)
    else:cleanup_locked.append(False)
   if failure==args[2]:return 1,"","AccessDenied fixture-secret"
   return 0,"",""
  if args[1]=="search-database":
   return 0,json.dumps({"SearchDatabaseList":{"SearchDatabase":[dict(DatabaseId="42",SchemaName="sandbox",EnvType="product",DbType="mysql")]}}),""
  if args[1]=="execute-script":return 0,json.dumps({"Results":[{"Success":True,"Rows":[{"probe":1}]}]}),""
  raise AssertionError(args)
 safe.SafeDmsExecutor=lambda:original(runner=runner)
 sys.argv=["execute_safe.py","--database-keyword=sandbox","--schema=sandbox","--db-id=42","--sql=SELECT 1 AS probe"]
 with real_lock(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):result=safe.main()
 assert result==5 and calls==[],calls
 with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):result=safe.main()
 assert result==0 and cleanup_locked==[True],cleanup_locked
 with real_lock():pass
 assert safe.single_query_lock is real_lock
 for failure in ("enable", "disable"):
  output=io.StringIO();errors=io.StringIO()
  with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):result=safe.main()
  assert result==(3 if failure=="enable" else 0)
  assert cleanup_locked[-1] is True
  if failure=="disable":assert '"status": "cleanup_failed"' in errors.getvalue()
  with real_lock():pass
 failure=None
 # An older approved main can borrow only its own lifecycle lock; other callers still contend.
 legacy=SimpleNamespace(single_query_lock=real_lock)
 with lifecycle_lock(legacy):
  with legacy.single_query_lock():pass
  with legacy.single_query_lock():pass
  try:
   with legacy.single_query_lock(path=lock):pass
  except guard.QueryLockError:pass
  else:raise AssertionError("an explicit lock was borrowed")
  thread_result=[]
  def contend():
   try:
    with legacy.single_query_lock():pass
   except guard.QueryLockError:thread_result.append("blocked")
  thread=Thread(target=contend);thread.start();thread.join()
  assert thread_result==["blocked"],thread_result
  with lifecycle_lock(legacy):
   with legacy.single_query_lock():pass
 assert legacy.single_query_lock is real_lock
 try:
  with lifecycle_lock(legacy):raise RuntimeError("fixture failure")
 except RuntimeError:pass
 assert legacy.single_query_lock is real_lock
 with real_lock():pass
from workbench_runtime import diagnostic
from engine_policy import drds_rows
for count,code in [(2,"drds_multishard"),(None,"drds_shard_unknown")]:
 try:drds_rows("SELECT id FROM products",lambda _: [{"SHARD_COUNT":count}])
 except ValueError as error:assert diagnostic(error)["code"]==code
 else:raise AssertionError("unverified shard accepted")
assert diagnostic(ValueError("DRDS physical scan estimate is unknown."))["code"]=="scan_unknown"
assert "fixture-secret" not in json.dumps(diagnostic(ValueError("AccessDenied fixture-secret")))
print("LIFECYCLE_RUNTIME_FIXTURE_PASS")
