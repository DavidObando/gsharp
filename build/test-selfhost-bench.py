#!/usr/bin/env python3
"""Regression tests for build/selfhost-bench.py (issue #4631, C6)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("selfhost_bench", REPO / "build" / "selfhost-bench.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/selfhost-bench.py")
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)


def fake_compiler(directory: Path, name: str, seconds: float, megabytes: int = 1, exit_code: int = 0) -> str:
    """An executable that stands in for gsc: burns CPU, allocates, checks its @rsp."""
    path = directory / name
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import sys, time\n"
        "assert sys.argv[1].startswith('@')\n"
        f"block = bytearray({megabytes} * 1024 * 1024)\n"
        "for i in range(0, len(block), 4096):\n"
        "    block[i] = 1\n"
        # Busy work, not sleep: a compiler spends its wall time on CPU.
        f"end = time.process_time() + {seconds}\n"
        "while time.process_time() < end:\n"
        "    pass\n"
        f"sys.exit({exit_code})\n",
        encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def run(argv: list[str]) -> int:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return bench.main(argv)


class RedirectTests(unittest.TestCase):
    def test_every_output_option_moves_and_inputs_stay(self) -> None:
        rsp = ("/out:/tree/out/obj/Core/Release/GSharp.Core.dll\n/pdb:/tree/out/obj/Core/Release/GSharp.Core.pdb\n"
               "/refout:/tree/out/obj/Core/Release/refint/GSharp.Core.dll\n/doc:/tree/out/bin/Core/GSharp.Core.xml\n"
               "/log:/tree/out/logs/gsc.log\n"
               "/deterministic+\n/r:/packs/System.Runtime.dll\n/tree/src/Core/Binder.gs\n")
        redirected = bench.redirect_outputs(rsp, Path("/work/run"))
        self.assertIn("/out:/work/run/GSharp.Core.dll", redirected)
        self.assertIn("/pdb:/work/run/GSharp.Core.pdb", redirected)
        self.assertIn("/refout:/work/run/ref-GSharp.Core.dll", redirected)
        self.assertIn("/doc:/work/run/GSharp.Core.xml", redirected)
        self.assertIn("/log:/work/run/gsc.log", redirected)
        self.assertIn("/r:/packs/System.Runtime.dll", redirected)
        self.assertIn("/tree/src/Core/Binder.gs", redirected)
        self.assertNotIn("/tree/out/", redirected)

    def test_a_path_with_spaces_is_quoted(self) -> None:
        redirected = bench.redirect_outputs("/out:/tree/a.dll\n", Path("/work dir/run"))
        self.assertIn('/out:"/work dir/run/a.dll"', redirected)

    def test_bare_log_uses_a_run_local_default_without_changing_other_empty_options(self) -> None:
        for spelling in ("/log:", '"/log:"', "/LOG:"):
            with self.subTest(spelling=spelling):
                self.assertEqual(
                    '/log:"/work dir/run/gsharp-compiler-debug.log"\n/out:\n',
                    bench.redirect_outputs(spelling + "\n/out:\n", Path("/work dir/run")))


class BuildTaskSpellingTests(unittest.TestCase):
    def test_a_whole_token_quoted_output_option_is_redirected(self) -> None:
        # The SDK's BuildTask writes "/out:path with spaces" as one quoted token.
        rsp = '"/out:/tree/my out/obj/GSharp.Core.dll"\n"/pdb:/tree/my out/obj/GSharp.Core.pdb"\n/r:/a.dll\n'
        redirected = bench.redirect_outputs(rsp, Path("/work/run"))
        self.assertIn("/out:/work/run/GSharp.Core.dll", redirected)
        self.assertIn("/pdb:/work/run/GSharp.Core.pdb", redirected)
        self.assertNotIn("/tree/", redirected)


class VerdictTests(unittest.TestCase):
    def summary(self, wall: float, cpu: float, rss: float) -> dict:
        return {"wallSeconds": {"median": wall}, "cpuSeconds": {"median": cpu}, "maxRssMb": {"median": rss}}

    def test_within_budget(self) -> None:
        result = bench.verdict(self.summary(100, 100, 1000), self.summary(140, 120, 1400), 1.5)
        self.assertTrue(result["withinBudget"])
        self.assertEqual(1.4, result["ratios"]["wallSeconds"])

    def test_memory_alone_can_break_the_budget(self) -> None:
        result = bench.verdict(self.summary(100, 100, 1000), self.summary(100, 100, 1600), 1.5)
        self.assertEqual(["maxRssMb"], result["overBudget"])

    def test_the_budget_decision_uses_the_unrounded_ratio(self) -> None:
        # 1.5004 rounds to 1.5 for display but is over a 1.5 budget.
        result = bench.verdict(self.summary(10000, 10000, 10000), self.summary(15004, 10000, 10000), 1.5)
        self.assertEqual(["wallSeconds"], result["overBudget"])
        self.assertFalse(result["withinBudget"])

    def test_parse_time_reads_the_last_measurement(self) -> None:
        measured = bench.parse_time("warning: x\nBENCH 1.0 0.5 0.1 2048\nBENCH 12.34 10.00 0.50 1048576\n")
        self.assertEqual({"wallSeconds": 12.34, "cpuSeconds": 10.5, "maxRssMb": 1024.0}, measured)


class GateTests(unittest.TestCase):
    """End to end through GNU time with stand-in compilers."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rsp = self.root / "Core.rsp"
        self.rsp.write_text("/out:/nowhere/GSharp.Core.dll\n/tree/src/Core/A.gs\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def gate(self, native: str, migrated: str) -> tuple[int, dict]:
        work = self.root / "work"
        code = run(["--rsp", str(self.rsp), "--native", native, "--migrated", migrated,
                    "--runs", "3", "--warmup", "0", "--work", str(work)])
        return code, json.loads((work / "bench-report.json").read_text())

    def test_an_equal_compiler_passes(self) -> None:
        code, report = self.gate(fake_compiler(self.root, "native", 0.2), fake_compiler(self.root, "migrated", 0.2))
        self.assertEqual(0, code, report)
        self.assertEqual(3, len(report["migratedRuns"]))

    def test_a_three_times_slower_compiler_fails(self) -> None:
        # The deliberately broken input: a "migrated" compiler 3x slower.
        code, report = self.gate(fake_compiler(self.root, "native", 0.2), fake_compiler(self.root, "migrated", 0.6))
        self.assertEqual(1, code, report)
        self.assertIn("wallSeconds", report["verdict"]["overBudget"])

    def test_a_memory_hungry_compiler_fails(self) -> None:
        code, report = self.gate(fake_compiler(self.root, "native", 0.1, megabytes=20),
                                 fake_compiler(self.root, "migrated", 0.1, megabytes=200))
        self.assertEqual(1, code, report)
        self.assertIn("maxRssMb", report["verdict"]["overBudget"])

    def test_a_negative_warmup_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            run(["--rsp", str(self.rsp), "--native", "x", "--migrated", "y", "--warmup", "-1",
                 "--work", str(self.root / "work")])

    def test_a_non_finite_or_non_positive_budget_is_rejected(self) -> None:
        for value in ("nan", "inf", "0", "-1"):
            with self.subTest(budget=value), self.assertRaises(SystemExit):
                run(["--rsp", str(self.rsp), "--native", "x", "--migrated", "y", "--budget", value,
                     "--work", str(self.root / "work")])

    def test_a_relative_compiler_path_resolves_against_the_callers_directory(self) -> None:
        native = fake_compiler(self.root, "native", 0.0)
        migrated = fake_compiler(self.root, "migrated", 0.0)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        previous = Path.cwd()
        os.chdir(self.root)
        try:
            work = self.root / "work"
            code = run(["--rsp", str(self.rsp), "--native", "./native", "--migrated", "./migrated",
                        "--runs", "1", "--warmup", "0", "--cwd", str(elsewhere), "--work", str(work)])
        finally:
            os.chdir(previous)
        # Both compilers ran (the verdict itself is noise for zero-work fakes).
        self.assertIn(code, (0, 1))
        self.assertNotIn("error", json.loads((work / "bench-report.json").read_text()))

    def test_a_missing_compiler_is_a_tool_error(self) -> None:
        code, report = self.gate(str(self.root / "no-such-compiler"), fake_compiler(self.root, "migrated", 0.0))
        self.assertEqual(2, code)
        self.assertIn("native run 0 failed", report["error"])

    def test_a_missing_working_directory_is_a_tool_error_not_a_traceback(self) -> None:
        work = self.root / "work"
        code = run(["--rsp", str(self.rsp), "--native", fake_compiler(self.root, "native", 0.0),
                    "--migrated", fake_compiler(self.root, "migrated", 0.0), "--runs", "1", "--warmup", "0",
                    "--cwd", str(self.root / "no-such-dir"), "--work", str(work)])
        self.assertEqual(2, code)
        self.assertIn("could not start", json.loads((work / "bench-report.json").read_text())["error"])

    def test_a_failing_compile_is_a_tool_error(self) -> None:
        code, report = self.gate(fake_compiler(self.root, "native", 0.0),
                                 fake_compiler(self.root, "migrated", 0.0, exit_code=3))
        self.assertEqual(2, code)
        self.assertIn("migrated run 0 failed", report["error"])


if __name__ == "__main__":
    unittest.main()
