"""Import a provenance-preserving static snapshot from concurrency-bench.yml."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import zipfile

SITE = Path(__file__).resolve().parents[1]
REPO = "DavidObando/gsharp"


def gh(path, binary=False):
    result = subprocess.run(["gh", "api", path], capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"GitHub request failed: {path}\n{result.stderr.decode()}")
    return result.stdout if binary else json.loads(result.stdout)


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"Invalid benchmark number: {value!r}")
    return value


def measurement(value, runs, launches):
    if value is None:
        return None
    median = finite(value["median_ns"])
    interval = value["ci95_ns"]
    if len(interval) != 2:
        raise ValueError("A benchmark interval needs two endpoints")
    low, high = map(finite, interval)
    if not low <= median <= high:
        raise ValueError("The median must be inside its reported interval")
    if value.get("runs") != runs or type(value.get("samples")) is not int or value["samples"] != runs * launches:
        raise ValueError("Incomplete whole-run sample accounting")
    return {"medianNs": median, "intervalNs": [low, high], "samples": value["samples"], "runs": runs}


def normalize(payload, registry, run, artifact, raw, checked_at):
    if payload.get("schemaVersion") != 2:
        raise ValueError("Unsupported concurrency artifact schema")
    if registry.get("schemaVersion") != 1:
        raise ValueError("Unsupported scenario registry schema")
    fingerprint = payload["fingerprint"]
    method = fingerprint["comparison"]
    build = fingerprint["build"]
    if run["conclusion"] != "success" or run["head_branch"] != "main":
        raise ValueError("Only successful main-branch runs can supply the website snapshot")
    if run["path"].split("@")[0] != ".github/workflows/concurrency-bench.yml":
        raise ValueError("The run does not belong to concurrency-bench.yml")
    if build["gitCommit"] != run["head_sha"] or build["gitDirty"]:
        raise ValueError("Benchmark build identity does not match the workflow run")
    if method["wholeRuns"] != 3 or method["scenario"] != "all":
        raise ValueError("Expected three complete benchmark runs")
    if set(method["modes"]) != {"gsharp", "gsharp_aot", "go"}:
        raise ValueError("The website comparison requires JIT, NativeAOT, and Go")
    if method["intervalMethod"] != "range-of-run-medians":
        raise ValueError("Unsupported aggregation interval method")
    if type(method["launches"]) is not int or method["launches"] < 1:
        raise ValueError("Invalid process-launch count")
    if not isinstance(fingerprint["comparable"], bool):
        raise ValueError("Missing comparability state")
    reasons = fingerprint["incomparabilityReasons"]
    if not fingerprint["comparable"] and not reasons:
        raise ValueError("An incomparable result must explain why")
    environments = payload["sourceEnvironments"]
    if len(environments) != 3 or len(fingerprint["sourceRunIds"]) != 3:
        raise ValueError("Missing source-run provenance")
    starts = [datetime.fromisoformat(e["start"]["timestampUtc"]) for e in environments]
    ends = [datetime.fromisoformat(e["end"]["timestampUtc"]) for e in environments]
    rows = []
    for scenario in registry["scenarios"]:
        name = scenario["name"]
        jit = measurement(payload["gsharp"].get(scenario["gsharp"]), 3, method["launches"])
        aot = measurement(payload["gsharp_aot"].get(scenario["gsharp"]), 3, method["launches"])
        go = measurement(payload["go"].get(scenario["go"]), 3, method["launches"]) if scenario["go"] else None
        if jit is None or aot is None or (scenario["go"] and go is None):
            raise ValueError(f"Missing expected measurement: {name}")
        rows.append({
            "name": name, "description": scenario["what"], "goScenario": scenario["go"],
            "jit": jit, "aot": aot, "go": go,
            "jitOverGo": jit["medianNs"] / go["medianNs"] if go and go["medianNs"] else None,
            "aotOverGo": aot["medianNs"] / go["medianNs"] if go and go["medianNs"] else None,
        })
    if not rows or len({r["name"] for r in rows}) != len(rows):
        raise ValueError("The scenario registry is empty or contains duplicate names")
    return {
        "schemaVersion": 1, "status": "available", "reason": None, "checkedAt": checked_at,
        "source": {
            "runId": run["id"], "runUrl": run["html_url"], "commit": run["head_sha"],
            "artifactId": artifact["id"], "artifactExpiresAt": artifact["expires_at"],
            "artifactSha256": hashlib.sha256(raw).hexdigest(),
            "compilerVersion": build["gscInformationalVersion"],
        },
        "measurement": {
            "startedAt": min(starts).isoformat(), "finishedAt": max(ends).isoformat(),
            "hardwareClass": method["host"]["hardwareClass"],
            "cpuModel": method["host"]["cpuModel"], "logicalCpuCount": method["host"]["logicalCpuCount"],
            "system": method["host"]["system"], "architecture": method["host"]["machine"],
            "kernel": method["host"]["release"], "toolchains": method["toolchains"],
            "wholeRuns": 3, "launchesPerRun": method["launches"],
            "intervalMethod": method["intervalMethod"], "launchOrder": method["launchOrder"],
            "jitMode": method["jitMode"], "jitEnvironment": method["jitEnvironment"],
            "comparable": fingerprint["comparable"], "warnings": reasons,
            "comparisonKey": payload["comparisonKey"], "aggregationKey": payload["aggregationKey"],
            "benchmarkDefinitionSha256": method["benchmarkDefinitionSha256"],
            "sourceRunIds": fingerprint["sourceRunIds"],
        },
        "scenarios": rows,
    }


def unavailable(reason, checked_at):
    print(f"Concurrency snapshot unavailable: {reason}")
    return {"schemaVersion": 1, "status": "unavailable", "reason": reason, "checkedAt": checked_at,
            "source": None, "measurement": None, "scenarios": []}


def fetch_snapshot(run_id=None):
    checked_at = datetime.now(timezone.utc).isoformat()
    if run_id is None:
        runs = gh(f"repos/{REPO}/actions/workflows/concurrency-bench.yml/runs?branch=main&status=success&per_page=1")["workflow_runs"]
        if not runs:
            return unavailable("No successful main-branch benchmark run was found.", checked_at)
        run = runs[0]
    else:
        run = gh(f"repos/{REPO}/actions/runs/{run_id}")
    artifacts = gh(f"repos/{REPO}/actions/runs/{run['id']}/artifacts")["artifacts"]
    candidates = [a for a in artifacts if a["name"] == "concurrency-bench" and not a["expired"]]
    if not candidates:
        return unavailable(f"Run {run['id']} has no unexpired concurrency-bench artifact.", checked_at)
    artifact = candidates[0]
    archive_bytes = gh(f"repos/{REPO}/actions/artifacts/{artifact['id']}/zip", binary=True)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        info = archive.getinfo("concurrency.json")
        if info.file_size > 10_000_000:
            raise ValueError("Unexpectedly large benchmark payload")
        raw = archive.read(info)
    registry_file = gh(f"repos/{REPO}/contents/bench/concurrency/scenarios.json?ref={run['head_sha']}")
    registry = json.loads(base64.b64decode(registry_file["content"]))
    return normalize(json.loads(raw), registry, run, artifact, raw, checked_at)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--output", type=Path, default=SITE / "static/data/concurrency-bench.json")
    args = parser.parse_args()
    snapshot = fetch_snapshot(args.run_id)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, indent=2, allow_nan=False) + "\n")
    print(f"Wrote {snapshot['status']} concurrency snapshot to {args.output}")


if __name__ == "__main__":
    main()
