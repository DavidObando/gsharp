#!/usr/bin/env python3
"""Self-migration cut-over mechanics (issue #3501, Phase 3).

`cutover.py dry-run` rehearses the cut-over from a FRESH clone, against nuget.org
only (no local out/bin nupkg, no pre-built tool): it installs the published
cs2gs/gsfmt, translates the repository, assembles the "delete .cs / add .gs"
tree, applies the hand-fix list, then formats, builds, runs e2etests and
checks the extension packaging. Every stage records its outcome in
`<work-root>/dry-run.json`; a failing stage does not stop the later ones
(unless --stop-on-failure) because the point of a dry run is to find ALL the
blockers early.

`cutover.py hand-fix --tree DIR` applies only the hand-fix list to a tree, so
the real cut-over PR and the dry run run the same code.

See docs/self-migration-cutover.md for the procedure, mapping rules, rollback
and the commit-message template. The transforms below are pure functions over
file text and are covered by build/test-cutover.py.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SDK_ID = "Gsharp.NET.Sdk"
CS2GS_ID = "Gsharp.Cs2Gs"
GSFMT_ID = "Gsharp.Gsfmt"
TESTING_ID = "GSharp.CodeAnalysis.Analyzers.Testing"
FLAT = "https://api.nuget.org/v3-flatcontainer"
CLONE_URL = "https://github.com/DavidObando/gsharp.git"
STAGES = ("clone", "tools", "prepare", "translate", "assemble", "hand-fix", "gsfmt",
          "core-smoke", "build", "e2e", "vsix")
# The Visual Studio extension stays C# by owner decision (it builds only under the
# Windows VSSDK toolchain), so the migrated repository is mixed.
ALWAYS_KEEP_CSHARP = ("src/vs-gsharp",)
SDK_PROJECT = "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj"
EXTENSIONS_PROJECT = "src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj"
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
WORK_ROOT_MARKER = ".cutover-work-root"
LOCK_REGEN = ["dotnet", "restore", "GSharp.slnx", "--force-evaluate"]
NUGET_ORG_CONFIG = ('<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear />'
                    '<add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>\n')
SKIP_DIRS = {".git", "bin", "obj", "node_modules", "TestResults"}


class CutoverError(Exception):
    """A precondition failure; always reported, never swallowed."""


# ---------------------------------------------------------------- pure transforms

def enable_generate_package_on_build(text: str) -> tuple[str, bool]:
    """The mirror forces GeneratePackageOnBuild=false; the SDK project must pack on build."""
    new, n = re.subn(r"(<GeneratePackageOnBuild>)\s*false\s*(</GeneratePackageOnBuild>)",
                     r"\1true\2", text, flags=re.IGNORECASE)
    return new, n > 0


def rewrite_dangling_csproj_refs(text: str, exists) -> tuple[str, list[str]]:
    """Rewrites `X.csproj` path literals to `X.gsproj` when only the latter exists.

    `exists(literal)` receives the literal as written (MSBuild properties and
    separators included) and returns (csproj_exists, gsproj_exists); the caller
    resolves it against the file's directory. Literals whose .csproj still exists
    (Gsharp.Extensions, the Visual Studio projects) are left alone.
    """
    changed: list[str] = []

    def sub(match: re.Match) -> str:
        literal = match.group(0)
        has_cs, has_gs = exists(literal)
        if has_gs and not has_cs:
            changed.append(literal)
            return literal[: -len(".csproj")] + ".gsproj"
        return literal

    new = re.sub(r"[\w$()./\\-]+?\.csproj", sub, text)
    return new, changed


def rewrite_by_basename(text: str, gsproj_only: set[str]) -> tuple[str, list[str]]:
    """Rewrites `<name>.csproj` to `<name>.gsproj` for names only a .gsproj provides in the tree.

    Used on build scripts and workflows, where the literal is a bare file name or a repo-relative
    path rather than something to resolve against the file's own directory.
    """
    changed: list[str] = []

    def sub(match: re.Match) -> str:
        name = match.group(1)
        if name in gsproj_only:
            changed.append(name)
            return name + ".gsproj"
        return match.group(0)

    return re.sub(r"(?<![\w.-])([\w.-]+)\.csproj\b", sub, text), changed


INFRA_DIRS = ("e2etests", ".github/workflows", "build", "src/vscode-gsharp", "website/scripts")
INFRA_SUFFIXES = (".sh", ".py", ".yml", ".yaml", ".js", ".ps1")


def rewrite_sln_literal(text: str) -> tuple[str, int]:
    """`GSharp.sln` -> `GSharp.slnx`: the repository root is anchored by this file name all over the sources."""
    return re.subn(r"(?<![\w.])GSharp\.sln\b", "GSharp.slnx", text)


SLN_LITERAL_SUFFIXES = (".gs", ".sh", ".py", ".yml", ".yaml", ".js", ".ts", ".ps1", ".targets", ".props")
SLN_LITERAL_SKIP = ("docs/", "website/", "node_modules/", "build/test-cutover.py", ".git/")


def unpin_sdk(text: str, version: str) -> tuple[str, bool]:
    """`<Project Sdk="Gsharp.NET.Sdk/<version>">` -> `Sdk="Gsharp.NET.Sdk"` (pin lives in global.json)."""
    pattern = re.compile(r'(<Project\b[^>]*?\bSdk=")' + re.escape(SDK_ID) + "/" + re.escape(version) + '(")',
                         re.DOTALL)
    new, n = pattern.subn(r"\1" + SDK_ID + r"\2", text)
    return new, n > 0


def project_sdk_attr(text: str) -> str | None:
    m = re.search(r'<Project\b[^>]*?\bSdk="([^"]*)"', text, re.DOTALL)
    return m.group(1) if m else None


def set_msbuild_sdk_pin(global_json: str | None, version: str) -> str:
    data = json.loads(global_json) if global_json and global_json.strip() else {}
    sdks = data.setdefault("msbuild-sdks", {})
    sdks[SDK_ID] = version
    return json.dumps(data, indent=2) + "\n"


def strip_csharp_only_props(text: str) -> tuple[str, list[str]]:
    """Removes C#-only compiler properties from a G# project file."""
    removed: list[str] = []

    def drop(match: re.Match) -> str:
        removed.append(match.group(1))
        return ""

    # A whole line holding only the element goes with its newline; an inline one leaves the rest.
    new = re.sub(r"^[ \t]*<(LangVersion|StyleCopRuleset|CodeAnalysisRuleSet)>[^<]*</\1>[ \t]*\r?\n?", drop,
                 text, flags=re.MULTILINE)
    new = re.sub(r"<(LangVersion)>[^<]*</\1>", drop, new)
    new = re.sub(r'^[ \t]*<PackageReference\s+Include="StyleCop\.Analyzers"[^>]*?(/>|>.*?</PackageReference>)[ \t]*\r?\n?',
                 lambda m: (removed.append("StyleCop.Analyzers") or ""), new, flags=re.MULTILINE | re.DOTALL)
    return new, removed


def solution_projects(text: str) -> list[str]:
    """Project paths of a .sln (Project(...) = "n", "path", ...) or a .slnx (<Project Path=.../>)."""
    paths = re.findall(r'<Project\s+Path="([^"]+)"', text)
    paths += re.findall(r'^Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+)"', text, flags=re.MULTILINE)
    # `.sln` solution folders are `Project(...)` entries too, with the folder name as their path.
    return [p.replace("\\", "/") for p in paths if p.lower().endswith((".csproj", ".gsproj", ".vbproj", ".fsproj"))]


def missing_from_slnx(original_projects, slnx_projects, tree_exists) -> list[str]:
    """Projects of the original .sln that the generated .slnx lacks (after .csproj->.gsproj mapping)."""
    listed = set(slnx_projects)
    missing = []
    for path in original_projects:
        mapped = path
        if path.endswith(".csproj") and not tree_exists(path) and tree_exists(path[:-7] + ".gsproj"):
            mapped = path[:-7] + ".gsproj"
        if mapped not in listed:
            missing.append(path)
    return missing


def parse_project_filters(selfmig_common_text: str) -> list[str]:
    """The --exclude/--passthrough list of build/selfmig-common.sh, as migrate arguments."""
    args: list[str] = []
    for line in selfmig_common_text.splitlines():
        m = re.match(r"^\s*(--exclude|--passthrough)\s+(\S+)\s*$", line)
        if m:
            args += [m.group(1), m.group(2)]
    return args


def keep_csharp_prefixes(filters: list[str]) -> list[str]:
    prefixes = list(ALWAYS_KEEP_CSHARP)
    for i in range(0, len(filters), 2):
        value = filters[i + 1].rstrip("/")
        if value.endswith((".csproj", ".gsproj")):
            value = value.rsplit("/", 1)[0] if "/" in value else ""
        if value:
            prefixes.append(value)
    return prefixes


def under(path: str, prefixes) -> bool:
    return any(path == p or path.startswith(p + "/") for p in prefixes)


def commit_message(final_sha: str, tag: str, cs2gs_version: str, sdk_version: str,
                   deleted: int, added: int) -> str:
    return (
        "Migrate the compiler to G#\n\n"
        f"Final C# tree: {final_sha} (tag {tag}).\n"
        f"Translated with Gsharp.Cs2Gs {cs2gs_version} against Gsharp.NET.Sdk {sdk_version}\n"
        "(build/cutover.py dry-run; procedure in docs/self-migration-cutover.md).\n\n"
        f"Shape: delete {deleted} C# files, add {added} files. Rename detection does not pair\n"
        "them; use the tag to read the C# history. The C# line stays buildable on the\n"
        "cs2gs/csharp-0.4 branch.\n")


def latest_common_version(sdk_versions, other_versions) -> str:
    def key(v): return tuple(int(x) for x in v.split("."))
    common = [v for v in sdk_versions if VERSION_RE.match(v) and v in set(other_versions)]
    if not common:
        raise CutoverError("no version is published for both the SDK and the requested tool")
    return max(common, key=key)


# ---------------------------------------------------------------- tree-level hand-fixes

def iter_files(root: Path, suffixes):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(tuple(suffixes)):
                yield Path(dirpath) / name


def read(path: Path) -> tuple[str, bool]:
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    return raw.decode("utf-8-sig"), bom


def write(path: Path, text: str, bom: bool) -> None:
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))


def packable_gsprojs(csproj_texts: dict[str, str]) -> list[str]:
    """`.gsproj` paths of the C# projects that set GeneratePackageOnBuild=true (input: {csproj path: text})."""
    return sorted(rel[:-len(".csproj")] + ".gsproj" for rel, text in csproj_texts.items()
                  if re.search(r"<GeneratePackageOnBuild>\s*true\s*</GeneratePackageOnBuild>", text, re.IGNORECASE))


def apply_hand_fixes(tree: Path, sdk_version: str, original_sln: str | None, log,
                     keep: tuple[str, ...] = ALWAYS_KEEP_CSHARP, packable: tuple[str, ...] = ()) -> list[str]:
    """Applies the audited hand-fix list; returns the list of problems that need a human."""
    problems: list[str] = []

    # 1. GeneratePackageOnBuild: the mirror forces it to false everywhere; every project that packed on
    #    build in C# (SDK, Templates, Repl, Cs2Gs.Cli, Gsfmt.Cli, Analyzers.Testing today) must again.
    for rel in sorted(set(packable) | {SDK_PROJECT}):
        proj = tree / rel
        if not proj.is_file():
            problems.append(f"{rel} not found")
            continue
        text, bom = read(proj)
        new_text, hit = enable_generate_package_on_build(text)
        if hit:
            write(proj, new_text, bom)
            log(f"hand-fix 1: {rel}: GeneratePackageOnBuild re-enabled")
        elif "<GeneratePackageOnBuild>true" not in text:
            problems.append(f"{rel} has no GeneratePackageOnBuild property")

    # 2. dangling .csproj literals (Pack* targets, VsGsharp LanguageServer path, ...)
    for path in iter_files(tree, (".gsproj", ".csproj", ".props", ".targets")):
        text, bom = read(path)

        def exists(literal, base=path.parent):
            if "$(" in literal:
                literal = re.sub(r"\$\(MSBuildThisFileDirectory\)", "", literal)
                literal = re.sub(r"\$\(MSBuildProjectDirectory\)[/\\]?", "", literal)
            if "$(" in literal:
                return (True, False)  # an unresolved property: never rewrite blindly
            rel = literal.replace("\\", "/")
            cs = (base / rel)
            return (cs.is_file(), cs.with_suffix(".gsproj").is_file())

        new, changed = rewrite_dangling_csproj_refs(text, exists)
        if changed:
            write(path, new, bom)
            log(f"hand-fix 2: {path.relative_to(tree)}: {len(changed)} .csproj literal(s) -> .gsproj")

    # 2b. build scripts, workflows and e2etests that name translated projects by file name
    #     (not in the plan's list; found by the first dry run). Test-name fixtures such as App.csproj
    #     have no .gsproj twin in the tree, so they are untouched.
    csproj_names = {p.stem for p in iter_files(tree, (".csproj",))}
    gsproj_only = {p.stem for p in iter_files(tree, (".gsproj",))} - csproj_names
    for top in INFRA_DIRS:
        base = tree / top
        if not base.is_dir():
            continue
        for path in iter_files(base, INFRA_SUFFIXES):
            rel = path.relative_to(tree).as_posix()
            if rel == "build/test-cutover.py" or "/test/" in rel or "/node_modules/" in rel:
                continue
            text, bom = read(path)
            new, changed = rewrite_by_basename(text, gsproj_only)
            if changed:
                write(path, new, bom)
                log(f"hand-fix 2b: {rel}: {len(changed)} project file name(s) .csproj -> .gsproj")

    # 3. Gsharp.Extensions rebound to the pinned SDK (the mirror does it; verify)
    ext = tree / EXTENSIONS_PROJECT
    if ext.is_file():
        text, _ = read(ext)
        if "Gsharp.NET.Sdk.Bootstrap" in text:
            problems.append(f"{EXTENSIONS_PROJECT} still imports the Bootstrap SDK")
        if re.search(r'<ProjectReference[^>]*(Compiler|Gsharp\.NET\.Sdk)\.(cs|gs)proj', text):
            problems.append(f"{EXTENSIONS_PROJECT} still has Compiler/SDK ordering ProjectReferences")
    else:
        problems.append(f"{EXTENSIONS_PROJECT} missing from the tree")

    # 4. solution: .slnx replaces .sln
    sln, slnx = tree / "GSharp.sln", tree / "GSharp.slnx"
    if not slnx.is_file():
        problems.append("GSharp.slnx was not generated")
    else:
        if sln.is_file():
            sln.unlink()
            log("hand-fix 4: GSharp.sln removed")
        if original_sln is not None:
            slnx_projects = solution_projects(slnx.read_text(encoding="utf-8-sig"))
            gone = missing_from_slnx(solution_projects(original_sln), slnx_projects,
                                     lambda rel: (tree / rel).is_file())
            for p in gone:
                problems.append(f"GSharp.slnx does not list {p}")
            for rel in slnx_projects:
                if not (tree / rel).is_file():
                    problems.append(f"GSharp.slnx lists a missing project {rel}")

    # 4b. the repository root is found by probing for GSharp.sln (cs2gs, Sdk.Tests RepoRoot, ~100 test files,
    #     the e2e scripts, build.yml). Found by the first dry run: with the .sln gone every one of them fails.
    rewritten = 0
    for path in iter_files(tree, SLN_LITERAL_SUFFIXES):
        rel = path.relative_to(tree).as_posix()
        if rel.startswith(SLN_LITERAL_SKIP[:4]) or rel in SLN_LITERAL_SKIP:
            continue
        text, bom = read(path)
        new, n = rewrite_sln_literal(text)
        if n:
            write(path, new, bom)
            rewritten += 1
    log(f"hand-fix 4b: GSharp.sln -> GSharp.slnx in {rewritten} file(s)")

    # 5. .gitattributes
    ga = tree / ".gitattributes"
    if not ga.is_file():
        ga.write_text("*.gs linguist-language=C#\n", encoding="utf-8")
        log("hand-fix 5: .gitattributes added")
    elif "*.gs" not in ga.read_text(encoding="utf-8"):
        with ga.open("a", encoding="utf-8") as f:
            f.write("*.gs linguist-language=C#\n")
        log("hand-fix 5: .gitattributes gained the *.gs rule")

    # 6. per-file SDK pins -> global.json msbuild-sdks
    unpinned = 0
    for path in iter_files(tree, (".gsproj", ".csproj")):
        text, bom = read(path)
        new, hit = unpin_sdk(text, sdk_version)
        if hit:
            write(path, new, bom)
            unpinned += 1
    gj = tree / "global.json"
    existing = gj.read_text(encoding="utf-8-sig") if gj.is_file() else None
    gj.write_text(set_msbuild_sdk_pin(existing, sdk_version), encoding="utf-8")
    log(f"hand-fix 6: {unpinned} project pin(s) removed; global.json msbuild-sdks {SDK_ID}={sdk_version}")
    for path in iter_files(tree, (".gsproj",)):
        sdk = project_sdk_attr(read(path)[0])
        rel = path.relative_to(tree).as_posix()
        if (sdk and sdk.startswith(SDK_ID + "/") and not under(rel, keep)
                and not rel.startswith(("samples/", "src/Sdk/Gsharp.Templates/"))):
            problems.append(f"{rel} keeps a versioned pin '{sdk}' that overrides global.json")

    # 7. C#-only properties
    for path in iter_files(tree, (".gsproj",)):
        text, bom = read(path)
        new, removed = strip_csharp_only_props(text)
        if removed:
            write(path, new, bom)
            log(f"hand-fix 7: {path.relative_to(tree)}: removed {', '.join(removed)}")
    return problems


# ---------------------------------------------------------------- dry run

class Run:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.work_root).expanduser().resolve()
        if str(self.root).startswith("/tmp") or str(self.root) == "/":
            raise CutoverError("the work root must not be under /tmp (shared tmpfs); use ~/.cache/<tag>/")
        # The stages delete and recreate src/, tools/, migrated/ and runs/ below the root, so the root must
        # be a directory of its own: never this checkout (or one containing it), never a repository.
        checkout = Path(__file__).resolve().parent.parent
        if self.root == checkout or self.root in checkout.parents or checkout in self.root.parents:
            raise CutoverError(f"the work root {self.root} overlaps the checkout {checkout}")
        marker = self.root / WORK_ROOT_MARKER
        if (self.root / ".git").exists():
            raise CutoverError(f"the work root {self.root} is a repository")
        if self.root.exists() and any(self.root.iterdir()) and not marker.is_file():
            raise CutoverError(f"the work root {self.root} is not empty and was not created by cutover.py")
        self.root.mkdir(parents=True, exist_ok=True)
        marker.write_text("created by build/cutover.py; safe to delete\n")
        self.src = self.root / "src"
        self.tools = self.root / "tools"
        self.pkgs = self.root / "packages"
        self.migrated = self.root / "migrated"
        self.runs = self.root / "runs"
        self.logs = self.root / "logs"
        self.logs.mkdir(exist_ok=True)
        self.record_path = self.root / "dry-run.json"
        self.record = json.loads(self.record_path.read_text()) if self.record_path.is_file() else {
            "stages": {}, "facts": {}}
        self.env = dict(os.environ)
        self.env.update({
            # A private package cache and CLI home: nothing from the host can satisfy a restore.
            "NUGET_PACKAGES": str(self.root / "nuget-packages"),
            "DOTNET_CLI_HOME": str(self.root / "dotnet-home"),
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
            "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1", "MSBUILDDISABLENODEREUSE": "1",
            "TMPDIR": str(self.root / "tmp"),
        })
        (self.root / "tmp").mkdir(exist_ok=True)

    def say(self, message: str) -> None:
        print(f"[cutover] {message}", flush=True)

    def sh(self, name: str, cmd, cwd=None, env_extra=None, check=True) -> int:
        log = self.logs / f"{name}.log"
        env = dict(self.env)
        env.update(env_extra or {})
        self.say(f"$ {' '.join(str(c) for c in cmd)}  (log: {log})")
        with log.open("ab") as out:
            out.write(f"\n$ {' '.join(str(c) for c in cmd)}\n".encode())
            rc = subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, stdout=out,
                                stderr=subprocess.STDOUT).returncode
        if check and rc != 0:
            raise CutoverError(f"{' '.join(str(c) for c in cmd[:3])} exited {rc}; see {log}")
        return rc

    def save(self) -> None:
        self.record_path.write_text(json.dumps(self.record, indent=2) + "\n")

    def stage(self, name: str, fn) -> None:
        selected = STAGES[STAGES.index(self.args.from_stage):]
        if name not in selected or (self.args.only and name not in self.args.only):
            self.record["stages"].setdefault(name, {"status": "not-run"})
            return
        if name in self.args.skip:
            self.record["stages"][name] = {"status": "skipped", "detail": "--skip"}
            self.save()
            return
        self.say(f"=== stage {name} ===")
        started = time.time()
        try:
            status, detail = fn()
        except CutoverError as e:
            status, detail = "failed", str(e)
        except Exception as e:  # a crash in the script is also a finding, never a silent pass
            status, detail = "failed", f"{type(e).__name__}: {e}"
        self.record["stages"][name] = {"status": status, "detail": detail,
                                       "seconds": round(time.time() - started)}
        self.save()
        self.say(f"stage {name}: {status}  {detail}")
        if status == "failed" and self.args.stop_on_failure:
            raise SystemExit(1)

    # ---- stages
    def s_clone(self):
        if self.src.exists():
            shutil.rmtree(self.src)
        self.sh("clone", ["git", "clone", "--quiet", self.args.repo_url, self.src])
        self.sh("clone", ["git", "checkout", "--quiet", self.args.commit], cwd=self.src)
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.src, text=True).strip()
        self.record["facts"]["csharp_commit"] = sha
        leftovers = [p for p in (self.src / ".nugs").glob("*.nupkg")] + list((self.src / "out").glob("bin/**/*.nupkg"))
        if leftovers:
            raise CutoverError(f"fresh clone unexpectedly holds nupkgs: {leftovers}")
        return "passed", f"cloned {sha}"

    def versions(self, package: str) -> list[str]:
        with urllib.request.urlopen(f"{FLAT}/{package.lower()}/index.json", timeout=60) as r:
            return json.load(r)["versions"]

    def download(self, package: str, version: str, dest: Path) -> Path:
        url = f"{FLAT}/{package.lower()}/{version}/{package.lower()}.{version}.nupkg"
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=300) as r, dest.open("wb") as f:
            shutil.copyfileobj(r, f)
        return dest

    def s_tools(self):
        pin = self.args.pin
        if pin == "latest":
            pin = latest_common_version(self.versions(SDK_ID), self.versions(CS2GS_ID))
        if not VERSION_RE.match(pin):
            raise CutoverError(f"--pin must be a published x.y.z version, got '{pin}'")
        cs2gs_version = self.args.cs2gs_version or pin
        self.record["facts"].update({"sdk_pin": pin, "cs2gs_version": cs2gs_version})
        if self.tools.exists():
            shutil.rmtree(self.tools)
        # A config of our own (<clear/> + nuget.org): no feed from the caller's checkout or user config can
        # satisfy these installs, so the rehearsal is nuget.org-only.
        config = self.root / "nuget.config"
        config.write_text(NUGET_ORG_CONFIG)
        for package, version in ((CS2GS_ID, cs2gs_version), (GSFMT_ID, pin)):
            self.sh("tools", ["dotnet", "tool", "install", package, "--version", version, "--tool-path",
                              self.tools, "--configfile", config], cwd=self.root)
        nupkg = self.download(SDK_ID, pin, self.pkgs / f"{SDK_ID}.{pin}.nupkg")
        self.download(TESTING_ID, pin, self.pkgs / f"{TESTING_ID}.{pin}.nupkg")
        shutil.rmtree(self.pkgs / "sdk", ignore_errors=True)
        with zipfile.ZipFile(nupkg) as z:
            z.extractall(self.pkgs / "sdk")
        for rel in ("tools/compiler/gsc.dll", "tools/gsgen/gsgen.dll"):
            if not (self.pkgs / "sdk" / rel).is_file():
                raise CutoverError(f"{nupkg.name} has no {rel}")
        help_text = subprocess.run([str(self.tools / "cs2gs"), "migrate", "--help"], env=self.env, text=True,
                                   capture_output=True).stdout
        capable = "--sdk-pin" in help_text and "--sdk-version" in help_text
        self.record["facts"]["cs2gs_has_sdk_pin_flags"] = capable
        detail = f"cs2gs {cs2gs_version}, gsfmt {pin}, SDK {pin}; --sdk-pin/--sdk-version " + (
            "supported" if capable else "NOT supported by this cs2gs (per-project pins; staged-nupkg fallback)")
        return "passed", detail

    def s_prepare(self):
        # Mirrors build/selfmig-common.sh selfmig_build_prerequisites plus the restore CI performs first.
        self.sh("prepare", ["dotnet", "restore", "GSharp.sln", "--locked-mode"], cwd=self.src)
        self.sh("prepare", ["dotnet", "build", "src/Compiler/Compiler.csproj", "-c", "Debug", "-graph"], cwd=self.src)
        self.sh("prepare", ["dotnet", "build", "src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj", "-c", "Debug",
                            "-graph"], cwd=self.src)
        self.sh("prepare", ["dotnet", "build", "src/Analyzers/GSharp.CodeAnalysis.Analyzers.Testing/"
                            "GSharp.CodeAnalysis.Analyzers.Testing.csproj", "-c", "Release", "-graph"], cwd=self.src)
        pin = self.stage_pinned_sdk()
        return "passed", f"restored, built prerequisites, staged published {SDK_ID} {pin}"

    def stage_pinned_sdk(self) -> str:
        """Only the PUBLISHED SDK may be a local candidate for the pin: drop what a source build produced.

        Called again after capture-test-oracle, whose Release build of the C# solution packs a fresh
        `Gsharp.NET.Sdk.<version>-g<sha>` that an older cs2gs (no --sdk-version) would otherwise pick as
        the newest local nupkg. The first dry run did exactly that and pinned the whole tree to 0.4.1253-g...
        """
        pin = self.record["facts"]["sdk_pin"]
        feed = self.src / "out" / "bin" / "Release" / "nupkgs"
        feed.mkdir(parents=True, exist_ok=True)
        # The analyzer-test verifier package is resolved the same way (newest local nupkg), so it is pinned too.
        for package in (SDK_ID, TESTING_ID):
            for nupkg in list(self.src.glob(f"out/bin/*/nupkgs/{package}.*.*pkg")) + list(
                    (self.src / ".nugs").glob(f"{package}.*.*pkg")):
                if nupkg.name != f"{package}.{pin}.nupkg":
                    nupkg.unlink()
            shutil.copy2(self.pkgs / f"{package}.{pin}.nupkg", feed / f"{package}.{pin}.nupkg")
        return pin

    def s_translate(self):
        facts = self.record["facts"]
        filters = parse_project_filters((self.src / "build" / "selfmig-common.sh").read_text())
        facts["filters"] = filters
        if not filters:
            raise CutoverError("no --exclude filters parsed from build/selfmig-common.sh")
        sdk = self.pkgs / "sdk" / "tools"
        env = {"CS2GS_TEST_SOURCE_ROOT": str(self.src)}  # published cs2gs cannot locate the repo root itself
        cs2gs = str(self.tools / "cs2gs")
        for p in (self.migrated, self.runs):
            if p.exists():
                shutil.rmtree(p)
        cmd = [cs2gs, "migrate", "--corpus", self.src, "--out", self.migrated, "--artifacts", self.runs,
               "--config", "Release", "--gsc", sdk / "compiler" / "gsc.dll", "--gsgen", sdk / "gsgen" / "gsgen.dll"]
        if facts.get("cs2gs_has_sdk_pin_flags"):
            cmd += ["--sdk-version", facts["sdk_pin"], "--sdk-pin", "global-json"]
        if self.args.translate_only:
            cmd += ["--translate-only"]
        else:
            oracle = self.root / "csharp-tests"
            self.sh("capture-oracle", [cs2gs, "capture-test-oracle", "--corpus", self.src, "--out", oracle]
                    + filters, cwd=self.src, env_extra=env, check=False)
            cmd += ["--csharp-test-oracle", oracle]
            self.stage_pinned_sdk()
        rc = self.sh("translate", cmd + filters, cwd=self.src, env_extra=env, check=False)
        run_jsons = sorted(self.runs.glob("*/run.json"))
        if not run_jsons:
            raise CutoverError(f"cs2gs migrate exited {rc} and wrote no run.json; see {self.logs / 'translate.log'}")
        run = json.loads(run_jsons[-1].read_text())
        apps = run.get("apps", [])
        # An app that passed with `unverified` set skipped a stage it needed: not green for a rehearsal.
        failed = [a.get("appId") for a in apps if not a.get("succeeded") or a.get("unverified")]
        facts["translate"] = {"apps": len(apps), "failed": failed, "exit": rc}
        status = "passed" if rc == 0 and not failed else "failed"
        return status, f"{len(apps) - len(failed)}/{len(apps)} apps green, cs2gs exit {rc}; failed: {failed}"

    def s_assemble(self):
        filters = self.record["facts"]["filters"]
        keep = keep_csharp_prefixes(filters)
        # Idempotent: always assemble from the pristine C# commit.
        self.sh("assemble", ["git", "checkout", "--quiet", "-f", "-B", "cutover/dry-run",
                             self.record["facts"]["csharp_commit"]], cwd=self.src)
        self.sh("assemble", ["git", "clean", "-fdq"], cwd=self.src)
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=self.src).decode().split("\0")
        deleted = 0
        retained: list[str] = []
        for rel in tracked:
            if not rel.endswith((".cs", ".csproj")) or under(rel, keep):
                continue
            stem = rel.rsplit(".", 1)[0]
            twin = (self.migrated / (stem + (".gs" if rel.endswith(".cs") else ".gsproj"))).is_file()
            # "split" sources: one C# file became Stem.<Part>.gs files (no same-named twin)
            split = rel.endswith(".cs") and any(
                (self.migrated / rel).parent.glob(Path(stem).name + ".*.gs"))
            if twin or split or (self.migrated / rel).is_file():
                if not (self.migrated / rel).is_file():
                    (self.src / rel).unlink()
                    deleted += 1
            else:
                # C# the mirror did not translate or carry (foreign-compile samples, C# fixture data, ...):
                # keep it and list it for review rather than delete it silently.
                retained.append(rel)
        added = 0
        for path in iter_files(self.migrated, ("",)):
            rel = path.relative_to(self.migrated)
            dest = self.src / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
            added += 1
        self.sh("assemble", ["git", "checkout", "--quiet", "-B", "cutover/dry-run"], cwd=self.src)
        self.sh("assemble", ["git", "add", "-A"], cwd=self.src)
        facts = self.record["facts"]
        msg = self.root / "commit-message.txt"
        msg.write_text(commit_message(facts["csharp_commit"], "<final-tag>", facts["cs2gs_version"],
                                      facts["sdk_pin"], deleted, added))
        self.sh("assemble", ["git", "-c", "user.name=cutover", "-c", "user.email=cutover@invalid", "commit",
                             "--quiet", "--no-verify", "-F", msg], cwd=self.src)
        facts["assemble"] = {"deleted": deleted, "written": added, "keep_csharp": keep, "retained_csharp": retained}
        return "passed", (f"deleted {deleted} C# files, wrote {added} files, kept C# under {keep}; "
                          f"{len(retained)} untranslated tracked C# file(s) retained for review: {retained[:12]}")

    def s_hand_fix(self):
        sln = subprocess.run(["git", "show", f"{self.record['facts']['csharp_commit']}:GSharp.sln"], cwd=self.src,
                             capture_output=True, text=True).stdout or None
        notes: list[str] = []
        commit = self.record["facts"]["csharp_commit"]
        listed = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", commit], cwd=self.src,
                                         text=True).splitlines()
        originals = {rel: subprocess.run(["git", "show", f"{commit}:{rel}"], cwd=self.src, capture_output=True,
                                         text=True).stdout
                     for rel in listed if rel.endswith(".csproj") and not under(rel, ALWAYS_KEEP_CSHARP)}
        packable = tuple(p for p in packable_gsprojs(originals) if (self.src / p).is_file())
        problems = apply_hand_fixes(self.src, self.record["facts"]["sdk_pin"], sln, notes.append,
                                    tuple(self.record["facts"]["assemble"]["keep_csharp"]), packable)
        (self.logs / "hand-fix.log").write_text("\n".join(notes + ["PROBLEMS:"] + problems) + "\n")
        # 8. the mirrored packages.lock.json files describe the C# projects; regenerate them so the
        #    locked-mode restore CI uses can pass (found by the first dry run: NU1004).
        rc = self.sh("hand-fix", LOCK_REGEN, cwd=self.src, check=False)
        if rc != 0:
            problems.append(f"lock-file regeneration (dotnet restore --force-evaluate) exited {rc}; see hand-fix.log")
        self.sh("hand-fix", ["git", "add", "-A"], cwd=self.src)
        self.sh("hand-fix", ["git", "-c", "user.name=cutover", "-c", "user.email=cutover@invalid", "commit",
                             "--quiet", "--no-verify", "-m", "Apply the cut-over hand-fixes"], cwd=self.src,
                check=False)
        return ("failed", "; ".join(problems)) if problems else ("passed", f"{len(notes)} fix groups applied")

    def s_gsfmt(self):
        rc = self.sh("gsfmt", [self.tools / "gsfmt", "--check", "."], cwd=self.src, check=False)
        count = sum(1 for _ in iter_files(self.src, (".gs",)))
        if rc == 0:
            return "passed", f"gsfmt --check clean over {count} .gs files"
        # The polish pass edits `!!` after the formatter ran, so some lines re-wrap. Record how many files
        # the cut-over commit must reformat (the plan expected zero), write them, and require a clean re-check.
        listing = self.logs / "gsfmt-list.log"
        with listing.open("wb") as out:
            subprocess.run([str(self.tools / "gsfmt"), "--list", "."], cwd=self.src, env=self.env, stdout=out)
        changed = sum(1 for line in listing.read_text().splitlines() if line.strip())
        self.record["facts"]["gsfmt_files_reformatted"] = changed
        self.sh("gsfmt", [self.tools / "gsfmt", "--write", "."], cwd=self.src)
        rc2 = self.sh("gsfmt", [self.tools / "gsfmt", "--check", "."], cwd=self.src, check=False)
        if rc2 != 0:
            return "failed", f"gsfmt --write left the tree unclean (exit {rc2})"
        self.sh("gsfmt", ["git", "add", "-A"], cwd=self.src)
        self.sh("gsfmt", ["git", "-c", "user.name=cutover", "-c", "user.email=cutover@invalid", "commit", "--quiet",
                          "--no-verify", "-m", "Run gsfmt over the migrated tree"], cwd=self.src, check=False)
        return "passed", f"gsfmt --check was NOT clean: {changed} of {count} .gs files reformatted by --write, re-check clean"

    def s_core_smoke(self):
        self.sh("core-smoke", ["dotnet", "build", "src/Core/Core.gsproj", "-c", "Release"], cwd=self.src)
        return "passed", "src/Core compiled with the pinned SDK"

    def s_build(self):
        rc = self.sh("build", ["dotnet", "restore", "GSharp.slnx", "--locked-mode"], cwd=self.src, check=False)
        note = ""
        if rc != 0:
            note = " (locked-mode restore FAILED; continued unlocked)"
            self.sh("build", ["dotnet", "restore", "GSharp.slnx"], cwd=self.src)
        self.sh("build", ["dotnet", "build", "GSharp.slnx", "-c", "Release", "--no-restore", "-graph"], cwd=self.src)
        return ("failed" if note else "passed"), "GSharp.slnx built in Release" + note

    def s_e2e(self):
        rc = self.sh("e2e", ["bash", "build/run-e2e-tests.sh"] + self.args.e2e, cwd=self.src, check=False)
        return ("passed", "e2etests green") if rc == 0 else ("failed", f"run-e2e-tests.sh exit {rc}")

    def s_vsix(self):
        details = []
        vs = (self.src / "src/vs-gsharp/src/VsGsharp/VsGsharp.csproj").read_text(encoding="utf-8-sig")
        lit = re.search(r'Projects="([^"]*LanguageServer[^"]*)"', vs)
        target = (self.src / "src/vs-gsharp/src/VsGsharp" / lit.group(1).replace("\\", "/")).resolve() if lit else None
        if not target or not target.is_file():
            raise CutoverError(f"VsGsharp.csproj LanguageServer path does not resolve ({lit.group(1) if lit else '?'})")
        details.append("VS VSIX: LanguageServer path resolves; the VSSDK build needs Windows (msbuild "
                       "src\\vs-gsharp\\VsGsharp.sln /restore /t:Build /p:Configuration=Release)")
        ext = self.src / "src" / "vscode-gsharp"
        if shutil.which("npm") and shutil.which("npx"):
            self.sh("vsix", ["npm", "ci"], cwd=ext)
            self.sh("vsix", ["npx", "vsce", "package", "--no-dependencies", "-o", "vscode-gsharp.vsix"], cwd=ext)
            details.append("VS Code .vsix packaged")
        else:
            raise CutoverError("npm/npx missing: the VS Code extension cannot be packaged")
        return "passed", "; ".join(details)

    def go(self) -> int:
        self.record["started"] = datetime.now(timezone.utc).isoformat()
        for name, fn in (("clone", self.s_clone), ("tools", self.s_tools), ("prepare", self.s_prepare),
                         ("translate", self.s_translate), ("assemble", self.s_assemble),
                         ("hand-fix", self.s_hand_fix), ("gsfmt", self.s_gsfmt), ("core-smoke", self.s_core_smoke),
                         ("build", self.s_build), ("e2e", self.s_e2e), ("vsix", self.s_vsix)):
            self.stage(name, fn)
        self.save()
        print(json.dumps(self.record["stages"], indent=2))
        return 0 if all(s.get("status") in ("passed", "skipped", "not-run") for s in self.record["stages"].values()) else 1


def main(argv=None) -> int:
    default_root = Path.home() / ".cache" / "cutover" / datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%S")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    d = sub.add_parser("dry-run", help="rehearse the cut-over from a fresh clone against nuget.org only")
    d.add_argument("--repo-url", default=CLONE_URL)
    d.add_argument("--commit", default="origin/main", help="commit-ish to translate (default origin/main)")
    d.add_argument("--pin", default="latest", help="published Gsharp.NET.Sdk version (default: newest also published as cs2gs)")
    d.add_argument("--cs2gs-version", help="published Gsharp.Cs2Gs version (default: same as --pin)")
    d.add_argument("--work-root", default=str(default_root), help="NOT under /tmp; default ~/.cache/cutover/run-<utc>")
    d.add_argument("--from-stage", choices=STAGES, default="clone", help="resume at a stage of an existing work root")
    d.add_argument("--only", nargs="*", choices=STAGES, default=[])
    d.add_argument("--skip", nargs="*", choices=STAGES, default=[])
    d.add_argument("--translate-only", action="store_true", help="skip compile/polish/parity (unpolished tree; fast iteration)")
    d.add_argument("--e2e", nargs="*", default=[], help="e2e script prefixes (default: all)")
    d.add_argument("--stop-on-failure", action="store_true")
    h = sub.add_parser("hand-fix", help="apply only the hand-fix list to a migrated tree")
    h.add_argument("--tree", required=True)
    h.add_argument("--sdk-version", required=True)
    h.add_argument("--packable", nargs="*", default=[], help=".gsproj paths whose C# project had GeneratePackageOnBuild=true")
    h.add_argument("--original-sln", help="path to the C# GSharp.sln, to check the .slnx lists every project")
    args = p.parse_args(argv)
    try:
        if args.command == "hand-fix":
            sln = Path(args.original_sln).read_text(encoding="utf-8-sig") if args.original_sln else None
            problems = apply_hand_fixes(Path(args.tree), args.sdk_version, sln, print, packable=tuple(args.packable))
            # hand-fix 8, shared with the dry run: the mirrored lock files describe the C# projects.
            rc = subprocess.run(LOCK_REGEN, cwd=args.tree).returncode
            if rc != 0:
                problems.append(f"lock-file regeneration ({' '.join(LOCK_REGEN)}) exited {rc}")
            for line in problems:
                print("PROBLEM:", line)
            return 1 if problems else 0
        if args.from_stage != "clone" and args.commit == "origin/main" and not Path(args.work_root).exists():
            raise CutoverError("--from-stage needs an existing --work-root")
        return Run(args).go()
    except CutoverError as e:
        print(f"cutover: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
