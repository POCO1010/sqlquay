#!/usr/bin/env python3
"""Fail-closed safety checks shared by every production read-query route.

The guard deliberately separates SQL read-only validation from execution-cost
preflight. A bounded SELECT is syntactically allowed, but execution still needs
an engine-limit scan budget from EXPLAIN or a separately verified physical
Tablet count. LIMIT never substitutes for a source/partition/business-key boundary.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import hashlib
import os
import re
import time
from pathlib import Path
from typing import Any, Iterator


ALLOWED_HEADS = {"select", "with", "show", "desc", "describe", "explain"}
METADATA_HEADS = {"show", "desc", "describe", "explain"}
BLOCKED_KEYWORDS = {
    "admin", "alter", "call", "create", "delete", "drop", "export", "grant",
    "insert", "load", "merge", "outfile", "recover", "rename", "replace",
    "revoke", "set", "truncate", "update",
}
SENSITIVE_FIELDS = {
    "address", "id_card", "identity_card", "mobile", "openid", "password", "phone",
}
# Operational ceilings; the warehouse value is user-selected, not Profile-calibrated.
ENGINE_ROW_LIMITS = {
    "mysql": 100_000,
    "rds": 100_000,
    "polardb": 100_000,
    "source": 100_000,
    "selectdb": 10_000_000,
    "doris": 10_000_000,
    "warehouse": 10_000_000,
}
DEFAULT_LOCK_PATH = Path("/tmp/sqlquay-read-query.lock")
IDENT = r"[A-Za-z_][A-Za-z0-9_$]*"
LITERAL = r"(?:'[^']*'|\"[^\"]*\"|-?\d+(?:\.\d+)?|DATE\s*'[^']*')"


class QueryLockError(RuntimeError):
    """Another governed production query is already in flight."""


def validate_batch_queries(items: Any, *, max_batches: int = 1000) -> list[dict[str, str]]:
    """Validate a serial query plan without trying to infer merge semantics."""
    if not isinstance(items, list) or not items:
        raise ValueError("Batch plan must contain a non-empty list of queries.")
    if len(items) > max_batches:
        raise ValueError(f"Batch plan exceeds {max_batches} queries.")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for position, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Batch {position} must be an object.")
        batch_id = str(item.get("id") or "").strip()
        sql = str(item.get("sql") or "").strip()
        if not batch_id or not sql:
            raise ValueError(f"Batch {position} requires non-empty id and sql fields.")
        if batch_id in seen:
            raise ValueError(f"Duplicate batch id: {batch_id}")
        seen.add(batch_id)
        normalized.append({"id": batch_id, "sql": sql})
    return normalized


def build_date_batches(
    sql_template: str,
    start_text: str,
    end_text: str,
    *,
    batch_days: int = 1,
    max_batches: int = 1000,
) -> list[dict[str, str]]:
    """Render serial half-open date windows from an explicit SQL template."""
    if "{{batch_start}}" not in sql_template or "{{batch_end}}" not in sql_template:
        raise ValueError("SQL template requires {{batch_start}} and {{batch_end}} placeholders.")
    if not 1 <= batch_days <= 7:
        raise ValueError("batch_days must be between 1 and 7.")
    try:
        start = dt.date.fromisoformat(start_text)
        end = dt.date.fromisoformat(end_text)
    except ValueError as exc:
        raise ValueError("Batch dates must use YYYY-MM-DD.") from exc
    if start >= end:
        raise ValueError("Batch start must be earlier than batch end.")

    batches: list[dict[str, str]] = []
    cursor = start
    step = dt.timedelta(days=batch_days)
    while cursor < end:
        batch_end = min(cursor + step, end)
        batches.append({
            "id": f"{cursor.isoformat()}_{batch_end.isoformat()}",
            "sql": sql_template.replace("{{batch_start}}", cursor.isoformat()).replace(
                "{{batch_end}}", batch_end.isoformat()
            ),
        })
        if len(batches) > max_batches:
            raise ValueError(f"Date range requires more than {max_batches} batches.")
        cursor = batch_end
    return batches


def strip_comments(sql: str) -> str:
    """Mask SQL comments without treating comment markers inside literals as syntax."""
    chars = list(sql)
    quote: str | None = None
    index = 0
    while index < len(chars):
        char = chars[index]
        if quote is not None:
            if char == "\\" and index + 1 < len(chars):
                index += 2
                continue
            if char == quote:
                if index + 1 < len(chars) and chars[index + 1] == quote:
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if char in {"'", '"', "`"}:
            quote = char
            index += 1
            continue
        if char == "-" and index + 1 < len(chars) and chars[index + 1] == "-":
            chars[index] = chars[index + 1] = " "
            index += 2
            while index < len(chars) and chars[index] not in {"\n", "\r"}:
                chars[index] = " "
                index += 1
            continue
        if char == "/" and index + 1 < len(chars) and chars[index + 1] == "*":
            chars[index] = chars[index + 1] = " "
            index += 2
            while index + 1 < len(chars) and not (chars[index] == "*" and chars[index + 1] == "/"):
                if chars[index] not in {"\n", "\r"}:
                    chars[index] = " "
                index += 1
            if index + 1 < len(chars):
                chars[index] = chars[index + 1] = " "
                index += 2
            continue
        index += 1
    return "".join(chars)


def mask_string_literals(sql: str, *, mask_backticks: bool = False) -> str:
    """Replace quoted values while preserving offsets for token-level checks."""
    chars = list(sql)
    quote: str | None = None
    index = 0
    while index < len(chars):
        char = chars[index]
        if quote is None:
            if char in ({"'", '"', "`"} if mask_backticks else {"'", '"'}):
                quote = char
            index += 1
            continue
        if char == "\\" and index + 1 < len(chars):
            chars[index] = " "
            chars[index + 1] = " "
            index += 2
            continue
        if char == quote:
            if index + 1 < len(chars) and chars[index + 1] == quote:
                chars[index] = chars[index + 1] = " "
                index += 2
                continue
            quote = None
        else:
            chars[index] = " "
        index += 1
    return "".join(chars)


def split_statements(sql: str) -> list[str]:
    cleaned = strip_comments(sql).strip()
    masked = mask_string_literals(cleaned, mask_backticks=True)
    boundaries = [index for index, char in enumerate(masked) if char == ";"]
    parts: list[str] = []
    start = 0
    for end in boundaries:
        part = cleaned[start:end].strip()
        if part:
            parts.append(part)
        start = end + 1
    tail = cleaned[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def first_token(sql: str) -> str:
    match = re.search(r"[A-Za-z_]+", strip_comments(sql))
    return match.group(0).lower() if match else ""


def extract_tables(sql: str) -> list[str]:
    cleaned = strip_comments(sql)
    cte_names = {
        match.group(1).lower()
        for match in re.finditer(rf"(?is)(?:\bwith\b|,)\s*({IDENT})\s+as\s*\(", cleaned)
    }
    tables: list[str] = []
    seen: set[str] = set()
    pattern = re.compile(rf"\b(?:from|join)\s+(`?{IDENT}`?(?:\.`?{IDENT}`?)?)", re.I)
    for match in pattern.finditer(cleaned):
        table = match.group(1).replace("`", "")
        lowered = table.lower()
        if lowered in cte_names or lowered in seen:
            continue
        seen.add(lowered)
        tables.append(table)
    return tables


def _outer_select_projections(sql: str) -> list[str]:
    cleaned = strip_comments(sql)
    masked = mask_string_literals(cleaned)
    depth = 0
    depth_at = [0] * (len(masked) + 1)
    for index, char in enumerate(masked):
        depth_at[index] = depth
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
    selects = [
        match for match in re.finditer(r"(?i)\bselect\b", masked)
        if depth_at[match.start()] == 0
    ]
    projections: list[str] = []
    for select in selects:
        start = select.end()
        end = len(cleaned)
        for match in re.finditer(r"(?i)\b(from|union|intersect|except)\b", masked[start:]):
            absolute = start + match.start()
            if depth_at[absolute] == 0:
                end = absolute
                break
        projections.append(cleaned[start:end])
    return projections


def has_select_star(sql: str) -> bool:
    return any(
        re.search(r"(?is)(?:^|,)\s*(?:distinct\s+)?(?:[A-Za-z_]\w*\.)?\*\s*(?:,|$)", projection)
        for projection in _outer_select_projections(sql)
    )


def referenced_sensitive_fields(sql: str) -> list[str]:
    safe_projections: list[str] = []
    for projection in _outer_select_projections(sql):
        lowered = mask_string_literals(projection).lower()
        chars = list(lowered)
        for match in re.finditer(r"(?i)\bcount\s*\(", lowered):
            depth = 1
            cursor = match.end()
            while cursor < len(chars) and depth:
                if chars[cursor] == "(":
                    depth += 1
                elif chars[cursor] == ")":
                    depth -= 1
                cursor += 1
            if depth == 0:
                for index in range(match.start(), cursor):
                    chars[index] = " "
        safe_projections.append("".join(chars))
    lowered = " ".join(safe_projections)
    return [
        field for field in sorted(SENSITIVE_FIELDS)
        if re.search(rf"(?<![\w]){re.escape(field)}(?![\w])", lowered)
    ]


def extract_scope_references(sql: str) -> set[tuple[str, str]]:
    """Return qualified columns with a complete literal equality/list/range boundary."""
    cleaned = strip_comments(sql).replace("`", "")
    if not re.search(r"(?is)\bwhere\b", cleaned):
        return set()

    scoped: set[tuple[str, str]] = set()
    ranges: dict[tuple[str, str], set[str]] = {}
    qualified = rf"(?:(?P<qual>{IDENT})\.)?(?P<col>{IDENT})"

    for match in re.finditer(rf"(?is)\b{qualified}\s*=\s*({LITERAL})", cleaned):
        scoped.add(((match.group("qual") or "").lower(), match.group("col").lower()))

    for match in re.finditer(rf"(?is)\b{qualified}\s+between\s+({LITERAL})\s+and\s+({LITERAL})", cleaned):
        scoped.add(((match.group("qual") or "").lower(), match.group("col").lower()))

    for match in re.finditer(rf"(?is)\b{qualified}\s+in\s*\(([^()]*)\)", cleaned):
        reference = ((match.group("qual") or "").lower(), match.group("col").lower())
        body = match.group(match.lastindex or 0)
        values = [item.strip() for item in body.split(",") if item.strip()]
        if values and len(values) <= 200 and all(re.fullmatch(LITERAL, value, re.I) for value in values):
            scoped.add(reference)

    for match in re.finditer(rf"(?is)\b{qualified}\s*(>=|>|<=|<)\s*({LITERAL})", cleaned):
        reference = ((match.group("qual") or "").lower(), match.group("col").lower())
        operator = match.group(match.lastindex - 1)
        ranges.setdefault(reference, set()).add(operator)
    for reference, operators in ranges.items():
        lower = bool(operators & {">", ">="})
        upper = bool(operators & {"<", "<="})
        if lower and upper:
            scoped.add(reference)
    return scoped


def extract_scope_columns(sql: str) -> list[str]:
    return sorted({column for _, column in extract_scope_references(sql)})


def has_implicit_join(sql: str) -> bool:
    cleaned = mask_string_literals(strip_comments(sql))
    depth_at = [0] * (len(cleaned) + 1)
    depth = 0
    for index, char in enumerate(cleaned):
        depth_at[index] = depth
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)

    boundaries = re.compile(
        r"(?i)\b(where|group|having|order|limit|union|intersect|except)\b"
    )
    for token in re.finditer(r"(?i)\bfrom\b", cleaned):
        base_depth = depth_at[token.start()]
        cursor = token.end()
        depth = base_depth
        boundary_starts = {
            match.start() for match in boundaries.finditer(cleaned, cursor)
            if depth_at[match.start()] == base_depth
        }
        while cursor < len(cleaned):
            if cursor in boundary_starts:
                break
            char = cleaned[cursor]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth < base_depth:
                    break
            elif char == "," and depth == base_depth:
                return True
            cursor += 1
    return False


def index_candidates_by_table(
    sql: str,
    tables: list[str],
    scope_references: set[tuple[str, str]],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Map literal bounds and JOIN keys separately to their source relations."""
    cleaned = mask_string_literals(strip_comments(sql)).replace("`", "")
    reserved = {"where", "join", "left", "right", "inner", "outer", "cross", "on", "group", "order", "limit"}
    relation_pattern = re.compile(
        rf"(?is)\b(?:from|join)\s+({IDENT}(?:\.{IDENT})?)(?:\s+(?:as\s+)?({IDENT}))?"
    )
    alias_to_table: dict[str, str] = {}
    for match in relation_pattern.finditer(cleaned):
        table = match.group(1)
        if table.lower() not in {item.lower() for item in tables}:
            continue
        alias = match.group(2)
        alias_to_table[table.lower()] = table
        alias_to_table[table.split(".")[-1].lower()] = table
        if alias and alias.lower() not in reserved:
            alias_to_table[alias.lower()] = table

    scope_candidates: dict[str, set[str]] = {table: set() for table in tables}
    join_candidates: dict[str, set[str]] = {table: set() for table in tables}
    comparison = re.compile(
        rf"(?is)\b(?:(?P<qual>{IDENT})\.)?(?P<col>{IDENT})\s*(?:=\s*{LITERAL}|between\s+{LITERAL}\s+and\s+{LITERAL}|in\s*\([^()]*\)|(?:>=|>|<=|<)\s*{LITERAL})"
    )
    for match in comparison.finditer(cleaned):
        column = match.group("col").lower()
        qualifier = (match.group("qual") or "").lower()
        if (qualifier, column) not in scope_references:
            continue
        if qualifier and qualifier in alias_to_table:
            scope_candidates[alias_to_table[qualifier]].add(column)
        elif len(tables) == 1:
            scope_candidates[tables[0]].add(column)

    join_equality = re.compile(
        rf"(?is)\b({IDENT})\.({IDENT})\s*=\s*({IDENT})\.({IDENT})\b"
    )
    for match in join_equality.finditer(cleaned):
        for qualifier, column in ((match.group(1), match.group(2)), (match.group(3), match.group(4))):
            table = alias_to_table.get(qualifier.lower())
            if table:
                join_candidates[table].add(column.lower())
    return (
        {table: sorted(columns) for table, columns in scope_candidates.items()},
        {table: sorted(columns) for table, columns in join_candidates.items()},
    )


def risk_flags(sql: str) -> list[str]:
    cleaned = strip_comments(sql)
    checks = {
        "join": r"(?is)\bjoin\b",
        "count_distinct": r"(?is)\bcount\s*\(\s*distinct\b",
        "distinct": r"(?is)\bselect\s+distinct\b",
        "group_by": r"(?is)\bgroup\s+by\b",
        "order_by": r"(?is)\border\s+by\b",
        "set_operation": r"(?is)\b(?:union|intersect|except)\b",
        "window_function": r"(?is)\bover\s*\(",
    }
    return [name for name, pattern in checks.items() if re.search(pattern, cleaned)]


def _limit_value(sql: str) -> int | None:
    matches = list(re.finditer(r"(?is)\blimit\s+(\d+)\b", strip_comments(sql)))
    return int(matches[-1].group(1)) if matches else None


def _is_aggregate(sql: str) -> bool:
    return bool(re.search(
        r"(?is)\b(?:count|sum|avg|min|max)\s*\(|\bgroup\s+by\b|\bhaving\b",
        strip_comments(sql),
    ))


def _has_cross_database_join(tables: list[str]) -> bool:
    schemas = {table.split(".", 1)[0].lower() for table in tables if "." in table}
    return len(tables) > 1 and len(schemas) > 1


def engine_row_limit(engine: str, requested: int | None = None) -> int:
    policy_limit = ENGINE_ROW_LIMITS.get((engine or "").lower(), ENGINE_ROW_LIMITS["source"])
    if requested is None:
        return policy_limit
    if requested < 1:
        raise ValueError("max_estimated_rows must be positive")
    return min(requested, policy_limit)


def validate_sql(
    sql: str,
    *,
    engine: str = "source",
    allow_select_star: bool = False,
    allow_sensitive_fields: bool = False,
    estimated_rows: int | None = None,
    max_estimated_rows: int | None = None,
    max_detail_rows: int = 200,
) -> dict[str, Any]:
    statements = split_statements(sql)
    violations: list[str] = []
    warnings: list[str] = []
    if not statements:
        violations.append("SQL is empty.")
    if len(statements) > 1:
        violations.append("Only one SQL statement is allowed.")

    statement = statements[0] if statements else ""
    token = first_token(statement)
    if token not in ALLOWED_HEADS:
        violations.append("Only SELECT, WITH, SHOW, DESC, DESCRIBE, or EXPLAIN SQL is allowed.")

    lowered = mask_string_literals(strip_comments(statement), mask_backticks=True).lower()
    for keyword in sorted(BLOCKED_KEYWORDS):
        if token == "show" and keyword == "create":
            continue
        if re.search(rf"(?<![\w]){re.escape(keyword)}(?![\w])", lowered):
            violations.append(f"Blocked keyword found: {keyword}")

    if has_select_star(statement) and not allow_select_star:
        violations.append("SELECT * is not allowed; list fields explicitly.")
    sensitive = referenced_sensitive_fields(statement)
    if sensitive and not allow_sensitive_fields:
        violations.append("Sensitive fields are referenced: " + ", ".join(sensitive))

    tables = extract_tables(statement)
    scope_references = extract_scope_references(statement)
    scopes = sorted({column for _, column in scope_references})
    scope_index_candidates, join_index_candidates = index_candidates_by_table(
        statement, tables, scope_references,
    )
    index_candidates = {
        table: scope_index_candidates.get(table) or join_index_candidates.get(table) or []
        for table in tables
    }
    flags = risk_flags(statement)
    metadata_only = token in METADATA_HEADS
    if has_implicit_join(statement):
        violations.append("Implicit comma JOIN is not allowed; use explicit JOIN with qualified keys.")
    if _has_cross_database_join(tables):
        violations.append("Cross-database JOIN/set queries are not allowed in the production query route.")

    if tables and not metadata_only and not scopes:
        violations.append(
            "Production table queries require an explicit bounded time, partition, or business-key predicate; LIMIT is not a scan boundary."
        )
    if (
        engine.lower() in {"mysql", "rds", "polardb", "source"}
        and len(tables) > 1
        and scopes
        and not any(scope_index_candidates.values())
    ):
        violations.append(
            "Multi-table queries require a qualified literal boundary on at least one source relation."
        )

    limit = _limit_value(statement)
    if tables and not metadata_only and not _is_aggregate(statement):
        if limit is None:
            violations.append("Detail queries require LIMIT 200 or smaller.")
        elif limit > max_detail_rows:
            violations.append(f"Detail query LIMIT exceeds {max_detail_rows}.")

    threshold = engine_row_limit(engine, max_estimated_rows)
    preflight_required = bool(tables and not metadata_only)
    if preflight_required and estimated_rows is None:
        warnings.append("EXPLAIN row estimate is required before execution.")
    elif preflight_required and estimated_rows is not None and estimated_rows > threshold:
        violations.append(
            f"EXPLAIN estimates {estimated_rows} rows, exceeding the {threshold} per-query limit for {engine}; split by a pruning partition or business key and preflight each smaller query."
        )

    allowed = not violations
    execution_allowed = allowed and (not preflight_required or estimated_rows is not None)
    return {
        "allowed": allowed,
        "execution_allowed": execution_allowed,
        "preflight_required": preflight_required,
        "violations": violations,
        "warnings": warnings,
        "tables": tables,
        "scope_columns": scopes,
        "scope_references": [
            f"{qualifier}.{column}" if qualifier else column
            for qualifier, column in sorted(scope_references)
        ],
        "index_candidates": index_candidates,
        "scope_index_candidates": scope_index_candidates,
        "join_index_candidates": join_index_candidates,
        "risk_flags": flags,
        "is_aggregate": _is_aggregate(statement),
        "statement_count": len(statements),
        "engine": engine,
        "max_estimated_rows": threshold,
        "estimated_rows": estimated_rows,
        "sql_fingerprint": hashlib.sha256(statement.encode("utf-8")).hexdigest()[:16] if statement else "",
        "sql": statement,
    }


def explain_sql(sql: str) -> str:
    if first_token(sql) == "explain":
        return sql
    return "EXPLAIN " + sql.strip().rstrip(";")


def _numeric(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str) and re.fullmatch(r"[\d,]+(?:\.\d+)?", value.strip()):
        return max(0, int(float(value.replace(",", ""))))
    return None


def estimate_rows_from_explain(rows: Any) -> int | None:
    """Parse common MySQL/Doris/SelectDB EXPLAIN row/cardinality representations."""
    estimates: list[int] = []
    mysql_tabular_rows: list[int] = []
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                mysql_tabular_rows = []
                break
            direct = next(
                (
                    _numeric(value)
                    for key, value in row.items()
                    if re.sub(r"[^a-z]", "", str(key).lower()) == "rows"
                ),
                None,
            )
            if direct is None:
                mysql_tabular_rows = []
                break
            mysql_tabular_rows.append(direct)

    def visit(value: Any, key: str = "") -> None:
        normalized = re.sub(r"[^a-z]", "", key.lower())
        if normalized in {"rows", "estimatedrows", "cardinality", "rowsproducedperjoin"}:
            number = _numeric(value)
            if number is not None:
                estimates.append(number)
        if isinstance(value, dict):
            for child_key, child in value.items():
                visit(child, str(child_key))
        elif isinstance(value, (list, tuple)):
            for child in value:
                visit(child)
        elif isinstance(value, str):
            for pattern in (
                r"(?i)\bcardinality\s*[=:]\s*([\d,]+)",
                r"(?i)\bestimated[_ ]?rows\s*[=:]\s*([\d,]+)",
                r"(?i)~\s*([\d,]+)\s+rows\b",
            ):
                for match in re.finditer(pattern, value):
                    estimates.append(int(match.group(1).replace(",", "")))

    visit(rows)
    if len(mysql_tabular_rows) > 1:
        join_product = 1
        for estimate in mysql_tabular_rows:
            join_product *= estimate
        estimates.append(join_product)
    return max(estimates) if estimates else None


def quote_table(table: str) -> str:
    parts = table.split(".")
    if not 1 <= len(parts) <= 2 or any(not re.fullmatch(IDENT, part) for part in parts):
        raise ValueError(f"Unsafe table identifier: {table}")
    return ".".join(f"`{part}`" for part in parts)


def indexed_scope_columns(index_rows: Any, scope_columns: list[str]) -> set[str]:
    scopes = {column.lower() for column in scope_columns}
    indexed: set[str] = set()
    if not isinstance(index_rows, list):
        return indexed
    indexes: dict[str, list[tuple[int | None, str]]] = {}
    for row in index_rows:
        if not isinstance(row, dict):
            continue
        index_name = ""
        sequence: int | None = None
        column = ""
        for key, value in row.items():
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in {"keyname", "indexname"}:
                index_name = str(value)
            elif normalized in {"seqinindex", "sequence"}:
                parsed = _numeric(value)
                sequence = parsed if parsed is not None else None
            elif normalized in {"columnname", "column"}:
                column = str(value).lower()
        if column:
            indexes.setdefault(index_name or f"unnamed:{len(indexes)}", []).append((sequence, column))
    for columns in indexes.values():
        explicit_first = [column for sequence, column in columns if sequence == 1]
        leading = explicit_first
        indexed.update(column for column in leading if column in scopes)
    return indexed


@contextlib.contextmanager
def single_query_lock(
    *,
    path: Path = DEFAULT_LOCK_PATH,
    wait_seconds: float = 0,
) -> Iterator[None]:
    """Serialize DMS and direct-db production reads on this workstation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    deadline = time.monotonic() + max(0, wait_seconds)
    try:
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as exc:
                if time.monotonic() >= deadline:
                    raise QueryLockError("Another governed production query is already in flight.") from exc
                time.sleep(0.1)
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} started={int(time.time())}\n")
        handle.flush()
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
