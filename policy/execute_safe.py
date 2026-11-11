#!/usr/bin/env python3
"""Execute one governed production read query through Alibaba Cloud DMS CLI.

All table queries are serialized, statically bounded, checked against source
indexes when applicable, and EXPLAINed before execution. Timeouts stop the
batch; traced pilot queries also attempt targeted cancellation and readback.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from query_guard import (
    QueryLockError,
    build_date_batches,
    estimate_rows_from_explain,
    explain_sql,
    first_token,
    indexed_scope_columns,
    mask_string_literals,
    quote_table,
    single_query_lock,
    strip_comments,
    validate_batch_queries,
    validate_sql,
)


PROFILE = "dms-prod"
USER_AGENT = "AlibabaCloud-Agent-Skills/alibabacloud-dms-skill"
SOURCE_ENGINES = {"mysql", "rds", "polardb", "source"}


@dataclass(frozen=True)
class DatabaseTarget:
    database_id: str
    engine: str
    schema: str
    environment: str


class DmsSafeQueryError(RuntimeError):
    batch_progress: dict[str, Any] | None = None
    query_trace_id: str | None = None


class QueryRejectedError(DmsSafeQueryError):
    pass


class QueryNeedsSplitError(QueryRejectedError):
    """The SQL needs a smaller physical scan; the question remains in progress."""


class QueryStateUnknownError(DmsSafeQueryError):
    pass


class QueryTimeoutStoppedError(DmsSafeQueryError):
    stop_evidence: str | None = None


Runner = Callable[[list[str]], tuple[int, str, str]]


class SafeDmsExecutor:
    """DMS CLI adapter with fail-closed cost and concurrency gates."""

    def __init__(
        self,
        *,
        runner: Runner | None = None,
        profile: str = PROFILE,
        region: str = "cn-hangzhou",
        timeout: int = 45,
    ) -> None:
        self.profile = profile
        self.region = region
        self.timeout = timeout
        self.cli = None if runner else self._find_cli()
        self.runner = runner or self._run_cli
        self._ai_mode_enabled = False
        self._resolved_targets: set[DatabaseTarget] = set()

    @staticmethod
    def _find_cli() -> str:
        cli = shutil.which("aliyun")
        if not cli:
            raise DmsSafeQueryError("aliyun CLI is not installed.")
        return cli

    def _run_cli(self, args: list[str]) -> tuple[int, str, str]:
        try:
            result = subprocess.run(
                [self.cli, *args],
                text=True,
                capture_output=True,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise QueryStateUnknownError(
                "DMS client timed out; the server-side statement state is unknown. Stop the batch and inspect query audit before any retry."
            ) from exc
        return result.returncode, result.stdout, result.stderr

    def _api_args(self, command: str, extra: list[str]) -> list[str]:
        return [
            "dms-enterprise", command, *extra,
            "--region", self.region,
            "--profile", self.profile,
            "--user-agent", USER_AGENT,
            "--read-timeout", "30",
            "--connect-timeout", "10",
        ]

    def _run_json(self, args: list[str]) -> dict[str, Any]:
        code, out, err = self.runner(args)
        if code != 0:
            message = err.strip() or out.strip() or "DMS CLI failed."
            if args[:2] == ["dms-enterprise", "execute-script"] and "execute script timeout" in message.lower():
                raise QueryStateUnknownError(
                    "DMS reported an execute-script timeout; the server-side statement state is unknown. "
                    "Stop the batch and inspect query audit before any retry."
                )
            raise DmsSafeQueryError(message)
        try:
            payload = json.loads(out)
        except json.JSONDecodeError as exc:
            raise DmsSafeQueryError("DMS CLI returned non-JSON output.") from exc
        if not isinstance(payload, dict):
            raise DmsSafeQueryError("DMS CLI returned an unexpected JSON payload.")
        return payload

    def enable_ai_mode(self) -> None:
        commands = (
            ["configure", "ai-mode", "enable", "--profile", self.profile],
            [
                "configure", "ai-mode", "set-user-agent",
                "--user-agent", USER_AGENT, "--profile", self.profile,
            ],
        )
        # Even partial enablement must be followed by a disable attempt.
        self._ai_mode_enabled = True
        for command in commands:
            code, out, err = self.runner(command)
            if code != 0:
                raise DmsSafeQueryError(err.strip() or out.strip() or "Failed to enable DMS AI mode.")
        self._ai_mode_enabled = True

    def disable_ai_mode(self) -> None:
        if not self._ai_mode_enabled:
            return
        code, out, err = self.runner([
            "configure", "ai-mode", "disable", "--profile", self.profile,
        ])
        self._ai_mode_enabled = False
        if code != 0:
            raise DmsSafeQueryError(err.strip() or out.strip() or "Failed to disable DMS AI mode.")

    def command_json(self, command: str, extra: list[str]) -> dict[str, Any]:
        return self._run_json(self._api_args(command, extra))

    def resolve_database(
        self,
        search_key: str,
        *,
        schema: str | None = None,
        database_id: str | None = None,
        environment: str = "product",
    ) -> DatabaseTarget:
        payload = self.command_json(
            "search-database",
            ["--search-key", search_key, "--page-number", "1", "--page-size", "100"],
        )
        rows = payload.get("SearchDatabaseList", {}).get("SearchDatabase", [])
        candidates = [row for row in rows if isinstance(row, dict)]
        if schema:
            candidates = [row for row in candidates if row.get("SchemaName") == schema]
        if database_id:
            candidates = [row for row in candidates if str(row.get("DatabaseId")) == str(database_id)]
        if environment:
            candidates = [
                row for row in candidates
                if str(row.get("EnvType") or "").lower() == environment.lower()
            ]
        if len(candidates) != 1:
            summary = ", ".join(
                f"{row.get('DatabaseId')}:{row.get('SchemaName')}/{row.get('DbType')}/{row.get('EnvType')}"
                for row in candidates
            )
            raise QueryRejectedError(
                f"Database metadata did not resolve to one target: {summary or 'no candidate'}."
            )
        row = candidates[0]
        db_type = str(row.get("DbType") or "").lower()
        if "selectdb" in db_type:
            engine = "selectdb"
        elif "doris" in db_type:
            engine = "doris"
        elif "polar" in db_type:
            engine = "polardb"
        elif "rds" in db_type:
            engine = "rds"
        elif "mysql" in db_type:
            engine = "mysql"
        else:
            raise QueryRejectedError(f"Unsupported DMS database engine: {db_type or 'unknown'}")
        target = DatabaseTarget(
            database_id=str(row["DatabaseId"]),
            engine=engine,
            schema=str(row.get("SchemaName") or schema or search_key),
            environment=str(row.get("EnvType") or ""),
        )
        self._resolved_targets.add(target)
        return target

    def _verify_resolved_target(self, target: DatabaseTarget) -> None:
        if target not in self._resolved_targets:
            raise QueryRejectedError(
                "Database target was not resolved from DMS metadata by this executor; caller-supplied engine/database metadata is not trusted."
            )

    def _execute_raw(self, target: DatabaseTarget, sql: str) -> list[dict[str, Any]]:
        self._verify_resolved_target(target)
        payload = self.command_json(
            "execute-script",
            ["--db-id", target.database_id, "--logic", "false", "--script", sql],
        )
        results = payload.get("Results") or []
        if not results or not results[0].get("Success"):
            message = results[0].get("Message") if results else None
            if message and "execute script timeout" in str(message).lower():
                raise QueryStateUnknownError(
                    "DMS reported an execute-script timeout; the server-side statement state is unknown. "
                    "Stop the batch and inspect query audit before any retry."
                )
            raise DmsSafeQueryError(message or "DMS SQL execution failed.")
        rows = results[0].get("Rows") or []
        return rows if isinstance(rows, list) else []

    def _verify_source_indexes(self, target: DatabaseTarget, check: dict[str, Any]) -> None:
        for table in check["tables"]:
            candidates = check["index_candidates"].get(table) or []
            if not candidates:
                raise QueryRejectedError(
                    f"Source table {table} has no qualified bounded/JOIN column for index validation."
                )
            rows = self._execute_raw(target, f"SHOW INDEX FROM {quote_table(table)}")
            if not rows:
                raise QueryRejectedError(
                    f"Source table {table} has no readable index metadata; query execution is blocked."
                )
            if not indexed_scope_columns(rows, candidates):
                raise QueryRejectedError(
                    f"Source table {table} has no leading index on its bounded/JOIN columns."
                )

    def _single_tablet_row_count(
        self, target: DatabaseTarget, check: dict[str, Any], explain_rows: list[dict[str, Any]]
    ) -> tuple[str, int] | None:
        """Use fresh physical metadata only when the plan proves one matching scan."""
        if target.engine not in {"selectdb", "doris"} or len(check["tables"]) != 1:
            return None
        table = check["tables"][0].lower()
        parts = table.split(".")
        if len(parts) == 2 and parts[0] != target.schema.lower():
            return None
        table_name = parts[-1]
        statement = mask_string_literals(strip_comments(check["sql"]))
        requested = re.findall(r"(?i)\btablet\s*\(\s*(\d+)\s*\)", statement)
        if len(requested) != 1:
            return None
        tablet_id = requested[0]
        plan = "\n".join(str(value) for row in explain_rows for value in row.values())
        if len(re.findall(r"(?i)\bV?OlapScanNode\b", plan)) != 1:
            return None
        plan_tables = re.findall(r"(?im)^\s*TABLE:\s*([^,(\s]+)", plan)
        if len(plan_tables) != 1 or plan_tables[0].replace("`", "").lower() not in {
            table_name, f"{target.schema.lower()}.{table_name}"
        }:
            return None
        scans = re.findall(r"(?i)\btablets\s*=\s*(\d+)\s*/\s*(\d+)\s*,\s*tabletList\s*=\s*([\d, ]+)", plan)
        if len(scans) != 1 or scans[0][0] != "1" or scans[0][2].strip() != tablet_id:
            return None

        # SHOW is read under the same workstation lock as EXPLAIN and execution.
        tablet_rows = self._execute_raw(target, f"SHOW TABLETS FROM {quote_table(table_name)}")
        matches = [row for row in tablet_rows if str(row.get("TabletId")) == tablet_id]
        if not matches:
            return None
        versions = {str(row.get("Version", "")) for row in matches}
        schema_hashes = {str(row.get("SchemaHash", "")) for row in matches}
        if "" in versions or len(versions) != 1 or "" in schema_hashes or len(schema_hashes) != 1:
            return None
        counts = []
        for row in matches:
            row_count = str(row.get("RowCount", ""))
            if str(row.get("State", "")).upper() != "NORMAL" or not re.fullmatch(r"\d+", row_count):
                return None
            counts.append(int(row_count))
        # SHOW TABLETS returns one row per replica; use the largest healthy replica as the conservative scan budget.
        return tablet_id, max(counts)

    def _bounded_pilot_plan(
        self, target: DatabaseTarget, check: dict[str, Any], explain_rows: list[dict[str, Any]]
    ) -> bool:
        """Accept one small aggregate probe only when its key range reaches storage."""
        if target.engine not in {"selectdb", "doris"} or len(check["tables"]) != 1:
            return False
        if not check["is_aggregate"] or check["risk_flags"]:
            return False
        table = check["tables"][0].lower()
        parts = table.split(".")
        if len(parts) == 2 and parts[0] != target.schema.lower():
            return False
        statement = strip_comments(check["sql"])
        if re.search(r"(?i)\bor\b", mask_string_literals(statement)):
            return False
        # A finite half-open range prevents the pilot from merely repeating the broad SQL.
        ranges = re.findall(
            r"(?i)\b([a-z_][a-z_0-9]*)\s*(?:>=|>)\s*(?:'[^']*'|\d+)"
            r"[\s\S]*?\b\1\s*(?:<|<=)\s*(?:'[^']*'|\d+)",
            statement,
        )
        if not ranges:
            return False
        plan = "\n".join(str(value) for row in explain_rows for value in row.values())
        if len(re.findall(r"(?i)\bV?OlapScanNode\b", plan)) != 1:
            return False
        plan_tables = re.findall(r"(?im)^\s*TABLE:\s*([^,(\s]+)", plan)
        if len(plan_tables) != 1 or plan_tables[0].replace("`", "").lower() not in {
            parts[-1], f"{target.schema.lower()}.{parts[-1]}"
        }:
            return False
        predicates = " ".join(re.findall(r"(?im)^\s*PREDICATES:\s*(.*)$", plan)).lower()
        return any(
            re.search(rf"\b{re.escape(column.lower())}(?:\[#\d+\])?\s*(?:>=|>)", predicates)
            and re.search(rf"\b{re.escape(column.lower())}(?:\[#\d+\])?\s*(?:<=|<)", predicates)
            for column in ranges
        )

    def _confirm_timed_query_stopped(self, target: DatabaseTarget, trace_id: str) -> str:
        """Cancel only this executor's timed query, then check that it is absent."""
        if not re.fullmatch(r"codex_[0-9a-f]{32}", trace_id):
            raise QueryStateUnknownError("Timed query trace ID is invalid; stop data queries.")
        kill_acknowledged = False
        already_absent = False
        try:
            self._execute_raw(target, f'KILL QUERY "{trace_id}"')
            kill_acknowledged = True
        except DmsSafeQueryError as exc:
            already_absent = bool(re.search(r"not found|does not exist|no such query|not running", str(exc), re.I))
        try:
            rows = self._execute_raw(target, 'SHOW PROC "/current_query_stmts"')
        except DmsSafeQueryError as exc:
            raise QueryStateUnknownError("Timed query status check failed; stop data queries.") from exc
        active = any(trace_id in str(value) for row in rows for value in row.values())
        if active or not (kill_acknowledged or already_absent):
            raise QueryStateUnknownError("Timed query has no confirmed terminal state; stop data queries.")
        return "kill_acknowledged_and_absent" if kill_acknowledged else "globally_absent_and_not_running"

    def _execute_timed_pilot(
        self, target: DatabaseTarget, sql: str, trace_id: str
    ) -> list[dict[str, Any]]:
        previous_timeout = self.timeout
        try:
            self.timeout = min(previous_timeout, 10)
            try:
                return self._execute_raw(target, sql)
            except DmsSafeQueryError as exc:
                exc.query_trace_id = trace_id
                timed_out = isinstance(exc, QueryStateUnknownError) or bool(re.search(
                    r"query (?:execution )?timed? ?out", str(exc), re.I
                ))
                if not timed_out:
                    raise
                self.timeout = previous_timeout
                try:
                    evidence = self._confirm_timed_query_stopped(target, trace_id)
                except QueryStateUnknownError as status_exc:
                    status_exc.query_trace_id = trace_id
                    raise status_exc from exc
                stopped = QueryTimeoutStoppedError("Timed query stopped; remaining batches were not executed.")
                stopped.query_trace_id = trace_id
                stopped.stop_evidence = evidence
                raise stopped from exc
        finally:
            self.timeout = previous_timeout

    def _execute_locked(
        self,
        target: DatabaseTarget,
        sql: str,
        *,
        allow_select_star: bool = False,
        allow_sensitive_fields: bool = False,
        max_estimated_rows: int | None = None,
        bounded_pilot: bool = False,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        pilot_sql = None
        query_trace_id = None
        if bounded_pilot:
            if first_token(sql) != "select" or not re.match(r"(?is)^\s*select\b", sql):
                raise QueryRejectedError("A bounded pilot requires one plain SELECT aggregate.")
            # A unique trace lets a timed-out read be identified without opening Studio.
            query_trace_id = f"codex_{uuid.uuid4().hex}"
            hint = f"SELECT /*+ SET_VAR(query_timeout=5, session_context=trace_id:{query_trace_id}) */"
            pilot_sql = re.sub(r"(?i)^\s*select\b", hint, sql, count=1)
        static = validate_sql(
            sql,
            engine=target.engine,
            allow_select_star=allow_select_star,
            allow_sensitive_fields=allow_sensitive_fields,
            max_estimated_rows=max_estimated_rows,
        )
        if not static["allowed"]:
            raise QueryRejectedError("; ".join(static["violations"]))

        if not static["preflight_required"]:
            return self._execute_raw(target, static["sql"]), static

        if target.engine in SOURCE_ENGINES:
            self._verify_source_indexes(target, static)

        try:
            explain_statement = explain_sql(pilot_sql or static["sql"])
            explain_rows = (
                self._execute_timed_pilot(target, explain_statement, query_trace_id)
                if bounded_pilot else self._execute_raw(target, explain_statement)
            )
        except DmsSafeQueryError as exc:
            exc.query_trace_id = query_trace_id
            raise
        estimated_rows = estimate_rows_from_explain(explain_rows)
        tablet_calibration = None
        if estimated_rows is None or estimated_rows > static["max_estimated_rows"]:
            tablet_calibration = self._single_tablet_row_count(target, static, explain_rows)
        scan_gate_rows = tablet_calibration[1] if tablet_calibration else estimated_rows
        if bounded_pilot and estimated_rows is None:
            raise QueryNeedsSplitError("A bounded pilot requires a parseable EXPLAIN estimate before execution.")
        if bounded_pilot and scan_gate_rows > static["max_estimated_rows"]:
            if not self._bounded_pilot_plan(target, static, explain_rows):
                raise QueryNeedsSplitError("Pilot requires a single-table aggregate with a pushed-down bounded key range.")
            approved = dict(static)
            approved.update({
                "estimated_rows": estimated_rows,
                "explain_estimated_rows": estimated_rows,
                "scan_gate": "optimized_timed_fallback",
                "scan_gate_rows": scan_gate_rows,
                "query_trace_id": query_trace_id,
                "execution_allowed": True,
            })
            return self._execute_timed_pilot(target, pilot_sql or approved["sql"], query_trace_id), approved
        if scan_gate_rows is None:
            raise QueryNeedsSplitError(
                "EXPLAIN did not provide a usable row estimate or a verified single-Tablet scan; split by a smaller physical boundary."
            )
        if tablet_calibration and scan_gate_rows > static["max_estimated_rows"]:
            raise QueryNeedsSplitError(
                f"Tablet {tablet_calibration[0]} has a maximum healthy-replica RowCount of {scan_gate_rows}, "
                f"exceeding the {static['max_estimated_rows']} per-query limit; find a smaller physical boundary."
            )
        approved = validate_sql(
            static["sql"],
            engine=target.engine,
            allow_select_star=allow_select_star,
            allow_sensitive_fields=allow_sensitive_fields,
            estimated_rows=scan_gate_rows,
            max_estimated_rows=max_estimated_rows,
        )
        if not approved["execution_allowed"]:
            if approved["violations"] and all(
                violation.startswith("EXPLAIN estimates ") for violation in approved["violations"]
            ):
                raise QueryNeedsSplitError("; ".join(approved["violations"]))
            raise QueryRejectedError("; ".join(approved["violations"]))
        approved["explain_estimated_rows"] = estimated_rows
        approved["scan_gate"] = "tablet_row_count" if tablet_calibration else "explain"
        approved["scan_gate_rows"] = scan_gate_rows
        if tablet_calibration:
            approved["tablet_id"] = tablet_calibration[0]
            approved["estimated_rows"] = estimated_rows
        if bounded_pilot:
            approved["query_trace_id"] = query_trace_id
            return self._execute_timed_pilot(target, pilot_sql or approved["sql"], query_trace_id), approved
        return self._execute_raw(target, approved["sql"]), approved

    def execute(
        self,
        target: DatabaseTarget,
        sql: str,
        *,
        allow_select_star: bool = False,
        allow_sensitive_fields: bool = False,
        max_estimated_rows: int | None = None,
        bounded_pilot: bool = False,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        with single_query_lock():
            return self._execute_locked(
                target,
                sql,
                allow_select_star=allow_select_star,
                allow_sensitive_fields=allow_sensitive_fields,
                max_estimated_rows=max_estimated_rows,
                bounded_pilot=bounded_pilot,
            )

    def execute_batches(
        self,
        target: DatabaseTarget,
        batches: list[dict[str, str]],
        *,
        allow_select_star: bool = False,
        allow_sensitive_fields: bool = False,
        max_estimated_rows: int | None = None,
    ) -> list[dict[str, Any]]:
        """Execute a complete plan serially; the first failed/unknown batch stops it."""
        plan = validate_batch_queries(batches)
        for batch in plan:
            static = validate_sql(
                batch["sql"],
                engine=target.engine,
                allow_select_star=allow_select_star,
                allow_sensitive_fields=allow_sensitive_fields,
                max_estimated_rows=max_estimated_rows,
            )
            if not static["allowed"]:
                raise QueryRejectedError(f"Batch {batch['id']} blocked: " + "; ".join(static["violations"]))
            if not static["is_aggregate"]:
                raise QueryRejectedError(
                    f"Batch {batch['id']} is a detail query; batch mode is aggregate-only and detail output stays capped at 200 rows."
                )
        results: list[dict[str, Any]] = []
        with single_query_lock():
            for position, batch in enumerate(plan):
                try:
                    rows, check = self._execute_locked(
                        target,
                        batch["sql"],
                        allow_select_star=allow_select_star,
                        allow_sensitive_fields=allow_sensitive_fields,
                        max_estimated_rows=max_estimated_rows,
                    )
                except DmsSafeQueryError as exc:
                    # Preserve completed aggregates so a split or timeout never forces already successful batches to run again.
                    exc.batch_progress = {
                        "completed": [_public_batch_result(item) for item in results],
                        "failed_batch_id": batch["id"],
                        "remaining_batch_ids": [item["id"] for item in plan[position + 1:]],
                    }
                    raise
                results.append({"id": batch["id"], "rows": rows, "sql_check": check})
        return results


def _public_batch_result(item: dict[str, Any]) -> dict[str, Any]:
    check = item["sql_check"]
    return {
        "id": item["id"],
        "sql_fingerprint": check["sql_fingerprint"],
        "estimated_rows": check["estimated_rows"],
        "scan_gate": check.get("scan_gate"),
        "scan_gate_rows": check.get("scan_gate_rows"),
        "rows": item["rows"],
    }


def _error_result(status: str, exc: DmsSafeQueryError) -> dict[str, Any]:
    result: dict[str, Any] = {"status": status, "error": str(exc)}
    if exc.query_trace_id:
        result["query_trace_id"] = exc.query_trace_id
    if isinstance(exc, QueryTimeoutStoppedError):
        result["stop_evidence"] = exc.stop_evidence
    if exc.batch_progress is not None:
        result["batch_progress"] = exc.batch_progress
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sql_group = parser.add_mutually_exclusive_group(required=True)
    sql_group.add_argument("--sql")
    sql_group.add_argument("--sql-file")
    sql_group.add_argument("--batch-plan", help="JSON file containing [{id, sql}, ...] or {batches: [...]}")
    sql_group.add_argument("--sql-template-file", help="SQL with {{batch_start}}/{{batch_end}} placeholders")
    parser.add_argument("--database-keyword", required=True, help="DMS database search keyword")
    parser.add_argument("--schema", help="Expected exact schema name")
    parser.add_argument("--db-id", help="Expected DatabaseId; verified against DMS metadata")
    parser.add_argument("--max-estimated-rows", type=int)
    parser.add_argument("--allow-select-star", action="store_true")
    parser.add_argument("--allow-sensitive-fields", action="store_true")
    parser.add_argument("--bounded-pilot", action="store_true", help="Run one optimized, timed warehouse key-range aggregate with a trace ID")
    parser.add_argument("--batch-start")
    parser.add_argument("--batch-end")
    parser.add_argument("--batch-days", type=int, default=1)
    args = parser.parse_args()
    if args.bounded_pilot and (args.batch_plan or args.sql_template_file):
        parser.error("--bounded-pilot accepts one SQL statement, not a batch plan")

    sql: str | None = None
    batches: list[dict[str, str]] | None = None
    try:
        if args.batch_plan:
            payload = json.loads(Path(args.batch_plan).read_text(encoding="utf-8-sig"))
            batches = validate_batch_queries(payload.get("batches") if isinstance(payload, dict) else payload)
        elif args.sql_template_file:
            if not args.batch_start or not args.batch_end:
                parser.error("--sql-template-file requires --batch-start and --batch-end")
            template = Path(args.sql_template_file).read_text(encoding="utf-8-sig")
            batches = build_date_batches(
                template, args.batch_start, args.batch_end, batch_days=args.batch_days
            )
        else:
            sql = args.sql if args.sql is not None else Path(args.sql_file).read_text(encoding="utf-8-sig")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "blocked", "error": f"Invalid query plan: {exc}"}, ensure_ascii=False), file=sys.stderr)
        return 2
    executor: SafeDmsExecutor | None = None
    try:
        executor = SafeDmsExecutor()
        executor.enable_ai_mode()
        target = executor.resolve_database(
            args.database_keyword,
            schema=args.schema,
            database_id=args.db_id,
        )
        if batches is not None:
            batch_results = executor.execute_batches(
                target,
                batches,
                allow_select_star=args.allow_select_star,
                allow_sensitive_fields=args.allow_sensitive_fields,
                max_estimated_rows=args.max_estimated_rows,
            )
            print(json.dumps({
                "status": "success",
                "source": "dms",
                "engine": target.engine,
                "database_id": target.database_id,
                "batch_count": len(batch_results),
                "batches": [_public_batch_result(item) for item in batch_results],
            }, ensure_ascii=False, indent=2))
        else:
            rows, check = executor.execute(
                target,
                sql or "",
                allow_select_star=args.allow_select_star,
                allow_sensitive_fields=args.allow_sensitive_fields,
                max_estimated_rows=args.max_estimated_rows,
                bounded_pilot=args.bounded_pilot,
            )
            print(json.dumps({
                "status": "success",
                "source": "dms",
                "engine": target.engine,
                "database_id": target.database_id,
                "sql_fingerprint": check["sql_fingerprint"],
                "estimated_rows": check["estimated_rows"],
                "scan_gate": check.get("scan_gate"),
                "scan_gate_rows": check.get("scan_gate_rows"),
                "query_trace_id": check.get("query_trace_id"),
                "rows": rows,
            }, ensure_ascii=False, indent=2))
        return 0
    except QueryNeedsSplitError as exc:
        print(json.dumps(_error_result("needs_split", exc), ensure_ascii=False), file=sys.stderr)
        return 3
    except QueryRejectedError as exc:
        print(json.dumps(_error_result("blocked", exc), ensure_ascii=False), file=sys.stderr)
        return 2
    except QueryTimeoutStoppedError as exc:
        print(json.dumps(_error_result("timed_out_stopped", exc), ensure_ascii=False), file=sys.stderr)
        return 6
    except QueryStateUnknownError as exc:
        print(json.dumps(_error_result("server_state_unknown", exc), ensure_ascii=False), file=sys.stderr)
        return 4
    except QueryLockError as exc:
        print(json.dumps({"status": "query_in_flight", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 5
    except DmsSafeQueryError as exc:
        print(json.dumps(_error_result("execution_failed", exc), ensure_ascii=False), file=sys.stderr)
        return 3
    finally:
        if executor is not None:
            try:
                executor.disable_ai_mode()
            except DmsSafeQueryError as exc:
                print(json.dumps({"status": "cleanup_failed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
