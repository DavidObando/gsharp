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
import os
import time
import shutil
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRATCH = REPO / "out" / "test-lsp-soak"
SPEC = importlib.util.spec_from_file_location("lsp_soak", REPO / "build" / "lsp-soak.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/lsp-soak.py")
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
restarted = os.path.exists(os.environ["STUB_FLAG"])
stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
diagnostics = 0
doc_lines = 0

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
    if "params" in msg and msg["params"] is None:
        sys.exit(9)  # like the real server: a null params member ends the session
    # Debug traffic echo, as the real server's LoggingStream does: it must never count.
    log_line("Debug", "[IN] " + json.dumps(msg)[:300] + ' "Level":"Error","Message":')
    if method == "exit":
        sys.exit(0)
    if method == "initialized" and restarted and os.environ.get("STUB_STARTUP_ERROR"):
        log_line("Error", "Background workspace load failed: System.NullReferenceException: startup",
                 "System.NullReferenceException", "System.NullReferenceException: startup")
    if method == "textDocument/didOpen":
        doc_lines = msg["params"]["textDocument"]["text"].count("\n")
    if method == "textDocument/didChange":
        doc_lines = msg["params"]["contentChanges"][-1]["text"].count("\n")
    if rid is None:
        continue
    result = None
    if method == "shutdown" and mode == "exit-on-shutdown":
        sys.exit(5)
    if method == "shutdown" and mode == "error-on-shutdown":
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": "shutdown failed"}})
        continue
    if method == "initialize":
        if mode == "hang-initialize":
            time.sleep(30)
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
            if mode == "log-background":
                log_line("Error", "Background workspace load failed: System.NullReferenceException: x",
                         "System.NullReferenceException", "System.NullReferenceException: x")
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
    elif method == "textDocument/inlayHint" and msg["params"]["range"]["end"]["line"] > doc_lines:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "range past the end"}})
        continue
    elif method == "textDocument/hover" and mode == "garbage-stdout" and not os.path.exists(os.environ["STUB_FLAG"]):
        open(os.environ["STUB_FLAG"], "w").close()
        stdout.write(b"Content-Length: 9\r\n\r\nnot json!")
        stdout.flush()
        continue
    elif method == os.environ.get("STUB_FORBID"):
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})
        continue
    elif method == "textDocument/hover" and mode == "no-hover":
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})
        continue
    send({"jsonrpc": "2.0", "id": rid, "result": result})
'''


def soak_children() -> list[int]:
    """PIDs of live stub servers started by this test process."""
    pids = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()
            cmdline = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if int(stat[1]) == os.getpid() and stat[0] != "Z" and b"stub_server.py" in cmdline:
            pids.append(int(entry.name))
    return pids


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
        code = soak.main(["run", "--plan", str(self.plan), "--label", mode, "--out", str(out),
                          "--request-timeout", timeout,
                          "--server", f"{sys.executable} {self.stub}",
                          "--server-env", f"STUB_MODE={mode}", "--server-env", f"STUB_AT={at}",
                          "--server-env", f"STUB_FLAG={out}.fired"] + (extra or []))
        steps_file = out / "00-Widget.steps.json"
        result = json.loads(steps_file.read_text(encoding="utf-8")) if steps_file.exists() else {}
        return code, result

    def crash_steps(self, result: dict) -> dict[str, list[str]]:
        return {s["id"]: [c["kind"] for c in s["crashes"]] for s in result["steps"] if s["crashes"]}

    def planned_ids(self) -> list[str]:
        plan = json.loads(self.plan.read_text(encoding="utf-8"))
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

    def test_errors_logged_by_a_restarted_server_are_tagged(self) -> None:
        out = SCRATCH / "run-exit-startup"
        code = soak.main(["run", "--plan", str(self.plan), "--label", "exit-startup", "--out", str(out),
                          "--server", f"{sys.executable} {self.stub}",
                          "--server-env", "STUB_MODE=exit", "--server-env", "STUB_AT=3",
                          "--server-env", "STUB_STARTUP_ERROR=1", "--server-env", f"STUB_FLAG={out}.fired"])
        self.assertEqual(1, code)
        result = json.loads((out / "00-Widget.steps.json").read_text(encoding="utf-8"))
        third = result["steps"][2]
        self.assertTrue(third["restarted"])
        kinds = {c["kind"]: c for c in third["crashes"]}
        self.assertEqual({"process-exit", "logged-exception"}, set(kinds))
        self.assertTrue(kinds["logged-exception"]["afterRestart"])

    def test_non_json_output_is_a_process_failure_with_the_reason(self) -> None:
        code, result = self.run_stub("garbage-stdout")
        self.assertEqual(1, code)
        crashes = [c for s in result["steps"] for c in s["crashes"]]
        self.assertEqual(["process-exit"], [c["kind"] for c in crashes])
        self.assertIn("not JSON", crashes[0]["stderr"])
        self.assertEqual(1, result["restarts"])

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

    def test_only_the_level_field_marks_a_log_line_as_an_error(self) -> None:
        log = SCRATCH / "server.log"
        log.write_text(
            '{"Timestamp":"t","Level":"Debug","Message":"[IN] \\"Level\\":\\"Error\\",\\"Message\\":","Exception":null}\n'
            '{"Timestamp":"t","Level":"Info","Message":"m","Extra":{"Level":"Error"}}\n'
            '{"Timestamp":"t","Level":"Error","Message":"HoverAsync failed: boom","Exception":null}\n'
            '{"Level":"Error","Timestamp":"t","Message":"fields reordered"}\n'
            '{ "Timestamp": "t", "Level": "Error", "Message": "spaced out" }\n',
            encoding="utf-8")
        errors = soak.LogScanner(log).new_errors()
        self.assertEqual(["HoverAsync failed: boom", "fields reordered", "spaced out"],
                         [e["Message"] for e in errors])

    def test_line_counting_matches_the_band_definition(self) -> None:
        cases = {"a.gs": "", "b.gs": "one", "c.gs": "one\n", "d.gs": "one\ntwo", "e.gs": "1\n2\n3\n4\n"}
        for name, text in cases.items():
            path = SCRATCH / name
            path.write_text(text, encoding="utf-8")
            self.assertEqual(len(text.splitlines()), soak.count_lines(path, stop_after=100), name)
        self.assertEqual(3, soak.count_lines(SCRATCH / "e.gs", stop_after=2))

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

    def test_server_that_never_initializes_is_a_harness_error(self) -> None:
        code, _ = self.run_stub("hang-initialize", timeout="2")
        self.assertEqual(2, code)

    def test_brace_deletions_pick_distinct_braces(self) -> None:
        many = SCRATCH / "Braces.gs"
        many.write_text("package P\n" + "func F() {\n}\n" * 6, encoding="utf-8")
        plan = SCRATCH / "braces.json"
        for seed in range(20):
            soak.main(["plan", str(many), "--seed", str(seed), "--brace-deletions", "5", "--out", str(plan)])
            steps = json.loads(plan.read_text(encoding="utf-8"))["files"][0]["steps"]
            sites = [s["edits"][0][0] for s in steps if s["kind"].startswith("delete-brace-") and s["kind"] != "delete-brace-tail"]
            self.assertEqual(len(sites), len(set(sites)), f"seed {seed}")

    def test_exit_during_shutdown_is_recorded_on_the_last_step(self) -> None:
        code, result = self.run_stub("exit-on-shutdown")
        self.assertEqual(1, code)
        last = self.planned_ids()[-1]
        self.assertEqual({last: ["process-exit"]}, self.crash_steps(result))
        self.assertTrue(result["steps"][-1]["crashes"][0]["atShutdown"])

    def test_error_reply_to_shutdown_is_recorded_on_the_last_step(self) -> None:
        code, result = self.run_stub("error-on-shutdown")
        self.assertEqual(1, code)
        crash = result["steps"][-1]["crashes"][0]
        self.assertEqual(("rpc-error", "shutdown", True), (crash["kind"], crash["method"], crash["atShutdown"]))

    def test_restart_probe_respects_skipped_methods(self) -> None:
        out = SCRATCH / "run-probe"
        code = soak.main(["run", "--plan", str(self.plan), "--label", "probe", "--out", str(out),
                          "--server", f"{sys.executable} {self.stub}",
                          "--skip-method", "textDocument/documentSymbol",
                          "--server-env", "STUB_MODE=exit", "--server-env", "STUB_AT=3",
                          "--server-env", "STUB_FORBID=textDocument/documentSymbol",
                          "--server-env", f"STUB_FLAG={out}.fired"])
        self.assertEqual(1, code)  # the exit is recorded; a forbidden probe would make this 2

    def test_compare_aligns_background_exceptions_per_file(self) -> None:
        self.run_stub("log-background", at=2)
        early = SCRATCH / "early.json"
        shutil.copy(SCRATCH / "run-log-background" / "summary.json", early)
        shutil.rmtree(SCRATCH / "run-log-background")
        (SCRATCH / "run-log-background.fired").unlink()
        self.run_stub("log-background", at=4)
        late = SCRATCH / "run-log-background" / "summary.json"
        for path in (early, late):
            summary = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual({}, summary["files"][0]["stepCrashes"])
            self.assertEqual(1, len(summary["files"][0]["backgroundCrashes"]))
        self.assertEqual(0, soak.main(["compare", str(early), str(late)]))
        self.run_stub("clean")
        self.assertEqual(1, soak.main(["compare", str(SCRATCH / "run-clean" / "summary.json"), str(late)]))

    def test_compare_reports_one_sided_timeouts(self) -> None:
        self.run_stub("clean", timeout="2")
        self.run_stub("hang", at=2, timeout="2")
        out = SCRATCH / "timeouts.md"
        self.assertEqual(1, soak.main(["compare", str(SCRATCH / "run-clean" / "summary.json"),
                                       str(SCRATCH / "run-hang" / "summary.json"), "--out", str(out)]))
        self.assertIn(f"{self.planned_ids()[1]}: timeout on hang only", out.read_text(encoding="utf-8"))

    def test_compare_rejects_runs_with_different_settings(self) -> None:
        self.run_stub("clean")
        clean = SCRATCH / "clean.json"
        shutil.copy(SCRATCH / "run-clean" / "summary.json", clean)
        shutil.rmtree(SCRATCH / "run-clean")
        (SCRATCH / "run-clean.fired").unlink(missing_ok=True)
        self.run_stub("clean", extra=["--skip-method", "textDocument/hover"])
        self.assertEqual(2, soak.main(["compare", str(clean), str(SCRATCH / "run-clean" / "summary.json")]))

    def test_only_filter_matching_nothing_is_a_harness_error(self) -> None:
        code = soak.main(["run", "--plan", str(self.plan), "--label", "none", "--out", str(SCRATCH / "run-none"),
                          "--server", f"{sys.executable} {self.stub}", "--only", "NoSuchFile"])
        self.assertEqual(2, code)

    @unittest.skipUnless(Path("/proc").is_dir(), "process listing uses /proc")
    def test_harness_error_does_not_leak_the_server(self) -> None:
        before = set(soak_children())
        code, _ = self.run_stub("no-hover")
        self.assertEqual(2, code)
        time.sleep(0.5)
        self.assertEqual(set(), set(soak_children()) - before)

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
        steps = lambda p: json.loads(p.read_text(encoding="utf-8"))["files"][0]["steps"]  # noqa: E731
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
        text = out.read_text(encoding="utf-8")
        self.assertIn(f"{self.planned_ids()[3]}: log-error only", text)
        # A file run on one side only is reported, not silently skipped.
        partial = SCRATCH / "partial.json"
        summary = json.loads((SCRATCH / "run-clean" / "summary.json").read_text(encoding="utf-8"))
        summary["files"] = []
        partial.write_text(json.dumps(summary), encoding="utf-8")
        self.assertEqual(1, soak.main(["compare", str(SCRATCH / "run-clean" / "summary.json"), str(partial),
                                       "--out", str(out)]))
        self.assertIn("00-Widget: not run by clean", out.read_text(encoding="utf-8"))
        # A crash only on the left side is a divergence too.
        reverse = soak.main(["compare", str(SCRATCH / "run-log-error" / "summary.json"),
                             str(SCRATCH / "run-clean" / "summary.json")])
        self.assertEqual(1, reverse)

    def test_files_sharing_a_basename_keep_separate_results(self) -> None:
        other_dir = SCRATCH / "other"
        other_dir.mkdir()
        twin = other_dir / "Widget.gs"
        twin.write_text(SOURCE.replace("Widget", "Gadget"), encoding="utf-8")
        plan = SCRATCH / "twins.json"
        self.assertEqual(0, soak.main(["plan", str(self.source), str(twin), "--out", str(plan)]))
        out = SCRATCH / "run-twins"
        self.assertEqual(0, soak.main(["run", "--plan", str(plan), "--label", "twins", "--out", str(out),
                                       "--server", f"{sys.executable} {self.stub}",
                                       "--server-env", f"STUB_FLAG={out}.fired"]))
        self.assertTrue((out / "00-Widget.steps.json").exists())
        self.assertTrue((out / "01-Widget.steps.json").exists())
        summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(["00-Widget", "01-Widget"], [f["id"] for f in summary["files"]])

    def test_malformed_key_value_options_are_harness_errors(self) -> None:
        out = SCRATCH / "run-bad"
        for option in ("--server-env", "--meta"):
            for values in (["NOEQUALS"], ["K=1", "K=2"]):
                args = [arg for value in values for arg in (option, value)]
                code = soak.main(["run", "--plan", str(self.plan), "--label", "bad", "--out", str(out),
                                  "--server", f"{sys.executable} {self.stub}"] + args)
                self.assertEqual(2, code)
                self.assertFalse(out.exists())

    def test_first_step_times_open_and_later_steps_time_change(self) -> None:
        _, result = self.run_stub("clean")
        first, second = result["steps"][0], result["steps"][1]
        self.assertIn("openToDiagnosticsMs", first)
        self.assertNotIn("changeToDiagnosticsMs", first)
        self.assertIn("changeToDiagnosticsMs", second)
        self.assertIsNotNone(soak.summarize_file(result)["openToDiagnosticsMs"])

    def test_tiny_inputs_plan_and_run(self) -> None:
        empty = SCRATCH / "Empty.gs"
        empty.write_text("", encoding="utf-8")
        one_line = SCRATCH / "OneLine.gs"
        one_line.write_text("package P", encoding="utf-8")
        plan = SCRATCH / "tiny.json"
        self.assertEqual(0, soak.main(["plan", str(empty), str(one_line), "--out", str(plan)]))
        out = SCRATCH / "run-tiny"
        self.assertEqual(0, soak.main(["run", "--plan", str(plan), "--label", "tiny", "--out", str(out),
                                       "--server", f"{sys.executable} {self.stub}",
                                       "--server-env", f"STUB_FLAG={out}.fired"]))

    def test_server_command_resolves_relative_to_the_callers_directory(self) -> None:
        out = SCRATCH / "run-relative"
        relative_stub = os.path.relpath(self.stub)
        self.assertFalse(os.path.isabs(relative_stub))
        self.assertEqual(0, soak.main(["run", "--plan", str(self.plan), "--label", "relative", "--out", str(out),
                                       "--server", f"{sys.executable} {relative_stub}",
                                       "--server-env", f"STUB_FLAG={out}.fired"]))

    def test_compare_refuses_summaries_without_a_plan_hash(self) -> None:
        self.run_stub("clean")
        current = SCRATCH / "run-clean" / "summary.json"
        self.assertEqual(0, soak.main(["compare", str(current), str(current)]))
        base = json.loads(current.read_text(encoding="utf-8"))
        del base["planSha256"]
        old = SCRATCH / "old.json"
        old.write_text(json.dumps(base), encoding="utf-8")
        self.assertEqual(2, soak.main(["compare", str(old), str(old)]))

    def test_utf16_positions(self) -> None:
        index = soak.LineIndex("ab\n\U0001F600x\n")
        self.assertEqual({"line": 1, "character": 3}, index.position(5))


if __name__ == "__main__":
    unittest.main()
