#!/usr/bin/env python3
"""Headless language-server hover regression audit over pinned Waikiki (#5026).

Small deterministic regression checks (cold-open #5024, body-only import reuse
#5025, indexed-member and receiver provenance #5035/#5036, synthetic-token
hit-testing #5277, and stdio JSON-RPC lifecycle) run in-process on relevant PRs
via ``test/LanguageServer.Tests/WaikikiHoverAuditTests.gs``.

This script orchestrates the full SHA-pinned external Waikiki corpus sweep for
scheduled/manual CI runs and local verification:
  1. ``checkout`` clones ``DavidObando/Waikiki`` at the exact pinned commit with
     LF line endings, verifies ``global.json``, and writes MSBuild directory
     isolation guards so parent repository props/targets cannot leak in.
  2. ``run`` builds ``Waikiki.slnx`` in Debug configuration under an isolated,
     credential-free environment, invokes the shared G# headless audit runner in
     ``LanguageServer.Tests``, verifies the emitted artifacts, and appends the
     Markdown report to ``GITHUB_STEP_SUMMARY`` when present.
  3. ``verify`` validates ``summary.json``, ``summary.md``, ``failures.json``,
     ``failures.csv``, and ``inventory.json`` for completeness, zero unreviewed
     failures, zero stale expectations, and absence of machine-local paths or
     secret markers.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
WAIKIKI_REPO = "https://github.com/DavidObando/Waikiki.git"
WAIKIKI_COMMIT = "ec66d0bfaa39583cd11c66095f2748342dc9e8f6"
WAIKIKI_SDK_VERSION = "0.5.26"
EXPECTED_PROJECTS = 8
EXPECTED_AUTHORED_FILES = 68
EXPECTED_GENERATED_FILES = 13
EXPECTED_PHYSICAL_TOKENS = 45829
EXPECTED_CHECKS = 68039
EXPECTED_SYNTHETIC_EXCLUDED = 602
EXPECTED_ORACLE_TARGETS = 11056
EXPECTED_ORACLE_MATCHED = 11036
EXPECTED_REVIEWED_FAILURES = 21
EXPECTED_REVIEWED_SYNTAX_GAPS = 185

REQUIRED_ARTIFACTS = (
    "summary.json",
    "summary.md",
    "failures.json",
    "failures.csv",
    "inventory.json",
)
FORBIDDEN_MARKERS = (
    "ACCESS-SECRET",
    "REFRESH-SECRET",
    "GITHUB_TOKEN",
    "NUGET_API_KEY",
    "WAIKIKI_LIVE_SECRETS=1",
)


class AuditVerificationError(ValueError):
    """Raised when the Waikiki checkout or hover audit artifacts fail validation."""


def checkout_corpus(dest: Path, repo: str = WAIKIKI_REPO, commit: str = WAIKIKI_COMMIT) -> Path:
    """Check out the exact pinned Waikiki revision with MSBuild isolation guards."""
    dest = dest.resolve()
    if dest in {Path("/"), ROOT, ROOT.parent}:
        raise AuditVerificationError(f"refusing unsafe corpus checkout destination: {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "--quiet", str(dest)], check=True)
    subprocess.run(["git", "-C", str(dest), "config", "core.autocrlf", "false"], check=True)
    subprocess.run(["git", "-C", str(dest), "remote", "add", "origin", repo], check=True)
    subprocess.run(["git", "-C", str(dest), "fetch", "--quiet", "origin", commit], check=True)
    subprocess.run(["git", "-C", str(dest), "checkout", "--quiet", "--detach", "FETCH_HEAD"], check=True)
    actual = subprocess.run(
        ["git", "-C", str(dest), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != commit:
        raise AuditVerificationError(f"expected Waikiki commit {commit}, got {actual}")

    global_json_path = dest / "global.json"
    if not global_json_path.is_file():
        raise AuditVerificationError("Waikiki checkout is missing global.json")
    global_json = json.loads(global_json_path.read_text(encoding="utf-8"))
    sdk_version = global_json.get("msbuild-sdks", {}).get("Gsharp.NET.Sdk")
    if sdk_version != WAIKIKI_SDK_VERSION:
        raise AuditVerificationError(
            f"expected Waikiki Gsharp.NET.Sdk {WAIKIKI_SDK_VERSION!r}, got {sdk_version!r}"
        )

    for guard_name in ("Directory.Build.props", "Directory.Build.targets"):
        guard_path = dest / guard_name
        if not guard_path.exists():
            guard_path.write_text("<Project />\n", encoding="utf-8")
    return dest


def isolated_environment(scratch_dir: Path) -> dict[str, str]:
    """Build a credential-free, headless environment for building and auditing Waikiki."""
    home_dir = scratch_dir / "isolated-home"
    config_dir = scratch_dir / "isolated-config"
    data_dir = scratch_dir / "isolated-data"
    state_dir = scratch_dir / "isolated-state"
    for directory in (home_dir, config_dir, data_dir, state_dir):
        directory.mkdir(parents=True, exist_ok=True)

    nuget_packages = os.environ.get("NUGET_PACKAGES")
    if not nuget_packages:
        default_nuget = Path.home() / ".nuget" / "packages"
        if default_nuget.is_dir():
            nuget_packages = str(default_nuget)

    env = dict(os.environ)
    for key in list(env):
        if key.startswith(("WAIKIKI_", "YOTO_")) or key in {"GITHUB_TOKEN", "NUGET_API_KEY", "VSCE_PAT"}:
            env.pop(key, None)
    env.update({
        "HOME": str(home_dir),
        "DOTNET_CLI_HOME": str(home_dir),
        "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "MSBUILDDISABLENODEREUSE": "1",
        "NBGV_SetCloudBuildVersionVars": "false",
        "XDG_CONFIG_HOME": str(config_dir),
        "XDG_DATA_HOME": str(data_dir),
        "XDG_STATE_HOME": str(state_dir),
        "WAIKIKI_LIVE_SECRETS": "0",
        "NO_COLOR": "1",
    })
    if nuget_packages:
        env["NUGET_PACKAGES"] = nuget_packages
    return env


def path_spellings(path_value: Path | str) -> list[str]:
    """Return raw, forward-slash, backslash, and JSON-escaped backslash spellings for a path."""
    raw_text = str(path_value)
    if isinstance(path_value, Path) and not re.match(r"^[A-Za-z]:[\\/]", raw_text):
        raw_text = str(path_value.resolve())
    raw_text = raw_text.rstrip("/\\")
    if not raw_text:
        return []
    slash_text = raw_text.replace("\\", "/")
    backslash_text = raw_text.replace("/", "\\")
    candidates = [
        backslash_text.replace("\\", "\\\\"),
        raw_text.replace("\\", "\\\\"),
        raw_text,
        slash_text,
        backslash_text,
    ]
    seen: set[str] = set()
    ordered: list[str] = []
    for item in candidates:
        if item and item.lower() not in seen:
            seen.add(item.lower())
            ordered.append(item)
    return ordered


def verify_artifacts(
    out_dir: Path,
    corpus_dir: Path | str | None = None,
    repo_dir: Path | str = ROOT,
    step_summary_path: Path | None = None,
) -> dict[str, Any]:
    """Validate audit artifacts, counts, issue-linked expectations, and path/secret scrubbing."""
    out_dir = out_dir.resolve()
    for name in REQUIRED_ARTIFACTS:
        artifact = out_dir / name
        if not artifact.is_file():
            raise AuditVerificationError(f"missing required audit artifact: {name}")

    forbidden_paths: list[Path | str] = [repo_dir]
    if corpus_dir is not None:
        forbidden_paths.append(corpus_dir)
    for name in REQUIRED_ARTIFACTS:
        text = (out_dir / name).read_text(encoding="utf-8")
        text_lower = text.lower()
        for marker in FORBIDDEN_MARKERS:
            if marker in text:
                raise AuditVerificationError(f"forbidden secret/env marker {marker!r} found in {name}")
        for path_item in forbidden_paths:
            for spelling in path_spellings(path_item):
                if spelling.lower() in text_lower:
                    raise AuditVerificationError(f"unscrubbed local path {spelling!r} found in {name}")

    summary = json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))
    inventory = json.loads((out_dir / "inventory.json").read_text(encoding="utf-8"))
    failures = json.loads((out_dir / "failures.json").read_text(encoding="utf-8"))
    with (out_dir / "failures.csv").open("r", encoding="utf-8", newline="") as handle:
        csv_rows = list(csv.DictReader(handle))

    expected_fields = {
        "CorpusCommit": WAIKIKI_COMMIT,
        "SdkVersion": WAIKIKI_SDK_VERSION,
        "ProjectCount": EXPECTED_PROJECTS,
        "AuthoredFileCount": EXPECTED_AUTHORED_FILES,
        "GeneratedFileCount": EXPECTED_GENERATED_FILES,
        "PhysicalTokenCount": EXPECTED_PHYSICAL_TOKENS,
        "StartAndInteriorCheckCount": EXPECTED_CHECKS,
        "ExcludedSyntheticTokenCount": EXPECTED_SYNTHETIC_EXCLUDED,
        "SyntheticLeakCount": 0,
        "CompilerOracleTargetCount": EXPECTED_ORACLE_TARGETS,
        "CompilerOracleMatchedCount": EXPECTED_ORACLE_MATCHED,
        "PlaceholderHoverCount": 0,
        "InteriorMismatchCount": 0,
        "ReviewedFailureCount": EXPECTED_REVIEWED_FAILURES,
        "ReviewedSyntaxGapCount": EXPECTED_REVIEWED_SYNTAX_GAPS,
        "UnreviewedFailureCount": 0,
        "StaleExpectationCount": 0,
    }
    for key, expected in expected_fields.items():
        actual = summary.get(key)
        if actual != expected:
            raise AuditVerificationError(f"summary.{key}: expected {expected!r}, got {actual!r}")

    if len(inventory) != EXPECTED_AUTHORED_FILES + EXPECTED_GENERATED_FILES:
        raise AuditVerificationError(
            f"inventory file count mismatch: expected {EXPECTED_AUTHORED_FILES + EXPECTED_GENERATED_FILES}, got {len(inventory)}"
        )
    if sum(item.get("PhysicalTokens", 0) for item in inventory) != EXPECTED_PHYSICAL_TOKENS:
        raise AuditVerificationError("inventory token sum does not match PhysicalTokenCount")
    if sum(item.get("Checks", 0) for item in inventory) != EXPECTED_CHECKS:
        raise AuditVerificationError("inventory check sum does not match StartAndInteriorCheckCount")

    if len(failures) != len(csv_rows):
        raise AuditVerificationError(
            f"failures.json ({len(failures)}) and failures.csv ({len(csv_rows)}) row counts disagree"
        )
    if len(failures) != EXPECTED_REVIEWED_FAILURES + EXPECTED_REVIEWED_SYNTAX_GAPS:
        raise AuditVerificationError(
            f"expected {EXPECTED_REVIEWED_FAILURES + EXPECTED_REVIEWED_SYNTAX_GAPS} reviewed failure records, got {len(failures)}"
        )
    for item in failures:
        if item.get("IsUnreviewed"):
            raise AuditVerificationError(f"unreviewed hover failure: {item}")
        issue = item.get("Issue", "")
        if not isinstance(issue, str) or not issue.startswith("#"):
            raise AuditVerificationError(f"failure record is missing an issue link: {item}")
        target_id = item.get("TargetId", "")
        if "\\" in target_id or not target_id:
            raise AuditVerificationError(f"invalid or unnormalized TargetId: {target_id!r}")

    if step_summary_path is not None:
        summary_md = (out_dir / "summary.md").read_text(encoding="utf-8")
        with step_summary_path.open("a", encoding="utf-8") as handle:
            handle.write(summary_md)
            if not summary_md.endswith("\n"):
                handle.write("\n")

    return summary


def stage_verified_artifacts(
    raw_dir: Path,
    publish_dir: Path,
    corpus_dir: Path | str | None = None,
    repo_dir: Path | str = ROOT,
    step_summary_path: Path | None = None,
) -> dict[str, Any]:
    """Validate raw artifacts and stage only verified artifacts into a separate upload directory."""
    raw_dir = raw_dir.resolve()
    publish_dir = publish_dir.resolve()
    if raw_dir == publish_dir:
        raise AuditVerificationError("raw_dir and publish_dir must be distinct directories")
    shutil.rmtree(publish_dir, ignore_errors=True)
    try:
        verify_artifacts(raw_dir, corpus_dir=corpus_dir, repo_dir=repo_dir)
        publish_dir.mkdir(parents=True, exist_ok=True)
        for name in REQUIRED_ARTIFACTS:
            shutil.copy2(raw_dir / name, publish_dir / name)
        return verify_artifacts(
            publish_dir,
            corpus_dir=corpus_dir,
            repo_dir=repo_dir,
            step_summary_path=step_summary_path,
        )
    except Exception:
        shutil.rmtree(publish_dir, ignore_errors=True)
        raise


def run_audit(corpus_dir: Path, out_dir: Path, restore_source: str | None = None, timeout_seconds: int = 900) -> dict[str, Any]:
    """Build the pinned Waikiki corpus, execute the G# headless hover audit, and verify artifacts."""
    corpus_dir = corpus_dir.resolve()
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    env = isolated_environment(out_dir / "env-scratch")
    env["GSHARP_WAIKIKI_CORPUS_ROOT"] = str(corpus_dir)
    env["GSHARP_WAIKIKI_AUDIT_OUT"] = str(out_dir)

    restore_cmd = ["dotnet", "restore", str(corpus_dir / "Waikiki.slnx")]
    if restore_source:
        restore_cmd.extend(["--source", restore_source])
    subprocess.run(restore_cmd, env=env, check=True, timeout=timeout_seconds)

    build_cmd = [
        "dotnet",
        "build",
        str(corpus_dir / "Waikiki.slnx"),
        "--configuration",
        "Debug",
        "--no-restore",
        "-graph",
    ]
    subprocess.run(build_cmd, env=env, check=True, timeout=timeout_seconds)

    test_cmd = [
        "dotnet",
        "test",
        str(ROOT / "test" / "LanguageServer.Tests" / "LanguageServer.Tests.gsproj"),
        "--configuration",
        "Release",
        "--no-build",
        "--no-restore",
        "--filter",
        "FullyQualifiedName~WaikikiHoverAuditTests.PinnedWaikikiCorpus_FullHeadlessAudit",
    ]
    subprocess.run(test_cmd, cwd=ROOT, env=env, check=True, timeout=timeout_seconds)

    scratch_dir = out_dir / "env-scratch"
    if scratch_dir.exists():
        import shutil
        shutil.rmtree(scratch_dir, ignore_errors=True)

    step_summary = Path(os.environ["GITHUB_STEP_SUMMARY"]) if os.environ.get("GITHUB_STEP_SUMMARY") else None
    return verify_artifacts(out_dir, corpus_dir=corpus_dir, repo_dir=ROOT, step_summary_path=step_summary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    checkout_parser = subparsers.add_parser("checkout", help="Check out the pinned Waikiki corpus")
    checkout_parser.add_argument("--dest", type=Path, required=True)
    checkout_parser.add_argument("--repo", default=WAIKIKI_REPO)
    checkout_parser.add_argument("--commit", default=WAIKIKI_COMMIT)

    run_parser = subparsers.add_parser("run", help="Build Waikiki, run the headless hover audit, and verify artifacts")
    run_parser.add_argument("--corpus", type=Path, required=True)
    run_parser.add_argument("--out", type=Path, required=True)
    run_parser.add_argument("--restore-source", default=None)
    run_parser.add_argument("--timeout-seconds", type=int, default=900)

    verify_parser = subparsers.add_parser("verify", help="Verify emitted Waikiki hover audit artifacts")
    verify_parser.add_argument("--out", type=Path, required=True)
    verify_parser.add_argument("--corpus", type=Path, default=None)

    stage_parser = subparsers.add_parser(
        "stage",
        help="Verify raw Waikiki hover audit artifacts and stage them into a separate upload directory",
    )
    stage_parser.add_argument("--raw", type=Path, required=True)
    stage_parser.add_argument("--out", type=Path, required=True)
    stage_parser.add_argument("--corpus", type=Path, default=None)

    args = parser.parse_args(argv)
    if args.command == "checkout":
        checkout_corpus(args.dest, repo=args.repo, commit=args.commit)
        return 0
    if args.command == "run":
        run_audit(args.corpus, args.out, restore_source=args.restore_source, timeout_seconds=args.timeout_seconds)
        return 0
    if args.command == "verify":
        step_summary = Path(os.environ["GITHUB_STEP_SUMMARY"]) if os.environ.get("GITHUB_STEP_SUMMARY") else None
        verify_artifacts(args.out, corpus_dir=args.corpus, repo_dir=ROOT, step_summary_path=step_summary)
        return 0
    if args.command == "stage":
        step_summary = Path(os.environ["GITHUB_STEP_SUMMARY"]) if os.environ.get("GITHUB_STEP_SUMMARY") else None
        stage_verified_artifacts(
            args.raw,
            args.out,
            corpus_dir=args.corpus,
            repo_dir=ROOT,
            step_summary_path=step_summary,
        )
        return 0
    raise AuditVerificationError(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
