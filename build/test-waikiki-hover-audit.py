#!/usr/bin/env python3
"""Unit tests for build/waikiki-hover-audit.py (#5026)."""

from __future__ import annotations

import csv
import importlib.util
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH_ROOT = ROOT / "out" / "test-waikiki-hover-audit"

SPEC = importlib.util.spec_from_file_location("waikiki_hover_audit", ROOT / "build" / "waikiki-hover-audit.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/waikiki-hover-audit.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class WaikikiHoverAuditScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        shutil.rmtree(SCRATCH_ROOT, ignore_errors=True)
        SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(SCRATCH_ROOT, ignore_errors=True)

    def write_valid_artifacts(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        summary = {
            "CorpusCommit": audit.WAIKIKI_COMMIT,
            "SdkVersion": audit.WAIKIKI_SDK_VERSION,
            "OperatingSystemName": "linux",
            "ProjectCount": audit.EXPECTED_PROJECTS,
            "AuthoredFileCount": audit.EXPECTED_AUTHORED_FILES,
            "GeneratedFileCount": audit.EXPECTED_GENERATED_FILES,
            "PhysicalTokenCount": audit.EXPECTED_PHYSICAL_TOKENS,
            "StartAndInteriorCheckCount": audit.EXPECTED_CHECKS,
            "ExcludedSyntheticTokenCount": audit.EXPECTED_SYNTHETIC_EXCLUDED,
            "SyntheticLeakCount": 0,
            "CompilerOracleTargetCount": audit.EXPECTED_ORACLE_TARGETS,
            "CompilerOracleMatchedCount": audit.EXPECTED_ORACLE_MATCHED,
            "HoverNonNullCount": 17229,
            "PlaceholderHoverCount": 0,
            "InteriorMismatchCount": 0,
            "ReviewedFailureCount": audit.EXPECTED_REVIEWED_FAILURES,
            "ReviewedSyntaxGapCount": audit.EXPECTED_REVIEWED_SYNTAX_GAPS,
            "UnreviewedFailureCount": 0,
            "StaleExpectationCount": 0,
            "ElapsedMilliseconds": 25000,
        }
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        (out_dir / "summary.md").write_text("## Waikiki Headless Hover Audit\n\nAll checks passed.\n", encoding="utf-8")

        inventory = []
        total_files = audit.EXPECTED_AUTHORED_FILES + audit.EXPECTED_GENERATED_FILES
        for idx in range(total_files):
            is_gen = idx >= audit.EXPECTED_AUTHORED_FILES
            tokens = audit.EXPECTED_PHYSICAL_TOKENS if idx == 0 else 0
            checks = audit.EXPECTED_CHECKS if idx == 0 else 0
            inventory.append({
                "RelativePath": f"src/File{idx}.g.gs" if is_gen else f"src/File{idx}.gs",
                "Sha256": "0" * 64,
                "IsGenerated": is_gen,
                "PhysicalTokens": tokens,
                "Checks": checks,
                "OracleTargets": audit.EXPECTED_ORACLE_TARGETS if idx == 0 else 0,
                "HoverCount": 17229 if idx == 0 else 0,
            })
        (out_dir / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")

        failures = []
        for idx in range(audit.EXPECTED_REVIEWED_FAILURES):
            failures.append({
                "TargetId": f"src/Waikiki.Core/JobState.gs:{idx + 1}:18:Delete",
                "Role": "CallExpression",
                "Kind": "SignatureMismatch",
                "Issue": "#5899",
                "IsUnreviewed": False,
                "Expected": "func (System.IO.File) Delete(path string)",
                "Actual": "func (JobStateStore) Delete(fingerprint string)",
            })
        for idx in range(audit.EXPECTED_REVIEWED_SYNTAX_GAPS):
            failures.append({
                "TargetId": f"src/Waikiki.Core/UploadJob.gs:{idx + 1}:17:CardId",
                "Role": "FieldAssignmentExpressionSyntax",
                "Kind": "ReviewedSyntaxGap",
                "Issue": "#5900",
                "IsUnreviewed": False,
                "Expected": "hover for FieldAssignmentExpressionSyntax",
                "Actual": "",
            })
        (out_dir / "failures.json").write_text(json.dumps(failures, indent=2), encoding="utf-8")
        with (out_dir / "failures.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["target_id", "role", "kind", "issue", "unreviewed", "expected", "actual"])
            for item in failures:
                writer.writerow([
                    item["TargetId"],
                    item["Role"],
                    item["Kind"],
                    item["Issue"],
                    "true" if item["IsUnreviewed"] else "false",
                    item["Expected"],
                    item["Actual"],
                ])

    def test_pinned_constants_match_issue_5026(self) -> None:
        self.assertEqual(audit.WAIKIKI_REPO, "https://github.com/DavidObando/Waikiki.git")
        self.assertEqual(audit.WAIKIKI_COMMIT, "ec66d0bfaa39583cd11c66095f2748342dc9e8f6")
        self.assertEqual(audit.WAIKIKI_SDK_VERSION, "0.5.26")
        self.assertEqual(audit.EXPECTED_PROJECTS, 8)
        self.assertEqual(audit.EXPECTED_AUTHORED_FILES, 68)
        self.assertEqual(audit.EXPECTED_GENERATED_FILES, 13)
        self.assertEqual(audit.EXPECTED_PHYSICAL_TOKENS, 45829)

    def test_verify_accepts_valid_scrubbed_artifacts_and_writes_step_summary(self) -> None:
        out_dir = SCRATCH_ROOT / "valid-artifacts"
        corpus_dir = SCRATCH_ROOT / "fake-corpus"
        summary_file = SCRATCH_ROOT / "step-summary.md"
        self.write_valid_artifacts(out_dir)
        verified = audit.verify_artifacts(out_dir, corpus_dir=corpus_dir, step_summary_path=summary_file)
        self.assertEqual(verified["PhysicalTokenCount"], 45829)
        self.assertTrue(summary_file.is_file())
        self.assertIn("Waikiki Headless Hover Audit", summary_file.read_text(encoding="utf-8"))

    def test_verify_rejects_unreviewed_failures_and_stale_expectations(self) -> None:
        out_dir = SCRATCH_ROOT / "broken-artifacts"
        self.write_valid_artifacts(out_dir)
        summary = json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))
        summary["UnreviewedFailureCount"] = 1
        (out_dir / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        with self.assertRaisesRegex(audit.AuditVerificationError, "UnreviewedFailureCount"):
            audit.verify_artifacts(out_dir)

        self.write_valid_artifacts(out_dir)
        summary = json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))
        summary["StaleExpectationCount"] = 1
        (out_dir / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        with self.assertRaisesRegex(audit.AuditVerificationError, "StaleExpectationCount"):
            audit.verify_artifacts(out_dir)

        self.write_valid_artifacts(out_dir)
        summary = json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))
        summary["PlaceholderHoverCount"] = 1
        (out_dir / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        with self.assertRaisesRegex(audit.AuditVerificationError, "PlaceholderHoverCount"):
            audit.verify_artifacts(out_dir)

    def test_verify_rejects_unscrubbed_paths_and_secret_markers(self) -> None:
        out_dir = SCRATCH_ROOT / "leaked-artifacts"
        corpus_dir = SCRATCH_ROOT / "secret-corpus-path"
        self.write_valid_artifacts(out_dir)
        (out_dir / "summary.md").write_text(f"Leaked path: {corpus_dir.resolve()}\n", encoding="utf-8")
        with self.assertRaisesRegex(audit.AuditVerificationError, "unscrubbed local path"):
            audit.verify_artifacts(out_dir, corpus_dir=corpus_dir)

        self.write_valid_artifacts(out_dir)
        win_root = r"C:\agent\_work\gsharp"
        (out_dir / "summary.md").write_text(
            json.dumps({"leakedRoot": win_root + r"\src\Waikiki.Core\JobState.gs"}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(audit.AuditVerificationError, "unscrubbed local path"):
            audit.verify_artifacts(out_dir, corpus_dir=corpus_dir, repo_dir=win_root)

        self.write_valid_artifacts(out_dir)
        (out_dir / "summary.md").write_text("Leaked token: ACCESS-SECRET\n", encoding="utf-8")
        with self.assertRaisesRegex(audit.AuditVerificationError, "forbidden secret/env marker"):
            audit.verify_artifacts(out_dir, corpus_dir=corpus_dir)

    def test_stage_verified_artifacts_publishes_only_after_validation_passes(self) -> None:
        raw_dir = SCRATCH_ROOT / "raw-artifacts"
        publish_dir = SCRATCH_ROOT / "verified-artifacts"
        corpus_dir = SCRATCH_ROOT / "stage-corpus"
        self.write_valid_artifacts(raw_dir)
        summary = audit.stage_verified_artifacts(raw_dir, publish_dir, corpus_dir=corpus_dir)
        self.assertEqual(summary["PhysicalTokenCount"], audit.EXPECTED_PHYSICAL_TOKENS)
        for name in audit.REQUIRED_ARTIFACTS:
            self.assertTrue((publish_dir / name).is_file())

        (raw_dir / "summary.md").write_text("Leaked token: ACCESS-SECRET\n", encoding="utf-8")
        with self.assertRaisesRegex(audit.AuditVerificationError, "forbidden secret/env marker"):
            audit.stage_verified_artifacts(raw_dir, publish_dir, corpus_dir=corpus_dir)
        self.assertFalse(publish_dir.exists())

    def test_checkout_verifies_commit_sdk_pin_and_msbuild_isolation_guards(self) -> None:
        sdk_key = "Gsharp." + "NET.Sdk"
        origin = SCRATCH_ROOT / "origin-repo"
        origin.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(origin)], check=True)
        subprocess.run(["git", "-C", str(origin), "config", "user.name", "Audit Test"], check=True)
        subprocess.run(["git", "-C", str(origin), "config", "user.email", "audit@example.invalid"], check=True)
        (origin / "global.json").write_text(
            json.dumps({"msbuild-sdks": {sdk_key: audit.WAIKIKI_SDK_VERSION}}),
            encoding="utf-8",
        )
        subprocess.run(["git", "-C", str(origin), "add", "global.json"], check=True)
        subprocess.run(["git", "-C", str(origin), "commit", "-qm", "init"], check=True)
        sha = subprocess.run(
            ["git", "-C", str(origin), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        dest = SCRATCH_ROOT / "checked-out"
        audit.checkout_corpus(dest, repo=str(origin), commit=sha)
        self.assertTrue((dest / "Directory.Build.props").is_file())
        self.assertTrue((dest / "Directory.Build.targets").is_file())

        bad_origin = SCRATCH_ROOT / "bad-origin"
        bad_origin.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(bad_origin)], check=True)
        subprocess.run(["git", "-C", str(bad_origin), "config", "user.name", "Audit Test"], check=True)
        subprocess.run(["git", "-C", str(bad_origin), "config", "user.email", "audit@example.invalid"], check=True)
        (bad_origin / "global.json").write_text(
            json.dumps({"msbuild-sdks": {sdk_key: "unexpected-sdk-pin"}}),
            encoding="utf-8",
        )
        subprocess.run(["git", "-C", str(bad_origin), "add", "global.json"], check=True)
        subprocess.run(["git", "-C", str(bad_origin), "commit", "-qm", "bad sdk"], check=True)
        bad_sha = subprocess.run(
            ["git", "-C", str(bad_origin), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        with self.assertRaisesRegex(audit.AuditVerificationError, "Gsharp.NET.Sdk"):
            audit.checkout_corpus(SCRATCH_ROOT / "bad-dest", repo=str(bad_origin), commit=bad_sha)

    def test_isolated_environment_strips_credentials_and_sets_headless_flags(self) -> None:
        old_token = os.environ.get("GITHUB_TOKEN")
        os.environ["GITHUB_TOKEN"] = "secret-token-value"
        try:
            env = audit.isolated_environment(SCRATCH_ROOT / "iso-env")
            self.assertNotIn("GITHUB_TOKEN", env)
            self.assertEqual(env["WAIKIKI_LIVE_SECRETS"], "0")
            self.assertEqual(env["MSBUILDDISABLENODEREUSE"], "1")
        finally:
            if old_token is None:
                os.environ.pop("GITHUB_TOKEN", None)
            else:
                os.environ["GITHUB_TOKEN"] = old_token


if __name__ == "__main__":
    unittest.main()
