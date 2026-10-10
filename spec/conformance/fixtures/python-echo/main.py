"""me plugin written in plain Python 3 (standard library only, no SDK).

Speaks JSON-RPC 2.0 over NDJSON on stdin/stdout (docs/PROTOCOL.md).
stdout carries protocol frames only; logs go to stderr.

Methods:
  echo  {text?}            -> {said}
  count {n?, delayMs?}     -> streams op.update {i} for i in 1..n, then {count: n}
"""

import json
import sys
import threading
import time

PROTOCOL_VERSION = 1
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
CANCELLED = -32004

_out = threading.Lock()
_cancelled = set()


def log(*args):
    print("[python-echo]", *args, file=sys.stderr, flush=True)


def send(frame):
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    with _out:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def echo(params, update, opid):
    return {"said": params.get("text")}


def count(params, update, opid):
    n = params.get("n", 3)
    delay = params.get("delayMs", 10) / 1000
    if not isinstance(n, int) or n < 0:
        raise RpcError(INVALID_PARAMS, "n must be a non-negative integer")
    for i in range(1, n + 1):
        if opid in _cancelled:
            raise RpcError(CANCELLED, "cancelled")
        update({"i": i})
        time.sleep(delay)
    return {"count": n}


METHODS = {"echo": echo, "count": count}


def run_stream(handler, params, opid):
    try:
        result = handler(params, lambda u: notify("op.update", {"opId": opid, "update": u}), opid)
        notify("op.end", {"opId": opid, "result": result})
    except RpcError as e:
        notify("op.end", {"opId": opid, "error": {"code": e.code, "message": e.message}})
    except Exception as e:  # noqa: BLE001 - every failure must still end the op
        notify("op.end", {"opId": opid, "error": {"code": -32603, "message": str(e)}})
    finally:
        _cancelled.discard(opid)


def on_call(p):
    method = p.get("method")
    handler = METHODS.get(method)
    if handler is None:
        raise RpcError(METHOD_NOT_FOUND, "python-echo has no method %s" % method)
    params = p.get("params") if isinstance(p.get("params"), dict) else {}
    opid = p.get("opId")
    if p.get("stream") and opid:
        threading.Thread(target=run_stream, args=(handler, params, opid), daemon=True).start()
        return {"accepted": True}
    return handler(params, lambda u: None, None)


def handle_request(rid, method, params):
    """Returns (result, keep_running)."""
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION), "ready": True}, True
    if method == "shutdown":
        return {}, False
    if method == "call":
        return on_call(params or {}), True
    raise RpcError(METHOD_NOT_FOUND, "unknown method: %s" % method)


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            frame = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        method = frame.get("method")
        rid = frame.get("id")
        if method is None:
            continue  # a response; this plugin never calls the kernel
        if rid is None:
            if method == "op.cancel":
                _cancelled.add((frame.get("params") or {}).get("opId"))
            continue
        try:
            result, keep_running = handle_request(rid, method, frame.get("params"))
            send({"jsonrpc": "2.0", "id": rid, "result": result})
        except RpcError as e:
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": e.code, "message": e.message}})
            keep_running = True
        except Exception as e:  # noqa: BLE001
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": str(e)}})
            keep_running = True
        if not keep_running:
            log("shutdown")
            return


if __name__ == "__main__":
    main()
