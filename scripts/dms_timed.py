"""Measure the approved DMS executor without changing its query policy or lifecycle."""
import json
from pathlib import Path
import sys
import time


def instrument(safe, expected=None):
    timings = {"connect": 0, "preflight": 0, "execute": 0}
    original = safe.SafeDmsExecutor

    def measure(phase, operation):
        start = time.perf_counter()
        try:
            return operation()
        finally:
            timings[phase] += (time.perf_counter() - start) * 1000

    class TimedExecutor(original):
        def enable_ai_mode(self):
            return measure("connect", super().enable_ai_mode)

        def resolve_database(self, *args, **kwargs):
            return measure("connect", lambda: super(TimedExecutor, self).resolve_database(*args, **kwargs))

        def _execute_raw(self, target, sql):
            final = sql.strip().rstrip(";") == expected if expected is not None else sql.startswith("SELECT /*+ ")
            return measure("execute" if final else "preflight",
                           lambda: super(TimedExecutor, self)._execute_raw(target, sql))

    safe.SafeDmsExecutor = TimedExecutor
    return timings


def report(timings):
    print(json.dumps({"status": "timing", "timings": timings}), file=sys.stderr)


def main():
    wrapper = Path(sys.argv.pop(1)).expanduser().resolve()
    if wrapper.name != "execute_safe.py" or not wrapper.is_file():
        raise ValueError("An installed execute_safe.py is required")
    sys.path.insert(0, str(wrapper.parent))
    import execute_safe as safe
    sql = next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--sql="))
    timings = instrument(safe, sql.strip().rstrip(";"))
    try:
        return safe.main()
    finally:
        report(timings)


if __name__ == "__main__":
    sys.exit(main())
