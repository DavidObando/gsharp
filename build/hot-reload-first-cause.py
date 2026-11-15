#!/usr/bin/env python3
"""Private, one-execution capture plumbing for issue 5976."""
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
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
SCOPE = "BINLOG_ONLY"
TASK_FILES = (
    "HotReloadFirstCause.dll", "HotReloadFirstCause.deps.json",
    "Microsoft.Diagnostics.Tracing.TraceEvent.dll",
    "Microsoft.Diagnostics.FastSerialization.dll",
    "Microsoft.Diagnostics.NETCore.Client.dll",
    "Microsoft.Extensions.Logging.Abstractions.dll",
    "Microsoft.Extensions.DependencyInjection.Abstractions.dll",
    "Dia2Lib.dll", "TraceReloggerLib.dll",
)
EVENT_KEYS = {
    "kind", "ticks", "node", "project", "target", "task", "submission",
    "parent_project", "category", "role", "thread", "identity", "hresult",
    "hresult_present", "frames_truncated", "frames",
}


def route(event, branch, sha, attempt, enabled, expected, scope):
    """Keep the original nightly route except for an explicit diagnostic request."""
    diagnostic = (
        event == "workflow_dispatch" and enabled is True and branch == BRANCH
        and attempt == 1 and bool(SHA.fullmatch(expected)) and sha == expected
        and scope == SCOPE
    )
    nightly = not (event == "workflow_dispatch" and enabled is True)
    return nightly, diagnostic


def prepare():
    RAW.mkdir(parents=True, exist_ok=False, mode=0o700)
    if any(SIDECAR.fullmatch(p.name) for p in ROOT.iterdir()):
        (RAW / "blocked").write_text("1")
        return 1
    initialize_session(RAW, ROOT / "samples/HotReload/App/App.gsproj")
    return 0


def initialize_session(raw, expected):
    expected = expected.resolve(strict=True)
    token = secrets.token_hex(16)
    directory = raw / ("native-" + token)
    directory.mkdir(mode=0o700, exist_ok=False)
    (raw / "session.json").write_text(json.dumps({
        "schema": 1, "token": token, "expected_project": str(expected),
    }))
    (raw / "owner").write_text("5976")
    return directory


def load_session(raw):
    if raw.is_symlink() or raw.resolve() != raw.absolute():
        raise ValueError("unowned_root")
    owner = raw / "owner"
    session = raw / "session.json"
    if owner.is_symlink() or session.is_symlink() or not owner.is_file() or owner.read_text() != "5976":
        raise ValueError("unowned_session")
    if not session.is_file() or session.stat().st_size > 4096:
        raise ValueError("missing_session")
    value = json.loads(session.read_bytes())
    keys(value, {"schema", "token", "expected_project"})
    integer(value["schema"], 1, 1)
    if type(value["token"]) is not str or not re.fullmatch(r"[0-9a-f]{32}", value["token"]):
        raise ValueError("invalid_session")
    expected = Path(value["expected_project"])
    if not expected.is_absolute() or expected.resolve(strict=True) != expected or not expected.is_file():
        raise ValueError("invalid_expected_project")
    directory = raw / ("native-" + value["token"])
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("unowned_log_directory")
    return directory, expected


def binlog_option(raw):
    directory, _ = load_session(raw)
    return f"-bl:{directory}/initial-{{}}.binlog;ProjectImports=None;OmitInitialInfo"


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
    keys(value, {"schema", "capture_quality", "readers", "absence_proven", "cross_process_order_exact", "build", "processes"})
    integer(value["schema"], 2, 2)
    integer(value["capture_quality"], 0, 3)
    if type(value["readers"]) is not list or len(value["readers"]) != 3:
        raise ValueError("invalid_readers")
    for kind, reader in enumerate(value["readers"], 1):
        keys(reader, {"kind", "known", "name_identity", "sha256", "mvid", "assembly_version", "file_version"})
        integer(reader["kind"], kind, kind)
        boolean(reader["known"])
        opaque(reader["name_identity"])
        opaque(reader["sha256"])
        if type(reader["mvid"]) is not str or not GUID.fullmatch(reader["mvid"]):
            raise ValueError("invalid_reader_mvid")
        for field in ("assembly_version", "file_version"):
            version = reader[field]
            if type(version) is not list or len(version) != 4:
                raise ValueError("invalid_reader_version")
            for part in version:
                integer(part, -1)
        if reader["known"] and (
            not reader["name_identity"] or not reader["sha256"] or reader["mvid"] == "0" * 32
        ):
            raise ValueError("incomplete_reader_identity")
    if value["absence_proven"] is not False or value["cross_process_order_exact"] is not False:
        raise ValueError("unsupported_inference")
    build = value["build"]
    keys(build, {
        "status", "succeeded", "projects_finished", "targets_finished",
        "tasks_finished", "errors", "cancellations", "selection_truncated", "events",
        "build_started", "build_finished_seen", "replay_returned", "projects_started",
        "targets_started", "tasks_started", "reader",
    })
    integer(build["status"], 0, 8)
    integer(build["succeeded"], -1, 1)
    for name in ("projects_started", "targets_started", "tasks_started",
                 "projects_finished", "targets_finished", "tasks_finished", "errors", "cancellations"):
        integer(build[name])
    for name in ("build_started", "build_finished_seen", "replay_returned"):
        boolean(build[name])
    validate_reader_state(build["reader"])
    if build["replay_returned"] != build["reader"]["returned"]:
        raise ValueError("inconsistent_replay_state")
    if build["status"] == 0 and not (
        build["reader"]["outcome"] == 1 and build["replay_returned"] and build["build_finished_seen"]
    ):
        raise ValueError("incomplete_successful_build_read")
    boolean(build["selection_truncated"])
    validate_events(build["events"], 32, 1, 6)
    processes = value["processes"]
    if type(processes) is not list or len(processes) != 2:
        raise ValueError("invalid_processes")
    for expected_role, data in enumerate(processes, 1):
        keys(data, {
            "status", "role", "pid", "events_lost", "rundown", "has_stacks",
            "exceptions", "cancellations", "selection_truncated", "anchor_ticks", "events",
            "reader",
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
        validate_reader_state(data["reader"])
        if data["status"] == 0 and data["reader"]["outcome"] != 1:
            raise ValueError("incomplete_successful_trace_read")
        validate_events(data["events"], 10, 7, 8)
    if value["capture_quality"] == 0:
        if value != empty_summary(build["status"]):
            raise ValueError("noncanonical_unavailable_capture")
    elif value["capture_quality"] != capture_quality(value):
        raise ValueError("invalid_capture_quality")


def opaque(value):
    if type(value) is not str or (value and not HEX.fullmatch(value)):
        raise ValueError("invalid_opaque_identity")


def validate_reader_state(value):
    keys(value, {
        "stage", "outcome", "returned", "input_bytes_known", "input_bytes",
        "header_known", "format_version", "minimum_reader_version", "exception",
        "event_limit", "events_seen", "native_truncated", "limit_reached",
    })
    integer(value["stage"], 0, 9)
    integer(value["outcome"], 0, 15)
    for name in ("returned", "input_bytes_known", "header_known"):
        boolean(value[name])
    integer(value["input_bytes"], 0, 9223372036854775807)
    integer(value["format_version"])
    integer(value["minimum_reader_version"])
    integer(value["event_limit"])
    integer(value["events_seen"])
    boolean(value["native_truncated"])
    boolean(value["limit_reached"])
    if not value["input_bytes_known"] and value["input_bytes"] != 0:
        raise ValueError("unknown_input_size")
    if not value["header_known"] and (value["format_version"] or value["minimum_reader_version"]):
        raise ValueError("unknown_native_header")
    error = value["exception"]
    keys(error, {"present", "type_identity", "hresult", "hresult_present"})
    boolean(error["present"])
    boolean(error["hresult_present"])
    opaque(error["type_identity"])
    integer(error["hresult"], -2147483648, 4294967295)
    if not error["present"] and (error["type_identity"] or error["hresult_present"] or error["hresult"]):
        raise ValueError("absent_reader_exception")
    if value["outcome"] in (1, 2, 9, 10, 11, 12) and not value["returned"]:
        raise ValueError("missing_reader_return")
    if value["outcome"] in (3, 4, 5, 6, 7, 8, 14, 15) and not error["present"]:
        raise ValueError("missing_reader_fault")
    if value["outcome"] == 9 and not (value["native_truncated"] or value["limit_reached"]):
        raise ValueError("unreported_trace_limit")


def capture_quality(value):
    if any(p["events_lost"] > 0 for p in value["processes"]):
        return 3
    if value["build"]["status"] == 0 and all(p["status"] == 0 for p in value["processes"]):
        return 1
    return 2


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
        "build_started": False, "build_finished_seen": False, "replay_returned": False,
        "projects_started": 0, "targets_started": 0, "tasks_started": 0,
        "reader": empty_reader_state(),
    }
    return {
        "schema": 2, "capture_quality": 0, "readers": [
            {"kind": kind, "known": False, "name_identity": "", "sha256": "",
             "mvid": "0" * 32, "assembly_version": [0] * 4, "file_version": [0] * 4}
            for kind in (1, 2, 3)
        ], "absence_proven": False, "cross_process_order_exact": False,
        "build": build,
        "processes": [
            {"status": status, "role": role, "pid": 0, "events_lost": 0,
             "rundown": False, "has_stacks": False, "exceptions": 0,
             "cancellations": 0, "selection_truncated": False, "anchor_ticks": 0,
             "events": [], "reader": empty_reader_state()}
            for role in (1, 2)
        ],
    }


def empty_reader_state():
    return {
        "stage": 0, "outcome": 0, "returned": False,
        "input_bytes_known": False, "input_bytes": 0,
        "header_known": False, "format_version": 0, "minimum_reader_version": 0,
        "event_limit": 0, "events_seen": 0, "native_truncated": False, "limit_reached": False,
        "exception": {"present": False, "type_identity": "", "hresult": 0, "hresult_present": False},
    }


def native_binlog_pattern():
    return re.compile(r"initial-[0-9]{8}-[0-9]{6}--(?P<writer>[1-9][0-9]{0,8})--[A-Za-z0-9+_]{6}\.binlog")


def select_inputs(raw):
    if any(p.is_symlink() for p in raw.iterdir()):
        raise ValueError("private_input_link")
    directory, _ = load_session(raw)
    initial, _ = initial_build_record(raw)
    pattern = native_binlog_pattern()
    if any(p.is_symlink() or not p.is_file() or not pattern.fullmatch(p.name) for p in directory.iterdir()):
        raise ValueError("unreviewed_log_file")
    candidates = list(directory.iterdir())
    binlog = candidates[0] if len(candidates) == 1 else raw / "missing-initial.binlog"
    writer = int(pattern.fullmatch(binlog.name)["writer"]) if len(candidates) == 1 else 0
    return binlog, raw / "NOT_OBSERVED-initial.nettrace", raw / "NOT_OBSERVED-watcher.nettrace", initial, writer, len(candidates)


def initial_build_record(raw):
    _, expected = load_session(raw)
    log = raw / "watch.log"
    if not log.is_file() or log.stat().st_size > 1048576:
        return 0, False
    text = log.read_text(errors="replace")
    launches = []
    for match in re.finditer(r"Launched '[^'\r\n]*' with arguments '(build [^\r\n]*)': process id ([1-9][0-9]{0,8})(?![0-9])", text):
        arguments = shlex.split(match[1])
        if str(expected) in arguments:
            if binlog_option(raw) not in arguments:
                return 0, False
            launches.append(match)
    if len(launches) != 1:
        return 0, False
    pid = int(launches[0][2])
    exits = list(re.finditer(
        rf"Process id {pid} ran for [0-9]+ms and exited with exit code -?[0-9]+(?![0-9])",
        text[launches[0].end():],
    ))
    return pid, len(exits) == 1


def build_exit_recorded(raw, pid):
    recorded, exited = initial_build_record(raw)
    return recorded == pid and exited


def installed_native_host(raw):
    log = raw / "private-installed-sdks.log"
    if private_run(["dotnet", "--list-sdks"], log, 20) != 0:
        return None
    candidates = []
    for line in log.read_text(errors="replace").splitlines():
        match = re.fullmatch(r"11\.0\.100 \[([^\]\r\n]+)\]", line.strip())
        if match:
            base = Path(match[1])
            candidates.append({"dotnet": base.parent / "dotnet", "sdk": base / "11.0.100"})
    if len(candidates) != 1:
        return None
    host = candidates[0]
    required = ("MSBuild.dll", "MSBuild.runtimeconfig.json", "MSBuild.deps.json",
                "Microsoft.Build.dll", "Microsoft.Build.Framework.dll")
    if not host["dotnet"].is_file() or not all((host["sdk"] / p).is_file() for p in required):
        return None
    return host


def run_native_task(raw, binlog, target, host, expected=None):
    stage = raw / "native-task"
    stage.mkdir(exist_ok=False)
    for name in TASK_FILES:
        shutil.copyfile(HELPER.parent / name, stage / name)
    if any(p.name.startswith("Microsoft.Build") for p in stage.iterdir()):
        raise ValueError("private_reader_shadow")
    project = ET.Element("Project")
    ET.SubElement(project, "UsingTask", TaskName="ProjectionTask", AssemblyFile=str(stage / HELPER.name))
    build = ET.SubElement(project, "Target", Name="Project")
    task = ET.SubElement(
        build, "ProjectionTask", Binlog=str(binlog),
        InitialTrace=str(raw / "NOT_OBSERVED-initial.nettrace"),
        WatcherTrace=str(raw / "NOT_OBSERVED-watcher.nettrace"),
        InitialPid="0", WatcherPid="0", SummaryFile=str(target),
    )
    if expected is not None:
        task.set("ExpectedProject", str(expected))
        task.set("SnapshotFile", str(raw / "private-snapshot.binlog"))
        task.set("OwnershipFile", str(raw / "private-ownership.json"))
    driver = raw / "native-driver.proj"
    ET.ElementTree(project).write(driver, encoding="utf-8", xml_declaration=True)
    return private_run(
        [str(host["dotnet"]), str(host["sdk"] / "MSBuild.dll"), str(driver),
         "/t:Project", "/nologo", "/noconlog"],
        raw / "private-native-host.log", 60,
    )


def validate_host_binding(summary, host):
    for role, name in (
        (1, "Microsoft.Build.dll"),
        (2, "Microsoft.Build.Framework.dll"),
    ):
        reader = summary["readers"][role - 1]
        if not (
            reader["kind"] == role and reader["known"] and reader["file_version"][:3] == [18, 12, 2]
            and type(reader["mvid"]) is str and GUID.fullmatch(reader["mvid"])
            and reader["mvid"] != "0" * 32
            and reader["sha256"].lower() == digest(host["sdk"] / name)
        ):
            raise ValueError("unverified_native_host")
    trace = summary["readers"][2]
    if not trace["known"] or trace["sha256"].lower() != digest(HELPER.parent / TASK_FILES[2]):
        raise ValueError("unverified_trace_dependency")


def validate_binlog_only(summary):
    if summary["capture_quality"] == 0 and summary == empty_summary(summary["build"]["status"]):
        return
    if summary["processes"] != empty_summary(1)["processes"]:
        raise ValueError("unexpected_trace_observation")
    if summary["capture_quality"] not in (0, 2):
        raise ValueError("comprehensive_capture_claim")


def validate_ownership(raw, source_hash, source_bytes):
    proof = raw / "private-ownership.json"
    if proof.is_symlink() or not proof.is_file() or proof.stat().st_size > 4096:
        raise ValueError("missing_ownership")
    value = json.loads(proof.read_bytes())
    keys(value, {"schema", "snapshot_created", "snapshot_bytes", "snapshot_sha256",
                 "root_projects", "matching_roots", "project_bound", "project_binding"})
    integer(value["schema"], 1, 1)
    for field in ("snapshot_created", "project_bound"):
        boolean(value[field])
    for field in ("snapshot_bytes", "root_projects", "matching_roots"):
        integer(value[field])
    integer(value["project_binding"], 0, 2)
    if value["matching_roots"] > value["root_projects"]:
        raise ValueError("invalid_native_project_counts")
    binding = 0 if value["root_projects"] == 0 else (
        1 if value["root_projects"] == value["matching_roots"] else 2
    )
    if value["project_binding"] != binding or value["project_bound"] != (binding == 1):
        raise ValueError("inconsistent_native_project_binding")
    opaque(value["snapshot_sha256"])
    return (
        value["snapshot_created"]
        and value["snapshot_bytes"] == source_bytes
        and value["snapshot_sha256"].lower() == source_hash
        and digest(raw / "private-snapshot.binlog") == source_hash
    ), binding


def private_run(command, log, timeout):
    with log.open("wb") as stream:
        try:
            return subprocess.run(
                command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT,
                timeout=timeout, check=False,
            ).returncode
        except (OSError, subprocess.TimeoutExpired):
            return -1


def project(raw=RAW, publish=PUBLISH, e2e_exit=255, build=True, host=None):
    """Only validated JSON crosses from the private directory to publication."""
    raw.mkdir(parents=True, exist_ok=True)
    publish.mkdir(parents=True, exist_ok=True)
    summary = empty_summary(1)
    status = 1
    preflight = 1
    writer_check = 0
    ownership_verified = False
    capability_verified = False
    project_binding = 0
    selected = (raw / "missing", raw / "missing", raw / "missing", 0, 0, 0)
    try:
        selected = select_inputs(raw)
        binlog, child_trace, watcher_trace, child, native_writer, matches = selected
        directory, expected = load_session(raw)
        if matches != 1 or not binlog.is_file() or not build_exit_recorded(raw, child):
            summary = empty_summary(1)
        elif any(raw.glob("*.nettrace")):
            summary = empty_summary(8)
            status = 8
            preflight = 6
        elif (
            binlog.stat().st_size > 16777216
            or len(list(raw.rglob("*.binlog"))) > 64
            or sum(p.stat().st_size for p in raw.rglob("*.binlog")) > 268435456
        ):
            summary = empty_summary(3)
            status = 3
            preflight = 7
        else:
            capability_verified = True
            writer_check = 1
            before_stat = binlog.stat()
            before = (before_stat.st_dev, before_stat.st_ino, before_stat.st_size, before_stat.st_mtime_ns)
            before_hash = digest(binlog)
            selected_host = host if host is not None else installed_native_host(raw)
            if selected_host is None:
                summary = empty_summary(7)
                status = 7
                preflight = 2
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
                    code = run_native_task(raw, binlog, target, selected_host, expected)
                if code != 0 or not target.is_file() or target.stat().st_size > 131072:
                    summary = empty_summary(7)
                    status = 7
                    preflight = 3
                else:
                    candidate = json.loads(target.read_bytes())
                    validate_summary(candidate)
                    validate_binlog_only(candidate)
                    preflight = 4
                    validate_host_binding(candidate, selected_host)
                    preflight = 8
                    ownership_verified, project_binding = validate_ownership(raw, before_hash, before_stat.st_size)
                    ownership_verified = ownership_verified and candidate["build"]["reader"]["header_known"]
                    after = binlog.stat()
                    if before != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or digest(binlog) != before_hash:
                        summary = empty_summary(8)
                        status = 8
                        preflight = 5
                        ownership_verified = False
                    elif not ownership_verified or project_binding == 2:
                        summary = empty_summary(8)
                        status = 8
                        writer_check = 2
                    else:
                        summary = candidate
                        status = 0
                        preflight = 0
                        native = summary["build"]
                        writer_check = 4 if native["replay_returned"] and native["build_finished_seen"] else (
                            3 if native["reader"]["header_known"] else 2
                        )
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
    binlog, child_trace, watcher_trace, child, native_writer, matches = selected
    manifest = {
        "schema": 2, "status": status, "schema_valid": True,
        "capture_quality": summary["capture_quality"], "formal_ci": False, "head": head,
        "observation_scope": "INITIAL_NATIVE_BINLOG_ONLY",
        "trace_inputs": "NOT_OBSERVED",
        "preflight": preflight, "writer_check": writer_check,
        "initial_pid": child, "native_writer_pid": native_writer, "watcher_pid": 0, "e2e_exit": e2e_exit,
        "snapshot_verified": ownership_verified, "capability_verified": capability_verified,
        "project_binding": project_binding, "project_bound": project_binding == 1,
        "launch_pid": 0,
        "initial_binlog_matches": matches, "summary_bytes": len(encoded),
        "summary_sha256": hashlib.sha256(encoded).hexdigest(),
        "binlog_sha256": digest(binlog), "initial_trace_sha256": "",
        "watcher_trace_sha256": "",
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
        "schema", "status", "schema_valid", "capture_quality", "formal_ci", "head", "initial_pid", "watcher_pid",
        "e2e_exit", "launch_pid", "initial_binlog_matches", "summary_bytes", "summary_sha256",
        "binlog_sha256", "initial_trace_sha256", "watcher_trace_sha256",
        "observation_scope", "trace_inputs", "preflight", "writer_check",
        "native_writer_pid", "snapshot_verified", "project_bound", "project_binding", "capability_verified",
    })
    integer(value["schema"], 2, 2)
    integer(value["status"], 0, 8)
    if value["schema_valid"] is not True:
        raise ValueError("schema_not_validated")
    integer(value["capture_quality"], 0, 3)
    if value["observation_scope"] != "INITIAL_NATIVE_BINLOG_ONLY" or value["trace_inputs"] != "NOT_OBSERVED":
        raise ValueError("unreviewed_observation_scope")
    integer(value["preflight"], 0, 8)
    integer(value["writer_check"], 0, 4)
    boolean(value["snapshot_verified"])
    boolean(value["project_bound"])
    boolean(value["capability_verified"])
    integer(value["project_binding"], 0, 2)
    if value["project_bound"] != (value["project_binding"] == 1):
        raise ValueError("inconsistent_project_binding")
    if value["snapshot_verified"] and not value["capability_verified"]:
        raise ValueError("unverified_capability")
    if value["writer_check"] in (3, 4) and not value["snapshot_verified"]:
        raise ValueError("unverified_finalization")
    if value["capture_quality"] not in (0, 2):
        raise ValueError("comprehensive_capture_claim")
    if value["initial_trace_sha256"] or value["watcher_trace_sha256"] or value["watcher_pid"]:
        raise ValueError("unreviewed_trace_input")
    if value["formal_ci"] is not False:
        raise ValueError("not_formal_ci")
    if type(value["head"]) is not str or (value["head"] and not SHA.fullmatch(value["head"])):
        raise ValueError("invalid_head")
    for name in ("initial_pid", "native_writer_pid", "watcher_pid", "launch_pid", "initial_binlog_matches", "summary_bytes"):
        integer(value[name])
    integer(value["e2e_exit"], 0, 255)
    for name in ("summary_sha256", "binlog_sha256", "initial_trace_sha256", "watcher_trace_sha256"):
        if type(value[name]) is not str or (value[name] and not HEX.fullmatch(value[name])):
            raise ValueError("invalid_hash")
    if value["snapshot_verified"] and value["project_binding"] != 2 and not (
        value["status"] == 0 and value["preflight"] == 0
        and value["initial_binlog_matches"] == 1 and value["initial_pid"] > 0
        and value["native_writer_pid"] > 0 and bool(value["binlog_sha256"])
        and value["capture_quality"] == 2
    ):
        raise ValueError("unverified_submission")
    if value["project_binding"] == 2 and (value["status"] != 8 or value["capture_quality"] != 0):
        raise ValueError("native_project_mismatch")


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
    validate_binlog_only(summary)
    if manifest["capture_quality"] != summary["capture_quality"]:
        raise ValueError("capture_quality_mismatch")
    if manifest["writer_check"] == 4 and summary["build"]["status"] != 0:
        raise ValueError("unconfirmed_build_finished")
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
                os.environ.get("OBS_SCOPE", ""),
            )
            return 0 if diagnostic else 1
        if command == "prepare":
            status = prepare()
            if status == 0:
                print(binlog_option(RAW))
            return status
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
