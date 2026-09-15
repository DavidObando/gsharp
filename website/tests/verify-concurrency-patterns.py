"""Run all ten downloaded Go/G# pairs and check their shared contracts."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--race", action="store_true", help="Run Go with its race detector")
parser.add_argument("--repetitions", type=int, default=3)
args = parser.parse_args()
if args.repetitions < 1:
    parser.error("repetitions must be positive")
subprocess.run([sys.executable, str(root / "website/scripts/prepare-showcase.py")], check=True)
release = json.loads((root / "website/src/data/release.json").read_text())
bundle = root / f'website/static/downloads/concurrency-patterns-{release["version"]}.zip'
patterns = json.loads((root / "samples/ConcurrencyPatterns/patterns.json").read_text())
assert len(patterns) == 10 and len({p["id"] for p in patterns}) == 10


def admission_before_spawn(source, language):
    body = source.split("func boundedExample()", 1)[1]
    acquisition = (r"await\s+permits\.WaitAsync\(\)" if language == "gsharp"
                   else r"permits\s*<-\s*struct\s*\{\s*\}\s*\{\s*\}")
    launch = r"go\s+limitedWork\(" if language == "gsharp" else r"workers\.Go\("
    return re.search(r"for\s+id\b[^{]*\{\s*" + acquisition + r"\s+" + launch, body) is not None


with tempfile.TemporaryDirectory(prefix="gsharp-patterns-") as temporary:
    workspace = Path(temporary)
    with zipfile.ZipFile(bundle) as archive:
        names = {"ConcurrencyPatterns/README.md", "ConcurrencyPatterns/patterns.json",
                 "ConcurrencyPatterns/gsharp/Patterns.gsproj", "ConcurrencyPatterns/gsharp/Program.gs",
                 "ConcurrencyPatterns/go/go.mod", "ConcurrencyPatterns/go/main.go"}
        for pattern in patterns:
            names.add("ConcurrencyPatterns/gsharp/" + pattern["gsharpFile"])
            names.add("ConcurrencyPatterns/go/" + pattern["goFile"])
        assert set(archive.namelist()) == names
        for name in names:
            relative = Path(name).relative_to("ConcurrencyPatterns")
            assert archive.read(name) == (root / "samples/ConcurrencyPatterns" / relative).read_bytes()
        archive.extractall(workspace)
    (workspace / "global.json").write_text(json.dumps({
        "sdk": {"version": "10.0.100", "rollForward": "latestFeature", "allowPrerelease": False}
    }))
    env = os.environ | {"DOTNET_CLI_HOME": str(workspace / "home"), "DOTNET_NOLOGO": "1",
                        "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "GOTOOLCHAIN": "local"}

    def command(argv, cwd=workspace, expected=0, timeout=120):
        result = subprocess.run(list(map(str, argv)), cwd=cwd, env=env, capture_output=True,
                                text=True, timeout=timeout)
        if (expected is None and result.returncode == 0) or (expected is not None and result.returncode != expected):
            raise RuntimeError(f"{argv}\nexit={result.returncode}\n{result.stdout}\n{result.stderr}")
        return result

    project = workspace / "ConcurrencyPatterns"
    # This is a structural ordering check; peak-active assertions alone cannot establish admission-before-spawn.
    gs_bounded = (project / "gsharp/Bounded.gs").read_text()
    go_bounded = (project / "go/bounded.go").read_text()
    assert admission_before_spawn(gs_bounded, "gsharp")
    assert admission_before_spawn(go_bounded, "go")
    late_gs = gs_bounded.replace("await permits.WaitAsync()", "", 1).replace(
        "    try {", "    await permits.WaitAsync()\n    try {", 1)
    late_go = go_bounded.replace("permits <- struct{}{}", "", 1).replace(
        "defer func() { <-permits }()", "permits <- struct{}{}\n\t\t\tdefer func() { <-permits }()", 1)
    assert not admission_before_spawn(late_gs, "gsharp"), "acquire-inside-worker mutation escaped"
    assert not admission_before_spawn(late_go, "go"), "acquire-inside-worker mutation escaped"
    command(["dotnet", "build", project / "gsharp", "--nologo", "-v:q"])
    go_binary = workspace / ("patterns-go.exe" if os.name == "nt" else "patterns-go")
    command(["go", "build", *(["-race"] if args.race else []), "-o", go_binary, "."], cwd=project / "go")
    dll = project / "gsharp/bin/Debug/net10.0/Patterns.dll"
    rows = []
    for pattern in patterns:
        for repeat in range(args.repetitions):
            gs = command(["dotnet", dll, pattern["id"]], timeout=20)
            go = command([go_binary, pattern["id"]], timeout=20)
            expected = pattern["output"] + "\n"
            assert gs.stdout == expected and go.stdout == expected, (pattern["id"], gs.stdout, go.stdout)
            assert not gs.stderr and not go.stderr, (pattern["id"], gs.stderr, go.stderr)
        rows.append({"id": pattern["id"], "repetitions": args.repetitions, "passed": True})
        print("Verified", pattern["id"], flush=True)
    command(["dotnet", dll, "not-a-pattern"], expected=2)
    command([go_binary, "not-a-pattern"], expected=2)

    for filename, pattern_id, original_message, assertion_message in [
        ("RateLimit.gs", "rate-limit", "clock moved backwards", "backwards clock"),
        ("TtlCache.gs", "ttl-cache", "TTL overflow", "expiry overflow"),
    ]:
        source = project / "gsharp" / filename
        original = source.read_text()
        assert original.count(f'"{original_message}"') == 2, filename
        try:
            source.write_text(original.replace(f'"{original_message}"', '"unrelated failure"', 1))
            command(["dotnet", "build", project / "gsharp", "--nologo", "-v:q"])
            failure = command(["dotnet", dll, pattern_id], expected=None, timeout=20)
            assert assertion_message in failure.stderr + failure.stdout, failure.stderr
        finally:
            source.write_text(original)
    command(["dotnet", "build", project / "gsharp", "--nologo", "-v:q"])

    negative = workspace / "negative"
    negative.mkdir()
    (negative / "Negative.gsproj").write_text(
        f'<Project Sdk="Gsharp.NET.Sdk/{release["version"]}"><PropertyGroup>'
        '<OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>'
        '</PropertyGroup></Project>')
    (negative / "Program.gs").write_text("package Negative\nlet reader in chan[int32] = chan[int32](1)\nreader <- 1\n")
    bad = command(["dotnet", "build", negative, "--nologo", "-v:q"], expected=1)
    assert "GS0549" in bad.stdout + bad.stderr, bad.stdout
    bad_go = negative / "negative.go"
    bad_go.write_text("package main\nfunc main() { var reader <-chan int = make(chan int, 1); reader <- 1 }\n")
    bad = command(["go", "build", "-o", negative / "bad", bad_go], expected=1)
    assert "receive-only" in bad.stderr, bad.stderr
    report = {
        "schemaVersion": 1, "checkedAt": datetime.now(timezone.utc).isoformat(),
        "sdkVersion": release["version"], "dotnetSdk": command(["dotnet", "--version"]).stdout.strip(),
        "goVersion": command(["go", "version"]).stdout.strip(),
        "goRaceDetector": args.race, "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
        "patterns": rows, "receiveOnlyRejection": {"gsharp": "GS0549", "go": "receive-only"},
        "reviewRegressions": {
            "admissionBeforeSpawn": "source-order check with acquire-inside-worker mutations rejected",
            "specificErrors": ["rate-limit", "ttl-cache"],
        },
    }
    (root / "website/static/data/concurrency-checks.json").write_text(json.dumps(report, indent=2) + "\n")
print("Verified ten Go/G# pairs and receive-only compile-time rejection.")
