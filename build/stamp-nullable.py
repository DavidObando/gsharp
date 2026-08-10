#!/usr/bin/env python3
"""Insert `#nullable enable` into C# files for an ADR-0155 migration slice.

ADR-0155 places the directive after the copyright header, separated by blank
lines, before the `using` block. `src/Core/CodeAnalysis/Text/TextLocation.cs`
is the canonical layout:

    // <copyright file="TextLocation.cs" company="GSharp">
    // Copyright (C) GSharp Authors. All rights reserved.
    // </copyright>
    <blank>
    #nullable enable
    <blank>
    using System;

Only `src/Core` needs per-file directives (ADR-0155 amendment A1): it is a
single project spanning every subsystem, so a sub-project boundary can only be
expressed per file. Every other project flips via its csproj property.

Files are rewritten as bytes so a UTF-8 BOM and the file's existing line
endings survive untouched. Re-running is a no-op.

Usage:
    stamp-nullable.py --dir src/Core/CodeAnalysis/Syntax
    stamp-nullable.py --glob 'src/Core/CodeAnalysis/Binding/Bound*.cs'
    stamp-nullable.py --file-list slice.txt --dry-run
"""

import argparse
import glob as globmod
import os
import re
import sys

BOM = b"\xef\xbb\xbf"
DIRECTIVE = "#nullable enable"
COPYRIGHT_END = re.compile(r"^\s*//\s*</copyright>\s*$")
# A directive that is actually a directive: start of line (modulo whitespace),
# not inside a string literal. See `already_enabled` for the literal guard.
DIRECTIVE_RE = re.compile(r"^\s*#nullable\s+enable\s*$")


def split_lines(text):
    """Split keeping line endings, so we can detect and reproduce them."""
    return text.splitlines(keepends=True)


def dominant_newline(lines):
    crlf = sum(1 for ln in lines if ln.endswith("\r\n"))
    lf = sum(1 for ln in lines if ln.endswith("\n") and not ln.endswith("\r\n"))
    return "\r\n" if crlf > lf else "\n"


def already_enabled(text):
    """True if the file has a real top-level `#nullable enable`.

    Guards against the 129 column-0 `#nullable` lines that live inside verbatim
    string literals in the cs2gs translation tests. We only scan the header
    region -- before the first `namespace` or type declaration -- which no
    string literal can precede.
    """
    for raw in split_lines(text):
        line = raw.rstrip("\r\n")
        if DIRECTIVE_RE.match(line):
            return True
        stripped = line.strip()
        if stripped.startswith("namespace ") or stripped.startswith("using "):
            # Past the header; a directive after this point is either absent or
            # misplaced. Keep scanning usings, stop at namespace.
            if stripped.startswith("namespace "):
                return False
    return False


def insertion_index(lines):
    """Line index to insert at: just past the copyright header, else the top."""
    for i, raw in enumerate(lines[:20]):
        if COPYRIGHT_END.match(raw.rstrip("\r\n")):
            return i + 1
    return 0


def stamp(path, dry_run):
    with open(path, "rb") as fh:
        raw = fh.read()

    bom, body = (BOM, raw[len(BOM):]) if raw.startswith(BOM) else (b"", raw)

    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        print(f"  SKIP (not utf-8): {path}", file=sys.stderr)
        return False

    if already_enabled(text):
        return False

    lines = split_lines(text)
    nl = dominant_newline(lines) if lines else "\n"
    at = insertion_index(lines)

    block = [DIRECTIVE + nl, nl]
    # After a copyright header we need a blank line before the directive too.
    # At the very top of a header-less file we do not.
    if at > 0:
        block.insert(0, nl)
        # Collapse a blank line that already followed the header.
        if at < len(lines) and lines[at].strip() == "":
            del lines[at]

    lines[at:at] = block

    if dry_run:
        print(f"  would stamp: {path}")
        return True

    with open(path, "wb") as fh:
        fh.write(bom + "".join(lines).encode("utf-8"))
    return True


def collect(args):
    paths = []
    if args.dir:
        for d in args.dir:
            for root, _, files in os.walk(d):
                if any(p in root.split(os.sep) for p in ("bin", "obj")):
                    continue
                paths += [os.path.join(root, f) for f in files if f.endswith(".cs")]
    for pattern in args.glob or []:
        paths += [p for p in globmod.glob(pattern, recursive=True) if p.endswith(".cs")]
    if args.file_list:
        with open(args.file_list) as fh:
            paths += [
                ln.strip() for ln in fh
                if ln.strip() and not ln.startswith("#") and ln.strip().endswith(".cs")
            ]
    return sorted(set(paths))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", action="append", help="recurse this directory (repeatable)")
    ap.add_argument("--glob", action="append", help="glob pattern (repeatable)")
    ap.add_argument("--file-list", help="file containing one path per line")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    paths = collect(args)
    if not paths:
        print("no .cs files matched", file=sys.stderr)
        return 1

    stamped = sum(1 for p in paths if stamp(p, args.dry_run))
    verb = "would stamp" if args.dry_run else "stamped"
    print(f"{verb} {stamped} of {len(paths)} file(s); "
          f"{len(paths) - stamped} already enabled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
