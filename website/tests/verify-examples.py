"""Verify the public installation and website fixtures with the advertised SDK."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


root = Path(__file__).resolve().parents[2]
release = json.loads((root / "website/src/data/release.json").read_text())

with tempfile.TemporaryDirectory(prefix="gsharp-website-") as temporary:
    workspace = Path(temporary)
    project = workspace / "app"
    hive = workspace / "templates"
    (workspace / "global.json").write_text(json.dumps({
        "sdk": {"version": "10.0.100", "rollForward": "latestFeature", "allowPrerelease": False}
    }))
    env = os.environ | {
        "DOTNET_CLI_HOME": str(workspace / "home"),
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "DOTNET_NOLOGO": "1",
    }

    def dotnet(*args, expected=0):
        result = subprocess.run(
            ["dotnet", *map(str, args)],
            cwd=workspace,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode != expected:
            raise RuntimeError(f"dotnet {' '.join(map(str, args))}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    dotnet("new", "install", f"Gsharp.Templates::{release['version']}", "--debug:custom-hive", hive)
    dotnet("new", "gsharp-console", "-n", "WebsiteSmoke", "-o", project, "--debug:custom-hive", hive)

    def build_and_run():
        dotnet("build", project, "--nologo", "--verbosity", "quiet")
        return dotnet(project / "bin/Debug/net10.0/WebsiteSmoke.dll")

    output = build_and_run()
    assert output == "Hello from GSharp!\n", repr(output)
    print(f"Verified public template {release['version']}", flush=True)
    sources = sorted((root / "samples").glob("Website*.gs"))
    assert sources, "No website examples were discovered"
    for source in sources:
        shutil.copyfile(source, project / "Program.gs")
        output = build_and_run()
        expected = source.with_suffix(".golden").read_text()
        assert output == expected, f"{source.name}: expected {expected!r}, got {output!r}"
        print(f"Verified {source.name}", flush=True)

    for expected, program in [
        ("GS0168", "fallthrough"),
        ("GS0168", 'switch 1 { case 1 { fallthrough\n Console.WriteLine("late") } default { } }'),
        ("GS0168", "switch 1 { case 1 { if true { fallthrough } } default { } }"),
        ("GS0533", "switch 1 { case 1 { fallthrough } }"),
        ("GS0534", 'let value object = 1\nswitch value { case 1 { fallthrough } case string text { Console.WriteLine(text) } default { } }'),
        ("GS0534", "switch 1 { case 1 { fallthrough } case 2 when true { } default { } }"),
    ]:
        (project / "Program.gs").write_text("package Negative\nimport System\n" + program + "\n")
        output = dotnet("build", project, "--nologo", "--verbosity", "quiet", expected=1)
        assert expected in output, (expected, output)
    print("Verified fallthrough placement, final-arm, binding-target, and guard-target diagnostics.", flush=True)
