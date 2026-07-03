// <copyright file="Issue1721PrinterPrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for issue #1721: <see cref="GSharpPrinter"/> printed
/// binary/unary expressions completely flat, with no awareness of G#'s
/// Go-style operator precedence (mirrored from
/// <c>SyntaxFacts.GetBinaryOperatorPrecedence</c> in
/// <c>src/Core/CodeAnalysis/Syntax</c>). C#'s precedence differs from G#'s in
/// exactly the ways exercised below, so a flat reprint of a C#-precedence
/// expression tree silently re-associates under G#'s rules and reparses to a
/// different value:
///
/// <list type="bullet">
/// <item>C#: multiplicative &gt; additive &gt; shift &gt; relational &gt;
/// equality &gt; <c>&amp;</c> &gt; <c>^</c> &gt; <c>|</c>.</item>
/// <item>G# (Go-style): <c>* / % &lt;&lt; &gt;&gt; &amp; &amp;^</c> share the
/// multiplicative level; <c>+ - | ^</c> share the additive level; ALL of
/// <c>== != &lt; &lt;= &gt; &gt;=</c> (plus <c>is</c>/<c>as</c>) share a single
/// comparison level below that.</item>
/// </list>
///
/// The fix makes <c>GSharpPrinter.RenderExpression</c> precedence-aware: it
/// threads the precedence required by the surrounding context through the
/// recursive descent and parenthesizes a child whenever its own G#-table
/// precedence would let it bind differently than the original (C#-shaped)
/// tree intends. It also inserts a separating space between adjacent unary
/// operators that would otherwise lex as a single (different) token, e.g.
/// <c>!!</c> (postfix non-null assertion) or <c>--</c> (predecrement).
/// </summary>
public class Issue1721PrinterPrecedenceTests
{
    // --- Shift vs. additive: G# puts `<<`/`>>` at the MULTIPLICATIVE level
    // (same as `*`), strictly above additive `+`/`-`, whereas C# puts shifts
    // BELOW additive. A flat reprint of `1 << 2 + 3` re-associates it.
    [Fact]
    public void ShiftOverAdditiveRightOperand_IsParenthesized()
    {
        string g = Render(@"
namespace N { public class C { public static int F() => 1 << 2 + 3; } }");

        Assert.Contains("1 << (2 + 3)", g, StringComparison.Ordinal);
        AssertEvaluatesTo(1 << 2 + 3, ExtractArrowBody(g));
    }

    [Fact]
    public void AdditiveOverShiftLeftOperand_IsParenthesized()
    {
        // C#: `+` binds tighter than `<<`, so this is `(1 + 2) << 3`. G#
        // ranks `<<` at the SAME level as `+`'s sibling multiplicative tier —
        // strictly above additive — so the left operand must be parenthesized
        // or it silently re-associates as `1 + (2 << 3)`.
        string g = Render(@"
namespace N { public class C { public static int F() => 1 + 2 << 3; } }");

        Assert.Contains("(1 + 2) << 3", g, StringComparison.Ordinal);
        AssertEvaluatesTo(1 + 2 << 3, ExtractArrowBody(g));
    }

    // --- Bitwise-and vs. additive: G# puts `&` at the MULTIPLICATIVE level
    // (same as `*`), whereas C# puts `&` far below additive (below equality).
    [Fact]
    public void BitwiseAndOverAdditiveRightOperand_IsParenthesized()
    {
        int a = 6, b = 3, c = 5;
        string g = Render(@"
namespace N { public class C { public static int F(int a, int b, int c) => a & b + c; } }");

        Assert.Contains("a & (b + c)", g, StringComparison.Ordinal);
        AssertEvaluatesTo(a & (b + c), "a", a, "b", b, "c", c, ExtractArrowBody(g));
    }

    // --- Bitwise-or vs. bitwise-xor: G# puts `|` and `^` at the SAME
    // (additive) level, left-associative, whereas C# ranks `^` strictly
    // above `|`. `x | y ^ z` is `x | (y ^ z)` in C# but re-associates to
    // `(x | y) ^ z` if printed flat under G#'s table.
    [Fact]
    public void BitwiseOrOverXorRightOperand_IsParenthesized()
    {
        int x = 0b1010, y = 0b0110, z = 0b0011;
        string g = Render(@"
namespace N { public class C { public static int F(int x, int y, int z) => x | y ^ z; } }");

        Assert.Contains("x | (y ^ z)", g, StringComparison.Ordinal);
        AssertEvaluatesTo(x | (y ^ z), "x", x, "y", y, "z", z, ExtractArrowBody(g));
    }

    // --- Equality vs. bitwise-and: G# ranks ALL comparisons (`==` included)
    // and `&` at DIFFERENT levels than C# does. C#'s `==` binds tighter than
    // `&`, so `a == b & c` is `(a == b) & c`; G# also ranks `==` (comparison,
    // level 3) below `&` (multiplicative, level 5), so the left operand of
    // `&` must be parenthesized or it silently re-associates to
    // `a == (b & c)`.
    [Fact]
    public void EqualityOverBitwiseAndLeftOperand_IsParenthesized()
    {
        string g = Render(@"
namespace N { public class C { public static bool F(int a, int b, bool c) => a == b & c; } }");

        Assert.Contains("(a == b) & c", g, StringComparison.Ordinal);
    }

    // --- Equality vs. relational: C# ranks relational (`<`) strictly ABOVE
    // equality (`==`), but G# puts them at the SAME (comparison) level. Flat
    // printing `a == b < c` (C# = `a == (b < c)`) re-associates to
    // `(a == b) < c` under G#'s rules.
    [Fact]
    public void EqualityOverRelationalRightOperand_IsParenthesized()
    {
        string g = Render(@"
namespace N { public class C { public static bool F(bool a, int b, int c) => a == (b < c); } }");

        Assert.Contains("a == (b < c)", g, StringComparison.Ordinal);
    }

    // --- Nested same-precedence, left-associative: no extra parens needed;
    // flat reprint already reproduces `(a - b) - c` under both C#'s and G#'s
    // (both left-associative, same tier) rules.
    [Fact]
    public void NestedSamePrecedenceLeftAssociative_NoParensNeeded()
    {
        int a = 10, b = 3, c = 2;
        string g = Render(@"
namespace N { public class C { public static int F(int a, int b, int c) => a - b - c; } }");

        Assert.Contains("a - b - c", g, StringComparison.Ordinal);
        Assert.DoesNotContain("(a - b)", g, StringComparison.Ordinal);
        AssertEvaluatesTo(a - b - c, "a", a, "b", b, "c", c, ExtractArrowBody(g));
    }

    // --- Nested same-precedence, RIGHT operand: re-association changes the
    // value even though the operator is the same on both sides, so the right
    // operand must be parenthesized whenever it is itself the same (or a
    // same-tier) operator.
    [Fact]
    public void NestedSamePrecedenceRightOperand_IsParenthesized()
    {
        int a = 10, b = 3, c = 2;
        string g = Render(@"
namespace N { public class C { public static int F(int a, int b, int c) => a - (b - c); } }");

        Assert.Contains("a - (b - c)", g, StringComparison.Ordinal);
        AssertEvaluatesTo(a - (b - c), "a", a, "b", b, "c", c, ExtractArrowBody(g));
    }

    // --- Unary vs. binary: a nested unary `!!flag` (double logical negation)
    // must not coalesce into the postfix `!!` (non-null assertion) token, and
    // `- -x` must not coalesce into a predecrement `--x`.
    [Fact]
    public void DoubleLogicalNegation_InsertsSeparatingSpace()
    {
        string g = Render(@"
namespace N { public class C { public static bool F(bool flag) => !!flag; } }");

        Assert.Contains("! !flag", g, StringComparison.Ordinal);
        Assert.DoesNotContain("!!flag", g, StringComparison.Ordinal);
    }

    [Fact]
    public void DoubleUnaryMinus_InsertsSeparatingSpace()
    {
        string g = Render(@"
namespace N { public class C { public static int F(int x) => - -x; } }");

        Assert.Contains("- -x", g, StringComparison.Ordinal);
        Assert.DoesNotContain("--x", g, StringComparison.Ordinal);
    }

    /// <summary>
    /// Translates the supplied C# source with the full cs2gs pipeline and
    /// returns the printed G# source, after confirming it round-trips (parses
    /// with no error diagnostics) with the real G# parser.
    /// </summary>
    private static string Render(string csharp)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", csharp) });
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Extracts the expression-bodied arrow tail (<c>-&gt; &lt;expr&gt;</c>)
    /// of the (single) free function <c>F</c> emitted by <see cref="Render"/>.
    /// </summary>
    private static string ExtractArrowBody(string printed)
    {
        Match match = Regex.Match(printed, @"func F\([^)]*\)[^\r\n{]* -> (?<body>[^\r\n]+)");
        Assert.True(match.Success, "Expected an arrow-bodied `F` in printed G#:\n" + printed);
        return match.Groups["body"].Value.Trim();
    }

    /// <summary>
    /// Evaluates the printed arrow-body expression with the real G#
    /// interpreter (no free variables) and asserts it equals
    /// <paramref name="expected"/> — the same expression, evaluated directly
    /// by the C# compiler in the calling test — proving the printed G# text
    /// re-parses to a tree that preserves the original C# value.
    /// </summary>
    private static void AssertEvaluatesTo(int expected, string gsharpExpression)
    {
        EvaluationResult result = Evaluate(gsharpExpression);
        AssertNoRealDiagnostics(result);
        Assert.Equal(expected, Convert.ToInt64(result.Value));
    }

    /// <summary>
    /// Same as <see cref="AssertEvaluatesTo(int, string)"/> but binds the
    /// function's parameters to concrete values via `let` bindings ahead of
    /// the expression. <paramref name="expected"/> is computed by the calling
    /// test using C#'s own operators over the same values, so the two
    /// languages' results are compared independently.
    /// </summary>
    private static void AssertEvaluatesTo(int expected, string name1, int value1, string name2, int value2, string name3, int value3, string gsharpExpression)
    {
        string script = $"let {name1} = {value1}\nlet {name2} = {value2}\nlet {name3} = {value3}\n{gsharpExpression}";
        EvaluationResult result = Evaluate(script);
        AssertNoRealDiagnostics(result);
        Assert.Equal(expected, Convert.ToInt64(result.Value));
    }

    private static EvaluationResult Evaluate(string gsharpSource)
    {
        var tree = SyntaxTree.Parse(gsharpSource);
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static void AssertNoRealDiagnostics(EvaluationResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }
}
