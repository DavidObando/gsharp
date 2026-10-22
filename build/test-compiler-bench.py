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
DEBUG_PAYLOAD = 0x300      # entry 0, CodeView (type 2): RSDS, GUID, age, path
EMBEDDED_PAYLOAD = 0x340   # entry 1, EmbeddedPortablePdb (type 17)
PDB_CHECKSUM = 0x360       # entry 2, PdbChecksum (type 19): "SHA256", NUL, 32-byte hash
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
    struct.pack_into("<I", data, optional + 112 + 6 * 8 + 4, 28 * 3)
    section = optional + 0xF0
    struct.pack_into("<IIII", data, section + 8, 0x600, 0x1000, 0x600, 0x0)  # vsize, rva, rawsize, rawptr (offsets +8..+20)
    for index, (kind, length, offset) in enumerate(((2, 26, DEBUG_PAYLOAD), (17, 16, EMBEDDED_PAYLOAD),
                                                     (19, 39, PDB_CHECKSUM))):
        entry = DEBUG_DIR + index * 28
        struct.pack_into("<IIII", data, entry + 12, kind, length, 0, offset)  # type, size, rva, pointer
    data[DEBUG_PAYLOAD:DEBUG_PAYLOAD + 4] = b"RSDS"
    data[DEBUG_PAYLOAD + 4:DEBUG_PAYLOAD + 20] = bytes(range(16))
    data[DEBUG_PAYLOAD + 24:DEBUG_PAYLOAD + 26] = b"p\0"
    data[EMBEDDED_PAYLOAD:EMBEDDED_PAYLOAD + 16] = b"compressed-pdb!!"
    data[PDB_CHECKSUM:PDB_CHECKSUM + 7] = b"SHA256\0"
    data[PDB_CHECKSUM + 7:PDB_CHECKSUM + 39] = bytes(range(32))
    data[BODY:BODY + 16] = b"method-body-0123"
    return bytes(data)


def fake_compiler(directory: Path, name: str, *, pdb: str = "pdb", ref: str = "ref", doc: str = "doc",
                  log: str = "ok", checksum: int = 0, body: str = "", noise: bool = False,
                  seconds: float = 0.0, exit_code: int = 0, omit: tuple = (),
                  differ_from_call: int = 0, noise_checksum: bool = False,
                  embedded: bool = False, pdb_hash: bool = False, extra: str = "", eol: str = "\n",
                  log_tail: bytes = b"") -> str:
    """An executable standing in for gsc: writes every output the @rsp names."""
    dll = bytearray(synthetic_pe())
    if checksum:
        dll[CHECKSUM_OFFSET:CHECKSUM_OFFSET + 4] = struct.pack("<I", checksum)
        dll[DEBUG_PAYLOAD + 4:DEBUG_PAYLOAD + 20] = bytes(16)  # a different CodeView GUID
    if embedded:
        dll[EMBEDDED_PAYLOAD + 3] ^= 1  # same size, different embedded symbols
    if pdb_hash:
        dll[PDB_CHECKSUM + 20] ^= 1
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
        f"omit = {omit!r}\n"
        "counter = sys.argv[0] + '.calls'\n"
        "calls = int(open(counter).read()) + 1 if os.path.exists(counter) else 1\n"
        "open(counter, 'w').write(str(calls))\n"
        f"pdb_text = {pdb!r} + ('-late' if {differ_from_call} and calls >= {differ_from_call} else '')\n"
        f"if {noise_checksum!r}:\n"
        f"    dll[{CHECKSUM_OFFSET}:{CHECKSUM_OFFSET + 4}] = os.urandom(4)\n"
        # Without /pdb the compiler writes <out>.pdb beside the DLL.
        "pdb_path = paths.get('/pdb:') or os.path.splitext(paths['/out:'])[0] + '.pdb'\n"
        "if 'out' not in omit: open(paths['/out:'], 'wb').write(dll)\n"
        "if 'pdb' not in omit: open(pdb_path, 'w').write(pdb_text)\n"
        f"if 'refout' not in omit: open(paths['/refout:'], 'w').write({ref!r})\n"
        f"if 'doc' not in omit: open(paths['/doc:'], 'w').write({doc!r})\n"
        f"sys.stdout.buffer.write(({log!r} + ' ' + os.path.dirname(paths['/out:']) + {eol!r}).encode() + {log_tail!r})\n"
        "sys.stdout.flush()\n"
        f"if {extra!r}: open(os.path.splitext(paths['/out:'])[0] + '.runtimeconfig.json', 'w').write({extra!r})\n"
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
        self.assertTrue(cell["parity"]["candidate"][0]["implementation"]["identical"])
        # Two 'parse' spans per run aggregate by name into one row: count 2, 12 ms.
        self.assertEqual({"count": 2, "wallMs": 12.0, "allocMiB": 2.0}, cell["candidate"]["phases"]["parse"])
        self.assertEqual(3, cell["candidate"]["counters"]["symbols"])
        self.assertEqual(3, len(cell["baselineRuns"]))
        self.assertIn("control (2 runs): identical", out)

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
        impl = self.report()["cells"]["core"]["parity"]["candidate"][0]["implementation"]
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


class VerdictHoleTests(BenchTestCase):
    def test_a_candidate_that_omits_an_artifact_fails(self) -> None:
        for kind in ("pdb", "refout", "doc", "out"):
            with self.subTest(kind=kind):
                code, _, _ = self.bench(fake_compiler(self.root, f"a{kind}"),
                                        fake_compiler(self.root, f"b{kind}", omit=(kind,)),
                                        "--work", str(self.root / f"work-{kind}"))
                self.assertEqual(1, code)
                report = json.loads((self.root / f"work-{kind}" / "compiler-bench-report.json").read_text("utf-8"))
                self.assertIn(f"{kind} output is absent", " ".join(report["cells"]["core"]["problems"]))

    def test_a_difference_in_a_later_candidate_run_fails(self) -> None:
        # The candidate's third run writes a different PDB; runs 0 and 1 match.
        code, _, _ = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", differ_from_call=3))
        self.assertEqual(1, code)
        self.assertEqual(["candidate run 2: pdb differs"], self.report()["cells"]["core"]["problems"])

    def test_the_baseline_control_rejects_identity_group_noise(self) -> None:
        code, _, _ = self.bench(fake_compiler(self.root, "a", noise_checksum=True), fake_compiler(self.root, "b"))
        self.assertEqual(1, code)
        self.assertIn("baseline control", " ".join(self.report()["cells"]["core"]["problems"]))

    def test_the_default_sidecar_pdb_is_compared_when_pdb_is_not_in_the_response_file(self) -> None:
        self.rsp.write_bytes(b"\xef\xbb\xbf/out:/tree/obj/Core.dll\n/refout:/tree/obj/ref/Core.dll\n"
                             b"/doc:/tree/bin/Core.xml\n" + str(self.project / "a.gs").encode() + b"\n")
        self.assertEqual({"out", "pdb", "refout", "doc"}, set(cb.output_paths(self.rsp.read_text("utf-8-sig"))))
        self.assertEqual(0, self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b"))[0])
        code, _, _ = self.bench(fake_compiler(self.root, "c"), fake_compiler(self.root, "d", pdb="other"),
                                "--work", str(self.root / "work2"))
        self.assertEqual(1, code)


class StrictInputTests(BenchTestCase):
    def failures(self, **candidate: object) -> list[str]:
        code, _, _ = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", **candidate))
        problems = self.report()["cells"]["core"]["problems"]
        self.assertEqual(1 if problems else 0, code)
        return problems

    def test_an_embedded_pdb_payload_change_fails(self) -> None:
        problems = self.failures(embedded=True)
        self.assertTrue(any("outside the identity groups (1 bytes)" in p for p in problems), problems)

    def test_a_pdb_checksum_hash_change_is_only_an_identity_difference(self) -> None:
        self.assertEqual([], self.failures(pdb_hash=True))
        impl = self.report()["cells"]["core"]["parity"]["candidate"][0]["implementation"]
        self.assertEqual(["debug-payload"], impl["groups"])

    def test_crlf_versus_lf_in_diagnostics_fails(self) -> None:
        problems = self.failures(eol="\r\n")
        self.assertIn("candidate run 0: diagnostics differ", problems)

    def test_distinct_invalid_utf8_in_diagnostics_fails(self) -> None:
        # Both bytes decode to U+FFFD with errors="replace"; raw comparison tells them apart.
        code, _, _ = self.bench(fake_compiler(self.root, "a", log_tail=b"\xff\n"),
                                fake_compiler(self.root, "b", log_tail=b"\xfe\n"))
        self.assertEqual(1, code)
        self.assertIn("diagnostics differ", " ".join(self.report()["cells"]["core"]["problems"]))

    def test_an_unnamed_sidecar_file_is_compared(self) -> None:
        a = fake_compiler(self.root, "a", extra='{"x":1}')
        code, _, _ = self.bench(a, fake_compiler(self.root, "b", extra='{"x":2}'))
        self.assertEqual(1, code)
        self.assertIn("file:Core.runtimeconfig.json differs", " ".join(self.report()["cells"]["core"]["problems"]))
        # Present on one side only is also a difference.
        code, _, _ = self.bench(fake_compiler(self.root, "c"), fake_compiler(self.root, "d", extra="{}"),
                                "--work", str(self.root / "work2"))
        self.assertEqual(1, code)

    def test_a_stage_path_in_diagnostics_is_normalized(self) -> None:
        # The log prints the staging directory; identical compilers must still match.
        self.assertEqual([], self.failures())


class SafetyTests(BenchTestCase):
    def run_with(self, *extra: str) -> tuple[int, str]:
        a = fake_compiler(self.root, "a")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cb.main(["--baseline", a, "--candidate", a, "--runs", "2", "--warmup", "0", *extra])
        return code, err.getvalue()

    def test_path_like_cell_names_are_rejected_and_nothing_is_deleted(self) -> None:
        victim = self.root / "victim"
        victim.mkdir()
        (victim / "keep.txt").write_text("x", encoding="utf-8")
        for index, name in enumerate(("../victim", str(victim), "a/b", "..")):
            with self.subTest(name=name):
                code, err = self.run_with("--cell", name, str(self.rsp), str(self.project),
                                          "--work", str(self.root / f"work-{index}"))
                self.assertEqual(2, code, err)
                self.assertIn("cell name", err)
                self.assertTrue((victim / "keep.txt").exists())

    def test_a_non_empty_work_root_is_refused_untouched(self) -> None:
        self.work.mkdir()
        (self.work / "precious").mkdir()
        (self.work / "precious" / "data.txt").write_text("x", encoding="utf-8")
        code, err = self.run_with("--cell", "core", str(self.rsp), str(self.project), "--work", str(self.work))
        self.assertEqual(2, code)
        self.assertIn("not an empty directory", err)
        self.assertEqual(["precious"], [p.name for p in self.work.iterdir()])
        self.assertTrue((self.work / "precious" / "data.txt").exists())

    def test_duplicate_cell_names_are_rejected(self) -> None:
        code, err = self.run_with("--cell", "core", str(self.rsp), str(self.project),
                                  "--cell", "core", str(self.rsp), str(self.project), "--work", str(self.work))
        self.assertEqual(2, code)
        self.assertIn("unique", err)

    def test_a_failed_run_keeps_its_log_and_drops_large_outputs(self) -> None:
        code, _, err = self.bench(fake_compiler(self.root, "a"), fake_compiler(self.root, "b", exit_code=3))
        self.assertEqual(2, code)
        log = self.work / "core" / "candidate-0" / "compile.log"
        self.assertTrue(log.exists())
        self.assertIn(str(log), err)
        self.assertFalse((self.work / "core" / "candidate-0" / "outputs" / "Core.dll").exists())
        self.assertFalse((self.work / "core" / "stage").exists())
        self.assertTrue((self.work / "compiler-bench-report.json").exists())

    def test_a_hello_path_with_spaces_is_one_token(self) -> None:
        spaced = self.root / "dir with space"
        spaced.mkdir()
        source = spaced / 'he"llo.gs'
        source.write_text("x", encoding="utf-8")
        line = cb.hello_rsp("/out:/a.dll\n", source).splitlines()[-1]
        # The response-file tokenizer reads a doubled quote inside quotes as one quote.
        self.assertEqual('"' + str(source).replace('"', '""') + '"', line)


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
        self.assertTrue((self.work / "core" / "candidate-0" / "outputs" / "Core.dll").exists())

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
        # Only the hash-derived bytes are exempt: the CodeView GUID, the PdbChecksum
        # hash, and each entry's timestamp. The embedded PDB payload is not.
        covered = {offset for _, start, end in regions for offset in range(start, end)}
        self.assertTrue(all(o in covered for o in range(DEBUG_PAYLOAD + 4, DEBUG_PAYLOAD + 20)))
        self.assertTrue(all(o in covered for o in range(PDB_CHECKSUM + 7, PDB_CHECKSUM + 39)))
        self.assertFalse(any(o in covered for o in range(EMBEDDED_PAYLOAD, EMBEDDED_PAYLOAD + 16)))
        self.assertFalse(any(o in covered for o in range(DEBUG_PAYLOAD + 20, DEBUG_PAYLOAD + 26)))  # age and path
        self.assertFalse(any(o in covered for o in range(DEBUG_DIR + 12, DEBUG_DIR + 28)))  # type, size, pointers
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
