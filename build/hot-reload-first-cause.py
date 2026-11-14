#!/usr/bin/env python3
"""Private, one-execution capture plumbing for issue 5976."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAPTURE = ROOT / "out/artifacts/issue-5976-first-cause/capture"
RAW = CAPTURE / "raw"
PUBLISH = CAPTURE / "publish"
PROJECT = ROOT / "build/hot-reload-first-cause/HotReloadFirstCause.gsproj"
HELPER = ROOT / "out/bin/Release/HotReloadFirstCause/HotReloadFirstCause.dll"
SIDECAR = re.compile(
    r"msbuild-dotnet-watch\.[A-Za-z0-9_-]+\.(App|Lib|Base)\.gsproj\.[0-9]+\.binlog"
)
HEX = re.compile(r"[0-9a-fA-F]{64}")
GUID = re.compile(r"[0-9a-fA-F]{32}")
SHA = re.compile(r"[0-9a-f]{40}")
BRANCH = "refs/heads/oats/5976-first-submission-cause"
EVENT_KEYS = {
    "kind", "ticks", "node", "project", "target", "task", "submission",
    "parent_project", "category", "role", "thread", "identity", "hresult",
    "hresult_present", "frames_truncated", "frames",
}


def route(event, branch, sha, attempt, enabled, expected):
    """Keep the original nightly route except for an explicit diagnostic request."""
    diagnostic = (
        event == "workflow_dispatch" and enabled is True and branch == BRANCH
        and attempt == 1 and bool(SHA.fullmatch(expected)) and sha == expected
    )
    nightly = not (event == "workflow_dispatch" and enabled is True)
    return nightly, diagnostic


def prepare():
    RAW.mkdir(parents=True, exist_ok=False)
    if any(SIDECAR.fullmatch(p.name) for p in ROOT.iterdir()):
        (RAW / "blocked").write_text("1")
        return 1
    (RAW / "owner").write_text("5976")
    return 0


def finish():
    if not (RAW / "owner").is_file():
        return
    for path in ROOT.iterdir():
        if SIDECAR.fullmatch(path.name) and path.is_file() and not path.is_symlink():
            target = RAW / path.name
            if not target.exists():
                path.rename(target)


def watcher_pid(launch, proc=Path("/proc")):
    """Inspect only the known launcher's bounded descendant tree on Linux."""
    integer(launch, 1)
    pending = [launch]
    seen = set()
    matches = []
    while pending and len(seen) < 32:
        pid = pending.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        try:
            arguments = (proc / str(pid) / "cmdline").read_bytes()
            if len(arguments) > 65536:
                continue
            names = [Path(p.decode(errors="replace")).name for p in arguments.split(b"\0") if p]
            if any(name in {"dotnet-watch", "dotnet-watch.dll"} for name in names):
                matches.append(pid)
            children = (proc / str(pid) / "task" / str(pid) / "children").read_text()
            if len(children) > 1024:
                continue
            for value in children.split():
                if re.fullmatch(r"[1-9][0-9]{0,8}", value):
                    pending.append(int(value))
        except OSError:
            continue
    return matches[0] if len(matches) == 1 and not pending else 0


def integer(value, low=0, high=2147483647):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("invalid_integer")


def boolean(value):
    if type(value) is not bool:
        raise ValueError("invalid_boolean")


def keys(value, expected):
    if type(value) is not dict or set(value) != expected:
        raise ValueError("invalid_keys")


def validate_summary(value):
    keys(value, {"schema", "absence_proven", "cross_process_order_exact", "build", "processes"})
    integer(value["schema"], 1, 1)
    if value["absence_proven"] is not False or value["cross_process_order_exact"] is not False:
        raise ValueError("unsupported_inference")
    build = value["build"]
    keys(build, {
        "status", "succeeded", "projects_finished", "targets_finished",
        "tasks_finished", "errors", "cancellations", "selection_truncated", "events",
    })
    integer(build["status"], 0, 8)
    integer(build["succeeded"], -1, 1)
    for name in ("projects_finished", "targets_finished", "tasks_finished", "errors", "cancellations"):
        integer(build[name])
    boolean(build["selection_truncated"])
    validate_events(build["events"], 32, 1, 6)
    processes = value["processes"]
    if type(processes) is not list or len(processes) != 2:
        raise ValueError("invalid_processes")
    for expected_role, data in enumerate(processes, 1):
        keys(data, {
            "status", "role", "pid", "events_lost", "rundown", "has_stacks",
            "exceptions", "cancellations", "selection_truncated", "anchor_ticks", "events",
        })
        integer(data["status"], 0, 8)
        integer(data["role"], expected_role, expected_role)
        integer(data["pid"])
        integer(data["events_lost"], 0, 9223372036854775807)
        integer(data["anchor_ticks"], 0, 3155378975999999999)
        for name in ("rundown", "has_stacks", "selection_truncated"):
            boolean(data[name])
        for name in ("exceptions", "cancellations"):
            integer(data[name])
        validate_events(data["events"], 10, 7, 8)


def validate_events(events, maximum, first, last):
    if type(events) is not list or len(events) > maximum:
        raise ValueError("invalid_events")
    for event in events:
        keys(event, EVENT_KEYS)
        integer(event["kind"], first, last)
        integer(event["ticks"], 0, 3155378975999999999)
        for name in ("node", "project", "target", "task", "submission", "parent_project", "thread"):
            integer(event[name], -2147483648)
        integer(event["category"], 0, 7)
        integer(event["role"], 0, 3)
        if type(event["identity"]) is not str or (event["identity"] and not HEX.fullmatch(event["identity"])):
            raise ValueError("invalid_identity")
        boolean(event["frames_truncated"])
        integer(event["hresult"], -2147483648, 4294967295)
        boolean(event["hresult_present"])
        frames = event["frames"]
        if type(frames) is not list or len(frames) > 10:
            raise ValueError("invalid_frames")
        if first == 1 and frames:
            raise ValueError("unexpected_build_stack")
        for frame in frames:
            keys(frame, {"category", "token", "identity", "module", "pdb_guid"})
            integer(frame["category"], 0, 6)
            integer(frame["token"], -2147483648)
            if type(frame["identity"]) is not str or not HEX.fullmatch(frame["identity"]):
                raise ValueError("invalid_identity")
            if type(frame["module"]) is not str or not HEX.fullmatch(frame["module"]):
                raise ValueError("invalid_module")
            if type(frame["pdb_guid"]) is not str or not GUID.fullmatch(frame["pdb_guid"]):
                raise ValueError("invalid_pdb_guid")


def bounded_encoding(value):
    """Keep negative build events and cancellation callers when trimming supplements."""
    validate_summary(value)
    while True:
        encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
        if len(encoded) <= 61440:
            return encoded
        candidates = []
        for process_index, process in enumerate(value["processes"]):
            for event_index, event in enumerate(process["events"]):
                if event["kind"] == 8:
                    candidates.append((
                        abs(event["ticks"] - process["anchor_ticks"]),
                        process_index, event_index,
                    ))
        if not candidates:
            raise ValueError("critical_payload_limit")
        _, process_index, event_index = max(candidates)
        process = value["processes"][process_index]
        del process["events"][event_index]
        process["selection_truncated"] = True


def digest(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 67108864:
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def empty_summary(status):
    build = {
        "status": status, "succeeded": -1, "projects_finished": 0, "targets_finished": 0,
        "tasks_finished": 0, "errors": 0, "cancellations": 0,
        "selection_truncated": False, "events": [],
    }
    return {
        "schema": 1, "absence_proven": False, "cross_process_order_exact": False,
        "build": build,
        "processes": [
            {"status": status, "role": role, "pid": 0, "events_lost": 0,
             "rundown": False, "has_stacks": False, "exceptions": 0,
             "cancellations": 0, "selection_truncated": False, "anchor_ticks": 0, "events": []}
            for role in (1, 2)
        ],
    }


def native_binlog_pattern(pid):
    integer(pid)
    return re.compile(rf"initial-[0-9]{{8}}-[0-9]{{6}}--{pid}--[A-Za-z0-9+_]{{6}}\.binlog")


def select_inputs(raw):
    if any(p.is_symlink() for p in raw.iterdir()):
        raise ValueError("private_input_link")
    watcher = 0
    initial = 0
    pid_file = raw / "watcher-pid.txt"
    if pid_file.is_file() and pid_file.stat().st_size <= 16:
        text = pid_file.read_text().strip()
        if re.fullmatch(r"[1-9][0-9]{0,8}", text):
            watcher = int(text)
    log = raw / "watch.log"
    if log.is_file() and log.stat().st_size <= 1048576:
        match = re.search(
            r"Launched '[^\r\n]*' with arguments 'build [^\r\n]*"
            r"samples/HotReload/App/App\.gsproj [^\r\n]*': process id ([1-9][0-9]{0,8})",
            log.read_text(errors="replace"),
        )
        if match:
            initial = int(match[1])
    if initial == watcher:
        initial = 0
    pattern = native_binlog_pattern(initial)
    candidates = sorted(p for p in raw.iterdir() if pattern.fullmatch(p.name) and p.is_file())
    binlog = candidates[0] if len(candidates) == 1 else raw / "missing-initial.binlog"
    return binlog, raw / f"process-{initial}.nettrace", raw / f"process-{watcher}.nettrace", initial, watcher, len(candidates)


def private_run(command, log, timeout):
    with log.open("wb") as stream:
        try:
            return subprocess.run(
                command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT,
                timeout=timeout, check=False,
            ).returncode
        except (OSError, subprocess.TimeoutExpired):
            return -1


def project(raw=RAW, publish=PUBLISH, e2e_exit=255, build=True):
    """Only validated JSON crosses from the private directory to publication."""
    raw.mkdir(parents=True, exist_ok=True)
    publish.mkdir(parents=True, exist_ok=True)
    summary = empty_summary(1)
    status = 1
    selected = (raw / "missing", raw / "missing", raw / "missing", 0, 0, 0)
    try:
        selected = select_inputs(raw)
        binlog, child_trace, watcher_trace, child, watcher, matches = selected
        traces = list(raw.glob("process-*.nettrace"))
        within_bounds = (
            len(traces) <= 64
            and sum(p.stat().st_size for p in traces) <= 268435456
            and all(p.stat().st_size <= 67108864 for p in traces)
            and (not binlog.exists() or binlog.stat().st_size <= 16777216)
        )
        if not within_bounds:
            summary = empty_summary(3)
            status = 3
        else:
            code = 0
            if build:
                code = private_run(
                    ["dotnet", "build", str(PROJECT), "-c", "Release", "--nologo", "-v:q",
                     "-p:RestoreLockedMode=true"],
                    raw / "private-helper-build.log", 120,
                )
            target = raw / "projected-summary.json"
            if code == 0:
                code = private_run(
                    ["dotnet", str(HELPER), str(binlog), str(child_trace), str(watcher_trace),
                     str(child), str(watcher), str(target)],
                    raw / "private-helper-run.log", 60,
                )
            if code == 0 and target.is_file() and target.stat().st_size <= 131072:
                candidate = json.loads(target.read_bytes())
                validate_summary(candidate)
                summary = candidate
                status = 0
            else:
                summary = empty_summary(7)
                status = 7
    except Exception:
        summary = empty_summary(8)
        status = 8
    encoded = bounded_encoding(summary)
    validate_summary(summary)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, check=False,
    ).stdout.decode(errors="replace").strip()
    if not SHA.fullmatch(head):
        head = ""
    binlog, child_trace, watcher_trace, child, watcher, matches = selected
    manifest = {
        "schema": 1, "status": status, "formal_ci": False, "head": head,
        "initial_pid": child, "watcher_pid": watcher, "e2e_exit": e2e_exit,
        "launch_pid": 0,
        "initial_binlog_matches": matches, "summary_bytes": len(encoded),
        "summary_sha256": hashlib.sha256(encoded).hexdigest(),
        "binlog_sha256": digest(binlog), "initial_trace_sha256": digest(child_trace),
        "watcher_trace_sha256": digest(watcher_trace),
    }
    launch_file = raw / "launch-pid.txt"
    if launch_file.is_file() and launch_file.stat().st_size <= 16:
        text = launch_file.read_text().strip()
        if re.fullmatch(r"[1-9][0-9]{0,8}", text):
            manifest["launch_pid"] = int(text)
    manifest_bytes = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode()
    validate_manifest(manifest)
    if len(encoded) + len(manifest_bytes) > 65536:
        raise ValueError("publication_limit")
    (publish / "summary.json").write_bytes(encoded)
    (publish / "manifest.json").write_bytes(manifest_bytes)
    validate_publication(publish)


def validate_manifest(value):
    keys(value, {
        "schema", "status", "formal_ci", "head", "initial_pid", "watcher_pid",
        "e2e_exit", "launch_pid", "initial_binlog_matches", "summary_bytes", "summary_sha256",
        "binlog_sha256", "initial_trace_sha256", "watcher_trace_sha256",
    })
    integer(value["schema"], 1, 1)
    integer(value["status"], 0, 8)
    if value["formal_ci"] is not False:
        raise ValueError("not_formal_ci")
    if type(value["head"]) is not str or (value["head"] and not SHA.fullmatch(value["head"])):
        raise ValueError("invalid_head")
    for name in ("initial_pid", "watcher_pid", "launch_pid", "initial_binlog_matches", "summary_bytes"):
        integer(value[name])
    integer(value["e2e_exit"], 0, 255)
    for name in ("summary_sha256", "binlog_sha256", "initial_trace_sha256", "watcher_trace_sha256"):
        if type(value[name]) is not str or (value[name] and not HEX.fullmatch(value[name])):
            raise ValueError("invalid_hash")


def validate_publication(publish=PUBLISH):
    if {p.name for p in publish.iterdir()} != {"summary.json", "manifest.json"}:
        raise ValueError("publication_files")
    if any(p.is_symlink() or not p.is_file() for p in publish.iterdir()):
        raise ValueError("publication_links")
    if sum(p.stat().st_size for p in publish.iterdir()) > 65536:
        raise ValueError("publication_limit")
    summary_bytes = (publish / "summary.json").read_bytes()
    manifest_bytes = (publish / "manifest.json").read_bytes()
    if len(summary_bytes) + len(manifest_bytes) > 65536:
        raise ValueError("publication_limit")
    summary = json.loads(summary_bytes)
    manifest = json.loads(manifest_bytes)
    validate_summary(summary)
    validate_manifest(manifest)
    if manifest["summary_bytes"] != len(summary_bytes) or manifest["summary_sha256"] != hashlib.sha256(summary_bytes).hexdigest():
        raise ValueError("publication_hash")


def main():
    try:
        command = sys.argv[1]
        if command == "guard":
            _, diagnostic = route(
                os.environ.get("OBS_EVENT", ""), os.environ.get("OBS_REF", ""),
                os.environ.get("OBS_SHA", ""), int(os.environ.get("OBS_ATTEMPT", "0")),
                os.environ.get("OBS_ENABLED", "") == "true", os.environ.get("OBS_EXPECTED", ""),
            )
            return 0 if diagnostic else 1
        if command == "prepare":
            return prepare()
        if command == "identify-watch":
            pid = watcher_pid(int(sys.argv[2]))
            if (RAW / "owner").is_file():
                (RAW / "watcher-pid.txt").write_text(str(pid))
        elif command == "finish":
            finish()
        elif command == "project":
            e2e_exit = int(sys.argv[2])
            integer(e2e_exit, 0, 255)
            project(e2e_exit=e2e_exit)
        elif command == "validate":
            validate_publication()
        elif command == "cleanup":
            if RAW.is_dir() and not RAW.is_symlink():
                shutil.rmtree(RAW)
        else:
            return 2
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
