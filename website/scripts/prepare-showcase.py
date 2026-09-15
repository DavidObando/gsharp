"""Package only reviewed Trail sources and derive the documented demo report."""
import hashlib
import json
from pathlib import Path
import zipfile

site = Path(__file__).resolve().parents[1]
project = site.parent / "samples/Trail"
release = json.loads((site / "src/data/release.json").read_text())
assert f'Gsharp.NET.Sdk/{release["version"]}' in (project / "Trail.gsproj").read_text()
sources = [project / name for name in ["Trail.gsproj", "Program.gs", "README.md"]]
sources += sorted((project / "demo").rglob("*"))
output = site / "static/downloads"
output.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output / f'trail-{release["version"]}.zip', "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for source in sources:
        if source.is_file():
            info = zipfile.ZipInfo("Trail/" + source.relative_to(project).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())

entries = []
for file in sorted((project / "demo").rglob("*")):
    if file.is_file():
        contents = file.read_bytes()
        entries.append({"path": file.relative_to(project / "demo").as_posix(),
                        "bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest(),
                        "error": None})
report = {"files": entries, "totalBytes": sum(entry["bytes"] for entry in entries), "failed": 0}
(site / "src/data/trail-report.json").write_text(json.dumps(report, indent=2) + "\n")
print("Prepared Trail download and demo report.")

patterns_root = site.parent / "samples/ConcurrencyPatterns"
patterns = json.loads((patterns_root / "patterns.json").read_text())
assert len(patterns) == 10 and len({p["id"] for p in patterns}) == 10
assert f'Gsharp.NET.Sdk/{release["version"]}' in (patterns_root / "gsharp/Patterns.gsproj").read_text()
pattern_files = [patterns_root / "README.md", patterns_root / "patterns.json",
                 patterns_root / "gsharp/Patterns.gsproj", patterns_root / "gsharp/Program.gs",
                 patterns_root / "go/go.mod", patterns_root / "go/main.go"]
for pattern in patterns:
    gs = patterns_root / "gsharp" / pattern["gsharpFile"]
    go = patterns_root / "go" / pattern["goFile"]
    pattern_files.extend([gs, go])
    pattern["gsharp"] = gs.read_text()
    pattern["go"] = go.read_text()
archive_name = f'concurrency-patterns-{release["version"]}.zip'
with zipfile.ZipFile(output / archive_name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for source in sorted(pattern_files):
        info = zipfile.ZipInfo("ConcurrencyPatterns/" + source.relative_to(patterns_root).as_posix(),
                              (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, source.read_bytes())
bundle = output / archive_name
comparison = {
    "sdkVersion": release["version"],
    "goVersion": (patterns_root / "go/go.mod").read_text().split("go ")[1].strip(),
    "download": "/downloads/" + archive_name,
    "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
    "patterns": patterns,
    "gsharpRunner": (patterns_root / "gsharp/Program.gs").read_text(),
    "goRunner": (patterns_root / "go/main.go").read_text(),
}
(site / "src/data/concurrency-examples.json").write_text(json.dumps(comparison, indent=2) + "\n")
print("Prepared ten-pattern comparison download and source.")
