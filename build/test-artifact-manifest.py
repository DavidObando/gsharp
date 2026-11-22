#!/usr/bin/env python3
"""Tests for build/artifact-manifest.sh and CI handoff verification (#6181)."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "build" / "artifact-manifest.sh"
R2R_E2E = ROOT / "e2etests" / "r2r-compiler-e2e.sh"
RIDS = ("linux-x64", "linux-arm64", "win-x64", "win-arm64", "osx-x64", "osx-arm64")
VERSION = "0.5.773-g1947662462"


def run_manifest(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SCRIPT), *args], cwd=ROOT, capture_output=True, text=True, check=False)


def populate_r2r_dir(folder: Path, *, skip_rid: str | None = None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"Gsharp.NET.Sdk.{VERSION}.nupkg").write_bytes(b"sdk-package-payload")
    (folder / f"Gsharp.NET.Sdk.{VERSION}.snupkg").write_bytes(b"sdk-symbol-payload")
    (folder / f"Gsharp.Templates.{VERSION}.nupkg").write_bytes(b"templates-payload")
    for rid in RIDS:
        if rid != skip_rid:
            (folder / f"Gsharp.NET.Sdk.Compiler.{rid}.{VERSION}.nupkg").write_bytes(f"compiler-{rid}".encode())


class ArtifactManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name) / "nupkgs"

    def test_complete_six_rid_manifest_passes_and_is_deterministic(self) -> None:
        populate_r2r_dir(self.dir)
        first = run_manifest("write", str(self.dir), "--require-r2r-packages")
        self.assertEqual(first.returncode, 0, first.stderr)
        manifest = self.dir / "artifact-manifest.sha256"
        first_bytes = manifest.read_bytes()
        self.assertIn(b"# end count=9\n", first_bytes)

        second = run_manifest("write", str(self.dir), "--require-r2r-packages")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(manifest.read_bytes(), first_bytes)

        verified = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn("PASS: verified 9 artifact file(s)", verified.stdout)

    def test_missing_manifest_or_empty_directory_fails(self) -> None:
        self.dir.mkdir()
        empty = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("artifact manifest missing or empty", empty.stderr)

        populate_r2r_dir(self.dir)
        no_manifest = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(no_manifest.returncode, 0)
        self.assertIn("artifact manifest missing or empty", no_manifest.stderr)

    def test_truncated_or_mismatched_manifest_fails(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        manifest = self.dir / "artifact-manifest.sha256"
        original = manifest.read_text(encoding="utf-8")

        manifest.write_text("\n".join(original.splitlines()[:-1]) + "\n", encoding="utf-8")
        truncated = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(truncated.returncode, 0)
        self.assertIn("truncated artifact manifest", truncated.stderr)

        manifest.write_text(original.replace("# end count=9", "# end count=99"), encoding="utf-8")
        bad_count = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(bad_count.returncode, 0)
        self.assertIn("manifest count mismatch", bad_count.stderr)

        manifest.write_text(original + "extra trailing line\n", encoding="utf-8")
        trailing = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(trailing.returncode, 0)
        self.assertIn("unexpected trailing content", trailing.stderr)

    def test_missing_file_fails_with_missing_filename(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        missing_pkg = f"Gsharp.NET.Sdk.Compiler.osx-x64.{VERSION}.nupkg"
        (self.dir / missing_pkg).unlink()
        result = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"missing file from artifact: {missing_pkg}", result.stderr)

    def test_truncated_file_fails_with_size_mismatch(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        target = self.dir / f"Gsharp.NET.Sdk.Compiler.win-arm64.{VERSION}.nupkg"
        target.write_bytes(target.read_bytes()[:-1])
        result = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"size mismatch for {target.name}", result.stderr)

    def test_same_size_corrupted_file_fails_with_checksum_mismatch(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        target = self.dir / f"Gsharp.NET.Sdk.{VERSION}.nupkg"
        raw = bytearray(target.read_bytes())
        raw[0] ^= 0xFF
        target.write_bytes(bytes(raw))
        result = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"checksum mismatch for {target.name}", result.stderr)

    def test_unexpected_extra_file_fails(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        (self.dir / "stray.nupkg").write_bytes(b"extra")
        result = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected file in artifact directory", result.stderr)
        self.assertIn("stray.nupkg", result.stderr)

    def test_missing_rid_fails_at_write_and_verify(self) -> None:
        populate_r2r_dir(self.dir, skip_rid="osx-x64")
        write_fail = run_manifest("write", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(write_fail.returncode, 0)
        self.assertIn(f"Gsharp.NET.Sdk.Compiler.osx-x64.{VERSION}.nupkg", write_fail.stderr)

        # Even if a manifest was written without --require-r2r-packages, verify --require-r2r-packages catches it.
        self.assertEqual(run_manifest("write", str(self.dir)).returncode, 0)
        verify_fail = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertNotEqual(verify_fail.returncode, 0)
        self.assertIn(f"Gsharp.NET.Sdk.Compiler.osx-x64.{VERSION}.nupkg", verify_fail.stderr)

    def test_checked_in_gitignore_in_download_dir_does_not_fail_verification(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        (self.dir / ".gitignore").write_text("*.nupkg\n", encoding="utf-8")
        verified = run_manifest("verify", str(self.dir), "--require-r2r-packages")
        self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_generic_archive_manifest_catches_missing_tar(self) -> None:
        self.dir.mkdir()
        (self.dir / "out.tar").write_bytes(b"out-archive")
        (self.dir / "csharp-out.tar").write_bytes(b"csharp-archive")
        self.assertEqual(run_manifest("write", str(self.dir)).returncode, 0)
        self.assertEqual(run_manifest("verify", str(self.dir)).returncode, 0)
        (self.dir / "csharp-out.tar").unlink()
        failed = run_manifest("verify", str(self.dir))
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("missing file from artifact: csharp-out.tar", failed.stderr)

    def test_r2r_e2e_verifies_manifest_before_running_smoke(self) -> None:
        populate_r2r_dir(self.dir)
        self.assertEqual(run_manifest("write", str(self.dir), "--require-r2r-packages").returncode, 0)
        target = self.dir / f"Gsharp.NET.Sdk.Compiler.osx-x64.{VERSION}.nupkg"
        raw = bytearray(target.read_bytes())
        raw[0] ^= 0xFF
        target.write_bytes(bytes(raw))
        result = subprocess.run(
            ["bash", str(R2R_E2E)],
            cwd=ROOT,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "GSHARP_R2R_NUPKG_DIR": str(self.dir)},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"checksum mismatch for {target.name}", result.stderr)
        self.assertNotIn("expected six Gsharp.NET.Sdk.Compiler", result.stderr)


if __name__ == "__main__":
    unittest.main()
