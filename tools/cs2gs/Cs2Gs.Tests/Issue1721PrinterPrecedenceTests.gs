// <copyright file="Issue1721PrinterPrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Text.RegularExpressions
import Xunit

/// Translation tests for issue #1721: (cref:GSharpPrinter) printed
/// binary/unary expressions completely flat, with no awareness of G#'s
/// Go-style operator precedence (mirrored from
/// `SyntaxFacts.GetBinaryOperatorPrecedence` in
/// `src/Core/CodeAnalysis/Syntax`). C#'s precedence differs from G#'s in
/// exactly the ways exercised below, so a flat reprint of a C#-precedence
/// expression tree silently re-associates under G#'s rules and reparses to a
/// different value:
/// - C#: multiplicative > additive > shift > relational > equality > `&` > `^` > `|`.
/// - G# (Go-style): `* / % << >> & &^` share the multiplicative level; `+ - | ^` share the additive
/// level; ALL of `== != < <= > >=` (plus `is`/`as`) share a single comparison level below that.
/// The fix makes `GSharpPrinter.RenderExpression` precedence-aware: it
/// threads the precedence required by the surrounding context through the
/// recursive descent and parenthesizes a child whenever its own G#-table
/// precedence would let it bind differently than the original (C#-shaped)
/// tree intends. It also inserts a separating space between adjacent unary
/// operators that would otherwise lex as a single (different) token, e.g.
/// `!!` (postfix non-null assertion) or `--` (predecrement).
open class Issue1721PrinterPrecedenceTests {
    // --- Shift vs. additive: G# puts `<<`/`>>` at the MULTIPLICATIVE level
    // (same as `*`), strictly above additive `+`/`-`, whereas C# puts shifts
    // BELOW additive. A flat reprint of `1 << 2 + 3` re-associates it.
    @Fact
    func ShiftOverAdditiveRightOperand_IsParenthesized() {
        let g = Render("\nnamespace N { public class C { public static int F() => 1 << 2 + 3; } }")
        Assert.Contains("1 << (2 + 3)", g, StringComparison.Ordinal)
        AssertEvaluatesTo(1 << (2 + 3), ExtractArrowBody(g))
    }

    @Fact
    func AdditiveOverShiftLeftOperand_IsParenthesized() {
        // C#: `+` binds tighter than `<<`, so this is `(1 + 2) << 3`. G#
        // ranks `<<` at the SAME level as `+`'s sibling multiplicative tier —
        // strictly above additive — so the left operand must be parenthesized
        // or it silently re-associates as `1 + (2 << 3)`.
        let g = Render("\nnamespace N { public class C { public static int F() => 1 + 2 << 3; } }")
        Assert.Contains("(1 + 2) << 3", g, StringComparison.Ordinal)
        AssertEvaluatesTo((1 + 2) << 3, ExtractArrowBody(g))
    }

    // --- Bitwise-and vs. additive: G# puts `&` at the MULTIPLICATIVE level
    // (same as `*`), whereas C# puts `&` far below additive (below equality).
    @Fact
    func BitwiseAndOverAdditiveRightOperand_IsParenthesized() {
        let a = 6
        let b = 3
        let c = 5
        let g = Render("\nnamespace N { public class C { public static int F(int a, int b, int c) => a & b + c; } }")
        Assert.Contains("a & (b + c)", g, StringComparison.Ordinal)
        AssertEvaluatesTo(a & (b + c), "a", a, "b", b, "c", c, ExtractArrowBody(g))
    }

    // --- Bitwise-or vs. bitwise-xor: G# puts `|` and `^` at the SAME
    // (additive) level, left-associative, whereas C# ranks `^` strictly
    // above `|`. `x | y ^ z` is `x | (y ^ z)` in C# but re-associates to
    // `(x | y) ^ z` if printed flat under G#'s table.
    @Fact
    func BitwiseOrOverXorRightOperand_IsParenthesized() {
        let x = 0b1010
        let y = 0b0110
        let z = 0b0011
        let g = Render("\nnamespace N { public class C { public static int F(int x, int y, int z) => x | y ^ z; } }")
        Assert.Contains("x | (y ^ z)", g, StringComparison.Ordinal)
        AssertEvaluatesTo(x | (y ^ z), "x", x, "y", y, "z", z, ExtractArrowBody(g))
    }

    // --- Equality vs. bitwise-and: G# ranks ALL comparisons (`==` included)
    // and `&` at DIFFERENT levels than C# does. C#'s `==` binds tighter than
    // `&`, so `a == b & c` is `(a == b) & c`; G# also ranks `==` (comparison,
    // level 3) below `&` (multiplicative, level 5), so the left operand of
    // `&` must be parenthesized or it silently re-associates to
    // `a == (b & c)`.
    @Fact
    func EqualityOverBitwiseAndLeftOperand_IsParenthesized() {
        let g = Render("\nnamespace N { public class C { public static bool F(int a, int b, bool c) => a == b & c; } }")
        Assert.Contains("(a == b) & c", g, StringComparison.Ordinal)
    }

    // --- Equality vs. relational: C# ranks relational (`<`) strictly ABOVE
    // equality (`==`), but G# puts them at the SAME (comparison) level. Flat
    // printing `a == b < c` (C# = `a == (b < c)`) re-associates to
    // `(a == b) < c` under G#'s rules.
    @Fact
    func EqualityOverRelationalRightOperand_IsParenthesized() {
        let g = Render(
            "\nnamespace N { public class C { public static bool F(bool a, int b, int c) => a == (b < c); } }"
        )
        Assert.Contains("a == (b < c)", g, StringComparison.Ordinal)
    }

    // --- Nested same-precedence, left-associative: no extra parens needed;
    // flat reprint already reproduces `(a - b) - c` under both C#'s and G#'s
    // (both left-associative, same tier) rules.
    @Fact
    func NestedSamePrecedenceLeftAssociative_NoParensNeeded() {
        let a = 10
        let b = 3
        let c = 2
        let g = Render("\nnamespace N { public class C { public static int F(int a, int b, int c) => a - b - c; } }")
        Assert.Contains("a - b - c", g, StringComparison.Ordinal)
        Assert.DoesNotContain("(a - b)", g, StringComparison.Ordinal)
        AssertEvaluatesTo(a - b - c, "a", a, "b", b, "c", c, ExtractArrowBody(g))
    }

    // --- Nested same-precedence, RIGHT operand: re-association changes the
    // value even though the operator is the same on both sides, so the right
    // operand must be parenthesized whenever it is itself the same (or a
    // same-tier) operator.
    @Fact
    func NestedSamePrecedenceRightOperand_IsParenthesized() {
        let a = 10
        let b = 3
        let c = 2
        let g = Render("\nnamespace N { public class C { public static int F(int a, int b, int c) => a - (b - c); } }")
        Assert.Contains("a - (b - c)", g, StringComparison.Ordinal)
        AssertEvaluatesTo(a - (b - c), "a", a, "b", b, "c", c, ExtractArrowBody(g))
    }

    // --- Unary vs. binary: a nested unary `!!flag` (double logical negation)
    // must not coalesce into the postfix `!!` (non-null assertion) token, and
    // `- -x` must not coalesce into a predecrement `--x`.
    @Fact
    func DoubleLogicalNegation_InsertsSeparatingSpace() {
        let g = Render("\nnamespace N { public class C { public static bool F(bool flag) => !!flag; } }")
        Assert.Contains("! !flag", g, StringComparison.Ordinal)
        Assert.DoesNotContain("!!flag", g, StringComparison.Ordinal)
    }

    @Fact
    func DoubleUnaryMinus_InsertsSeparatingSpace() {
        let g = Render("\nnamespace N { public class C { public static int F(int x) => - -x; } }")
        Assert.Contains("- -x", g, StringComparison.Ordinal)
        Assert.DoesNotContain("--x", g, StringComparison.Ordinal)
    }

    shared {
        /// Translates the supplied C# source with the full cs2gs pipeline and
        /// returns the printed G# source, after confirming it round-trips (parses
        /// with no error diagnostics) with the real G# parser.
        private func Render(csharp string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, csharp string){("Source.cs", csharp)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        /// Extracts the expression-bodied arrow tail (`-> <expr>`)
        /// of the (single) free function `F` emitted by (cref:Render).
        private func ExtractArrowBody(printed string) string {
            let match = Regex.Match(printed, "func F\\([^)]*\\)[^\\r\\n{]* -> (?<body>[^\\r\\n]+)")
            Assert.True(match.Success, "Expected an arrow-bodied `F` in printed G#:\n" + printed)
            return match.Groups["body"].Value.Trim()
        }

        /// Evaluates the printed arrow-body expression through the emitted oracle
        /// (ADR-0156 Phase 3c, #3176 — no free variables) and asserts it equals
        /// [`expected`](paramref) — the same expression, evaluated directly
        /// by the C# compiler in the calling test — proving the printed G# text
        /// re-parses to a tree that preserves the original C# value.
        private func AssertEvaluatesTo(expected int32, gsharpExpression string) {
            let result = EmittedOracle.Evaluate(gsharpExpression)
            AssertNoRealDiagnostics(result)
            Assert.Equal(int64(expected), Convert.ToInt64(result.Value))
        }

        /// Same as (cref:AssertEvaluatesTo(int, string)) but binds the
        /// function's parameters to concrete values via `let` bindings ahead of
        /// the expression. [`expected`](paramref) is computed by the calling
        /// test using C#'s own operators over the same values, so the two
        /// languages' results are compared independently.
        private func AssertEvaluatesTo(
            expected int32,
            name1 string,
            value1 int32,
            name2 string,
            value2 int32,
            name3 string,
            value3 int32,
            gsharpExpression string
        ) {
            let script = (`let ` + "$name1" + ` = ` + "$value1" + `
let ` + "$name2" + ` = ` + "$value2" + `
let ` + "$name3" + ` = ` + "$value3" + `
` + "$gsharpExpression")
            let result = EmittedOracle.Evaluate(script)
            AssertNoRealDiagnostics(result)
            Assert.Equal(int64(expected), Convert.ToInt64(result.Value))
        }

        private func AssertNoRealDiagnostics(result EmittedOracleResult) {
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        }
    }
}
