"""SQLQuay-owned AK session. Credentials arrive on stdin; only CLI children receive them."""
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


def report(reason):
    print(json.dumps({"status": "configuration_error", "reason": reason}), file=sys.stderr)
    return 2


def main():
    operation = sys.argv.pop(1)
    if operation not in {"search", "query", "preview", "instances", "databases"}:
        return report("search_failed")
    try:
        auth = json.load(sys.stdin)
        values = [auth[key].strip() for key in ("accessKeyId", "accessKeySecret")]
        if any(not value or len(value) > 256 or re.search(r"[\s\x00-\x1f\x7f]", value) for value in values):
            return report("invalid_credentials")
    except (ValueError, KeyError, TypeError, AttributeError):
        return report("invalid_credentials")
    cli = shutil.which("aliyun")
    if not cli:
        return report("cli_missing")
    scripts = Path(__file__).resolve().parent
    sys.path.insert(0, str(scripts.parent / "policy"))
    import execute_safe as safe
    import query_guard as guard
    from engine_policy import engine_type, ENVIRONMENTS
    sys.path.insert(0, str(scripts))
    safe.USER_AGENT = "SQLQuay"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("ALIBABA_CLOUD_", "ALIBABACLOUD_", "ALICLOUD_")) and key != "DEBUG"}
    env.update(ALIBABA_CLOUD_IGNORE_PROFILE="TRUE", ALIBABA_CLOUD_PROFILE_MODE="AK",
               ALIBABA_CLOUD_ACCESS_KEY_ID=values[0], ALIBABA_CLOUD_ACCESS_KEY_SECRET=values[1],
               ALIBABA_CLOUD_CLI_PLUGIN_AUTO_INSTALL="false", ALIBABA_CLOUD_RETRY_COUNT="0",
               ALIBABA_CLOUD_CLI_AGENT_INTEGRATION="disabled")
    plugin_directory = os.environ.get("ALIBABA_CLOUD_CLI_PLUGINS_DIR") or str(Path.home() / ".aliyun" / "plugins")
    # Only CLI children get a private HOME; the Python guard keeps the shared workstation lock.
    with TemporaryDirectory(prefix="sqlquay-dms-") as directory:
        env.update(HOME=directory, USERPROFILE=directory, ALIBABA_CLOUD_CLI_PLUGINS_DIR=plugin_directory)

        def run(executor, args):
            try:
                result = subprocess.run([cli, *args], env=env,
                                        text=True, capture_output=True, timeout=executor.timeout, check=False)
            except subprocess.TimeoutExpired as exc:
                raise safe.QueryStateUnknownError("DMS CLI timed out; the operation was not retried.") from exc
            return result.returncode, result.stdout, result.stderr

        safe.SafeDmsExecutor._run_cli = run
        executor = safe.SafeDmsExecutor(profile="sqlquay", timeout=45)
        try:
            code, output, _ = executor.runner(["plugin", "list"])
            if code or not re.search(r"(?m)^\s*aliyun-cli-dms-enterprise(?:[ \t]|$)", output):
                return report("plugin_missing")
        except safe.DmsSafeQueryError:
            return report("plugin_missing")
        if operation in {"instances", "databases"}:
            import argparse
            from dms_catalog import catalog
            parser = argparse.ArgumentParser()
            parser.add_argument("--keyword", default="")
            parser.add_argument("--region", required=True)
            parser.add_argument("--profile", choices=["sqlquay"], required=True)
            parser.add_argument("--instance-id")
            parser.add_argument("--instance-name", default="")
            parser.add_argument("--page", type=int, default=1)
            parser.add_argument("--environment", default="", choices=["", *sorted(ENVIRONMENTS)])
            parser.add_argument("--engine", default="", choices=["", "mysql", "rds", "polardb", "drds", "doris", "selectdb", "ots"])
            args = parser.parse_args()
            args.operation = operation
            if not 1 <= args.page <= 10000 or len(args.keyword) > 128 or re.search(r"[\x00-\x1f]", args.keyword) or not re.fullmatch(r"[a-z]{2}-[a-z0-9-]{1,40}", args.region) or (operation == "databases" and not re.fullmatch(r"[1-9][0-9]{0,19}", args.instance_id or "")):
                return report("search_failed")
            try:
                with guard.single_query_lock():
                    executor.region = args.region
                    try:
                        executor.enable_ai_mode()
                        result = catalog(executor, args)
                    finally:
                        try:
                            executor._ai_mode_enabled = True
                            executor.disable_ai_mode()
                        except safe.DmsSafeQueryError:
                            print(json.dumps({"status": "cleanup_failed"}), file=sys.stderr)
                            raise
                print(json.dumps(dict(status="success", **result), ensure_ascii=False))
                return 0
            except guard.QueryLockError:
                print(json.dumps({"status":"query_in_flight"}), file=sys.stderr)
                return 2
            except (safe.DmsSafeQueryError, ValueError, TypeError, KeyError):
                return report("search_failed")
        if operation == "search":
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--database-keyword", required=True)
            parser.add_argument("--region", required=True)
            parser.add_argument("--profile", choices=["sqlquay"], required=True)
            args = parser.parse_args()
            try:
                with guard.single_query_lock():
                    executor.region = args.region
                    try:
                        executor.enable_ai_mode()
                        data = executor.command_json("search-database", ["--search-key", args.database_keyword,
                                                     "--page-number", "1", "--page-size", "100"])
                        if data.get("Success") is False:
                            return report("search_failed")
                        rows = data.get("SearchDatabaseList", {}).get("SearchDatabase", [])
                        databases = []
                        for row in rows:
                            if not isinstance(row, dict) or str(row.get("EnvType", "")).lower() not in ENVIRONMENTS or row.get("Logic") is True:
                                continue
                            engine = str(row.get("DbType", "")).lower()
                            if engine_type(engine) is None:
                                continue
                            database, identity = row.get("SchemaName"), str(row.get("DatabaseId", ""))
                            if not isinstance(database, str) or not database or len(database) > 128 or not re.fullmatch(r"[1-9][0-9]{0,19}", identity):
                                continue
                            alias = str(row.get("Alias") or row.get("SearchName") or "")[:256]
                            label = " · ".join(value for value in (database, alias, engine, "#" + identity) if value)
                            databases.append(dict(database=database, databaseId=identity, engine=engine_type(engine), environment=str(row["EnvType"]).lower(), label=label[:512]))
                    finally:
                        try:
                            executor.disable_ai_mode()
                        except safe.DmsSafeQueryError:
                            print(json.dumps({"status": "cleanup_failed"}), file=sys.stderr)
                            raise
                print(json.dumps({"status": "success", "databases": databases[:100],
                                  "more": int(data.get("TotalCount", len(rows))) > 100}, ensure_ascii=False))
                return 0
            except (safe.DmsSafeQueryError, guard.QueryLockError, ValueError, TypeError):
                return report("search_failed")
        wrapper = str(scripts.parent / "policy" / "execute_safe.py")
        if operation == "query":
            entry = scripts / "dms_timed.py"
            sys.argv = [str(entry), wrapper, *sys.argv[1:]]
        else:
            entry = scripts / "preview_safe.py"
            sys.argv = [str(entry), *sys.argv[1:], "--safe-wrapper=" + wrapper]
        runpy.run_path(str(entry), run_name="__main__")


if __name__ == "__main__":
    sys.exit(main())
