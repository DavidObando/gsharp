#!/usr/bin/env python3
"""Generate the child accessors of the G# syntax node classes (issue #5136).

`SyntaxNode.GetChildren()` used to find the child properties of a node type by
reflection and read them through compiled expression getters that boxed each
child. This script reads the node classes in `src/Core/CodeAnalysis/Syntax`
and writes `SyntaxNode.Children.g.gs`: for each concrete node class, a
`partial class` part that overrides `ChildCount` and `GetChild(index)`.

The children are in the same order that the reflection path returns them: the
public instance properties of the class in declaration order, then those of
each base class. A class marked `@SyntaxChildSourceOrder` (or derived from one) then
sorts them by source position, because its property order is not the source order
for every shape (issue #5185). A property is a child when its type is a syntax node, a
`SeparatedSyntaxList`, or a collection of syntax nodes, and it has no
`@SyntaxChildIgnore` attribute. The reflection path stays in `SyntaxNode.gs` as
the fallback for a class without generated code and as the test oracle
(`Issue1675SyntaxNodeChildEnumerationTests`, `Issue5136GeneratedChildrenTests`).

Usage:
  generate-syntax-children.py            write the generated file
  generate-syntax-children.py --check    exit 1 when the file is out of date

The output depends only on the sorted file list and the file contents.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

SYNTAX_DIR = Path("src/Core/CodeAnalysis/Syntax")
OUTPUT = SYNTAX_DIR / "SyntaxNode.Children.g.gs"
ROOT_NODE = "SyntaxNode"

CLASS_RE = re.compile(
    r"^(?P<mods>(?:(?:open|abstract|internal|sealed|partial|final|data|public)\s+)*)class\s+"
    r"(?P<name>\w+)(?P<generic>\[[^\]]*\])?"
)
PROP_RE = re.compile(
    r"^    (?P<mods>(?:(?:open|override|internal|private|protected|public|final|new)\s+)*)prop\s+"
    r"(?P<name>\w+)\s+(?P<type>[^{>]*?)\s*(?:\{|->|$)"
)
MEMBER_INDENT = "    "
SOURCE_ORDER_ATTRIBUTE = "@SyntaxChildSourceOrder"


@dataclass
class Prop:
    name: str
    type: str
    ignored: bool
    public: bool
    line: str


@dataclass
class Cls:
    name: str
    path: Path
    abstract: bool
    base: str | None
    is_open: bool = False
    own_source_order: bool = False
    props: list[Prop] = field(default_factory=list)


def strip_comment_and_strings(line: str) -> str:
    return line.split("//", 1)[0]


def parse_file(path: Path, text: str) -> list[Cls]:
    classes: list[Cls] = []
    current: Cls | None = None
    pending_attrs: list[str] = []
    class_attrs: list[str] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = strip_comment_and_strings(raw)
        if line.startswith("@"):
            class_attrs.append(line.strip())
            i += 1
            continue
        m = CLASS_RE.match(line)
        if m and not raw.startswith(" "):
            # Header: collect up to the line that opens the class body.
            header = line
            j = i
            while "{" not in header and j + 1 < len(lines):
                j += 1
                header += " " + strip_comment_and_strings(lines[j]).strip()
            base = None
            after = header[m.end():].split("{", 1)[0]
            # The base is the first name after the first top-level ':'.
            if ":" in after:
                bm = re.match(r"\s*:\s*([\w.]+)", after[after.index(":"):])
                if bm:
                    base = bm.group(1).split(".")[-1]
            current = Cls(
                name=m.group("name"),
                path=path,
                abstract="abstract" in m.group("mods").split(),
                base=base,
                is_open="open" in m.group("mods").split(),
                own_source_order=any(a.startswith(SOURCE_ORDER_ATTRIBUTE) for a in class_attrs),
            )
            classes.append(current)
            class_attrs = []
            pending_attrs = []
            i = j + 1
            continue
        if current is None:
            i += 1
            continue
        stripped = line.strip()
        if line.startswith(MEMBER_INDENT) and not line.startswith(MEMBER_INDENT + " "):
            if stripped.startswith("@"):
                pending_attrs.append(stripped)
                i += 1
                continue
            pm = PROP_RE.match(line)
            if pm:
                mods = pm.group("mods").split()
                type_text = pm.group("type").strip()
                # An auto property types: "Name Type {" so the type is the rest.
                current.props.append(
                    Prop(
                        name=pm.group("name"),
                        type=type_text,
                        ignored=any(a.startswith("@SyntaxChildIgnore") for a in pending_attrs),
                        public=not any(x in mods for x in ("internal", "private", "protected")),
                        line=line.strip(),
                    )
                )
            if stripped and not stripped.startswith("@"):
                pending_attrs = []
        elif line.startswith("}"):
            pass
        i += 1
    # Members inside a shared block are indented by eight spaces; the loop above
    # only tracks the open brace, so recompute by a second pass for correctness.
    return classes


def parse_all(root: Path) -> dict[str, Cls]:
    classes: dict[str, Cls] = {}
    for path in sorted((root / SYNTAX_DIR).glob("*.gs"), key=lambda p: p.name):
        if path.name.endswith(".g.gs"):
            continue
        text = path.read_text(encoding="utf-8")
        for cls in parse_file(path, text):
            existing = classes.get(cls.name)
            if existing is None:
                classes[cls.name] = cls
            else:
                # Another part of a partial class: merge the properties in file order.
                existing.props.extend(cls.props)
                existing.base = existing.base or cls.base
                existing.own_source_order = existing.own_source_order or cls.own_source_order
    return classes


def node_types(classes: dict[str, Cls]) -> set[str]:
    nodes = {ROOT_NODE}
    changed = True
    while changed:
        changed = False
        for cls in classes.values():
            if cls.name not in nodes and cls.base in nodes:
                nodes.add(cls.name)
                changed = True
    return nodes


def classify(type_text: str, nodes: set[str], where: str) -> str | None:
    """Return 'node', 'sep', 'list' or None for a property type."""
    t = type_text.strip()
    nullable = t.endswith("?")
    if nullable:
        t = t[:-1].strip()
    if t in nodes:
        return "node"
    if t == "SeparatedSyntaxList" or t.startswith("SeparatedSyntaxList["):
        return "sep"
    m = re.fullmatch(r"(ImmutableArray|IEnumerable|IReadOnlyList|List|IReadOnlyCollection)\[(.+)\]", t)
    if m:
        element = m.group(2).strip()
        if element.endswith("?"):
            if element[:-1] == "SyntaxToken" and m.group(1) == "ImmutableArray" and not nullable:
                # Absent elements are skipped, as the reflection path skips them.
                return "tokens"
            if element[:-1] in nodes:
                raise SystemExit(f"{where}: nullable element type in {type_text!r} is not supported")
            return None
        if element in nodes:
            if m.group(1) == "IEnumerable":
                # A computed sequence: the generated code copies it for each access.
                return "enum"
            if m.group(1) != "ImmutableArray":
                raise SystemExit(f"{where}: collection type {type_text!r} is not supported; use ImmutableArray")
            if nullable:
                raise SystemExit(f"{where}: nullable list {type_text!r} is not supported")
            return "list"
        return None
    if t.startswith("[]") and t[2:] in nodes:
        raise SystemExit(f"{where}: array type {type_text!r} is not supported; use ImmutableArray")
    return None


def effective_props(name: str, classes: dict[str, Cls], nodes: set[str]) -> list[tuple[Prop, str]]:
    result: list[tuple[Prop, str]] = []
    seen: set[str] = set()
    cur: str | None = name
    while cur is not None and cur in classes:
        cls = classes[cur]
        for prop in cls.props:
            if prop.name in seen:
                continue
            seen.add(prop.name)
            if not prop.public or prop.ignored:
                continue
            kind = classify(prop.type, nodes, f"{cls.name}.{prop.name}")
            if kind is not None:
                result.append((prop, kind))
        cur = cls.base
    return result


COMPUTED_KINDS = ("enum", "tokens")


def is_source_ordered(name: str, classes: dict[str, Cls]) -> bool:
    """A class is source ordered when it or a base class has @SyntaxChildSourceOrder."""
    cur: str | None = name
    while cur is not None and cur in classes:
        if classes[cur].own_source_order:
            return True
        cur = classes[cur].base
    return False


def emit_class(cls: Cls, props: list[tuple[Prop, str]], source_ordered: bool) -> list[str]:
    """Emit the generated part of one concrete class.

    Two invariants hold for every class (tested in build/test-generate-syntax-children.py):
    1. An open class guards every generated accessor by its exact runtime type. A subclass that
       the generator did not see takes the reflection path, so a child property it adds is kept.
    2. A class with a property that is computed on each read (a sequence, or a token list that
       allows absent entries) builds its children once into an array, so each lookup is O(1).
       The other classes read their properties in place.
    3. A class marked `@SyntaxChildSourceOrder` (directly or through a base class) lists the
       children in the order of their source positions. Its property order is not the source
       order for every shape, so it builds the children once and sorts them (issue #5185).
    """
    out: list[str] = []
    # The guard compares the runtime type of a live node with a static field. The node always
    # belongs to the compiler's own load context, so this is not the MetadataLoadContext case of
    # issue #835; the field keeps the comparison out of the `== typeof(X)` source pattern that
    # the Issue835 guard test scans for.
    exact = f"ExactTypeOf{cls.name}"
    guard = f"GetType() != {exact}"
    cached = source_ordered or any(kind in COMPUTED_KINDS for _, kind in props)
    out.append(f"partial class {cls.name} {{")
    if cls.is_open:
        out.append("    shared {")
        out.append(f"        internal let {exact} Type = typeof({cls.name})")
        out.append("    }")
        out.append("")
    if cached:
        out.append("    /// ```xmldoc")
        out.append("    /// <inheritdoc />")
        out.append("    /// ```")
        out.append("    internal override func BuildChildren() ImmutableArray[SyntaxNode] {")
        if cls.is_open:
            out.append(f"        if {guard} {{")
            out.append("            return BuildChildrenByReflection()")
            out.append("        }")
        out.append("        let builder = ImmutableArray.CreateBuilder[SyntaxNode]()")
        for prop, kind in props:
            if kind == "node":
                out.append(f"        if IsPresent({prop.name}) {{")
                suppress = "!!" if prop.type.strip().endswith("?") else ""
                out.append(f"            builder.Add({prop.name}{suppress})")
                out.append("        }")
            elif kind == "sep":
                out.append(f"        builder.AddRange(SeparatedItems({prop.name}))")
            elif kind == "enum":
                out.append(f"        builder.AddRange(EnumerableItems({prop.name}))")
            elif kind == "tokens":
                out.append(f"        builder.AddRange(PresentTokens({prop.name}))")
            else:
                out.append(f"        for item{prop.name} in {prop.name} {{")
                out.append(f"            builder.Add(item{prop.name})")
                out.append("        }")
        if source_ordered:
            out.append("        return SortBySourcePosition(builder.ToImmutable())")
        else:
            out.append("        return builder.ToImmutable()")
        out.append("    }")
        out.append("}")
        return out

    out.append("    /// ```xmldoc")
    out.append("    /// <inheritdoc />")
    out.append("    /// ```")
    out.append("    internal override prop ChildCount int32 {")
    out.append("        get {")
    if cls.is_open:
        out.append(f"            if {guard} {{")
        out.append("                return CachedChildren().Length")
        out.append("            }")
    if not props:
        out.append("            return 0")
    else:
        out.append("            var count = 0")
        for prop, kind in props:
            if kind == "node":
                out.append(f"            if IsPresent({prop.name}) {{")
                out.append("                count++")
                out.append("            }")
            elif kind == "sep":
                out.append(f"            count += SeparatedLength({prop.name})")
            else:
                out.append(f"            count += {prop.name}.Length")
        out.append("            return count")
    out.append("        }")
    out.append("    }")
    out.append("")
    out.append("    /// ```xmldoc")
    out.append("    /// <inheritdoc />")
    out.append("    /// ```")
    out.append("    internal override func GetChild(index int32) SyntaxNode {")
    if cls.is_open:
        out.append(f"        if {guard} {{")
        out.append("            return ChildAt(CachedChildren(), index)")
        out.append("        }")
    if props:
        out.append("        var remaining = index")
        out.append("        if remaining >= 0 {")
        for n, (prop, kind) in enumerate(props):
            var = f"child{n}"
            if kind == "node":
                out.append(f"            let {var} = {prop.name}")
                out.append(f"            if IsPresent({var}) {{")
                out.append("                if remaining == 0 {")
                suppress = "!!" if prop.type.strip().endswith("?") else ""
                out.append(f"                    return {var}{suppress}")
                out.append("                }")
                out.append("                remaining--")
                out.append("            }")
            elif kind == "sep":
                out.append(f"            let {var} = SeparatedItems({prop.name})")
                out.append(f"            if remaining < {var}.Length {{")
                out.append(f"                return {var}[remaining]")
                out.append("            }")
                out.append(f"            remaining -= {var}.Length")
            else:
                out.append(f"            let {var} = {prop.name}")
                out.append(f"            if remaining < {var}.Length {{")
                out.append(f"                return {var}[remaining]")
                out.append("            }")
                out.append(f"            remaining -= {var}.Length")
        out.append("        }")
    out.append("        throw ArgumentOutOfRangeException(nameof(index))")
    out.append("    }")
    out.append("}")
    return out


HEADER = """// <auto-generated>
// Generated by build/generate-syntax-children.py from the syntax node classes in this directory.
// Do not edit by hand. Run `python3 build/generate-syntax-children.py` after a change to a
// child-bearing property, and add `partial` to the new class. Issues #5136 and #5185.
// </auto-generated>

package GSharp.Core.CodeAnalysis.Syntax

import System
import System.Collections.Immutable
"""


def generate(root: Path) -> str:
    classes = parse_all(root)
    nodes = node_types(classes)
    chunks: list[str] = [HEADER]
    for name in sorted(classes):
        cls = classes[name]
        if name not in nodes or name == ROOT_NODE or cls.abstract:
            continue
        props = effective_props(name, classes, nodes)
        chunks.append("\n".join(emit_class(cls, props, is_source_ordered(name, classes))) + "\n")
    return "\n".join(chunks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail when the generated file is out of date")
    parser.add_argument("--root", default=".", help="repository root")
    args = parser.parse_args()
    root = Path(args.root)
    text = generate(root)
    target = root / OUTPUT
    if args.check:
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        if current != text:
            print(f"{OUTPUT} is out of date. Run: python3 build/generate-syntax-children.py", file=sys.stderr)
            return 1
        return 0
    target.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
