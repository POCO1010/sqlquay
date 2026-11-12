"""Measure the approved DMS executor without changing its query policy or lifecycle."""
import argparse
import json
from pathlib import Path
import sys
import time


def instrument(safe, expected=None, *, profile=None, region=None, environment=None, instance_id=None):
    timings = {"connect": 0, "preflight": 0, "execute": 0}
    from workbench_runtime import progress, remember_failure
    original = safe.SafeDmsExecutor

    def measure(phase, operation, event=None):
        progress(event or phase)
        start = time.perf_counter()
        try:
            return operation()
        except Exception as error:
            remember_failure(error)
            raise
        finally:
            timings[phase] += (time.perf_counter() - start) * 1000

    class TimedExecutor(original):
        def __init__(self, **kwargs):
            if profile is not None:
                kwargs["profile"] = profile
            if region is not None:
                kwargs["region"] = region
            super().__init__(**kwargs)

        def enable_ai_mode(self):
            return measure("connect", super().enable_ai_mode)

        def disable_ai_mode(self):
            progress("cleanup")
            try: return super().disable_ai_mode()
            except Exception as error:
                remember_failure(error)
                raise

        def execute(self, *args, **kwargs):
            progress("preflight")
            try: return super().execute(*args, **kwargs)
            except Exception as error:
                remember_failure(error)
                raise

        def execute_batches(self, *args, **kwargs):
            progress("preflight")
            try: return super().execute_batches(*args, **kwargs)
            except Exception as error:
                remember_failure(error)
                raise

        def command_json(self, command, extra):
            data = super().command_json(command, extra)
            if command in {"search-database", "list-databases"} and hasattr(self, "_target_filter"):
                from engine_policy import compatible_policy, engine_type
                identity, schema = self._target_filter
                rows = data.get("SearchDatabaseList", {}).get("SearchDatabase", []) if command == "search-database" else data.get("DatabaseList", {}).get("Database", [])
                for row in rows:
                    if isinstance(row, dict) and (not identity or str(row.get("DatabaseId")) == str(identity)) and (not schema or row.get("SchemaName") == schema):
                        if not compatible_policy(safe, engine_type(row.get("DbType")), instance_id):
                            raise safe.QueryRejectedError("External policy lacks required engine capabilities.")
            return data

        def resolve_database(self, *args, **kwargs):
            self._target_filter = (kwargs.get("database_id"), kwargs.get("schema"))
            if environment is not None:
                kwargs["environment"] = environment
            if instance_id is not None:
                kwargs["instance_id"] = instance_id
            return measure("connect", lambda: super(TimedExecutor, self).resolve_database(*args, **kwargs), "resolve")

        def _execute_raw(self, target, sql):
            final = safe.strip_comments(sql).strip().rstrip(";") == safe.strip_comments(expected).strip().rstrip(";") if expected is not None else safe.first_token(sql) == "select"
            return measure("execute" if final else "preflight",
                           lambda: super(TimedExecutor, self)._execute_raw(target, sql))

    safe.SafeDmsExecutor = TimedExecutor
    return timings


def report(timings):
    print(json.dumps({"status": "timing", "timings": timings}), file=sys.stderr)


def main():
    wrapper = Path(sys.argv.pop(1)).expanduser().resolve()
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--profile", default="dms-prod")
    parser.add_argument("--region", default="cn-hangzhou")
    parser.add_argument("--environment")
    parser.add_argument("--instance-id")
    parser.add_argument("--engine")
    settings, remaining = parser.parse_known_args(sys.argv[1:])
    sys.argv[1:] = remaining
    if wrapper.name != "execute_safe.py" or not wrapper.is_file():
        raise ValueError("An installed execute_safe.py is required")
    sys.path.insert(0, str(wrapper.parent))
    import execute_safe as safe
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "policy"))
    from engine_policy import compatible_policy
    from workbench_runtime import lifecycle_lock, progress
    from query_guard import QueryLockError
    if not compatible_policy(safe, settings.engine, settings.instance_id):
        print(json.dumps({"status":"configuration_error","reason":"policy_incompatible"}), file=sys.stderr)
        return 2
    sql = next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--sql="))
    timings = instrument(safe, sql.strip().rstrip(";"), profile=settings.profile, region=settings.region, environment=settings.environment, instance_id=settings.instance_id)
    try:
        progress("waiting")
        with lifecycle_lock(safe):
            return safe.main()
    except QueryLockError:
        print(json.dumps({"status":"query_in_flight"}), file=sys.stderr, flush=True)
        return 5
    finally:
        report(timings)


if __name__ == "__main__":
    sys.exit(main())
