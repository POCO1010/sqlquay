"""Synthetic plans follow documented DRDS SHARD_COUNT / MySQL rows fields."""
from pathlib import Path
import contextlib
import json
import sys
sys.path[:0] = [str(Path(__file__).resolve().parent.parent / "policy"), str(Path(__file__).resolve().parent.parent / "scripts")]
import query_guard as guard
import engine_policy as engines
import execute_safe as safe
import jdbc_guard as jdbc
from preview_safe import preview, PreviewRefused

assert engines.engine_type("drds") == "drds"
assert engines.engine_type("polardb_mysql") == "polardb"
assert engines.engine_type("polardb_pg") is None
assert engines.engine_type("ots") == "ots"
for env in engines.ENVIRONMENTS:
    row = dict(SchemaName="sandbox", DatabaseId="42", DbType="mysql", EnvType=env, InstanceId="7")
    runner = lambda args: (0, json.dumps({"DatabaseList":{"Database":[row]}}), "")
    executor = safe.SafeDmsExecutor(runner=runner)
    assert executor.resolve_database("sandbox",schema="sandbox",database_id="42",environment=env,instance_id="7").environment == env
    try: executor.resolve_database("sandbox",schema="sandbox",database_id="42",environment=env,instance_id="8")
    except safe.QueryRejectedError: pass
    else: raise AssertionError("instance mismatch accepted")
for engine in ["mysql","polardb","drds","selectdb","ots"]:
    row = dict(SchemaName="sandbox", DatabaseId="42", DbType=engine, EnvType="product")
    executor=safe.SafeDmsExecutor(runner=lambda args:(0,json.dumps({"SearchDatabaseList":{"SearchDatabase":[row]}}),""))
    assert executor.resolve_database("sandbox").engine == engine
assert not guard.validate_sql("SELECT id FROM products WHERE id=1 LIMIT 1",engine="ots")["allowed"]
assert guard.validate_sql("SHOW CREATE TABLE `products`",engine="ots")["allowed"]
assert not guard.validate_sql("SELECT /*TDDL:SOCKET_TIMEOUT=900000*/ id FROM products WHERE id=1 LIMIT 1",engine="drds")["allowed"]
assert guard.validate_sql("SELECT '/*TDDL:foo*/' AS note",engine="mysql")["allowed"]
for shards in [0,2,None]:
    try: engines.drds_rows("SELECT id FROM products", lambda sql:[{"SHARD_COUNT":shards}])
    except ValueError: pass
    else: raise AssertionError("unverified distributed scan accepted")
calls=[]
def read(sql):
    calls.append(sql)
    if sql.startswith("SHOW CREATE"): return [{"Create Table":"CREATE TABLE products (id BIGINT) ENGINE=InnoDB"}]
    if sql.startswith("DESCRIBE"): return [{"Field":"id","Type":"BIGINT"}]
    if sql.startswith("SHOW INDEX"): return [{"Key_name":"PRIMARY","Column_name":"id","Seq_in_index":1}]
    if sql.startswith("EXPLAIN SHARDING"): return [{"SHARD_COUNT":1}]
    if sql.startswith("EXPLAIN EXECUTE"): return [{"rows":100000}]
    if sql.startswith("/*TDDL:SOCKET_TIMEOUT=5000*/"): return [{"id":1}]
    raise AssertionError(sql)
assert engines.drds_rows("SELECT id FROM products",read)==100000
result,cols=preview(guard,"drds","sandbox","products",read,read)
assert cols==["id"] and result==[{"id":1}]
assert any(sql.startswith("EXPLAIN SHARDING SELECT `id`") and "LIMIT" not in sql for sql in calls)
assert calls[-1].endswith("LIMIT 100")
assert not any(sql.startswith("EXPLAIN ANALYZE") for sql in calls)
try: preview(guard,"ots","sandbox","products",lambda sql:(_ for _ in ()).throw(AssertionError("OTS data path reached")),read)
except PreviewRefused: pass
else: raise AssertionError("OTS preview was accepted")
check=guard.validate_sql("SELECT id FROM products WHERE id=1 LIMIT 1",engine="drds")
def grid(sql,limit):
    rows=read(sql)
    keys=list(rows[0])
    return dict(columns=[dict(name=k) for k in keys],rows=[[r[k] for k in keys] for r in rows],truncated=False)
assert jdbc.governed(guard,"drds",check,grid,200)["rows"]==[[1]]
# Both default locks are acquired; explicit test paths remain fully isolated.
held=[]
original=guard._file_lock
@contextlib.contextmanager
def fake_lock(**kwargs):
    held.append(str(kwargs["path"]))
    yield
try:
    guard._file_lock=fake_lock
    with guard.single_query_lock(): pass
finally: guard._file_lock=original
assert held==["/tmp/ahyk-production-read-query.lock","/tmp/sqlquay-read-query.lock"]
# A later catalog page must remain an executable exact target.
pages=[]
def paged(args):
    number=int(args[args.index("--page-number")+1]);pages.append(number)
    rows=[dict(SchemaName="sandbox_"+str(i),DatabaseId=str(1000+i),DbType="mysql",EnvType="test",InstanceId="7") for i in range(100)] if number==1 else [dict(SchemaName="sandbox",DatabaseId="42",DbType="mysql",EnvType="test",InstanceId="7")]
    return 0,json.dumps({"Success":True,"TotalCount":101,"DatabaseList":{"Database":rows}}),""
ex=safe.SafeDmsExecutor(runner=paged)
assert ex.resolve_database("sandbox",schema="sandbox",database_id="42",environment="test",instance_id="7").database_id=="42"
assert pages==[1,2]
from types import SimpleNamespace
assert engines.compatible_policy(SimpleNamespace(),"mysql",None)
for engine,instance in [("drds",None),("ots",None),("mysql","7")]:
    assert not engines.compatible_policy(SimpleNamespace(),engine,instance)
    assert engines.compatible_policy(safe,engine,instance)
for message in ["ERR_SQL_QUERY_TIMEOUT", "ERR_SQL_QUERY_MERGE_TIMEOUT", "ERR-CODE: [TDDL-4202]", "TDDL-4203"]:
    requests=[]
    def timed(args):
        requests.append(args)
        if args[1]=="search-database":
            return 0,json.dumps({"SearchDatabaseList":{"SearchDatabase":[dict(SchemaName="sandbox",DatabaseId="42",DbType="drds",EnvType="product")]}}),""
        return 0,json.dumps({"Results":[{"Success":False,"Message":message}]}),""
    ex=safe.SafeDmsExecutor(runner=timed)
    target=ex.resolve_database("sandbox")
    try: ex._execute_raw(target,"SELECT 1")
    except safe.QueryStateUnknownError: pass
    else: raise AssertionError("DRDS timeout did not retain unknown-state semantics")
    assert len(requests)==2
# External old wrappers keep old calls but cannot receive new engine traffic.
import subprocess
from tempfile import TemporaryDirectory
with TemporaryDirectory(prefix="sqlquay-policy-capability-") as directory:
    wrapper=Path(directory)/"execute_safe.py"
    mark=Path(directory)/"executed"
    wrapper.write_text("class SafeDmsExecutor: pass\ndef main():\n from pathlib import Path\n Path("+repr(str(mark))+").write_text('legacy call')\n return 0\n")
    entry=str(Path(__file__).resolve().parent.parent/"scripts/dms_timed.py")
    common=[sys.executable,"-I","-B",entry,str(wrapper),"--sql=SELECT 1"]
    failed=subprocess.run(common+["--engine=drds"],capture_output=True,text=True)
    assert failed.returncode==2 and 'policy_incompatible' in failed.stderr and not mark.exists(),failed.stderr
    old=subprocess.run(common+["--engine=mysql"],capture_output=True,text=True)
    assert old.returncode==0 and mark.exists(),old.stderr
# Auto-detection must inspect actual metadata even with an old wrapper's loose classifier.
from dms_timed import instrument
for raw in ["mysql", "drds", "ots"]:
    class LegacyExecutor:
        def command_json(self, command, extra):
            return {"SearchDatabaseList":{"SearchDatabase":[dict(DatabaseId="42",SchemaName="sandbox",DbType=raw)]}}
        def resolve_database(self, *args, **kwargs):
            self.command_json("search-database", [])
            return SimpleNamespace(engine="rds")
    legacy=SimpleNamespace(SafeDmsExecutor=LegacyExecutor,QueryRejectedError=safe.QueryRejectedError)
    instrument(legacy)
    executor=legacy.SafeDmsExecutor()
    try: executor.resolve_database("sandbox",schema="sandbox",database_id="42")
    except safe.QueryRejectedError:
        assert raw in {"drds", "ots"}
    else: assert raw == "mysql"
print("ENGINE_ADAPTER_FIXTURE_PASS")
