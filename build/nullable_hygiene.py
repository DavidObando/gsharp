#!/usr/bin/env python3
"""Nullable-migration hygiene gate (ADR-0155, issue #1364).

ADR-0155 states several rules that were originally review conventions. Review
conventions do not survive a large migration, so amendment A3 moved them here,
where CI enforces them:

  1. defaults      Production projects use the shared nullable-enabled default,
                   tests and supporting tooling remain oblivious, and src/Core
                   has no stale per-file enable directives after the final flip.
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
  5b. arg-null-bang No `f(null!)` in production code -- the argument-position
                   twin of `= null!`. Test projects are oblivious, so exempt.
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

The allowlist contains permanent intentional oblivious regions, including the
metadata-import test fixture and six legacy annotations-only production files.
Removing those escapes would either break the fixture premise or expose
unmigrated flow warnings; they are explicit boundaries, not warning
suppression for newly migrated code.

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
# These regions intentionally exercise oblivious metadata and must survive the
# final project-wide default. See the comments at each source site.
DISABLE_ALLOWLIST = {
    "test/Core.Tests/CodeAnalysis/Symbols/ClrNullabilityTests.cs",
    "test-assets/Issue3119.CrossConstants/Constants.cs",
    "src/Core/CodeAnalysis/Binding/Binder.cs",
    "src/Core/CodeAnalysis/Binding/BoundScope.cs",
    "src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.Invocation.cs",
    "src/Core/CodeAnalysis/Binding/ExpressionBinder.cs",
    "src/Core/CodeAnalysis/Symbols/ReferenceResolver.cs",
    "src/Core/CodeAnalysis/Symbols/StructSymbol.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/CompilationUnit.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/GExpression.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/GMember.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/GPattern.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/GStatement.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/GTypeReference.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/Parameter.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Ast/TypeDeclaration.cs",
    "tools/cs2gs/Cs2Gs.CodeModel/Printing/GSharpPrinter.cs",
}
# MEF [Import] fields legitimately use `= null!`; that tree is a separate
# build island with its own Directory.Build.props.
NULL_BANG_ALLOWLIST_PREFIXES = ("src/vs-gsharp/",)

# A null-forgiving `!`: preceded by something that can end an expression,
# followed by something that can follow one. Excludes `!=` and prefix `!x`.
FORGIVING_RE = re.compile(r"[A-Za-z0-9_\)\]\"]!(?!=)(?=[.\[\)\],;:}\s]|$)")
# `foo(null!)` / `foo(x, null!)` deliberately passes null to a non-nullable
# parameter. In a test that is how you check an ArgumentNullException guard --
# the opposite of laundering -- so `forgiving` ignores it. In PRODUCTION code it
# is laundering, and `arg-null-bang` fails on it; that check runs only where
# `in_nullable_context` holds, which post-flip excludes every test project.
# `= null!` and `return null!` still trip (null-bang and forgiving respectively).
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


HEAD_REF = None
_PROJECT_NULLABLE = {}


def in_nullable_context(rel):
    """True if `rel` is compiled in a nullable context today.

    Either the file carries `#nullable enable`, or its owning project is a
    production project under the shared final-flip default. In an oblivious
    file `!` is a no-op and `= null!` is meaningless, so the
    annotation-discipline checks would only generate noise there.
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
            oblivious_project = any(
                re.search(r"<IsTestProject>\s*true\s*</IsTestProject>",
                           open(os.path.join(d, p), encoding="utf-8",
                                errors="replace").read())
                for p in projs)
            ancestor = d
            while ancestor.startswith(ROOT) and len(ancestor) >= len(ROOT):
                dbp = os.path.join(ancestor, "Directory.Build.props")
                if os.path.exists(dbp):
                    with open(dbp, encoding="utf-8", errors="replace") as fh:
                        if re.search(r"<IsTestProject>\s*true\s*</IsTestProject>"
                                     r"|<IsToolingProject>\s*true\s*</IsToolingProject>",
                                     fh.read()):
                            oblivious_project = True
                            break
                parent = os.path.dirname(ancestor)
                if parent == ancestor:
                    break
                ancestor = parent
            enabled = False
            for p in projs:
                with open(os.path.join(d, p), encoding="utf-8", errors="replace") as fh:
                    if re.search(r"<Nullable>\s*enable\s*</Nullable>", fh.read()):
                        enabled = True
            enabled = enabled or not oblivious_project
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
    props = read("build/gsharp.build.props")
    required = (
        "<Nullable Condition=\"'$(IsTestProject)' == 'true' or '$(IsToolingProject)' == 'true'\">disable</Nullable>",
        "<Nullable Condition=\"'$(IsTestProject)' != 'true' and '$(IsToolingProject)' != 'true'\">enable</Nullable>",
    )
    bad = 0
    for line in required:
        if line not in props:
            fail(f"build/gsharp.build.props: missing final-flip property `{line}`")
            bad += 1
    core_files = git("ls-files", "src/Core/**/*.cs").splitlines()
    stale = [rel for rel in core_files
             if re.search(r"^\s*#nullable\s+enable\s*$", code_only(read(rel)), re.MULTILINE)]
    if stale:
        for rel in stale:
            fail(f"{rel}: obsolete per-file `#nullable enable` after final flip")
            bad += 1
    if not bad:
        print("  shared properties enable production and disable tests/tooling")
        print("  src/Core has no obsolete per-file nullable directives")


def check_no_escapes(_base, fail):
    bad = 0
    for rel in git("ls-files", "*.cs").splitlines():
        if rel in DISABLE_ALLOWLIST:
            continue
        for ln, kind in directives(rel):
            if kind in ("disable", "restore"):
                fail(f"{rel}:{ln}: `#nullable {kind}` in an enabled file "
                     f"(ADR-0155: once enabled it stays enabled; add only "
                     f"intentional migration boundaries to the allowlist)")
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


def check_arg_null_bang(base, fail):
    """No `f(null!)` in a nullable context.

    Passing `null!` to a non-nullable parameter is the argument-position twin
    of `= null!`: it asserts a contract the call site then violates, and defers
    the consequence to a runtime NRE somewhere downstream. The honest fixes are
    to widen the parameter (if null is a real form) or to not pass null.

    Test code is exempt and needs no allowlist: passing `null!` to check that a
    guard throws is the opposite of laundering, and post-flip every test project
    builds with `Nullable=disable`, so `in_nullable_context` already excludes it.
    """
    bad = 0
    for path, ln, text in added_lines(base, HEAD_REF):
        if path and path.startswith(NULL_BANG_ALLOWLIST_PREFIXES):
            continue
        if not path or not path.endswith(".cs") or not in_nullable_context(path):
            continue
        if ARG_NULL_BANG_RE.search(code_only(text)):
            fail(f"{path}:{ln}: passes `null!` to a non-nullable parameter -- "
                 f"widen the parameter or stop passing null; do not suppress\n"
                 f"      {text.strip()[:100]}")
            bad += 1
    if not bad:
        print("  no `null!` arguments in nullable code")


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
    re.compile(r"^\s*#nullable\s+enable\s+annotations\s*$"),
    re.compile(r"^\s*#nullable\s+disable\s+warnings\s*$"),
    re.compile(r"^\s*using\s+System\.Diagnostics\.CodeAnalysis;\s*$"),
]
ATTR_RE = re.compile(
    r"\[\s*(?:return\s*:\s*)?"
    r"(MaybeNull|NotNull|AllowNull|DisallowNull|MaybeNullWhen|NotNullWhen"
    r"|MemberNotNull|MemberNotNullWhen|NotNullIfNotNull)\s*(\([^]]*\))?\s*\]\s*")
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
    "arg-null-bang": check_arg_null_bang,
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
