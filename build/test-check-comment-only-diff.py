#!/usr/bin/env python3
"""Regression tests for build/check-comment-only-diff.py.

Each test gives the check a base and a head version of one file. The "fails"
tests change code, often next to a comment or inside a string that looks like
a comment, and assert that the check reports it (ADR-0154). The "passes" tests
change only comments and assert that the check accepts them. The Git tests
build a temporary repository outside the checkout.

The tests run the real G# lexer through build/gstokens, so the module builds
build/gstokens/GsTokens.gsproj first (Release).
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("check_comment_only_diff", REPO / "build" / "check-comment-only-diff.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build/check-comment-only-diff.py")
check = importlib.util.module_from_spec(SPEC)
# dataclasses resolve string annotations through sys.modules.
sys.modules[SPEC.name] = check
SPEC.loader.exec_module(check)

LEXER = check.GsLexer(check.GSTOKENS_DLL)


def setUpModule() -> None:
    # Build the token tool once, before any test runs. A build failure is
    # reported as a module setup error.
    global LEXER
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

    def test_inline_block_comment_removal_keeps_the_space(self) -> None:
        # The parser can depend on whether two tokens touch, so the space that
        # the comment leaves must stay.
        self.assertPasses("a.gs", "let x = f(1 /* count */, 2)\n", "let x = f(1 , 2)\n")
        self.assertFails("a.gs", "let x = f(1 /* count */, 2)\n", "let x = f(1, 2)\n")

    def test_null_conditional_call_adjacency_is_compared(self) -> None:
        # `a?(x)` is a null-conditional call; `a? (x)` starts a conditional.
        self.assertFails("a.gs", "let r = GetHandler()?(x)\n", "let r = GetHandler()? /* note */ (x)\n")
        self.assertFails("a.gs", "let r = GetHandler() /* note */?(x)\n", "let r = GetHandler()?(x)\n")
        self.assertFails("a.gs", "let r = GetHandler()?(x)\n", "let r = GetHandler()? (x)\n")

    def test_header_comment_insertion_and_deletion_pass(self) -> None:
        self.assertPasses("a.gs", "// History.\nlet x = 1\n", "let x = 1\n")
        self.assertPasses("a.gs", "let x = 1\n", "// Note.\nlet x = 1\n")

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

    def test_auto_generated_marker_is_a_directive(self) -> None:
        self.assertFails("a.gs", "// <auto-generated/>\nlet x = 1\n", "// Generated.\nlet x = 1\n", "directive comment changed")
        self.assertPasses("a.gs", "// <auto-generated/>\nlet x = 1\n", "// <auto-generated/>\n\n// Note.\nlet x = 1\n")

    def test_doc_comment_prose_change_passes(self) -> None:
        base = "/// Adds two numbers.\n/// @param a The first (cref:Int32).\n/// @returns The sum.\nfunc Add(a int32) int32 -> a\n"
        head = "/// Returns the sum of two numbers.\n/// @param a The first number, an (cref:Int32).\n/// @returns The sum of the numbers.\nfunc Add(a int32) int32 -> a\n"
        self.assertPasses("a.gs", base, head)

    def test_doc_comment_structure_change_fails(self) -> None:
        base = "/// Adds.\n/// @param a The first (cref:Int32).\nfunc Add(a int32) int32 -> a\n"
        for old, new in (("@param a", "@param b"), ("(cref:Int32)", "(cref:Int64)"), ("@param a", "@typeparam a")):
            with self.subTest(old=old):
                self.assertFails("a.gs", base, base.replace(old, new), "directive comment changed")
        self.assertFails("a.gs", base, base.replace("/// Adds.\n", "/// Adds.\n/// @returns The sum.\n"), "directive comment changed")

    def test_doc_comment_markup_the_compiler_reads_fails(self) -> None:
        base = (
            "/// Adds [`a`](paramref).\n"
            "/// ```xmldoc\n"
            '/// <see cref="A"/>\n'
            "/// ```\n"
            "/// @param a The value.\n"
            "func Add(a int32) int32 -> a\n"
        )
        for old, new in (("[`a`](paramref)", "[`b`](paramref)"), ('cref="A"', 'cref="B"'), ("@param a", "@param\ta")):
            with self.subTest(old=old):
                self.assertIn(old, base)
                self.assertFails("a.gs", base, base.replace(old, new), "directive comment changed")

    def test_gap_between_doc_comment_and_declaration_fails(self) -> None:
        base = "/// @param a Value.\nfunc F(a int32) {}\n"
        for gap in ("\n", "// note\n"):
            with self.subTest(gap=gap):
                self.assertFails("a.gs", base, base.replace("\nfunc", "\n" + gap + "func"), "directive comment changed")

    def test_trailing_doc_comment_change_fails(self) -> None:
        base = "func F() {}\n"
        tagged = base + "/// @unknown-tag content\n"
        self.assertFails("a.gs", base, tagged, "directive comment changed")
        self.assertFails("a.gs", tagged, base, "directive comment changed")
        self.assertFails("a.gs", tagged, tagged.replace("@unknown-tag", "@other-tag"), "directive comment changed")

    def test_doc_comment_moved_to_another_declaration_fails(self) -> None:
        base = "/// @param a The value.\nfunc F(a int32) {}\nfunc G(a int32) {}\n"
        head = "func F(a int32) {}\n/// @param a The value.\nfunc G(a int32) {}\n"
        self.assertFails("a.gs", base, head, "directive comment changed")

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
            kind, line, old = token[:3]
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


class UnsupportedTests(CommentOnlyCase):
    def test_every_non_gsharp_type_is_unsupported(self) -> None:
        for path in ("a.py", "a.yml", "a.yaml", "a.sh", "a.bash", "a.cs", "a.md", "Directory.Build.props"):
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
        self.write("b.gs", "let x = 1 // old\n")
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
        self.write("b.gs", "let x = 1 // new\n")
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
        self.write("b.gs", "let x = 1 // new\n")
        self.commit()
        code, out = self.run_check("--base", "base", "b.gs")
        self.assertEqual(code, 0, out)
        self.assertNotIn("a.gs", out)

    def test_unsupported_added_deleted_renamed_and_mode_changes_fail(self) -> None:
        self.write("c.sh", "echo hi # new\n")
        self.write("d.gs", "let d = 1\n")
        (self.repo / "b.gs").chmod(0o755)
        git(self.repo, "mv", "a.gs", "renamed.gs")
        self.commit()
        code, out = self.run_check("--base", "base")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL c.sh: unsupported: review manually", out)
        self.assertIn("FAIL d.gs: file is added", out)
        self.assertIn("FAIL a.gs: file is deleted", out)
        self.assertIn("FAIL renamed.gs: file is added", out)
        self.assertIn("FAIL b.gs: mode changed from 100644 to 100755", out)

    def test_bad_revision_exits_2(self) -> None:
        code, out = self.run_check("--base", "no-such-rev")
        self.assertEqual(code, 2, out)


if __name__ == "__main__":
    unittest.main()
