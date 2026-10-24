#!/usr/bin/env python3
"""Regression tests for build/generate-syntax-children.py (issue #5136).

Each test builds a small syntax directory in a temporary folder and runs the
generator on it. The checks cover the property order (declared properties
first, then each base class), the classification of child types, the skipped
members, the failure on an unsupported collection type, and the `--check` mode.
Source-order tests cover the `@SyntaxChildSourceOrder` marker (issue #5185). The last test runs `--check` on the real repository, so a change to a node
class without a regenerated file fails here as well as in CI.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "build" / "generate-syntax-children.py"
SPEC = importlib.util.spec_from_file_location("generate_syntax_children", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/generate-syntax-children.py")
gen = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gen
SPEC.loader.exec_module(gen)

BASE = """package GSharp.Core.CodeAnalysis.Syntax

abstract class SyntaxNode {
}

class SyntaxToken : SyntaxNode {
}

abstract class MemberSyntax : SyntaxNode {
    prop Annotations ImmutableArray[SyntaxNode] {
        get;
    }
}
"""

NODE = """package GSharp.Core.CodeAnalysis.Syntax

open class PairSyntax : MemberSyntax {
    prop Left SyntaxToken {
        get;
    }

    prop Maybe SyntaxToken? {
        get;
    }

    prop Items SeparatedSyntaxList[SyntaxToken] {
        get;
    }

    prop Name string {
        get;
    }

    @SyntaxChildIgnore
    prop Hidden SyntaxToken -> Left

    internal prop Internal SyntaxToken {
        get;
    }

    prop Right SyntaxToken {
        get;
    }

    shared {
        prop Static SyntaxToken {
            get;
        }
    }
}
"""


PLAIN = """package GSharp.Core.CodeAnalysis.Syntax

class PlainSyntax : SyntaxNode {
    prop First SyntaxToken {
        get;
    }

    prop Second SyntaxToken {
        get;
    }
}
"""


def make_tree(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="syntax-children-"))
    syntax = root / gen.SYNTAX_DIR
    syntax.mkdir(parents=True)
    for name, text in files.items():
        (syntax / name).write_text(text, encoding="utf-8")
    return root


class GeneratorCase(unittest.TestCase):
    def generate(self, node: str) -> str:
        root = make_tree({"Base.gs": BASE, "PairSyntax.gs": node})
        return gen.generate(root)

    def test_orders_declared_properties_before_base_properties(self) -> None:
        text = self.generate(NODE)
        body = text[text.index("partial class PairSyntax"):]
        body = body[body.index("GetChild(index"):]
        order = [body.index(f"= {name}") for name in ("Left", "Maybe", "SeparatedItems(Items)", "Right", "Annotations")]
        self.assertEqual(order, sorted(order))

    def test_skips_ignored_internal_static_and_non_node_properties(self) -> None:
        text = self.generate(NODE)
        body = text[text.index("partial class PairSyntax"):]
        for name in ("Hidden", "Internal", "Static", "Name"):
            self.assertNotIn(name, body)

    def test_suppresses_null_only_for_optional_children(self) -> None:
        text = self.generate(NODE)
        body = text[text.index("partial class PairSyntax"):]
        self.assertIn("return child1!!", body)
        self.assertIn("return child0\n", body)

    def test_does_not_emit_abstract_classes(self) -> None:
        text = self.generate(NODE)
        self.assertNotIn("partial class MemberSyntax", text)
        self.assertIn("partial class SyntaxToken", text)

    def test_rejects_an_unsupported_collection(self) -> None:
        bad = NODE.replace("SeparatedSyntaxList[SyntaxToken]", "List[SyntaxToken]")
        with self.assertRaises(SystemExit):
            self.generate(bad)

    def test_output_is_stable(self) -> None:
        self.assertEqual(self.generate(NODE), self.generate(NODE))

    def run_script(self, root: Path, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(root), *extra],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_check_mode_detects_a_stale_file(self) -> None:
        root = make_tree({"Base.gs": BASE, "PairSyntax.gs": NODE})
        self.assertEqual(self.run_script(root, "--check").returncode, 1)
        self.assertEqual(self.run_script(root).returncode, 0)
        self.assertEqual(self.run_script(root, "--check").returncode, 0)
        node = root / gen.SYNTAX_DIR / "PairSyntax.gs"
        node.write_text(NODE.replace("prop Right SyntaxToken", "prop Other SyntaxToken"), encoding="utf-8")
        self.assertEqual(self.run_script(root, "--check").returncode, 1)

    def test_every_generated_class_keeps_both_invariants(self) -> None:
        """Exact runtime type for open classes; no per-lookup copy of a computed property."""
        classes = gen.parse_all(REPO)
        nodes = gen.node_types(classes)
        text = gen.generate(REPO)
        parts = text.split("\npartial class ")[1:]
        generated = {part.split(" ", 1)[0]: part for part in parts}
        expected = {n for n in nodes if n != gen.ROOT_NODE and not classes[n].abstract}
        self.assertEqual(set(generated), expected)
        for name, part in sorted(generated.items()):
            guard = f"GetType() != ExactTypeOf{name}"
            accessors = [m for m in ("ChildCount", "GetChild(", "BuildChildren(") if m in part]
            self.assertTrue(accessors, name)
            if classes[name].is_open:
                bodies = part.split("internal override ")[1:]
                self.assertTrue(bodies, name)
                for body in bodies:
                    self.assertIn(guard, body, f"{name}: open class accessor without the exact-type guard")
            else:
                self.assertNotIn("GetType()", part, name)
            self.assertNotRegex(part, r"[=!]=\s*typeof\(", f"{name}: Issue835 pattern")
            for body in part.split("internal override ")[1:]:
                if body.startswith("func BuildChildren"):
                    continue
                for computed in ("EnumerableItems(", "PresentTokens("):
                    self.assertNotIn(computed, body, f"{name}: lookup copies a computed property")

    def test_source_ordered_class_sorts_its_children(self) -> None:
        """A class with @SyntaxChildSourceOrder, or derived from one, sorts by source position."""
        marked = BASE.replace("abstract class MemberSyntax", "@SyntaxChildSourceOrder\nabstract class MemberSyntax")
        root = make_tree({"Base.gs": marked, "PairSyntax.gs": NODE, "Plain.gs": PLAIN})
        text = gen.generate(root)
        pair = text[text.index("partial class PairSyntax"):text.index("partial class PlainSyntax")]
        plain = text[text.index("partial class PlainSyntax"):]
        self.assertIn("BuildChildren()", pair)
        self.assertIn("return SortBySourcePosition(builder.ToImmutable())", pair)
        self.assertNotIn("SortBySourcePosition", plain)
        self.assertIn("internal override prop ChildCount", plain)

    def test_attribute_on_the_class_itself_is_enough(self) -> None:
        own = PLAIN.replace("class PlainSyntax", "@SyntaxChildSourceOrder\nclass PlainSyntax")
        root = make_tree({"Base.gs": BASE, "Plain.gs": own})
        self.assertIn("SortBySourcePosition", gen.generate(root))

    def test_repository_sorts_the_known_shape_dependent_classes(self) -> None:
        text = gen.generate(REPO)
        for name in ("UnaryExpressionSyntax", "TypeClauseSyntax", "StructDeclarationSyntax", "FunctionDeclarationSyntax"):
            part = text[text.index(f"partial class {name} {{"):]
            part = part[:part.index("\n}\n")]
            self.assertIn("SortBySourcePosition", part, name)

    def test_repository_file_is_current(self) -> None:
        result = self.run_script(REPO, "--check")
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
