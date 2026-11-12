"""JDBC transport. SQL policy is owned by the installed, shared query guard."""
import argparse
import base64
import json
from pathlib import Path
from queue import Empty, Queue
import re
import subprocess
import sys
from threading import Thread
import time


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "policy"))
from engine_policy import drds_rows, drds_timeout
from workbench_runtime import progress, diagnostic, remember_failure, coded


class Refused(Exception):
    pass


class Unknown(Exception):
    pass


def policy(guard, engine, sql):
    if re.search(r"/\*\s*(?:M)?!|/\*\+|/\*\s*(?:TDDL|DRDS)\s*:", sql, re.I):
        raise Refused("Executable comments and optimizer hints are not supported.")
    text = guard.mask_string_literals(guard.strip_comments(sql), mask_backticks=True)
    if re.search(r"\b(?:FOR|LOCK|INTO|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|SLEEP|BENCHMARK|LOAD_FILE)\b", text, re.I):
        raise Refused("Locking clauses, INTO and side-effect or delay functions are not allowed in JDBC.")
    if re.match(r"\s*EXPLAIN\b", text, re.I) and re.search(r"\bANALYZE\b", text, re.I):
        raise Refused("EXPLAIN ANALYZE executes the query and is not supported.")
    if re.match(r"\s*SHOW\b", text, re.I) and not re.match(
        r"\s*SHOW\s+(?:(?:FULL\s+)?(?:TABLES|COLUMNS|FIELDS)|INDEX(?:ES)?|KEYS|CREATE\s+(?:TABLE|VIEW))\b",
        text, re.I,
    ):
        raise Refused("SHOW is limited to table, column and index metadata.")
    identifiers = guard.mask_string_literals(guard.strip_comments(sql), mask_backticks=False).replace("`", "")
    if re.search(r"\b(?:authentication_string|access_token|api_key|secret_key|private_key|access_key_secret)\b", identifiers, re.I):
        raise Refused("Credential fields are not allowed.")
    check = guard.validate_sql(sql, engine=engine)
    if not check["allowed"]:
        raise Refused("; ".join(check["violations"]))
    return check


def governed(guard, engine, check, run, limit):
    def as_records(result):
        if result["truncated"]:
            raise Refused("Incomplete preflight result; the data query was not sent.")
        columns = [col["name"] for col in result["columns"]]
        return [dict(zip(columns, row)) for row in result["rows"]]

    if check["preflight_required"]:
        if engine in {"mysql", "polardb", "drds"}:
            for table in check["tables"]:
                indexes = as_records(run("SHOW INDEX FROM " + guard.quote_table(table), 10000))
                if not guard.indexed_scope_columns(indexes, check["index_candidates"].get(table, [])):
                    raise Refused("A bounded predicate must use a verified leading index.")
        if engine == "drds":
            if len(check["tables"]) != 1:
                raise Refused("DRDS preflight supports one physical table at a time.")
            try:
                rows = drds_rows(check["sql"], lambda sql: as_records(run(sql, 10000)))
            except ValueError as exc:
                raise Refused(str(exc)) from exc
            if rows > check["max_estimated_rows"]:
                raise coded(Refused("DRDS physical scan estimate exceeds the scan limit."), "scan_limit", estimatedRows=rows, maxRows=check["max_estimated_rows"])
            return run(drds_timeout(check["sql"]), limit)
        plan = as_records(run(guard.explain_sql(check["sql"]), 10000))
        if engine == "doris":
            scans = re.findall(r"\b\w*ScanNode\b", str(plan), re.I)
            if not scans or any(scan.lower() not in ("volapscannode", "olapscannode") for scan in scans):
                raise Refused("The plan did not establish an internal Doris OLAP scan.")
        rows = guard.estimate_rows_from_explain(plan)
        if rows is None or rows > check["max_estimated_rows"]:
            raise coded(Refused("Scan estimate is unknown or above the limit. Narrow the query."),
                        "scan_unknown" if rows is None else "scan_limit", **({"estimatedRows":rows,"maxRows":check["max_estimated_rows"]} if rows is not None else {}))
    return run(check["sql"], limit)


def b64(value):
    return base64.b64encode(value.encode()).decode()


def exchange(proc, request, operation):
    response = Queue(maxsize=1)
    deadline = time.monotonic() + 24

    def receive():
        try:
            while True:
                line = proc.stdout.readline(6_500_000)
                if not line or not line.endswith("\n"):
                    response.put(None)
                    break
                response.put(json.loads(line))
        except (ValueError, OSError):
            response.put(None)

    Thread(target=receive, daemon=True).start()

    def send(line, may_have_executed=False):
        try:
            proc.stdin.write(line + "\n")
            proc.stdin.flush()
            reply = response.get(timeout=max(0.0, deadline - time.monotonic()))
        except (Empty, OSError) as exc:
            if may_have_executed:
                raise Unknown() from exc
            raise Refused("JDBC connection did not start. Check Java, TLS and network.") from exc
        if not isinstance(reply, dict):
            if may_have_executed:
                raise Unknown()
            raise Refused("Could not start JDBC. Check Java and driver settings.")
        if reply.get("error") == "sql":
            state = reply.get("state", "")
            code = reply.get("code", 0)
            if may_have_executed and (reply.get("timeout") is True or not state or state.startswith(("08", "HYT")) or code in (1317, 3024, 4202, 4203)):
                raise Unknown()
            error = Refused(f"JDBC SQLSTATE {state or 'unknown'} ({code}).")
            if state.startswith("28") or code == 1045:
                raise coded(error, "authentication_failed")
            if state == "42501" or code in (1044, 1142, 1143, 1227):
                raise coded(error, "permission_denied")
            raise error
        if reply.get("error") == "driver":
            raise Refused("Use the official MySQL Connector/J 8.0.12 or newer.")
        if reply.get("error") == "size":
            raise Refused("A result cell is too large. Select fewer or smaller values.")
        return reply

    reply = send(" ".join(b64(request[k]) for k in ("url", "user", "password", "sslMode")))
    if reply.get("ready") is not True:
        raise Refused("Could not start JDBC.")
    return operation(lambda sql, limit: send(f"{limit} {b64(sql)}", True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("guard")
    parser.add_argument("java")
    parser.add_argument("classpath")
    args = parser.parse_args()
    request = json.load(sys.stdin)
    guard_path = Path(args.guard).expanduser()
    if guard_path.name != "query_guard.py" or not guard_path.is_file():
        return {"error": "blocked", "message": "Installed shared query_guard.py was not found."}
    sys.path.insert(0, str(guard_path.resolve().parent))
    import query_guard as guard
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from preview_safe import LIMIT, PreviewRefused, preview, quote

    timings = {"preflight": 0, "execute": 0}

    def reply(value):
        return {**value, "timings": timings}

    def execute(raw_run):
        timings["connect"] = (time.perf_counter() - connect_start) * 1000

        def run(sql, limit):
            final = guard.first_token(sql) == "select" if is_preview else guard.strip_comments(sql).strip() == check["sql"]
            phase = "execute" if final else "preflight"
            progress(phase)
            start = time.perf_counter()
            try:
                return raw_run(sql, limit)
            except Exception as error:
                remember_failure(error)
                raise
            finally:
                timings[phase] += (time.perf_counter() - start) * 1000
        if not is_preview:
            return governed(guard, request["engine"], check, run, request["limit"])

        def read(sql):
            result = run(sql, 10000)
            if result["truncated"]:
                raise PreviewRefused("Incomplete preview metadata or scan estimate.")
            names = [column["name"] for column in result["columns"]]
            return [dict(zip(names, row)) for row in result["rows"]]

        result, _ = preview(guard, request["engine"], request["schema"], request["table"], read,
                            lambda sql: run(sql, LIMIT))
        return result

    try:
        progress("preflight")
        is_preview = "table" in request
        if is_preview:
            quote(request["schema"])
            quote(request["table"])
        else:
            check = policy(guard, request["engine"], request["sql"])
        progress("waiting")
        with guard.single_query_lock():
            progress("connect")
            connect_start = time.perf_counter()
            proc = subprocess.Popen(
                [args.java, "-Xmx128m", "-cp", args.classpath, "WorkbenchJdbc"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8")
            try:
                return reply(exchange(proc, request, execute))
            except Exception as error:
                remember_failure(error)
                raise
            finally:
                progress("cleanup")
                proc.stdin.close()
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
    except (Refused, PreviewRefused, guard.QueryLockError, FileNotFoundError) as exc:
        return reply({"error": "blocked", "message": str(exc) if not isinstance(exc, FileNotFoundError) else "Java executable was not found.", "diagnostic":diagnostic(exc)})
    except Unknown as error:
        return reply({"error": "unknown", "diagnostic":diagnostic(error)})


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False))
