#!/usr/bin/env python3
"""Nullable-migration hygiene gate (ADR-0155, issue #1364).

ADR-0155 states several rules that were originally review conventions. Review
conventions do not survive a 573-file migration, so amendment A3 moves them
here, where CI enforces them:

  1. coverage      Every file matching a glob in build/nullable-enabled.txt
                   carries a real top-level `#nullable enable`, placed after
                   the copyright header and before the usings.
  2. no-escapes    No `#nullable disable` / `#nullable restore` inside an
                   enabled file. ADR-0155: "once a file is enabled it stays
                   enabled".
  3. suppressions  No CS8xxx suppression is introduced -- not via
                   `#pragma warning disable`, not via `<NoWarn>`, not via an
                   `.editorconfig` severity. All three baselines are zero and
                   this check keeps a zero at zero.
  4. forgiving     Every null-forgiving `!` added by the diff has a justifying
                   comment adjacent to it. ADR-0155: "uncommented `!` is a
                   review defect". Accepted sites are printed with their
                   justification so a reviewer reads a short report instead of
                   hunting through the diff.
  5. null-bang     No `= null!` / `= default!` initializer is introduced.
  6. classify      Reports which changed files are annotation-only -- their
                   added and removed lines are identical once nullability
                   syntax is stripped, so they cannot have changed behaviour.
                   A slice whose files are all annotation-only needs no test
                   run (the build is a complete decision procedure for a
                   compile-time property) and no ADR-0154 witness (it adds no
                   tests). Files with behaviour-capable hunks need both.

Checks 1 and 2 need to distinguish a real directive from the 129 column-0
`#nullable` lines that live inside verbatim string literals in the cs2gs
translation tests, so this module carries a small C# lexer (`code_only`) that
blanks comments and string literals before matching. Grep cannot do this.

`test/Core.Tests/CodeAnalysis/Symbols/ClrNullabilityTests.cs` is a permanent
allowlist entry for check 2: its `#nullable disable` region exists precisely so
the C# compiler emits no NullableAttribute, giving the G# metadata importer a
genuinely oblivious type to import (issue #1354). Removing it silently breaks
the premise of that test.

Usage:
    python3 build/nullable_hygiene.py                  # gate vs origin/main
    python3 build/nullable_hygiene.py --base HEAD~1
    python3 build/nullable_hygiene.py --check coverage # single check
"""

import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "build", "nullable-enabled.txt")

# Issue #1354: this region must survive the entire migration. See module docs.
DISABLE_ALLOWLIST = {
    "test/Core.Tests/CodeAnalysis/Symbols/ClrNullabilityTests.cs",
}
# MEF [Import] fields legitimately use `= null!`; that tree is a separate
# build island with its own Directory.Build.props.
NULL_BANG_ALLOWLIST_PREFIXES = ("src/vs-gsharp/",)

EXCLUDED_DIRS = {"bin", "obj", "out", "artifacts", ".claude", "node_modules"}

# A null-forgiving `!`: preceded by something that can end an expression,
# followed by something that can follow one. Excludes `!=` and prefix `!x`.
FORGIVING_RE = re.compile(r"[A-Za-z0-9_\)\]\"]!(?!=)(?=[.\[\)\],;:}\s]|$)")
# `foo(null!)` / `foo(x, null!)` deliberately passes null to a non-nullable
# parameter -- the standard way to test an ArgumentNullException guard. That is
# the opposite of laundering, so it is exempt. `= null!` and `return null!`
# still trip (null-bang and forgiving respectively).
ARG_NULL_BANG_RE = re.compile(r"[(,]\s*null!")


def code_only(text):
    '''Return `text` with comments and string literals blanked to spaces.

    Line structure is preserved so line numbers still line up. Handles line and
    block comments, regular string literals with backslash escapes, verbatim
    `@"..."` literals with doubled-quote escapes, and raw string literals
    (three or more quotes).
    '''
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if c == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if c == "/" and nxt == "*":
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            out.append("  ")
            i = min(i + 2, n)
            continue
        if c == '"' and text[i:i + 3] == '"""':
            fence = 0
            while i + fence < n and text[i + fence] == '"':
                fence += 1
            out.append(" " * fence)
            i += fence
            while i < n:
                if text[i] == '"' and text[i:i + fence] == '"' * fence:
                    out.append(" " * fence)
                    i += fence
                    break
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            continue
        if c == "@" and nxt == '"':
            out.append("  ")
            i += 2
            while i < n:
                if text[i] == '"':
                    if i + 1 < n and text[i + 1] == '"':
                        out.append("  ")
                        i += 2
                        continue
                    out.append(" ")
                    i += 1
                    break
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            continue
        if c == '"':
            out.append(" ")
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "\\":
                    out.append("  ")
                    i += 2
                    continue
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            out.append(" ")
            i += 1
            continue
        if c == "'":
            out.append(" ")
            i += 1
            while i < n and text[i] != "'":
                if text[i] == "\\":
                    out.append("  ")
                    i += 2
                    continue
                out.append(" ")
                i += 1
            out.append(" ")
            i += 1
            continue

        out.append(c)
        i += 1
    return "".join(out)


def read(path):
    with open(os.path.join(ROOT, path), "rb") as fh:
        raw = fh.read()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return raw.decode("utf-8", errors="replace")


def directives(path):
    """Yield (lineno, kind) for every real #nullable directive in `path`."""
    for i, line in enumerate(code_only(read(path)).splitlines(), start=1):
        m = re.match(r"\s*#nullable\s+(enable|disable|restore)\b", line)
        if m:
            yield i, m.group(1)


def manifest_globs():
    if not os.path.exists(MANIFEST):
        return []
    with open(MANIFEST) as fh:
        return [ln.strip() for ln in fh
                if ln.strip() and not ln.lstrip().startswith("#")]


def enabled_files():
    """Expand the manifest. A line beginning with `!` subtracts a pattern.

    Exclusions exist because a slice is a file set, not a directory (ADR-0155
    amendment A3): `Binding/Bound*.cs` is the right way to say "the Bound node
    types", and the handful of Bound* files that are logic rather than data are
    subtracted by name rather than by contorting the glob.
    """
    import glob as g

    def expand(pattern):
        found = set()
        for p in g.glob(os.path.join(ROOT, pattern), recursive=True):
            rel = os.path.relpath(p, ROOT)
            if rel.endswith(".cs") and not any(
                    part in EXCLUDED_DIRS for part in rel.split(os.sep)):
                found.add(rel)
        return found

    out = set()
    for pattern in manifest_globs():
        if pattern.startswith("!"):
            out -= expand(pattern[1:].strip())
        else:
            out |= expand(pattern)
    return sorted(out)


HEAD_REF = None
_PROJECT_NULLABLE = {}


def in_nullable_context(rel):
    """True if `rel` is compiled in a nullable context today.

    Either the file carries `#nullable enable`, or its owning project sets
    `<Nullable>enable</Nullable>` (as `src/Repl` already does, and as every
    project will once Phase 2 lands). In an oblivious file `!` is a no-op and
    `= null!` is meaningless, so the annotation-discipline checks would only
    generate noise there.
    """
    full = os.path.join(ROOT, rel)
    if not os.path.exists(full):
        return False
    try:
        if any(k == "enable" for _, k in directives(rel)):
            return True
    except OSError:
        return False

    d = os.path.dirname(full)
    while d.startswith(ROOT) and len(d) >= len(ROOT):
        if d in _PROJECT_NULLABLE:
            return _PROJECT_NULLABLE[d]
        projs = [f for f in os.listdir(d) if f.endswith(".csproj")] if os.path.isdir(d) else []
        if projs:
            enabled = False
            for p in projs:
                with open(os.path.join(d, p), encoding="utf-8", errors="replace") as fh:
                    if re.search(r"<Nullable>\s*enable\s*</Nullable>", fh.read()):
                        enabled = True
            # Directory.Build.props can enable a whole subtree (src/vs-gsharp).
            dbp = os.path.join(d, "Directory.Build.props")
            if not enabled and os.path.exists(dbp):
                with open(dbp, encoding="utf-8", errors="replace") as fh:
                    enabled = bool(re.search(r"<Nullable>\s*enable\s*</Nullable>", fh.read()))
            _PROJECT_NULLABLE[d] = enabled
            return enabled
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return False


def git(*args):
    return subprocess.run(["git", "-C", ROOT, *args],
                          capture_output=True, text=True).stdout


def added_lines(base, head=None):
    """Yield (path, lineno, text) for lines this diff adds to .cs/.csproj/.editorconfig."""
    rng = [base, head] if head else [base]
    diff = git("diff", "-U0", *rng, "--", "*.cs", "*.csproj", "*.props",
               "*.targets", ".editorconfig")
    path, lineno = None, 0
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            lineno = int(m.group(1)) if m else 0
        elif line.startswith("+") and not line.startswith("+++"):
            yield path, lineno, line[1:]
            lineno += 1


# --------------------------------------------------------------------------- checks

def check_coverage(_base, fail):
    files = enabled_files()
    if not manifest_globs():
        print("  manifest is empty -- no directories enabled yet")
        return
    if not files:
        fail("build/nullable-enabled.txt lists globs but none matched any file")
        return
    bad = 0
    for rel in files:
        ds = list(directives(rel))
        if not any(k == "enable" for _, k in ds):
            fail(f"{rel}: in an enabled glob but has no `#nullable enable` (ADR-0155)")
            bad += 1
            continue
        first = next(ln for ln, k in ds if k == "enable")
        code = code_only(read(rel)).splitlines()
        for i, line in enumerate(code[:first - 1], start=1):
            s = line.strip()
            if s.startswith("using ") or s.startswith("namespace "):
                fail(f"{rel}:{first}: `#nullable enable` must precede the usings "
                     f"(found `{s[:40]}` at line {i})")
                bad += 1
                break
    if not bad:
        print(f"  {len(files)} file(s) in the enabled set, all carry the directive")


def check_no_escapes(_base, fail):
    bad = 0
    for rel in enabled_files():
        if rel in DISABLE_ALLOWLIST:
            continue
        for ln, kind in directives(rel):
            if kind in ("disable", "restore"):
                fail(f"{rel}:{ln}: `#nullable {kind}` in an enabled file "
                     f"(ADR-0155: once enabled it stays enabled)")
                bad += 1
    if not bad:
        print("  no disable/restore escapes in enabled files")


def check_suppressions(base, fail):
    pats = [
        (re.compile(r"#pragma\s+warning\s+(disable|restore)\s+[^/\n]*\bCS8\d{3}"),
         "CS8xxx pragma suppression"),
        (re.compile(r"<NoWarn>[^<]*CS8\d{3}"), "CS8xxx in <NoWarn>"),
        (re.compile(r"dotnet_diagnostic\.CS8\d{3}\.severity"),
         "CS8xxx severity override in .editorconfig"),
        (re.compile(r"<WarningsNotAsErrors>"), "<WarningsNotAsErrors> escape hatch"),
    ]
    bad = 0
    for path, ln, text in added_lines(base, HEAD_REF):
        for rx, what in pats:
            if rx.search(text):
                fail(f"{path}:{ln}: introduces {what} -- ADR-0155 requires "
                     f"annotating the contract, not suppressing the warning\n"
                     f"      {text.strip()[:100]}")
                bad += 1
    if not bad:
        print("  no CS8xxx suppressions introduced")


def check_null_bang(base, fail):
    rx = re.compile(r"=\s*(null|default)!")
    bad = 0
    for path, ln, text in added_lines(base, HEAD_REF):
        if path and path.startswith(NULL_BANG_ALLOWLIST_PREFIXES):
            continue
        if not path or not path.endswith(".cs") or not in_nullable_context(path):
            continue
        if rx.search(code_only(text)):
            fail(f"{path}:{ln}: introduces `= null!` -- this defers a contract "
                 f"violation to a runtime NRE\n      {text.strip()[:100]}")
            bad += 1
    if not bad:
        print("  no `= null!` initializers introduced")


def has_justification(path, lineno, window=30):
    """Return the justifying comment for a `!` at `lineno`, or None.

    A justification is an ordinary `//` comment -- either trailing the `!`
    itself or in the preceding `window` lines. `///` XML documentation does NOT
    count: it describes the API for consumers, whereas the invariant that makes
    a `!` safe is a statement about the code. Without that distinction the
    check is vacuous, since nearly every member in this codebase carries doc
    comments (StyleCop SA1600 et al).

    The window is 30 because the canonical precedent --
    `src/Core/CodeAnalysis/Text/TextLocation.cs` -- puts one comment block at
    lines 39-44 covering four uses, the last at line 68.

    Presence is all this can check. The caller prints the matched comment so a
    reviewer can judge whether it actually names the invariant and its
    establisher, which is the part no tool can verify.
    """
    try:
        lines = read(path).splitlines()
    except OSError:
        return None
    if lineno - 1 >= len(lines):
        return None

    def is_plain_comment(s):
        t = s.lstrip()
        return t.startswith("//") and not t.startswith("///")

    same = lines[lineno - 1]
    # A trailing comment: `//` that survives outside a string literal.
    blanked = code_only(same)
    idx = same.find("//")
    if idx != -1 and "//" in blanked[:idx + 2] + same[idx:idx + 2]:
        if is_plain_comment(same[idx:]):
            return same[idx:].strip()

    for i in range(lineno - 2, max(-1, lineno - 2 - window), -1):
        t = lines[i].lstrip()
        # Nothing above the file preamble can justify anything below it. Without
        # this the copyright block's `// </copyright>` matches every `!` in the
        # first 30 lines of a file.
        if (t.startswith("#nullable") or t.startswith("using ")
                or t.startswith("namespace ") or t.startswith("// <copyright")
                or t.startswith("// </copyright>") or t.startswith("// Copyright ")):
            return None
        if is_plain_comment(lines[i]):
            return lines[i].strip()
    return None


def check_forgiving(base, fail):
    sites, bad = [], 0
    for path, ln, text in added_lines(base, HEAD_REF):
        if not path or not path.endswith(".cs") or not in_nullable_context(path):
            continue
        code = code_only(text)
        if not FORGIVING_RE.search(ARG_NULL_BANG_RE.sub("", code)):
            continue
        why = has_justification(path, ln)
        if why:
            sites.append((path, ln, text.strip()[:80], why[:90]))
        else:
            fail(f"{path}:{ln}: null-forgiving `!` with no adjacent justifying "
                 f"comment (ADR-0155: uncommented `!` is a review defect)\n"
                 f"      {text.strip()[:100]}")
            bad += 1
    if sites:
        print(f"  {len(sites)} justified `!` site(s) -- paste into the PR body and")
        print("  check that each comment names the invariant AND its establisher:")
        for path, ln, text, why in sites:
            print(f"    {path}:{ln}")
            print(f"      code: {text}")
            print(f"      why:  {why}")
    elif not bad:
        print("  no null-forgiving `!` introduced")


# Nullability syntax that carries no runtime meaning. Stripping it turns
# "did this line change?" into "did this line change for a reason other
# than annotation?".
NULLABILITY_NOISE = [
    re.compile(r"^\s*#nullable\s+enable\s*$"),
    re.compile(r"^\s*using\s+System\.Diagnostics\.CodeAnalysis;\s*$"),
]
ATTR_RE = re.compile(
    r"\[\s*(MaybeNull|NotNull|AllowNull|DisallowNull|MaybeNullWhen|NotNullWhen"
    r"|MemberNotNull|MemberNotNullWhen|NotNullIfNotNull)\s*(\([^)]*\))?\s*\]\s*")
# `?` in type position: after an identifier/generic/array close, before a name,
# `,`, `)`, `>` or `{`. Deliberately does not touch `?.`, `??` or `a ? b : c`.
TYPE_Q_RE = re.compile(r"(?<=[A-Za-z0-9_>\]])\?(?=\s*[A-Za-z_,\)>\{\[])")


def normalize_annotation(line):
    for rx in NULLABILITY_NOISE:
        if rx.match(line):
            return None
    s = ATTR_RE.sub("", line)
    s = TYPE_Q_RE.sub("", s)
    s = ARG_NULL_BANG_RE.sub("(null", s)
    s = FORGIVING_RE.sub(lambda m: m.group(0)[0], s)
    s = re.sub(r"//.*$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def check_classify(base, _fail):
    '''Report which files this diff changes for annotation reasons only.

    An annotation-only file is behaviour-free by construction, which is what
    licenses skipping its test suite (ADR-0155 amendment: the build is the
    oracle for a compile-time property). A file with behaviour-capable hunks
    needs its owning suite run and each hunk justified in the PR body.
    '''
    per_file = {}
    rng = [base, HEAD_REF] if HEAD_REF else [base]
    diff = git("diff", "-U0", *rng, "--", "*.cs")
    path = None
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
            per_file.setdefault(path, ([], []))
        elif path and line.startswith("+") and not line.startswith("+++"):
            per_file[path][0].append(line[1:])
        elif path and line.startswith("-") and not line.startswith("---"):
            per_file[path][1].append(line[1:])

    anno, behav = [], []
    for p, (adds, dels) in sorted(per_file.items()):
        na = sorted(x for x in (normalize_annotation(l) for l in adds) if x)
        nd = sorted(x for x in (normalize_annotation(l) for l in dels) if x)
        (anno if na == nd else behav).append(p)

    print(f"  annotation-only files: {len(anno)}")
    if behav:
        print(f"  behaviour-capable files: {len(behav)} -- run their suites and "
              f"justify each hunk in the PR body:")
        for p in behav:
            print(f"    {p}")
    else:
        print("  behaviour-capable files: 0 -- annotation-only PR, "
              "no ADR-0154 witness required")


CHECKS = {
    "classify": check_classify,
    "coverage": check_coverage,
    "no-escapes": check_no_escapes,
    "suppressions": check_suppressions,
    "null-bang": check_null_bang,
    "forgiving": check_forgiving,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="origin/main", help="diff base (default origin/main)")
    ap.add_argument("--head", help="diff head (default: the working tree)")
    ap.add_argument("--check", action="append", choices=sorted(CHECKS),
                    help="run only these checks (repeatable)")
    args = ap.parse_args()

    global HEAD_REF
    HEAD_REF = args.head

    failures = []

    def fail(msg):
        failures.append(msg)

    for name in (args.check or sorted(CHECKS)):
        print(f"[{name}]")
        CHECKS[name](args.base, fail)

    if failures:
        print(f"\nFAILED -- {len(failures)} problem(s):\n")
        for f in failures:
            print(f"  * {f}")
        return 1
    print("\nnullable hygiene: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
