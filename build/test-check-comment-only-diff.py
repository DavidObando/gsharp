#!/usr/bin/env python3
"""Regression tests for build/check-comment-only-diff.py.

Each test gives the check a base and a head version of one file. The "fails"
tests change code, often next to a comment or inside a string that looks like
a comment, and assert that the check reports it (ADR-0154). The "passes" tests
change only comments and assert that the check accepts them. The Git tests
build a temporary repository outside the checkout.
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


class CommentOnlyCase(unittest.TestCase):
    def assertPasses(self, path: str, base: str, head: str) -> None:
        self.assertNotEqual(base, head, "the test must change something")
        reason = check.compare(path, base, head)
        self.assertIsNone(reason, f"{path}: expected a comment-only change, got: {reason}")

    def assertFails(self, path: str, base: str, head: str, fragment: str = "code differs") -> None:
        self.assertNotEqual(base, head, "the test must change something")
        reason = check.compare(path, base, head)
        self.assertIsNotNone(reason, f"{path}: expected a failure, but the change passed")
        assert reason is not None  # narrows the type; assertIsNotNone above reports the failure
        self.assertIn(fragment, reason)


class GSharpTests(CommentOnlyCase):
    def test_comment_reword_passes(self) -> None:
        self.assertPasses(
            "a.gs",
            'func F() int {\n    // This is load-bearing.\n    return 1 // belt and suspenders\n}\n',
            'func F() int {\n    // F returns 1.\n    return 1 // the default\n}\n',
        )

    def test_doc_and_block_comment_reword_passes(self) -> None:
        self.assertPasses(
            "a.gs",
            "/// Old summary.\n/* one\n   two */\nfunc F() {}\n",
            "/// New summary that\n/// spans two lines.\n/* one line */\nfunc F() {}\n",
        )

    def test_deleted_comment_lines_and_extra_blank_line_pass(self) -> None:
        self.assertPasses(
            "a.gs",
            "let a = 1\n\n// History of the fix.\n// More history.\n\nlet b = 2 // trailing\n",
            "let a = 1\n\nlet b = 2\n",
        )

    def test_inline_block_comment_removal_passes(self) -> None:
        self.assertPasses("a.gs", "let x = f(1 /* count */, 2)\n", "let x = f(1, 2)\n")
        self.assertPasses("a.gs", "let x = a /* left */ + b\n", "let x = a + b\n")
        self.assertPasses("a.gs", "    /* lead */ F()\n", "    F()\n")

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

    def test_change_inside_string_with_url_fails(self) -> None:
        self.assertFails("a.gs", 'let u = "http://a/hot-core" // c\n', 'let u = "http://a/core" // c\n')

    def test_change_inside_string_that_looks_like_block_comment_fails(self) -> None:
        self.assertFails("a.gs", 'let s = "/* selfmig */"\n', 'let s = "/* migration */"\n')

    def test_change_inside_interpolation_fails(self) -> None:
        self.assertFails(
            "a.gs",
            'let s = "x ${f("a // selfmig")} y"\n',
            'let s = "x ${f("a // migration")} y"\n',
        )

    def test_change_to_comment_inside_interpolation_hole_fails(self) -> None:
        # A comment inside a hole is part of the string token, so the check
        # treats it as string content.
        self.assertFails(
            "a.gs",
            'let s = "x ${\n    f() // old\n} y"\n',
            'let s = "x ${\n    f() // new\n} y"\n',
        )

    def test_change_inside_raw_string_fails(self) -> None:
        self.assertFails("a.gs", "let s = `a\n// selfmig\n`\n", "let s = `a\n// migration\n`\n")

    def test_change_to_char_literal_beside_comment_fails(self) -> None:
        self.assertFails("a.gs", "if c == '/' // slash\n", "if c == '*' // slash\n")

    def test_code_token_change_next_to_comment_fails(self) -> None:
        self.assertFails("a.gs", "let x = 1 // count\n", "let x = 2 // count\n")

    def test_trailing_comment_edit_with_code_edit_on_same_line_fails(self) -> None:
        self.assertFails("a.gs", "let x = 1 // old count\n", "let x = 2 // new count\n")

    def test_question_and_bracket_joined_by_comment_removal_fail(self) -> None:
        # The G# lexer reads `?[` as one token.
        self.assertFails("a.gs", "let x = c ? /* note */ [1] : [2]\n", "let x = c ?[1] : [2]\n")
        self.assertPasses("a.gs", "let x = c ? /* note */ [1] : [2]\n", "let x = c ? [1] : [2]\n")

    def test_tokens_joined_by_comment_removal_fail(self) -> None:
        self.assertFails("a.gs", "let x = a/**/b\n", "let x = ab\n")

    def test_commenting_out_code_fails(self) -> None:
        self.assertFails("a.gs", "Setup()\nRun()\n", "Setup()\n// Run()\n")

    def test_uncommenting_code_fails(self) -> None:
        self.assertFails("a.gs", "Setup()\n// Run()\n", "Setup()\nRun()\n")

    def test_blank_line_inside_raw_string_is_not_normalized(self) -> None:
        self.assertFails("a.gs", "let s = `a\n\n\nb`\n", "let s = `a\n\nb`\n")

    def test_trailing_space_inside_raw_string_is_not_normalized(self) -> None:
        self.assertFails("a.gs", "let s = `a   \nb`\n", "let s = `a\nb`\n")

    def test_unterminated_string_fails_closed(self) -> None:
        self.assertFails("a.gs", 'let s = "a\n', 'let s = "a // b\n', "cannot tokenize")

    def test_unterminated_block_comment_fails_closed(self) -> None:
        self.assertFails("a.gs", "let s = 1\n", "let s = 1 /* open\n", "cannot tokenize")


class CSharpTests(CommentOnlyCase):
    BASE = (
        "#if DEBUG // old\n"
        "var a = \"http://x\"; // old\n"
        "var b = @\"C:\\dir\\\"; // old\n"
        "var c = @\"say \"\"// hi\"\"\"; // old\n"
        "var d = $\"{x} // {y:N2} {{z}}\"; // old\n"
        'var e = """\n    // raw\n    """; // old\n'
        "var f = $$\"\"\"{{x}} { // }\"\"\"; // old\n"
        "var g = '/'; // old\n"
        "#endif\n"
    )

    def test_comment_reword_beside_tricky_strings_passes(self) -> None:
        head = self.BASE.replace("; // old", "; // new")
        self.assertPasses("a.cs", self.BASE, head)

    def test_preprocessor_line_comment_is_code(self) -> None:
        self.assertFails("a.cs", self.BASE, self.BASE.replace("DEBUG // old", "DEBUG // new"))

    def test_change_inside_each_string_form_fails(self) -> None:
        for old, new in (
            ("http://x", "http://y"),
            ("\\dir\\", "\\path\\"),
            ("// hi", "// ho"),
            ("// {y:N2}", "// {y:N3}"),
            ("// raw", "// cooked"),
            ("{ // }", "{ // ]}"),
            ("'/'", "'*'"),
        ):
            with self.subTest(old=old):
                self.assertIn(old, self.BASE)
                self.assertFails("a.cs", self.BASE, self.BASE.replace(old, new, 1))

    def test_comment_across_conditional_compilation_fails_closed(self) -> None:
        # C# ignores the `/*` in the disabled region, so the WriteLine is active.
        base = '#if false\n/*\n#endif\nSystem.Console.WriteLine("old");\n#if false\n*/\n#endif\n'
        self.assertFails("a.cs", base, base.replace('"old"', '"new"'), "preprocessor line")

    def test_string_across_conditional_compilation_fails_closed(self) -> None:
        base = '#if false\nvar v = @"\n#endif\nvar s = "a // old";\n'
        self.assertFails("a.cs", base, base.replace("old", "new"), "preprocessor line")

    def test_comment_across_indented_directive_fails_closed(self) -> None:
        base = '#if false\n/*\n\f#endif\nSystem.Console.WriteLine("old");\n\f#if false\n*/\n#endif\n'
        self.assertFails("a.cs", base, base.replace('"old"', '"new"'), "preprocessor line")

    def test_unicode_line_separator_fails_closed(self) -> None:
        # C# ends the // comment at U+2028, so the WriteLine is code.
        base = '// note\u2028System.Console.WriteLine("old");\n'
        self.assertFails("a.cs", base, base.replace("old", "new"), "U+2028")

    def test_auto_generated_marker_is_code(self) -> None:
        self.assertFails("a.cs", "// <auto-generated/>\nclass C {}\n", "// Generated.\nclass C {}\n")


class PythonTests(CommentOnlyCase):
    def test_comment_reword_passes(self) -> None:
        self.assertPasses(
            "a.py",
            '#!/usr/bin/env python3\nx = "a # b"  # old\n# old line\ny = f"{x!r} # {x}"\n',
            '#!/usr/bin/env python3\nx = "a # b"  # new\ny = f"{x!r} # {x}"\n',
        )

    def test_change_inside_string_after_hash_fails(self) -> None:
        self.assertFails("a.py", 'x = "a # selfmig"\n', 'x = "a # migration"\n')

    def test_change_inside_f_string_fails(self) -> None:
        self.assertFails("a.py", 'x = f"{y} # {z}"\n', 'x = f"{y} # {w}"\n')

    def test_docstring_change_fails(self) -> None:
        self.assertFails("a.py", '"""Old summary."""\n', '"""New summary."""\n')

    def test_shebang_change_fails(self) -> None:
        self.assertFails("a.py", "#!/usr/bin/env python3\nx = 1\n", "#!/usr/bin/python3\nx = 1\n")

    def test_noqa_change_fails(self) -> None:
        self.assertFails("a.py", "import os  # noqa: F401\n", "import os  # unused\n")

    def test_blank_lines_inside_triple_quoted_string_are_not_normalized(self) -> None:
        self.assertFails("a.py", 'x = """a\n\n\nb"""\n', 'x = """a\n\nb"""\n')
        self.assertFails("a.py", 'x = """a   \nb"""\n', 'x = """a\nb"""\n')

    def test_deleting_comment_after_crlf_continuation_fails(self) -> None:
        # The base prints 1 and the head prints 3.
        self.assertFails("a.py", "x = 1 \\\r\n# old\r\n+ 2\r\nprint(x)\r\n", "x = 1 \\\r\n+ 2\r\nprint(x)\r\n")

    def test_byte_order_mark_fails_closed(self) -> None:
        self.assertFails("a.py", "\ufeffx = 1  # old\n", "\ufeffx = 1  # new\n", "byte-order mark")

    def test_tokenize_error_fails_closed(self) -> None:
        self.assertFails("a.py", "x = (1,\n", "x = (1, # c\n", "cannot tokenize")


class ShellTests(CommentOnlyCase):
    BASE = (
        "#!/usr/bin/env bash\n"
        "# old header\n"
        'echo "a # b" \'c # d\' e#f ${#arr[@]} $# # old\n'
        "cat <<'EOF'\n"
        "# heredoc line\n"
        "EOF\n"
        'x=$(echo "y" # old\n)\n'
    )

    def test_comment_reword_passes(self) -> None:
        self.assertPasses("a.sh", self.BASE, self.BASE.replace("# old", "# new"))

    def test_change_inside_quotes_or_words_fails(self) -> None:
        for old, new in (("a # b", "a # c"), ("c # d", "c # e"), ("e#f", "e#g"), ("${#arr[@]}", "${#arr[*]}")):
            with self.subTest(old=old):
                self.assertFails("a.sh", self.BASE, self.BASE.replace(old, new, 1))

    def test_change_inside_heredoc_body_fails(self) -> None:
        self.assertFails("a.sh", self.BASE, self.BASE.replace("# heredoc line", "# heredoc text"))

    def test_blank_lines_inside_heredoc_body_are_not_normalized(self) -> None:
        self.assertFails("a.sh", "cat <<EOF\na\n\n\nb\nEOF\n", "cat <<EOF\na\n\nb\nEOF\n")
        self.assertFails("a.sh", "cat <<EOF\na   \nEOF\n", "cat <<EOF\na\nEOF\n")

    def test_shellcheck_directive_change_fails(self) -> None:
        self.assertFails("a.sh", "# shellcheck disable=SC2086\necho $x\n", "# quoting\necho $x\n")

    def test_deleting_comment_after_line_continuation_fails(self) -> None:
        # The comment ends the command, so deleting its line joins "run" and "--fast".
        self.assertFails("a.sh", "run \\\n# keep\n--fast\n", "run \\\n--fast\n")

    def test_escaped_trailing_space_is_not_normalized(self) -> None:
        # Bash prints "<a >" for the base and "<a>" for the head.
        self.assertFails("a.sh", "printf '<%s>\\n' a\\ \n", "printf '<%s>\\n' a\\\n", "")
        self.assertFails("a.sh", "printf '<%s>\\n' a\\ \n", "printf '<%s>\\n' a\\\t\n")

    def test_quoted_text_inside_parameter_expansion_is_not_normalized(self) -> None:
        self.assertFails("a.sh", "x=${u:-'a   \nb'}\n", "x=${u:-'a\nb'}\n")
        self.assertFails("a.sh", 'x=${u:-"a   \nb"}\n', 'x=${u:-"a\nb"}\n')

    def test_backtick_substitution_is_not_normalized(self) -> None:
        self.assertFails("a.sh", "x=`printf 'a   \nb'`\n", "x=`printf 'a\nb'`\n")

    def test_hash_after_escape_or_continuation_is_not_a_comment(self) -> None:
        self.assertFails("a.sh", "echo a\\ #old\n", "echo a\\ #new\n")
        self.assertFails("a.sh", "echo a\\\n#old\n", "echo a\\\n#new\n", "inside a word")

    def test_comment_after_continuation_and_space_is_a_comment(self) -> None:
        self.assertPasses("a.sh", "echo a \\\n#old\n", "echo a \\\n#new\n")

    def test_unquoted_heredoc_line_ending_in_backslash_fails_closed(self) -> None:
        # The first EOF joins the line before it, so it does not end the body.
        self.assertFails(
            "a.sh", "cat <<EOF\nx\\\nEOF\n#old\nEOF\n", "cat <<EOF\nx\\\nEOF\n#new\nEOF\n", "cannot tokenize"
        )

    def test_hash_inside_extended_glob_is_not_a_comment(self) -> None:
        self.assertFails("a.sh", "[[ '#x' == @(a|#x) ]]\n", "[[ '#x' == @(a|#y) ]]\n")

    def test_case_inside_command_substitution_fails_closed(self) -> None:
        base = 'x="$(case x in x) echo "value # old";; esac)"\n'
        self.assertFails("a.sh", base, base.replace("old", "new"), "case inside")

    def test_case_split_by_line_continuation_fails_closed(self) -> None:
        base = 'x="$(ca\\\nse x in x) echo "value # old";; esac)"\n'
        self.assertFails("a.sh", base, base.replace("old", "new"), "inside a word")

    def test_ansi_c_string_inside_parameter_expansion(self) -> None:
        base = "x=${u:-$'\\'} value # old'}\n"
        self.assertFails("a.sh", base, base.replace("old", "new"))

    def test_trailing_form_feed_and_vertical_tab_are_kept(self) -> None:
        for ch in ("\f", "\v"):
            with self.subTest(ch=repr(ch)):
                self.assertFails("a.sh", f"printf '<%s>\\n' value{ch}\n", "printf '<%s>\\n' value\n")

    def test_byte_order_mark_fails_closed(self) -> None:
        self.assertFails("a.sh", "\ufeffecho hi # old\n", "\ufeffecho hi # new\n", "byte-order mark")

    def test_continuation_inside_a_token_fails_closed(self) -> None:
        for base in (
            "printf '%s\\n' $\\\n#old\n",
            "cat <\\\n<'EOF'\n#old\nEOF\n",
            'x="$\\\n(echo "value # old")"\n',
        ):
            with self.subTest(base=base):
                self.assertFails("a.sh", base, base.replace("old", "new"), "inside a word")

    def test_literal_dollar_does_not_hide_an_escape(self) -> None:
        # Bash prints "$ #old" and "$ #new".
        self.assertFails("a.sh", "printf '%s\\n' $\\ #old\n", "printf '%s\\n' $\\ #new\n")

    def test_expansion_in_heredoc_delimiter_fails_closed(self) -> None:
        base = "cat <<$(echo EOF)\n$\n#old\n$(echo EOF)\n"
        self.assertFails("a.sh", base, base.replace("old", "new"), "heredoc delimiter")

    def test_hash_inside_array_subscript_fails_closed(self) -> None:
        base = "declare -A a\na[ #old]=value\nprintf '%s\\n' \"${!a[@]}\"\n"
        self.assertFails("a.sh", base, base.replace("old", "new"), "unclosed")

    def test_comment_after_closed_test_bracket_passes(self) -> None:
        self.assertPasses("a.sh", 'if [ -n "$x" ]; then # old\n  :\nfi\n', 'if [ -n "$x" ]; then # new\n  :\nfi\n')

    def test_line_ending_change_fails(self) -> None:
        # Bash prints "<value\r>" for the base and "<value>" for the head.
        self.assertFails("a.sh", "printf '<%s>\\n' value\r\n", "printf '<%s>\\n' value\n", "carriage return")
        self.assertFails("a.gs", "let x = 1\r\n", "let x = 1\n")

    def test_comment_edit_in_crlf_file_passes(self) -> None:
        self.assertPasses("a.gs", "a()\r\n// old\r\nb() // old\r\n", "a()\r\nb() // new\r\n")

    def test_carriage_return_in_heredoc_delimiter_line_fails_closed(self) -> None:
        # Bash does not end the body at "EOF\r", so "#old" is body data.
        base = "cat <<'EOF'\nEOF\r\n#old\nEOF\n"
        self.assertFails("a.sh", base, base.replace("old", "new"), "carriage return")

    def test_backtick_inside_parameter_expansion_is_skipped(self) -> None:
        base = 'x="${u:-`echo } "value # old"`}"\n'
        self.assertFails("a.sh", base, base.replace("old", "new"))

    def test_quoted_heredoc_delimiter_forms_fail_closed(self) -> None:
        for base in ("cat <<$'EOF'\n$EOF\n#old\nEOF\n", 'cat <<"E\\OF"\nx\n#old\nE\\OF\n'):
            with self.subTest(base=base):
                self.assertFails("a.sh", base, base.replace("old", "new"), "heredoc delimiter")

    def test_unclosed_heredoc_fails_closed(self) -> None:
        self.assertFails("a.sh", "cat <<EOF\nx\nEOF\n", "cat <<EOF\nx # c\n", "cannot tokenize")


class YamlTests(CommentOnlyCase):
    BASE = (
        "# old header\n"
        "jobs:\n"
        "  build: # old\n"
        "    if: ${{ a == 'b' }} # old\n"
        "    name: \"a # b\"\n"
        "    url: http://x#y\n"
        "    steps:\n"
        "      - run: |\n"
        "          # shell comment\n"
        "          echo hi\n"
        "\n"
        "      # old step note\n"
        "      - run: echo 'q#r'\n"
    )

    def test_comment_reword_passes(self) -> None:
        self.assertPasses("a.yml", self.BASE, self.BASE.replace("# old", "# new"))

    def test_deleting_comment_lines_passes(self) -> None:
        head = self.BASE.replace("# old header\n", "").replace("      # old step note\n", "")
        self.assertPasses("a.yaml", self.BASE, head)

    def test_change_inside_scalar_fails(self) -> None:
        for old, new in (("a # b", "a # c"), ("x#y", "x#z"), ("q#r", "q#s"), ("'b'", "'c'")):
            with self.subTest(old=old):
                self.assertFails("a.yml", self.BASE, self.BASE.replace(old, new, 1))

    def test_blank_lines_inside_block_scalar_are_not_normalized(self) -> None:
        self.assertFails("a.yml", "k: |\n  a\n\n\n  b\nn: 1\n", "k: |\n  a\n\n  b\nn: 1\n")
        self.assertFails("a.yml", "k: |\n  a   \n  b\n", "k: |\n  a\n  b\n")

    def test_change_inside_tagged_or_anchored_scalar_fails(self) -> None:
        self.assertFails("a.yml", 'a: !!str "x # y"\n', 'a: !!str "x # z"\n')
        self.assertFails("a.yml", "a: &k 'x # y'\n", "a: &k 'x # z'\n")

    def test_blank_lines_inside_plain_scalar_are_not_normalized(self) -> None:
        # The values are "a\n\nb" and "a\nb".
        self.assertFails("a.yml", "k: a\n\n\n  b\n", "k: a\n\n  b\n")

    def test_quoted_flow_value_after_colon_is_a_string(self) -> None:
        self.assertFails("a.yml", '{"k":"a # old"}\n', '{"k":"a # new"}\n')
        self.assertFails("a.yml", "m: {k: x,\n  j:'a # old'}\n", "m: {k: x,\n  j:'a # new'}\n")

    def test_final_line_break_of_block_scalar_is_kept(self) -> None:
        self.assertFails("a.yml", "k: |\n  a\n", "k: |\n  a")
        self.assertFails("a.yml", "k: |+\n  a\n\n", "k: |+\n  a\n")

    def test_scalar_after_document_marker_is_a_string(self) -> None:
        self.assertFails("a.yml", '--- "a # old"\n', '--- "a # new"\n')
        self.assertFails("a.yml", "--- |\n  # old\n", "--- |\n  # new\n")

    def test_open_plain_quote_before_comment_fails_closed(self) -> None:
        # The scanner does not know every place where a quoted scalar can start.
        self.assertFails("a.yml", 'k: x "a # old"\n', 'k: x "a # new"\n', "cannot tokenize")

    def test_byte_order_mark_fails_closed(self) -> None:
        self.assertFails("a.yml", "\ufeff- |\n    # old\n", "\ufeff- |\n    # new\n", "byte-order mark")

    def test_byte_order_mark_before_later_document_fails_closed(self) -> None:
        base = "--- a\n...\n\ufeff--- |\n  # old\n"
        self.assertFails("a.yml", base, base.replace("old", "new"), "byte-order mark")

    def test_blank_only_block_scalar_fails_closed(self) -> None:
        # The base value of k is a line break; the head value is empty.
        self.assertFails("a.yml", "k: |+\n\n# note\nn: 1\n", "k: |+\n# note\n\nn: 1\n", "only blank lines")

    def test_whitespace_only_block_lines_are_kept(self) -> None:
        # The values are "a\n \n" and "a\n".
        self.assertFails("a.yml", "k: |\n  a\n   \n", "k: |\n  a\n")
        self.assertFails("a.yml", "k: |\n  a\n    \nn: 1\n", "k: |\n  a\n  \nn: 1\n")

    def test_bare_carriage_return_fails_closed(self) -> None:
        self.assertFails("a.yml", "# note\rk: old\r", "# note\rk: new\r", "carriage return")

    def test_change_inside_block_scalar_fails(self) -> None:
        self.assertFails("a.yml", self.BASE, self.BASE.replace("# shell comment", "# shell note"))


class RealSourceTests(CommentOnlyCase):
    """The scanners accept real repository files, and real edits behave."""

    LEXER = "src/Core/CodeAnalysis/Syntax/Lexer.gs"

    def test_real_files_scan_and_compare_equal(self) -> None:
        for path in (self.LEXER, "build/check-comment-only-diff.py", "build/selfmig-common.sh", ".github/workflows/build.yml"):
            with self.subTest(path=path):
                text = (REPO / path).read_text(encoding="utf-8")
                self.assertIsNone(check.compare(path, text, text))
                self.assertGreater(check.classify(path, text).count(check.COMMENT), 0)

    def test_real_lexer_comment_and_string_edits(self) -> None:
        # The edits come from the scanner, not from fixed text, so a later
        # rewording of Lexer.gs does not break this test.
        text = (REPO / self.LEXER).read_text(encoding="utf-8")
        mask = check.classify(self.LEXER, text)
        comments = [(s, e) for s, e in check._runs(mask, check.COMMENT) if text.startswith("// ", s)]
        self.assertGreater(len(comments), 0)
        start, end = comments[len(comments) // 2]
        self.assertPasses(self.LEXER, text, text[:start] + "// A reworded comment." + text[end:])
        strings = [(s, e) for s, e in check._runs(mask, check.STRING) if e - s >= 3 and text[(s + e) // 2] not in "\"'`\\{}$"]
        self.assertGreater(len(strings), 0)
        start, end = strings[len(strings) // 2]
        middle = (start + end) // 2
        changed = "Q" if text[middle] != "Q" else "R"
        self.assertFails(self.LEXER, text, text[:middle] + changed + text[middle + 1 :])


def git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env).stdout


class GitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = tempfile.TemporaryDirectory()
        self.repo = Path(self.scratch.name)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "core.autocrlf", "false")
        self.write("a.gs", 'let s = "a // b" // old\n')
        self.write("b.sh", "echo hi # old\n")
        self.write("c.md", "# Title\n")
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

    def run_check(self, *paths: str) -> tuple[int, str]:
        result = subprocess.run(
            [sys.executable, str(REPO / "build" / "check-comment-only-diff.py"), "--repo", str(self.repo), "--base", "base", *paths],
            capture_output=True, text=True,
        )
        return result.returncode, result.stdout

    def test_comment_only_commit_passes(self) -> None:
        self.write("a.gs", 'let s = "a // b" // new\n')
        self.write("b.sh", "echo hi # new\n")
        self.commit()
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("PASS a.gs", out)
        self.assertIn("2 of 2 changed files", out)

    def test_string_change_fails_with_exit_1(self) -> None:
        self.write("a.gs", 'let s = "a // c" // old\n')
        self.commit()
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL a.gs: code differs at base line 1 / head line 1", out)

    def test_path_filter_limits_the_check(self) -> None:
        self.write("a.gs", 'let s = "a // c" // old\n')
        self.write("b.sh", "echo hi # new\n")
        self.commit()
        code, out = self.run_check("b.sh")
        self.assertEqual(code, 0, out)
        self.assertNotIn("a.gs", out)

    def test_unsupported_added_deleted_renamed_and_mode_changes_fail(self) -> None:
        self.write("c.md", "# New title\n")
        self.write("d.gs", "let d = 1\n")
        (self.repo / "b.sh").chmod(0o755)
        git(self.repo, "mv", "a.gs", "renamed.gs")
        self.commit()
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL c.md: unsupported file type", out)
        self.assertIn("FAIL d.gs: file is added", out)
        self.assertIn("FAIL a.gs: file is deleted", out)
        self.assertIn("FAIL renamed.gs: file is added", out)
        self.assertIn("FAIL b.sh: mode changed from 100644 to 100755", out)

    def test_bad_revision_exits_2(self) -> None:
        result = subprocess.run(
            [sys.executable, str(REPO / "build" / "check-comment-only-diff.py"), "--repo", str(self.repo), "--base", "no-such-rev"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2, result.stdout)


if __name__ == "__main__":
    unittest.main()
