#!/usr/bin/env python3
"""Checks that the ReadyToRun compiler packages exist on a NuGet feed (ADR-0207, issue #5155).

Gsharp.NET.Sdk restores `Gsharp.NET.Sdk.Compiler.<rid>` at its own exact version with
PackageDownload. On the six supported RIDs a restore fails when that package is missing, so a release
must publish the six packages first and must prove that they exist before and after the SDK package.

The version comes from the `Gsharp.NET.Sdk.<version>.nupkg` file in --packages. The script asks the
NuGet flat container (`<base>/<id>/<version>/<id>.nuspec`) for each package and repeats the question
every --interval seconds until --wait-minutes pass. It exits 0 when every package exists, and 1 when
one is missing at the end.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RIDS = ("linux-x64", "linux-arm64", "win-x64", "win-arm64", "osx-x64", "osx-arm64")
SDK_PATTERN = re.compile(r"^Gsharp\.NET\.Sdk\.(\d+\.\d+\.\d+.*)\.nupkg$")
DEFAULT_BASE = "https://api.nuget.org/v3-flatcontainer"


def sdk_version(packages: Path) -> str:
    versions = sorted({m.group(1) for p in packages.glob("Gsharp.NET.Sdk.*.nupkg")
                       if (m := SDK_PATTERN.match(p.name))})
    if len(versions) != 1:
        raise SystemExit(f"expected exactly one Gsharp.NET.Sdk package version in {packages}, found {versions}")
    return versions[0]


def local_rids(packages: Path, version: str) -> set[str]:
    found = set()
    for rid in RIDS:
        if (packages / f"Gsharp.NET.Sdk.Compiler.{rid}.{version}.nupkg").is_file():
            found.add(rid)
    return found


def exists(base: str, package_id: str, version: str) -> bool:
    lower = package_id.lower()
    url = f"{base.rstrip('/')}/{lower}/{version.lower()}/{lower}.nuspec"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return response.status == 200
    except urllib.error.HTTPError as error:
        error.close()
        if error.code == 404:
            return False
        print(f"warning: {url}: HTTP {error.code}", file=sys.stderr)
        return False
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"warning: {url}: {error}", file=sys.stderr)
        return False


def main(argv: list[str] | None = None, sleep=time.sleep, clock=time.monotonic) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--packages", type=Path, required=True, help="folder with the packages of one build")
    parser.add_argument("--base-url", default=DEFAULT_BASE, help="NuGet flat container base URL")
    parser.add_argument("--wait-minutes", type=float, default=0, help="how long to wait for missing packages")
    parser.add_argument("--interval", type=float, default=30, help="seconds between two checks")
    parser.add_argument("--require-sdk", action="store_true", help="also require the Gsharp.NET.Sdk package")
    args = parser.parse_args(argv)

    version = sdk_version(args.packages)
    present = local_rids(args.packages, version)
    if present != set(RIDS):
        print(f"the build has RID packages for {sorted(present)} only; expected {sorted(RIDS)}", file=sys.stderr)
        return 1
    wanted = [f"Gsharp.NET.Sdk.Compiler.{rid}" for rid in RIDS]
    if args.require_sdk:
        wanted.append("Gsharp.NET.Sdk")

    deadline = clock() + args.wait_minutes * 60
    while True:
        missing = [package for package in wanted if not exists(args.base_url, package, version)]
        if not missing:
            print(f"all {len(wanted)} packages exist at {version}")
            return 0
        if clock() >= deadline:
            print(f"missing at {version}: {', '.join(missing)}", file=sys.stderr)
            return 1
        print(f"waiting for {len(missing)} package(s): {', '.join(missing)}")
        sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
