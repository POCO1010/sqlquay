"""Exact DMS identities and guarded DRDS plans; unknown engines fail closed."""
import re
from workbench_runtime import coded

ENVIRONMENTS = {"product", "test", "dev", "pre", "sit", "uat", "pet", "stag"}
ENGINE_TYPES = {
    "mysql": "mysql", "rds": "rds", "polardb": "polardb", "polardb_mysql": "polardb",
    "doris": "doris", "selectdb": "selectdb", "drds": "drds", "polardbx": "drds",
    "polardb-x": "drds", "ots": "ots", "tablestore": "ots",
}
TABLESTORE_MESSAGE = "Tablestore supports databases, tables and DDL only. Data queries and previews require verified EXPLAIN support."

def timeout_message(message):
    return bool(re.search(r"execute script timeout|ERR_SQL_QUERY(?:_MERGE)?_TIMEOUT|TDDL[- :]?420[23]|\b(?:timed?\s*out|query timeout)\b", str(message), re.I))

def compatible_policy(safe, engine, instance_id):
    required = set()
    if engine == "drds": required.add("drds-single-shard-v1")
    if engine == "ots": required.add("ots-schema-only-v1")
    if instance_id: required.add("instance-target-v1")
    return required.issubset(getattr(safe, "POLICY_CAPABILITIES", ()))

def engine_type(value):
    return ENGINE_TYPES.get(str(value).lower())

def drds_rows(sql, read):
    shards = read("EXPLAIN SHARDING " + sql)
    counts = [str(next((v for k, v in row.items() if k.upper() == "SHARD_COUNT"), "")) for row in shards]
    if len(counts) != 1 or counts[0] != "1":
        known = len(counts) == 1 and re.fullmatch(r"[0-9]+", counts[0]) and int(counts[0]) > 1
        raise coded(ValueError("DRDS requires a verified single-shard plan. Narrow the shard-key predicate."),
                    "drds_multishard" if known else "drds_shard_unknown", **({"shards":int(counts[0])} if known else {}))
    plan = read("EXPLAIN EXECUTE " + sql)
    if len(plan) != 1:
        raise coded(ValueError("DRDS physical scan estimate is incomplete."), "drds_plan_incomplete")
    value = next((v for k, v in plan[0].items() if k.lower() == "rows"), None)
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+", str(value)):
        raise coded(ValueError("DRDS physical scan estimate is unknown."), "scan_unknown")
    return int(value)

def drds_timeout(sql):
    return "/*TDDL:SOCKET_TIMEOUT=5000*/ " + sql
