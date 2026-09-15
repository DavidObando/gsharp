"""Build Trail with its published SDK and verify observable application behavior."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import zipfile

root = Path(__file__).resolve().parents[2]
release = json.loads((root / "website/src/data/release.json").read_text())
subprocess.run([sys.executable, str(root / "website/scripts/prepare-showcase.py")], check=True)

with tempfile.TemporaryDirectory(prefix="gsharp-trail-") as temporary:
    workspace = Path(temporary)
    project = workspace / "Trail"
    with zipfile.ZipFile(root / f'website/static/downloads/trail-{release["version"]}.zip') as archive:
        expected_files = ["Program.gs", "Trail.gsproj", "README.md"] + [
            path.relative_to(root / "samples/Trail").as_posix()
            for path in (root / "samples/Trail/demo").rglob("*") if path.is_file()
        ]
        assert sorted(archive.namelist()) == sorted("Trail/" + name for name in expected_files)
        for name in expected_files:
            assert archive.read("Trail/" + name) == (root / "samples/Trail" / name).read_bytes()
        archive.extractall(workspace)
    (workspace / "global.json").write_text(json.dumps({
        "sdk": {"version": "10.0.100", "rollForward": "latestFeature", "allowPrerelease": False}
    }))
    env = os.environ | {"DOTNET_CLI_HOME": str(workspace / "home"), "DOTNET_NOLOGO": "1",
                        "DOTNET_CLI_TELEMETRY_OPTOUT": "1"}
    build = subprocess.run(["dotnet", "build", str(project), "--nologo", "-v:q"],
                           cwd=workspace, env=env, capture_output=True, text=True, timeout=180)
    if build.returncode:
        raise RuntimeError(build.stdout + build.stderr)
    assembly = project / "bin/Debug/net10.0/Trail.dll"

    def run(*args, code=0):
        result = subprocess.run(["dotnet", str(assembly), *map(str, args)],
                                cwd=workspace, env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode == code, (args, result.returncode, result.stdout, result.stderr)
        return result

    def check(folder, extension=None):
        args = [folder] + ([extension] if extension else [])
        result = run(*args)
        assert not result.stderr, result.stderr
        report = json.loads(result.stdout)
        expected = []
        for path in sorted(folder.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            if extension and not path.name.lower().endswith(extension.lower()):
                continue
            contents = path.read_bytes()
            expected.append({"path": path.relative_to(folder).as_posix(), "bytes": len(contents),
                             "sha256": hashlib.sha256(contents).hexdigest(), "error": None})
        expected.sort(key=lambda entry: entry["path"])
        assert report == {"files": expected, "totalBytes": sum(e["bytes"] for e in expected), "failed": 0}, report
        return report

    check(project / "demo")
    expected_demo = json.loads((root / "website/src/data/trail-report.json").read_text())
    assert json.loads(run(project / "demo").stdout) == expected_demo
    check(project / "demo", ".TXT")
    empty = workspace / "empty"
    empty.mkdir()
    check(empty)
    many = workspace / "many"
    many.mkdir()
    for index in range(40):
        (many / f"{index:02}.txt").write_text(f"item {index}\n")
    check(many)
    assert "Usage:" in run("--help").stdout
    assert "Usage:" in run(code=2).stderr
    assert not run(workspace / "missing", code=2).stdout
    assert "extension" in run(project / "demo", "txt", code=2).stderr
    assert "extension" in run(project / "demo", ".txt/other", code=2).stderr
    if os.name != "nt":
        outside = workspace / "outside"
        outside.mkdir()
        (outside / "private.txt").write_text("not part of this report")
        (many / "linked-file.txt").symlink_to(outside / "private.txt")
        (many / "linked-folder").symlink_to(outside, target_is_directory=True)
        check(many)
        assert "symbolic link" in run(many / "linked-folder", code=2).stderr
        if os.geteuid() != 0:
            denied = many / "denied.txt"
            denied.write_text("unreadable")
            denied.chmod(0)
            try:
                report = json.loads(run(many, code=1).stdout)
                failures = [entry for entry in report["files"] if entry["error"]]
                assert report["failed"] == 1 and len(failures) == 1, report
                assert failures[0]["path"] == "denied.txt" and failures[0]["sha256"] is None
            finally:
                denied.chmod(0o600)
    print("Verified Trail: hashes, JSON schema, filtering, empty/bounded workloads, errors, and links.")
