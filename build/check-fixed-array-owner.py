#!/usr/bin/env python3
"""Check the canonical ADR-0210 owner in an actual SDK package."""

import argparse
import hashlib
from pathlib import Path
import zipfile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("owner", type=Path)
    args = parser.parse_args()
    expected = args.owner.read_bytes()
    required = {"compiler", "formatter", "gsgen", "values"}
    found = set()
    failures = []
    with zipfile.ZipFile(args.package) as package:
        for name in package.namelist():
            path = Path(name)
            if path.name != "Gsharp.Runtime.Values.dll":
                continue
            if len(path.parts) == 3 and path.parts[0] == "tools":
                found.add(path.parts[1])
            if package.read(name) != expected:
                failures.append(f"{name}: differs from the production owner")
    failures.extend(f"tools/{tool}/: missing owner" for tool in sorted(required - found))
    if failures:
        print("\n".join(failures))
        return 1
    print(f"Verified SDK owner copies: SHA-256 {hashlib.sha256(expected).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
