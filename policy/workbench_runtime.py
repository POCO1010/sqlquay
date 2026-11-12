"""Safe execution events and a lifecycle-owned lock for bundled and legacy DMS entry points."""
from contextlib import contextmanager
import json
import re
import sys
from threading import get_ident

PHASES = {"prepare", "waiting", "connect", "resolve", "preflight", "execute", "cleanup"}
CODES = {"drds_multishard", "drds_shard_unknown", "drds_plan_incomplete", "scan_unknown", "scan_limit", "index_unverified", "scope_required", "explicit_columns", "credential_field", "authentication_failed", "permission_denied", "connection_failed"}
_phase = None

def progress(phase):
    global _phase
    if phase in PHASES and phase != _phase:
        _phase = phase
        print(json.dumps({"status":"progress", "phase":phase}), file=sys.stderr, flush=True)

def coded(error, code, **details):
    error._dbw_diagnostic = dict(code=code, **details)
    return error

def diagnostic(error):
    current = error
    data = {}
    for _ in range(8):
        if getattr(current, "_dbw_diagnostic", None):
            data = dict(current._dbw_diagnostic)
            break
        if current.__cause__ is None: break
        current = current.__cause__
    if data.get("code") not in CODES:
        text = str(error).lower()
        rules = [
            ("scan_unknown", r"estimate.*unknown|usable row estimate|estimate is incomplete|full.scan estimate is unknown"),
            ("scan_limit", r"scan estimate exceeds|explain estimates .*exceeding|exceeding the .*limit"),
            ("index_unverified", r"leading index|index validation|no qualified bounded|verified.*index"),
            ("scope_required", r"require.*bounded|bounded.*predicate|explicit bounded"),
            ("explicit_columns", r"select \* is not allowed"),
            ("credential_field", r"credential fields|sensitive fields are referenced"),
            ("authentication_failed", r"invalidaccesskey|signaturedoesnotmatch|authentication failed|credentials.*expired"),
            ("permission_denied", r"accessdenied|access denied|permission denied|forbidden|not authorized"),
            ("connection_failed", r"jdbc sqlstate 08|jdbc connection did not start|could not start jdbc"),
        ]
        code = next((code for code, pattern in rules if re.search(pattern, text)), None)
        data = {"code":code} if code else {}
    result = {"code":data["code"]} if data.get("code") in CODES else {}
    phase = getattr(error, "_dbw_phase", None) or getattr(current, "_dbw_phase", None)
    if phase in PHASES: result["phase"] = phase
    for key in ("estimatedRows", "maxRows", "shards"):
        value = data.get(key)
        if type(value) is int and 0 <= value <= 9007199254740991: result[key] = value
    return result

def remember_failure(error):
    if not hasattr(error, "_dbw_phase") and _phase in PHASES: error._dbw_phase = _phase
    if not getattr(error, "_dbw_reported", False):
        error._dbw_reported = True
        print(json.dumps({"status":"diagnostic", "diagnostic":diagnostic(error)}), file=sys.stderr, flush=True)
    return error

@contextmanager
def lifecycle_lock(module):
    from query_guard import single_query_lock
    original = getattr(module, "single_query_lock", single_query_lock)
    existed = hasattr(module, "single_query_lock")
    owner = get_ident()
    with original():
        @contextmanager
        def owned(*args, **kwargs):
            # Only this thread's default inner lock borrows the already-held lifecycle lock.
            if get_ident() == owner and not args and not kwargs:
                yield
            else:
                with original(*args, **kwargs): yield
        module.single_query_lock = owned
        try: yield
        finally:
            if existed: module.single_query_lock = original
            else: del module.single_query_lock
