#!/usr/bin/env python3
"""
Generates NotImplementedException stub overrides for every abstract member of a
Roslyn class so we can subclass it without hand-implementing the entire surface.

Usage:
    python3 tools/gen-roslyn-stubs.py \
        src/Roslyn/src/Compilers/Core/Portable/Compilation/Compilation.cs

Emits to stdout. Pipe into the body of a partial class (see
src/CodeAnalysis/Compilation/GsharpCompilation.Abstracts.cs for an example).

Re-run when rebasing onto a newer Roslyn tag if the abstract surface drifts.
"""
import re
import sys
import pathlib

src = pathlib.Path(sys.argv[1]).read_text()
# Better pattern: visibility allows two-word combos
vis_re = r'(?:public|internal|protected|private protected|protected internal)'
pattern = re.compile(
    rf'(?P<vis>{vis_re})(?:\s+(?:override|sealed|new))?\s+abstract\s+(?P<body>[^;{{}}]+?)\s*;',
    re.DOTALL
)
out = []
seen = set()
for m in pattern.finditer(src):
    vis = m.group('vis')
    body = m.group('body').strip()
    body_norm = re.sub(r'\s+', ' ', body)
    if body_norm in seen:
        continue
    seen.add(body_norm)
    out.append((vis, body_norm))

# Also property pattern: vis abstract Type Name { get; [set;] }
prop_re = re.compile(
    rf'(?P<vis>{vis_re})(?:\s+(?:override|sealed|new))?\s+abstract\s+(?P<body>[^;{{}}]+?\{{\s*(?:get;?\s*)?(?:set;?\s*)?\}})',
    re.DOTALL
)
for m in prop_re.finditer(src):
    vis = m.group('vis')
    body = re.sub(r'\s+', ' ', m.group('body').strip())
    if body in seen:
        continue
    seen.add(body)
    out.append((vis, body))

print(f"// Found {len(out)} abstract members")
for vis, sig in out:
    m = re.match(r'^(.+?)\s+([A-Za-z_]\w*)\s*\{\s*(.*?)\s*\}$', sig)
    if m:
        ret, name, accessors = m.groups()
        ret = re.sub(r'(?<![\w.])Compilation(?![\w.])', 'Microsoft.CodeAnalysis.Compilation', ret.strip())
        parts = []
        if 'get' in accessors:
            parts.append("get => throw new System.NotImplementedException();")
        if 'set' in accessors:
            parts.append("set => throw new System.NotImplementedException();")
        print(f"    {vis} override {ret} {name} {{ {' '.join(parts)} }}")
    else:
        # Strip 'where ...' constraints on overrides (CS0460)
        sig = re.sub(r'\s+where\s+\w+\s*:\s*[^;]+$', '', sig)
        # Replace bare 'Compilation' return type with fully-qualified
        sig = re.sub(r'(?<![\w.])Compilation(?![\w.])', 'Microsoft.CodeAnalysis.Compilation', sig)
        print(f"    {vis} override {sig} => throw new System.NotImplementedException();")
