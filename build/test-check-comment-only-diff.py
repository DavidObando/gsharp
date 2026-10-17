#!/usr/bin/env python3
"""Regression tests for build/check-comment-only-diff.py.

Each test gives the check a base and a head version of one file. The "fails"
tests change code, often next to a comment or inside a string that looks like
a comment, and assert that the check reports it (ADR-0154). The "passes" tests
change only comments and assert that the check accepts them. The Git tests
build a temporary repository outside the checkout.

The G# tests run the real lexer through build/gstokens, so the module builds
build/gstokens/GsTokens.gsproj first (Release). The YAML tests need PyYAML.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("check_comment_only_diff", REPO / "build" / "check-comment-only-diff.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-comment-only-diff.py")
check = importlib.util.module_from_spec(SPEC)
# dataclasses resolve string annotations through sys.modules.
sys.modules[SPEC.name] = check
SPEC.loader.exec_module(check)

LEXER = check.GsLexer.build()


class CommentOnlyCase(unittest.TestCase):
    def assertPasses(self, path: str, base: str, head: str) -> None:
        self.assertNotEqual(base, head, "the test must change something")
        reason = check.compare(path, base, head, LEXER)
        self.assertIsNone(reason, f"{path}: expected a comment-only change, got: {reason}")

    def assertFails(self, path: str, base: str, head: str, fragment: str = "code differs") -> None:
        self.assertNotEqual(base, head, "the test must change something")
        reason = check.compare(path, base, head, LEXER)
        self.assertIsNotNone(reason, f"{path}: expected a failure, but the change passed")
        assert reason is not None  # narrows the type; assertIsNotNone above reports the failure
        self.assertIn(fragment, reason)


class GSharpTests(CommentOnlyCase):
    def test_comment_reword_passes(self) -> None:
        self.assertPasses(
            "a.gs",
            "func F() int32 {\n    // This is load-bearing.\n    return 1 // belt and suspenders\n}\n",
            "func F() int32 {\n    // F returns 1.\n    return 1 // the default\n}\n",
        )

    def test_doc_and_block_comment_reword_passes(self) -> None:
        self.assertPasses(
            "a.gs",
            "/// Old summary.\n/* one\n   two */\nfunc F() {}\n",
            "/// New summary that\n/// spans two lines.\n/* one line */\nfunc F() {}\n",
        )

    def test_deleted_comment_lines_pass(self) -> None:
        self.assertPasses(
            "a.gs",
            "let a = 1\n\n// History of the fix.\n// More history.\n\nlet b = 2 // trailing\n",
            "let a = 1\n\nlet b = 2\n",
        )

    def test_inline_block_comment_removal_passes(self) -> None:
        self.assertPasses("a.gs", "let x = f(1 /* count */, 2)\n", "let x = f(1, 2)\n")

    def test_comment_reword_beside_tricky_strings_passes(self) -> None:
        base = (
            'let url = "http://example.com/a" // old\n'
            "let raw = `line // one\n/* two */`\n"
            "let slash = '/' // old\n"
            'let hole = "${f("}", "//")} done" // old\n'
            'let dollar = "$${not a hole // }" // old\n'
        )
        self.assertPasses("a.gs", base, base.replace("// old", "// new"))

    def test_change_inside_string_after_double_slash_fails(self) -> None:
        self.assertFails("a.gs", 'let s = "a // selfmig"\n', 'let s = "a // migration"\n')

    def test_change_inside_string_that_looks_like_block_comment_fails(self) -> None:
        self.assertFails("a.gs", 'let s = "/* selfmig */"\n', 'let s = "/* migration */"\n')

    def test_change_inside_interpolation_fails(self) -> None:
        self.assertFails("a.gs", 'let s = "x ${f("a // selfmig")} y"\n', 'let s = "x ${f("a // migration")} y"\n')

    def test_change_inside_raw_string_fails(self) -> None:
        self.assertFails("a.gs", "let s = `a\n// selfmig\n`\n", "let s = `a\n// migration\n`\n")

    def test_question_and_bracket_joined_by_comment_removal_fail(self) -> None:
        # The G# lexer reads `?[` as one token.
        self.assertFails("a.gs", "let x = c ? /* note */ [1] : [2]\n", "let x = c ?[1] : [2]\n")
        self.assertPasses("a.gs", "let x = c ? /* note */ [1] : [2]\n", "let x = c ? [1] : [2]\n")

    def test_tokens_joined_by_comment_removal_fail(self) -> None:
        self.assertFails("a.gs", "let x = a/**/b\n", "let x = ab\n")

    def test_line_break_removed_with_a_block_comment_fails(self) -> None:
        self.assertFails("a.gs", "let x = a /*\n*/ b\n", "let x = a b\n")

    def test_code_token_change_next_to_comment_fails(self) -> None:
        self.assertFails("a.gs", "let x = 1 // count\n", "let x = 2 // count\n")

    def test_trailing_comment_edit_with_code_edit_on_same_line_fails(self) -> None:
        self.assertFails("a.gs", "let x = 1 // old count\n", "let x = 2 // new count\n")

    def test_commenting_out_code_fails(self) -> None:
        self.assertFails("a.gs", "Setup()\nRun()\n", "Setup()\n// Run()\n")

    def test_auto_generated_marker_is_code(self) -> None:
        self.assertFails("a.gs", "// <auto-generated/>\nlet x = 1\n", "// Generated.\nlet x = 1\n")

    def test_prose_that_mentions_the_generated_marker_is_a_comment(self) -> None:
        self.assertPasses(
            "a.gs",
            "// A file marked `<auto-generated/>` is skipped.\nlet x = 1\n",
            "// The check skips a file that has the `<auto-generated/>` marker.\nlet x = 1\n",
        )

    def test_lexer_error_fails_closed(self) -> None:
        self.assertFails("a.gs", 'let s = "a"\n', 'let s = "a // b\n', "the G# lexer reports")

    def test_byte_order_mark_change_fails(self) -> None:
        self.assertFails("a.gs", "\ufefflet x = 1\n", "let x = 1\n", "byte-order mark")

    def test_missing_token_tool_fails_closed(self) -> None:
        reason = check.compare("a.gs", "let x = 1 // a\n", "let x = 1 // b\n", check.GsLexer(Path("/no/such/gstokens.dll")))
        self.assertIsNotNone(reason)
        assert reason is not None  # narrows the type
        self.assertIn("does not exist", reason)

    def test_real_lexer_file_comment_and_string_edits(self) -> None:
        # The edits come from the lexer's own tokens, not from fixed text, so
        # a later rewording of Lexer.gs does not break this test.
        path = "src/Core/CodeAnalysis/Syntax/Lexer.gs"
        text = (REPO / path).read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as scratch:
            file = Path(scratch) / "Lexer.gs"
            file.write_text(text, encoding="utf-8")
            result = subprocess.run(["dotnet", str(LEXER.dll), str(file)], capture_output=True, text=True, check=True)
        import json

        raw = json.loads(result.stdout)[0]["tokens"]
        lines = text.splitlines(keepends=True)

        def edit(token: list, new: str) -> str:
            kind, line, old = token
            row = lines[line - 1]
            self.assertEqual(row.count(old.rstrip("\r\n")), 1, f"{kind} on line {line}")
            changed = lines[: line - 1] + [row.replace(old.rstrip("\r\n"), new)] + lines[line:]
            return "".join(changed)

        def single_line(t: list) -> bool:
            line = lines[t[1] - 1]
            return "\n" not in t[2].rstrip("\r\n") and line.count(t[2].rstrip("\r\n")) == 1

        comments = [t for t in raw if t[0] == "CommentToken" and t[2].startswith("// ") and single_line(t)]
        strings = [t for t in raw if t[0] == "StringToken" and len(t[2]) >= 3 and single_line(t)]
        self.assertGreater(len(comments), 0)
        self.assertGreater(len(strings), 0)
        comment = comments[len(comments) // 2]
        literal = strings[len(strings) // 2]
        self.assertPasses(path, text, edit(comment, "// A reworded comment."))
        quote = literal[2][0]
        self.assertFails(path, text, edit(literal, quote + "Q" + literal[2][1:]))


class PythonTests(CommentOnlyCase):
    def test_comment_reword_passes(self) -> None:
        self.assertPasses(
            "a.py",
            '#!/usr/bin/env python3\nx = "a # b"  # old\n# old line\n\ny = f"{x!r} # {x}"\n',
            '#!/usr/bin/env python3\nx = "a # b"  # new\ny = f"{x!r} # {x}"\n',
        )

    def test_change_inside_string_after_hash_fails(self) -> None:
        self.assertFails("a.py", 'x = "a # selfmig"\n', 'x = "a # migration"\n')

    def test_change_inside_f_string_fails(self) -> None:
        self.assertFails("a.py", 'x = f"{y} # {z}"\n', 'x = f"{y} # {w}"\n')

    def test_docstring_change_fails_for_manual_review(self) -> None:
        self.assertFails("a.py", '"""Old summary."""\nx = 1\n', '"""New summary."""\nx = 1\n', "docstring changed: review manually")
        self.assertFails(
            "a.py", 'def f():\n    """Old."""\n    return 1\n', 'def f():\n    """New."""\n    return 1\n', "docstring changed"
        )

    def test_shebang_change_fails(self) -> None:
        self.assertFails("a.py", "#!/usr/bin/env python3\nx = 1\n", "#!/usr/bin/python3\nx = 1\n")

    def test_noqa_change_fails(self) -> None:
        self.assertFails("a.py", "import os  # noqa: F401\n", "import os  # unused\n")

    def test_deleting_comment_after_continuation_fails(self) -> None:
        # The base prints 1 and the head prints 3.
        self.assertFails("a.py", "x = 1 \\\n# old\n+ 2\nprint(x)\n", "x = 1 \\\n+ 2\nprint(x)\n")

    def test_tokenize_error_fails_closed(self) -> None:
        self.assertFails("a.py", "x = (1,\n", "x = (1, # c\n", "cannot compare")


class YamlTests(CommentOnlyCase):
    BASE = (
        "# old header\n"
        "jobs:\n"
        "  build: # old\n"
        "    if: ${{ a == 'b' }} # old\n"
        '    name: "a # b"\n'
        "    steps:\n"
        "      - run: |\n"
        "          # shell comment\n"
        "          echo hi\n"
        "\n"
        "      # old step note\n"
        "      - run: echo 'q#r'\n"
    )

    def setUp(self) -> None:
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.fail("PyYAML is not installed; install python3-yaml to run the YAML tests")

    def test_comment_reword_and_deletion_passes(self) -> None:
        head = self.BASE.replace("# old", "# new").replace("      # new step note\n", "")
        self.assertPasses("a.yml", self.BASE, head)

    def test_change_inside_scalar_fails(self) -> None:
        for old, new in (("a # b", "a # c"), ("q#r", "q#s"), ("'b'", "'c'")):
            with self.subTest(old=old):
                self.assertFails("a.yml", self.BASE, self.BASE.replace(old, new, 1), "differs")

    def test_change_inside_block_scalar_fails(self) -> None:
        self.assertFails("a.yml", self.BASE, self.BASE.replace("# shell comment", "# shell note"), "differs")

    def test_parse_error_fails_closed(self) -> None:
        self.assertFails("a.yaml", "k: [1, 2]\n", "k: [1, 2\n", "YAML parse failed")

    def test_missing_pyyaml_fails_closed(self) -> None:
        with mock.patch.dict(sys.modules, {"yaml": None}):
            self.assertFails("a.yml", "k: 1 # a\n", "k: 1 # b\n", "PyYAML is not installed")


class UnsupportedTests(CommentOnlyCase):
    def test_shell_csharp_and_other_types_are_unsupported(self) -> None:
        for path in ("a.sh", "a.bash", "a.cs", "a.md", "Directory.Build.props"):
            with self.subTest(path=path):
                self.assertFails(path, "x # a\n", "x # b\n", "unsupported: review manually")


def git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env).stdout


class GitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = tempfile.TemporaryDirectory()
        self.repo = Path(self.scratch.name)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "core.autocrlf", "false")
        git(self.repo, "config", "commit.gpgsign", "false")
        self.write("a.gs", 'let s = "a // b" // old\n')
        self.write("b.py", "x = 1  # old\n")
        self.write("c.sh", "echo hi # old\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "base")
        git(self.repo, "branch", "base")

    def tearDown(self) -> None:
        self.scratch.cleanup()

    def write(self, path: str, text: str) -> None:
        (self.repo / path).write_text(text, encoding="utf-8")

    def commit(self) -> None:
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "head")

    def run_check(self, *args: str) -> tuple[int, str]:
        result = subprocess.run(
            [sys.executable, str(REPO / "build" / "check-comment-only-diff.py"), "--repo", str(self.repo),
             "--gstokens", str(LEXER.dll), *args],
            capture_output=True,
            text=True,
        )
        return result.returncode, result.stdout

    def test_comment_only_commit_passes(self) -> None:
        self.write("a.gs", 'let s = "a // b" // new\n')
        self.write("b.py", "x = 1  # new\n")
        self.commit()
        code, out = self.run_check("--base", "base")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS a.gs", out)
        self.assertIn("2 of 2 changed files", out)

    def test_string_change_fails_with_exit_1(self) -> None:
        self.write("a.gs", 'let s = "a // c" // old\n')
        self.commit()
        code, out = self.run_check("--base", "base")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL a.gs: code differs at base line 1 / head line 1", out)

    def test_path_filter_limits_the_check(self) -> None:
        self.write("a.gs", 'let s = "a // c" // old\n')
        self.write("b.py", "x = 1  # new\n")
        self.commit()
        code, out = self.run_check("--base", "base", "b.py")
        self.assertEqual(code, 0, out)
        self.assertNotIn("a.gs", out)

    def test_unsupported_added_deleted_renamed_and_mode_changes_fail(self) -> None:
        self.write("c.sh", "echo hi # new\n")
        self.write("d.gs", "let d = 1\n")
        (self.repo / "b.py").chmod(0o755)
        git(self.repo, "mv", "a.gs", "renamed.gs")
        self.commit()
        code, out = self.run_check("--base", "base")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL c.sh: unsupported: review manually", out)
        self.assertIn("FAIL d.gs: file is added", out)
        self.assertIn("FAIL a.gs: file is deleted", out)
        self.assertIn("FAIL renamed.gs: file is added", out)
        self.assertIn("FAIL b.py: mode changed from 100644 to 100755", out)

    def test_bad_revision_exits_2(self) -> None:
        code, out = self.run_check("--base", "no-such-rev")
        self.assertEqual(code, 2, out)


if __name__ == "__main__":
    unittest.main()
