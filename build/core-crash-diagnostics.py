#!/usr/bin/env python3
"""Dump-free, metadata-only normalization for the separately approved #5393 head."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import xml.etree.ElementTree as ET


PRIVATE = Path("out/5393-ci/private")
PUBLIC = Path("TestResults/5393")
OWNER = b"gsharp-core-crash-5393-v1\n"
MAX_INPUT = 16 * 1024 * 1024
MAX_TOTAL_INPUT = 64 * 1024 * 1024
MAX_FILES = 256
MAX_CASES = 20000
OUTPUT_LIMITS = {"summary.json": 64 * 1024, "provenance.json": 512 * 1024,
                 "test-sequence.json": 8 * 1024 * 1024}
NS = "{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}"
FILTER = ("FullyQualifiedName!~GSharp.Core.Tests.CodeAnalysis.Binding.&"
          "FullyQualifiedName!~GSharp.Core.Tests.ReaderAgreement.")
OUTCOMES = {"Passed", "Failed", "Completed", "Aborted", "Error", "NotExecuted",
            "Inconclusive", "Warning", "Timeout", "NotRunnable", "Disconnected",
            "PassedButRunAborted", "Pending"}
COUNTERS = {"total", "executed", "passed", "failed", "error", "timeout", "aborted",
            "notRunnable", "notExecuted", "disconnected", "warning",
            "passedButRunAborted", "pending", "completed", "inconclusive", "inProgress"}


class DiagnosticError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise DiagnosticError(code)


def read(path, limit=MAX_INPUT):
    require(not path.is_symlink(), "unsafe-file")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.getuid(), "unsafe-file")
        require(info.st_size <= limit, "input-limit")
        data = stream.read(limit + 1)
        require(len(data) <= limit and len(data) == info.st_size, "input-changed")
        return data


def safe_parents(root, relative):
    path = root
    for part in relative.parts:
        path /= part
        if path.exists() or path.is_symlink():
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) and not path.is_symlink()
                    and info.st_uid == os.getuid(), "unsafe-directory")


def image(path, role, expected=None):
    require(re.fullmatch(r"[A-Za-z0-9_.+-]{1,160}", path.name), "image-name")
    # Hashing a declared on-disk input does not establish a loaded module identity.
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 128 * 1024 * 1024,
                "image-limit")
        size = 0
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(block)
            require(size <= 128 * 1024 * 1024, "image-limit")
            digest.update(block)
        require(size == info.st_size, "image-changed")
    value = digest.hexdigest()
    require(expected is None or value == expected.lower(), "tool-input-changed")
    return {"role": role, "name": path.name, "bytes": info.st_size, "sha256": value}


def authorize(environment, event):
    head = event.get("pull_request", {}).get("head", {})
    approved = environment.get("GSHARP_5393_INITIAL_HEAD", "")
    require(re.fullmatch(r"[0-9a-f]{40}", approved)
            and environment.get("GITHUB_EVENT_NAME") == "pull_request"
            and environment.get("GITHUB_REPOSITORY") == "DavidObando/gsharp"
            and head.get("repo", {}).get("full_name") == "DavidObando/gsharp"
            and environment.get("GITHUB_HEAD_REF") == "fix/p0-5393-b12435c5-r2"
            and environment.get("GITHUB_RUN_ATTEMPT") == "1"
            and event.get("action") == "synchronize"
            and event.get("number") == 5432
            and head.get("sha") == approved, "not-authorized")


def provenance(root):
    event = json.loads(read(Path(os.environ["GITHUB_EVENT_PATH"]), 1024 * 1024))
    authorize(os.environ, event)
    require(os.environ.get("TEST_PROJECTS") == "test/Core.Tests/Core.Tests.gsproj"
            and os.environ.get("TEST_FILTER") == FILTER, "test-shape")
    policy = json.loads(read(root / "global.json", 16384))
    require(policy["msbuild-sdks"]["Gsharp.NET.Sdk"] == "0.5.212"
            and policy["sdk"] == {"version": "10.0.300", "rollForward": "latestFeature"},
            "sdk-policy")
    git = subprocess.run(
        ["git", "--no-pager", "-C", str(root), "show", "--no-patch",
         "--format=%H%n%T%n%P", "HEAD"], capture_output=True, check=True, timeout=5,
        env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"})
    lines = git.stdout.decode("ascii").splitlines()
    identities = [lines[0], lines[1], *lines[2].split()]
    require(len(identities) <= 10
            and all(re.fullmatch(r"[0-9a-f]{40}", value) for value in identities),
            "source-identity")
    dirty = subprocess.run(
        ["git", "--no-pager", "-C", str(root), "diff", "--name-only", "HEAD"],
        capture_output=True, check=True, timeout=5)
    require(not dirty.stdout, "tracked-checkout-changed")
    stamps = sorted((root / "out/obj/Core.Tests").rglob("repository-build-tools.cache"))
    require(len(stamps) == 1, "compiler-input-stamp-missing-or-ambiguous")
    stamp = stamps[0]
    stamp_bytes = read(stamp, 2 * 1024 * 1024)
    records = stamp_bytes.decode("utf-8-sig").splitlines()
    named = {}
    references = []
    tools = []
    roots = (root.resolve(),
             Path(os.environ.get("NUGET_PACKAGES", Path.home() / ".nuget/packages")).resolve(),
             Path(os.environ["DOTNET_ROOT"]).resolve())
    # MSBuild properties can retain Windows separators on a Linux runner.
    def msbuild_path(value):
        return Path(value.replace("\\", "/"))

    for record in records:
        if not record:
            continue
        if record.startswith(("COMPILER:", "GENERATOR:", "TASK:")):
            kind, value = record.split(":", 1)
            require(kind not in named, "compiler-input-stamp-schema")
            named[kind] = msbuild_path(value)
        elif record.startswith("REFERENCE:"):
            references.append(msbuild_path(record.removeprefix("REFERENCE:")))
        elif record.startswith(("SOURCE:", "ANALYZER:")):
            continue
        else:
            value, separator, digest = record.rpartition("|")
            require(separator and re.fullmatch(r"[0-9A-Fa-f]{64}", digest),
                    "compiler-input-stamp-schema")
            tools.append((msbuild_path(value), digest))
    require(named.keys() >= {"COMPILER", "TASK"} and references and tools
            and len(references) <= 2048 and len(tools) <= 2048, "compiler-input-stamp-schema")

    def declared(path):
        require(path.is_absolute() and not path.is_symlink(), "input-path")
        physical = path.resolve(strict=True)
        require(any(physical.is_relative_to(base) for base in roots), "input-path")
        return physical

    named = {key: declared(value) for key, value in named.items()}
    for key in ("COMPILER", "TASK"):
        require(named[key].is_relative_to(roots[1] / "gsharp.net.sdk/0.5.212"),
                "compiler-selection")
    tools = [(declared(path), digest) for path, digest in tools]
    tool_images = [
        image(declared(path), "compiler" if path == named["COMPILER"] else
              "build-task" if path == named["TASK"] else "declared-tool-input", digest)
        for path, digest in tools]
    require(any(row["role"] == "compiler" for row in tool_images)
            and any(row["role"] == "build-task" for row in tool_images),
            "compiler-input-stamp-schema")
    reference_images = [image(declared(path), "declared-reference") for path in references]
    output = root / "out/bin/Release/Core.Tests"
    disk = [image(output / name, "pre-test-disk-image") for name in (
        "GSharp.Core.Tests.dll", "GSharp.Core.dll", "Gsharp.Runtime.Channels.dll",
        "Gsharp.Runtime.Values.dll", "GSharp.Core.Tests.deps.json",
        "GSharp.Core.Tests.runtimeconfig.json")]
    command = shutil.which("dotnet")
    require(command is not None, "dotnet-command-missing")
    dotnet = image(Path(command).resolve(strict=True), "resolved-command-not-runtime-identity")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    base = event["pull_request"].get("base", {}).get("sha")
    require(re.fullmatch(r"[0-9]{1,20}", run_id)
            and re.fullmatch(r"[0-9a-f]{40}", base or ""), "run-identity")
    response = stamp.parent / "GSharp.Core.Tests.rsp"
    return {
        "schema_version": 1, "checkout_sha": lines[0], "checkout_tree": lines[1],
        "checkout_parents": lines[2].split(), "pull_request_head": event["pull_request"]["head"]["sha"],
        "pull_request_base": base, "run_id": run_id, "run_attempt": 1,
        "test_project": "test/Core.Tests/Core.Tests.gsproj", "test_filter": FILTER,
        "configuration": "Release",
        "sdk_package": "Gsharp.NET.Sdk/0.5.212",
        "global_json_sha256": hashlib.sha256(read(root / "global.json", 16384)).hexdigest(),
        "workflow_sha256": hashlib.sha256(read(root / ".github/workflows/build.yml")).hexdigest(),
        "input_stamp_sha256": hashlib.sha256(stamp_bytes).hexdigest(),
        "reference_capture": "declared-before-CoreCompile-not-loaded-identities",
        "reference_bytes_at_compilation": None, "generated_compile_inputs": None,
        "response_file_sha256": hashlib.sha256(read(response)).hexdigest() if response.exists() else None,
        "tool_images": tool_images, "reference_images": reference_images, "disk_images": disk,
        "dotnet_command": dotnet,
        "actual_selected_sdk": None, "actual_testhost_runtime": None,
        "actual_vstest_driver": None, "actual_blame_collector": None,
        "actual_loaded_modules": None, "actual_task_or_dynamic_caller": None,
    }


def prepare(root):
    safe_parents(root, PRIVATE)
    safe_parents(root, PUBLIC)
    require(not (root / PRIVATE).exists() and not (root / PUBLIC).exists(), "already-used")
    metadata = provenance(root)
    encoded = json.dumps(metadata).encode("utf-8")
    require(len(encoded) <= OUTPUT_LIMITS["provenance.json"], "artifact-limit")
    path = root / PRIVATE
    path.mkdir(parents=True, mode=0o700)
    (path / ".owner").write_bytes(OWNER)
    (path / "provenance.json").write_bytes(encoded)
    (path / "results").mkdir(mode=0o700)
    for name in ("test.stdout", "test.stderr"):
        descriptor = os.open(path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)


def test_without_collection(root):
    require(os.environ.get("TEST_PROJECTS") == "test/Core.Tests/Core.Tests.gsproj"
            and os.environ.get("TEST_FILTER") == FILTER, "test-shape")
    safe_parents(root, PRIVATE)
    private = root / PRIVATE
    require(not private.exists(), "already-used")
    private.mkdir(parents=True, mode=0o700)
    (private / ".owner").write_bytes(OWNER)
    environment = {**os.environ, "DOTNET_DbgEnableMiniDump": "0",
                   "COMPlus_DbgEnableMiniDump": "0"}
    environment.pop("CS2GS_TEST_SOURCE_ROOT", None)
    try:
        with os.fdopen(os.open(private / "test.stdout",
                               os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600),
                       "wb") as stdout, os.fdopen(os.open(
                           private / "test.stderr",
                           os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600),
                           "wb") as stderr:
            result = subprocess.run(
                ["dotnet", "test", "test/Core.Tests/Core.Tests.gsproj",
                 "--configuration", "Release", "--no-build", "--no-restore",
                 "--filter", FILTER],
                cwd=root, env=environment, stdout=stdout, stderr=stderr)
        status = result.returncode if result.returncode >= 0 else 128 - result.returncode
        print("Core validation wrapper exit: " + str(status))
        return status
    finally:
        cleanup(root)


def xml(data):
    text = data.decode("utf-8-sig")
    require("\x00" not in text and "<!DOCTYPE" not in text.upper()
            and "<!ENTITY" not in text.upper(), "unsafe-xml")
    tree = ET.fromstring(text)
    require(sum(1 for _ in tree.iter()) <= 200000, "xml-node-limit")
    return tree


def method(value):
    if value and len(value) <= 512 and re.fullmatch(
            r"GSharp\.Core\.Tests\.(?:[A-Za-z_][A-Za-z0-9_`+]*\.)+[A-Za-z_][A-Za-z0-9_]*",
            value):
        return value
    return None


def identifier(value):
    if value is not None:
        require(re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
                             value), "identifier-schema")
        return value.lower()
    return None


def sequence(data):
    tree = xml(data)
    require(tree.tag == "TestSequence" and not tree.attrib
            and not (tree.text or "").strip(), "sequence-schema")
    result = []
    for index, node in enumerate(tree):
        require(node.tag == "Test" and set(node.attrib) == {
            "Name", "DisplayName", "Source", "Completed"} and len(node) == 0
            and not (node.text or "").strip() and not (node.tail or "").strip()
            and node.attrib["Completed"] in {"True", "False"}, "sequence-schema")
        require(len(result) < MAX_CASES, "case-limit")
        result.append({"ordinal": index + 1, "method": method(node.attrib["Name"]),
                       "completed": node.attrib["Completed"] == "True",
                       "test_id": None, "execution_id": None})
    return result


def trx(data):
    tree = xml(data)
    require(tree.tag == NS + "TestRun", "trx-schema")
    summaries = tree.findall(NS + "ResultSummary")
    require(len(summaries) == 1, "trx-schema")
    summary = summaries[0]
    outcome = summary.get("outcome")
    require(outcome in OUTCOMES, "trx-schema")
    counters = summary.findall(NS + "Counters")
    require(len(counters) == 1, "trx-schema")
    counters = counters[0].attrib
    require({"total", "executed", "passed", "failed"} <= counters.keys()
            and counters.keys() <= COUNTERS, "counter-schema")
    require(all(re.fullmatch(r"[0-9]{1,9}", value) for value in counters.values()),
            "counter-schema")
    counters = {key: int(value) for key, value in counters.items()}
    require(counters["executed"] <= counters["total"]
            and counters["passed"] + counters["failed"] <= counters["executed"],
            "counter-schema")
    definitions = {}
    for definition in tree.findall(NS + "TestDefinitions/" + NS + "UnitTest"):
        test_id = identifier(definition.get("id"))
        detail = definition.find(NS + "TestMethod")
        require(test_id is not None and test_id not in definitions, "definition-schema")
        definitions[test_id] = method(
            detail.get("className", "") + "." + detail.get("name", "")
            if detail is not None else None)
    results = []
    for node in tree.findall(NS + "Results/" + NS + "UnitTestResult"):
        test_id = identifier(node.get("testId"))
        require(len(results) < MAX_CASES and node.get("outcome") in OUTCOMES, "result-schema")
        results.append({"ordinal": len(results) + 1, "test_id": test_id,
                        "execution_id": identifier(node.get("executionId")),
                        "method": definitions.get(test_id), "outcome": node.get("outcome")})
    return outcome, counters, results


def cleanup(root):
    safe_parents(root, PRIVATE)
    path = root / PRIVATE
    require(shutil.rmtree.avoids_symlink_attacks, "cleanup-unavailable")
    if path.exists():
        require(read(path / ".owner", 128) == OWNER, "unowned-private-directory")
        shutil.rmtree(path)
    require(not path.exists(), "cleanup-failed")


def encode_outputs(documents):
    require(documents.keys() == OUTPUT_LIMITS.keys(), "output-schema")
    summary = documents["summary.json"]
    require(summary.keys() == {
        "schema_version", "issue", "wrapper_exit", "actual_dotnet_test_exit",
        "actual_testhost_exit", "classification", "diagnostic_state", "attribution",
        "trx_present", "trx_outcome", "counters", "sequence_present",
        "original_signature_text_match", "original_issue_fixed", "actual_task_identity",
        "raw_files"}, "output-schema")
    require(all(row.keys() == {"kind", "sha256", "bytes"} for row in summary["raw_files"]),
            "output-schema")
    document = documents["test-sequence.json"]
    require(document.keys() == {
        "schema_version", "sequences", "results", "sequence_order", "cross_sequence_order",
        "result_order", "sequence_schema", "sequence_ids", "completed_semantics", "method_policy"},
        "output-schema")
    records = []
    for group in document["sequences"] or []:
        require(group.keys() == {"ordinal", "occurrences"}, "output-schema")
        for row in group["occurrences"]:
            require(row.keys() == {"ordinal", "method", "completed", "test_id", "execution_id"}
                    and type(row["completed"]) is bool, "output-schema")
            records.append(row)
    for row in document["results"] or []:
        require(row.keys() == {"ordinal", "method", "outcome", "test_id", "execution_id"}
                and row["outcome"] in OUTCOMES, "output-schema")
        records.append(row)
    for row in records:
        require(row["method"] is None or method(row["method"]) == row["method"], "output-schema")
        identifier(row["test_id"])
        identifier(row["execution_id"])
    # Provenance comes from the fixed producer above, never the private JSON.
    encoded = {
        name: json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2).encode("ascii") + b"\n"
        for name, value in documents.items()}
    require(all(len(data) <= OUTPUT_LIMITS[name] for name, data in encoded.items()),
            "artifact-limit")
    return encoded


def finish(root, exit_code):
    documents = None
    try:
        require(type(exit_code) is int and 0 <= exit_code <= 255, "missing-test-exit")
        require(not (root / PUBLIC).exists(), "already-published")
        safe_parents(root, PRIVATE)
        private = root / PRIVATE
        require(read(private / ".owner", 128) == OWNER, "unowned-private-directory")
        files = []
        for directory, subdirectories, names in os.walk(private, followlinks=False):
            for name in subdirectories:
                safe_parents(root, (Path(directory) / name).relative_to(root))
            for name in names:
                path = Path(directory) / name
                require(len(files) < MAX_FILES, "file-count-limit")
                files.append(path)
        inputs = {}
        fingerprints = []
        total_bytes = 0
        for path in sorted(files):
            if path == private / ".owner":
                continue
            if path == private / "provenance.json":
                inputs["provenance"] = json.loads(read(path, OUTPUT_LIMITS["provenance.json"]))
                continue
            if path == private / "test.stdout":
                kind = "stdout"
            elif path == private / "test.stderr":
                kind = "stderr"
            elif path.is_relative_to(private / "results") and path.suffix.lower() == ".trx":
                kind = "trx"
            elif path.is_relative_to(private / "results") and re.fullmatch(
                    r"Sequence_[A-Za-z0-9_-]+\.xml", path.name):
                kind = "sequence"
            else:
                raise DiagnosticError("unexpected-private-file")
            data = read(path, min(MAX_INPUT, MAX_TOTAL_INPUT - total_bytes))
            total_bytes += len(data)
            inputs.setdefault(kind, []).append(data)
            fingerprints.append({"kind": kind, "sha256": hashlib.sha256(data).hexdigest(),
                                 "bytes": len(data)})
        require(len(inputs.get("stdout", [])) == len(inputs.get("stderr", [])) == 1,
                "missing-private-log")
        metadata = provenance(root)
        require(inputs.get("provenance") == metadata, "provenance-changed")
        require(len(inputs.get("trx", [])) <= 1, "multiple-trx")
        outcome, counters, results = trx(inputs["trx"][0]) if inputs.get("trx") else (None, None, None)
        sequences = []
        count = len(results or [])
        for data in inputs.get("sequence", []):
            occurrences = sequence(data)
            count += len(occurrences)
            require(count <= MAX_CASES, "case-limit")
            sequences.append({"ordinal": len(sequences) + 1, "occurrences": occurrences})
        has_occurrences = any(group["occurrences"] for group in sequences)
        nonempty = counters is not None and counters["executed"] > 0 and bool(results)
        if exit_code == 0:
            require(nonempty and outcome in {"Passed", "Completed"}
                    and counters["failed"] == 0
                    and all(counters.get(key, 0) == 0 for key in ("error", "aborted", "timeout"))
                    and all(row["outcome"] in {"Passed", "NotExecuted"} for row in results)
                    and all(row["completed"] for group in sequences for row in group["occurrences"]),
                    "invalid-successful-trx")
        stderr = inputs["stderr"][0]
        signature = all(value in stderr for value in (
            b"System.NullReferenceException", b"Task.RunContinuations", b"ScopeFrame.ExitAsync"))
        classification = ("bounded-nonreproduction" if exit_code == 0 else
                          "timeout-status" if exit_code == 124 else
                          "terminated-status" if exit_code == 137 else "process-failure")
        summary = {
            "schema_version": 1, "issue": 5393, "wrapper_exit": exit_code,
            "actual_dotnet_test_exit": None, "actual_testhost_exit": None,
            "classification": classification,
            "diagnostic_state": "incomplete" if exit_code != 0 and
            (not nonempty or not has_occurrences) else "recorded",
            "attribution": "not-observed" if exit_code == 0 else
            "candidates-only" if has_occurrences else "gap",
            "trx_present": counters is not None, "trx_outcome": outcome, "counters": counters,
            "sequence_present": bool(sequences), "original_signature_text_match": signature,
            "original_issue_fixed": False, "actual_task_identity": None, "raw_files": fingerprints,
        }
        documents = {
            "summary.json": summary, "provenance.json": metadata,
            "test-sequence.json": {
                "schema_version": 1, "sequences": sequences or None, "results": results,
                "sequence_order": "per-file-test-start-order" if sequences else None,
                "cross_sequence_order": None, "result_order": "trx-document-order" if results else None,
                "sequence_schema": "matches-reviewed-vstest-v17.11.1-writer-shape",
                "sequence_ids": "not-serialized-in-accepted-schema",
                "completed_semantics": "serialized-final-object-flag-not-a-finish-event",
                "method_policy": "owned-namespace-identifiers-only-otherwise-null",
            },
        }
        documents = encode_outputs(documents)
    finally:
        try:
            cleanup(root)
        except Exception:
            raise DiagnosticError("cleanup-failed") from None
    safe_parents(root, PUBLIC)
    public = root / PUBLIC
    public.mkdir(parents=True, mode=0o700)
    try:
        for name, data in documents.items():
            with (public / name).open("xb") as stream:
                stream.write(data)
    except Exception:
        shutil.rmtree(public)
        raise


def main():
    root = Path(__file__).resolve().parent.parent
    try:
        require(len(sys.argv) == 2, "command")
        if sys.argv[1] == "test":
            return test_without_collection(root)
        os.umask(0o077)
        if sys.argv[1] == "prepare":
            prepare(root)
        elif sys.argv[1] == "cleanup":
            cleanup(root)
        elif sys.argv[1] == "finish":
            value = os.environ.get("TEST_EXIT_CODE", "")
            finish(root, int(value) if re.fullmatch(r"[0-9]{1,3}", value) else None)
        else:
            raise DiagnosticError("command")
    except Exception as error:
        # Never put raw XML, paths, exception text or test output in the job log.
        code = str(error) if isinstance(error, DiagnosticError) else "metadata-processing-failed"
        print("Core crash diagnostics failed: " + code, file=sys.stderr)
        return 70
    return 0


if __name__ == "__main__":
    sys.exit(main())
