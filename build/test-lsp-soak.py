#!/usr/bin/env python3
"""Tests for build/lsp-soak.py's crash detection (ADR-0154 witnesses).

The soak's value is that it notices a crash, so each detection channel is
driven by a stub language server that misbehaves in exactly one way, plus a
clean stub that must produce zero crash records. Like the soak itself this is
a manual tool, deliberately not wired into CI: run it with
`python3 build/test-lsp-soak.py` after changing build/lsp-soak.py.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRATCH = REPO / "out" / "test-lsp-soak"
SPEC = importlib.util.spec_from_file_location("lsp_soak", REPO / "build" / "lsp-soak.py")
assert SPEC and SPEC.loader
soak = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(soak)

SOURCE = """package Demo

import System

type Widget class {
    func Area(width int, height int) int {
        let label = "a string literal"
        let items = List[Widget]()
        return width * height
    }

    func Name(value string?) string {
        return value!!.Trim()
    }
}
"""

# A minimal LSP server over stdio. STUB_MODE picks the one misbehaviour; the
# trigger is the STUB_AT-th textDocument/diagnostic request (1-based) of the
# first server process; STUB_FLAG makes it fire once, so a restarted stub is clean.
STUB = r'''
import json, os, sys, time
mode = os.environ.get("STUB_MODE", "clean")
at = int(os.environ.get("STUB_AT", "3"))
log = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--log=")), None)
stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
diagnostics = 0

def log_line(level, message, exc_type=None, exc=None):
    if log:
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"Timestamp": "t", "Level": level, "Message": message,
                                "ExceptionType": exc_type, "Exception": exc}, separators=(",", ":")) + "\n")

def send(msg):
    body = json.dumps(msg).encode()
    stdout.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    stdout.flush()

while True:
    length = None
    while True:
        line = stdin.readline()
        if not line:
            sys.exit(0)
        line = line.strip()
        if not line:
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":")[1])
    msg = json.loads(stdin.read(length))
    method, rid = msg.get("method"), msg.get("id")
    # Debug traffic echo, as the real server's LoggingStream does: it must never count.
    log_line("Debug", "[IN] " + json.dumps(msg)[:300] + ' "Level":"Error","Message":')
    if method == "exit":
        sys.exit(0)
    if rid is None:
        continue
    result = None
    if method == "initialize":
        result = {"capabilities": {}}
    elif method == "textDocument/diagnostic":
        diagnostics += 1
        items = []
        flag = os.environ["STUB_FLAG"]
        if diagnostics == at and not os.path.exists(flag):
            open(flag, "w").close()
            if mode == "exit":
                sys.exit(3)
            if mode == "ice":
                items = [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
                          "severity": 1, "code": "GS9998", "message": "internal compiler error"}]
            if mode == "log-error":
                log_line("Error", "HoverAsync failed: System.NullReferenceException: boom",
                         "System.NullReferenceException",
                         "System.NullReferenceException: boom\n   at GSharp.Core.Binder.Bind()\n   at X.Y()")
            if mode == "hang":
                time.sleep(30)
            if mode == "rpc-error":
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": "internal"}})
                continue
            if mode == "cancelled":
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32800, "message": "cancelled"}})
                continue
        result = {"kind": "full", "items": items}
    elif method == "textDocument/hover" and mode == "no-hover":
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})
        continue
    send({"jsonrpc": "2.0", "id": rid, "result": result})
'''


class LspSoakTests(unittest.TestCase):
    def setUp(self) -> None:
        shutil.rmtree(SCRATCH, ignore_errors=True)
        SCRATCH.mkdir(parents=True)
        self.source = SCRATCH / "Widget.gs"
        self.source.write_text(SOURCE, encoding="utf-8")
        self.stub = SCRATCH / "stub_server.py"
        self.stub.write_text(STUB, encoding="utf-8")
        self.plan = SCRATCH / "plan.json"
        self.assertEqual(0, soak.main(["plan", str(self.source), "--seed", "7", "--out", str(self.plan)]))

    def tearDown(self) -> None:
        shutil.rmtree(SCRATCH, ignore_errors=True)

    def run_stub(self, mode: str, at: int = 3, timeout: str = "300", extra: list[str] | None = None) -> tuple[int, dict]:
        out = SCRATCH / f"run-{mode}"
        env_prefix = f"env STUB_MODE={mode} STUB_AT={at} STUB_FLAG={out}.fired "
        code = soak.main(["run", "--plan", str(self.plan), "--label", mode, "--out", str(out),
                          "--request-timeout", timeout,
                          "--server", env_prefix + f"{sys.executable} {self.stub}"] + (extra or []))
        steps_file = out / "Widget.steps.json"
        result = json.loads(steps_file.read_text()) if steps_file.exists() else {}
        return code, result

    def crash_steps(self, result: dict) -> dict[str, list[str]]:
        return {s["id"]: [c["kind"] for c in s["crashes"]] for s in result["steps"] if s["crashes"]}

    def planned_ids(self) -> list[str]:
        plan = json.loads(self.plan.read_text())
        return [s["id"] for s in plan["files"][0]["steps"]]

    def test_clean_server_records_every_step_and_no_crash(self) -> None:
        code, result = self.run_stub("clean")
        self.assertEqual(0, code)
        self.assertEqual(self.planned_ids(), [s["id"] for s in result["steps"]])
        self.assertEqual({}, self.crash_steps(result))
        self.assertEqual(0, result["restarts"])

    def test_cancelled_request_is_not_a_crash(self) -> None:
        code, result = self.run_stub("cancelled")
        self.assertEqual(0, code)
        self.assertEqual({}, self.crash_steps(result))

    def test_process_exit_is_recorded_on_its_step_and_the_soak_continues(self) -> None:
        code, result = self.run_stub("exit", at=3)
        self.assertEqual(1, code)
        third = self.planned_ids()[2]
        self.assertEqual({third: ["process-exit"]}, self.crash_steps(result))
        self.assertEqual(1, result["restarts"])
        self.assertEqual(len(self.planned_ids()), len(result["steps"]))

    def test_rpc_error_is_recorded(self) -> None:
        code, result = self.run_stub("rpc-error", at=2)
        self.assertEqual(1, code)
        self.assertEqual({self.planned_ids()[1]: ["rpc-error"]}, self.crash_steps(result))

    def test_logged_exception_is_recorded_with_its_type_and_debug_echo_is_ignored(self) -> None:
        code, result = self.run_stub("log-error", at=4)
        self.assertEqual(1, code)
        self.assertEqual({self.planned_ids()[3]: ["logged-exception"]}, self.crash_steps(result))
        crash = next(c for s in result["steps"] for c in s["crashes"])
        self.assertEqual("System.NullReferenceException", crash["exceptionType"])
        self.assertEqual("logged-exception:HoverAsync:System.NullReferenceException", crash["signature"])
        self.assertIn("at GSharp.Core.Binder.Bind()", crash["frames"])

    def test_internal_compiler_error_diagnostic_is_recorded(self) -> None:
        code, result = self.run_stub("ice", at=5)
        self.assertEqual(1, code)
        self.assertEqual({self.planned_ids()[4]: ["ice"]}, self.crash_steps(result))

    def test_hang_is_a_timeout_not_a_crash_and_the_server_is_restarted(self) -> None:
        code, result = self.run_stub("hang", at=2, timeout="2")
        self.assertEqual(1, code)
        self.assertEqual({}, self.crash_steps(result))
        hung = result["steps"][1]
        self.assertEqual(1, len(hung["timeouts"]))
        self.assertEqual(1, result["restarts"])

    def test_method_not_found_is_a_harness_error(self) -> None:
        code, _ = self.run_stub("no-hover")
        self.assertEqual(2, code)

    def test_skipped_method_is_never_sent(self) -> None:
        code, result = self.run_stub("no-hover", extra=["--skip-method", "textDocument/hover"])
        self.assertEqual(0, code)
        self.assertTrue(all("textDocument/hover" not in s["timings"] for s in result["steps"]))

    def test_plan_is_deterministic_and_reproduces_each_document(self) -> None:
        again = SCRATCH / "again.json"
        other = SCRATCH / "other.json"
        soak.main(["plan", str(self.source), "--seed", "7", "--out", str(again)])
        soak.main(["plan", str(self.source), "--seed", "8", "--out", str(other)])
        steps = lambda p: json.loads(p.read_text())["files"][0]["steps"]  # noqa: E731
        self.assertEqual(steps(self.plan), steps(again))
        self.assertNotEqual(steps(self.plan), steps(other))
        kinds = {s["kind"] for s in steps(self.plan)}
        for expected in ("open-full", "truncate-mid-string", "truncate-mid-generic-args", "truncate-mid-bangbang",
                         "delete-brace-0", "garbage-0", "edit-type-param", "edit-undo-rename"):
            self.assertIn(expected, kinds)
        bang = next(s for s in steps(self.plan) if s["kind"] == "truncate-mid-bangbang")
        self.assertTrue(soak.apply_edits(SOURCE, bang["edits"]).endswith("value!"))
        last = steps(self.plan)[-1]
        self.assertEqual(SOURCE, soak.apply_edits(SOURCE, last["edits"]))

    def test_compare_reports_steps_that_crash_only_on_one_side(self) -> None:
        self.run_stub("clean")
        self.run_stub("log-error", at=4)
        out = SCRATCH / "compare.md"
        code = soak.main(["compare", str(SCRATCH / "run-clean" / "summary.json"),
                          str(SCRATCH / "run-log-error" / "summary.json"), "--out", str(out)])
        self.assertEqual(1, code)
        text = out.read_text()
        self.assertIn(f"{self.planned_ids()[3]}: log-error only", text)

    def test_utf16_positions(self) -> None:
        index = soak.LineIndex("ab\n\U0001F600x\n")
        self.assertEqual({"line": 1, "character": 3}, index.position(5))


if __name__ == "__main__":
    unittest.main()
