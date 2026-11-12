"""Workbench's single-table preview. Accepts identifiers, never caller SQL."""
import argparse
import json
from pathlib import Path
import re
import sys

LIMIT = 100
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "policy"))
from engine_policy import drds_rows, drds_timeout, TABLESTORE_MESSAGE, compatible_policy

WAREHOUSE = {"selectdb", "doris"}
IDENTIFIER = re.compile(r"[\w$-]{1,128}")
SENSITIVE = re.compile(
    r"password|passwd|authentication[_-]?string|credential|secret|token|cookie|authorization|"
    r"(?:api|access|private)[_-]?key|phone|mobile|address|e[_-]?mail|"
    r"id[_-]?card|identity[_-]?card|open[_-]?id", re.I
)
SCALAR = re.compile(
    r"^(?:tinyint|smallint|mediumint|int|integer|bigint|largeint|decimal\w*|numeric|float|double|"
    r"bool|boolean|date|datetime\w*|time|timestamp|year|char|varchar|text|string)\b", re.I
)


class PreviewRefused(ValueError):
    pass


class ScanUnknown(PreviewRefused):
    pass


def quote(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise PreviewRefused("Unsupported preview identifier.")
    return "`" + value + "`"


def fields(rows):
    for row in rows:
        if isinstance(row, dict):
            yield {key.lower().replace("_", "").replace(" ", ""): value for key, value in row.items()}


def count(value):
    value = str(value).strip()
    return int(value.replace(",", "")) if re.fullmatch(r"[0-9]+(?:,[0-9]{3})*", value) else None


def scan_rows(engine, plan):
    if engine in WAREHOUSE:
        lines = "\n".join(str(v) for row in fields(plan) for v in row.values())
        scans = list(re.finditer(r"\b\w*ScanNode\b", lines, re.I))
        if len(scans) != 1 or scans[0][0].lower() not in {"volapscannode", "olapscannode"}:
            return None
        # Use the scan node's estimate, not a downstream node's cardinality.
        scan = re.split(r"(?m)^\s*[|+ -]*\d+\s*:", lines[scans[0].end():], maxsplit=1)[0]
        values = re.findall(r"(?im)^\s*\|?\s*cardinality\s*[:=]\s*([^\s]+)", scan)
        estimate = count(values[0].rstrip(",")) if len(values) == 1 else None
        return None if estimate == 0 and re.search(r"unknown.*statistics", lines, re.I) else estimate
    records = list(fields(plan))
    return count(records[0].get("rows")) if len(records) == len(plan) == 1 else None


def preview(guard, engine, schema, table, read, run):
    if engine == "ots":
        raise PreviewRefused(TABLESTORE_MESSAGE)
    relation = quote(schema) + "." + quote(table)
    definitions = list(fields(read("SHOW CREATE TABLE " + relation)))
    ddl = definitions[0].get("createtable") if len(definitions) == 1 else None
    if not isinstance(ddl, str) or not re.match(r"^\s*CREATE\s+TABLE\b", ddl, re.I):
        raise PreviewRefused("Only physical tables can be previewed.")
    engines = re.findall(r"(?i)\bENGINE\s*=\s*[`'\" ]*(\w+)", ddl)
    allowed = {"olap"} if engine in WAREHOUSE else {"innodb", "myisam", "memory", "aria", "archive", "csv", "ndb", "ndbcluster"}
    if any(value.lower() not in allowed for value in engines):
        raise PreviewRefused("External tables cannot be previewed.")
    columns = []
    for row in fields(read("DESCRIBE " + relation)):
        name = row.get("field", row.get("columnname"))
        kind = row.get("type", row.get("columntype"))
        if (isinstance(name, str) and IDENTIFIER.fullmatch(name) and not SENSITIVE.search(name)
                and isinstance(kind, str) and SCALAR.match(kind) and name not in columns):
            columns.append(name)
    if not columns:
        raise PreviewRefused("No supported non-sensitive columns to preview.")
    projection = ", ".join(map(quote, columns)) + " FROM " + relation
    if len(projection) > 48_000:
        raise PreviewRefused("Table projection is too wide to preview.")
    # LIMIT can cap cardinality; preflight the full scan instead.
    try:
        estimate = drds_rows("SELECT " + projection, read) if engine == "drds" else scan_rows(engine, read("EXPLAIN SELECT " + projection))
    except ValueError as exc:
        raise ScanUnknown(str(exc)) from exc
    ceiling = guard.ENGINE_ROW_LIMITS.get(engine)
    if estimate is None or ceiling is None or estimate > ceiling:
        raise ScanUnknown("Full-scan estimate is unknown or exceeds the scan limit.")
    hint = "SET_VAR(query_timeout=5)" if engine in WAREHOUSE else "MAX_EXECUTION_TIME(5000)"
    statement = f"SELECT /*+ {hint} */ {projection} LIMIT {LIMIT}"
    return run(drds_timeout(statement) if engine == "drds" else statement), columns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("safe-wrapper", "database-keyword", "schema", "db-id", "table"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--profile", default="dms-prod")
    parser.add_argument("--region", default="cn-hangzhou")
    parser.add_argument("--environment")
    parser.add_argument("--instance-id")
    parser.add_argument("--engine")
    args = parser.parse_args()
    wrapper = Path(args.safe_wrapper).resolve()
    if wrapper.name != "execute_safe.py" or not wrapper.is_file():
        parser.error("An installed execute_safe.py is required")
    sys.path.insert(0, str(wrapper.parent))
    import execute_safe as safe
    if not compatible_policy(safe, args.engine, args.instance_id):
        print(json.dumps({"status":"configuration_error","reason":"policy_incompatible"}), file=sys.stderr)
        return 2
    import query_guard as guard
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from dms_timed import instrument, report as report_timings
    timings = instrument(safe)

    def report(status):
        print(json.dumps({"status": status}), file=sys.stderr)
        return 3

    try:
        quote(args.schema)
        quote(args.table)
        with guard.single_query_lock():
            executor = safe.SafeDmsExecutor(profile=args.profile, region=args.region, timeout=10)
            try:
                executor.enable_ai_mode()
                target_options = {}
                if args.environment is not None: target_options["environment"] = args.environment
                if args.instance_id is not None: target_options["instance_id"] = args.instance_id
                target = executor.resolve_database(args.database_keyword, schema=args.schema, database_id=args.db_id, **target_options)

                def read(sql):
                    try:
                        return executor._execute_raw(target, sql)
                    except safe.DmsSafeQueryError as exc:
                        if re.search(r"time[ -]?out|timed out|deadline exceeded", str(exc), re.I):
                            raise safe.QueryStateUnknownError("Preview stopped after a timeout.") from exc
                        raise

                rows, columns = preview(guard, target.engine, target.schema, args.table, read, read)
            finally:
                try:
                    executor._ai_mode_enabled = True
                    executor.disable_ai_mode()
                except safe.DmsSafeQueryError:
                    report("cleanup_failed")
                    raise
        print(json.dumps({"status": "success", "source": "dms", "database_id": target.database_id,
                          "columns": columns, "rows": rows[:LIMIT]}, ensure_ascii=False))
        return 0
    except guard.QueryLockError:
        return report("query_in_flight")
    except safe.QueryStateUnknownError:
        return report("server_state_unknown")
    except ScanUnknown:
        return report("needs_split")
    except (PreviewRefused, safe.QueryRejectedError):
        return report("blocked")
    except safe.DmsSafeQueryError:
        return report("execution_failed")
    finally:
        report_timings(timings)


if __name__ == "__main__":
    sys.exit(main())
