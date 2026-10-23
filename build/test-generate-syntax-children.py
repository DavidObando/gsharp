#!/usr/bin/env python3
"""Regression tests for build/generate-syntax-children.py (issue #5136).

Each test builds a small syntax directory in a temporary folder and runs the
generator on it. The checks cover the property order (declared properties
first, then each base class), the classification of child types, the skipped
members, the failure on an unsupported collection type, and the `--check` mode.
The last test runs `--check` on the real repository, so a change to a node
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

    def test_repository_file_is_current(self) -> None:
        result = self.run_script(REPO, "--check")
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
