#!/usr/bin/env python3
"""Regression tests for build/compiler-bench.py (issue #5127, Q9)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import struct
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("compiler_bench", REPO / "build" / "compiler-bench.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/compiler-bench.py")
cb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cb)

CHECKSUM_OFFSET = 0x80 + 24 + 64
DEBUG_DIR = 0x200
DEBUG_PAYLOAD = 0x300
BODY = 0x400


def synthetic_pe() -> bytes:
    """A minimal PE32+ with one section, a debug directory entry and its payload."""
    data = bytearray(0x600)
    data[0:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<H", data, 0x80 + 6, 1)       # sections
    struct.pack_into("<H", data, 0x80 + 20, 0xF0)   # optional header size
    optional = 0x80 + 24
    struct.pack_into("<H", data, optional, 0x20B)
    struct.pack_into("<I", data, optional + 112 + 6 * 8, 0x1200)  # debug directory RVA
    struct.pack_into("<I", data, optional + 112 + 6 * 8 + 4, 28)
    section = optional + 0xF0
    struct.pack_into("<IIII", data, section + 8, 0x600, 0x1000, 0x600, 0x0)  # vsize, rva, rawsize, rawptr (offsets +8..+20)
    struct.pack_into("<I", data, DEBUG_DIR + 16, 8)
    struct.pack_into("<I", data, DEBUG_DIR + 24, DEBUG_PAYLOAD)
    data[DEBUG_PAYLOAD:DEBUG_PAYLOAD + 8] = b"RSDSpdb1"
    data[BODY:BODY + 16] = b"method-body-0123"
    return bytes(data)


def fake_compiler(directory: Path, name: str, *, pdb: str = "pdb", ref: str = "ref", doc: str = "doc",
                  log: str = "ok", checksum: int = 0, body: str = "", noise: bool = False,
                  seconds: float = 0.0, exit_code: int = 0) -> str:
    """An executable standing in for gsc: writes every output the @rsp names."""
    dll = bytearray(synthetic_pe())
    if checksum:
        dll[CHECKSUM_OFFSET:CHECKSUM_OFFSET + 4] = struct.pack("<I", checksum)
        dll[DEBUG_PAYLOAD:DEBUG_PAYLOAD + 8] = b"RSDSpdb2"
    if body:
        dll[BODY:BODY + len(body)] = body.encode()
    path = directory / name
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, time\n"
        "rsp = open(sys.argv[1][1:], encoding='utf-8').read()\n"
        "assert not rsp.startswith('\\ufeff')\n"
        "paths = {}\n"
        "for line in rsp.splitlines():\n"
        "    for option in ('/out:', '/pdb:', '/refout:', '/doc:'):\n"
        "        if line.startswith(option):\n"
        "            paths[option] = line[len(option):]\n"
        f"dll = bytearray({bytes(dll)!r})\n"
        f"if {noise!r}:\n"
        "    dll[0x420:0x428] = os.urandom(8)\n"
        "open(paths['/out:'], 'wb').write(dll)\n"
        f"open(paths['/pdb:'], 'w').write({pdb!r})\n"
        f"open(paths['/refout:'], 'w').write({ref!r})\n"
        f"open(paths['/doc:'], 'w').write({doc!r})\n"
        f"print({log!r}, os.path.dirname(paths['/out:']))\n"
        "phases = {'Phases': [{'Name': 'parse', 'ElapsedMilliseconds': 5.0, 'ProcessAllocatedBytes': 1048576},\n"
        "                     {'Name': 'parse', 'ElapsedMilliseconds': 7.0, 'ProcessAllocatedBytes': 1048576}],\n"
        "          'Counters': {'symbols': 3}}\n"
        "open(os.environ['GSHARP_MEASURE_PHASES'], 'w').write(json.dumps(phases))\n"
        f"end = time.process_time() + {seconds}\n"
        "while time.process_time() < end:\n"
        "    pass\n"
        f"sys.exit({exit_code})\n",
        encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


class BenchTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # The work root must not be under /tmp, like real use; keep it off tmpfs.
        base = Path.home() / ".cache" / "q9-bench-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(dir=base))
        self.addCleanup(self.remove_root)
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "a.gs").write_text("func main() {}\n", encoding="utf-8")
        (self.project / "hello.gs").write_text("func main() {}\n", encoding="utf-8")
        self.rsp = self.root / "core.rsp"
        # The SDK writes a BOM; the script must read it as utf-8-sig.
        self.rsp.write_bytes(b"\xef\xbb\xbf/out:/tree/obj/Core.dll\n/pdb:/tree/obj/Core.pdb\n"
                             b"/refout:/tree/obj/ref/Core.dll\n/doc:/tree/bin/Core.xml\n/optimize+\n"
                             + str(self.project / "a.gs").encode() + b"\n")
        self.work = self.root / "work"

    def remove_root(self) -> None:
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def bench(self, baseline: str, candidate: str, *extra: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cb.main(["--baseline", baseline, "--candidate", candidate,
                            "--cell", "core", str(self.rsp), str(self.project),
                            "--runs", "3", "--warmup", "0", "--work", str(self.work), *extra])
        return code, out.getvalue(), err.getvalue()

    def report(self) -> dict:
        return json.loads((self.work / "compiler-bench-report.json").read_text(encoding="utf-8"))


class ParityTests(BenchTestCase):
    def test_identical_outputs_are_green_and_phases_are_aggregated(self) -> None:
        a = fake_compiler(self.root, "a")
        b = fake_compiler(self.root, "b")
        code, out, err = self.bench(a, b)
        self.assertEqual(0, code, err)
        cell = self.report()["cells"]["core"]
        self.assertEqual([], cell["problems"])
        self.assertTrue(cell["parity"]["candidate"]["implementation"]["identical"])
        # Two 'parse' spans per run aggregate by name into one row: count 2, 12 ms.
        self.assertEqual({"count": 2, "wallMs": 12.0, "allocMiB": 2.0}, cell["candidate"]["phases"]["parse"])
        self.assertEqual(3, cell["candidate"]["counters"]["symbols"])
        self.assertEqual(3, len(cell["baselineRuns"]))
        self.assertIn("baseline-vs-baseline control: identical", out)

    def test_a_pdb_difference_fails(self) -> None:
        code, _, err = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", pdb="other"))
        self.assertEqual(1, code)
        self.assertIn("pdb differs", " ".join(self.report()["cells"]["core"]["problems"]))

    def test_reference_assembly_and_xml_doc_differences_fail(self) -> None:
        code, _, _ = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", ref="x", doc="y"))
        self.assertEqual(1, code)
        problems = " ".join(self.report()["cells"]["core"]["problems"])
        self.assertIn("refout differs", problems)
        self.assertIn("doc differs", problems)

    def test_a_diagnostics_difference_fails(self) -> None:
        code, _, _ = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", log="warning GS1"))
        self.assertEqual(1, code)
        self.assertIn("diagnostics differ", " ".join(self.report()["cells"]["core"]["problems"]))

    def test_identity_group_bytes_are_reported_but_pass(self) -> None:
        code, out, err = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", checksum=0xDEADBEEF))
        self.assertEqual(0, code, err)
        impl = self.report()["cells"]["core"]["parity"]["candidate"]["implementation"]
        self.assertEqual(["checksum", "debug-payload"], impl["groups"])
        self.assertEqual(0, impl["otherBytes"])
        self.assertIn("differs in checksum, debug-payload", out)

    def test_a_method_body_difference_fails(self) -> None:
        code, _, _ = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", body="method-body-XXXX"))
        self.assertEqual(1, code)
        problems = " ".join(self.report()["cells"]["core"]["problems"])
        self.assertIn("outside the identity groups", problems)
        self.assertIn("4 bytes", problems)

    def test_a_nondeterministic_baseline_is_caught_by_the_control(self) -> None:
        noisy = fake_compiler(self.root, "a", noise=True)
        code, _, _ = self.bench(noisy, fake_compiler(self.root, "b"))
        self.assertEqual(1, code)
        self.assertIn("baseline control", " ".join(self.report()["cells"]["core"]["problems"]))


class DisciplineTests(BenchTestCase):
    def test_work_under_tmp_is_refused(self) -> None:
        a = fake_compiler(self.root, "a")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cb.main(["--baseline", a, "--candidate", a, "--cell", "core", str(self.rsp), str(self.project),
                            "--work", "/tmp/compiler-bench-refused"])
        self.assertEqual(2, code)
        self.assertIn("refusing to write under", err.getvalue())
        self.assertFalse(Path("/tmp/compiler-bench-refused").exists())

    def test_large_outputs_are_removed_and_the_report_is_kept(self) -> None:
        a = fake_compiler(self.root, "a")
        self.assertEqual(0, self.bench(a, a)[0])
        self.assertEqual(["compiler-bench-report.json"], [p.name for p in self.work.iterdir()])

    def test_keep_retains_the_outputs(self) -> None:
        a = fake_compiler(self.root, "a")
        self.assertEqual(0, self.bench(a, a, "--keep")[0])
        self.assertTrue((self.work / "core" / "candidate-0" / "Core.dll").exists())

    def test_a_failed_compile_is_a_tool_error(self) -> None:
        code, _, err = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", exit_code=3))
        self.assertEqual(2, code)
        self.assertIn("failed (exit 3)", err)

    def test_hello_cell_keeps_options_and_swaps_the_source(self) -> None:
        text = cb.hello_rsp(cb.load_rsp(self.rsp), self.project / "hello.gs")
        self.assertTrue(text.startswith("/out:"))  # BOM was dropped
        self.assertIn("/optimize+", text)
        self.assertIn("hello.gs", text)
        self.assertNotIn("a.gs", text)
        a = fake_compiler(self.root, "a")
        code, out, _ = self.bench(a, a, "--hello", str(self.project / "hello.gs"))
        self.assertEqual(0, code)
        self.assertEqual(["hello", "core"], list(self.report()["cells"]))
        self.assertIn("== hello ==", out)

    def test_interleaving_alternates_the_first_compiler(self) -> None:
        a = fake_compiler(self.root, "a")
        calls: list[str] = []
        original = cb.run_once

        def spy(compiler, rsp_text, work, label, index, cwd):
            calls.append(f"{label}{index}")
            return original(compiler, rsp_text, work, label, index, cwd)

        cb.run_once = spy
        try:
            self.assertEqual(0, self.bench(a, a)[0])
        finally:
            cb.run_once = original
        self.assertEqual(["baseline0", "candidate0", "candidate1", "baseline1", "baseline2", "candidate2"], calls)


class PeGroupTests(unittest.TestCase):
    def test_regions_cover_checksum_and_debug_groups(self) -> None:
        regions, notes = cb.identity_regions(synthetic_pe())
        names = {name for name, _, _ in regions}
        self.assertTrue({"checksum", "debug-directory", "debug-payload"} <= names)
        self.assertTrue(any("MVID not located" in note for note in notes))  # synthetic PE has no metadata

    def test_the_mvid_group_comes_from_the_pe_layout_reader(self) -> None:
        class Layout:
            mvid_offset = BODY + 0x40

        original = cb.pe.inspect_layout
        cb.pe.inspect_layout = lambda data: Layout()
        try:
            data = synthetic_pe()
            regions, notes = cb.identity_regions(data)
            mutated = bytearray(data)
            mutated[BODY + 0x40] ^= 0xFF
            outcome = cb.compare_bytes(data, bytes(mutated), regions)
        finally:
            cb.pe.inspect_layout = original
        self.assertEqual([], notes[1:])
        self.assertEqual(["mvid"], outcome["groups"])
        self.assertEqual(0, outcome["otherBytes"])

    def test_a_size_change_is_never_an_identity_difference(self) -> None:
        outcome = cb.compare_bytes(b"abc", b"abcd", [])
        self.assertTrue(outcome["sizeDiffers"])


if __name__ == "__main__":
    unittest.main()
